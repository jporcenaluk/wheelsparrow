import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import { readRun, StaleRevisionError } from "../database/runs.js";
import { WorkflowCoordinator } from "./coordinator.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
const at = "2026-08-09T12:00:00.000Z";

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(
    join(tmpdir(), "wheelsparrow-review-persistence-"),
  );
  directories.push(directory);
  const migrationsDirectory = join(directory, "migrations");
  await cp(migrationSource, migrationsDirectory, { recursive: true });
  const connection = openDatabase(join(directory, "wheelsparrow.sqlite3"));
  migrateDatabase(connection, migrationsDirectory);
  connections.push(connection);
  return connection;
}

function claimInput(id = "run-review") {
  return {
    id,
    repository: "owner/repository",
    projectItemId: `project-${id}`,
    issueNodeId: `issue-${id}`,
    issueNumber: 42,
    ownerToken: `owner-${id}`,
    at,
    summary: { text: `Claim ${id}.` },
  };
}

async function enterReviewing(
  coordinator: WorkflowCoordinator,
  connection: ReturnType<typeof openDatabase>,
  id = "run-review",
) {
  await coordinator.createClaim(claimInput(id));
  const transitions = [
    ["todo_observed", "preparing"],
    ["workspace_prepared", "intaking"],
    ["intake_captured", "building"],
    ["builder_succeeded", "verifying"],
    ["verification_passed", "reviewing"],
  ] as const;
  let run = await readRun(connection.db, id);
  for (const [trigger] of transitions) {
    run = await coordinator.transition({
      runId: id,
      expectedRevision: run.revision,
      trigger,
      at,
      summary: { text: `${trigger}.` },
    });
  }
  return run;
}

function reviewStep(run: Awaited<ReturnType<typeof enterReviewing>>) {
  return {
    id: `run:${run.id}:review:step:1`,
    runId: run.id,
    expectedRevision: run.revision,
    reworkEpoch: run.reworkEpoch,
    role: "reviewer",
    logicalStep: "review",
    attempt: 1,
    statusSequence: 1,
    status: "completed",
    promptHash: "c".repeat(64),
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    startedAt: at,
    completedAt: at,
    exitResultJson: JSON.stringify({ outcome: "needs_repair" }),
    summary: { text: "The review found one repairable issue." },
    rawLogReference: `logs/${run.id}/review/1.jsonl`,
  } as const;
}

function reviewFinding(
  run: Awaited<ReturnType<typeof enterReviewing>>,
  stepId: string,
) {
  return {
    id: `run:${run.id}:finding:consent`,
    runId: run.id,
    expectedRevision: run.revision,
    reworkEpoch: run.reworkEpoch,
    reviewStepId: stepId,
    stableKey: "signup.missing-consent",
    dispositionSequence: 1,
    severity: "high",
    evidence: "The consent value is not persisted before the response.",
    disposition: "open",
    at,
  } as const;
}

async function reviewEffect(
  coordinator: WorkflowCoordinator,
  run: Awaited<ReturnType<typeof enterReviewing>>,
  key = `run:${run.id}:agent:review:attempt:1`,
) {
  await coordinator.createEffectIntent({
    runId: run.id,
    expectedRevision: run.revision,
    key,
    kind: "agent_review",
    intent: { runId: run.id, attempt: 1 },
    dispatch: false,
  });
  return coordinator.beginEffect({
    effectKey: key,
    expectedRevision: run.revision,
  });
}

