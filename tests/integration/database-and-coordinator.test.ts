import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../../apps/server/src/database/connection.js";
import {
  createEffectMutationRepository,
  EffectConflictError,
  type EffectInsertResult,
  EffectNotFoundError,
  listUnresolvedForReconciliation,
  StaleEffectError,
} from "../../apps/server/src/database/effects.js";
import { migrateDatabase } from "../../apps/server/src/database/migrate.js";
import {
  CodingSlotOccupiedError,
  createRunMutationRepository,
  listEvents,
  RepairRoundLimitError,
  RunOwnershipConflictError,
  readRun,
  readSchedulerControl,
  StaleRevisionError,
} from "../../apps/server/src/database/runs.js";
import {
  EFFECT_STATUSES,
  type EffectStatus,
  InvalidTransitionError,
} from "../../apps/server/src/workflow/state.js";

const migrationSource = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);
const temporaryDirectories: string[] = [];
const connections = new Set<ReturnType<typeof openDatabase>>();

const firstAt = "2026-08-08T18:00:00.000Z";
const secondAt = "2026-08-08T18:01:00.000Z";

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-runs-"));
  temporaryDirectories.push(directory);
  const migrationsDirectory = join(directory, "migrations");
  await cp(migrationSource, migrationsDirectory, { recursive: true });
  const connection = openDatabase(join(directory, "wheelsparrow.sqlite3"));
  migrateDatabase(connection, migrationsDirectory);
  connections.add(connection);
  return connection;
}

async function closeConnection(
  connection: ReturnType<typeof openDatabase>,
): Promise<void> {
  await connection.close();
  connections.delete(connection);
}

function claimInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    repository: "owner/repository",
    projectItemId: "project-item-1",
    issueNodeId: "issue-node-1",
    issueNumber: 1,
    ownerToken: "owner-token-1",
    at: firstAt,
    summary: { text: "Claimed for execution." },
    ...overrides,
  };
}

async function createClaim(
  connection: ReturnType<typeof openDatabase>,
  overrides: Record<string, unknown> = {},
) {
  return connection.db
    .transaction()
    .execute((tx) =>
      createRunMutationRepository(tx).createClaim(claimInput(overrides)),
    );
}

