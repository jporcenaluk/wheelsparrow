import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DatabaseConnection } from "./connection.js";

const migrationFilename = /^(?<id>[0-9]{3})_(?<name>[a-z0-9_]+)\.sql$/;

interface Migration {
  id: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateDatabaseOptions {
  afterLedgerInsert?: (migration: Pick<Migration, "id" | "name">) => void;
}

function readMigrations(directory: string): Migration[] {
  const seenIds = new Set<number>();
  const migrations = readdirSync(directory, { withFileTypes: true }).map(
    (entry) => {
      if (
        !entry.isFile() ||
        [...entry.name].some(
          (character) => (character.codePointAt(0) ?? 0) > 0x7f,
        )
      ) {
        throw new Error(`Invalid migration filename: ${entry.name}`);
      }
      const match = migrationFilename.exec(entry.name);
      if (match?.groups === undefined) {
        throw new Error(`Invalid migration filename: ${entry.name}`);
      }
      const id = Number(match.groups.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        throw new Error(`Invalid retroactive migration id: ${id}`);
      }
      if (seenIds.has(id)) {
        throw new Error(`Duplicate migration id: ${id}`);
      }
      seenIds.add(id);
      const bytes = readFileSync(join(directory, entry.name));
      let sql: string;
      try {
        sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw new Error(
          `Migration ${entry.name} is not valid UTF-8 encoded SQL`,
          { cause: error },
        );
      }
      rejectForbiddenSql(sql, entry.name);
      return {
        id,
        name: entry.name,
        sql,
        checksum: createHash("sha256").update(bytes).digest("hex"),
      };
    },
  );
  const ordered = migrations.toSorted((left, right) => left.id - right.id);
  if (
    !ordered.some(
      (migration) => migration.id === 1 && migration.name === "001_initial.sql",
    )
  ) {
    throw new Error(
      "Missing canonical initial migration 001_initial.sql; applied migrations must remain present",
    );
  }
  return ordered;
}

/** Remove comments and literals, retaining statement-leading executable tokens. */
function executableTokens(sql: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  let atStatementStart = true;
  let createTriggerPending = false;
  let triggerDeclaration = false;
  let triggerBody = false;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === "-" && next === "-") {
      index = sql.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) throw new Error("Unterminated SQL block comment");
      index = end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote && quote !== "`") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === "[") {
      const end = sql.indexOf("]", index + 1);
      if (end === -1) throw new Error("Unterminated SQL quoted identifier");
      index = end + 1;
      continue;
    }
    if (character === ";") {
      atStatementStart = true;
      index += 1;
      continue;
    }
    if (/\s/u.test(character ?? "")) {
      index += 1;
      continue;
    }
    const match = /^[A-Za-z]+/.exec(sql.slice(index));
    if (match?.[0] !== undefined) {
      const token = match[0].toUpperCase();
      const wasStatementStart = atStatementStart;
      if (wasStatementStart) {
        if (!(triggerBody && token === "END")) tokens.push(token);
        atStatementStart = false;
      }

      if (wasStatementStart && token === "CREATE") {
        createTriggerPending = true;
      } else if (
        createTriggerPending &&
        (token === "TEMP" || token === "TEMPORARY")
      ) {
        // CREATE TEMP[ORARY] TRIGGER is also a trigger declaration.
      } else if (createTriggerPending && token === "TRIGGER") {
        createTriggerPending = false;
        triggerDeclaration = true;
      } else if (createTriggerPending) {
        createTriggerPending = false;
      }

      if (triggerDeclaration && token === "BEGIN") triggerBody = true;
      if (triggerBody && wasStatementStart && token === "END") {
        triggerBody = false;
        triggerDeclaration = false;
      }
      index += match[0].length;
      continue;
    }
    atStatementStart = false;
    index += 1;
  }
  return tokens;
}

function rejectForbiddenSql(sql: string, name: string): void {
  const forbidden = new Set([
    "BEGIN",
    "COMMIT",
    "END",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE",
    "ATTACH",
    "DETACH",
  ]);
  for (const token of executableTokens(sql)) {
    if (forbidden.has(token)) {
      throw new Error(
        `Migration ${name} contains forbidden ${token} statement`,
      );
    }
  }
}

function ledgerExists(connection: DatabaseConnection): boolean {
  return (
    connection.native
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() !== undefined
  );
}

export function migrateDatabase(
  connection: DatabaseConnection,
  directory: string,
  options: MigrateDatabaseOptions = {},
): void {
  const migrations = readMigrations(directory);
  const byId = new Map(
    migrations.map((migration) => [migration.id, migration]),
  );
  const applied = ledgerExists(connection)
    ? (connection.native
        .prepare("SELECT id, name, checksum FROM schema_migrations ORDER BY id")
        .all() as Array<{ id: number; name: string; checksum: string }>)
    : [];

  // Validate the entire known history before the first mutation. This prevents
  // a later file from applying against a changed or incomplete past.
  for (const record of applied) {
    const migration = byId.get(record.id);
    if (migration === undefined) {
      throw new Error(`Missing applied migration ${record.id}: ${record.name}`);
    }
    if (
      migration.name !== record.name ||
      migration.checksum !== record.checksum
    ) {
      throw new Error(
        `Checksum mismatch for applied migration ${record.id}: ${record.name}`,
      );
    }
  }
  const maximumAppliedId = applied.at(-1)?.id ?? 0;
  for (const migration of migrations) {
    if (!byId.has(migration.id))
      throw new Error(`Missing migration ${migration.id}`);
    if (
      migration.id < maximumAppliedId &&
      !applied.some((record) => record.id === migration.id)
    ) {
      throw new Error(`Retroactive unapplied migration ${migration.id}`);
    }
  }

  const appliedIds = new Set(applied.map((record) => record.id));
  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) continue;
    connection.native.transaction(() => {
      connection.native.exec(migration.sql);
      const insertLedger = connection.native.prepare(
        "INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      );
      insertLedger.run(
        migration.id,
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      );
      options.afterLedgerInsert?.(migration);
    })();
  }
}
