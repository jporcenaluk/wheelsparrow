import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import { readRun } from "../database/runs.js";
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
      verification: { command: "pnpm test:unit", headSha: firstHeadSha },
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
          receipt.headSha === firstHeadSha ? repairedHeadSha : receipt.headSha,
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
      { key: `run:${run.id}:agent:repair:attempt:1` },
      { key: `run:${run.id}:agent:review:attempt:1` },
      { key: `run:${run.id}:agent:review:attempt:2` },
      { key: `run:${run.id}:intake:capture` },
      { key: `run:${run.id}:verify:attempt:2` },
    ]);
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM findings WHERE run_id = ?")
        .get(run.id),
    ).toEqual({ count: 1 });
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
      verification: "verification evidence",
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
    await coordinator.close();
  });
});