afterEach(async () => {
  for (const connection of connections) await closeConnection(connection);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("durable run mutation repository", () => {
  test("creates a claiming run and its first event atomically", async () => {
    const connection = await createDatabase();

    const run = await createClaim(connection);
    const events = await listEvents(connection.db, run.id);

    expect(run).toMatchObject({
      id: "run-1",
      repository: "owner/repository",
      projectItemId: "project-item-1",
      issueNodeId: "issue-node-1",
      issueNumber: 1,
      state: "claiming",
      revision: 1,
      ownerToken: "owner-token-1",
      reworkEpoch: 0,
      repairRound: 0,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      runId: "run-1",
      sequence: 1,
      runRevision: 1,
      summary: "Claimed for execution.",
    });
  });

  test("updates by exact revision and appends one ordered event", async () => {
    const connection = await createDatabase();
    await createClaim(connection);

    const run = await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: "run-1",
        expectedRevision: 1,
        trigger: "todo_observed",
        at: secondAt,
        summary: { text: "Workspace may be prepared." },
      }),
    );

    expect(run.state).toBe("preparing");
    expect(run.revision).toBe(2);
    expect(await listEvents(connection.db, "run-1")).toHaveLength(2);
    expect((await listEvents(connection.db, "run-1"))[1]).toMatchObject({
      sequence: 2,
      runRevision: 2,
      kind: "todo_observed",
    });
  });

  test("rejects stale and invalid transitions without changing durable rows", async () => {
    const connection = await createDatabase();
    await createClaim(connection);
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: "run-1",
        expectedRevision: 1,
        trigger: "todo_observed",
        at: secondAt,
        summary: { text: "Workspace may be prepared." },
      }),
    );

    const before = await readRun(connection.db, "run-1");
    const beforeEvents = await listEvents(connection.db, "run-1");
    await expect(
      connection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).transitionRun({
          runId: "run-1",
          expectedRevision: 1,
          trigger: "workspace_prepared",
          at: "2026-08-08T18:02:00.000Z",
          summary: { text: "Stale attempt." },
        }),
      ),
    ).rejects.toBeInstanceOf(StaleRevisionError);
    await expect(
      connection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).transitionRun({
          runId: "run-1",
          expectedRevision: 2,
          trigger: "review_approved",
          at: "2026-08-08T18:03:00.000Z",
          summary: { text: "Not legal from preparing." },
        }),
      ),
    ).rejects.toThrow(/invalid workflow transition/i);

    expect(await readRun(connection.db, "run-1")).toEqual(before);
    expect(await listEvents(connection.db, "run-1")).toEqual(beforeEvents);
  });

  test("reports coding-slot and project-owner conflicts as typed errors", async () => {
    const connection = await createDatabase();
    await createClaim(connection);

    await expect(
      createClaim(connection, {
        id: "run-2",
        projectItemId: "project-item-2",
        issueNodeId: "issue-node-2",
        issueNumber: 2,
        ownerToken: "owner-token-2",
      }),
    ).rejects.toBeInstanceOf(CodingSlotOccupiedError);

    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: "run-1",
        expectedRevision: 1,
        trigger: "handoff_required",
        at: secondAt,
        summary: { text: "Needs human attention." },
      }),
    );

    const second = await createClaim(connection, {
      id: "run-2",
      projectItemId: "project-item-2",
      issueNodeId: "issue-node-2",
      issueNumber: 2,
      ownerToken: "owner-token-2",
    });
    expect(second.state).toBe("claiming");
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: "run-2",
        expectedRevision: 1,
        trigger: "handoff_required",
        at: "2026-08-08T18:02:00.000Z",
        summary: { text: "Needs human attention." },
      }),
    );
    await expect(
      createClaim(connection, {
        id: "run-3",
        projectItemId: "project-item-1",
        issueNodeId: "issue-node-3",
        issueNumber: 3,
        ownerToken: "owner-token-3",
      }),
    ).rejects.toBeInstanceOf(RunOwnershipConflictError);
  });

  test("return-to-todo starts a new repair epoch and appends invalidation evidence", async () => {
    const connection = await createDatabase();
    await createClaim(connection);
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: "run-1",
        expectedRevision: 1,
        trigger: "handoff_required",
        at: secondAt,
        summary: { text: "Ready for review." },
      }),
    );
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).appendApproval({
        id: "approval-1",
        runId: "run-1",
        expectedRevision: 2,
        operator: "operator@example.test",
        approvedHeadSha: "a".repeat(40),
        observedBaseSha: "b".repeat(40),
        decision: "approved",
        at: secondAt,
      }),
    );

    const run = await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: "run-1",
        expectedRevision: 2,
        trigger: "return_todo_reserved",
        at: "2026-08-08T18:02:00.000Z",
        summary: { text: "Please address the review findings." },
      }),
    );

    expect(run).toMatchObject({
      state: "returning_to_todo",
      revision: 3,
      reworkEpoch: 1,
      repairRound: 0,
      ownerToken: "owner-token-1",
      ownershipReleasedAt: null,
    });
    const approvals = connection.native
      .prepare(
        "SELECT decision, invalidation_reason FROM approvals WHERE run_id = ? ORDER BY rowid",
      )
      .all("run-1") as Array<{
      decision: string;
      invalidation_reason: string | null;
    }>;
    expect(approvals).toEqual([
      { decision: "approved", invalidation_reason: null },
      {
        decision: "invalidated",
        invalidation_reason: "Please address the review findings.",
      },
    ]);
  });

  test("queued rework immediately invalidates every active approval decision", async () => {
    const connection = await createDatabase();
    await createClaim(connection);
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: "run-1",
        expectedRevision: 1,
        trigger: "handoff_required",
        at: secondAt,
        summary: { text: "Ready for review." },
      }),
    );
    for (const [id, decision, head] of [
      ["approval-approved-1", "approved", "a"],
      ["approval-rejected", "rejected", "a"],
      ["approval-approved-2", "approved", "c"],
    ] as const) {
      await connection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).appendApproval({
          id,
          runId: "run-1",
          expectedRevision: 2,
          operator: "operator@example.test",
          approvedHeadSha: head.repeat(40),
          observedBaseSha: "d".repeat(40),
          decision,
          at: secondAt,
        }),
      );
    }

    const queued = await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: "run-1",
        expectedRevision: 2,
        trigger: "return_todo_queued",
        at: "2026-08-08T18:02:00.000Z",
        summary: { text: "Queue the requested rework." },
      }),
    );
    expect(queued).toMatchObject({
      state: "queued_rework",
      revision: 3,
      reworkEpoch: 0,
    });
    const approvals = connection.native
      .prepare(
        "SELECT decision, approved_head_sha, invalidation_reason FROM approvals WHERE run_id = ? ORDER BY rowid",
      )
      .all("run-1") as Array<{
      decision: string;
      approved_head_sha: string;
      invalidation_reason: string | null;
    }>;
    expect(
      approvals.filter(({ decision }) => decision === "invalidated"),
    ).toHaveLength(2);
    expect(
      approvals
        .filter(({ decision }) => decision === "invalidated")
        .every(
          ({ invalidation_reason }) =>
            invalidation_reason === "Queue the requested rework.",
        ),
    ).toBe(true);
    const latestByHead = new Map<string, (typeof approvals)[number]>();
    for (const approval of approvals)
      latestByHead.set(approval.approved_head_sha, approval);
    expect(
      [...latestByHead.values()].filter(
        ({ decision }) => decision === "approved",
      ),
    ).toHaveLength(0);

    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: "run-1",
        expectedRevision: 3,
        trigger: "coding_slot_available",
        at: "2026-08-08T18:03:00.000Z",
        summary: { text: "Start the queued rework." },
      }),
    );
    const step = {
      id: "step-current-epoch",
      runId: "run-1",
      expectedRevision: 4,
      reworkEpoch: 1,
      role: "builder",
      logicalStep: "repair",
      attempt: 1,
      statusSequence: 1,
      status: "started",
      promptHash: "e".repeat(64),
      model: "gpt-5",
      reasoningEffort: "medium",
      startedAt: "2026-08-08T18:03:00.000Z",
      summary: { text: "Current epoch step." },
    };
    await connection.db
      .transaction()
      .execute((tx) => createRunMutationRepository(tx).appendStep(step));
    await expect(
      connection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).appendStep({
          ...step,
          id: "step-old-epoch",
          reworkEpoch: 0,
        }),
      ),
    ).rejects.toThrow(/rework epoch/i);
  });

  test("rejects stale append epochs and rework-epoch overflow before writes", async () => {
    const connection = await createDatabase();
    await createClaim(connection);
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: "run-1",
        expectedRevision: 1,
        trigger: "handoff_required",
        at: secondAt,
        summary: { text: "Ready for review." },
      }),
    );
    const beforeSteps = connection.native
      .prepare("SELECT count(*) AS count FROM steps WHERE run_id = ?")
      .get("run-1");
    await expect(
      connection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).appendStep({
          id: "step-stale-epoch",
          runId: "run-1",
          expectedRevision: 2,
          reworkEpoch: 1,
          role: "reviewer",
          logicalStep: "review",
          attempt: 1,
          statusSequence: 1,
          status: "completed",
          promptHash: "f".repeat(64),
          model: "gpt-5",
          reasoningEffort: "medium",
          startedAt: secondAt,
          summary: { text: "Wrong epoch." },
        }),
      ),
    ).rejects.toThrow(/rework epoch/i);
    expect(
      connection.native
        .prepare("SELECT count(*) AS count FROM steps WHERE run_id = ?")
        .get("run-1"),
    ).toEqual(beforeSteps);

    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).appendStep({
        id: "step-current-epoch",
        runId: "run-1",
        expectedRevision: 2,
        reworkEpoch: 0,
        role: "reviewer",
        logicalStep: "review",
        attempt: 1,
        statusSequence: 1,
        status: "completed",
        promptHash: "e".repeat(64),
        model: "gpt-5",
        reasoningEffort: "medium",
        startedAt: secondAt,
        summary: { text: "Current epoch." },
      }),
    );
    await expect(
      connection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).appendFinding({
          id: "finding-stale-epoch",
          runId: "run-1",
          expectedRevision: 2,
          reworkEpoch: 1,
          reviewStepId: "step-current-epoch",
          stableKey: "stale-epoch",
          dispositionSequence: 1,
          severity: "high",
          evidence: "Wrong epoch.",
          disposition: "open",
          at: secondAt,
        }),
      ),
    ).rejects.toThrow(/rework epoch/i);
    expect(
      connection.native
        .prepare("SELECT count(*) AS count FROM findings WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ count: 0 });

    connection.native
      .prepare("UPDATE runs SET rework_epoch = ? WHERE id = ?")
      .run(Number.MAX_SAFE_INTEGER, "run-1");
    const beforeRun = await readRun(connection.db, "run-1");
    const beforeEvents = await listEvents(connection.db, "run-1");
    await expect(
      connection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).transitionRun({
          runId: "run-1",
          expectedRevision: 2,
          trigger: "return_todo_reserved",
          at: "2026-08-08T18:03:00.000Z",
          summary: { text: "Must not overflow rework epoch." },
        }),
      ),
    ).rejects.toThrow(RangeError);
    expect(await readRun(connection.db, "run-1")).toEqual(beforeRun);
    expect(await listEvents(connection.db, "run-1")).toEqual(beforeEvents);
  });

  test("commits exactly one concurrent transition and rolls back a post-update event failure", async () => {
    const connection = await createDatabase();
    const secondConnection = openDatabase(connection.native.name);
    connections.add(secondConnection);
    await createClaim(connection);
    const transitions = await Promise.allSettled([
      connection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).transitionRun({
          runId: "run-1",
          expectedRevision: 1,
          trigger: "todo_observed",
          at: secondAt,
          summary: { text: "First concurrent transition." },
        }),
      ),
      secondConnection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).transitionRun({
          runId: "run-1",
          expectedRevision: 1,
          trigger: "todo_observed",
          at: secondAt,
          summary: { text: "Second concurrent transition." },
        }),
      ),
    ]);
    expect(
      transitions.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      transitions.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);
    expect(await listEvents(connection.db, "run-1")).toHaveLength(2);

    connection.native
      .prepare(
        `INSERT INTO events (
          id, run_id, sequence, run_revision, kind, summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "event-conflict",
        "run-1",
        3,
        3,
        "conflict",
        "reserved sequence",
        "2026-08-08T18:04:00.000Z",
      );
    const beforeRun = await readRun(connection.db, "run-1");
    await expect(
      connection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx, {
          eventIdFactory: () => "event-conflict",
        }).transitionRun({
          runId: "run-1",
          expectedRevision: 2,
          trigger: "workspace_prepared",
          at: "2026-08-08T18:05:00.000Z",
          summary: { text: "Event insert must fail." },
        }),
      ),
    ).rejects.toThrow();
    expect(await readRun(connection.db, "run-1")).toEqual(beforeRun);
    expect(await listEvents(connection.db, "run-1")).toHaveLength(3);
  });

  test("increments repair rounds once, preserves them across nonrepair transitions, and resets on return-to-todo", async () => {
    const connection = await createDatabase();
    await createClaim(connection);
    const transition = (
      expectedRevision: number,
      trigger:
        | "todo_observed"
        | "workspace_prepared"
        | "intake_captured"
        | "builder_succeeded"
        | "verification_failed_repairable"
        | "repair_succeeded"
        | "verification_passed"
        | "review_needs_repair"
        | "return_todo_reserved",
      at: string,
    ) =>
      connection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).transitionRun({
          runId: "run-1",
          expectedRevision,
          trigger,
          at,
          summary: { text: `Transition ${trigger}.` },
        }),
      );

    await transition(1, "todo_observed", secondAt);
    await transition(2, "workspace_prepared", "2026-08-08T18:02:00.000Z");
    await transition(3, "intake_captured", "2026-08-08T18:03:00.000Z");
    await transition(4, "builder_succeeded", "2026-08-08T18:04:00.000Z");
    let run = await transition(
      5,
      "verification_failed_repairable",
      "2026-08-08T18:05:00.000Z",
    );
    expect(run).toMatchObject({
      state: "repairing",
      revision: 6,
      repairRound: 1,
    });
    run = await transition(6, "repair_succeeded", "2026-08-08T18:06:00.000Z");
    expect(run.repairRound).toBe(1);
    run = await transition(
      7,
      "verification_passed",
      "2026-08-08T18:07:00.000Z",
    );
    expect(run).toMatchObject({ state: "reviewing", repairRound: 1 });
    run = await transition(
      8,
      "review_needs_repair",
      "2026-08-08T18:08:00.000Z",
    );
    expect(run).toMatchObject({
      state: "repairing",
      revision: 9,
      repairRound: 2,
    });
    run = await transition(9, "repair_succeeded", "2026-08-08T18:09:00.000Z");
    expect(run.repairRound).toBe(2);
    run = await transition(
      10,
      "verification_passed",
      "2026-08-08T18:10:00.000Z",
    );
    expect(run).toMatchObject({ state: "reviewing", repairRound: 2 });

    const beforeThirdRepair = await readRun(connection.db, "run-1");
    const beforeThirdEvents = await listEvents(connection.db, "run-1");
    await expect(
      transition(11, "review_needs_repair", "2026-08-08T18:11:00.000Z"),
    ).rejects.toBeInstanceOf(RepairRoundLimitError);
    expect(await readRun(connection.db, "run-1")).toEqual(beforeThirdRepair);
    expect(await listEvents(connection.db, "run-1")).toEqual(beforeThirdEvents);

    connection.native
      .prepare("UPDATE runs SET state = ? WHERE id = ?")
      .run("review", "run-1");
    run = await transition(
      11,
      "return_todo_reserved",
      "2026-08-08T18:12:00.000Z",
    );
    expect(run).toMatchObject({
      state: "returning_to_todo",
      reworkEpoch: 1,
      repairRound: 0,
    });

    for (const [state, trigger] of [
      ["reviewing", "review_needs_repair"],
      ["waiting_for_ci", "ci_failed_repairable"],
    ] as const) {
      const source = await createDatabase();
      await createClaim(source);
      source.native
        .prepare("UPDATE runs SET state = ? WHERE id = ?")
        .run(state, "run-1");
      const repaired = await source.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).transitionRun({
          runId: "run-1",
          expectedRevision: 1,
          trigger,
          at: secondAt,
          summary: { text: `Transition ${trigger}.` },
        }),
      );
      expect(repaired).toMatchObject({ state: "repairing", repairRound: 1 });
    }
  });

  test("rejects an event sequence overflow before updating the run", async () => {
    const connection = await createDatabase();
    await createClaim(connection);
    connection.native
      .prepare(
        `INSERT INTO events (
          id, run_id, sequence, run_revision, kind, summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "event-max-sequence",
        "run-1",
        Number.MAX_SAFE_INTEGER,
        1,
        "seed",
        "maximum sequence",
        secondAt,
      );
    const beforeRun = await readRun(connection.db, "run-1");
    const beforeEvents = await listEvents(connection.db, "run-1");
    await expect(
      connection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).transitionRun({
          runId: "run-1",
          expectedRevision: 1,
          trigger: "todo_observed",
          at: "2026-08-08T18:02:00.000Z",
          summary: { text: "Must not overflow event sequence." },
        }),
      ),
    ).rejects.toThrow(RangeError);
    expect(await readRun(connection.db, "run-1")).toEqual(beforeRun);
    expect(await listEvents(connection.db, "run-1")).toEqual(beforeEvents);
  });

  test("records handoff and releases ownership only at terminal states", async () => {
    const connection = await createDatabase();
    await createClaim(connection);

    const review = await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: "run-1",
        expectedRevision: 1,
        trigger: "handoff_required",
        at: secondAt,
        summary: { text: "Needs human attention." },
        requiredAction: "Review the pull request.",
      }),
    );
    expect(review).toMatchObject({
      state: "review",
      handedOffAt: secondAt,
      ownerToken: "owner-token-1",
      ownershipReleasedAt: null,
      requiredAction: "Review the pull request.",
    });

    const stopped = await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: "run-1",
        expectedRevision: 2,
        trigger: "stop_safe",
        at: "2026-08-08T18:02:00.000Z",
        summary: { text: "Stopped by operator." },
      }),
    );
    expect(stopped).toMatchObject({
      state: "stopped",
      ownerToken: null,
      ownershipReleasedAt: "2026-08-08T18:02:00.000Z",
      terminalAt: "2026-08-08T18:02:00.000Z",
      stopRequestedAt: "2026-08-08T18:02:00.000Z",
    });
  });

  test("appends steps, findings, and approvals without update paths", async () => {
    const connection = await createDatabase();
    await createClaim(connection);
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).appendStep({
        id: "step-1",
        runId: "run-1",
        expectedRevision: 1,
        reworkEpoch: 0,
        role: "reviewer",
        logicalStep: "review",
        attempt: 1,
        statusSequence: 1,
        status: "completed",
        promptHash: "c".repeat(64),
        model: "gpt-5",
        reasoningEffort: "medium",
        startedAt: firstAt,
        summary: { text: "Review complete." },
      }),
    );
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).appendFinding({
        id: "finding-1",
        runId: "run-1",
        expectedRevision: 1,
        reworkEpoch: 0,
        reviewStepId: "step-1",
        stableKey: "finding-key",
        dispositionSequence: 1,
        severity: "high",
        evidence: "The check failed.",
        disposition: "open",
        at: secondAt,
      }),
    );
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).appendApproval({
        id: "approval-1",
        runId: "run-1",
        expectedRevision: 1,
        operator: "operator@example.test",
        approvedHeadSha: "d".repeat(64),
        observedBaseSha: "e".repeat(40),
        decision: "rejected",
        invalidationReason: "Needs another pass.",
        at: secondAt,
      }),
    );

    expect(
      connection.native
        .prepare("SELECT count(*) AS count FROM steps WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ count: 1 });
    expect(
      connection.native
        .prepare("SELECT count(*) AS count FROM findings WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ count: 1 });
    expect(
      connection.native
        .prepare("SELECT count(*) AS count FROM approvals WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ count: 1 });
  });

  test("append-only mutations require the exact run revision", async () => {
    const connection = await createDatabase();
    await createClaim(connection);

    const step = {
      id: "step-stale",
      runId: "run-1",
      expectedRevision: 0,
      reworkEpoch: 0,
      role: "reviewer",
      logicalStep: "review",
      attempt: 1,
      statusSequence: 1,
      status: "completed",
      promptHash: "f".repeat(64),
      model: "gpt-5",
      reasoningEffort: "medium",
      startedAt: firstAt,
      summary: { text: "Stale review." },
    };
    await expect(
      connection.db
        .transaction()
        .execute((tx) => createRunMutationRepository(tx).appendStep(step)),
    ).rejects.toBeInstanceOf(StaleRevisionError);
    expect(
      connection.native
        .prepare("SELECT count(*) AS count FROM steps WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ count: 0 });

    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).appendStep({
        ...step,
        id: "step-valid",
        expectedRevision: 1,
      }),
    );
    const finding = {
      id: "finding-stale",
      runId: "run-1",
      expectedRevision: 0,
      reworkEpoch: 0,
      reviewStepId: "step-valid",
      stableKey: "stale-finding",
      dispositionSequence: 1,
      severity: "high",
      evidence: "Stale evidence.",
      disposition: "open",
      at: secondAt,
    };
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createRunMutationRepository(tx).appendFinding(finding),
        ),
    ).rejects.toBeInstanceOf(StaleRevisionError);
    expect(
      connection.native
        .prepare("SELECT count(*) AS count FROM findings WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ count: 0 });

    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).appendFinding({
        ...finding,
        id: "finding-valid",
        expectedRevision: 1,
      }),
    );
    const approval = {
      id: "approval-stale",
      runId: "run-1",
      expectedRevision: 0,
      operator: "operator@example.test",
      approvedHeadSha: "a".repeat(40),
      observedBaseSha: "b".repeat(40),
      decision: "approved",
      at: secondAt,
    };
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createRunMutationRepository(tx).appendApproval(approval),
        ),
    ).rejects.toBeInstanceOf(StaleRevisionError);
    expect(
      connection.native
        .prepare("SELECT count(*) AS count FROM approvals WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ count: 0 });

    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).appendApproval({
        ...approval,
        id: "approval-valid",
        expectedRevision: 1,
      }),
    );
    expect(
      connection.native
        .prepare("SELECT count(*) AS count FROM approvals WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ count: 1 });
  });

  test("rejects revision overflow before transition or scheduler writes", async () => {
    const connection = await createDatabase();
    await createClaim(connection);
    connection.native
      .prepare("UPDATE runs SET revision = ? WHERE id = ?")
      .run(Number.MAX_SAFE_INTEGER, "run-1");
    const beforeRun = await readRun(connection.db, "run-1");
    const beforeEvents = await listEvents(connection.db, "run-1");
    await expect(
      connection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).transitionRun({
          runId: "run-1",
          expectedRevision: Number.MAX_SAFE_INTEGER,
          trigger: "stop_safe",
          at: secondAt,
          summary: { text: "Must not overflow." },
        }),
      ),
    ).rejects.toThrow(RangeError);
    expect(await readRun(connection.db, "run-1")).toEqual(beforeRun);
    expect(await listEvents(connection.db, "run-1")).toEqual(beforeEvents);

    connection.native
      .prepare("UPDATE scheduler_control SET revision = ? WHERE id = 1")
      .run(Number.MAX_SAFE_INTEGER);
    const beforeControl = await readSchedulerControl(connection.db);
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createRunMutationRepository(tx).updateSchedulerControl(
            Number.MAX_SAFE_INTEGER,
            { paused: true },
            secondAt,
          ),
        ),
    ).rejects.toThrow(RangeError);
    expect(await readSchedulerControl(connection.db)).toEqual(beforeControl);
  });

  test("updates scheduler control by exact revision with no partial stale write", async () => {
    const connection = await createDatabase();
    const changed = await connection.db
      .transaction()
      .execute((tx) =>
        createRunMutationRepository(tx).updateSchedulerControl(
          0,
          { paused: true },
          firstAt,
        ),
      );
    expect(changed).toMatchObject({
      revision: 1,
      paused: true,
      stopAfterCurrent: false,
    });

    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createRunMutationRepository(tx).updateSchedulerControl(
            0,
            { paused: false, stopAfterCurrent: true },
            secondAt,
          ),
        ),
    ).rejects.toBeInstanceOf(StaleRevisionError);
    expect(await readSchedulerControl(connection.db)).toEqual({
      id: 1,
      revision: 1,
      paused: true,
      stopAfterCurrent: false,
      updatedAt: firstAt,
    });
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createRunMutationRepository(tx).updateSchedulerControl(
            1,
            {},
            secondAt,
          ),
        ),
    ).rejects.toThrow(/non-empty/i);
  });
});

