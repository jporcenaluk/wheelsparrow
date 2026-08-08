import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../../apps/server/src/database/connection.js";
import { migrateDatabase } from "../../apps/server/src/database/migrate.js";

const repositoryInitialMigration = fileURLToPath(
  new URL("../../migrations/001_initial.sql", import.meta.url),
);
const maximumJsonBytes = 1024 * 1024;
const temporaryDirectories: string[] = [];
const connections = new Set<ReturnType<typeof openDatabase>>();

async function createTemporaryDatabase(): Promise<{
  databasePath: string;
  migrationsDirectory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-migrations-"));
  temporaryDirectories.push(directory);
  const migrationsDirectory = join(directory, "migrations");

  await mkdir(migrationsDirectory);
  await cp(
    repositoryInitialMigration,
    join(migrationsDirectory, "001_initial.sql"),
    {
      recursive: false,
    },
  );

  return {
    databasePath: join(directory, "wheelsparrow.sqlite3"),
    migrationsDirectory,
  };
}

function open(path: string): ReturnType<typeof openDatabase> {
  const connection = openDatabase(path);
  connections.add(connection);
  return connection;
}

async function close(
  connection: ReturnType<typeof openDatabase>,
): Promise<void> {
  await connection.close();
  connections.delete(connection);
}

async function addMigration(
  directory: string,
  filename: string,
  sql: string,
): Promise<void> {
  await writeFile(join(directory, filename), sql, "utf8");
}

async function readMigration(
  directory: string,
  filename: string,
): Promise<string> {
  return readFile(join(directory, filename), "utf8");
}

async function replaceMigration(
  directory: string,
  filename: string,
  sql: string,
): Promise<void> {
  await writeFile(join(directory, filename), sql, "utf8");
}

