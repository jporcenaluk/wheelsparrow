import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import { type RunRecord, readRun } from "../database/runs.js";
import { WorkflowCoordinator } from "./coordinator.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
const firstAt = "2026-08-09T09:00:00.000Z";

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-execution-"));
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
    id: "run-1",
    repository: "owner/repository",
    projectItemId: "project-run-1",
    issueNodeId: "issue-run-1",
    issueNumber: 1,
    ownerToken: "owner-run-1",
    at: firstAt,
    summary: { text: "Claim run-1." },
  };
}

function effectInput(
  kind: "workspace_prepare" | "intake_capture" | "agent_build" | "verify",
  key: string,
) {
  return {
    key,
    kind,
    intent: { runId: "run-1", kind },
    dispatch: false,
  } as const;
}

async function createInFlightEffect(
  coordinator: WorkflowCoordinator,
  run: RunRecord,
  input: ReturnType<typeof effectInput>,
) {
  await coordinator.createEffectIntent({
    ...input,
    runId: run.id,
    expectedRevision: run.revision,
  });
  return coordinator.beginEffect({
    effectKey: input.key,
    expectedRevision: run.revision,
  });
}

function step(run: RunRecord, id: string, logicalStep: "build" | "verify") {
  return {
    id,
    runId: run.id,
    expectedRevision: run.revision,
    reworkEpoch: run.reworkEpoch,
    role: logicalStep === "build" ? "builder" : "verifier",
    logicalStep,
    attempt: 1,
    statusSequence: 1,
    status: "completed",
    promptHash: logicalStep === "build" ? "a".repeat(64) : "b".repeat(64),
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    startedAt: "2026-08-09T09:04:00.000Z",
    completedAt: "2026-08-09T09:05:00.000Z",
    exitResultJson: JSON.stringify({ outcome: "completed", logicalStep }),
    summary: { text: `${logicalStep} completed.` },
    rawLogReference: `logs/${id}.jsonl`,
  };
}

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("atomic execution settlement persistence", () => {
  test("persists workspace provenance before settling workspace_prepare", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput());
    await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-09T09:01:00.000Z",
      summary: { text: "Todo observed." },
    });
    const run = await readRun(connection.db, "run-1");
    const effect = await createInFlightEffect(
      coordinator,
      run,
      effectInput("workspace_prepare", "run:run-1:workspace:prepare"),
    );

    const settled = await coordinator.settleExecution({
      runId: "run-1",
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome: "confirmed",
      trigger: "workspace_prepared",
      evidence: "Prepared the contained worktree.",
      at: "2026-08-09T09:02:00.000Z",
      facts: {
        worktreePath: "/tmp/wheelsparrow/run-1",
        baseSha: "a".repeat(40),
        branch: "wheelsparrow/1-run-1",
      },
      receipt: {
        path: "/tmp/wheelsparrow/run-1",
        baseSha: "a".repeat(40),
        branch: "wheelsparrow/1-run-1",
      },
    });

    expect(settled.run).toMatchObject({
      state: "intaking",
      revision: run.revision + 1,
      worktreePath: "/tmp/wheelsparrow/run-1",
      baseSha: "a".repeat(40),
      baseBranch: "main",
      branch: "wheelsparrow/1-run-1",
    });
    expect(settled.effect).toMatchObject({
      key: effect.key,
      status: "confirmed",
    });
    expect(JSON.parse(settled.effect.receipt ?? "null")).toEqual({
      path: "/tmp/wheelsparrow/run-1",
      baseSha: "a".repeat(40),
      branch: "wheelsparrow/1-run-1",
    });
    await coordinator.close();
  });

  test("persists bounded intake JSON before settling intake_capture", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput());
    await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-09T09:01:00.000Z",
      summary: { text: "Todo observed." },
    });
    let run = await readRun(connection.db, "run-1");
    const workspaceEffect = await createInFlightEffect(
      coordinator,
      run,
      effectInput("workspace_prepare", "run:run-1:workspace:prepare"),
    );
    await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: workspaceEffect.key,
      outcome: "confirmed",
      trigger: "workspace_prepared",
      evidence: "Prepared worktree.",
      at: "2026-08-09T09:02:00.000Z",
      facts: {
        worktreePath: "/tmp/wheelsparrow/run-1",
        baseSha: "a".repeat(40),
        branch: "wheelsparrow/1-run-1",
      },
    });
    run = await readRun(connection.db, "run-1");
    const intakeEffect = await createInFlightEffect(
      coordinator,
      run,
      effectInput("intake_capture", "run:run-1:intake:capture"),
    );
    const intakeJson = JSON.stringify({
      body: "Keep this issue bounded.",
      labels: ["mvp"],
    });

    const settled = await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: intakeEffect.key,
      outcome: "confirmed",
      trigger: "intake_captured",
      evidence: "Captured issue intake.",
      at: "2026-08-09T09:03:00.000Z",
      facts: { intakeJson },
    });

    expect(settled.run).toMatchObject({
      state: "building",
      revision: run.revision + 1,
      intakeJson,
    });
    expect(
      Buffer.byteLength(settled.run.intakeJson ?? "", "utf8"),
    ).toBeLessThanOrEqual(1024 * 1024);
    await coordinator.close();
  });

  test("appends builder and verification steps atomically with their transitions", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput());
    await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-09T09:01:00.000Z",
      summary: { text: "Todo observed." },
    });
    let run = await readRun(connection.db, "run-1");
    const workspaceEffect = await createInFlightEffect(
      coordinator,
      run,
      effectInput("workspace_prepare", "run:run-1:workspace:prepare"),
    );
    await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: workspaceEffect.key,
      outcome: "confirmed",
      trigger: "workspace_prepared",
      evidence: "Prepared worktree.",
      at: "2026-08-09T09:02:00.000Z",
      facts: {
        worktreePath: "/tmp/wheelsparrow/run-1",
        baseSha: "a".repeat(40),
        branch: "wheelsparrow/1-run-1",
      },
    });
    run = await readRun(connection.db, "run-1");
    const intakeEffect = await createInFlightEffect(
      coordinator,
      run,
      effectInput("intake_capture", "run:run-1:intake:capture"),
    );
    await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: intakeEffect.key,
      outcome: "confirmed",
      trigger: "intake_captured",
      evidence: "Captured intake.",
      at: "2026-08-09T09:03:00.000Z",
      facts: { intakeJson: JSON.stringify({ title: "Build this." }) },
    });
    run = await readRun(connection.db, "run-1");
    const buildEffect = await createInFlightEffect(
      coordinator,
      run,
      effectInput("agent_build", "run:run-1:agent:builder:attempt:1"),
    );
    const buildStep = step(run, "step-build-1", "build");
    const buildSettled = await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: buildEffect.key,
      outcome: "confirmed",
      trigger: "builder_succeeded",
      evidence: "Builder completed.",
      at: "2026-08-09T09:05:00.000Z",
      facts: { headSha: "b".repeat(40) },
      step: buildStep,
    });
    expect(buildSettled.run).toMatchObject({
      state: "verifying",
      revision: run.revision + 1,
      headSha: "b".repeat(40),
    });

    run = await readRun(connection.db, "run-1");
    const verifyEffect = await createInFlightEffect(
      coordinator,
      run,
      effectInput("verify", "run:run-1:verify:attempt:1"),
    );
    const verifyStep = step(run, "step-verify-1", "verify");
    const verifySettled = await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: verifyEffect.key,
      outcome: "confirmed",
      trigger: "verification_passed",
      evidence: "Verification passed.",
      at: "2026-08-09T09:06:00.000Z",
      step: verifyStep,
    });

    expect(verifySettled.run).toMatchObject({
      state: "reviewing",
      revision: run.revision + 1,
    });
    expect(
      connection.native
        .prepare(
          `SELECT role, logical_step, attempt, status_sequence, status,
                  prompt_hash, model, reasoning_effort, started_at,
                  completed_at, exit_result_json, summary, raw_log_reference
             FROM steps WHERE run_id = ? ORDER BY rowid`,
        )
        .all("run-1"),
    ).toEqual([
      {
        role: "builder",
        logical_step: "build",
        attempt: 1,
        status_sequence: 1,
        status: "completed",
        prompt_hash: "a".repeat(64),
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        started_at: "2026-08-09T09:04:00.000Z",
        completed_at: "2026-08-09T09:05:00.000Z",
        exit_result_json: JSON.stringify({
          outcome: "completed",
          logicalStep: "build",
        }),
        summary: "build completed.",
        raw_log_reference: "logs/step-build-1.jsonl",
      },
      {
        role: "verifier",
        logical_step: "verify",
        attempt: 1,
        status_sequence: 1,
        status: "completed",
        prompt_hash: "b".repeat(64),
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        started_at: "2026-08-09T09:04:00.000Z",
        completed_at: "2026-08-09T09:05:00.000Z",
        exit_result_json: JSON.stringify({
          outcome: "completed",
          logicalStep: "verify",
        }),
        summary: "verify completed.",
        raw_log_reference: "logs/step-verify-1.jsonl",
      },
    ]);
    await coordinator.close();
  });

  test("rejects a stale late callback without facts or step writes", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput());
    await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-09T09:01:00.000Z",
      summary: { text: "Todo observed." },
    });
    let run = await readRun(connection.db, "run-1");
    const workspaceEffect = await createInFlightEffect(
      coordinator,
      run,
      effectInput("workspace_prepare", "run:run-1:workspace:prepare"),
    );
    await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: workspaceEffect.key,
      outcome: "confirmed",
      trigger: "workspace_prepared",
      evidence: "Prepared worktree.",
      at: "2026-08-09T09:02:00.000Z",
      facts: {
        worktreePath: "/tmp/wheelsparrow/run-1",
        baseSha: "a".repeat(40),
        branch: "wheelsparrow/1-run-1",
      },
    });
    run = await readRun(connection.db, "run-1");
    const intakeEffect = await createInFlightEffect(
      coordinator,
      run,
      effectInput("intake_capture", "run:run-1:intake:capture"),
    );
    await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: intakeEffect.key,
      outcome: "confirmed",
      trigger: "intake_captured",
      evidence: "Captured intake.",
      at: "2026-08-09T09:03:00.000Z",
      facts: { intakeJson: JSON.stringify({ title: "Build this." }) },
    });
    run = await readRun(connection.db, "run-1");
    const buildEffect = await createInFlightEffect(
      coordinator,
      run,
      effectInput("agent_build", "run:run-1:agent:builder:attempt:1"),
    );
    await coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision,
      trigger: "builder_succeeded",
      at: "2026-08-09T09:05:00.000Z",
      summary: { text: "A newer command already settled the builder." },
    });
    const before = await readRun(connection.db, "run-1");

    await expect(
      coordinator.settleExecution({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey: buildEffect.key,
        outcome: "confirmed",
        trigger: "builder_succeeded",
        evidence: "Late builder callback.",
        at: "2026-08-09T09:06:00.000Z",
        facts: { headSha: "c".repeat(40) },
        step: step(run, "step-late", "build"),
      }),
    ).rejects.toThrow(/stale/i);

    expect(await readRun(connection.db, "run-1")).toEqual(before);
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ count: 0 });
    expect(
      connection.native
        .prepare("SELECT head_sha FROM runs WHERE id = ?")
        .get("run-1"),
    ).toEqual({ head_sha: null });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(buildEffect.key),
    ).toEqual({ status: "in_flight" });
    await coordinator.close();
  });
});
