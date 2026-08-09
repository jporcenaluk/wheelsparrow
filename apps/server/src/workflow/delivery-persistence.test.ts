import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import { createRunMutationRepository, readRun } from "../database/runs.js";
import { WorkflowCoordinator } from "./coordinator.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
const at = "2026-08-09T20:00:00.000Z";
const baseSha = "a".repeat(40);
const initialHeadSha = "b".repeat(40);
const approvedHeadSha = "c".repeat(40);
const mergeSha = "d".repeat(40);

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-delivery-"));
  directories.push(directory);
  const migrationsDirectory = join(directory, "migrations");
  await cp(migrationSource, migrationsDirectory, { recursive: true });
  const connection = openDatabase(join(directory, "wheelsparrow.sqlite3"));
  migrateDatabase(connection, migrationsDirectory);
  connections.push(connection);
  return connection;
}

function claimInput() {
  return {
    id: "run-delivery",
    repository: "owner/repository",
    projectItemId: "project-run-delivery",
    issueNodeId: "issue-run-delivery",
    issueNumber: 42,
    ownerToken: "owner-run-delivery",
    at,
    summary: { text: "Claim the delivery run." },
  };
}

function mergeReceipt(overrides: Record<string, unknown> = {}) {
  return {
    repository: "owner/repository",
    number: 123,
    issueNumber: 42,
    nodeId: "PR_node_delivery",
    method: "squash",
    baseBranch: "main",
    baseSha,
    headBranch: "wheelsparrow/42-delivery",
    headSha: approvedHeadSha,
    mergeSha,
    ...overrides,
  };
}

async function approvedMergeEffect(
  connection: ReturnType<typeof openDatabase>,
  coordinator: WorkflowCoordinator,
) {
  const review = await enterReview(connection, coordinator);
  const approved = await coordinator.approveMerge({
    runId: review.id,
    expectedRevision: review.revision,
    operator: "operator@example.test",
    approvedHeadSha,
    observedBaseSha: baseSha,
    at,
    dispatch: false,
  });
  await coordinator.beginEffect({ effectKey: approved.effect.key });
  return { review, approved };
}

async function deliveryEffect(
  connection: ReturnType<typeof openDatabase>,
  coordinator: WorkflowCoordinator,
  kind: "smoke" | "project_done",
) {
  let run = await enterReview(connection, coordinator);
  run = await connection.db.transaction().execute((tx) =>
    createRunMutationRepository(tx).updateDeliveryFacts({
      runId: run.id,
      expectedRevision: run.revision,
      facts: { mergeSha },
      at,
    }),
  );
  const key = `run:${run.id}:${kind}`;
  const intent =
    kind === "smoke"
      ? {
          runId: run.id,
          reworkEpoch: run.reworkEpoch,
          repository: run.repository,
          mergeSha,
          command: "pnpm test:unit",
        }
      : {
          runId: run.id,
          reworkEpoch: run.reworkEpoch,
          repository: run.repository,
          projectId: "project-delivery",
          projectNumber: 7,
          itemId: run.projectItemId,
          issueNodeId: run.issueNodeId,
          issueNumber: run.issueNumber,
          expectedRevision: "project-revision",
          fromStatus: "Review",
          toStatus: "Done",
          mergeSha,
        };
  const created = await coordinator.createEffectIntent({
    runId: run.id,
    expectedRevision: run.revision,
    key,
    kind,
    intent,
    dispatch: false,
  });
  const effect = await coordinator.beginEffect({
    effectKey: created.effect.key,
  });
  return { run, effect };
}

