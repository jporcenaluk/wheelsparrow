import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../database/connection.js";
import type { EffectRecord } from "../database/effects.js";
import { migrateDatabase } from "../database/migrate.js";
import { type RunRecord, readRun } from "../database/runs.js";
import { WorkflowCoordinator } from "./coordinator.js";
import {
  createExecutionCapability,
  executeClaimedRun,
  type IntakeCapture,
  type WorkspacePreparationReceipt,
} from "./execution.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
const firstAt = "2026-08-09T10:00:00.000Z";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const builtHeadSha = "c".repeat(40);
const prompt = "rendered builder prompt";
const promptHash = createHash("sha256").update(prompt, "utf8").digest("hex");

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

async function preparingRun(
  coordinator: WorkflowCoordinator,
  connection: ReturnType<typeof openDatabase>,
): Promise<RunRecord> {
  await coordinator.createClaim(claimInput());
  await coordinator.transition({
    runId: "run-1",
    expectedRevision: 1,
    trigger: "todo_observed",
    at: "2026-08-09T10:01:00.000Z",
    summary: { text: "Todo observed." },
  });
  return readRun(connection.db, "run-1");
}

function receipt(): WorkspacePreparationReceipt {
  return {
    path: "/tmp/wheelsparrow/run-1",
    branch: "wheelsparrow/1-run-1",
    baseBranch: "main",
    baseSha,
    headSha,
    changedFiles: [],
  };
}

