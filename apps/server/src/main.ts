import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import {
  type LocalPaths,
  loadRuntimeConfiguration,
  prepareLocalPaths,
} from "./config.js";
import { openDatabase } from "./database/connection.js";
import { migrateDatabase } from "./database/migrate.js";
import { acquireOwnership } from "./database/ownership.js";
import { createReadinessGate, type ReadinessGate } from "./readiness.js";
import { registerWeb } from "./web.js";

interface Ownership {
  release(): Promise<void>;
}

interface Database {
  close(): Promise<void>;
}

interface Application {
  close(): Promise<void>;
  listen(options: { host: string; port: number }): Promise<string>;
}

type Signal = "SIGINT" | "SIGTERM";

interface SignalTarget {
  once(signal: Signal, listener: () => void | Promise<void>): void;
  removeListener(signal: Signal, listener: () => void | Promise<void>): void;
}

export interface RunningService {
  close(): Promise<void>;
}

export interface StartDependencies {
  loadRuntimeConfiguration(
    repositoryRoot: string,
  ): Promise<{ paths: LocalPaths }>;
  prepareLocalPaths(paths: LocalPaths): Promise<LocalPaths>;
  acquireOwnership(lockPath: string): Promise<Ownership>;
  openDatabase(databasePath: string): Database | Promise<Database>;
  migrateDatabase(database: Database, directory: string): void | Promise<void>;
  buildApp(options: {
    readiness: ReadinessGate;
    registerWeb?: (app: FastifyInstance) => Promise<void>;
  }): Promise<Application>;
  createReadinessGate(): ReadinessGate;
  announce(url: string): void;
  signalTarget: SignalTarget;
  registerWeb?:
    | ((app: FastifyInstance, directory: string) => Promise<void>)
    | undefined;
}

export function parsePort(value: string | undefined): number {
  const port = value === undefined ? 4321 : Number(value);
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    !/^\d+$/.test(value ?? "4321")
  ) {
    throw new Error("WHEELSPARROW_PORT must be an integer between 0 and 65535");
  }
  return port;
}

export function resolveMigrationsDirectory(
  moduleDirectory = import.meta.dirname,
): string {
  return resolve(moduleDirectory, "../../../migrations");
}

class ShutdownRequestedError extends Error {
  constructor() {
    super("startup interrupted by shutdown signal");
    this.name = "ShutdownRequestedError";
  }
}

function reportCleanupFailure(errors: unknown[]): void {
  if (errors[0] !== undefined) throw errors[0];
}

export async function startService(
  repositoryRoot: string,
  dependencies: StartDependencies,
): Promise<RunningService> {
  let readiness: ReadinessGate | undefined;
  let ownership: Ownership | undefined;
  let database: Database | undefined;
  let app: Application | undefined;
  let handlersInstalled = false;
  let shutdownRequested = false;
  let closePromise: Promise<void> | undefined;
  let startupSettled = false;
  let resolveStartupSettled!: () => void;
  const startupHasSettled = new Promise<void>((resolve) => {
    resolveStartupSettled = resolve;
  });

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      if (!startupSettled) await startupHasSettled;

      const errors: unknown[] = [];
      const attempt = async (operation: () => void | Promise<void>) => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };

      if (handlersInstalled && readiness !== undefined) {
        await attempt(() => readiness?.markNotReady());
      }
      if (app !== undefined) await attempt(() => app?.close());
      if (database !== undefined) await attempt(() => database?.close());
      if (ownership !== undefined) await attempt(() => ownership?.release());
      if (handlersInstalled) {
        await attempt(() =>
          dependencies.signalTarget.removeListener(
            "SIGINT",
            signalHandlers.SIGINT,
          ),
        );
        await attempt(() =>
          dependencies.signalTarget.removeListener(
            "SIGTERM",
            signalHandlers.SIGTERM,
          ),
        );
      }
      reportCleanupFailure(errors);
    })();
    return closePromise;
  };

  const signalHandlers: Record<Signal, () => Promise<void>> = {
    SIGINT: () => {
      shutdownRequested = true;
      return close();
    },
    SIGTERM: () => {
      shutdownRequested = true;
      return close();
    },
  };

  const stopIfRequested = (): void => {
    if (shutdownRequested) throw new ShutdownRequestedError();
  };

  let address: string | undefined;
  try {
    try {
      const { paths } =
        await dependencies.loadRuntimeConfiguration(repositoryRoot);
      readiness = dependencies.createReadinessGate();
      dependencies.signalTarget.once("SIGINT", signalHandlers.SIGINT);
      dependencies.signalTarget.once("SIGTERM", signalHandlers.SIGTERM);
      handlersInstalled = true;
      await dependencies.prepareLocalPaths(paths);
      stopIfRequested();
      ownership = await dependencies.acquireOwnership(paths.lockPath);
      stopIfRequested();
      database = await dependencies.openDatabase(paths.databasePath);
      stopIfRequested();
      await dependencies.migrateDatabase(
        database,
        resolveMigrationsDirectory(),
      );
      stopIfRequested();
      app = await dependencies.buildApp(
        process.env.NODE_ENV === "development"
          ? { readiness }
          : {
              readiness,
              registerWeb: async (server) => {
                await dependencies.registerWeb?.(
                  server,
                  resolve(import.meta.dirname, "../../web/dist"),
                );
              },
            },
      );
      stopIfRequested();
      address = await app.listen({
        host: "127.0.0.1",
        port: parsePort(process.env.WHEELSPARROW_PORT),
      });
      stopIfRequested();
      readiness.markReady();
      dependencies.announce(address);
    } finally {
      startupSettled = true;
      resolveStartupSettled();
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      if (error instanceof ShutdownRequestedError) throw cleanupError;
    }
    throw error;
  }

  return { close };
}

function productionSignalTarget(): SignalTarget {
  const listeners = new Map<
    Signal,
    Map<() => void | Promise<void>, () => void>
  >();

  return {
    once(signal, listener) {
      const byListener = listeners.get(signal) ?? new Map();
      listeners.set(signal, byListener);
      const wrapped = () => {
        byListener.delete(listener);
        const force = setTimeout(() => process.exit(1), 10_000);
        force.unref();
        void Promise.resolve(listener()).then(
          () => clearTimeout(force),
          () => {
            process.exitCode = 1;
          },
        );
      };
      byListener.set(listener, wrapped);
      process.once(signal, wrapped);
    },
    removeListener(signal, listener) {
      const wrapped = listeners.get(signal)?.get(listener);
      if (wrapped === undefined) return;
      process.removeListener(signal, wrapped);
      listeners.get(signal)?.delete(listener);
    },
  };
}

const productionDependencies: StartDependencies = {
  loadRuntimeConfiguration,
  prepareLocalPaths,
  acquireOwnership,
  openDatabase,
  migrateDatabase,
  buildApp,
  createReadinessGate,
  announce(url) {
    process.stdout.write(`WHEELSPARROW_URL=${url}\n`);
  },
  signalTarget: productionSignalTarget(),
  registerWeb,
};

export async function start(repositoryRoot = process.cwd()): Promise<void> {
  try {
    await startService(repositoryRoot, productionDependencies);
  } catch (error) {
    if (!(error instanceof ShutdownRequestedError)) throw error;
  }
}

if (import.meta.main) await start();
