import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import { readRun } from "../database/runs.js";
import { WorkflowCoordinator } from "./coordinator.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
const firstAt = "2026-08-10T09:00:00.000Z";

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(
    join(tmpdir(), "wheelsparrow-coordinator-redaction-"),
  );
  directories.push(directory);
  const migrationsDirectory = join(directory, "migrations");
  await cp(migrationSource, migrationsDirectory, { recursive: true });
  const connection = openDatabase(join(directory, "wheelsparrow.sqlite3"));
  migrateDatabase(connection, migrationsDirectory);
  connections.push(connection);
  return connection;
}

async function createRun(coordinator: WorkflowCoordinator): Promise<void> {
  await coordinator.createClaim({
    id: "run-redaction",
    repository: "owner/repository",
    projectItemId: "project-redaction",
    issueNodeId: "issue-redaction",
    issueNumber: 7,
    ownerToken: "owner-redaction",
    at: firstAt,
    summary: { text: "Create a redaction test run." },
  });
}

async function createEffect(
  coordinator: WorkflowCoordinator,
  key: string,
): Promise<void> {
  await coordinator.createEffectIntent({
    runId: "run-redaction",
    dispatch: false,
    key,
    kind: "project_todo",
    intent: { projectItemId: "project-redaction", from: "Ready", to: "Todo" },
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

describe("coordinator durable redaction", () => {
  test("redacts evidence on direct quarantine, rejection, and ambiguity writes", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await createRun(coordinator);

    const abandonKey = "run:run-redaction:abandon";
    await createEffect(coordinator, abandonKey);
    await coordinator.beginEffect(abandonKey);
    await coordinator.abandonEffect({
      runId: "run-redaction",
      expectedRevision: 1,
      effectKey: abandonKey,
      outcome: "ambiguous",
      trigger: null,
      evidence: "ghp_abandonCredentialSentinel",
      at: "2026-08-10T09:01:00.000Z",
    });

    const quarantineKey = "run:run-redaction:quarantine";
    await createEffect(coordinator, quarantineKey);
    await coordinator.beginEffect(quarantineKey);
    await coordinator.quarantineEffect({
      runId: "run-redaction",
      expectedRevision: 1,
      effectKey: quarantineKey,
      outcome: "ambiguous",
      trigger: null,
      evidence: "Authorization: Basic quarantineBasicCredentialSentinel",
      at: "2026-08-10T09:01:00.000Z",
    });

    const rejectionKey = "run:run-redaction:rejection";
    await createEffect(coordinator, rejectionKey);
    await coordinator.beginEffect(rejectionKey);
    const settledRejection = coordinator.waitForEffectSettlement(rejectionKey);
    await coordinator.rejectClaim({
      runId: "run-redaction",
      expectedRevision: 2,
      effectKey: rejectionKey,
      reason: "Bearer rejectionBearerCredentialSentinel",
      at: "2026-08-10T09:02:00.000Z",
    });
    expect((await settledRejection).failure).not.toContain(
      "rejectionBearerCredentialSentinel",
    );

    const ambiguityKey = "run:run-redaction:ambiguity";
    await createEffect(coordinator, ambiguityKey);
    await coordinator.beginEffect(ambiguityKey);
    const markEffectAmbiguous = (
      coordinator as unknown as {
        markEffectAmbiguous(effectKey: string, evidence: string): Promise<void>;
      }
    ).markEffectAmbiguous.bind(coordinator);
    await markEffectAmbiguous(
      ambiguityKey,
      "token: ambiguityTokenCredentialSentinel",
    );

    const rows = connection.native
      .prepare(
        `SELECT kind, summary, details_json FROM events WHERE run_id = ? ORDER BY sequence`,
      )
      .all("run-redaction") as Array<{
      kind: string;
      summary: string;
      details_json: string | null;
    }>;
    const effects = connection.native
      .prepare(
        `SELECT key, failure, reconciliation_evidence FROM side_effects WHERE run_id = ? ORDER BY key`,
      )
      .all("run-redaction") as Array<{
      key: string;
      failure: string | null;
      reconciliation_evidence: string | null;
    }>;
    const persisted = JSON.stringify({ rows, effects });

    for (const credential of [
      "abandonCredentialSentinel",
      "quarantineBasicCredentialSentinel",
      "rejectionBearerCredentialSentinel",
      "ambiguityTokenCredentialSentinel",
    ])
      expect(persisted).not.toContain(credential);
    expect(persisted).toContain("[REDACTED]");
    expect(
      rows.filter((row) => row.kind === "effect_quarantined"),
    ).toHaveLength(2);
    expect(await readRun(connection.db, "run-redaction")).toMatchObject({
      state: "claim_failed",
    });

    await coordinator.close();
  });
});
