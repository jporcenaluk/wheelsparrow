import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

const databases = new Set<Database.Database>();
const temporaryDirectories: string[] = [];

function openDatabase(path: string): Database.Database {
  const database = new Database(path);
  databases.add(database);
  return database;
}

function closeDatabase(database: Database.Database): void {
  database.close();
  databases.delete(database);
}

afterEach(async () => {
  let closeError: unknown;

  for (const database of databases) {
    try {
      database.close();
    } catch (error) {
      closeError ??= error;
    }
  }
  databases.clear();

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );

  if (closeError !== undefined) {
    throw closeError;
  }
});

describe("SQLite persistence", () => {
  test("persists a value after closing and reopening a database file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-sqlite-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "storage.sqlite");

    const initialDatabase = openDatabase(path);
    initialDatabase.exec("CREATE TABLE entries (value TEXT NOT NULL)");
    initialDatabase.prepare("INSERT INTO entries (value) VALUES (?)").run("saved");
    closeDatabase(initialDatabase);

    const reopenedDatabase = openDatabase(path);

    expect(
      reopenedDatabase
        .prepare("SELECT value FROM entries")
        .get() as { value: string },
    ).toEqual({ value: "saved" });
  });
});