describe("durable effect mutation repository", () => {
  function effectIntent(overrides: Record<string, unknown> = {}) {
    return {
      key: "run:run-1:project:todo",
      kind: "project_todo" as const,
      targetRevision: 1,
      intent: { z: "last", a: { y: 2, x: 1 } },
      ...overrides,
    };
  }

  test("canonicalizes intent JSON and replays identical keys without inserting", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    const first = await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).insertEffectIntent(
          run,
          effectIntent(),
          secondAt,
        ),
      );

    expect(first.inserted).toBe(true);
    expect(first.record.intent).toBe('{"a":{"x":1,"y":2},"z":"last"}');
    expect(first.record.fingerprint).toMatch(/^[0-9a-f]{64}$/u);

    const replay = await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).insertEffectIntent(
          run,
          effectIntent({ intent: { a: { x: 1, y: 2 }, z: "last" } }),
          secondAt,
        ),
      );
    expect(replay.inserted).toBe(false);
    expect(replay.record.key).toBe(first.record.key);

    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).insertEffectIntent(
            run,
            effectIntent({ targetRevision: 2 }),
            secondAt,
          ),
        ),
    ).rejects.toBeInstanceOf(EffectConflictError);
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).insertEffectIntent(
            run,
            effectIntent({ fingerprint: "not-a-fingerprint" }),
            secondAt,
          ),
        ),
    ).rejects.toBeInstanceOf(EffectConflictError);
    expect(
      connection.native
        .prepare("SELECT count(*) AS count FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ count: 1 });
  });

  test("retains own __proto__ JSON keys instead of collapsing them into the prototype", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    const first = await connection.db.transaction().execute((tx) =>
      createEffectMutationRepository(tx).insertEffectIntent(
        run,
        effectIntent({
          key: "run:run-1:proto",
          intent: JSON.parse('{"__proto__":{"x":1}}') as unknown,
        }),
        firstAt,
      ),
    );
    expect(first.record.intent).toBe('{"__proto__":{"x":1}}');

    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).insertEffectIntent(
            run,
            effectIntent({ key: "run:run-1:proto", intent: {} }),
            firstAt,
          ),
        ),
    ).rejects.toBeInstanceOf(EffectConflictError);
    expect(first.record.fingerprint).not.toBe(
      (
        await connection.db
          .transaction()
          .execute((tx) =>
            createEffectMutationRepository(tx).insertEffectIntent(
              run,
              effectIntent({ key: "run:run-1:empty", intent: {} }),
              firstAt,
            ),
          )
      ).record.fingerprint,
    );
  });

  test("replays an identical intent after its run advances, while differing replay conflicts", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    const intent = effectIntent({ key: "run:run-1:advanced-replay" });
    const first = await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).insertEffectIntent(
          run,
          intent,
          firstAt,
        ),
      );
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: run.id,
        expectedRevision: run.revision,
        trigger: "todo_observed",
        at: secondAt,
        summary: { text: "Advance before replay." },
      }),
    );

    const replay = await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).insertEffectIntent(
          run,
          intent,
          secondAt,
        ),
      );
    expect(replay.inserted).toBe(false);
    expect(replay.record).toEqual(first.record);
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).insertEffectIntent(
            run,
            { ...intent, intent: { changed: true } },
            secondAt,
          ),
        ),
    ).rejects.toBeInstanceOf(EffectConflictError);
    expect(
      connection.native
        .prepare("SELECT status, receipt_json FROM side_effects WHERE key = ?")
        .get(intent.key),
    ).toEqual({ status: "pending", receipt_json: null });
  });

  test("requires the passed run snapshot and intent target revision to match the live run", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    const staleSnapshot = { ...run, state: "preparing" as const };
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).insertEffectIntent(
            staleSnapshot,
            effectIntent({ key: "run:run-1:stale-state" }),
            firstAt,
          ),
        ),
    ).rejects.toBeInstanceOf(StaleEffectError);
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).insertEffectIntent(
            { ...run, revision: 0 },
            effectIntent({ key: "run:run-1:stale-revision" }),
            firstAt,
          ),
        ),
    ).rejects.toBeInstanceOf(StaleEffectError);
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).insertEffectIntent(
            run,
            effectIntent({ key: "run:run-1:wrong-target", targetRevision: 2 }),
            firstAt,
          ),
        ),
    ).rejects.toBeInstanceOf(StaleEffectError);
    expect(
      connection.native
        .prepare("SELECT count(*) AS count FROM side_effects")
        .get(),
    ).toEqual({ count: 0 });
  });

  test("invalid kinds and observation triggers leave the durable effect and run unchanged", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).insertEffectIntent(
            run,
            effectIntent({ key: "run:run-1:bad-kind", kind: "not-a-kind" }),
            firstAt,
          ),
        ),
    ).rejects.toThrow(/effect kind/i);

    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).insertEffectIntent(
          run,
          effectIntent(),
          firstAt,
        ),
      );
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).markEffectInFlight(
          effectIntent().key,
          "executor-1",
          secondAt,
        ),
      );
    await expect(
      connection.db.transaction().execute((tx) =>
        createEffectMutationRepository(tx).recordEffectObservation(
          {
            runId: run.id,
            expectedRevision: run.revision,
            effectKey: effectIntent().key,
            outcome: "confirmed",
            trigger: "handoff_required",
            evidence: "Wrong trigger for project_todo.",
          },
          secondAt,
        ),
      ),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(await readRun(connection.db, run.id)).toMatchObject({
      state: "claiming",
      revision: 1,
    });
    expect(
      connection.native
        .prepare(
          "SELECT status, receipt_json, reconciliation_evidence FROM side_effects WHERE key = ?",
        )
        .get(effectIntent().key),
    ).toEqual({
      status: "in_flight",
      receipt_json: null,
      reconciliation_evidence: null,
    });
  });

  test("enforces every legal and illegal effect lifecycle edge in SQLite", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    const legal: Record<EffectStatus, readonly EffectStatus[]> = {
      pending: ["in_flight", "failed", "cancelled"],
      in_flight: ["confirmed", "failed", "ambiguous"],
      ambiguous: ["confirmed", "failed"],
      confirmed: [],
      failed: [],
      cancelled: [],
    };
    for (const from of EFFECT_STATUSES) {
      for (const to of EFFECT_STATUSES) {
        const key = `run:run-1:edge:${from}:${to}`;
        await connection.db
          .transaction()
          .execute((tx) =>
            createEffectMutationRepository(tx).insertEffectIntent(
              run,
              effectIntent({ key, kind: "project_review" }),
              firstAt,
            ),
          );
        connection.native
          .prepare(
            "UPDATE side_effects SET status = ?, executor_owner_token = ? WHERE key = ?",
          )
          .run(from, from === "in_flight" ? "edge-owner" : null, key);

        const operation = () => {
          if (to === "in_flight")
            return connection.db
              .transaction()
              .execute((tx) =>
                createEffectMutationRepository(tx).markEffectInFlight(
                  key,
                  "edge-owner",
                  secondAt,
                ),
              );
          if (to === "cancelled")
            return connection.db
              .transaction()
              .execute((tx) =>
                createEffectMutationRepository(tx).cancelPendingEffect(
                  key,
                  "Cancelled edge.",
                  secondAt,
                ),
              );
          return connection.db.transaction().execute((tx) =>
            createEffectMutationRepository(tx).recordEffectObservation(
              {
                runId: run.id,
                expectedRevision: run.revision,
                effectKey: key,
                outcome: to as "confirmed" | "failed" | "ambiguous",
                evidence: "Observed edge.",
              },
              secondAt,
            ),
          );
        };
        if (legal[from].includes(to)) {
          await expect(operation()).resolves.toMatchObject({ status: to });
        } else {
          if (to === "pending") {
            await expect(operation()).rejects.toThrow();
          } else {
            await expect(operation()).rejects.toBeInstanceOf(
              InvalidTransitionError,
            );
          }
          expect(
            connection.native
              .prepare("SELECT status FROM side_effects WHERE key = ?")
              .get(key),
          ).toEqual({ status: from });
        }
      }
    }
  });

  test("serializes concurrent same-key inserts and pending dispatch claims", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    const intent = effectIntent({ key: "run:run-1:concurrent" });
    const inserts = await Promise.allSettled([
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).insertEffectIntent(
            run,
            intent,
            firstAt,
          ),
        ),
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).insertEffectIntent(
            run,
            intent,
            firstAt,
          ),
        ),
    ]);
    expect(
      inserts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(2);
    expect(
      inserts
        .filter(
          (result): result is PromiseFulfilledResult<EffectInsertResult> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value.inserted)
        .sort(),
    ).toEqual([false, true]);
    expect(
      connection.native
        .prepare("SELECT count(*) AS count FROM side_effects WHERE key = ?")
        .get(intent.key),
    ).toEqual({ count: 1 });

    const claims = await Promise.allSettled([
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).markEffectInFlight(
            intent.key,
            "owner-a",
            secondAt,
          ),
        ),
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).markEffectInFlight(
            intent.key,
            "owner-b",
            secondAt,
          ),
        ),
    ]);
    expect(
      claims.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      claims.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      connection.native
        .prepare(
          "SELECT status, executor_owner_token FROM side_effects WHERE key = ?",
        )
        .get(intent.key),
    ).toMatchObject({ status: "in_flight" });
  });

  test("scopes shutdown ambiguity to owner and never restarts an ambiguous effect", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    for (const [key, owner] of [
      ["run:run-1:owner-a", "owner-a"],
      ["run:run-1:owner-b", "owner-b"],
    ] as const) {
      await connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).insertEffectIntent(
            run,
            effectIntent({ key }),
            firstAt,
          ),
        );
      await connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).markEffectInFlight(
            key,
            owner,
            secondAt,
          ),
        );
    }
    const changed = await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).markOwnedInFlightAmbiguous(
          "owner-a",
          "Owner A stopped before receipt.",
          secondAt,
        ),
      );
    expect(changed.map((effect) => effect.key)).toEqual(["run:run-1:owner-a"]);
    expect(
      connection.native
        .prepare("SELECT key, status FROM side_effects ORDER BY key")
        .all(),
    ).toEqual([
      { key: "run:run-1:owner-a", status: "ambiguous" },
      { key: "run:run-1:owner-b", status: "in_flight" },
    ]);
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).markEffectInFlight(
            "run:run-1:owner-a",
            "owner-c",
            secondAt,
          ),
        ),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  test("persists bounded failed and ambiguous receipts and evidence", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    for (const [key, outcome] of [
      ["run:run-1:failed", "failed"],
      ["run:run-1:ambiguous", "ambiguous"],
    ] as const) {
      await connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).insertEffectIntent(
            run,
            effectIntent({ key, kind: "project_review" }),
            firstAt,
          ),
        );
      await connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).markEffectInFlight(
            key,
            "owner-1",
            secondAt,
          ),
        );
      const effect = await connection.db.transaction().execute((tx) =>
        createEffectMutationRepository(tx).recordEffectObservation(
          {
            runId: run.id,
            expectedRevision: run.revision,
            effectKey: key,
            outcome,
            receipt: { requestId: key },
            evidence: `${outcome} evidence`,
          },
          secondAt,
        ),
      );
      expect(effect.receipt).toBe(`{"requestId":"${key}"}`);
      expect(effect.reconciliationEvidence).toBe(`${outcome} evidence`);
      if (outcome === "failed") expect(effect.failure).toBe("failed evidence");
    }
  });

  test("orders unresolved effects by run and key across multiple runs", async () => {
    const connection = await createDatabase();
    const firstRun = await createClaim(connection);
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: firstRun.id,
        expectedRevision: 1,
        trigger: "handoff_required",
        at: secondAt,
        summary: { text: "Release the coding slot." },
      }),
    );
    const liveFirstRun = await readRun(connection.db, firstRun.id);
    const secondRun = await createClaim(connection, {
      id: "run-2",
      projectItemId: "project-item-2",
      issueNodeId: "issue-node-2",
      issueNumber: 2,
      ownerToken: "owner-token-2",
    });
    for (const [run, key] of [
      [liveFirstRun, "run-1:z"],
      [liveFirstRun, "run-1:a"],
      [secondRun, "run-2:y"],
      [secondRun, "run-2:b"],
    ] as const) {
      await connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).insertEffectIntent(
            run,
            effectIntent({ key, targetRevision: run.revision }),
            firstAt,
          ),
        );
    }
    const unresolved = await listUnresolvedForReconciliation(connection.db);
    expect(unresolved.map(({ effect }) => effect.key)).toEqual([
      "run-1:a",
      "run-1:z",
      "run-2:b",
      "run-2:y",
    ]);
  });

  test("conditionally claims pending effects and records a revision-checked confirmation", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).insertEffectIntent(
          run,
          effectIntent(),
          firstAt,
        ),
      );

    const inFlight = await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).markEffectInFlight(
          "run:run-1:project:todo",
          "executor-1",
          secondAt,
        ),
      );
    expect(inFlight).toMatchObject({
      status: "in_flight",
      executorAttempt: 1,
      executorOwnerToken: "executor-1",
      startedAt: secondAt,
    });
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).markEffectInFlight(
            "run:run-1:project:todo",
            "executor-2",
            secondAt,
          ),
        ),
    ).rejects.toThrow(/invalid workflow transition/i);

    const confirmed = await connection.db.transaction().execute((tx) =>
      createEffectMutationRepository(tx).recordEffectObservation(
        {
          runId: run.id,
          expectedRevision: run.revision,
          effectKey: "run:run-1:project:todo",
          outcome: "confirmed",
          trigger: "todo_observed",
          receipt: { projectItemId: "project-item-1" },
          evidence: "Project item is now Todo.",
        },
        "2026-08-08T18:02:00.000Z",
      ),
    );
    expect(confirmed).toMatchObject({
      status: "confirmed",
      receipt: '{"projectItemId":"project-item-1"}',
      reconciliationEvidence: "Project item is now Todo.",
    });
    expect(await readRun(connection.db, run.id)).toMatchObject({
      state: "preparing",
      revision: 2,
    });
  });

  test("does not dispatch a pending effect after its target revision is stale", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    const intent = effectIntent({ key: "run:run-1:stale-dispatch" });
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).insertEffectIntent(
          run,
          intent,
          firstAt,
        ),
      );
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: run.id,
        expectedRevision: run.revision,
        trigger: "todo_observed",
        at: secondAt,
        summary: { text: "Advance before dispatch." },
      }),
    );

    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).markEffectInFlight(
            intent.key,
            "executor-1",
            "2026-08-08T18:02:00.000Z",
          ),
        ),
    ).rejects.toBeInstanceOf(StaleEffectError);
    expect(
      connection.native
        .prepare(
          "SELECT status, receipt_json, executor_owner_token FROM side_effects WHERE key = ?",
        )
        .get(intent.key),
    ).toEqual({
      status: "pending",
      receipt_json: null,
      executor_owner_token: null,
    });
  });

  test("rejects stale callbacks without changing the effect", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).insertEffectIntent(
          run,
          effectIntent(),
          firstAt,
        ),
      );
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).markEffectInFlight(
          effectIntent().key,
          "executor-1",
          secondAt,
        ),
      );
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: run.id,
        expectedRevision: 1,
        trigger: "todo_observed",
        at: "2026-08-08T18:02:00.000Z",
        summary: { text: "Advance the run before a stale callback." },
      }),
    );

    await expect(
      connection.db.transaction().execute((tx) =>
        createEffectMutationRepository(tx).recordEffectObservation(
          {
            runId: run.id,
            expectedRevision: 1,
            effectKey: effectIntent().key,
            outcome: "confirmed",
            trigger: "todo_observed",
            evidence: "Late callback.",
          },
          "2026-08-08T18:03:00.000Z",
        ),
      ),
    ).rejects.toBeInstanceOf(StaleEffectError);
    expect(
      connection.native
        .prepare("SELECT status, receipt_json FROM side_effects WHERE key = ?")
        .get(effectIntent().key),
    ).toEqual({ status: "in_flight", receipt_json: null });
  });

  test("marks only owned in-flight effects ambiguous and preserves run state", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).insertEffectIntent(
          run,
          effectIntent(),
          firstAt,
        ),
      );
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).markEffectInFlight(
          effectIntent().key,
          "executor-1",
          secondAt,
        ),
      );
    expect(
      await connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).markOwnedInFlightAmbiguous(
            "other-owner",
            "No matching effect.",
            secondAt,
          ),
        ),
    ).toHaveLength(0);
    const changed = await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).markOwnedInFlightAmbiguous(
          "executor-1",
          "Process exited before receipt.",
          "2026-08-08T18:03:00.000Z",
        ),
      );
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      status: "ambiguous",
      reconciliationEvidence: "Process exited before receipt.",
    });
    expect(await readRun(connection.db, run.id)).toMatchObject({
      state: "claiming",
      revision: 1,
    });
  });

  test("cancels only pending effects and lists unresolved records deterministically", async () => {
    const connection = await createDatabase();
    const run = await createClaim(connection);
    const pending = effectIntent();
    const second = effectIntent({
      key: "run:run-1:workspace:prepare",
      kind: "workspace_prepare",
    });
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).insertEffectIntent(
          run,
          pending,
          firstAt,
        ),
      );
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).insertEffectIntent(
          run,
          second,
          firstAt,
        ),
      );
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).markEffectInFlight(
          second.key,
          "executor-1",
          secondAt,
        ),
      );
    const cancelled = await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).cancelPendingEffect(
          pending.key,
          "No longer required.",
          secondAt,
        ),
      );
    expect(cancelled.status).toBe("cancelled");
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).cancelPendingEffect(
            second.key,
            "Must not cancel in-flight.",
            secondAt,
          ),
        ),
    ).rejects.toThrow(/invalid workflow transition/i);
    const unresolved = await listUnresolvedForReconciliation(connection.db);
    expect(unresolved.map(({ effect }) => effect.key)).toEqual([second.key]);
    expect(unresolved[0]?.run).toMatchObject({ id: run.id, state: "claiming" });
  });

  test("reports missing effects with a typed error", async () => {
    const connection = await createDatabase();
    await expect(
      connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).markEffectInFlight(
            "missing-effect",
            "executor-1",
            firstAt,
          ),
        ),
    ).rejects.toBeInstanceOf(EffectNotFoundError);
  });
});
