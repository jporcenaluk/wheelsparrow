import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import { FakeGitHubDeliveryGateway } from "../../../../tests/fakes/github.js";
import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import { createRunMutationRepository, readRun } from "../database/runs.js";
import type {
  MergeCandidateReceipt,
  StagingDeploymentReceipt,
  StagingWorkflowRunReceipt,
} from "../github/delivery.js";
import { WorkflowCoordinator } from "./coordinator.js";
import {
  executeMergeStage,
  executeProjectDoneStage,
  executeSmokeStage,
  executeStagingStage,
  type SmokeRunner,
} from "./delivery.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
const at = "2026-08-09T21:00:00.000Z";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const mergeSha = "c".repeat(40);

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(
    join(tmpdir(), "wheelsparrow-delivery-stage-"),
  );
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
    id: "run-delivery-stage",
    repository: "octo/widget",
    projectItemId: "PVTI_1",
    issueNodeId: "I_42",
    issueNumber: 42,
    ownerToken: "owner-delivery-stage",
    at,
    summary: { text: "Deliver the stage test run." },
  };
}

function candidate(): MergeCandidateReceipt {
  return {
    repository: "octo/widget",
    number: 7,
    issueNumber: 42,
    nodeId: "PR_node_7",
    isDraft: false,
    title: "feat: deliver the stage",
    baseBranch: "main",
    baseSha,
    headBranch: "ticket/42",
    headSha,
    requiredChecks: {
      repository: "octo/widget",
      number: 7,
      nodeId: "PR_node_7",
      headSha,
      requiredCheckNames: ["test"],
      requiredChecks: [{ name: "test", state: "success" }],
      headDrift: false,
      aggregate: "green",
    },
    threads: [],
    mergeability: "mergeable",
    permittedMergeMethods: ["squash"],
  };
}

async function enterReview(
  connection: ReturnType<typeof openDatabase>,
  coordinator: WorkflowCoordinator,
) {
  await coordinator.createClaim(claimInput());
  let run = await readRun(connection.db, claimInput().id);
  run = await connection.db.transaction().execute((tx) =>
    createRunMutationRepository(tx).updateExecutionFacts({
      runId: run.id,
      expectedRevision: run.revision,
      facts: {
        worktreePath: "/tmp/wheelsparrow-delivery-stage",
        baseSha,
        branch: "ticket/42",
        headSha,
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
  await coordinator.createEffectIntent({
    runId: run.id,
    expectedRevision: run.revision,
    key: `run:${run.id}:publish`,
    kind: "publish",
    intent: { runId: run.id },
    dispatch: false,
  });
  await coordinator.beginEffect({ effectKey: `run:${run.id}:publish` });
  run = (
    await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: `run:${run.id}:publish`,
      outcome: "confirmed",
      trigger: "pr_observed",
      evidence: "The exact candidate was published.",
      publicationFacts: {
        pullRequestNumber: 7,
        pullRequestNodeId: "PR_node_7",
        pullRequestTitle: "feat: deliver the stage",
        pullRequestUrl: "https://github.com/octo/widget/pull/7",
        baseSha,
        headSha,
        branch: "ticket/42",
      },
      at,
    })
  ).run;
  await coordinator.createEffectIntent({
    runId: run.id,
    expectedRevision: run.revision,
    key: `run:${run.id}:ci`,
    kind: "observe_ci",
    intent: { runId: run.id },
    dispatch: false,
  });
  await coordinator.beginEffect({ effectKey: `run:${run.id}:ci` });
  return (
    await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: `run:${run.id}:ci`,
      outcome: "confirmed",
      trigger: "ci_passed",
      evidence: "Checks passed.",
      receipt: { headSha },
      at,
    })
  ).run;
}

function deliveryConfiguration() {
  return {
    workflow: "deploy-staging.yml",
    environment: "staging",
    smokeCommand: "make smoke-staging",
    smokeTimeoutMs: 10_000,
    projectId: "PVT_1",
    projectNumber: 2,
    expectedProjectRevision: "revision-1",
    reviewStatus: "Review",
    doneStatus: "Done",
  } as const;
}

