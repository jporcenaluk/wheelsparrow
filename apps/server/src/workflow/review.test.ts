import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import { readRun, StaleRevisionError } from "../database/runs.js";
import { WorkflowCoordinator } from "./coordinator.js";
import { executeReviewRepair, type ReviewRepairInput } from "./review.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
const at = "2026-08-09T14:00:00.000Z";
const baseSha = "a".repeat(40);
const firstHeadSha = "b".repeat(40);
const repairedHeadSha = "c".repeat(40);

function hash(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-review-loop-"));
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
    id: "run-review-loop",
    repository: "owner/repository",
    projectItemId: "project-run-review-loop",
    issueNodeId: "issue-run-review-loop",
    issueNumber: 42,
    ownerToken: "owner-run-review-loop",
    at,
    summary: { text: "Claim the review loop." },
  };
}

function intake() {
  return {
    title: "Implement the bounded review loop",
    body: "The issue contract must remain authoritative.",
    acceptanceCriteria: ["The review is independent."],
    dependencyState: [],
    project: {
      projectId: "project-42",
      projectNumber: 2,
      projectItemId: "project-run-review-loop",
      issueNodeId: "issue-run-review-loop",
      issueNumber: 42,
      status: "Todo",
      revision: "revision-1",
      labels: ["mvp"],
      createdAt: at,
    },
    repository: "owner/repository",
    baseSha,
    builder: {
      command: "codex",
      model: "review-model",
      reasoningEffort: "high",
      timeoutMinutes: 10,
    },
    verificationCommand: "pnpm test:unit",
  } as const;
}

function workspace(headSha: string) {
  return {
    path: "/tmp/wheelsparrow-review-loop/worktree",
    branch: "wheelsparrow/42-review-loop",
    baseBranch: "main" as const,
    baseSha,
    headSha,
    changedFiles: ["apps/server/src/workflow/review.ts"],
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

async function enterReviewing(
  coordinator: WorkflowCoordinator,
  connection: ReturnType<typeof openDatabase>,
): Promise<Awaited<ReturnType<typeof readRun>>> {
  await coordinator.createClaim(claimInput());
  let run = await readRun(connection.db, claimInput().id);
  for (const trigger of [
    "todo_observed",
    "workspace_prepared",
    "intake_captured",
    "builder_succeeded",
    "verification_passed",
  ] as const) {
    run = await coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision,
      trigger,
      at,
      summary: { text: `${trigger}.` },
    });
  }
  connection.native
    .prepare(
      "UPDATE runs SET base_sha = ?, head_sha = ?, worktree_path = ?, branch = ?, intake_json = ? WHERE id = ?",
    )
    .run(
      baseSha,
      firstHeadSha,
      workspace(firstHeadSha).path,
      workspace(firstHeadSha).branch,
      JSON.stringify(intake()),
      run.id,
    );
  return readRun(connection.db, run.id);
}

async function enterRepairing(
  coordinator: WorkflowCoordinator,
  connection: ReturnType<typeof openDatabase>,
): Promise<Awaited<ReturnType<typeof readRun>>> {
  const reviewing = await enterReviewing(coordinator, connection);
  return coordinator.transition({
    runId: reviewing.id,
    expectedRevision: reviewing.revision,
    trigger: "review_needs_repair",
    at,
    summary: { text: "Repair is required." },
  });
}

function repairInput(
  coordinator: WorkflowCoordinator,
  run: Awaited<ReturnType<typeof readRun>>,
  workspaceInspect: NonNullable<ReviewRepairInput["workspaceInspect"]>,
): ReviewRepairInput {
  return {
    coordinator,
    run,
    verification: {
      kind: "succeeded",
      command: "pnpm test:unit",
      cwd: workspace(firstHeadSha).path,
      exitCode: 0,
      signal: null,
      stdout: "verified",
      stderr: "",
      headSha: firstHeadSha,
      changedFiles: workspace(firstHeadSha).changedFiles,
    },
    readDiff: async () => "raw diff",
    readFindings: async () => [
      {
        stable_key: "review.repair",
        severity: "high" as const,
        evidence: "Repair this finding.",
      },
    ],
    reviewer: {
      render: async () => ({ prompt: "unused", promptHash: hash("unused") }),
      invoke: async () => ({
        outcome: "approved" as const,
        summary: "unused",
        validation: [],
      }),
    },
    repair: {
      render: async () => ({ prompt: "repair", promptHash: hash("repair") }),
      invoke: async () => ({
        kind: "succeeded" as const,
        terminal: {
          outcome: "completed" as const,
          summary: "Repaired the finding.",
          validation: ["Checked."],
          changed_files: workspace(firstHeadSha).changedFiles,
        },
        stdout: "repair",
        stderr: "",
      }),
    },
    workspaceInspect,
    now: () => at,
  };
}

