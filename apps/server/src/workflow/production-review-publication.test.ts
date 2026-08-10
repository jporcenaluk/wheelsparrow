import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Configuration } from "@wheelsparrow/contracts";
import { afterEach, describe, expect, test } from "vitest";

import { FakeGitHubPublicationGateway } from "../../../../tests/fakes/github.js";
import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import {
  createRunMutationRepository,
  type RunRecord,
  readRun,
} from "../database/runs.js";
import type { GitHubPublicationGateway } from "../github/publication.js";
import { WorkflowCoordinator } from "./coordinator.js";
import { createProductionReviewPublication } from "./production-review-publication.js";
import type { RepairAdapter, ReviewerAdapter } from "./review.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
const at = "2026-08-10T14:00:00.000Z";
const baseSha = "a".repeat(40);
const firstHeadSha = "b".repeat(40);
const repairedHeadSha = "c".repeat(40);

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

const intake = {
  title: "Implement the bounded workflow",
  body: "The issue contract is authoritative.",
  acceptanceCriteria: ["The workflow remains bounded."],
  dependencyState: [],
  project: {
    projectId: "PVT_1",
    projectNumber: 1,
    projectItemId: "PVTI_1",
    issueNodeId: "I_1",
    issueNumber: 1,
    status: "Todo",
    revision: "revision-1",
    labels: ["mvp"],
    createdAt: at,
  },
  repository: "owner/repository",
  baseSha,
  builder: {
    command: "codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    timeoutMinutes: 30,
  },
  verificationCommand: "pnpm test",
};

const verification = {
  kind: "succeeded" as const,
  command: "pnpm test",
  cwd: "/repository/.wheelsparrow/workspaces/1-run-1",
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  headSha: firstHeadSha,
  changedFiles: ["apps/server/src/app.ts"],
};

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-prod-review-"));
  directories.push(directory);
  const migrationsDirectory = join(directory, "migrations");
  await cp(migrationSource, migrationsDirectory, { recursive: true });
  const connection = openDatabase(join(directory, "wheelsparrow.sqlite3"));
  migrateDatabase(connection, migrationsDirectory);
  connections.push(connection);
  return connection;
}

async function enterReviewing(
  connection: ReturnType<typeof openDatabase>,
  coordinator: WorkflowCoordinator,
): Promise<Awaited<ReturnType<typeof readRun>>> {
  await coordinator.createClaim({
    id: "run-production-review",
    repository: "owner/repository",
    projectItemId: "PVTI_1",
    issueNodeId: "I_1",
    issueNumber: 1,
    ownerToken: "owner-production-review",
    at,
    summary: { text: "Production review run." },
  });
  let run = await readRun(connection.db, "run-production-review");
  run = await connection.db.transaction().execute((tx) =>
    createRunMutationRepository(tx).updateExecutionFacts({
      runId: run.id,
      expectedRevision: run.revision,
      facts: {
        worktreePath: verification.cwd,
        baseSha,
        branch: "wheelsparrow/1-run-1",
        headSha: firstHeadSha,
        intakeJson: JSON.stringify(intake),
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
  ] as const) {
    run = await coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision,
      trigger,
      at,
      summary: { text: `${trigger}.` },
    });
  }
  return run;
}

function reviewer(terminal: unknown): ReviewerAdapter {
  return {
    render: async (input) => {
      const prompt = `review ${input.issueNumber} ${input.headSha}`;
      return {
        prompt,
        promptHash: createHash("sha256").update(prompt, "utf8").digest("hex"),
      };
    },
    invoke: async () => terminal,
  };
}

function repairer(terminal: unknown, onInvoke: () => void): RepairAdapter {
  return {
    render: async (input) => {
      const prompt = `repair ${input.issueNumber} ${input.headSha}`;
      return {
        prompt,
        promptHash: createHash("sha256").update(prompt, "utf8").digest("hex"),
      };
    },
    invoke: async () => {
      onInvoke();
      return terminal;
    },
  };
}

function workspace(headSha: string) {
  return {
    path: verification.cwd,
    branch: "wheelsparrow/1-run-1",
    baseBranch: "main" as const,
    baseSha,
    headSha,
    changedFiles: ["apps/server/src/app.ts"],
  };
}

