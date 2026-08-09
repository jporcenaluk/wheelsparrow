import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import { FakeGitHubDeliveryGateway } from "../../../../tests/fakes/github.js";
import { openDatabase } from "../database/connection.js";
import type { EffectRecord } from "../database/effects.js";
import { listUnresolvedForReconciliation } from "../database/effects.js";
import { migrateDatabase } from "../database/migrate.js";
import { createRunMutationRepository, readRun } from "../database/runs.js";
import type {
  MergeCandidateReceipt,
  StagingDeploymentReceipt,
  StagingWorkflowRunReceipt,
} from "../github/delivery.js";
import { WorkflowCoordinator } from "./coordinator.js";
import {
  createDeliveryCapability,
  createSafeSmokeRunner,
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

async function dispatchCapability(
  capability: ReturnType<typeof createDeliveryCapability>,
  effect: EffectRecord,
): Promise<unknown> {
  const dispatcher = capability.dispatcher;
  if (typeof dispatcher === "function")
    return dispatcher(effect, () => undefined);
  return dispatcher.dispatch(effect, () => undefined);
}

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

async function reachSmoked() {
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
  const unresolved = await listUnresolvedForReconciliation(connection.db);
  const doneEffect = unresolved.find(
    ({ effect }) => effect.key === smoked.doneEffectKey,
  );
  if (doneEffect === undefined) throw new Error("Done effect is missing");
  return { connection, gateway, coordinator, smoked, doneEffect };
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

  test("ambiguous merge reaches Review and restart does not merge again", async () => {
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
    expect(result).toMatchObject({ kind: "human", run: { state: "review" } });
    expect(gateway.mergeMutations()).toHaveLength(0);
    const replay = await executeMergeStage({
      coordinator,
      gateway,
      run: result.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });
    expect(replay.kind).toBe("stale");
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

  test("startup merge dispatch derives the non-default issue from the durable run", async () => {
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
    const effect = await coordinator.createEffectIntent({
      runId: approval.run.id,
      expectedRevision: approval.run.revision,
      key: `run:${approval.run.id}:startup-merge`,
      kind: "merge",
      intent: {
        repository: approval.run.repository,
        pullRequestNumber: approval.run.pullRequestNumber,
        pullRequestNodeId: approval.run.pullRequestNodeId,
        pullRequestUrl: approval.run.pullRequestUrl,
        branch: approval.run.branch,
        baseSha,
        headSha,
      },
      dispatch: false,
      at,
    });
    const capability = createDeliveryCapability(
      gateway,
      deliveryConfiguration(),
      {
        run: async () => ({
          outcome: "passed" as const,
          exitCode: 0,
          durationMs: 1,
        }),
      },
      { resolveRun: () => approval.run },
    );
    const dispatched = await dispatchCapability(capability, effect.effect);
    expect(dispatched).toMatchObject({
      outcome: "confirmed",
      trigger: "merge_observed",
    });
    expect(gateway.mergeMutations()).toHaveLength(1);
    await coordinator.close();
  });

  test("requires a durable run resolver for restart delivery capabilities", () => {
    const gateway = new FakeGitHubDeliveryGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
      staging: { workflow: "deploy-staging.yml", environment: "staging" },
    });
    expect(() =>
      createDeliveryCapability(
        gateway,
        deliveryConfiguration(),
        { run: async () => ({ outcome: "passed" as const }) },
        undefined as never,
      ),
    ).toThrow(/durable run resolver/i);
  });

  test("staging startup dispatch uses durable intent despite configuration drift", async () => {
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
    gateway.setWorkflowRun(stagingRun(merged.merge.mergeSha));
    gateway.setDeployment(deployment(merged.merge.mergeSha));
    const effect = await coordinator.createEffectIntent({
      runId: merged.run.id,
      expectedRevision: merged.run.revision,
      key: `run:${merged.run.id}:config-drift-staging`,
      kind: "observe_staging",
      intent: {
        runId: merged.run.id,
        reworkEpoch: merged.run.reworkEpoch,
        repository: merged.run.repository,
        workflow: "deploy-staging.yml",
        environment: "staging",
        mergeSha: merged.merge.mergeSha,
      },
      dispatch: false,
      at,
    });
    const capability = createDeliveryCapability(
      gateway,
      {
        ...deliveryConfiguration(),
        workflow: "other-workflow.yml",
        environment: "other",
      },
      {
        run: async () => ({
          outcome: "passed" as const,
          exitCode: 0,
          durationMs: 1,
        }),
      },
    );
    const dispatched = await dispatchCapability(capability, effect.effect);
    expect(dispatched).toMatchObject({
      outcome: "confirmed",
      trigger: "staging_succeeded",
    });
    await coordinator.close();
  });

  test("safe smoke runner is shell-free and bounded", async () => {
    const runner = createSafeSmokeRunner({ cwd: process.cwd(), env: {} });
    const result = await runner.run({
      command: `${process.execPath} --version`,
      timeoutMs: 2_000,
      runId: "smoke-run",
      mergeSha,
    });
    expect(result.outcome).toBe("passed");
    expect(Buffer.byteLength(result.output ?? "", "utf8")).toBeLessThanOrEqual(
      16 * 1024,
    );
    expect(() =>
      runner.run({
        command: `${process.execPath} -e 'process.exit(1)'`,
        timeoutMs: 2_000,
        runId: "smoke-run",
        mergeSha,
      }),
    ).toThrow("shell syntax");
  });

  test("smoke dispatch binds the durable command and merge SHA and rejects malformed receipts", async () => {
    const effect = {
      key: "run:smoke-dispatch:smoke",
      runId: "smoke-dispatch",
      reworkEpoch: 0,
      kind: "smoke",
      targetRevision: 3,
      fingerprint: "fingerprint",
      intent: JSON.stringify({
        runId: "smoke-dispatch",
        reworkEpoch: 0,
        repository: "octo/widget",
        mergeSha,
        command: "make smoke-durable",
      }),
      status: "in_flight",
      executorAttempt: 1,
      executorOwnerToken: "owner",
      receipt: null,
      processId: null,
      requestId: null,
      prNumber: null,
      prNodeId: null,
      workflowRunId: null,
      startedAt: at,
      completedAt: null,
      failure: null,
      reconciliationEvidence: null,
      createdAt: at,
      updatedAt: at,
    } as EffectRecord;
    const runner: SmokeRunner = {
      run: vi.fn(async (request) => ({
        outcome: "passed" as const,
        exitCode: 0,
        durationMs: 7,
        output: request.command,
      })),
    };
    const capability = createDeliveryCapability(
      new FakeGitHubDeliveryGateway({
        repository: "octo/widget",
        requiredChecks: ["test"],
        staging: { workflow: "deploy-staging.yml", environment: "staging" },
      }),
      deliveryConfiguration(),
      runner,
    );
    const dispatched = await dispatchCapability(capability, effect);
    expect(dispatched).toMatchObject({
      outcome: "confirmed",
      receipt: { command: "make smoke-durable", mergeSha },
    });
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ command: "make smoke-durable", mergeSha }),
    );

    const malformed = createDeliveryCapability(
      new FakeGitHubDeliveryGateway({
        repository: "octo/widget",
        requiredChecks: ["test"],
        staging: { workflow: "deploy-staging.yml", environment: "staging" },
      }),
      deliveryConfiguration(),
      {
        run: async () =>
          ({ outcome: "passed", exitCode: "not-a-number" }) as unknown as {
            outcome: "passed";
            exitCode: number;
          },
      },
    );
    await expect(dispatchCapability(malformed, effect)).resolves.toMatchObject({
      outcome: "ambiguous",
    });
  });

  test("quarantines staging when durable settlement fails before Review handoff", async () => {
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
    gateway.setWorkflowRun(stagingRun(merged.merge.mergeSha));
    gateway.setDeployment(deployment(merged.merge.mergeSha));
    vi.spyOn(coordinator, "settleExecution").mockRejectedValue(
      new Error("durable settlement unavailable"),
    );

    const result = await executeStagingStage({
      coordinator,
      gateway,
      run: merged.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });

    expect(result).toMatchObject({ kind: "human", run: { state: "review" } });
    const effect = await connection.db
      .selectFrom("side_effects")
      .select(["status", "reconciliation_evidence"])
      .where("key", "=", merged.stagingEffectKey)
      .executeTakeFirstOrThrow();
    expect(effect.status).toBe("ambiguous");
    expect(effect.reconciliation_evidence).toMatch(/quarantined/i);
    await coordinator.close();
  });

  test("direct Done confirmation satisfies strict coordinator receipt binding", async () => {
    const fixture = await reachSmoked();
    const result = await executeProjectDoneStage({
      coordinator: fixture.coordinator,
      gateway: fixture.gateway,
      run: fixture.smoked.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });

    expect(result).toMatchObject({ kind: "done", run: { state: "done" } });
    expect(JSON.parse(fixture.doneEffect.effect.intent)).toMatchObject({
      runId: fixture.smoked.run.id,
      reworkEpoch: fixture.smoked.run.reworkEpoch,
    });
    const effect = await fixture.connection.db
      .selectFrom("side_effects")
      .select(["status", "receipt_json"])
      .where("key", "=", fixture.smoked.doneEffectKey)
      .executeTakeFirstOrThrow();
    expect(effect.status).toBe("confirmed");
    expect(JSON.parse(effect.receipt_json ?? "null")).toMatchObject({
      outcome: "moved",
      mergeSha,
    });
    await fixture.coordinator.close();
  });

  test("dispatcher Done confirmation satisfies strict coordinator receipt binding", async () => {
    const fixture = await reachSmoked();
    await fixture.coordinator.close();
    const capability = createDeliveryCapability(
      fixture.gateway,
      deliveryConfiguration(),
      {
        run: async () => ({
          outcome: "passed" as const,
          exitCode: 0,
          durationMs: 1,
        }),
      },
      { resolveRun: () => fixture.smoked.run },
    );
    const restarted = new WorkflowCoordinator({
      connection: fixture.connection,
      dispatcher: capability.dispatcher,
    });
    const settlement = restarted.waitForEffectSettlement(
      fixture.doneEffect.effect.key,
      1_000,
    );
    await restarted.beginEffect({
      effectKey: fixture.doneEffect.effect.key,
      expectedRevision: fixture.smoked.run.revision,
      at,
    });
    const effect = await settlement;
    expect(effect.status).toBe("confirmed");
    expect(JSON.parse(effect.receipt ?? "null")).toMatchObject({
      outcome: "moved",
      mergeSha,
    });
    expect(
      await readRun(fixture.connection.db, fixture.smoked.run.id),
    ).toMatchObject({
      state: "done",
    });
    await restarted.close();
  });

  test("restart reconciliation Done confirmation satisfies strict coordinator receipt binding", async () => {
    const fixture = await reachSmoked();
    await fixture.coordinator.beginEffect({
      effectKey: fixture.doneEffect.effect.key,
      expectedRevision: fixture.smoked.run.revision,
      at,
    });
    await fixture.coordinator.close();
    const capability = createDeliveryCapability(
      fixture.gateway,
      deliveryConfiguration(),
      {
        run: async () => ({
          outcome: "passed" as const,
          exitCode: 0,
          durationMs: 1,
        }),
      },
      { resolveRun: () => fixture.smoked.run },
    );
    const restarted = new WorkflowCoordinator({
      connection: fixture.connection,
      observer: capability.observer,
    });
    const current = await readRun(fixture.connection.db, fixture.smoked.run.id);
    const settlement = restarted.waitForEffectSettlement(
      fixture.doneEffect.effect.key,
      1_000,
    );
    await restarted.observeAmbiguousEffect({
      effectKey: fixture.doneEffect.effect.key,
      expectedRevision: current.revision,
    });
    const effect = await settlement;
    expect(effect.status).toBe("confirmed");
    expect(JSON.parse(effect.receipt ?? "null")).toMatchObject({
      outcome: "already_applied",
      mergeSha,
    });
    expect(
      await readRun(fixture.connection.db, fixture.smoked.run.id),
    ).toMatchObject({
      state: "done",
    });
    await restarted.close();
  });

  test("Done projection rejects a missing durable merge SHA", async () => {
    const fixture = await reachSmoked();
    const result = await executeProjectDoneStage({
      coordinator: fixture.coordinator,
      gateway: fixture.gateway,
      run: { ...fixture.smoked.run, mergeSha: null },
      configuration: deliveryConfiguration(),
      now: () => at,
    });

    expect(result.kind).toBe("human");
    expect(fixture.gateway.doneMutations()).toHaveLength(0);
    await fixture.coordinator.close();
  });

  test("redacts token-shaped provider errors before persisting delivery evidence", async () => {
    const fixture = await reachSmoked();
    vi.spyOn(fixture.gateway, "moveProjectItemToDone").mockRejectedValue(
      new Error("provider rejected request: Bearer ghp_deliverySecret123"),
    );

    const result = await executeProjectDoneStage({
      coordinator: fixture.coordinator,
      gateway: fixture.gateway,
      run: fixture.smoked.run,
      configuration: deliveryConfiguration(),
      now: () => at,
    });

    expect(result).toMatchObject({ kind: "human", run: { state: "review" } });
    const effect = await fixture.connection.db
      .selectFrom("side_effects")
      .select(["failure", "reconciliation_evidence"])
      .where("key", "=", fixture.doneEffect.effect.key)
      .executeTakeFirstOrThrow();
    expect(effect.failure).not.toContain("ghp_deliverySecret123");
    expect(effect.reconciliation_evidence).not.toContain(
      "ghp_deliverySecret123",
    );
    expect(effect.failure).toContain("[REDACTED]");
    await fixture.coordinator.close();
  });
});
