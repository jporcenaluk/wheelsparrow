import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { LocalPaths } from "./config.js";
import {
  parsePort,
  type RunningService,
  resolveMigrationsDirectory,
  type StartDependencies,
  start,
  startService,
} from "./main.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function localPaths(repositoryRoot = "/repository"): LocalPaths {
  const dataRoot = join(repositoryRoot, ".wheelsparrow");
  return {
    repositoryRoot,
    dataRoot,
    workspaceRoot: join(dataRoot, "workspaces"),
    databasePath: join(dataRoot, "wheelsparrow.sqlite3"),
    lockPath: join(dataRoot, "wheelsparrow.lock"),
    logsRoot: join(dataRoot, "logs"),
  };
}

type Phase =
  | "load-runtime"
  | "prepare-paths"
  | "acquire"
  | "open"
  | "migrate"
  | "build"
  | "listen"
  | "ready"
  | "announce";

function lifecycleFakes({
  events,
  failAt,
  cleanupFailure,
}: {
  events: string[];
  failAt?: Phase;
  cleanupFailure?: boolean;
}) {
  const paths = localPaths();
  const failure = new Error(`failed at ${failAt}`);
  const fail = (phase: Phase): void => {
    events.push(phase);
    if (phase === failAt) throw failure;
  };
  const listeners = new Map<string, () => void>();
  const signalTarget = {
    once(signal: string, listener: () => void) {
      events.push(`install:${signal}`);
      listeners.set(signal, listener);
    },
    removeListener(signal: string, listener: () => void) {
      events.push(`remove:${signal}`);
      if (listeners.get(signal) === listener) listeners.delete(signal);
    },
  };
  const ownership = {
    async release() {
      events.push("ownership-release");
      if (cleanupFailure) throw new Error("ownership cleanup failed");
    },
  };
  const database = {
    async close() {
      events.push("database-close");
      if (cleanupFailure) throw new Error("database cleanup failed");
    },
  };
  const app = {
    async close() {
      events.push("app-close");
      if (cleanupFailure) throw new Error("app cleanup failed");
    },
    async listen(options: { host: string; port: number }) {
      fail("listen");
      expect(options).toEqual({ host: "127.0.0.1", port: 4321 });
      return "http://127.0.0.1:4321";
    },
  };

  return {
    paths,
    events,
    failure,
    signalTarget,
    dependencies: {
      async loadRuntimeConfiguration(repositoryRoot: string) {
        fail("load-runtime");
        expect(repositoryRoot).toBe(paths.repositoryRoot);
        return { configuration: {}, paths };
      },
      async prepareLocalPaths(actualPaths: LocalPaths) {
        fail("prepare-paths");
        expect(actualPaths).toBe(paths);
        return actualPaths;
      },
      async acquireOwnership(lockPath: string) {
        fail("acquire");
        expect(lockPath).toBe(paths.lockPath);
        return ownership;
      },
      async openDatabase(databasePath: string) {
        fail("open");
        expect(databasePath).toBe(paths.databasePath);
        return database;
      },
      async migrateDatabase(
        actualDatabase: typeof database,
        directory: string,
      ) {
        fail("migrate");
        expect(actualDatabase).toBe(database);
        expect(directory).toBe(
          resolve(import.meta.dirname, "../../../migrations"),
        );
      },
      async buildApp({ readiness }: { readiness: { isReady(): boolean } }) {
        fail("build");
        expect(readiness.isReady()).toBe(false);
        return app;
      },
      createReadinessGate() {
        let ready = false;
        return {
          isReady: () => ready,
          markReady() {
            fail("ready");
            ready = true;
          },
          markNotReady() {
            events.push("not-ready");
            ready = false;
          },
        };
      },
      announce(url: string) {
        fail("announce");
        expect(url).toBe("http://127.0.0.1:4321");
      },
      signalTarget,
    } satisfies StartDependencies,
  };
}

