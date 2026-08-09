import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { FakeGitHubPublicationGateway } from "../../../../tests/fakes/github.js";
import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import { createRunMutationRepository, readRun } from "../database/runs.js";
import { WorkflowCoordinator } from "./coordinator.js";
import { observePublishedCi, publishApprovedRun } from "./publication.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
const at = "2026-08-09T18:00:00.000Z";
const baseSha = "a".repeat(40);
const committedHeadSha = "b".repeat(40);

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-publication-"));
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
    id: "run-publication-workflow",
    repository: "octo/widget",
    projectItemId: "project-publication-workflow",
    issueNodeId: "issue-publication-workflow",
    issueNumber: 42,
    ownerToken: "owner-publication-workflow",
    at,
    summary: { text: "Publish the workflow test run." },
  };
}

async function enterPublishing(
  connection: ReturnType<typeof openDatabase>,
  coordinator: WorkflowCoordinator,
) {
  await coordinator.createClaim(claimInput());
  let run = await readRun(connection.db, "run-publication-workflow");
  run = await connection.db.transaction().execute(async (tx) => {
    return createRunMutationRepository(tx).updateExecutionFacts({
      runId: run.id,
      expectedRevision: run.revision,
      facts: {
        branch: "wheelsparrow/42-publication",
        baseSha,
        headSha: "c".repeat(40),
        worktreePath: "/tmp/worktree-42-publication",
      },
      at,
    });
  });
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
  return run;
}