function tableColumns(
  connection: ReturnType<typeof openDatabase>,
  table: string,
): Set<string> {
  return new Set(
    (
      connection.native.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
}

function tableInfo(
  connection: ReturnType<typeof openDatabase>,
  table: string,
): Array<{ name: string; type: string; notnull: number; pk: number }> {
  return connection.native
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
}

function tableExists(
  connection: ReturnType<typeof openDatabase>,
  table: string,
): boolean {
  return (
    connection.native
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function indexColumnSets(
  connection: ReturnType<typeof openDatabase>,
  table: string,
  unique: 0 | 1,
): string[][] {
  const indexes = connection.native
    .prepare(`PRAGMA index_list(${table})`)
    .all() as Array<{ name: string; unique: 0 | 1 }>;

  return indexes
    .filter((index) => index.unique === unique)
    .map((index) =>
      (
        connection.native
          .prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`)
          .all() as Array<{ name: string; seqno: number }>
      )
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => column.name),
    );
}

function foreignKeyColumnSets(
  connection: ReturnType<typeof openDatabase>,
  table: string,
): string[] {
  const rows = connection.native
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all() as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
  }>;
  const groups = Map.groupBy(rows, (row) => row.id);

  return [...groups.values()]
    .map((group) => {
      const ordered = group.toSorted((left, right) => left.seq - right.seq);
      return `${ordered.map((row) => row.from).join(",")}->${ordered[0]?.table}->${ordered.map((row) => row.to).join(",")}`;
    })
    .sort();
}

function foreignKeyActions(
  connection: ReturnType<typeof openDatabase>,
  table: string,
): Array<{ onUpdate: string; onDelete: string }> {
  return (
    connection.native
      .prepare(`PRAGMA foreign_key_list(${table})`)
      .all() as Array<{ on_update: string; on_delete: string }>
  ).map((row) => ({
    onUpdate: row.on_update,
    onDelete: row.on_delete,
  }));
}

function schemaSql(
  connection: ReturnType<typeof openDatabase>,
  table: string,
): string {
  const row = connection.native
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  if (row === undefined) throw new Error(`missing table ${table}`);
  return row.sql;
}

function insertRun(
  connection: ReturnType<typeof openDatabase>,
  overrides: Record<string, unknown> = {},
): void {
  const values = {
    id: "run-1",
    repository: "owner/repository",
    project_item_id: "project-item-1",
    issue_node_id: "issue-node-1",
    issue_number: 1,
    intake_json: JSON.stringify({ title: "Issue" }),
    state: "claimed",
    revision: 0,
    rework_epoch: 0,
    repair_round: 0,
    worktree_path: "/tmp/worktree",
    base_branch: "main",
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
  connection.native
    .prepare(
      `INSERT INTO runs (
        id, repository, project_item_id, issue_node_id, issue_number,
        intake_json, state, revision, rework_epoch, repair_round,
        worktree_path, base_branch, created_at, updated_at
      ) VALUES (
        @id, @repository, @project_item_id, @issue_node_id, @issue_number,
        @intake_json, @state, @revision, @rework_epoch, @repair_round,
        @worktree_path, @base_branch, @created_at, @updated_at
      )`,
    )
    .run(values);
}

function insertStep(
  connection: ReturnType<typeof openDatabase>,
  overrides: Record<string, unknown> = {},
): void {
  const values = {
    id: "step-1",
    run_id: "run-1",
    rework_epoch: 0,
    role: "reviewer",
    logical_step: "review",
    attempt: 1,
    status_sequence: 1,
    status: "started",
    prompt_hash: "a".repeat(64),
    model: "gpt-5.6-terra",
    reasoning_effort: "medium",
    started_at: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
  connection.native
    .prepare(
      `INSERT INTO steps (
        id, run_id, rework_epoch, role, logical_step, attempt,
        status_sequence, status, prompt_hash, model, reasoning_effort, started_at
      ) VALUES (
        @id, @run_id, @rework_epoch, @role, @logical_step, @attempt,
        @status_sequence, @status, @prompt_hash, @model, @reasoning_effort, @started_at
      )`,
    )
    .run(values);
}

function expectExactColumns(columns: Set<string>, names: string[]): void {
  expect([...columns].sort()).toEqual([...names].sort());
}

function expectAffinities(
  connection: ReturnType<typeof openDatabase>,
  table: string,
  integerColumns: string[],
): void {
  const integers = new Set(integerColumns);
  const actual = Object.fromEntries(
    tableInfo(connection, table).map((column) => [
      column.name,
      column.type.toUpperCase(),
    ]),
  );
  const expected = Object.fromEntries(
    [...tableColumns(connection, table)].map((column) => [
      column,
      integers.has(column) ? "INTEGER" : "TEXT",
    ]),
  );
  expect(actual).toEqual(expected);
}

afterEach(async () => {
  let closeError: unknown;
  for (const connection of connections) {
    try {
      await connection.close();
    } catch (error) {
      closeError ??= error;
    }
  }
  connections.clear();

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );

  if (closeError !== undefined) throw closeError;
});

describe("immutable SQLite migrations", () => {
  test("migrates a fresh real database to exactly the ledger and six operational tables", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);

    migrateDatabase(connection, migrationsDirectory);

    const tables = (
      connection.native
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(tables).toEqual([
      "approvals",
      "events",
      "findings",
      "runs",
      "schema_migrations",
      "side_effects",
      "steps",
    ]);

    expectExactColumns(tableColumns(connection, "schema_migrations"), [
      "id",
      "name",
      "checksum",
      "applied_at",
    ]);
    expectExactColumns(tableColumns(connection, "runs"), [
      "id",
      "repository",
      "project_item_id",
      "issue_node_id",
      "issue_number",
      "intake_json",
      "state",
      "revision",
      "rework_epoch",
      "repair_round",
      "owner_token",
      "ownership_released_at",
      "stop_requested_at",
      "base_sha",
      "head_sha",
      "approved_head_sha",
      "observed_base_sha",
      "merge_sha",
      "worktree_path",
      "base_branch",
      "branch",
      "pull_request_number",
      "pull_request_title",
      "pull_request_url",
      "required_action",
      "last_failure_json",
      "created_at",
      "updated_at",
      "started_at",
      "handed_off_at",
      "terminal_at",
    ]);
    expectExactColumns(tableColumns(connection, "steps"), [
      "id",
      "run_id",
      "rework_epoch",
      "role",
      "logical_step",
      "attempt",
      "status_sequence",
      "status",
      "prompt_hash",
      "model",
      "reasoning_effort",
      "started_at",
      "completed_at",
      "exit_result_json",
      "summary",
      "raw_log_reference",
    ]);
    expectExactColumns(tableColumns(connection, "events"), [
      "id",
      "run_id",
      "sequence",
      "run_revision",
      "kind",
      "summary",
      "details_json",
      "log_reference",
      "created_at",
    ]);
    expectExactColumns(tableColumns(connection, "findings"), [
      "id",
      "run_id",
      "rework_epoch",
      "review_step_id",
      "stable_key",
      "disposition_sequence",
      "severity",
      "evidence",
      "disposition",
      "resolving_step_id",
      "created_at",
    ]);
    expectExactColumns(tableColumns(connection, "approvals"), [
      "id",
      "run_id",
      "operator",
      "approved_head_sha",
      "observed_base_sha",
      "decision",
      "invalidation_reason",
      "created_at",
    ]);
    expectExactColumns(tableColumns(connection, "side_effects"), [
      "key",
      "run_id",
      "rework_epoch",
      "kind",
      "target_revision",
      "fingerprint",
      "intent_json",
      "receipt_json",
      "status",
      "executor_attempt",
      "executor_owner_token",
      "process_id",
      "request_id",
      "pr_number",
      "pr_node_id",
      "workflow_run_id",
      "started_at",
      "completed_at",
      "failure",
      "reconciliation_evidence",
      "created_at",
      "updated_at",
    ]);
  });

  test("installs stable primary, foreign, unique, index, check, and not-null integrity", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);
    migrateDatabase(connection, migrationsDirectory);

    const primaryKeys = Object.fromEntries(
      [
        "schema_migrations",
        "runs",
        "steps",
        "events",
        "findings",
        "approvals",
        "side_effects",
      ].map((table) => [
        table,
        tableInfo(connection, table)
          .filter((column) => column.pk > 0)
          .sort((left, right) => left.pk - right.pk)
          .map((column) => column.name),
      ]),
    );
    expect(primaryKeys).toEqual({
      schema_migrations: ["id"],
      runs: ["id"],
      steps: ["id"],
      events: ["id"],
      findings: ["id"],
      approvals: ["id"],
      side_effects: ["key"],
    });

    const foreignKeys = Object.fromEntries(
      ["steps", "events", "findings", "approvals", "side_effects"].map(
        (table) => [table, foreignKeyColumnSets(connection, table)],
      ),
    );
    expect(foreignKeys).toEqual({
      steps: ["run_id->runs->id"],
      events: ["run_id->runs->id"],
      findings: [
        "resolving_step_id,run_id->steps->id,run_id",
        "review_step_id,run_id->steps->id,run_id",
        "run_id->runs->id",
      ],
      approvals: ["run_id->runs->id"],
      side_effects: ["run_id->runs->id"],
    });

    expect(indexColumnSets(connection, "events", 1)).toContainEqual([
      "run_id",
      "sequence",
    ]);
    expect(indexColumnSets(connection, "runs", 0)).toContainEqual([
      "project_item_id",
    ]);
    expect(indexColumnSets(connection, "runs", 0)).toContainEqual([
      "issue_node_id",
    ]);
    expect(indexColumnSets(connection, "steps", 1)).toContainEqual([
      "id",
      "run_id",
    ]);
    expect(indexColumnSets(connection, "steps", 1)).toContainEqual([
      "run_id",
      "rework_epoch",
      "logical_step",
      "attempt",
      "status_sequence",
    ]);
    expect(indexColumnSets(connection, "findings", 1)).toContainEqual([
      "run_id",
      "rework_epoch",
      "stable_key",
      "disposition_sequence",
    ]);
    for (const table of ["approvals", "side_effects"])
      expect(
        indexColumnSets(connection, table, 0).some(
          (columns) => columns[0] === "run_id",
        ),
      ).toBe(true);

    for (const table of [
      "steps",
      "events",
      "findings",
      "approvals",
      "side_effects",
    ]) {
      for (const action of foreignKeyActions(connection, table)) {
        expect(["NO ACTION", "RESTRICT"]).toContain(action.onUpdate);
        expect(["NO ACTION", "RESTRICT"]).toContain(action.onDelete);
        expect(action.onUpdate).not.toBe("CASCADE");
        expect(action.onDelete).not.toBe("CASCADE");
      }
    }

    const requiredColumns: Record<string, string[]> = {
      schema_migrations: ["name", "checksum", "applied_at"],
      runs: [
        "repository",
        "project_item_id",
        "issue_node_id",
        "issue_number",
        "state",
        "revision",
        "rework_epoch",
        "repair_round",
        "created_at",
        "updated_at",
      ],
      steps: [
        "run_id",
        "rework_epoch",
        "role",
        "logical_step",
        "attempt",
        "status_sequence",
        "status",
        "prompt_hash",
        "model",
        "reasoning_effort",
        "started_at",
      ],
      events: [
        "run_id",
        "sequence",
        "run_revision",
        "kind",
        "summary",
        "created_at",
      ],
      findings: [
        "run_id",
        "rework_epoch",
        "review_step_id",
        "stable_key",
        "disposition_sequence",
        "severity",
        "evidence",
        "disposition",
        "created_at",
      ],
      approvals: [
        "run_id",
        "operator",
        "approved_head_sha",
        "observed_base_sha",
        "decision",
        "created_at",
      ],
      side_effects: [
        "run_id",
        "rework_epoch",
        "kind",
        "target_revision",
        "fingerprint",
        "intent_json",
        "status",
        "executor_attempt",
        "created_at",
        "updated_at",
      ],
    };
    for (const [table, columns] of Object.entries(requiredColumns)) {
      const notNullColumns = tableInfo(connection, table)
        .filter((column) => column.notnull === 1)
        .map((column) => column.name);
      for (const column of columns) expect(notNullColumns).toContain(column);
    }
    expect(
      tableInfo(connection, "runs").find(
        (column) => column.name === "intake_json",
      )?.notnull,
    ).toBe(0);

    for (const [table, primaryKey] of [
      ["runs", "id"],
      ["steps", "id"],
      ["events", "id"],
      ["findings", "id"],
      ["approvals", "id"],
      ["side_effects", "key"],
    ] as const) {
      expect(
        tableInfo(connection, table).find(
          (column) => column.name === primaryKey,
        )?.notnull,
      ).toBe(1);
    }

    expectAffinities(connection, "schema_migrations", ["id"]);
    expectAffinities(connection, "runs", [
      "issue_number",
      "revision",
      "rework_epoch",
      "repair_round",
      "pull_request_number",
    ]);
    expectAffinities(connection, "steps", [
      "rework_epoch",
      "attempt",
      "status_sequence",
    ]);
    expectAffinities(connection, "events", ["sequence", "run_revision"]);
    expectAffinities(connection, "findings", [
      "rework_epoch",
      "disposition_sequence",
    ]);
    expectAffinities(connection, "approvals", []);
    expectAffinities(connection, "side_effects", [
      "rework_epoch",
      "target_revision",
      "executor_attempt",
      "process_id",
      "pr_number",
      "workflow_run_id",
    ]);

    const migrationSchema = schemaSql(connection, "schema_migrations");
    expect(indexColumnSets(connection, "schema_migrations", 1)).toContainEqual([
      "name",
    ]);
    expect(migrationSchema).toMatch(/CHECK\s*\(\s*id\s*>\s*0\s*\)/i);
    expect(migrationSchema).toMatch(/length\s*\(\s*checksum\s*\)\s*=\s*64/i);
    expect(migrationSchema).toMatch(
      /checksum[^,]*(?:GLOB|NOT\s+GLOB)[^,]*0-9a-f/i,
    );

    const runsSchema = schemaSql(connection, "runs");
    const stepsSchema = schemaSql(connection, "steps");
    const eventsSchema = schemaSql(connection, "events");
    const findingsSchema = schemaSql(connection, "findings");
    const sideEffectsSchema = schemaSql(connection, "side_effects");

    const jsonBounds: Record<string, string[]> = {
      runs: ["intake_json", "last_failure_json"],
      steps: ["exit_result_json"],
      events: ["details_json"],
      side_effects: ["intent_json", "receipt_json"],
    };
    for (const [table, columns] of Object.entries(jsonBounds)) {
      const tableSchema = schemaSql(connection, table);
      for (const column of columns)
        expect(tableSchema).toMatch(
          new RegExp(
            `length\\s*\\(\\s*cast\\s*\\(\\s*${column}\\s+as\\s+blob\\s*\\)\\s*\\)\\s*<=\\s*${maximumJsonBytes}`,
            "i",
          ),
        );
    }

    const operationalSchema = [
      runsSchema,
      stepsSchema,
      eventsSchema,
      findingsSchema,
      schemaSql(connection, "approvals"),
      sideEffectsSchema,
    ].join("\n");
    expect(operationalSchema).not.toMatch(
      /(?:state|status|decision|disposition|severity)\s+IN\s*\(/i,
    );
  });

  test("indexes durable identities without enforcing active ownership uniqueness", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);
    migrateDatabase(connection, migrationsDirectory);
    insertRun(connection);

    insertRun(connection, {
      id: "run-duplicate-project-item",
      issue_node_id: "issue-node-2",
      issue_number: 2,
    });
    insertRun(connection, {
      id: "run-duplicate-issue",
      project_item_id: "project-item-2",
      issue_number: 2,
    });
    expect(
      connection.native.prepare("SELECT count(*) AS count FROM runs").get(),
    ).toEqual({ count: 3 });
    expect(() =>
      insertRun(connection, {
        id: "run-invalid-number",
        project_item_id: "project-item-3",
        issue_node_id: "issue-node-3",
        issue_number: 0,
      }),
    ).toThrow(/check/i);
  });

  test("persists a claimed run before intake, worktree, or pull request presentation exists", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);
    migrateDatabase(connection, migrationsDirectory);

    insertRun(connection, {
      intake_json: null,
      worktree_path: null,
    });

    expect(
      connection.native
        .prepare(
          `SELECT
            state, intake_json, worktree_path, pull_request_number,
            pull_request_title, pull_request_url
           FROM runs WHERE id = ?`,
        )
        .get("run-1"),
    ).toEqual({
      state: "claimed",
      intake_json: null,
      worktree_path: null,
      pull_request_number: null,
      pull_request_title: null,
      pull_request_url: null,
    });
  });

  test.each([
    ["runs", "id"],
    ["steps", "id"],
    ["events", "id"],
    ["findings", "id"],
    ["approvals", "id"],
    ["side_effects", "key"],
  ])("rejects a NULL %s.%s text primary key", async (table, primaryKey) => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);
    migrateDatabase(connection, migrationsDirectory);

    expect(() =>
      connection.native
        .prepare(`INSERT INTO ${table} (${primaryKey}) VALUES (NULL)`)
        .run(),
    ).toThrow(new RegExp(`NOT NULL.*${table}\\.${primaryKey}`, "i"));
  });

  test("behaviorally rejects every invalid stable counter and sequence", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);
    migrateDatabase(connection, migrationsDirectory);
    insertRun(connection);
    insertStep(connection);

    for (const [id, overrides] of [
      ["bad-issue-number", { issue_number: 0 }],
      ["bad-revision", { revision: -1 }],
      ["bad-run-rework", { rework_epoch: -1 }],
      ["bad-repair-round", { repair_round: -1 }],
    ] as const) {
      expect(() =>
        insertRun(connection, {
          id,
          project_item_id: `project-${id}`,
          issue_node_id: `issue-${id}`,
          issue_number: 2,
          ...overrides,
        }),
      ).toThrow(/check/i);
    }

    for (const [id, overrides] of [
      ["bad-step-rework", { rework_epoch: -1 }],
      ["bad-attempt", { attempt: 0 }],
      ["bad-status-sequence", { status_sequence: 0 }],
    ] as const) {
      expect(() => insertStep(connection, { id, ...overrides })).toThrow(
        /check/i,
      );
    }

    const insertEvent = connection.native.prepare(
      `INSERT INTO events (
        id, run_id, sequence, run_revision, kind, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      insertEvent.run(
        "bad-event-sequence",
        "run-1",
        0,
        0,
        "test",
        "test",
        "2026-08-08T00:00:00.000Z",
      ),
    ).toThrow(/check/i);
    expect(() =>
      insertEvent.run(
        "bad-event-revision",
        "run-1",
        1,
        -1,
        "test",
        "test",
        "2026-08-08T00:00:00.000Z",
      ),
    ).toThrow(/check/i);

    const insertFinding = connection.native.prepare(
      `INSERT INTO findings (
        id, run_id, rework_epoch, review_step_id, stable_key,
        disposition_sequence, severity, evidence, disposition, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      insertFinding.run(
        "bad-finding-rework",
        "run-1",
        -1,
        "step-1",
        "finding-1",
        1,
        "test",
        "test",
        "open",
        "2026-08-08T00:00:00.000Z",
      ),
    ).toThrow(/check/i);
    expect(() =>
      insertFinding.run(
        "bad-disposition-sequence",
        "run-1",
        0,
        "step-1",
        "finding-2",
        0,
        "test",
        "test",
        "open",
        "2026-08-08T00:00:00.000Z",
      ),
    ).toThrow(/check/i);

    const insertSideEffect = connection.native.prepare(
      `INSERT INTO side_effects (
        key, run_id, rework_epoch, kind, target_revision, fingerprint,
        intent_json, status, executor_attempt, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      insertSideEffect.run(
        "bad-side-effect-rework",
        "run-1",
        -1,
        "test",
        0,
        "fingerprint-0",
        "{}",
        "pending",
        0,
        "2026-08-08T00:00:00.000Z",
        "2026-08-08T00:00:00.000Z",
      ),
    ).toThrow(/check/i);
    expect(() =>
      insertSideEffect.run(
        "bad-target-revision",
        "run-1",
        0,
        "test",
        -1,
        "fingerprint-1",
        "{}",
        "pending",
        0,
        "2026-08-08T00:00:00.000Z",
        "2026-08-08T00:00:00.000Z",
      ),
    ).toThrow(/check/i);
    expect(() =>
      insertSideEffect.run(
        "bad-executor-attempt",
        "run-1",
        0,
        "test",
        0,
        "fingerprint-2",
        "{}",
        "pending",
        -1,
        "2026-08-08T00:00:00.000Z",
        "2026-08-08T00:00:00.000Z",
      ),
    ).toThrow(/check/i);
  });

  test("rejects a finding whose referenced review step belongs to another run", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);
    migrateDatabase(connection, migrationsDirectory);
    insertRun(connection);
    insertRun(connection, {
      id: "run-2",
      project_item_id: "project-item-2",
      issue_node_id: "issue-node-2",
      issue_number: 2,
    });
    insertStep(connection);

    expect(() =>
      connection.native
        .prepare(
          `INSERT INTO findings (
            id, run_id, rework_epoch, review_step_id, stable_key,
            disposition_sequence, severity, evidence, disposition, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "finding-1",
          "run-2",
          0,
          "step-1",
          "finding-key",
          1,
          "high",
          "evidence",
          "open",
          "2026-08-08T00:00:00.000Z",
        ),
    ).toThrow(/foreign key/i);
  });

  test("rejects duplicate durable step lifecycle coordinates", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);
    migrateDatabase(connection, migrationsDirectory);
    insertRun(connection);
    insertStep(connection);

    expect(() => insertStep(connection, { id: "step-2" })).toThrow(/unique/i);
  });

  test("rejects invalid migration ledger identity and checksum values", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);
    migrateDatabase(connection, migrationsDirectory);
    const insertLedger = connection.native.prepare(
      "INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    );
    const appliedAt = "2026-08-08T00:00:00.000Z";

    expect(() =>
      insertLedger.run(0, "000_invalid.sql", "a".repeat(64), appliedAt),
    ).toThrow(/check/i);
    expect(() =>
      insertLedger.run(2, "001_initial.sql", "a".repeat(64), appliedAt),
    ).toThrow(/unique/i);
    expect(() =>
      insertLedger.run(2, "002_upper.sql", "A".repeat(64), appliedAt),
    ).toThrow(/check/i);
    expect(() =>
      insertLedger.run(2, "002_short.sql", "a".repeat(63), appliedAt),
    ).toThrow(/check/i);
    expect(() => insertLedger.run(2, null, "a".repeat(64), appliedAt)).toThrow(
      /NOT NULL.*schema_migrations\.name/i,
    );
    expect(() =>
      insertLedger.run(2, "002_null_checksum.sql", null, appliedAt),
    ).toThrow(/NOT NULL.*schema_migrations\.checksum/i);
    expect(() =>
      insertLedger.run(2, "002_null_applied_at.sql", "a".repeat(64), null),
    ).toThrow(/NOT NULL.*schema_migrations\.applied_at/i);
  });

  test("rejects a durable JSON value larger than one MiB", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);
    migrateDatabase(connection, migrationsDirectory);

    expect(() =>
      insertRun(connection, {
        intake_json: JSON.stringify("x".repeat(maximumJsonBytes)),
      }),
    ).toThrow(/check/i);
  });

  test("enforces foreign keys on the open connection", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);
    migrateDatabase(connection, migrationsDirectory);

    expect(connection.foreignKeysEnabled).toBe(true);
    expect(() =>
      connection.native
        .prepare(
          `INSERT INTO steps (
            id, run_id, rework_epoch, role, logical_step, attempt,
            status_sequence, status, prompt_hash, model, reasoning_effort, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "step-1",
          "not-a-run",
          0,
          "builder",
          "build",
          1,
          1,
          "pending",
          "sha256:prompt",
          "gpt-5.6-terra",
          "medium",
          "2026-08-08T00:00:00.000Z",
        ),
    ).toThrow(/foreign key/i);
  });

  test("reports actual WAL journal mode on an ordinary temporary filesystem", async () => {
    const { databasePath } = await createTemporaryDatabase();
    const connection = open(databasePath);

    expect(connection.journalMode).toBe("wal");
    expect(connection.native.pragma("journal_mode", { simple: true })).toBe(
      "wal",
    );
  });

  test("reports and warns about the actual safe non-WAL fallback mode", async () => {
    const { databasePath } = await createTemporaryDatabase();
    const fallbackModes: string[] = [];
    const connection = openDatabase(databasePath, {
      onJournalModeFallback: (actualMode: string) =>
        fallbackModes.push(actualMode),
      requestJournalMode: (native) =>
        native.pragma("journal_mode = DELETE", { simple: true }) as string,
    });
    connections.add(connection);

    expect(connection.journalMode).toBe("delete");
    expect(connection.native.pragma("journal_mode", { simple: true })).toBe(
      "delete",
    );
    expect(fallbackModes).toEqual(["delete"]);
  });

  test.each(["OFF", "MEMORY"])(
    "rejects unsafe injected %s journal mode and leaves the file reopenable",
    async (unsafeMode) => {
      const { databasePath } = await createTemporaryDatabase();
      let capturedNative: { open: boolean } | undefined;

      expect(() =>
        openDatabase(databasePath, {
          requestJournalMode: (native) => {
            capturedNative = native;
            return unsafeMode.toLowerCase();
          },
        }),
      ).toThrow(/journal.*(?:off|memory)|unsafe/i);
      expect(capturedNative?.open).toBe(false);

      const reopened = open(databasePath);
      await close(reopened);
      const reopenedAgain = open(databasePath);
      expect(reopenedAgain.native.open).toBe(true);
    },
  );

  test("configures the five-second busy timeout", async () => {
    const { databasePath } = await createTemporaryDatabase();
    const connection = open(databasePath);

    expect(connection.native.pragma("busy_timeout", { simple: true })).toBe(
      5_000,
    );
  });

  test("exposes Kysely transactions on the same native storage handle", async () => {
    const { databasePath } = await createTemporaryDatabase();
    const connection = open(databasePath);

    await connection.db.transaction().execute(async (transaction) => {
      expect(connection.native.inTransaction).toBe(true);
      await transaction.schema
        .createTable("kysely_probe")
        .addColumn("value", "text", (column) => column.notNull())
        .execute();
      connection.native
        .prepare("INSERT INTO kysely_probe (value) VALUES (?)")
        .run("committed");
    });

    expect(
      connection.native.prepare("SELECT value FROM kysely_probe").get(),
    ).toEqual({ value: "committed" });
  });

  test("closes the Kysely and native handle asynchronously and idempotently", async () => {
    const { databasePath } = await createTemporaryDatabase();
    const connection = open(databasePath);

    await expect(connection.close()).resolves.toBeUndefined();
    await expect(connection.close()).resolves.toBeUndefined();
    connections.delete(connection);

    expect(connection.native.open).toBe(false);
    await expect(
      connection.db.schema
        .createTable("must_not_open")
        .addColumn("id", "integer")
        .execute(),
    ).rejects.toThrow(/closed|destroyed|not open/i);
  });

  test("does not replay applied migrations after closing and reopening", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const first = open(databasePath);
    migrateDatabase(first, migrationsDirectory);
    expect(
      first.native.prepare("SELECT id, name FROM schema_migrations").all(),
    ).toEqual([{ id: 1, name: "001_initial.sql" }]);
    await close(first);

    const reopened = open(databasePath);
    migrateDatabase(reopened, migrationsDirectory);
    expect(
      reopened.native.prepare("SELECT id, name FROM schema_migrations").all(),
    ).toEqual([{ id: 1, name: "001_initial.sql" }]);
  });

  test("stores the SHA-256 checksum of the exact raw migration bytes", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const rawMigration = await readFile(
      join(migrationsDirectory, "001_initial.sql"),
    );
    const connection = open(databasePath);

    migrateDatabase(connection, migrationsDirectory);

    expect(
      connection.native
        .prepare("SELECT checksum FROM schema_migrations WHERE id = 1")
        .get(),
    ).toEqual({
      checksum: createHash("sha256").update(rawMigration).digest("hex"),
    });
  });

  test("applies later migrations in numeric order", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    await addMigration(
      migrationsDirectory,
      "010_ten.sql",
      "CREATE TABLE ten (id INTEGER PRIMARY KEY);",
    );
    await addMigration(
      migrationsDirectory,
      "002_two.sql",
      "CREATE TABLE two (id INTEGER PRIMARY KEY);",
    );
    const connection = open(databasePath);

    migrateDatabase(connection, migrationsDirectory);

    expect(
      connection.native
        .prepare("SELECT id, name FROM schema_migrations ORDER BY id")
        .all(),
    ).toEqual([
      { id: 1, name: "001_initial.sql" },
      { id: 2, name: "002_two.sql" },
      { id: 10, name: "010_ten.sql" },
    ]);
  });

  test("rolls back migration 002 schema and ledger after its ledger insert fails", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const initialConnection = open(databasePath);
    migrateDatabase(initialConnection, migrationsDirectory);
    await close(initialConnection);
    await addMigration(
      migrationsDirectory,
      "002_atomic.sql",
      "CREATE TABLE must_not_survive (id INTEGER PRIMARY KEY);",
    );
    const connection = open(databasePath);

    expect(() =>
      migrateDatabase(connection, migrationsDirectory, {
        afterLedgerInsert: ({ id }: { id: number }) => {
          if (id === 2) throw new Error("injected failure");
        },
      }),
    ).toThrow("injected failure");
    await close(connection);

    const reopened = open(databasePath);

    expect(tableExists(reopened, "runs")).toBe(true);
    expect(tableExists(reopened, "must_not_survive")).toBe(false);
    expect(
      reopened.native
        .prepare("SELECT id FROM schema_migrations ORDER BY id")
        .all(),
    ).toEqual([{ id: 1 }]);
  });

  test("preflights an edited applied migration before applying a later migration", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);
    migrateDatabase(connection, migrationsDirectory);
    await close(connection);
    await addMigration(
      migrationsDirectory,
      "002_must_not_apply.sql",
      "CREATE TABLE must_not_apply (id INTEGER PRIMARY KEY);",
    );
    await replaceMigration(
      migrationsDirectory,
      "001_initial.sql",
      `${await readMigration(migrationsDirectory, "001_initial.sql")}\n-- edited`,
    );

    const invalid = open(databasePath);
    expect(() => migrateDatabase(invalid, migrationsDirectory)).toThrow(
      /checksum/i,
    );
    await close(invalid);

    const reopened = open(databasePath);
    expect(tableExists(reopened, "runs")).toBe(true);
    expect(tableExists(reopened, "must_not_apply")).toBe(false);
    expect(
      reopened.native
        .prepare("SELECT id FROM schema_migrations ORDER BY id")
        .all(),
    ).toEqual([{ id: 1 }]);
  });

  test("preflights a missing applied migration before applying a later migration", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);
    migrateDatabase(connection, migrationsDirectory);
    await close(connection);
    await addMigration(
      migrationsDirectory,
      "002_must_not_apply.sql",
      "CREATE TABLE must_not_apply (id INTEGER PRIMARY KEY);",
    );
    await rm(join(migrationsDirectory, "001_initial.sql"));

    const invalid = open(databasePath);
    expect(() => migrateDatabase(invalid, migrationsDirectory)).toThrow(
      /missing.*applied/i,
    );
    await close(invalid);

    const reopened = open(databasePath);
    expect(tableExists(reopened, "runs")).toBe(true);
    expect(tableExists(reopened, "must_not_apply")).toBe(false);
    expect(
      reopened.native
        .prepare("SELECT id FROM schema_migrations ORDER BY id")
        .all(),
    ).toEqual([{ id: 1 }]);
  });

  test("rejects duplicate numeric migration identifiers before mutation", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    await addMigration(
      migrationsDirectory,
      "001_duplicate.sql",
      "CREATE TABLE duplicate_id (id INTEGER);",
    );
    const connection = open(databasePath);

    expect(() => migrateDatabase(connection, migrationsDirectory)).toThrow(
      /duplicate.*id/i,
    );
    expect(
      connection.native
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all(),
    ).toEqual([]);
  });

  test.each([
    "01_short.sql",
    "001_Upper.sql",
    "001-dash.sql",
    "001_unicode_é.sql",
    "001_case.SQL",
  ])(
    "rejects malformed migration filename %s before mutation",
    async (filename) => {
      const { databasePath, migrationsDirectory } =
        await createTemporaryDatabase();
      await addMigration(
        migrationsDirectory,
        filename,
        "CREATE TABLE malformed (id INTEGER);",
      );
      const connection = open(databasePath);

      expect(() => migrateDatabase(connection, migrationsDirectory)).toThrow(
        /filename|migration/i,
      );
      expect(
        connection.native
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all(),
      ).toEqual([]);
    },
  );

  test("rejects a retroactive unapplied migration ID", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);
    migrateDatabase(connection, migrationsDirectory);
    await close(connection);
    await addMigration(
      migrationsDirectory,
      "000_retroactive.sql",
      "CREATE TABLE retroactive (id INTEGER);",
    );
    await addMigration(
      migrationsDirectory,
      "002_must_not_apply.sql",
      "CREATE TABLE must_not_apply (id INTEGER);",
    );

    const invalid = open(databasePath);
    expect(() => migrateDatabase(invalid, migrationsDirectory)).toThrow(
      /retroactive|applied/i,
    );
    await close(invalid);

    const reopened = open(databasePath);
    expect(tableExists(reopened, "runs")).toBe(true);
    expect(tableExists(reopened, "retroactive")).toBe(false);
    expect(tableExists(reopened, "must_not_apply")).toBe(false);
    expect(
      reopened.native
        .prepare("SELECT id FROM schema_migrations ORDER BY id")
        .all(),
    ).toEqual([{ id: 1 }]);
  });

  test("allows transaction and attachment words inside comments and string literals", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    await addMigration(
      migrationsDirectory,
      "002_legal_words.sql",
      `-- BEGIN COMMIT ROLLBACK SAVEPOINT ATTACH DETACH are documentation here
       CREATE TABLE legal_words (value TEXT NOT NULL);
       INSERT INTO legal_words (value)
       VALUES ('BEGIN; COMMIT; ROLLBACK; SAVEPOINT; ATTACH; DETACH;');
       /* ATTACH DATABASE and DETACH DATABASE remain comments */`,
    );
    const connection = open(databasePath);

    migrateDatabase(connection, migrationsDirectory);

    expect(
      connection.native.prepare("SELECT value FROM legal_words").get(),
    ).toEqual({
      value: "BEGIN; COMMIT; ROLLBACK; SAVEPOINT; ATTACH; DETACH;",
    });
    expect(
      connection.native
        .prepare("SELECT id FROM schema_migrations ORDER BY id")
        .all(),
    ).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test.each([
    "BEGIN; CREATE TABLE forbidden (id INTEGER);",
    "  -- leading comment\n  bEgIn IMMEDIATE; CREATE TABLE forbidden (id INTEGER);",
    "CREATE TABLE must_not_survive (id INTEGER); /* boundary */ CoMmIt;",
    "CREATE TABLE must_not_survive (id INTEGER);\n\tRoLlBaCk;",
    "CREATE TABLE must_not_survive (id INTEGER);\nSAVEPOINT migrations;",
    "CREATE TABLE must_not_survive (id INTEGER); -- attach next\nAtTaCh DATABASE 'other.sqlite' AS other;",
    "CREATE TABLE must_not_survive (id INTEGER);\n/* detach next */ DeTaCh DATABASE other;",
  ])("rejects forbidden SQL statement %s before mutation", async (sql) => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    await addMigration(migrationsDirectory, "002_forbidden.sql", sql);
    const connection = open(databasePath);

    expect(() => migrateDatabase(connection, migrationsDirectory)).toThrow(
      /forbidden|transaction|attach/i,
    );
    expect(
      connection.native
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all(),
    ).toEqual([]);
    expect(tableExists(connection, "must_not_survive")).toBe(false);
  });

  test("copies and applies the repository initial migration by its immutable filename", async () => {
    const { databasePath, migrationsDirectory } =
      await createTemporaryDatabase();
    const connection = open(databasePath);

    migrateDatabase(connection, migrationsDirectory);

    expect(
      connection.native
        .prepare("SELECT name FROM schema_migrations WHERE id = 1")
        .get(),
    ).toEqual({ name: basename(repositoryInitialMigration) });
  });
});