async function enterReview(
  connection: ReturnType<typeof openDatabase>,
  coordinator: WorkflowCoordinator,
) {
  await coordinator.createClaim(claimInput());
  let run = await readRun(connection.db, "run-delivery");
  run = await connection.db.transaction().execute((tx) =>
    createRunMutationRepository(tx).updateExecutionFacts({
      runId: run.id,
      expectedRevision: run.revision,
      facts: {
        worktreePath: "/tmp/wheelsparrow-delivery-worktree",
        baseSha,
        branch: "wheelsparrow/42-delivery",
        headSha: initialHeadSha,
      },
      at,
    }),
  );
  for (const trigger of [
    "todo_observed",
    "workspace_prepared",
    "intake_captured",
    "builder_succeeded",
    "verification_passed",
    "review_approved",
  ] as const) {
    run = await coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision,
      trigger,
      at,
      summary: { text: `${trigger}.` },
    });
  }

  const publishKey = "run:run-delivery:publish";
  await coordinator.createEffectIntent({
    runId: run.id,
    expectedRevision: run.revision,
    key: publishKey,
    kind: "publish",
    intent: { runId: run.id, branch: run.branch },
    dispatch: false,
  });
  await coordinator.beginEffect({ effectKey: publishKey });
  run = (
    await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: publishKey,
      outcome: "confirmed",
      trigger: "pr_observed",
      evidence: "Published the exact delivery candidate.",
      publicationFacts: {
        pullRequestNumber: 123,
        pullRequestNodeId: "PR_node_delivery",
        pullRequestTitle: "feat: deliver the run",
        pullRequestUrl: "https://github.com/owner/repository/pull/123",
        baseSha,
        headSha: approvedHeadSha,
        branch: run.branch as string,
      },
      at,
    })
  ).run;

  const ciKey = "run:run-delivery:observe-ci";
  await coordinator.createEffectIntent({
    runId: run.id,
    expectedRevision: run.revision,
    key: ciKey,
    kind: "observe_ci",
    intent: { runId: run.id, pullRequestNumber: run.pullRequestNumber },
    dispatch: false,
  });
  await coordinator.beginEffect({ effectKey: ciKey });
  return (
    await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: ciKey,
      outcome: "confirmed",
      trigger: "ci_passed",
      evidence: "Required checks passed for the exact candidate.",
      receipt: { conclusion: "success", headSha: approvedHeadSha },
      at,
    })
  ).run;
}

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("coordinator-owned delivery persistence", () => {
  test("atomically records exact approval, merge effect, and legal transition", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const review = await enterReview(connection, coordinator);

    const approved = await coordinator.approveMerge({
      runId: review.id,
      expectedRevision: review.revision,
      operator: "operator@example.test",
      approvedHeadSha,
      observedBaseSha: baseSha,
      at,
      dispatch: false,
    });

    expect(approved.run).toMatchObject({
      state: "merging",
      revision: review.revision + 1,
      approvedHeadSha,
      observedBaseSha: baseSha,
    });
    expect(approved.approval).toMatchObject({
      decision: "approved",
      operator: "operator@example.test",
      approvedHeadSha,
      observedBaseSha: baseSha,
    });
    expect(approved.effect).toMatchObject({
      key: `run:${review.id}:rework:${review.reworkEpoch}:merge`,
      kind: "merge",
      status: "pending",
      targetRevision: review.revision + 1,
    });
    expect(JSON.parse(approved.effect.intent)).toMatchObject({
      repository: "owner/repository",
      pullRequestNumber: 123,
      headSha: approvedHeadSha,
      baseSha,
    });
    await coordinator.close();
  });

  test("rejects a changed exact candidate without writing approval or effect", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const review = await enterReview(connection, coordinator);

    await expect(
      coordinator.approveMerge({
        runId: review.id,
        expectedRevision: review.revision,
        operator: "operator@example.test",
        approvedHeadSha: initialHeadSha,
        observedBaseSha: baseSha,
        at,
        dispatch: false,
      }),
    ).rejects.toThrow(/head|candidate|exact/i);

    expect(await readRun(connection.db, review.id)).toEqual(review);
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM approvals WHERE run_id = ?")
        .get(review.id),
    ).toEqual({ count: 0 });
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM side_effects WHERE run_id = ?")
        .get(review.id),
    ).toEqual({ count: 2 });
    await coordinator.close();
  });

  test("does not expose merge authorization through the generic transition command", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const review = await enterReview(connection, coordinator);

    await expect(
      coordinator.transition({
        runId: review.id,
        expectedRevision: review.revision,
        trigger: "merge_authorized",
        at,
        summary: { text: "Attempted to bypass exact approval." },
      }),
    ).rejects.toThrow(/approveMerge|coordinator-owned/i);
    expect(await readRun(connection.db, review.id)).toEqual(review);
    await coordinator.close();
  });

  test("rolls back approval and transition when merge effect creation conflicts", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const review = await enterReview(connection, coordinator);
    const effectKey = `run:${review.id}:merge-conflict`;
    await coordinator.createEffectIntent({
      runId: review.id,
      expectedRevision: review.revision,
      key: effectKey,
      kind: "project_review",
      intent: { runId: review.id, marker: "conflict" },
      dispatch: false,
    });

    await expect(
      coordinator.approveMerge({
        runId: review.id,
        expectedRevision: review.revision,
        operator: "operator@example.test",
        approvedHeadSha,
        observedBaseSha: baseSha,
        effectKey,
        at,
        dispatch: false,
      }),
    ).rejects.toThrow(/effect|conflict|stale/i);

    expect(await readRun(connection.db, review.id)).toEqual(review);
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM approvals WHERE run_id = ?")
        .get(review.id),
    ).toEqual({ count: 0 });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(effectKey),
    ).toEqual({ status: "pending" });
    await coordinator.close();
  });

  test("settles a merge only with a narrow merge-SHA patch", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const review = await enterReview(connection, coordinator);
    const approved = await coordinator.approveMerge({
      runId: review.id,
      expectedRevision: review.revision,
      operator: "operator@example.test",
      approvedHeadSha,
      observedBaseSha: baseSha,
      at,
      dispatch: false,
    });
    await coordinator.beginEffect({ effectKey: approved.effect.key });

    const settled = await coordinator.settleExecution({
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      effectKey: approved.effect.key,
      outcome: "confirmed",
      trigger: "merge_observed",
      evidence: "Merge receipt observed for the approved candidate.",
      receipt: mergeReceipt(),
      deliveryFacts: { mergeSha },
      at,
    });

    expect(settled.run).toMatchObject({
      state: "waiting_for_staging",
      mergeSha,
      revision: approved.run.revision + 1,
    });
    expect(JSON.parse(settled.effect.receipt as string)).toMatchObject({
      mergeSha,
    });
    await coordinator.close();
  });

  test("rejects a null generic merge receipt without advancing or writing facts", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const { approved } = await approvedMergeEffect(connection, coordinator);

    await expect(
      coordinator.observeEffect({
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
        effectKey: approved.effect.key,
        outcome: "confirmed",
        trigger: "merge_observed",
        evidence: "The callback omitted its receipt.",
        receipt: null,
        at,
      }),
    ).rejects.toThrow(/receipt|merge/i);
    expect(await readRun(connection.db, approved.run.id)).toEqual(approved.run);
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(approved.effect.key),
    ).toEqual({ status: "in_flight" });
    await coordinator.close();
  });

  test("abandonEffect rejects a null confirmed delivery receipt", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const { approved } = await approvedMergeEffect(connection, coordinator);

    await expect(
      coordinator.abandonEffect({
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
        effectKey: approved.effect.key,
        outcome: "confirmed",
        trigger: "merge_observed",
        evidence: "The abandoned merge omitted its receipt.",
        receipt: null,
        at,
      }),
    ).rejects.toThrow(/receipt|merge/i);
    expect(await readRun(connection.db, approved.run.id)).toEqual(approved.run);
    await coordinator.close();
  });

  test("quarantineEffect rejects a confirmed merge receipt without merge SHA", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const { approved } = await approvedMergeEffect(connection, coordinator);

    await expect(
      coordinator.quarantineEffect({
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
        effectKey: approved.effect.key,
        outcome: "confirmed",
        trigger: "merge_observed",
        evidence: "The quarantined merge omitted its SHA.",
        receipt: mergeReceipt({ mergeSha: undefined }),
        at,
      }),
    ).rejects.toThrow(/SHA|receipt|merge/i);
    expect(await readRun(connection.db, approved.run.id)).toEqual(approved.run);
    await coordinator.close();
  });

  test("abandonEffect rejects a confirmed smoke receipt without merge SHA", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const { run, effect } = await deliveryEffect(
      connection,
      coordinator,
      "smoke",
    );

    await expect(
      coordinator.abandonEffect({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey: effect.key,
        outcome: "confirmed",
        trigger: "smoke_passed",
        evidence: "The smoke receipt omitted its SHA.",
        receipt: {
          outcome: "passed",
          exitCode: 0,
          durationMs: 10,
          summary: "Smoke passed.",
          command: "pnpm test:unit",
        },
        at,
      }),
    ).rejects.toThrow(/SHA|receipt|smoke/i);
    await coordinator.close();
  });

  test("quarantineEffect rejects a confirmed smoke receipt with changed merge SHA", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const { run, effect } = await deliveryEffect(
      connection,
      coordinator,
      "smoke",
    );

    await expect(
      coordinator.quarantineEffect({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey: effect.key,
        outcome: "confirmed",
        trigger: "smoke_passed",
        evidence: "The smoke receipt changed its SHA.",
        receipt: {
          outcome: "passed",
          exitCode: 0,
          durationMs: 10,
          summary: "Smoke passed.",
          command: "pnpm test:unit",
          mergeSha: "e".repeat(40),
        },
        at,
      }),
    ).rejects.toThrow(/SHA|intent|smoke|match/i);
    await coordinator.close();
  });

  test("abandonEffect rejects a Done receipt without merge SHA", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const { run, effect } = await deliveryEffect(
      connection,
      coordinator,
      "project_done",
    );

    await expect(
      coordinator.abandonEffect({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey: effect.key,
        outcome: "confirmed",
        trigger: "done_observed",
        evidence: "The Done receipt omitted its SHA.",
        receipt: { outcome: "moved", item: {} },
        at,
      }),
    ).rejects.toThrow(/SHA|receipt|Done/i);
    await coordinator.close();
  });

  test("quarantineEffect rejects a Done receipt with changed merge SHA", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const { run, effect } = await deliveryEffect(
      connection,
      coordinator,
      "project_done",
    );

    await expect(
      coordinator.quarantineEffect({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey: effect.key,
        outcome: "confirmed",
        trigger: "done_observed",
        evidence: "The Done receipt changed its SHA.",
        receipt: {
          outcome: "moved",
          mergeSha: "e".repeat(40),
          item: {},
        },
        at,
      }),
    ).rejects.toThrow(/SHA|intent|Done|match/i);
    await coordinator.close();
  });

  test.each([
    ["empty", {}],
    ["missing merge SHA", { ...mergeReceipt(), mergeSha: undefined }],
  ])("rejects a %s generic merge receipt", async (_label, receipt) => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const { approved } = await approvedMergeEffect(connection, coordinator);

    await expect(
      coordinator.observeEffect({
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
        effectKey: approved.effect.key,
        outcome: "confirmed",
        trigger: "merge_observed",
        evidence: "The callback omitted a required merge fact.",
        receipt,
        at,
      }),
    ).rejects.toThrow(/receipt|merge|SHA/i);
    expect(await readRun(connection.db, approved.run.id)).toEqual(approved.run);
    await coordinator.close();
  });

  test("quarantines a malformed confirmed merge callback instead of advancing the run", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: (effect, complete) => {
        if (effect.kind !== "merge") return;
        complete({
          outcome: "confirmed",
          trigger: "merge_observed",
          evidence: "The callback omitted its merge receipt.",
          receipt: null,
        });
      },
    });
    const review = await enterReview(connection, coordinator);
    const approved = await coordinator.approveMerge({
      runId: review.id,
      expectedRevision: review.revision,
      operator: "operator@example.test",
      approvedHeadSha,
      observedBaseSha: baseSha,
      at,
      dispatch: false,
    });
    await coordinator.beginEffect({ effectKey: approved.effect.key });
    await coordinator.waitForIdle();

    expect(await readRun(connection.db, approved.run.id)).toMatchObject({
      state: "merging",
      revision: approved.run.revision + 1,
      mergeSha: null,
    });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(approved.effect.key),
    ).toEqual({ status: "ambiguous" });
    await coordinator.close();
  });

  test("persists merge SHA before a valid generic observation transitions the run", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const { approved } = await approvedMergeEffect(connection, coordinator);

    const settled = await coordinator.observeEffect({
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      effectKey: approved.effect.key,
      outcome: "confirmed",
      trigger: "merge_observed",
      evidence: "The exact merge receipt was observed.",
      receipt: mergeReceipt(),
      at,
    });

    expect(settled.status).toBe("confirmed");
    expect(await readRun(connection.db, approved.run.id)).toMatchObject({
      state: "waiting_for_staging",
      mergeSha,
      revision: approved.run.revision + 1,
    });
    await coordinator.close();
  });

  test("rejects a generic merge receipt whose candidate SHA differs from intent", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const { approved } = await approvedMergeEffect(connection, coordinator);

    await expect(
      coordinator.observeEffect({
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
        effectKey: approved.effect.key,
        outcome: "confirmed",
        trigger: "merge_observed",
        evidence: "The callback reports a changed candidate.",
        receipt: mergeReceipt({ headSha: "e".repeat(40) }),
        at,
      }),
    ).rejects.toThrow(/head|intent|match/i);
    expect(await readRun(connection.db, approved.run.id)).toEqual(approved.run);
    await coordinator.close();
  });

  test("rejects a generic merge receipt when the durable intent fingerprint is tampered", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const { approved } = await approvedMergeEffect(connection, coordinator);
    connection.native
      .prepare("UPDATE side_effects SET intent_json = ? WHERE key = ?")
      .run(
        JSON.stringify({
          baseSha,
          branch: "wheelsparrow/42-delivery",
          headSha: "e".repeat(40),
          pullRequestNodeId: "PR_node_delivery",
          pullRequestNumber: 123,
          pullRequestUrl: "https://github.com/owner/repository/pull/123",
          repository: "owner/repository",
        }),
        approved.effect.key,
      );

    await expect(
      coordinator.observeEffect({
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
        effectKey: approved.effect.key,
        outcome: "confirmed",
        trigger: "merge_observed",
        evidence: "The callback is bound to a tampered intent.",
        receipt: mergeReceipt(),
        at,
      }),
    ).rejects.toThrow(/intent|integrity|fingerprint/i);
    expect(await readRun(connection.db, approved.run.id)).toEqual(approved.run);
    await coordinator.close();
  });

  test("invalidates approval when delivery fails back into Review", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const review = await enterReview(connection, coordinator);
    const approved = await coordinator.approveMerge({
      runId: review.id,
      expectedRevision: review.revision,
      operator: "operator@example.test",
      approvedHeadSha,
      observedBaseSha: baseSha,
      at,
      dispatch: false,
    });
    await coordinator.beginEffect({ effectKey: approved.effect.key });

    const settled = await coordinator.settleExecution({
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      effectKey: approved.effect.key,
      outcome: "failed",
      trigger: "delivery_failed",
      evidence: "Merge was prevented by the repository boundary.",
      at,
    });

    expect(settled.run.state).toBe("review");
    expect(
      connection.native
        .prepare(
          "SELECT decision, invalidation_reason FROM approvals WHERE run_id = ?",
        )
        .all(review.id)
        .sort((left, right) =>
          (left as { decision: string }).decision.localeCompare(
            (right as { decision: string }).decision,
          ),
        ),
    ).toEqual([
      {
        decision: "approved",
        invalidation_reason: null,
      },
      {
        decision: "invalidated",
        invalidation_reason: "Merge was prevented by the repository boundary.",
      },
    ]);
    await coordinator.close();
  });
});
