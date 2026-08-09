import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import {
  createRunMutationRepository,
  type PublicationFactsPatch,
  readRun,
} from "../database/runs.js";
import { WorkflowCoordinator } from "./coordinator.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
const at = "2026-08-09T18:00:00.000Z";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

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
    id: "run-publication",
    repository: "owner/repository",
    projectItemId: "project-run-publication",
    issueNodeId: "issue-run-publication",
    issueNumber: 42,
    ownerToken: "owner-run-publication",
    at,
    summary: { text: "Claim the publication run." },
  };
}

async function enterPublishing(
  connection: ReturnType<typeof openDatabase>,
  coordinator: WorkflowCoordinator,
) {
  await coordinator.createClaim(claimInput());
  let run = await readRun(connection.db, "run-publication");
  run = await connection.db.transaction().execute((tx) =>
    createRunMutationRepository(tx).updateExecutionFacts({
      runId: run.id,
      expectedRevision: run.revision,
      facts: { branch: "wheelsparrow/42-publication" },
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
  return run;
}

async function beginPublishEffect(
  coordinator: WorkflowCoordinator,
  run: Awaited<ReturnType<typeof enterPublishing>>,
  effectKey: string,
) {
  await coordinator.createEffectIntent({
    runId: run.id,
    expectedRevision: run.revision,
    key: effectKey,
    kind: "publish",
    intent: { runId: run.id, branch: "wheelsparrow/42-publication" },
    dispatch: false,
  });
  return coordinator.beginEffect({
    effectKey,
    expectedRevision: run.revision,
  });
}

function validPublicationFacts() {
  return {
    pullRequestNumber: 123,
    pullRequestTitle: "feat: publish the run",
    pullRequestUrl: "https://github.com/owner/repository/pull/123",
    baseSha,
    headSha,
    branch: "wheelsparrow/42-publication",
  };
}

function publicationStep(run: Awaited<ReturnType<typeof enterPublishing>>) {
  return {
    id: "publication-step",
    runId: run.id,
    expectedRevision: run.revision,
    reworkEpoch: run.reworkEpoch,
    role: "publisher",
    logicalStep: "publish",
    attempt: 1,
    statusSequence: 1,
    status: "completed",
    promptHash: "c".repeat(64),
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    startedAt: at,
    completedAt: at,
    exitResultJson: JSON.stringify({ outcome: "completed" }),
    summary: { text: "Publication attempted." },
  } as const;
}

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("atomic publication facts settlement", () => {
  test("persists the exact PR receipt with the publish settlement", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterPublishing(connection, coordinator);
    const effectKey = "run:run-publication:publish";
    await beginPublishEffect(coordinator, run, effectKey);

    const settled = await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey,
      outcome: "confirmed",
      trigger: "pr_observed",
      evidence: "Published the linked pull request.",
      at,
      // This field is intentionally introduced by the implementation task.
      publicationFacts: validPublicationFacts(),
    });

    expect(settled.run).toMatchObject({
      state: "waiting_for_ci",
      revision: run.revision + 1,
      pullRequestNumber: 123,
      pullRequestTitle: "feat: publish the run",
      pullRequestUrl: "https://github.com/owner/repository/pull/123",
      baseSha,
      headSha,
      branch: "wheelsparrow/42-publication",
    });
    expect(settled.effect).toMatchObject({
      key: effectKey,
      status: "confirmed",
    });
    await coordinator.close();
  });

  test("rejects invalid publication facts and rolls back every prior write", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterPublishing(connection, coordinator);
    const effectKey = "run:run-publication:publish-invalid";
    await beginPublishEffect(coordinator, run, effectKey);
    const before = await readRun(connection.db, run.id);

    await expect(
      coordinator.settleExecution({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey,
        outcome: "confirmed",
        trigger: "pr_observed",
        evidence: "Invalid publication receipt.",
        at,
        publicationFacts: {
          pullRequestNumber: 0,
          pullRequestTitle: "feat: invalid",
          pullRequestUrl: "not-a-url",
          baseSha: "not-a-sha",
          headSha,
          branch: "wheelsparrow/42-publication",
        },
        step: publicationStep(run),
      }),
    ).rejects.toThrow(/publication|pull request|url|number|sha/i);

    expect(await readRun(connection.db, run.id)).toEqual(before);
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?")
        .get(run.id),
    ).toEqual({ count: 0 });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(effectKey),
    ).toEqual({ status: "in_flight" });
    await coordinator.close();
  });

  test.each([
    ["pull request number", { pullRequestNumber: 0 }],
    ["pull request URL", { pullRequestUrl: "not-a-url" }],
    ["base SHA", { baseSha: "not-a-sha" }],
    ["head SHA", { headSha: "not-a-sha" }],
  ] as const)("rejects an invalid %s", async (_label, invalid) => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterPublishing(connection, coordinator);
    const effectKey = `run:run-publication:publish-invalid-${_label}`;
    await beginPublishEffect(coordinator, run, effectKey);

    await expect(
      coordinator.settleExecution({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey,
        outcome: "confirmed",
        trigger: "pr_observed",
        evidence: "Invalid publication receipt.",
        at,
        publicationFacts: {
          ...validPublicationFacts(),
          ...invalid,
        },
      }),
    ).rejects.toThrow();
    expect(await readRun(connection.db, run.id)).toEqual(run);
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(effectKey),
    ).toEqual({ status: "in_flight" });
    await coordinator.close();
  });

  test.each([
    ["omitted", undefined],
    ["bad branch", "bad branch"],
    ["parent ref", "../x"],
    ["trailing slash", "trailing/"],
    ["mismatch", "wheelsparrow/43-other"],
  ] as const)(
    "rejects a %s publication branch and rolls back",
    async (_label, branch) => {
      const connection = await createDatabase();
      const coordinator = new WorkflowCoordinator({ connection });
      const run = await enterPublishing(connection, coordinator);
      const effectKey = `run:run-publication:publish-branch-${_label}`;
      await beginPublishEffect(coordinator, run, effectKey);
      const before = await readRun(connection.db, run.id);
      const publicationFacts = {
        ...validPublicationFacts(),
        branch,
      } as unknown as PublicationFactsPatch;

      await expect(
        coordinator.settleExecution({
          runId: run.id,
          expectedRevision: run.revision,
          effectKey,
          outcome: "confirmed",
          trigger: "pr_observed",
          evidence: "Invalid publication branch.",
          at,
          publicationFacts,
          step: publicationStep(run),
        }),
      ).rejects.toThrow(/branch|Git ref/i);

      expect(await readRun(connection.db, run.id)).toEqual(before);
      expect(
        connection.native
          .prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?")
          .get(run.id),
      ).toEqual({ count: 0 });
      expect(
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get(effectKey),
      ).toEqual({ status: "in_flight" });
      await coordinator.close();
    },
  );

  test("rejects a stale publish callback without writing its receipt", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterPublishing(connection, coordinator);
    const effectKey = "run:run-publication:publish-stale";
    await beginPublishEffect(coordinator, run, effectKey);
    await coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision,
      trigger: "handoff_required",
      at,
      summary: { text: "A newer command handed the run to Review." },
    });
    const before = await readRun(connection.db, run.id);

    await expect(
      coordinator.settleExecution({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey,
        outcome: "confirmed",
        trigger: "pr_observed",
        evidence: "Late publish callback.",
        at,
        publicationFacts: validPublicationFacts(),
      }),
    ).rejects.toThrow(/stale/i);
    expect(await readRun(connection.db, run.id)).toEqual(before);
    expect(
      connection.native
        .prepare(
          "SELECT pull_request_number, pull_request_url, status FROM runs JOIN side_effects ON side_effects.run_id = runs.id WHERE side_effects.key = ?",
        )
        .get(effectKey),
    ).toEqual({
      pull_request_number: null,
      pull_request_url: null,
      status: "in_flight",
    });
    await coordinator.close();
  });

  test("rejects publication facts for a non-publish effect", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput());
    let run = await readRun(connection.db, "run-publication");
    run = await coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision,
      trigger: "todo_observed",
      at,
      summary: {
        text: "Enter preparation before testing the effect boundary.",
      },
    });
    const effectKey = "run:run-publication:workspace-invalid-facts";
    await coordinator.createEffectIntent({
      runId: run.id,
      expectedRevision: run.revision,
      key: effectKey,
      kind: "workspace_prepare",
      intent: { runId: run.id },
      dispatch: false,
    });
    await coordinator.beginEffect({
      effectKey,
      expectedRevision: run.revision,
    });

    await expect(
      coordinator.settleExecution({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey,
        outcome: "confirmed",
        trigger: "workspace_prepared",
        evidence: "Facts are for the wrong effect.",
        publicationFacts: {
          pullRequestNumber: 123,
          pullRequestTitle: "feat: invalid effect",
          pullRequestUrl: "https://github.com/owner/repository/pull/123",
          baseSha,
          headSha,
          branch: "wheelsparrow/42-publication",
        },
      }),
    ).rejects.toThrow(/publish|publication/i);
    expect(await readRun(connection.db, run.id)).toEqual(run);
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(effectKey),
    ).toEqual({ status: "in_flight" });
    await coordinator.close();
  });

  test("rejects the generic execution facts patch on a publish effect", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const run = await enterPublishing(connection, coordinator);
    const effectKey = "run:run-publication:publish-generic-facts";
    await beginPublishEffect(coordinator, run, effectKey);

    await expect(
      coordinator.settleExecution({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey,
        outcome: "confirmed",
        trigger: "pr_observed",
        evidence: "Generic facts are not publication facts.",
        facts: { headSha },
        at,
      }),
    ).rejects.toThrow(/publication facts/i);
    expect(await readRun(connection.db, run.id)).toEqual(run);
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(effectKey),
    ).toEqual({ status: "in_flight" });
    await coordinator.close();
  });
});