async function publish(
  connection: ReturnType<typeof openDatabase>,
  coordinator: WorkflowCoordinator,
  gateway: FakeGitHubPublicationGateway,
  headSha = committedHeadSha,
) {
  const run = await enterPublishing(connection, coordinator);
  return publishApprovedRun({
    coordinator,
    run,
    gateway,
    title: "feat: publish issue 42",
    body: "Closes #42",
    commitAndPush: async (currentRun) => ({
      branch: currentRun.branch,
      baseSha,
      headSha,
    }),
    now: () => at,
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

describe("approved publication workflow", () => {
  test("persists the publish intent before calling commit and settles the PR receipt", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterPublishing(connection, coordinator);
    const statuses: string[] = [];

    const result = await publishApprovedRun({
      coordinator,
      run,
      gateway,
      title: "feat: publish issue 42",
      body: "Closes #42",
      commitAndPush: async (currentRun) => {
        const row = connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get(
            `run:${currentRun.id}:rework:${currentRun.reworkEpoch}:round:${currentRun.repairRound}:publish`,
          ) as { status: string } | undefined;
        statuses.push(row?.status ?? "missing");
        return {
          branch: currentRun.branch,
          baseSha,
          headSha: committedHeadSha,
        };
      },
      now: () => at,
    });

    expect(statuses).toEqual(["in_flight"]);
    expect(result).toMatchObject({
      kind: "published",
      run: {
        state: "waiting_for_ci",
        pullRequestNumber: 1,
        pullRequestNodeId: "PR_node_1",
        pullRequestUrl: "https://github.com/octo/widget/pull/1",
        baseSha,
        headSha: committedHeadSha,
      },
    });
    expect(gateway.publicationMutations()).toHaveLength(1);
    gateway.setRequiredCheck(1, committedHeadSha, "test", "success");
    if (result.kind !== "published") throw new Error("publish failed");
    connection.native
      .prepare(
        "DELETE FROM side_effects WHERE run_id = ? AND kind = 'observe_ci'",
      )
      .run(result.run.id);
    const restartedRun = await readRun(connection.db, result.run.id);
    const restarted = await observePublishedCi({
      coordinator,
      run: restartedRun,
      gateway,
      now: () => at,
    });
    expect(restarted).toMatchObject({
      kind: "ci_passed",
      run: { state: "review" },
    });
    await coordinator.close();
  });

  test("replays the durable publication key without calling commit or creating another PR", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    let commits = 0;
    const run = await enterPublishing(connection, coordinator);
    const first = await publishApprovedRun({
      coordinator,
      run,
      gateway,
      title: "feat: publish issue 42",
      body: "Closes #42",
      commitAndPush: async (currentRun) => {
        commits += 1;
        return {
          branch: currentRun.branch,
          baseSha,
          headSha: committedHeadSha,
        };
      },
      now: () => at,
    });
    const replay = await publishApprovedRun({
      coordinator,
      run: first.run,
      gateway,
      title: "feat: publish issue 42",
      body: "Closes #42",
      commitAndPush: async () => {
        commits += 1;
        return {
          branch: "wheelsparrow/42-publication",
          baseSha,
          headSha: "d".repeat(40),
        };
      },
      now: () => at,
    });

    expect(first.kind).toBe("published");
    expect(replay.kind).toBe("stale");
    expect(commits).toBe(1);
    expect(gateway.publicationMutations()).toHaveLength(1);
    await coordinator.close();
  });

  test("preserves the create receipt when PR reread identity changes", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const gateway = {
      createPullRequest: (
        request: Parameters<typeof fake.createPullRequest>[0],
      ) => fake.createPullRequest(request),
      reconcilePullRequest: (
        request: Parameters<typeof fake.reconcilePullRequest>[0],
      ) => fake.reconcilePullRequest(request),
      readPullRequest: async (
        request: Parameters<typeof fake.readPullRequest>[0],
      ) => ({
        ...(await fake.readPullRequest(request)),
        nodeId: "PR_node_changed",
      }),
      observeRequiredChecks: (
        request: Parameters<typeof fake.observeRequiredChecks>[0],
      ) => fake.observeRequiredChecks(request),
    };
    const run = await enterPublishing(connection, coordinator);

    const result = await publishApprovedRun({
      coordinator,
      run,
      gateway,
      title: "feat: publish issue 42",
      body: "Closes #42",
      commitAndPush: async (currentRun) => ({
        branch: currentRun.branch,
        baseSha,
        headSha: committedHeadSha,
      }),
      now: () => at,
    });

    expect(result).toMatchObject({ kind: "human", run: { state: "review" } });
    const receiptRow = connection.native
      .prepare(
        "SELECT receipt_json FROM side_effects WHERE run_id = ? AND kind = 'publish'",
      )
      .get(run.id) as { receipt_json: string };
    expect(JSON.parse(receiptRow.receipt_json)).toMatchObject({
      pullRequestNumber: 1,
      pullRequestNodeId: "PR_node_1",
      pullRequestUrl: "https://github.com/octo/widget/pull/1",
    });
    expect(fake.publicationMutations()).toHaveLength(1);
    await coordinator.close();
  });

  test("does not call an edge for a cancelled publication intent", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterPublishing(connection, coordinator);
    const key = `run:${run.id}:rework:${run.reworkEpoch}:round:${run.repairRound}:publish`;
    await coordinator.createEffectIntent({
      runId: run.id,
      expectedRevision: run.revision,
      key,
      kind: "publish",
      intent: {
        runId: run.id,
        reworkEpoch: run.reworkEpoch,
        repository: run.repository,
        issueNumber: run.issueNumber,
        worktreePath: run.worktreePath,
        branch: run.branch,
        baseBranch: run.baseBranch,
        baseSha: run.baseSha,
        previousHeadSha: run.headSha,
        title: "feat: publish issue 42",
        body: "Closes #42",
      },
      dispatch: false,
      at,
    });
    await coordinator.cancelEffect({
      effectKey: key,
      expectedRevision: run.revision,
      reason: "Operator cancelled the uncertain publication intent.",
      at,
    });
    let commits = 0;
    const result = await publishApprovedRun({
      coordinator,
      run,
      gateway,
      title: "feat: publish issue 42",
      body: "Closes #42",
      commitAndPush: async (currentRun) => {
        commits += 1;
        return {
          branch: currentRun.branch,
          baseSha,
          headSha: committedHeadSha,
        };
      },
      now: () => at,
    });

    expect(result).toMatchObject({ kind: "human", run: { state: "review" } });
    expect(commits).toBe(0);
    expect(gateway.publicationMutations()).toHaveLength(0);
    await coordinator.close();
  });

  test("durably hands off when publication scheduling fails", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterPublishing(connection, coordinator);
    const failingCoordinator = {
      createEffectIntent: () => Promise.reject(new Error("SQLite unavailable")),
      beginEffect: coordinator.beginEffect.bind(coordinator),
      releaseEffectForRetry:
        coordinator.releaseEffectForRetry.bind(coordinator),
      settleExecution: coordinator.settleExecution.bind(coordinator),
      quarantineEffect: coordinator.quarantineEffect.bind(coordinator),
      transition: coordinator.transition.bind(coordinator),
    };

    const result = await publishApprovedRun({
      coordinator: failingCoordinator,
      run,
      gateway,
      title: "feat: publish issue 42",
      body: "Closes #42",
      commitAndPush: async () => {
        throw new Error("edge must not run");
      },
      now: () => at,
    });

    expect(result).toMatchObject({ kind: "human", run: { state: "review" } });
    expect(result).toMatchObject({ reason: /SQLite unavailable/ });
    await coordinator.close();
  });

  test("hands an ambiguous publication intent to Review without retrying it", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterPublishing(connection, coordinator);
    const key = `run:${run.id}:rework:${run.reworkEpoch}:round:${run.repairRound}:publish`;
    const intent = {
      runId: run.id,
      reworkEpoch: run.reworkEpoch,
      repository: run.repository,
      issueNumber: run.issueNumber,
      worktreePath: run.worktreePath,
      branch: run.branch,
      baseBranch: run.baseBranch,
      baseSha: run.baseSha,
      previousHeadSha: run.headSha,
      title: "feat: publish issue 42",
      body: "Closes #42",
    };
    await coordinator.createEffectIntent({
      runId: run.id,
      expectedRevision: run.revision,
      key,
      kind: "publish",
      intent,
      dispatch: false,
      at,
    });
    await coordinator.beginEffect({
      effectKey: key,
      expectedRevision: run.revision,
      at,
    });
    await coordinator.abandonEffect({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: key,
      outcome: "ambiguous",
      evidence: "The publisher stopped before the external receipt arrived.",
      at,
    });
    let commits = 0;
    const result = await publishApprovedRun({
      coordinator,
      run,
      gateway,
      title: "feat: publish issue 42",
      body: "Closes #42",
      commitAndPush: async (currentRun) => {
        commits += 1;
        return {
          branch: currentRun.branch,
          baseSha,
          headSha: committedHeadSha,
        };
      },
      now: () => at,
    });

    expect(result).toMatchObject({ kind: "human", run: { state: "review" } });
    expect(commits).toBe(0);
    expect(gateway.publicationMutations()).toHaveLength(0);
    await coordinator.close();
  });

  test("preserves PR evidence when publication settlement fails once", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    let settlements = 0;
    const flakyCoordinator = {
      createEffectIntent: coordinator.createEffectIntent.bind(coordinator),
      beginEffect: coordinator.beginEffect.bind(coordinator),
      releaseEffectForRetry:
        coordinator.releaseEffectForRetry.bind(coordinator),
      settleExecution: async (
        command: Parameters<typeof coordinator.settleExecution>[0],
      ) => {
        settlements += 1;
        if (settlements === 1)
          throw new Error("SQLite commit failed after the PR was reread");
        return coordinator.settleExecution(command);
      },
      quarantineEffect: coordinator.quarantineEffect.bind(coordinator),
      transition: coordinator.transition.bind(coordinator),
    };
    const run = await enterPublishing(connection, coordinator);
    const result = await publishApprovedRun({
      coordinator: flakyCoordinator,
      run,
      gateway,
      title: "feat: publish issue 42",
      body: "Closes #42",
      commitAndPush: async (currentRun) => ({
        branch: currentRun.branch,
        baseSha,
        headSha: committedHeadSha,
      }),
      now: () => at,
    });

    expect(result).toMatchObject({ kind: "human", run: { state: "review" } });
    const receiptRow = connection.native
      .prepare(
        "SELECT receipt_json FROM side_effects WHERE run_id = ? AND kind = 'publish'",
      )
      .get(run.id) as { receipt_json: string };
    expect(JSON.parse(receiptRow.receipt_json)).toMatchObject({
      pullRequestNumber: 1,
      pullRequestNodeId: "PR_node_1",
      pullRequestUrl: "https://github.com/octo/widget/pull/1",
    });
    expect(settlements).toBe(2);
    await coordinator.close();
  });

  test("releases pending observation for a later green poll", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const published = await publish(connection, coordinator, gateway);
    if (published.kind !== "published") throw new Error("publish failed");
    let checkReads = 0;
    const observingGateway = {
      createPullRequest: (
        request: Parameters<typeof gateway.createPullRequest>[0],
      ) => gateway.createPullRequest(request),
      reconcilePullRequest: (
        request: Parameters<typeof gateway.reconcilePullRequest>[0],
      ) => gateway.reconcilePullRequest(request),
      readPullRequest: (
        request: Parameters<typeof gateway.readPullRequest>[0],
      ) => gateway.readPullRequest(request),
      observeRequiredChecks: async (
        request: Parameters<typeof gateway.observeRequiredChecks>[0],
      ) => {
        checkReads += 1;
        return gateway.observeRequiredChecks(request);
      },
    };

    const first = await observePublishedCi({
      coordinator,
      run: published.run,
      gateway: observingGateway,
      pullRequest: published.pullRequest,
      now: () => at,
    });
    gateway.setRequiredCheck(1, committedHeadSha, "test", "success");
    const second = await observePublishedCi({
      coordinator,
      run: published.run,
      gateway: observingGateway,
      pullRequest: published.pullRequest,
      now: () => at,
    });

    expect(first.kind).toBe("ci_pending");
    expect(second).toMatchObject({
      kind: "ci_passed",
      run: { state: "review" },
    });
    expect(checkReads).toBe(2);
    expect(
      connection.native
        .prepare(
          "SELECT status FROM side_effects WHERE run_id = ? AND kind = 'observe_ci'",
        )
        .get(published.run.id),
    ).toEqual({ status: "confirmed" });
    await coordinator.close();
  });

  test("does not duplicate an in-flight check read", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const published = await publish(connection, coordinator, gateway);
    if (published.kind !== "published") throw new Error("publish failed");
    let checkReads = 0;
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observingGateway = {
      createPullRequest: (
        request: Parameters<typeof gateway.createPullRequest>[0],
      ) => gateway.createPullRequest(request),
      reconcilePullRequest: (
        request: Parameters<typeof gateway.reconcilePullRequest>[0],
      ) => gateway.reconcilePullRequest(request),
      readPullRequest: (
        request: Parameters<typeof gateway.readPullRequest>[0],
      ) => gateway.readPullRequest(request),
      observeRequiredChecks: async (
        request: Parameters<typeof gateway.observeRequiredChecks>[0],
      ) => {
        checkReads += 1;
        entered();
        await blocked;
        return gateway.observeRequiredChecks(request);
      },
    };

    const firstPromise = observePublishedCi({
      coordinator,
      run: published.run,
      gateway: observingGateway,
      now: () => at,
    });
    await enteredPromise;
    const concurrent = await observePublishedCi({
      coordinator,
      run: published.run,
      gateway: observingGateway,
      now: () => at,
    });
    expect(concurrent).toMatchObject({ kind: "ci_pending" });
    expect(checkReads).toBe(1);
    release();
    expect(await firstPromise).toMatchObject({ kind: "ci_pending" });
    await coordinator.close();
  });

  test("hands an exact-head green check set to human Review", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test", "lint"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const published = await publish(connection, coordinator, gateway);
    if (published.kind !== "published") throw new Error("publish failed");
    gateway.setRequiredCheck(1, committedHeadSha, "test", "success");
    gateway.setRequiredCheck(1, committedHeadSha, "lint", "success");

    const observed = await observePublishedCi({
      coordinator,
      run: published.run,
      gateway,
      pullRequest: published.pullRequest,
      now: () => at,
    });

    expect(observed).toMatchObject({
      kind: "ci_passed",
      run: { state: "review" },
    });
    await coordinator.close();
  });

  test("fails closed when checks are reported for another PR node", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const published = await publish(connection, coordinator, fake);
    if (published.kind !== "published") throw new Error("publish failed");
    const gateway = {
      createPullRequest: (
        request: Parameters<typeof fake.createPullRequest>[0],
      ) => fake.createPullRequest(request),
      reconcilePullRequest: (
        request: Parameters<typeof fake.reconcilePullRequest>[0],
      ) => fake.reconcilePullRequest(request),
      readPullRequest: (request: Parameters<typeof fake.readPullRequest>[0]) =>
        fake.readPullRequest(request),
      observeRequiredChecks: async (
        request: Parameters<typeof fake.observeRequiredChecks>[0],
      ) => ({
        ...(await fake.observeRequiredChecks(request)),
        nodeId: "PR_node_other",
      }),
    };
    const observed = await observePublishedCi({
      coordinator,
      run: published.run,
      gateway,
      now: () => at,
    });

    expect(observed).toMatchObject({ kind: "human", run: { state: "review" } });
    await coordinator.close();
  });

  test("durably hands off a conflicting ephemeral PR node ID", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const published = await publish(connection, coordinator, gateway);
    if (published.kind !== "published") throw new Error("publish failed");

    const observed = await observePublishedCi({
      coordinator,
      run: published.run,
      gateway,
      pullRequestNodeId: "PR_node_other",
      now: () => at,
    });

    expect(observed).toMatchObject({
      kind: "human",
      run: { state: "review" },
      reason: /conflicts with the durable PR identity/,
    });
    await coordinator.close();
  });

  test("durably hands off when CI observation scheduling fails", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const published = await publish(connection, coordinator, gateway);
    if (published.kind !== "published") throw new Error("publish failed");
    let checkReads = 0;
    const failingCoordinator = {
      createEffectIntent: () => Promise.reject(new Error("SQLite unavailable")),
      beginEffect: coordinator.beginEffect.bind(coordinator),
      releaseEffectForRetry:
        coordinator.releaseEffectForRetry.bind(coordinator),
      settleExecution: coordinator.settleExecution.bind(coordinator),
      quarantineEffect: coordinator.quarantineEffect.bind(coordinator),
      transition: coordinator.transition.bind(coordinator),
    };
    const observingGateway = {
      createPullRequest: gateway.createPullRequest.bind(gateway),
      reconcilePullRequest: gateway.reconcilePullRequest.bind(gateway),
      readPullRequest: gateway.readPullRequest.bind(gateway),
      observeRequiredChecks: async (
        request: Parameters<typeof gateway.observeRequiredChecks>[0],
      ) => {
        checkReads += 1;
        return gateway.observeRequiredChecks(request);
      },
    };

    const result = await observePublishedCi({
      coordinator: failingCoordinator,
      run: published.run,
      gateway: observingGateway,
      now: () => at,
    });

    expect(result).toMatchObject({ kind: "human", run: { state: "review" } });
    expect(result).toMatchObject({ reason: /SQLite unavailable/ });
    expect(checkReads).toBe(0);
    await coordinator.close();
  });

  test("fails closed to Review when the PR head drifts", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const published = await publish(connection, coordinator, gateway);
    if (published.kind !== "published") throw new Error("publish failed");
    gateway.setPullRequestHead(1, "d".repeat(40));

    const observed = await observePublishedCi({
      coordinator,
      run: published.run,
      gateway,
      pullRequest: published.pullRequest,
      now: () => at,
    });

    expect(observed).toMatchObject({ kind: "human", run: { state: "review" } });
    await coordinator.close();
  });

  test("routes failed required checks into the bounded repair loop", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const published = await publish(connection, coordinator, gateway);
    if (published.kind !== "published") throw new Error("publish failed");
    gateway.setRequiredCheck(1, committedHeadSha, "test", "failure");

    const observed = await observePublishedCi({
      coordinator,
      run: published.run,
      gateway,
      pullRequest: published.pullRequest,
      now: () => at,
    });

    expect(observed).toMatchObject({
      kind: "ci_failed_repairable",
      run: { state: "repairing", repairRound: 1 },
    });
    await coordinator.close();
  });

  test("reuses the linked PR across a repair round and observes the new head", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const first = await publish(connection, coordinator, gateway);
    if (first.kind !== "published") throw new Error("initial publish failed");
    gateway.setRequiredCheck(1, committedHeadSha, "test", "failure");
    const failed = await observePublishedCi({
      coordinator,
      run: first.run,
      gateway,
      now: () => at,
    });
    if (failed.kind !== "ci_failed_repairable")
      throw new Error("repair was not scheduled");

    const repairedHead = "e".repeat(40);
    gateway.advancePullRequestHead(1, repairedHead);
    let repairing = failed.run;
    repairing = await coordinator.transition({
      runId: repairing.id,
      expectedRevision: repairing.revision,
      trigger: "repair_succeeded",
      at,
      summary: { text: "The bounded repair produced a new head." },
    });
    repairing = await coordinator.transition({
      runId: repairing.id,
      expectedRevision: repairing.revision,
      trigger: "verification_passed",
      at,
      summary: { text: "The repaired head passed verification." },
    });
    repairing = await coordinator.transition({
      runId: repairing.id,
      expectedRevision: repairing.revision,
      trigger: "review_approved",
      at,
      summary: { text: "The repaired head was approved for publication." },
    });

    const second = await publishApprovedRun({
      coordinator,
      run: repairing,
      gateway,
      title: "feat: publish issue 42",
      body: "Closes #42",
      commitAndPush: async (currentRun) => ({
        branch: currentRun.branch,
        baseSha,
        headSha: repairedHead,
      }),
      now: () => at,
    });
    expect(second).toMatchObject({
      kind: "published",
      pullRequest: { number: 1, nodeId: "PR_node_1", headSha: repairedHead },
    });
    if (second.kind !== "published") throw new Error("repair publish failed");
    gateway.setRequiredCheck(1, repairedHead, "test", "success");
    const green = await observePublishedCi({
      coordinator,
      run: second.run,
      gateway,
      now: () => at,
    });

    expect(green).toMatchObject({
      kind: "ci_passed",
      run: { state: "review" },
    });
    expect(gateway.publicationMutations()).toHaveLength(1);
    expect(
      connection.native
        .prepare(
          "SELECT key, status FROM side_effects WHERE run_id = ? ORDER BY key",
        )
        .all(first.run.id),
    ).toEqual([
      {
        key: `run:${first.run.id}:rework:${first.run.reworkEpoch}:round:0:observe-ci`,
        status: "failed",
      },
      {
        key: `run:${first.run.id}:rework:${first.run.reworkEpoch}:round:0:publish`,
        status: "confirmed",
      },
      {
        key: `run:${first.run.id}:rework:${first.run.reworkEpoch}:round:1:observe-ci`,
        status: "confirmed",
      },
      {
        key: `run:${first.run.id}:rework:${first.run.reworkEpoch}:round:1:publish`,
        status: "confirmed",
      },
    ]);
    await coordinator.close();
  });

  test("hands another failed check set to Review after two repair rounds", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const published = await publish(connection, coordinator, gateway);
    if (published.kind !== "published") throw new Error("publish failed");
    connection.native
      .prepare("UPDATE runs SET repair_round = 2 WHERE id = ?")
      .run(published.run.id);
    gateway.setRequiredCheck(1, committedHeadSha, "test", "failure");

    const observed = await observePublishedCi({
      coordinator,
      run: { ...published.run, repairRound: 2 },
      gateway,
      pullRequest: published.pullRequest,
      now: () => at,
    });

    expect(observed).toMatchObject({
      kind: "ci_failed_exhausted",
      run: { state: "review", repairRound: 2 },
    });
    await coordinator.close();
  });

  test("fails closed on a malformed gateway check receipt", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const published = await publish(connection, coordinator, fake);
    if (published.kind !== "published") throw new Error("publish failed");
    const gateway = {
      ...fake,
      reconcilePullRequest: fake.reconcilePullRequest.bind(fake),
      observeRequiredChecks: async () => ({ aggregate: "green" }),
    } as unknown as FakeGitHubPublicationGateway;

    const observed = await observePublishedCi({
      coordinator,
      run: published.run,
      gateway,
      pullRequest: published.pullRequest,
      now: () => at,
    });

    expect(observed).toMatchObject({ kind: "human", run: { state: "review" } });
    await coordinator.close();
  });

  test("hands off when the next CI effect cannot be durably scheduled", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterPublishing(connection, coordinator);
    const failingCoordinator = {
      createEffectIntent: (
        command: Parameters<typeof coordinator.createEffectIntent>[0],
      ) =>
        command.kind === "observe_ci"
          ? Promise.reject(new Error("SQLite unavailable while scheduling CI"))
          : coordinator.createEffectIntent(command),
      beginEffect: coordinator.beginEffect.bind(coordinator),
      releaseEffectForRetry:
        coordinator.releaseEffectForRetry.bind(coordinator),
      settleExecution: coordinator.settleExecution.bind(coordinator),
      quarantineEffect: coordinator.quarantineEffect.bind(coordinator),
      transition: coordinator.transition.bind(coordinator),
    };

    const result = await publishApprovedRun({
      coordinator: failingCoordinator,
      run,
      gateway,
      title: "feat: publish issue 42",
      body: "Closes #42",
      commitAndPush: async (currentRun) => ({
        branch: currentRun.branch,
        baseSha,
        headSha: committedHeadSha,
      }),
      now: () => at,
    });

    expect(result).toMatchObject({ kind: "human", run: { state: "review" } });
    expect(result).toMatchObject({ reason: /schedule.*CI/i });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(
          `run:${run.id}:rework:${run.reworkEpoch}:round:${run.repairRound}:publish`,
        ),
    ).toEqual({ status: "confirmed" });
    expect(
      connection.native
        .prepare(
          "SELECT COUNT(*) AS count FROM side_effects WHERE run_id = ? AND kind = 'observe_ci'",
        )
        .get(run.id),
    ).toEqual({ count: 0 });
    await coordinator.close();
  });
});