describe("durable review and repair sequencing", () => {
  test("runs a fresh review, records findings, repairs in place, re-verifies, and reviews again", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput());
    let run = await readRun(connection.db, claimInput().id);
    await coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision,
      trigger: "todo_observed",
      at,
      summary: { text: "Todo observed." },
    });
    run = await readRun(connection.db, run.id);
    await coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision,
      trigger: "workspace_prepared",
      at,
      summary: { text: "Workspace prepared." },
    });
    run = await readRun(connection.db, run.id);
    const intakeJson = JSON.stringify(intake());
    const intakeEffect = await coordinator.createEffectIntent({
      runId: run.id,
      expectedRevision: run.revision,
      key: `run:${run.id}:intake:capture`,
      kind: "intake_capture",
      intent: intake(),
      dispatch: false,
    });
    const inFlight = await coordinator.beginEffect({
      effectKey: intakeEffect.key,
      expectedRevision: run.revision,
    });
    await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: inFlight.key,
      outcome: "confirmed",
      trigger: "intake_captured",
      evidence: "Intake captured.",
      facts: { intakeJson },
      at,
    });
    run = await readRun(connection.db, run.id);
    await coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision,
      trigger: "builder_succeeded",
      at,
      summary: { text: "Builder succeeded." },
    });
    run = await readRun(connection.db, run.id);
    await coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision,
      trigger: "verification_passed",
      at,
      summary: { text: "Verification passed." },
    });
    connection.native
      .prepare(
        "UPDATE runs SET base_sha = ?, head_sha = ?, worktree_path = ?, branch = ? WHERE id = ?",
      )
      .run(
        baseSha,
        firstHeadSha,
        workspace(firstHeadSha).path,
        workspace(firstHeadSha).branch,
        run.id,
      );
    run = await readRun(connection.db, run.id);

    const calls: string[] = [];
    const input: ReviewRepairInput = {
      coordinator,
      run,
      intake: intake(),
      verification: {
        kind: "succeeded" as const,
        command: "pnpm test:unit",
        cwd: workspace(firstHeadSha).path,
        exitCode: 0,
        signal: null,
        stdout: "verified",
        stderr: "",
        headSha: firstHeadSha,
        changedFiles: workspace(firstHeadSha).changedFiles,
      },
      readDiff: async () => `diff --git a/file b/file\n+repair me`,
      readFindings: async () => [
        {
          stable_key: "review.missing-check",
          severity: "high" as const,
          evidence: "The check is missing.",
        },
      ],
      reviewer: {
        render: async (prompt) => {
          expect(prompt.diff).toContain("repair me");
          expect(prompt.issueBody).not.toContain("builder claimed");
          return { prompt: "review prompt", promptHash: hash("review prompt") };
        },
        invoke: async ({ attempt }) => {
          calls.push(`review:${attempt}`);
          return attempt === 1
            ? {
                kind: "succeeded" as const,
                terminal: {
                  outcome: "needs_repair" as const,
                  summary: "Repair one issue.",
                  validation: ["Raw diff inspected."],
                  findings: [
                    {
                      stable_key: "review.missing-check",
                      severity: "high" as const,
                      evidence: "The check is missing.",
                    },
                  ],
                },
                stdout: "review output",
                stderr: "",
              }
            : {
                kind: "succeeded" as const,
                terminal: {
                  outcome: "approved" as const,
                  summary: "Repair is correct.",
                  validation: ["Fresh diff inspected."],
                },
                stdout: "review output",
                stderr: "",
              };
        },
      },
      repair: {
        render: async (prompt) => {
          expect(prompt.findings[0]?.stable_key).toBe("review.missing-check");
          return { prompt: "repair prompt", promptHash: hash("repair prompt") };
        },
        invoke: async ({ attempt }) => {
          calls.push(`repair:${attempt}`);
          return {
            kind: "succeeded" as const,
            terminal: {
              outcome: "completed" as const,
              summary: "Repaired the listed finding.",
              validation: ["The targeted check now exists."],
              changed_files: ["apps/server/src/workflow/review.ts"],
            },
            stdout: "repair output",
            stderr: "",
          };
        },
      },
      workspaceInspect: async (_run, expected) => {
        const receipt = expected as ReturnType<typeof workspace>;
        return workspace(
          calls.includes("repair:1") ? repairedHeadSha : receipt.headSha,
        );
      },
      verify: async ({ expectedHeadSha }) => ({
        kind: "succeeded" as const,
        command: "pnpm test:unit",
        cwd: workspace(expectedHeadSha).path,
        exitCode: 0,
        signal: null,
        stdout: "verified",
        stderr: "",
        headSha: expectedHeadSha,
      }),
      now: () => at,
    };

    const result = await executeReviewRepair(input);
    expect(result.kind).toBe("approved");
    expect(result.run.state).toBe("publishing");
    expect(calls).toEqual(["review:1", "repair:1", "review:2"]);
    expect(
      connection.native
        .prepare("SELECT key FROM side_effects WHERE run_id = ? ORDER BY key")
        .all(run.id),
    ).toEqual([
      { key: `run:${run.id}:intake:capture` },
      { key: `run:${run.id}:rework:${run.reworkEpoch}:agent:repair:attempt:1` },
      { key: `run:${run.id}:rework:${run.reworkEpoch}:agent:review:attempt:1` },
      { key: `run:${run.id}:rework:${run.reworkEpoch}:agent:review:attempt:2` },
      { key: `run:${run.id}:rework:${run.reworkEpoch}:verify:attempt:2` },
    ]);
    const reviewIntents = connection.native
      .prepare(
        "SELECT key, intent_json FROM side_effects WHERE run_id = ? AND kind IN ('agent_review', 'agent_repair') ORDER BY key",
      )
      .all(run.id) as Array<{ key: string; intent_json: string }>;
    expect(
      reviewIntents.map(({ intent_json: intent }) => JSON.parse(intent)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "review-model",
          reasoningEffort: "high",
        }),
      ]),
    );
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM findings WHERE run_id = ?")
        .get(run.id),
    ).toEqual({ count: 1 });
    const durableStepIds = connection.native
      .prepare("SELECT id FROM steps WHERE run_id = ? ORDER BY rowid")
      .all(run.id) as Array<{ id: string }>;
    expect(durableStepIds.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        `run:${run.id}:rework:0:review:attempt:1:step`,
        `run:${run.id}:rework:0:repair:attempt:1:step`,
        `run:${run.id}:rework:0:review:attempt:2:step`,
      ]),
    );
    expect(
      connection.native
        .prepare(
          "SELECT id, disposition_sequence FROM findings WHERE run_id = ?",
        )
        .all(run.id),
    ).toEqual([
      {
        id: `run:${run.id}:rework:0:finding:review:1:1`,
        disposition_sequence: 1,
      },
    ]);
    await coordinator.close();
  });

  test("does not start a third repair and hands malformed or human outcomes to Review", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput());
    let run = await readRun(connection.db, claimInput().id);
    for (const trigger of [
      "todo_observed",
      "workspace_prepared",
      "intake_captured",
      "builder_succeeded",
      "verification_passed",
      "review_needs_repair",
      "repair_succeeded",
      "verification_passed",
      "review_needs_repair",
      "repair_succeeded",
      "verification_passed",
    ] as const) {
      await coordinator.transition({
        runId: run.id,
        expectedRevision: run.revision,
        trigger,
        at,
        summary: { text: `${trigger}.` },
      });
      run = await readRun(connection.db, run.id);
    }
    connection.native
      .prepare(
        "UPDATE runs SET base_sha = ?, head_sha = ?, worktree_path = ?, branch = ?, intake_json = ? WHERE id = ?",
      )
      .run(
        baseSha,
        firstHeadSha,
        workspace(firstHeadSha).path,
        workspace(firstHeadSha).branch,
        JSON.stringify(intake()),
        run.id,
      );
    run = await readRun(connection.db, run.id);
    const reviewCalls: number[] = [];
    const result = await executeReviewRepair({
      coordinator,
      run,
      intake: intake(),
      verification: {
        kind: "succeeded" as const,
        command: "pnpm test:unit",
        cwd: workspace(firstHeadSha).path,
        exitCode: 0,
        signal: null,
        stdout: "verified",
        stderr: "",
        headSha: firstHeadSha,
        changedFiles: workspace(firstHeadSha).changedFiles,
      },
      readDiff: async () => "raw diff",
      reviewer: {
        render: async () => ({ prompt: "review", promptHash: hash("review") }),
        invoke: async ({ attempt }) => {
          reviewCalls.push(attempt);
          return {
            kind: "succeeded" as const,
            terminal: {
              outcome: "needs_repair" as const,
              summary: "Still broken.",
              validation: ["Checked."],
              findings: [
                {
                  stable_key: "same.finding",
                  severity: "critical" as const,
                  evidence: "Still broken.",
                },
              ],
            },
            stdout: "",
            stderr: "",
          };
        },
      },
      workspaceInspect: async (_run, expected) => ({
        ...(expected as ReturnType<typeof workspace>),
        changedFiles: workspace(firstHeadSha).changedFiles,
      }),
      now: () => at,
    });
    expect(result.kind).toBe("human");
    expect(result.run.state).toBe("review");
    expect(reviewCalls).toEqual([3]);
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM side_effects WHERE run_id = ?")
        .get(run.id),
    ).toEqual({ count: 1 });
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM findings WHERE run_id = ?")
        .get(run.id),
    ).toEqual({ count: 1 });
    await coordinator.close();
  });

  test("settles invalid findings before handing the review effect to Review", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterReviewing(coordinator, connection);
    const result = await executeReviewRepair({
      coordinator,
      run,
      verification: {
        kind: "succeeded" as const,
        command: "pnpm test:unit",
        cwd: workspace(firstHeadSha).path,
        exitCode: 0,
        signal: null,
        stdout: "verified",
        stderr: "",
        headSha: firstHeadSha,
        changedFiles: workspace(firstHeadSha).changedFiles,
      },
      readDiff: async () => "raw diff",
      reviewer: {
        render: async () => ({ prompt: "review", promptHash: hash("review") }),
        invoke: async () => ({
          kind: "succeeded" as const,
          terminal: {
            outcome: "needs_repair" as const,
            summary: "Malformed finding evidence.",
            validation: [],
            findings: [
              {
                stable_key: "review.invalid-evidence",
                severity: "high" as const,
                evidence: " ",
              },
            ],
          },
          stdout: "review output",
          stderr: "",
        }),
      },
      workspaceInspect: async (_run, expected) => ({
        ...(expected as ReturnType<typeof workspace>),
        changedFiles: workspace(firstHeadSha).changedFiles,
      }),
      now: () => at,
    });
    expect(result.kind).toBe("human");
    expect(result.run.state).toBe("review");
    expect(
      connection.native
        .prepare(
          "SELECT status FROM side_effects WHERE run_id = ? AND kind = 'agent_review'",
        )
        .get(run.id),
    ).toEqual({ status: "failed" });
    expect(
      connection.native
        .prepare(
          "SELECT COUNT(*) AS count FROM side_effects WHERE run_id = ? AND status = 'in_flight'",
        )
        .get(run.id),
    ).toEqual({ count: 0 });
    await coordinator.close();
  });

  test("quarantines the review effect when its handoff settlement fails", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterReviewing(coordinator, connection);
    let settleCalls = 0;
    coordinator.settleExecution = async () => {
      settleCalls += 1;
      throw new Error("coordinator unavailable");
    };
    const result = await executeReviewRepair({
      coordinator,
      run,
      verification: {
        kind: "succeeded" as const,
        command: "pnpm test:unit",
        cwd: workspace(firstHeadSha).path,
        exitCode: 0,
        signal: null,
        stdout: "verified",
        stderr: "",
        headSha: firstHeadSha,
        changedFiles: workspace(firstHeadSha).changedFiles,
      },
      readDiff: async () => "raw diff",
      reviewer: {
        render: async () => ({ prompt: "review", promptHash: hash("review") }),
        invoke: async () => ({
          kind: "succeeded" as const,
          terminal: {
            outcome: "needs_repair" as const,
            summary: "Malformed finding evidence.",
            validation: [],
            findings: [
              {
                stable_key: "review.invalid-evidence",
                severity: "high" as const,
                evidence: " ",
              },
            ],
          },
          stdout: "review output",
          stderr: "",
        }),
      },
      workspaceInspect: async (_run, expected) => ({
        ...(expected as ReturnType<typeof workspace>),
        changedFiles: workspace(firstHeadSha).changedFiles,
      }),
      now: () => at,
    });
    expect(result.kind).toBe("human");
    expect(result.run.state).toBe("review");
    expect(settleCalls).toBe(1);
    expect(
      connection.native
        .prepare(
          "SELECT status FROM side_effects WHERE run_id = ? AND kind = 'agent_review'",
        )
        .get(run.id),
    ).toEqual({ status: "ambiguous" });
    expect(
      connection.native
        .prepare(
          "SELECT COUNT(*) AS count FROM side_effects WHERE run_id = ? AND status = 'in_flight'",
        )
        .get(run.id),
    ).toEqual({ count: 0 });
    await coordinator.close();
  });

  test("returns stale when repair handoff settlement is stale", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterRepairing(coordinator, connection);
    coordinator.settleExecution = async () => {
      throw new StaleRevisionError(run.revision);
    };
    let inspectCalls = 0;
    const result = await executeReviewRepair(
      repairInput(coordinator, run, async () => {
        inspectCalls += 1;
        return workspace(inspectCalls >= 3 ? "d".repeat(40) : firstHeadSha);
      }),
    );
    expect(result.kind).toBe("stale");
    expect(inspectCalls).toBe(3);
    expect(
      connection.native
        .prepare(
          "SELECT status FROM side_effects WHERE run_id = ? AND kind = 'agent_repair'",
        )
        .get(run.id),
    ).toEqual({ status: "in_flight" });
    await coordinator.close();
  });

  test("hands off to Review when repair settlement fails non-stale", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterRepairing(coordinator, connection);
    let inspectCalls = 0;
    let settleCalls = 0;
    coordinator.settleExecution = async () => {
      settleCalls += 1;
      throw new Error("coordinator acknowledgement failed");
    };
    const result = await executeReviewRepair(
      repairInput(coordinator, run, async () => {
        inspectCalls += 1;
        return workspace(inspectCalls >= 4 ? repairedHeadSha : firstHeadSha);
      }),
    );
    expect(result.kind).toBe("human");
    expect(result.run.state).toBe("review");
    expect(settleCalls).toBe(1);
    expect(
      connection.native
        .prepare(
          "SELECT status FROM side_effects WHERE run_id = ? AND kind = 'agent_repair'",
        )
        .get(run.id),
    ).toEqual({ status: "ambiguous" });
    expect(
      connection.native
        .prepare(
          "SELECT COUNT(*) AS count FROM side_effects WHERE run_id = ? AND status = 'in_flight'",
        )
        .get(run.id),
    ).toEqual({ count: 0 });
    await coordinator.close();
  });

  test("durably hands a missing repair capability from repairing to Review", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput());
    let run = await readRun(connection.db, claimInput().id);
    for (const trigger of [
      "todo_observed",
      "workspace_prepared",
      "intake_captured",
      "builder_succeeded",
      "verification_passed",
      "review_needs_repair",
    ] as const) {
      await coordinator.transition({
        runId: run.id,
        expectedRevision: run.revision,
        trigger,
        at,
        summary: { text: `${trigger}.` },
      });
      run = await readRun(connection.db, run.id);
    }
    connection.native
      .prepare(
        "UPDATE runs SET base_sha = ?, head_sha = ?, worktree_path = ?, branch = ?, intake_json = ? WHERE id = ?",
      )
      .run(
        baseSha,
        firstHeadSha,
        workspace(firstHeadSha).path,
        workspace(firstHeadSha).branch,
        JSON.stringify(intake()),
        run.id,
      );
    run = await readRun(connection.db, run.id);

    const result = await executeReviewRepair({
      coordinator,
      run,
      intake: intake(),
      verification: { kind: "succeeded", headSha: firstHeadSha },
      readDiff: async () => "diff",
      reviewer: {
        render: async () => ({ prompt: "unused", promptHash: hash("unused") }),
        invoke: async () => ({
          outcome: "approved" as const,
          summary: "unused",
          validation: [],
        }),
      },
    });

    expect(result.kind).toBe("human");
    expect(result.run.state).toBe("review");
    expect(result.run.revision).toBe(run.revision + 1);
    expect(result.run.requiredAction).toMatch(/repair capability/iu);
    await coordinator.close();
  });
});
