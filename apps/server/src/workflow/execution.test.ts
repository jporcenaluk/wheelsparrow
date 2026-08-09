import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import { type RunRecord, readRun } from "../database/runs.js";
import { WorkflowCoordinator } from "./coordinator.js";
import {
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

describe("executeClaimedRun", () => {
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