describe("start", () => {
  test.each([
    ["source", "/repo/apps/server/src"],
    ["built", "/repo/apps/server/dist"],
  ])(
    "resolves the top-level migrations directory from the %s module directory",
    (_, moduleDirectory) => {
      expect(resolveMigrationsDirectory(moduleDirectory)).toBe(
        "/repo/migrations",
      );
    },
  );

  test("validates the repository-owned configuration even when an override is set", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "wheelsparrow-main-root-"),
    );
    const externalRoot = await mkdtemp(
      join(tmpdir(), "wheelsparrow-main-external-"),
    );
    temporaryDirectories.push(repositoryRoot, externalRoot);
    const repositoryConfiguration = join(repositoryRoot, "wheelsparrow.yaml");
    await writeFile(repositoryConfiguration, "github: [invalid", "utf8");
    const externalConfiguration = join(externalRoot, "wheelsparrow.yaml");
    await writeFile(externalConfiguration, "{}", "utf8");
    const previousConfiguration = process.env.WHEELSPARROW_CONFIG;
    try {
      process.env.WHEELSPARROW_CONFIG = externalConfiguration;

      await expect(start(repositoryRoot)).rejects.toThrow(
        `Invalid configuration in ${repositoryConfiguration}:`,
      );
    } finally {
      if (previousConfiguration === undefined) {
        delete process.env.WHEELSPARROW_CONFIG;
      } else {
        process.env.WHEELSPARROW_CONFIG = previousConfiguration;
      }
    }
  });

  test("starts and stops in the exact ownership-safe order", async () => {
    const events: string[] = [];
    const fake = lifecycleFakes({ events });

    const service: RunningService = await startService(
      fake.paths.repositoryRoot,
      fake.dependencies,
    );

    expect(events).toEqual([
      "load-runtime",
      "install:SIGINT",
      "install:SIGTERM",
      "prepare-paths",
      "acquire",
      "open",
      "migrate",
      "build",
      "listen",
      "ready",
      "announce",
    ]);

    await service.close();

    expect(events).toEqual([
      "load-runtime",
      "install:SIGINT",
      "install:SIGTERM",
      "prepare-paths",
      "acquire",
      "open",
      "migrate",
      "build",
      "listen",
      "ready",
      "announce",
      "not-ready",
      "app-close",
      "database-close",
      "ownership-release",
      "remove:SIGINT",
      "remove:SIGTERM",
    ]);
  });

  test("shares one shutdown completion across concurrent close calls", async () => {
    const events: string[] = [];
    const fake = lifecycleFakes({ events });
    const service = await startService(
      fake.paths.repositoryRoot,
      fake.dependencies,
    );

    const first = service.close();
    const second = service.close();
    expect(first).toBe(second);
    await Promise.all([first, second, service.close()]);

    expect(events.filter((event) => event === "not-ready")).toHaveLength(1);
    expect(events.filter((event) => event === "app-close")).toHaveLength(1);
    expect(events.filter((event) => event === "database-close")).toHaveLength(
      1,
    );
    expect(
      events.filter((event) => event === "ownership-release"),
    ).toHaveLength(1);
    expect(events.filter((event) => event.startsWith("remove:"))).toHaveLength(
      2,
    );
  });

  test.each([
    ["load-runtime", []],
    ["prepare-paths", ["not-ready", "remove:SIGINT", "remove:SIGTERM"]],
    ["acquire", ["not-ready", "remove:SIGINT", "remove:SIGTERM"]],
    [
      "open",
      ["not-ready", "ownership-release", "remove:SIGINT", "remove:SIGTERM"],
    ],
    [
      "migrate",
      [
        "not-ready",
        "database-close",
        "ownership-release",
        "remove:SIGINT",
        "remove:SIGTERM",
      ],
    ],
    [
      "build",
      [
        "not-ready",
        "database-close",
        "ownership-release",
        "remove:SIGINT",
        "remove:SIGTERM",
      ],
    ],
    [
      "listen",
      [
        "not-ready",
        "app-close",
        "database-close",
        "ownership-release",
        "remove:SIGINT",
        "remove:SIGTERM",
      ],
    ],
    [
      "ready",
      [
        "not-ready",
        "app-close",
        "database-close",
        "ownership-release",
        "remove:SIGINT",
        "remove:SIGTERM",
      ],
    ],
    [
      "announce",
      [
        "not-ready",
        "app-close",
        "database-close",
        "ownership-release",
        "remove:SIGINT",
        "remove:SIGTERM",
      ],
    ],
  ] as const)(
    "stops downstream work and releases only acquired resources when %s fails",
    async (phase, cleanup) => {
      const events: string[] = [];
      const fake = lifecycleFakes({ events, failAt: phase });

      await expect(
        startService(fake.paths.repositoryRoot, fake.dependencies),
      ).rejects.toBe(fake.failure);

      const expectedStartup = [
        "load-runtime",
        "install:SIGINT",
        "install:SIGTERM",
        "prepare-paths",
        "acquire",
        "open",
        "migrate",
        "build",
        "listen",
        "ready",
        "announce",
      ].slice(
        0,
        [
          "load-runtime",
          "install:SIGINT",
          "install:SIGTERM",
          "prepare-paths",
          "acquire",
          "open",
          "migrate",
          "build",
          "listen",
          "ready",
          "announce",
        ].indexOf(phase) + 1,
      );
      expect(events).toEqual([...expectedStartup, ...cleanup]);
    },
  );

  test("preserves the startup failure when every later cleanup fails", async () => {
    const events: string[] = [];
    const fake = lifecycleFakes({
      events,
      failAt: "listen",
      cleanupFailure: true,
    });

    await expect(
      startService(fake.paths.repositoryRoot, fake.dependencies),
    ).rejects.toBe(fake.failure);

    expect(events).toEqual([
      "load-runtime",
      "install:SIGINT",
      "install:SIGTERM",
      "prepare-paths",
      "acquire",
      "open",
      "migrate",
      "build",
      "listen",
      "not-ready",
      "app-close",
      "database-close",
      "ownership-release",
      "remove:SIGINT",
      "remove:SIGTERM",
    ]);
  });

  test("can restart after a migration failure releases its database and ownership", async () => {
    const events: string[] = [];
    const fake = lifecycleFakes({ events });
    const migrationFailure = new Error("first migration fails");
    let allowFirstRelease!: () => void;
    let firstReleaseStarted!: () => void;
    const firstReleaseMayComplete = new Promise<void>((resolve) => {
      allowFirstRelease = resolve;
    });
    const firstReleaseHasStarted = new Promise<void>((resolve) => {
      firstReleaseStarted = resolve;
    });
    let ownershipHeld = false;
    let firstReleaseCompleted = false;
    let acquisitions = 0;
    let migrationAttempts = 0;
    fake.dependencies.acquireOwnership = async (lockPath: string) => {
      events.push("acquire");
      expect(lockPath).toBe(fake.paths.lockPath);
      expect(ownershipHeld).toBe(false);
      acquisitions += 1;
      ownershipHeld = true;
      const acquisition = acquisitions;
      return {
        async release() {
          events.push("ownership-release");
          if (acquisition === 1) {
            firstReleaseStarted();
            await firstReleaseMayComplete;
            firstReleaseCompleted = true;
          }
          ownershipHeld = false;
        },
      };
    };
    fake.dependencies.migrateDatabase = async () => {
      events.push("migrate");
      if (migrationAttempts === 0) {
        migrationAttempts += 1;
        throw migrationFailure;
      }
      migrationAttempts += 1;
    };

    let firstSettled = false;
    const firstStart = startService(
      fake.paths.repositoryRoot,
      fake.dependencies,
    );
    void firstStart.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    await firstReleaseHasStarted;
    // Let a fire-and-forget cleanup settle the startup promise before we
    // assert that the lifecycle is genuinely waiting for release completion.
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(ownershipHeld).toBe(true);

    allowFirstRelease();
    await expect(firstStart).rejects.toBe(migrationFailure);
    expect(firstReleaseCompleted).toBe(true);
    expect(ownershipHeld).toBe(false);

    const service = await startService(
      fake.paths.repositoryRoot,
      fake.dependencies,
    );
    await service.close();
    expect(acquisitions).toBe(2);

    expect(events).toEqual([
      "load-runtime",
      "install:SIGINT",
      "install:SIGTERM",
      "prepare-paths",
      "acquire",
      "open",
      "migrate",
      "not-ready",
      "database-close",
      "ownership-release",
      "remove:SIGINT",
      "remove:SIGTERM",
      "load-runtime",
      "install:SIGINT",
      "install:SIGTERM",
      "prepare-paths",
      "acquire",
      "open",
      "migrate",
      "build",
      "listen",
      "ready",
      "announce",
      "not-ready",
      "app-close",
      "database-close",
      "ownership-release",
      "remove:SIGINT",
      "remove:SIGTERM",
    ]);
  });

  test("keeps the loopback listener, strict port parsing, and production static-web registration", async () => {
    const events: string[] = [];
    const fake = lifecycleFakes({ events });
    const previousEnvironment = process.env.NODE_ENV;
    const previousPort = process.env.WHEELSPARROW_PORT;
    try {
      process.env.NODE_ENV = "production";
      process.env.WHEELSPARROW_PORT = "8765";
      fake.dependencies.buildApp = async ({
        readiness,
        registerWeb,
      }: {
        readiness: { isReady(): boolean };
        registerWeb?: (app: unknown) => Promise<void>;
      }) => {
        events.push("build");
        expect(readiness.isReady()).toBe(false);
        await registerWeb?.({ staticTarget: true });
        return {
          async close() {
            events.push("app-close");
          },
          async listen(options: { host: string; port: number }) {
            events.push("listen");
            expect(options).toEqual({ host: "127.0.0.1", port: 8765 });
            return "http://127.0.0.1:8765";
          },
        };
      };
      fake.dependencies.registerWeb = async (
        app: unknown,
        directory: string,
      ) => {
        expect(app).toEqual({ staticTarget: true });
        expect(directory).toBe(resolve(import.meta.dirname, "../../web/dist"));
        events.push("register-web");
      };
      const service = await startService(
        fake.paths.repositoryRoot,
        fake.dependencies,
      );
      await service.close();
      expect(events).toContain("register-web");
    } finally {
      if (previousEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnvironment;
      if (previousPort === undefined) delete process.env.WHEELSPARROW_PORT;
      else process.env.WHEELSPARROW_PORT = previousPort;
    }
  });

  test.each(["", "-1", "1.2", "65536", "NaN", " 4321"])(
    "rejects an invalid WHEELSPARROW_PORT of %j",
    (value) => {
      expect(() => parsePort(value)).toThrow(
        "WHEELSPARROW_PORT must be an integer between 0 and 65535",
      );
    },
  );
});
