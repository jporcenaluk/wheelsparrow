import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Configuration } from "@wheelsparrow/contracts";
import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import { WorkflowCoordinator } from "./coordinator.js";
import type {
  BuilderAdapter,
  WorkspacePreparationReceipt,
} from "./execution.js";
import {
  createProductionExecution,
  type ProductionIssueReader,
  type ProductionProjectGateway,
} from "./production-execution.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const prompt = "rendered production prompt";
const promptHash = createHash("sha256").update(prompt, "utf8").digest("hex");

const configuration: Configuration = {
  github: {
    owner: "owner",
    repository: "repository",
    project_number: 1,
    status_field: "Status",
    lanes: { ready: "Ready", todo: "Todo", review: "Review", done: "Done" },
    required_labels: ["mvp"],
    priority_field: "Priority",
  },
  poll_interval_seconds: 30,
  workspace_root: ".wheelsparrow/workspaces",
  agent: {
    command: "codex",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    timeout_minutes: 30,
  },
  verification: { command: "pnpm test" },
  staging: {
    workflow: "deploy.yml",
    environment: "staging",
    smoke_command: "pnpm smoke",
  },
};

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(
    join(tmpdir(), "wheelsparrow-production-execution-"),
  );
  directories.push(directory);
  const migrationsDirectory = join(directory, "migrations");
  await cp(migrationSource, migrationsDirectory, { recursive: true });
  const connection = openDatabase(join(directory, "wheelsparrow.sqlite3"));
  migrateDatabase(connection, migrationsDirectory);
  connections.push(connection);
  return connection;
}

function projectGateway(): ProductionProjectGateway {
  return {
    async readProjectItem() {
      return {
        projectItemId: "PVTI_1",
        projectId: "PVT_1",
        projectNumber: 1,
        repository: "owner/repository",
        issueNodeId: "I_1",
        issueNumber: 1,
        isOpen: true,
        status: "Todo",
        revision: "revision-1",
        labels: ["mvp"],
        createdAt: "2026-08-10T09:00:00.000Z",
        dependencies: [],
      };
    },
  };
}

function issueReader(): ProductionIssueReader {
  return {
    async readIssue(issueNumber) {
      expect(issueNumber).toBe(1);
      return {
        issueNumber,
        title: "Run the production execution slice",
        body: "## Acceptance Criteria\n- [ ] Capture the current issue contract.\n- [ ] Execute in the contained worktree.",
      };
    },
  };
}

function receipt(): WorkspacePreparationReceipt {
  return {
    path: "/repository/.wheelsparrow/workspaces/1-run-1",
    branch: "wheelsparrow/1-run-1",
    baseBranch: "main",
    baseSha,
    headSha,
    changedFiles: [],
  };
}