function intakeCapture(): IntakeCapture {
  return {
    title: "Capture this issue",
    body: "Keep this issue bounded.",
    acceptanceCriteria: ["The intake is persisted exactly once."],
    dependencyState: [],
    project: {
      projectId: "project-1",
      projectNumber: 1,
      projectItemId: "project-run-1",
      issueNodeId: "issue-run-1",
      issueNumber: 1,
      status: "Todo",
      revision: "revision-1",
      labels: ["mvp"],
      createdAt: "2026-08-09T09:00:00.000Z",
    },
    repository: "owner/repository",
    baseSha,
    builder: {
      command: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      timeoutMinutes: 30,
    },
    verificationCommand: "pnpm test:unit",
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

test("execution capability fails closed for an unprovable restarted builder", async () => {
  let builderCalls = 0;
  const capability = createExecutionCapability({
    readRun: async () => {
      throw new Error("run is unavailable");
    },
    builder: {
      render: async () => ({ prompt, promptHash }),
      invoke: async () => {
        builderCalls += 1;
        throw new Error("must not run during observation");
      },
    },
  });
  const effect = {
    key: "run:run-1:agent:builder:attempt:1",
    runId: "run-1",
    reworkEpoch: 0,
    kind: "agent_build",
    targetRevision: 4,
    intent: JSON.stringify({}),
    status: "ambiguous",
  } as unknown as EffectRecord;

  const observer = capability.observer as (
    effect: EffectRecord,
  ) => Promise<{ outcome: string; evidence?: string }>;
  await expect(observer(effect)).resolves.toMatchObject({
    outcome: "ambiguous",
    evidence: expect.stringMatching(/cannot prove|unavailable/iu),
  });
  expect(builderCalls).toBe(0);
});

test("execution capability delegates durable dispatch to its coordinator-owned seam", async () => {
  const connection = await createDatabase();
  const coordinator = new WorkflowCoordinator({ connection });
  const run = await preparingRun(coordinator, connection);
  const executed: string[] = [];
  const capability = createExecutionCapability({
    readRun: async () => run,
    execute: async (effect) => {
      executed.push(effect.key);
    },
  });
  const effect = {
    key: "run:run-1:workspace:prepare",
    runId: "run-1",
    reworkEpoch: run.reworkEpoch,
    kind: "workspace_prepare",
    targetRevision: run.revision,
    intent: '{"baseBranch":"main","issueNumber":1,"runId":"run-1"}',
    status: "in_flight",
  } as unknown as EffectRecord;

  const dispatcher = capability.dispatcher as (
    effect: EffectRecord,
  ) => Promise<unknown>;
  await expect(dispatcher(effect)).resolves.toBeUndefined();
  expect(executed).toEqual([effect.key]);
  await coordinator.close();
});

describe("executeClaimedRun", () => {
  test("runs builder after committed intake and persists its receipt atomically", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await preparingRun(coordinator, connection);
    const preparing = await executeClaimedRun({
      coordinator,
      run,
      now: () => "2026-08-09T10:02:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => receipt(),
      workspaceInspect: async () => receipt(),
    });
    expect(preparing.kind).toBe("building");
    const building = await readRun(connection.db, "run-1");
    const intentStatuses: string[] = [];
    let inspectCalls = 0;

    const outcome = await executeClaimedRun({
      coordinator,
      run: building,
      now: () => "2026-08-09T10:02:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => {
        throw new Error("workspace must not run from building");
      },
      workspaceInspect: async () => {
        inspectCalls += 1;
        return { ...receipt(), headSha: builtHeadSha };
      },
      builder: {
        render: async (input) => {
          expect(input.worktreePath).toBe(receipt().path);
          expect(input.intake).toEqual(intakeCapture());
          return { prompt, promptHash: promptHash };
        },
        invoke: async (input) => {
          intentStatuses.push(
            (
              connection.native
                .prepare("SELECT status FROM side_effects WHERE key = ?")
                .get("run:run-1:agent:builder:attempt:1") as { status: string }
            ).status,
          );
          expect(input.worktreePath).toBe(receipt().path);
          expect(input.intake).toEqual(intakeCapture());
          return {
            kind: "succeeded" as const,
            terminal: {
              outcome: "completed" as const,
              summary: "Implemented the issue.",
              validation: ["pnpm test:unit"],
            },
            stdout: "builder output",
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });

    expect(inspectCalls).toBe(2);
    expect(intentStatuses).toEqual(["in_flight"]);
    expect(outcome).toMatchObject({
      kind: "verifying",
      run: {
        id: "run-1",
        state: "verifying",
        revision: building.revision + 1,
        worktreePath: receipt().path,
        branch: receipt().branch,
        baseSha,
        headSha: builtHeadSha,
      },
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
        prompt_hash: promptHash,
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        started_at: "2026-08-09T10:02:00.000Z",
        completed_at: "2026-08-09T10:02:00.000Z",
        exit_result_json: JSON.stringify({
          kind: "succeeded",
          promptHash: promptHash,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          terminal: {
            outcome: "completed",
            summary: "Implemented the issue.",
            validation: ["pnpm test:unit"],
          },
          stdout: "builder output",
          stderr: "",
          exitCode: 0,
          headSha: builtHeadSha,
          changedFiles: [],
        }),
        summary: "Implemented the issue.",
        raw_log_reference: "logs/run-1/builder/attempt-1.jsonl",
      },
    ]);
    await coordinator.close();
  });

  test("runs workspace, builder, and verification in durable order", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const order: string[] = [];
    const intentStatuses: string[] = [];
    let inspectCalls = 0;

    const outcome = await executeClaimedRun({
      coordinator,
      run: await preparingRun(coordinator, connection),
      now: () => "2026-08-09T10:02:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => {
        order.push("workspace");
        intentStatuses.push(
          (
            connection.native
              .prepare("SELECT status FROM side_effects WHERE key = ?")
              .get("run:run-1:workspace:prepare") as { status: string }
          ).status,
        );
        return receipt();
      },
      workspaceInspect: async () => {
        inspectCalls += 1;
        return inspectCalls === 1
          ? receipt()
          : { ...receipt(), headSha: builtHeadSha };
      },
      builder: {
        render: async (input) => {
          expect(input.worktreePath).toBe(receipt().path);
          expect(input.intake).toEqual(intakeCapture());
          return { prompt, promptHash: promptHash };
        },
        invoke: async (input) => {
          order.push("builder");
          intentStatuses.push(
            (
              connection.native
                .prepare("SELECT status FROM side_effects WHERE key = ?")
                .get("run:run-1:agent:builder:attempt:1") as { status: string }
            ).status,
          );
          expect(input.worktreePath).toBe(receipt().path);
          expect(input.intake).toEqual(intakeCapture());
          return {
            kind: "succeeded" as const,
            terminal: {
              outcome: "completed" as const,
              summary: "Implemented the issue.",
              validation: ["pnpm test:unit"],
            },
            stdout: "builder output",
            stderr: "",
            exitCode: 0,
          };
        },
      },
      verify: async (input) => {
        order.push("verify");
        intentStatuses.push(
          (
            connection.native
              .prepare("SELECT status FROM side_effects WHERE key = ?")
              .get("run:run-1:rework:0:verify:attempt:1") as { status: string }
          ).status,
        );
        expect(input.worktreePath).toBe(receipt().path);
        expect(input.intake).toEqual(intakeCapture());
        expect(input.command).toBe(intakeCapture().verificationCommand);
        expect(input.expectedHeadSha).toBe(builtHeadSha);
        return {
          kind: "succeeded" as const,
          command: intakeCapture().verificationCommand,
          cwd: receipt().path,
          exitCode: 0,
          signal: null,
          stdout: "verification output",
          stderr: "",
          headSha: builtHeadSha,
        };
      },
    });

    expect(order).toEqual(["workspace", "builder", "verify"]);
    expect(intentStatuses).toEqual(["in_flight", "in_flight", "in_flight"]);
    expect(inspectCalls).toBe(3);
    expect(outcome).toMatchObject({
      kind: "reviewing",
      run: {
        id: "run-1",
        state: "reviewing",
        revision: 6,
        headSha: builtHeadSha,
      },
    });
    expect(
      connection.native
        .prepare(
          `SELECT role, logical_step, attempt, status_sequence, status,
                  prompt_hash, model, reasoning_effort, exit_result_json,
                  summary, raw_log_reference
             FROM steps WHERE run_id = ? ORDER BY rowid`,
        )
        .all("run-1"),
    ).toHaveLength(2);
    await coordinator.close();
  });

  test("fails closed when verification changes the assigned worktree", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    let inspectCalls = 0;
    const outcome = await executeClaimedRun({
      coordinator,
      run: await preparingRun(coordinator, connection),
      now: () => "2026-08-09T10:02:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => receipt(),
      workspaceInspect: async () => {
        inspectCalls += 1;
        if (inspectCalls === 1) return receipt();
        if (inspectCalls === 2) return { ...receipt(), headSha: builtHeadSha };
        return { ...receipt(), headSha: "d".repeat(40) };
      },
      builder: {
        render: async () => ({ prompt, promptHash }),
        invoke: async () => ({
          kind: "succeeded" as const,
          terminal: {
            outcome: "completed" as const,
            summary: "Implemented the issue.",
            validation: ["pnpm test:unit"],
          },
          stdout: "builder output",
          stderr: "",
          exitCode: 0,
        }),
      },
      verify: async () => ({
        kind: "succeeded" as const,
        command: intakeCapture().verificationCommand,
        cwd: receipt().path,
        exitCode: 0,
        signal: null,
        stdout: "verification output",
        stderr: "",
        headSha: builtHeadSha,
      }),
    });
    if (outcome.kind !== "verification_failed")
      throw new Error(`Expected verification failure, got ${outcome.kind}.`);
    expect(outcome.run.state).toBe("repairing");
    expect(outcome.reason).toMatch(/changed after the command/iu);
    expect(inspectCalls).toBe(3);
    await coordinator.close();
  });

  test("rejects a prompt hash that does not hash the rendered prompt", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const preparing = await executeClaimedRun({
      coordinator,
      run: await preparingRun(coordinator, connection),
      now: () => "2026-08-09T10:02:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => receipt(),
      workspaceInspect: async () => receipt(),
    });
    expect(preparing.kind).toBe("building");
    const building = await readRun(connection.db, "run-1");
    let invokeCalls = 0;

    await expect(
      executeClaimedRun({
        coordinator,
        run: building,
        now: () => "2026-08-09T10:03:00.000Z",
        intake: intakeCapture(),
        workspacePrepare: async () => receipt(),
        workspaceInspect: async () => receipt(),
        builder: {
          render: async () => ({ prompt, promptHash: "a".repeat(64) }),
          invoke: async () => {
            invokeCalls += 1;
            return {};
          },
        },
      }),
    ).rejects.toThrow(/prompt hash/iu);
    expect(invokeCalls).toBe(0);
    expect(
      connection.native
        .prepare("SELECT key FROM side_effects WHERE kind = ?")
        .all("agent_build"),
    ).toEqual([]);
    await coordinator.close();
  });

  test("routes a failed verification to repair without invoking repair", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const builderPhase = await executeClaimedRun({
      coordinator,
      run: await preparingRun(coordinator, connection),
      now: () => "2026-08-09T10:02:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => receipt(),
      workspaceInspect: async () => receipt(),
      builder: {
        render: async () => ({ prompt, promptHash: promptHash }),
        invoke: async () => ({
          kind: "succeeded" as const,
          terminal: {
            outcome: "completed" as const,
            summary: "Implemented the issue.",
            validation: ["pnpm test:unit"],
          },
          stdout: "builder output",
          stderr: "",
          exitCode: 0,
        }),
      },
    });
    expect(builderPhase).toMatchObject({ kind: "verifying" });
    const verifying = await readRun(connection.db, "run-1");
    let verifyCalls = 0;

    const outcome = await executeClaimedRun({
      coordinator,
      run: verifying,
      now: () => "2026-08-09T10:03:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => receipt(),
      workspaceInspect: async () => receipt(),
      verify: async () => {
        verifyCalls += 1;
        return {
          kind: "failed" as const,
          reason: "nonzero_exit" as const,
          command: intakeCapture().verificationCommand,
          cwd: receipt().path,
          exitCode: 1,
          signal: null,
          stdout: "failing test",
          stderr: "",
          headSha: receipt().headSha,
        };
      },
    });

    expect(verifyCalls).toBe(1);
    expect(outcome).toMatchObject({
      kind: "verification_failed",
      run: { state: "repairing", repairRound: 1 },
    });
    expect(
      connection.native
        .prepare("SELECT key, status FROM side_effects WHERE key = ?")
        .get("run:run-1:rework:0:verify:attempt:1"),
    ).toEqual({
      key: "run:run-1:rework:0:verify:attempt:1",
      status: "failed",
    });
    expect(
      JSON.parse(
        (
          connection.native
            .prepare(
              "SELECT exit_result_json FROM steps WHERE logical_step = ?",
            )
            .get("verify") as { exit_result_json: string }
        ).exit_result_json,
      ),
    ).toMatchObject({
      kind: "failed",
      command: intakeCapture().verificationCommand,
      exitCode: 1,
      headSha: receipt().headSha,
      stdout: "failing test",
    });
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ count: 2 });
    await coordinator.close();
  });

  test("does not invoke a confirmed verification effect on a stale resume", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const builderPhase = await executeClaimedRun({
      coordinator,
      run: await preparingRun(coordinator, connection),
      now: () => "2026-08-09T10:02:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => receipt(),
      workspaceInspect: async () => receipt(),
      builder: {
        render: async () => ({ prompt, promptHash: promptHash }),
        invoke: async () => ({
          kind: "succeeded" as const,
          terminal: {
            outcome: "completed" as const,
            summary: "Implemented the issue.",
            validation: ["pnpm test:unit"],
          },
          stdout: "builder output",
          stderr: "",
          exitCode: 0,
        }),
      },
    });
    expect(builderPhase).toMatchObject({ kind: "verifying" });
    const verifying = await readRun(connection.db, "run-1");
    let verifyCalls = 0;
    const verify = async () => {
      verifyCalls += 1;
      return {
        kind: "succeeded" as const,
        command: intakeCapture().verificationCommand,
        cwd: receipt().path,
        exitCode: 0,
        signal: null,
        stdout: "verification output",
        stderr: "",
        headSha: receipt().headSha,
      };
    };

    const first = await executeClaimedRun({
      coordinator,
      run: verifying,
      now: () => "2026-08-09T10:03:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => receipt(),
      workspaceInspect: async () => receipt(),
      verify,
    });
    const resumed = await executeClaimedRun({
      coordinator,
      run: verifying,
      now: () => "2026-08-09T10:04:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => receipt(),
      workspaceInspect: async () => receipt(),
      verify,
    });

    expect(first).toMatchObject({ kind: "reviewing" });
    expect(resumed).toEqual({ kind: "stale", run: verifying });
    expect(verifyCalls).toBe(1);
    await coordinator.close();
  });

  test.each([
    [
      "throws",
      async () => {
        throw new Error("builder unavailable");
      },
    ],
    [
      "returns a blocked terminal",
      async () => ({
        kind: "succeeded" as const,
        terminal: {
          outcome: "blocked" as const,
          summary: "The builder could not continue.",
          validation: [],
          requested_action: "Provide the missing dependency.",
        },
        stdout: "builder output",
        stderr: "",
        exitCode: 0,
      }),
    ],
    [
      "returns a failed runner classification",
      async () => ({
        kind: "failed" as const,
        reason: "timeout" as const,
        stdout: "partial builder output",
        stderr: "builder timed out",
        exitCode: null,
        signal: "SIGTERM" as const,
        error: "timed out after 30 minutes",
      }),
    ],
  ] as const)(
    "hands off after a builder %s without verification",
    async (description, invoke) => {
      const connection = await createDatabase();
      const coordinator = new WorkflowCoordinator({ connection });
      const preparing = await executeClaimedRun({
        coordinator,
        run: await preparingRun(coordinator, connection),
        now: () => "2026-08-09T10:02:00.000Z",
        intake: intakeCapture(),
        workspacePrepare: async () => receipt(),
        workspaceInspect: async () => receipt(),
      });
      expect(preparing.kind).toBe("building");
      const building = await readRun(connection.db, "run-1");
      let inspectCalls = 0;

      const outcome = await executeClaimedRun({
        coordinator,
        run: building,
        now: () => "2026-08-09T10:03:00.000Z",
        intake: intakeCapture(),
        workspacePrepare: async () => {
          throw new Error("workspace must not run from building");
        },
        workspaceInspect: async () => {
          inspectCalls += 1;
          return receipt();
        },
        builder: {
          render: async () => ({ prompt, promptHash: promptHash }),
          invoke,
        },
      });

      expect(inspectCalls).toBe(1);
      expect(outcome).toMatchObject({
        kind: "builder_failed",
        run: { state: "review" },
      });
      expect((outcome as { reason: string }).reason).toMatch(/builder/iu);
      expect(
        connection.native
          .prepare(
            "SELECT key, kind, status, failure FROM side_effects WHERE key = ?",
          )
          .get("run:run-1:agent:builder:attempt:1"),
      ).toMatchObject({
        key: "run:run-1:agent:builder:attempt:1",
        kind: "agent_build",
        status: "failed",
      });
      expect(
        connection.native
          .prepare("SELECT status, summary FROM steps WHERE run_id = ?")
          .get("run-1"),
      ).toMatchObject({ status: "failed" });
      if (description === "returns a blocked terminal") {
        const step = connection.native
          .prepare("SELECT exit_result_json FROM steps WHERE logical_step = ?")
          .get("build") as { exit_result_json: string };
        expect(JSON.parse(step.exit_result_json)).toMatchObject({
          terminal: {
            outcome: "blocked",
            requested_action: "Provide the missing dependency.",
          },
        });
      }
      if (description === "returns a failed runner classification") {
        const step = connection.native
          .prepare("SELECT exit_result_json FROM steps WHERE logical_step = ?")
          .get("build") as { exit_result_json: string };
        expect(JSON.parse(step.exit_result_json)).toMatchObject({
          kind: "failed",
          stdout: "partial builder output",
          stderr: "builder timed out",
          signal: "SIGTERM",
          error: "timed out after 30 minutes",
        });
      }
      await coordinator.close();
    },
  );

  test("does not invoke a confirmed builder effect on a stale resume", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const preparing = await executeClaimedRun({
      coordinator,
      run: await preparingRun(coordinator, connection),
      now: () => "2026-08-09T10:02:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => receipt(),
      workspaceInspect: async () => receipt(),
    });
    expect(preparing.kind).toBe("building");
    const building = await readRun(connection.db, "run-1");
    let builderCalls = 0;
    const builder = {
      render: async () => ({ prompt, promptHash: promptHash }),
      invoke: async () => {
        builderCalls += 1;
        return {
          kind: "succeeded" as const,
          terminal: {
            outcome: "completed" as const,
            summary: "Implemented the issue.",
            validation: ["pnpm test:unit"],
          },
          stdout: "builder output",
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const first = await executeClaimedRun({
      coordinator,
      run: building,
      now: () => "2026-08-09T10:03:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => receipt(),
      workspaceInspect: async () => ({ ...receipt(), headSha: builtHeadSha }),
      builder,
    });
    const resumed = await executeClaimedRun({
      coordinator,
      run: building,
      now: () => "2026-08-09T10:04:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => receipt(),
      workspaceInspect: async () => ({ ...receipt(), headSha: builtHeadSha }),
      builder,
    });

    expect(first).toMatchObject({ kind: "verifying" });
    expect(resumed).toEqual({ kind: "stale", run: building });
    expect(builderCalls).toBe(1);
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ count: 1 });
    await coordinator.close();
  });

  test("commits workspace intent before the edge and settles deterministic intake", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await preparingRun(coordinator, connection);
    const dispatchStatuses: string[] = [];
    let workspaceCalls = 0;
    let inspected: unknown;

    const outcome = await executeClaimedRun({
      coordinator,
      run,
      now: () => "2026-08-09T10:02:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async (candidate) => {
        workspaceCalls += 1;
        expect(candidate.id).toBe(run.id);
        const effect = connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get("run:run-1:workspace:prepare") as { status: string } | undefined;
        dispatchStatuses.push(effect?.status ?? "missing");
        return { ...receipt(), untrusted: "raw" };
      },
      workspaceInspect: async (candidate, expected) => {
        expect(candidate.id).toBe(run.id);
        inspected = expected;
        return receipt();
      },
    });
    expect(inspected).toEqual({ ...receipt(), untrusted: "raw" });

    expect(workspaceCalls).toBe(1);
    expect(dispatchStatuses).toEqual(["in_flight"]);
    expect(outcome).toMatchObject({
      kind: "building",
      run: {
        id: "run-1",
        state: "building",
        revision: run.revision + 2,
        worktreePath: receipt().path,
        branch: receipt().branch,
        baseBranch: "main",
        baseSha,
        headSha,
      },
    });

    const persisted = await readRun(connection.db, "run-1");
    expect(persisted).toMatchObject({ state: "building" });
    expect(JSON.parse(persisted.intakeJson ?? "null")).toEqual(intakeCapture());
    expect(
      connection.native
        .prepare("SELECT receipt_json FROM side_effects WHERE key = ?")
        .get("run:run-1:workspace:prepare"),
    ).toMatchObject({ receipt_json: expect.any(String) });
    expect(
      JSON.parse(
        (
          connection.native
            .prepare("SELECT receipt_json FROM side_effects WHERE key = ?")
            .get("run:run-1:workspace:prepare") as { receipt_json: string }
        ).receipt_json,
      ),
    ).toEqual(receipt());
    expect(
      connection.native
        .prepare("SELECT key, status FROM side_effects ORDER BY key")
        .all(),
    ).toEqual([
      {
        key: "run:run-1:intake:capture",
        status: "confirmed",
      },
      {
        key: "run:run-1:workspace:prepare",
        status: "confirmed",
      },
    ]);
    await coordinator.close();
  });

  test.each([
    ["malformed inspection", async () => ({ path: "/tmp/not-enough" })],
    [
      "inspection changed-files escape",
      async () => ({ ...receipt(), changedFiles: ["../escape"] }),
    ],
    [
      "failed edge",
      async () => {
        throw new Error("workspace unavailable");
      },
    ],
  ] as const)("does not invoke intake after a %s", async (_, inspect) => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await preparingRun(coordinator, connection);
    let intakeKeyExists = false;
    let inspectCalls = 0;

    const outcome = await executeClaimedRun({
      coordinator,
      run,
      now: () => "2026-08-09T10:02:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => receipt(),
      workspaceInspect: async () => {
        inspectCalls += 1;
        try {
          return await inspect();
        } finally {
          intakeKeyExists =
            connection.native
              .prepare("SELECT 1 AS present FROM side_effects WHERE key = ?")
              .get("run:run-1:intake:capture") !== undefined;
        }
      },
    });

    expect(outcome).toMatchObject({
      kind: "workspace_failed",
      run: { state: "rolling_back_claim" },
    });
    expect(intakeKeyExists).toBe(false);
    expect(inspectCalls).toBe(1);
    expect(
      connection.native.prepare("SELECT key, status FROM side_effects").all(),
    ).toEqual([
      {
        key: "run:run-1:workspace:prepare",
        status: "failed",
      },
    ]);
    await coordinator.close();
  });

  test("does not inspect or capture intake when workspace preparation throws", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await preparingRun(coordinator, connection);
    let inspectCalls = 0;

    const outcome = await executeClaimedRun({
      coordinator,
      run,
      now: () => "2026-08-09T10:02:00.000Z",
      intake: intakeCapture(),
      workspacePrepare: async () => {
        throw new Error("workspace unavailable");
      },
      workspaceInspect: async () => {
        inspectCalls += 1;
        return receipt();
      },
    });

    expect(outcome).toMatchObject({
      kind: "workspace_failed",
      run: { state: "rolling_back_claim" },
    });
    expect(inspectCalls).toBe(0);
    expect(
      connection.native.prepare("SELECT key, status FROM side_effects").all(),
    ).toEqual([
      {
        key: "run:run-1:workspace:prepare",
        status: "failed",
      },
    ]);
    expect(
      connection.native
        .prepare("SELECT 1 FROM side_effects WHERE key = ?")
        .get("run:run-1:intake:capture"),
    ).toBeUndefined();
    await coordinator.close();
  });

  test("does not invoke workspace preparation twice for a stale resume", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await preparingRun(coordinator, connection);
    let workspaceCalls = 0;
    const workspacePrepare = async () => {
      workspaceCalls += 1;
      return receipt();
    };

    await executeClaimedRun({
      coordinator,
      run,
      now: () => "2026-08-09T10:02:00.000Z",
      intake: intakeCapture(),
      workspacePrepare,
      workspaceInspect: async () => receipt(),
    });
    const resumed = await executeClaimedRun({
      coordinator,
      run,
      now: () => "2026-08-09T10:03:00.000Z",
      intake: intakeCapture(),
      workspacePrepare,
      workspaceInspect: async () => receipt(),
    });

    expect(workspaceCalls).toBe(1);
    expect(resumed).toMatchObject({ kind: "stale", run });
    await coordinator.close();
  });

  test.each([
    ["missing title", { title: "" }],
    ["missing project fields", { project: undefined }],
    ["missing builder configuration", { builder: undefined }],
  ] as const)(
    "rejects incomplete intake before workspace call (%s)",
    async (_, patch) => {
      const connection = await createDatabase();
      const coordinator = new WorkflowCoordinator({ connection });
      const run = await preparingRun(coordinator, connection);
      let workspaceCalls = 0;
      const candidate = {
        ...intakeCapture(),
        ...patch,
      } as unknown as IntakeCapture;

      await expect(
        executeClaimedRun({
          coordinator,
          run,
          intake: candidate,
          workspacePrepare: async () => {
            workspaceCalls += 1;
            return receipt();
          },
          workspaceInspect: async () => receipt(),
        }),
      ).rejects.toThrow(/intake/iu);
      expect(workspaceCalls).toBe(0);
      expect(
        connection.native
          .prepare("SELECT key FROM side_effects WHERE run_id = ?")
          .all("run-1"),
      ).toEqual([]);
      await coordinator.close();
    },
  );
});
