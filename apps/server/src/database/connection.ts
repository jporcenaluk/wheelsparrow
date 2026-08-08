import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import type { DatabaseSchema } from "./schema.js";

const safeJournalModes = new Set(["wal", "delete", "truncate", "persist"]);

export interface OpenDatabaseOptions {
  /** Narrow test seam for filesystems where WAL negotiation must be simulated. */
  requestJournalMode?: (native: Database.Database) => string;
  /** Called before startup proceeds when the filesystem cannot provide WAL. */
  onJournalModeFallback?: (actualMode: string) => void;
}

export interface DatabaseConnection {
  native: Database.Database;
  db: Kysely<DatabaseSchema>;
  foreignKeysEnabled: true;
  recursiveTriggersEnabled: true;
  journalMode: string;
  close(): Promise<void>;
}

function validateExistingSqliteTarget(path: string): boolean {
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`SQLite path must be a regular file: ${path}`);
  }
  if (process.platform !== "win32") {
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && status.uid !== currentUid) {
      throw new Error(`SQLite path is not owned by the current user: ${path}`);
    }
    if ((status.mode & 0o077) !== 0) {
      throw new Error(
        `SQLite path must be private to the current user: ${path}`,
      );
    }
  }
  return true;
}

function validateExistingDatabaseFiles(path: string): boolean {
  const databaseExisted = validateExistingSqliteTarget(path);
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (candidate !== path) validateExistingSqliteTarget(candidate);
  }
  return databaseExisted;
}

function normalizeJournalMode(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("SQLite returned an invalid journal mode");
  }
  return value.toLowerCase();
}

function makeNewDatabasePrivate(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile()) {
      throw new Error(`SQLite path must be a regular file: ${path}`);
    }
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && status.uid !== currentUid) {
      throw new Error(`SQLite path is not owned by the current user: ${path}`);
    }
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

export function openDatabase(
  path: string,
  options: OpenDatabaseOptions = {},
): DatabaseConnection {
  let native: Database.Database | undefined;
  let db: Kysely<DatabaseSchema> | undefined;
  let closePromise: Promise<void> | undefined;

  try {
    const databaseExisted = validateExistingDatabaseFiles(path);
    native = new Database(path);
    if (!databaseExisted && process.platform !== "win32")
      makeNewDatabasePrivate(path);
    validateExistingSqliteTarget(path);
    native.pragma("busy_timeout = 5000");
    native.pragma("foreign_keys = ON");
    if (native.pragma("foreign_keys", { simple: true }) !== 1) {
      throw new Error("SQLite foreign key enforcement could not be enabled");
    }
    native.pragma("recursive_triggers = ON");
    if (native.pragma("recursive_triggers", { simple: true }) !== 1) {
      throw new Error(
        "SQLite recursive trigger enforcement could not be enabled",
      );
    }

    const requested =
      options.requestJournalMode ??
      ((handle: Database.Database) =>
        handle.pragma("journal_mode = WAL", { simple: true }) as string);
    const requestedMode = normalizeJournalMode(requested(native));
    if (!safeJournalModes.has(requestedMode)) {
      throw new Error(
        `SQLite journal mode ${requestedMode} is unsafe for Wheelsparrow`,
      );
    }
    const journalMode = normalizeJournalMode(
      native.pragma("journal_mode", { simple: true }),
    );
    if (!safeJournalModes.has(journalMode)) {
      throw new Error(
        `SQLite journal mode ${journalMode} is unsafe for Wheelsparrow`,
      );
    }
    if (journalMode !== "wal") {
      if (options.onJournalModeFallback !== undefined) {
        options.onJournalModeFallback(journalMode);
      } else {
        process.stderr.write(
          `${JSON.stringify({
            event: "sqlite_journal_mode_fallback",
            journalMode,
            level: "warn",
          })}\n`,
        );
      }
    }
    // SQLite creates WAL sidecars while negotiating journal mode. Re-check
    // each live file now that a newly-created database has been made private.
    validateExistingDatabaseFiles(path);

    db = new Kysely<DatabaseSchema>({
      dialect: new SqliteDialect({ database: native }),
    });

    const handle = native;
    const kysely = db;
    return {
      native: handle,
      db: kysely,
      foreignKeysEnabled: true,
      recursiveTriggersEnabled: true,
      journalMode,
      close(): Promise<void> {
        if (closePromise !== undefined) return closePromise;
        closePromise = Promise.resolve().then(async () => {
          // Kysely closes an initialized SqliteDialect handle. If Kysely was
          // never used, the explicit guard closes the same owned handle.
          try {
            await kysely.destroy();
          } finally {
            if (handle.open) handle.close();
          }
        });
        return closePromise;
      },
    };
  } catch (error) {
    if (native?.open) native.close();
    throw error;
  }
}