async function repairEffect(
  coordinator: WorkflowCoordinator,
  run: Awaited<ReturnType<typeof enterReviewing>>,
) {
  const key = `run:${run.id}:agent:repair:attempt:1`;
  await coordinator.createEffectIntent({
    runId: run.id,
    expectedRevision: run.revision,
    key,
    kind: "agent_repair",
    intent: { runId: run.id, attempt: 1 },
    dispatch: false,
  });
  return coordinator.beginEffect({
    effectKey: key,
    expectedRevision: run.revision,
  });
}

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("atomic review findings settlement", () => {
  test("persists review step, every finding, facts, and repair transition together", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterReviewing(coordinator, connection);
    const effect = await reviewEffect(coordinator, run);
    const step = reviewStep(run);
    const finding = reviewFinding(run, step.id);

    const settled = await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome: "failed",
      trigger: "review_needs_repair",
      evidence: "Independent review requires a bounded repair.",
      at,
      facts: { headSha: "d".repeat(40) },
      step,
      findings: [finding],
    });

    expect(settled.run).toMatchObject({
      state: "repairing",
      revision: run.revision + 1,
      headSha: "d".repeat(40),
    });
    expect(settled.effect.status).toBe("failed");
    expect(
      connection.native
        .prepare(
          "SELECT id, review_step_id, stable_key, disposition FROM findings WHERE run_id = ?",
        )
        .all(run.id),
    ).toEqual([
      {
        id: finding.id,
        review_step_id: step.id,
        stable_key: finding.stableKey,
        disposition: "open",
      },
    ]);
    expect(
      connection.native
        .prepare("SELECT id FROM steps WHERE run_id = ?")
        .all(run.id),
    ).toEqual([{ id: step.id }]);
    expect(() =>
      connection.native
        .prepare("UPDATE findings SET evidence = ? WHERE id = ?")
        .run("rewritten", finding.id),
    ).toThrow(/append-only/u);
    await coordinator.close();
  });

  test("rejects findings from non-review effects without partial writes", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterReviewing(
      coordinator,
      connection,
      "run-effect-boundary",
    );
    const effect = await repairEffect(coordinator, run);
    const step = reviewStep(run);
    const finding = reviewFinding(run, step.id);

    await expect(
      coordinator.settleExecution({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey: effect.key,
        outcome: "failed",
        trigger: "handoff_required",
        evidence: "Repair effect cannot settle review findings.",
        at,
        step,
        findings: [finding],
      }),
    ).rejects.toThrow(/agent_review|review effect|findings/u);

    expect(await readRun(connection.db, run.id)).toMatchObject({
      state: "reviewing",
      revision: run.revision,
    });
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?")
        .get(run.id),
    ).toEqual({ count: 0 });
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM findings WHERE run_id = ?")
        .get(run.id),
    ).toEqual({ count: 0 });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(effect.key),
    ).toEqual({ status: "in_flight" });
    await coordinator.close();
  });

  test("requires a reviewer review step for review findings", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterReviewing(
      coordinator,
      connection,
      "run-step-boundary",
    );
    const effect = await reviewEffect(coordinator, run);
    const step = reviewStep(run);
    const finding = reviewFinding(run, step.id);

    await expect(
      coordinator.settleExecution({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey: effect.key,
        outcome: "failed",
        trigger: "review_needs_repair",
        evidence: "A builder step cannot own reviewer findings.",
        at,
        step: { ...step, role: "builder", logicalStep: "build" },
        findings: [finding],
      }),
    ).rejects.toThrow(/reviewer|review step/u);

    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?")
        .get(run.id),
    ).toEqual({ count: 0 });
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM findings WHERE run_id = ?")
        .get(run.id),
    ).toEqual({ count: 0 });
    await coordinator.close();
  });

  test("requires the repairable review outcome and nonempty findings", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const cases = [
      {
        id: "run-empty-findings",
        outcome: "failed" as const,
        trigger: "review_needs_repair" as const,
        findings: [] as const,
      },
      {
        id: "run-omitted-findings",
        outcome: "failed" as const,
        trigger: "review_needs_repair" as const,
      },
      {
        id: "run-approved-findings",
        outcome: "confirmed" as const,
        trigger: "review_approved" as const,
        findings: "included" as const,
      },
      {
        id: "run-human-findings",
        outcome: "failed" as const,
        trigger: "handoff_required" as const,
        findings: "included" as const,
      },
    ];

    for (const item of cases) {
      const run = await enterReviewing(coordinator, connection, item.id);
      const effect = await reviewEffect(coordinator, run);
      const step = reviewStep(run);
      const finding = reviewFinding(run, step.id);
      const findings =
        item.findings === "included"
          ? [finding]
          : item.findings === undefined
            ? undefined
            : item.findings;

      await expect(
        coordinator.settleExecution({
          runId: run.id,
          expectedRevision: run.revision,
          effectKey: effect.key,
          outcome: item.outcome,
          trigger: item.trigger,
          evidence: "Invalid findings outcome contract.",
          at,
          step,
          ...(findings === undefined ? {} : { findings }),
        }),
      ).rejects.toThrow(/findings|review_needs_repair|nonempty/u);

      expect(
        connection.native
          .prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?")
          .get(run.id),
      ).toEqual({ count: 0 });
      expect(
        connection.native
          .prepare("SELECT COUNT(*) AS count FROM findings WHERE run_id = ?")
          .get(run.id),
      ).toEqual({ count: 0 });
      expect(
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get(effect.key),
      ).toEqual({ status: "in_flight" });
      await coordinator.transition({
        runId: run.id,
        expectedRevision: run.revision,
        trigger: "handoff_required",
        at,
        summary: { text: "Release the test run after rejecting the contract." },
      });
    }
    await coordinator.close();
  });

  test("rolls back step, findings, facts, and effect transition for a stale callback", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterReviewing(coordinator, connection, "run-stale");
    const effect = await reviewEffect(coordinator, run);
    const step = reviewStep(run);
    const finding = reviewFinding(run, step.id);
    await coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision,
      trigger: "handoff_required",
      at,
      summary: { text: "The reviewer callback became stale." },
    });

    await expect(
      coordinator.settleExecution({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey: effect.key,
        outcome: "failed",
        trigger: "review_needs_repair",
        evidence: "Late review callback.",
        at,
        facts: { headSha: "e".repeat(40) },
        step,
        findings: [finding],
      }),
    ).rejects.toBeInstanceOf(StaleRevisionError);

    expect(await readRun(connection.db, run.id)).toMatchObject({
      state: "review",
      revision: run.revision + 1,
      headSha: null,
    });
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?")
        .get(run.id),
    ).toEqual({ count: 0 });
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM findings WHERE run_id = ?")
        .get(run.id),
    ).toEqual({ count: 0 });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(effect.key),
    ).toEqual({ status: "in_flight" });
    await coordinator.close();
  });

  test("rejects stale rework findings and foreign review-step references atomically", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterReviewing(coordinator, connection, "run-validation");
    const effect = await reviewEffect(coordinator, run);
    const step = reviewStep(run);

    await expect(
      coordinator.settleExecution({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey: effect.key,
        outcome: "failed",
        trigger: "review_needs_repair",
        evidence: "Stale rework finding.",
        at,
        step: { ...step, reworkEpoch: run.reworkEpoch + 1 },
        findings: [reviewFinding(run, step.id)],
      }),
    ).rejects.toThrow(/rework epoch|stale/u);

    await expect(
      coordinator.settleExecution({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey: effect.key,
        outcome: "failed",
        trigger: "review_needs_repair",
        evidence: "Foreign review step.",
        at,
        step,
        findings: [
          { ...reviewFinding(run, step.id), reviewStepId: "missing-step" },
        ],
      }),
    ).rejects.toThrow(
      /foreign key|constraint|durable run write|reviewer step/u,
    );

    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?")
        .get(run.id),
    ).toEqual({ count: 0 });
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM findings WHERE run_id = ?")
        .get(run.id),
    ).toEqual({ count: 0 });
    await coordinator.close();
  });
});