function stagingRun(sha: string): StagingWorkflowRunReceipt {
  return {
    id: "workflow-run-1",
    workflow: "deploy-staging.yml",
    headSha: sha,
    status: "completed",
    conclusion: "success",
  };
}

function deployment(sha: string): StagingDeploymentReceipt {
  return {
    id: "deployment-1",
    environment: "staging",
    deployedSha: sha,
    state: "success",
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

describe("coordinator-owned delivery stages", () => {
  test("rereads and merges only the exact approved candidate, then schedules staging", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubDeliveryGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
      staging: { workflow: "deploy-staging.yml", environment: "staging" },
    });
    gateway.seedPullRequest(candidate());
    const coordinator = new WorkflowCoordinator({ connection });
    const review = await enterReview(connection, coordinator);
    const approval = await coordinator.approveMerge({
      runId: review.id,
      expectedRevision: review.revision,
      operator: "operator@example.test",
      approvedHeadSha: headSha,
      observedBaseSha: baseSha,
      dispatch: false,
      at,
    });

    console.log("AMB INPUT REV", approval.run.revision);
    const result = await executeMergeStage({
      coordinator,
      gateway,
      run: approval.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });

    expect(result.kind).toBe("merged");
    expect(gateway.mergeMutations()).toHaveLength(1);
    expect(result).toMatchObject({ run: { state: "waiting_for_staging" } });
    await coordinator.close();
  });

  test("changed candidate fails closed without merging", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubDeliveryGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
      staging: { workflow: "deploy-staging.yml", environment: "staging" },
    });
    gateway.seedPullRequest(candidate());
    gateway.setPullRequestHead(7, "d".repeat(40));
    const coordinator = new WorkflowCoordinator({ connection });
    const review = await enterReview(connection, coordinator);
    const approval = await coordinator.approveMerge({
      runId: review.id,
      expectedRevision: review.revision,
      operator: "operator@example.test",
      approvedHeadSha: headSha,
      observedBaseSha: baseSha,
      dispatch: false,
      at,
    });

    const result = await executeMergeStage({
      coordinator,
      gateway,
      run: approval.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });

    expect(result).toMatchObject({ kind: "human", run: { state: "review" } });
    expect(gateway.mergeMutations()).toHaveLength(0);
    await coordinator.close();
  });

  test("ambiguous merge is quarantined and restart does not merge again", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubDeliveryGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
      staging: { workflow: "deploy-staging.yml", environment: "staging" },
    });
    gateway.seedPullRequest(candidate());
    gateway.setMergeFailure("merge_ambiguous");
    const coordinator = new WorkflowCoordinator({ connection });
    const review = await enterReview(connection, coordinator);
    const approval = await coordinator.approveMerge({
      runId: review.id,
      expectedRevision: review.revision,
      operator: "operator@example.test",
      approvedHeadSha: headSha,
      observedBaseSha: baseSha,
      dispatch: false,
      at,
    });

    const result = await executeMergeStage({
      coordinator,
      gateway,
      run: approval.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });
    expect(result).toMatchObject({ kind: "human", run: { state: "merging" } });
    expect(gateway.mergeMutations()).toHaveLength(0);
    const replay = await executeMergeStage({
      coordinator,
      gateway,
      run: result.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });
    expect(replay.kind).toBe("human");
    expect(gateway.mergeMutations()).toHaveLength(0);
    await coordinator.close();
  });

  test("staging SHA mismatch returns Review and retry never calls merge", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubDeliveryGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
      staging: { workflow: "deploy-staging.yml", environment: "staging" },
    });
    gateway.seedPullRequest(candidate());
    const coordinator = new WorkflowCoordinator({ connection });
    const review = await enterReview(connection, coordinator);
    const approval = await coordinator.approveMerge({
      runId: review.id,
      expectedRevision: review.revision,
      operator: "operator@example.test",
      approvedHeadSha: headSha,
      observedBaseSha: baseSha,
      dispatch: false,
      at,
    });
    const merged = await executeMergeStage({
      coordinator,
      gateway,
      run: approval.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });
    if (merged.kind !== "merged") throw new Error("merge did not complete");
    gateway.setWorkflowRun(stagingRun(mergeSha));
    gateway.setDeployment(deployment("d".repeat(40)));

    const staging = await executeStagingStage({
      coordinator,
      gateway,
      run: merged.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });
    expect(staging).toMatchObject({ kind: "human", run: { state: "review" } });
    expect(gateway.mergeMutations()).toHaveLength(1);
    await coordinator.close();
  });

  test("smoke failure enters Review without projecting Done", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubDeliveryGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
      staging: { workflow: "deploy-staging.yml", environment: "staging" },
    });
    gateway.seedPullRequest(candidate());
    const coordinator = new WorkflowCoordinator({ connection });
    const review = await enterReview(connection, coordinator);
    const approval = await coordinator.approveMerge({
      runId: review.id,
      expectedRevision: review.revision,
      operator: "operator@example.test",
      approvedHeadSha: headSha,
      observedBaseSha: baseSha,
      dispatch: false,
      at,
    });
    const merged = await executeMergeStage({
      coordinator,
      gateway,
      run: approval.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });
    if (merged.kind !== "merged") throw new Error("merge did not complete");
    gateway.setWorkflowRun(stagingRun(mergeSha));
    gateway.setDeployment(deployment(mergeSha));
    const staged = await executeStagingStage({
      coordinator,
      gateway,
      run: merged.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });
    if (staged.kind !== "staged") throw new Error("staging did not complete");
    const runner: SmokeRunner = {
      run: vi.fn(async () => ({
        outcome: "failed" as const,
        exitCode: 1,
        durationMs: 12,
        output: "smoke failed",
      })),
    };
    const smoked = await executeSmokeStage({
      coordinator,
      run: staged.run,
      configuration: deliveryConfiguration(),
      smokeRunner: runner,
      now: () => at,
    });
    expect(smoked).toMatchObject({ kind: "human", run: { state: "review" } });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(gateway.doneMutations()).toHaveLength(0);
    await coordinator.close();
  });

  test("Done projection conflict is failed closed", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubDeliveryGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
      staging: { workflow: "deploy-staging.yml", environment: "staging" },
    });
    gateway.seedProjectItem({
      projectItemId: "PVTI_1",
      projectId: "PVT_1",
      projectNumber: 2,
      repository: "octo/widget",
      issueNodeId: "I_42",
      issueNumber: 42,
      isOpen: true,
      status: "Review",
      revision: "revision-1",
      labels: [],
      createdAt: at,
      dependencies: [],
    });
    gateway.seedPullRequest(candidate());
    const coordinator = new WorkflowCoordinator({ connection });
    const review = await enterReview(connection, coordinator);
    const approval = await coordinator.approveMerge({
      runId: review.id,
      expectedRevision: review.revision,
      operator: "operator@example.test",
      approvedHeadSha: headSha,
      observedBaseSha: baseSha,
      dispatch: false,
      at,
    });
    const merged = await executeMergeStage({
      coordinator,
      gateway,
      run: approval.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });
    if (merged.kind !== "merged") throw new Error("merge did not complete");
    gateway.setWorkflowRun(stagingRun(merged.merge.mergeSha));
    gateway.setDeployment(deployment(merged.merge.mergeSha));
    const staged = await executeStagingStage({
      coordinator,
      gateway,
      run: merged.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });
    if (staged.kind !== "staged") throw new Error("staging did not complete");
    const smoked = await executeSmokeStage({
      coordinator,
      run: staged.run,
      configuration: deliveryConfiguration(),
      smokeRunner: {
        run: async () => ({
          outcome: "passed" as const,
          exitCode: 0,
          durationMs: 2,
          output: "ok",
        }),
      },
      now: () => at,
    });
    if (smoked.kind !== "smoked") throw new Error("smoke did not complete");
    gateway.simulateProjectDrift("PVTI_1");
    const result = await executeProjectDoneStage({
      coordinator,
      gateway,
      run: smoked.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });
    expect(result).toMatchObject({ kind: "human", run: { state: "review" } });
    await coordinator.close();
  });
});