function builder(): BuilderAdapter {
  return {
    async render(input) {
      expect(input.intake.title).toBe("Run the production execution slice");
      expect(input.intake.acceptanceCriteria).toEqual([
        "Capture the current issue contract.",
        "Execute in the contained worktree.",
      ]);
      return { prompt, promptHash };
    },
    async invoke(input) {
      expect(input.worktreePath).toBe(receipt().path);
      return {
        kind: "succeeded",
        terminal: {
          outcome: "completed",
          summary: "Builder completed.",
          validation: ["Builder returned one terminal result."],
        },
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    },
  };
}

describe("production execution composition", () => {
  afterEach(async () => {
    for (const connection of connections.splice(0)) await connection.close();
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("captures the current project and issue before running the real execution workflow", async () => {
    const connection = await createDatabase();
    let coordinator!: WorkflowCoordinator;
    const runtime = createProductionExecution({
      connection,
      coordinator: () => coordinator,
      configuration,
      repositoryRoot: "/repository",
      projectGateway: projectGateway(),
      projectId: "PVT_1",
      issueReader: issueReader(),
      readBaseSha: async () => baseSha,
      workspacePrepare: async () => receipt(),
      workspaceInspect: async () => receipt(),
      builder: builder(),
      verify: async (input) => ({
        kind: "succeeded",
        command: input.command,
        cwd: input.worktreePath,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        headSha,
      }),
    });
    coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: runtime.capability.dispatcher,
      observer: runtime.capability.observer,
    });

    await coordinator.createClaim({
      id: "run-1",
      repository: "owner/repository",
      projectItemId: "PVTI_1",
      issueNodeId: "I_1",
      issueNumber: 1,
      ownerToken: "owner-1",
      at: "2026-08-10T10:00:00.000Z",
      summary: { text: "Claimed run-1." },
    });
    const run = await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-10T10:00:01.000Z",
      summary: { text: "Todo observed." },
    });

    const outcome = await runtime.runClaimedRun(run);

    expect(outcome.kind).toBe("reviewing");
    expect((outcome as { verification: unknown }).verification).toBeDefined();
    await expect(
      coordinator
        .waitForIdle()
        .then(() =>
          connection.db
            .selectFrom("runs")
            .select(["state", "intake_json"])
            .where("id", "=", "run-1")
            .executeTakeFirstOrThrow(),
        ),
    ).resolves.toMatchObject({ state: "reviewing" });
  });

  test("resumes an in-flight workspace effect through the execution dispatcher", async () => {
    const connection = await createDatabase();
    let coordinator!: WorkflowCoordinator;
    let workspaceCalls = 0;
    const runtime = createProductionExecution({
      connection,
      coordinator: () => coordinator,
      configuration,
      repositoryRoot: "/repository",
      projectGateway: projectGateway(),
      projectId: "PVT_1",
      issueReader: issueReader(),
      readBaseSha: async () => baseSha,
      workspacePrepare: async () => {
        workspaceCalls += 1;
        return receipt();
      },
      workspaceInspect: async () => receipt(),
      builder: builder(),
      verify: async (input) => ({
        kind: "succeeded",
        command: input.command,
        cwd: input.worktreePath,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        headSha,
      }),
    });
    coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: runtime.capability.dispatcher,
      observer: runtime.capability.observer,
    });
    await coordinator.createClaim({
      id: "run-1",
      repository: "owner/repository",
      projectItemId: "PVTI_1",
      issueNodeId: "I_1",
      issueNumber: 1,
      ownerToken: "owner-1",
      at: "2026-08-10T10:00:00.000Z",
      summary: { text: "Claimed run-1." },
    });
    const run = await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-10T10:00:01.000Z",
      summary: { text: "Todo observed." },
    });
    const created = await coordinator.createEffectIntent({
      runId: run.id,
      expectedRevision: run.revision,
      key: "run:run-1:workspace:prepare",
      kind: "workspace_prepare",
      intent: {
        runId: run.id,
        issueNumber: run.issueNumber,
        baseBranch: "main",
      },
      dispatch: false,
      at: "2026-08-10T10:00:02.000Z",
    });
    await coordinator.beginEffect({
      effectKey: created.key,
      expectedRevision: run.revision,
      at: "2026-08-10T10:00:03.000Z",
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(created.key) as { status: string };
      if (row.status === "confirmed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(created.key),
    ).toMatchObject({ status: "confirmed" });
    expect(workspaceCalls).toBe(1);
    await coordinator.close();
  });

  test("fails closed when preparation advances origin/main after intake capture", async () => {
    const connection = await createDatabase();
    let coordinator!: WorkflowCoordinator;
    const advancedBaseSha = "c".repeat(40);
    const runtime = createProductionExecution({
      connection,
      coordinator: () => coordinator,
      configuration,
      repositoryRoot: "/repository",
      projectGateway: projectGateway(),
      projectId: "PVT_1",
      issueReader: issueReader(),
      readBaseSha: async () => baseSha,
      workspacePrepare: async () => ({
        ...receipt(),
        baseSha: advancedBaseSha,
      }),
      workspaceInspect: async () => ({
        ...receipt(),
        baseSha: advancedBaseSha,
      }),
      builder: builder(),
      verify: async (input) => ({
        kind: "succeeded",
        command: input.command,
        cwd: input.worktreePath,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        headSha,
      }),
    });
    coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: runtime.capability.dispatcher,
      observer: runtime.capability.observer,
    });
    await coordinator.createClaim({
      id: "run-1",
      repository: "owner/repository",
      projectItemId: "PVTI_1",
      issueNodeId: "I_1",
      issueNumber: 1,
      ownerToken: "owner-1",
      at: "2026-08-10T10:00:00.000Z",
      summary: { text: "Claimed run-1." },
    });
    const run = await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-10T10:00:01.000Z",
      summary: { text: "Todo observed." },
    });

    const outcome = await runtime.runClaimedRun(run);

    expect(outcome.kind).toBe("workspace_failed");
    if (outcome.kind !== "workspace_failed")
      throw new Error("expected a fail-closed workspace result");
    expect(outcome.reason).toMatch(/base SHA/iu);
  });
});
