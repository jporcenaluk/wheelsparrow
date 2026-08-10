import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { type DatabaseConnection, openDatabase } from "./connection.js";
import { createEffectMutationRepository } from "./effects.js";
import { migrateDatabase } from "./migrate.js";
import { createRunMutationRepository, type readRun } from "./runs.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: DatabaseConnection[] = [];

async function createDatabase(): Promise<DatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-redaction-"));
  directories.push(directory);
  const migrationsDirectory = join(directory, "migrations");
  await cp(migrationSource, migrationsDirectory, { recursive: true });
  const connection = openDatabase(join(directory, "wheelsparrow.sqlite3"));
  migrateDatabase(connection, migrationsDirectory);
  connections.push(connection);
  return connection;
}

async function createRun(
  connection: DatabaseConnection,
  summary: string,
): Promise<Awaited<ReturnType<typeof readRun>>> {
  return connection.db.transaction().execute((tx) =>
    createRunMutationRepository(tx).createClaim({
      id: "run-redaction",
      repository: "owner/repository",
      projectItemId: "project-redaction",
      issueNodeId: "issue-redaction",
      issueNumber: 7,
      ownerToken: "owner-redaction",
      at: "2026-08-10T09:00:00.000Z",
      summary: { text: summary },
    }),
  );
}

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("durable credential redaction", () => {
  test("redacts untrusted run text before SQLite writes", async () => {
    const connection = await createDatabase();
    const githubSecret = "ghp_runCredentialSentinel";
    const githubSession = "ghs_runCredentialSentinel";
    const bearer = "runBearerCredentialSentinel";
    const labeledSecret = "runLabeledCredentialSentinel";
    const apiKey = "runApiCredentialSentinel";
    const namespacedToken = "runNamespacedCredentialSentinel";
    const urlPassword = "runUrlCredentialSentinel";
    const basicCredential = "basic-redaction-fixture";
    const summary = `token: ${labeledSecret}; GH_TOKEN=${namespacedToken}; Authorization: Basic ${basicCredential}; ${githubSecret}`;
    const run = await createRun(connection, summary);

    const intakeJson = JSON.stringify({
      title: `Bearer ${bearer}`,
      body: `${githubSession} https://operator:${urlPassword}@example.test/path`,
      secret: labeledSecret,
      api_key: apiKey,
      safeHash: "a".repeat(64),
    });

    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).updateExecutionFacts({
        runId: run.id,
        expectedRevision: run.revision,
        facts: {
          branch: "wheelsparrow/7-redaction",
          intakeJson,
        },
        at: "2026-08-10T09:01:00.000Z",
      }),
    );
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).appendStep({
        id: "step-redaction",
        runId: run.id,
        expectedRevision: run.revision,
        reworkEpoch: run.reworkEpoch,
        role: "builder",
        logicalStep: "build",
        attempt: 1,
        statusSequence: 1,
        status: "failed",
        promptHash: "b".repeat(64),
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        startedAt: "2026-08-10T09:02:00.000Z",
        completedAt: "2026-08-10T09:03:00.000Z",
        exitResultJson: JSON.stringify({
          output: `${githubSecret} Bearer ${bearer}`,
          token: labeledSecret,
        }),
        summary: { text: `api_key=${apiKey}` },
      }),
    );
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).appendFinding({
        id: "finding-redaction",
        runId: run.id,
        expectedRevision: run.revision,
        reworkEpoch: run.reworkEpoch,
        reviewStepId: "step-redaction",
        stableKey: "credential-output",
        dispositionSequence: 1,
        severity: "high",
        evidence: `secret=${labeledSecret}; ${githubSecret}`,
        disposition: "open",
        at: "2026-08-10T09:04:00.000Z",
      }),
    );
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).updatePublicationFacts({
        runId: run.id,
        expectedRevision: run.revision,
        facts: {
          pullRequestNumber: 12,
          pullRequestNodeId: "pr-redaction",
          pullRequestTitle: `Authorization: ${bearer}`,
          pullRequestUrl: "https://github.com/owner/repository/pull/12",
          baseSha: "c".repeat(40),
          headSha: "d".repeat(40),
          branch: "wheelsparrow/7-redaction",
        },
        at: "2026-08-10T09:05:00.000Z",
      }),
    );
    await connection.db.transaction().execute((tx) =>
      createRunMutationRepository(tx).transitionRun({
        runId: run.id,
        expectedRevision: run.revision,
        trigger: "handoff_required",
        at: "2026-08-10T09:06:00.000Z",
        summary: { text: `Bearer ${bearer}` },
        requiredAction: `password: ${urlPassword}`,
      }),
    );

    const rows = {
      runs: connection.native
        .prepare(
          `SELECT intake_json, pull_request_title, required_action
             FROM runs WHERE id = ?`,
        )
        .get(run.id) as Record<string, string | null>,
      events: connection.native
        .prepare("SELECT summary FROM events WHERE run_id = ?")
        .all(run.id) as Array<{ summary: string }>,
      steps: connection.native
        .prepare("SELECT exit_result_json, summary FROM steps WHERE run_id = ?")
        .all(run.id) as Array<{ exit_result_json: string; summary: string }>,
      findings: connection.native
        .prepare("SELECT evidence FROM findings WHERE run_id = ?")
        .all(run.id) as Array<{ evidence: string }>,
    };
    const persisted = JSON.stringify(rows);

    for (const credential of [
      githubSecret,
      githubSession,
      bearer,
      labeledSecret,
      apiKey,
      namespacedToken,
      urlPassword,
      basicCredential,
    ])
      expect(persisted).not.toContain(credential);
    expect(persisted).toContain("[REDACTED]");
    expect(rows.runs.intake_json).not.toBeNull();
    expect(JSON.parse(rows.runs.intake_json as string)).toMatchObject({
      safeHash: "a".repeat(64),
      secret: "[REDACTED]",
      api_key: "[REDACTED]",
    });
  });

  test("redacts effect intent, receipt, failure, and evidence columns", async () => {
    const connection = await createDatabase();
    const githubSecret = "ghp_effectCredentialSentinel";
    const githubSession = "ghs_effectCredentialSentinel";
    const bearer = "effectBearerCredentialSentinel";
    const labeledSecret = "effectLabeledCredentialSentinel";
    const apiKey = "effectApiCredentialSentinel";
    const namespacedToken = "effectNamespacedCredentialSentinel";
    const urlPassword = "effectUrlCredentialSentinel";
    const run = await createRun(connection, "Create an effect.");
    const now = "2026-08-10T09:10:00.000Z";
    const effectPrefix = "run:run-redaction:project-review";

    const createEffect = (key: string) =>
      connection.db.transaction().execute((tx) =>
        createEffectMutationRepository(tx).insertEffectIntent(
          run,
          {
            key,
            kind: "project_review",
            targetRevision: run.revision,
            intent: {
              prompt: `${githubSecret} ${githubSession}`,
              authorization: bearer,
              credentials: {
                secret: labeledSecret,
                apiKey,
                GH_TOKEN: namespacedToken,
              },
              endpoint: `https://operator:${urlPassword}@example.test/path`,
              safeHash: "e".repeat(64),
            },
          },
          now,
        ),
      );

    const failedEffect = await createEffect(`${effectPrefix}:failed`);
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).markEffectInFlight(
          failedEffect.key,
          "executor-failed",
          now,
        ),
      );
    await connection.db.transaction().execute((tx) =>
      createEffectMutationRepository(tx).recordEffectObservation(
        {
          runId: run.id,
          expectedRevision: run.revision,
          effectKey: failedEffect.key,
          outcome: "failed",
          receipt: {
            output: `${githubSecret} Bearer ${bearer}`,
            token: labeledSecret,
          },
          evidence: `api_key=${apiKey}; https://user:${urlPassword}@example.test`,
          trigger: null,
        },
        now,
      ),
    );

    const retryEffect = await createEffect(`${effectPrefix}:retry`);
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).markEffectInFlight(
          retryEffect.key,
          "executor-retry",
          now,
        ),
      );
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).releaseInFlightForRetry(
          retryEffect.key,
          run.id,
          run.revision,
          "executor-retry",
          `Bearer ${bearer}`,
          now,
        ),
      );

    const canceledEffect = await createEffect(`${effectPrefix}:canceled`);
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).cancelPendingEffect(
          canceledEffect.key,
          `secret=${labeledSecret}`,
          now,
        ),
      );

    const ambiguousEffect = await createEffect(`${effectPrefix}:ambiguous`);
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).markEffectInFlight(
          ambiguousEffect.key,
          "executor-ambiguous",
          now,
        ),
      );
    await connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).markOwnedInFlightAmbiguous(
          "executor-ambiguous",
          `https://user:${urlPassword}@example.test`,
          now,
        ),
      );

    const rows = connection.native
      .prepare(
        `SELECT intent_json, receipt_json, failure, reconciliation_evidence
           FROM side_effects ORDER BY key`,
      )
      .all() as Array<Record<string, string | null>>;
    const persisted = JSON.stringify(rows);

    for (const credential of [
      githubSecret,
      githubSession,
      bearer,
      labeledSecret,
      apiKey,
      namespacedToken,
      urlPassword,
    ])
      expect(persisted).not.toContain(credential);
    expect(persisted).toContain("[REDACTED]");
    const intent = JSON.parse(rows[0]?.intent_json ?? "null") as {
      safeHash: string;
      credentials: { secret: string; apiKey: string };
    };
    expect(intent.safeHash).toBe("e".repeat(64));
    expect(intent.credentials).toEqual({
      secret: "[REDACTED]",
      apiKey: "[REDACTED]",
      GH_TOKEN: "[REDACTED]",
    });
  });
});