function runtimeOptions(
  connection: ReturnType<typeof openDatabase>,
  coordinator: WorkflowCoordinator,
  gateway: GitHubPublicationGateway,
  reviewerAdapter: ReviewerAdapter,
  repairAdapter?: RepairAdapter,
  headSha = firstHeadSha,
  publishedHeadSha = "d".repeat(40),
  workspaceHead: () => string = () => headSha,
) {
  return {
    connection,
    coordinator: () => coordinator,
    configuration,
    repositoryRoot: "/repository",
    workspaceInspect: async () => workspace(workspaceHead()),
    readDiff: async () =>
      "diff --git a/apps/server/src/app.ts b/apps/server/src/app.ts",
    reviewer: reviewerAdapter,
    ...(repairAdapter === undefined ? {} : { repair: repairAdapter }),
    verify: async () => ({ ...verification, headSha: workspaceHead() }),
    publicationGateway: gateway,
    commitAndPush: async (run: RunRecord) => {
      if (run.branch === null || run.baseSha === null)
        throw new Error("test run has incomplete worktree facts");
      return {
        branch: run.branch,
        baseSha: run.baseSha,
        headSha: publishedHeadSha,
      };
    },
  };
}

function greenGateway(): GitHubPublicationGateway {
  const fake = new FakeGitHubPublicationGateway({
    repository: "owner/repository",
    requiredChecks: ["test"],
  });
  return {
    createPullRequest: async (request) => {
      const receipt = await fake.createPullRequest(request);
      fake.setRequiredCheck(receipt.number, receipt.headSha, "test", "success");
      return receipt;
    },
    reconcilePullRequest: (request) => fake.reconcilePullRequest(request),
    readPullRequest: (request) => fake.readPullRequest(request),
    observeRequiredChecks: (request) => fake.observeRequiredChecks(request),
  };
}

describe("production review and publication composition", () => {
  afterEach(async () => {
    for (const connection of connections.splice(0)) await connection.close();
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("runs independent review, publishes its exact head, and observes green CI", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const gateway = greenGateway();
    const runtime = createProductionReviewPublication(
      runtimeOptions(
        connection,
        coordinator,
        gateway,
        reviewer({
          outcome: "approved",
          summary: "Independent review approved the exact head.",
          validation: ["The exact head was inspected."],
        }),
      ),
    );
    const run = await enterReviewing(connection, coordinator);
    const result = await runtime.runFromVerification(run, verification);

    expect(result).toMatchObject({
      kind: "ci_passed",
      run: { state: "review" },
    });
  });

  test("uses the bounded repair path before publishing the repaired head", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const gateway = greenGateway();
    let repaired = false;
    let currentHead = firstHeadSha;
    const runtime = createProductionReviewPublication(
      runtimeOptions(
        connection,
        coordinator,
        gateway,
        {
          ...reviewer({
            outcome: "needs_repair",
            summary: "The first review found one bounded issue.",
            validation: ["The exact head was inspected."],
            findings: [
              {
                stable_key: "missing-validation",
                severity: "high",
                evidence: "The input is not validated.",
              },
            ],
          }),
          invoke: async () => {
            if (repaired)
              return {
                outcome: "approved",
                summary: "The repaired exact head is approved.",
                validation: ["The repaired exact head was inspected."],
              };
            repaired = true;
            return {
              outcome: "needs_repair",
              summary: "The first review found one bounded issue.",
              validation: ["The exact head was inspected."],
              findings: [
                {
                  stable_key: "missing-validation",
                  severity: "high" as const,
                  evidence: "The input is not validated.",
                },
              ],
            };
          },
        },
        repairer(
          {
            outcome: "completed",
            summary: "The repair added validation.",
            validation: ["pnpm test"],
            changed_files: ["apps/server/src/app.ts"],
          },
          () => {
            repaired = true;
            currentHead = repairedHeadSha;
          },
        ),
        firstHeadSha,
        repairedHeadSha,
        () => currentHead,
      ),
    );
    const run = await enterReviewing(connection, coordinator);
    const result = await runtime.runFromVerification(run, verification);
    expect(result).toMatchObject({ kind: "human", run: { state: "review" } });
    expect((result as { reason: string }).reason).toContain(
      "durable linked pull request identity",
    );
  });
});
