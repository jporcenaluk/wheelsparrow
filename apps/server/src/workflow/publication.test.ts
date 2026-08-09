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
            `run:${currentRun.id}:rework:${currentRun.reworkEpoch}:publish`,
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
        pullRequestUrl: "https://github.com/octo/widget/pull/1",
        baseSha,
        headSha: committedHeadSha,
      },
    });
    expect(gateway.publicationMutations()).toHaveLength(1);
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

  test("keeps pending checks in the same waiting state without duplicating the effect", async () => {
    const connection = await createDatabase();
    const gateway = new FakeGitHubPublicationGateway({
      repository: "octo/widget",
      requiredChecks: ["test"],
    });
    const coordinator = new WorkflowCoordinator({ connection });
    const published = await publish(connection, coordinator, gateway);
    if (published.kind !== "published") throw new Error("publish failed");

    const first = await observePublishedCi({
      coordinator,
      run: published.run,
      gateway,
      pullRequest: published.pullRequest,
      now: () => at,
    });
    const second = await observePublishedCi({
      coordinator,
      run: published.run,
      gateway,
      pullRequest: published.pullRequest,
      now: () => at,
    });

    expect(first.kind).toBe("ci_pending");
    expect(second.kind).toBe("ci_pending");
    expect(first.run).toMatchObject({
      state: "waiting_for_ci",
      revision: published.run.revision,
    });
    expect(
      connection.native
        .prepare(
          "SELECT COUNT(*) AS count FROM side_effects WHERE run_id = ? AND kind = 'observe_ci'",
        )
        .get(published.run.id),
    ).toEqual({ count: 1 });
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
});
