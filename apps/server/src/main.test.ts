import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Configuration } from "@wheelsparrow/contracts";
import { afterEach, describe, expect, test } from "vitest";
import {
  FakeGitHubDeliveryGateway,
  FakeGitHubProjectGateway,
} from "../../../tests/fakes/github.js";
import type { LocalPaths } from "./config.js";
import type { DatabaseConnection } from "./database/connection.js";
import { openDatabase } from "./database/connection.js";
import { migrateDatabase } from "./database/migrate.js";
import { createRunMutationRepository, readRun } from "./database/runs.js";
import type { MergeCandidateReceipt } from "./github/delivery.js";
import type { GitHubProjectGateway, ProjectItem } from "./github/project.js";
import { GitHubCredentialsUnavailableError } from "./github/project-client.js";
import {
  createProductionCoordinator,
  createProductionDoneProjectResolver,
  createProductionReadyDiscovery,
  createProductionSmokeEnvironment,
  parsePort,
  type RunningService,
  resolveMigrationsDirectory,
  resolveRuntimeDependencies,
  type StartDependencies,
  start,
  startService,
} from "./main.js";
import { claimNextEligible } from "./workflow/claim.js";

const temporaryDirectories: string[] = [];
const temporaryConnections: ReturnType<typeof openDatabase>[] = [];

const productionConfiguration: Configuration = {
  github: {
    owner: "owner",
    repository: "repository",
    project_number: 1,
    status_field: "Status",
    lanes: { ready: "Ready", todo: "Todo", review: "Review", done: "Done" },
    required_labels: ["mvp"],
    priority_field: "Priority",
  },
  poll_interval_seconds: 30,
  workspace_root: ".wheelsparrow/workspaces",
  agent: {
    command: "codex",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    timeout_minutes: 30,
  },
  verification: { command: "pnpm test" },
  staging: {
    workflow: "deploy.yml",
    environment: "staging",
    smoke_command: "pnpm smoke",
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryConnections.splice(0).map((connection) => connection.close()),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const migrationSource = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);

async function createMainCompositionDatabase(): Promise<
  ReturnType<typeof openDatabase>
> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-main-compose-"));
  temporaryDirectories.push(directory);
  const migrationsDirectory = join(directory, "migrations");
  await cp(migrationSource, migrationsDirectory, { recursive: true });
  const connection = openDatabase(join(directory, "wheelsparrow.sqlite3"));
  migrateDatabase(connection, migrationsDirectory);
  temporaryConnections.push(connection);
  return connection;
}

const mergeBaseSha = "a".repeat(40);
const mergeHeadSha = "b".repeat(40);

function mergeCandidate(): MergeCandidateReceipt {
  return {
    repository: "owner/repository",
    number: 7,
    issueNumber: 42,
    nodeId: "PR_node_7",
    isDraft: false,
    title: "Merge the exact approved candidate",
    baseBranch: "main",
    baseSha: mergeBaseSha,
    headBranch: "ticket/42",
    headSha: mergeHeadSha,
    requiredChecks: {
      repository: "owner/repository",
      number: 7,
      nodeId: "PR_node_7",
      headSha: mergeHeadSha,
      requiredCheckNames: ["test"],
      requiredChecks: [{ name: "test", state: "success" }],
      headDrift: false,
      aggregate: "green",
    },
    threads: [],
    mergeability: "mergeable",
    permittedMergeMethods: ["squash"],
  };
}

async function enterCompositionReview(
  connection: ReturnType<typeof openDatabase>,
  coordinator: {
    createClaim: (input: {
      id: string;
      repository: string;
      projectItemId: string;
      issueNodeId: string;
      issueNumber: number;
      ownerToken: string;
      at: string;
      summary: { text: string };
    }) => Promise<unknown>;
    transition: (request: {
      runId: string;
      expectedRevision: number;
      trigger:
        | "todo_observed"
        | "workspace_prepared"
        | "intake_captured"
        | "builder_succeeded"
        | "verification_passed"
        | "review_approved"
        | "pr_observed"
        | "ci_passed";
      at: string;
      summary: { text: string };
    }) => Promise<unknown>;
  },
) {
  const runId = "main-composition-run";
  const at = "2026-08-10T10:00:00.000Z";
  await coordinator.createClaim({
    id: runId,
    repository: "owner/repository",
    projectItemId: "PVTI_42",
    issueNodeId: "I_42",
    issueNumber: 42,
    ownerToken: "main-composition-owner",
    at,
    summary: { text: "Composition test run." },
  });
  let run = await readRun(connection.db, runId);
  run = await connection.db.transaction().execute((tx) =>
    createRunMutationRepository(tx).updateExecutionFacts({
      runId,
      expectedRevision: run.revision,
      facts: {
        worktreePath: "/safe/worktree",
        baseSha: mergeBaseSha,
        branch: "ticket/42",
        headSha: mergeHeadSha,
      },
      at,
    }),
  );
  run = await connection.db.transaction().execute((tx) =>
    createRunMutationRepository(tx).updatePublicationFacts({
      runId,
      expectedRevision: run.revision,
      facts: {
        pullRequestNumber: 7,
        pullRequestNodeId: "PR_node_7",
        pullRequestTitle: mergeCandidate().title,
        pullRequestUrl: "https://github.com/owner/repository/pull/7",
        baseSha: mergeBaseSha,
        headSha: mergeHeadSha,
        branch: "ticket/42",
      },
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
    run = (await coordinator.transition({
      runId,
      expectedRevision: run.revision,
      trigger,
      at,
      summary: { text: `${trigger}.` },
    })) as typeof run;
  }
  for (const trigger of ["pr_observed", "ci_passed"] as const) {
    run = (await coordinator.transition({
      runId,
      expectedRevision: run.revision,
      trigger,
      at,
      summary: { text: `${trigger}.` },
    })) as typeof run;
  }
  return run;
}

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

type InterruptiblePhase = "acquire" | "open" | "migrate" | "build" | "listen";

function lifecycleFakes({
  events,
  failAt,
  cleanupFailure,
  pauseAt,
}: {
  events: string[];
  failAt?: Phase;
  cleanupFailure?: boolean;
  pauseAt?: InterruptiblePhase;
}) {
  const paths = localPaths();
  const failure = new Error(`failed at ${failAt}`);
  const fail = (phase: Phase): void => {
    events.push(phase);
    if (phase === failAt) throw failure;
  };
  let resumePausedPhase!: () => void;
  let pausedPhaseStarted!: () => void;
  const pausedPhaseMayComplete = new Promise<void>((resolve) => {
    resumePausedPhase = resolve;
  });
  const pausedPhaseHasStarted = new Promise<void>((resolve) => {
    pausedPhaseStarted = resolve;
  });
  const pause = async (phase: InterruptiblePhase): Promise<void> => {
    if (phase !== pauseAt) return;
    pausedPhaseStarted();
    await pausedPhaseMayComplete;
  };
  const listeners = new Map<string, () => void | Promise<void>>();
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
      await pause("listen");
      return "http://127.0.0.1:4321";
    },
  };
  let registerWeb: StartDependencies["registerWeb"];

  const dependencies = {
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
      await pause("acquire");
      return ownership;
    },
    async openDatabase(databasePath: string) {
      fail("open");
      expect(databasePath).toBe(paths.databasePath);
      await pause("open");
      return database;
    },
    async migrateDatabase(actualDatabase: typeof database, directory: string) {
      fail("migrate");
      expect(actualDatabase).toBe(database);
      expect(directory).toBe(
        resolve(import.meta.dirname, "../../../migrations"),
      );
      await pause("migrate");
    },
    async buildApp({ readiness }: { readiness: { isReady(): boolean } }) {
      fail("build");
      expect(readiness.isReady()).toBe(false);
      await pause("build");
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
    registerWeb,
    signalTarget,
    createCoordinator: undefined as StartDependencies["createCoordinator"],
    reconcileEffects: undefined as StartDependencies["reconcileEffects"],
    createScheduler: undefined as StartDependencies["createScheduler"],
  } satisfies StartDependencies;
  return {
    paths,
    events,
    failure,
    signalTarget,
    async emitSignal(signal: "SIGINT" | "SIGTERM") {
      const listener = listeners.get(signal);
      expect(listener).toBeDefined();
      await listener?.();
    },
    pausedPhaseHasStarted,
    resumePausedPhase,
    dependencies,
  };
}

describe("start", () => {
  test("uses a credential-free dependency set only for explicit local smoke", () => {
    const production = resolveRuntimeDependencies({});
    const localSmoke = resolveRuntimeDependencies({
      WHEELSPARROW_LOCAL_SMOKE: "1",
    });

    expect(production.createCoordinator).toBeDefined();
    expect(production.reconcileEffects).toBeDefined();
    expect(production.createScheduler).toBeDefined();
    expect(production.registerOperator).toBeDefined();
    expect(localSmoke.createCoordinator).toBeUndefined();
    expect(localSmoke.reconcileEffects).toBeUndefined();
    expect(localSmoke.createScheduler).toBeUndefined();
    expect(localSmoke.registerOperator).toBeUndefined();
  });

  test("resolves Project Done facts from the current matching Review item", async () => {
    const item: ProjectItem = {
      projectItemId: "PVTI_42",
      projectId: "PVT_1",
      projectNumber: 1,
      repository: "owner/repository",
      issueNodeId: "I_42",
      issueNumber: 42,
      isOpen: true,
      status: productionConfiguration.github.lanes.review,
      revision: "revision-7",
      labels: ["mvp"],
      createdAt: "2026-08-10T09:00:00.000Z",
      dependencies: [],
    };
    const projectGateway: GitHubProjectGateway = {
      readProject: async () => {
        throw new Error("not used");
      },
      readProjectItem: async (projectItemId) =>
        projectItemId === item.projectItemId ? item : undefined,
      moveProjectItem: async () => {
        throw new Error("not used");
      },
    };
    const resolveDoneProject = createProductionDoneProjectResolver(
      projectGateway,
      productionConfiguration,
    );

    await expect(
      resolveDoneProject({
        repository: item.repository,
        projectItemId: item.projectItemId,
        issueNodeId: item.issueNodeId,
        issueNumber: item.issueNumber,
      }),
    ).resolves.toEqual({
      projectId: item.projectId,
      projectNumber: item.projectNumber,
      expectedProjectRevision: item.revision,
    });
  });

  test("rejects a Project Done resolver read outside the current Review lane", async () => {
    const projectGateway: GitHubProjectGateway = {
      readProject: async () => {
        throw new Error("not used");
      },
      readProjectItem: async () => ({
        projectItemId: "PVTI_42",
        projectId: "PVT_1",
        projectNumber: 1,
        repository: "owner/repository",
        issueNodeId: "I_42",
        issueNumber: 42,
        isOpen: true,
        status: productionConfiguration.github.lanes.done,
        revision: "revision-8",
        labels: ["mvp"],
        createdAt: "2026-08-10T09:00:00.000Z",
        dependencies: [],
      }),
      moveProjectItem: async () => {
        throw new Error("not used");
      },
    };
    const resolveDoneProject = createProductionDoneProjectResolver(
      projectGateway,
      productionConfiguration,
    );

    await expect(
      resolveDoneProject({
        repository: "owner/repository",
        projectItemId: "PVTI_42",
        issueNodeId: "I_42",
        issueNumber: 42,
      }),
    ).rejects.toThrow("does not match the durable run");
  });

  test("projects PATH but no credentials into the production smoke environment", () => {
    const environment = createProductionSmokeEnvironment({
      PATH: "/safe/bin",
      HOME: "/home/operator",
      GITHUB_TOKEN: "ghp_secret",
      GH_TOKEN: "gho_secret",
      NODE_OPTIONS: "--require=secret-module",
    });

    expect(environment).toEqual({ PATH: "/safe/bin" });
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
  });

  test("composes production delivery adapters that dispatch an approved merge to the gateway", async () => {
    const connection = await createMainCompositionDatabase();
    const gateway = new FakeGitHubDeliveryGateway({
      repository: "owner/repository",
      requiredChecks: ["test"],
      staging: {
        workflow: productionConfiguration.staging.workflow,
        environment: productionConfiguration.staging.environment,
      },
    });
    gateway.seedPullRequest(mergeCandidate());
    const coordinator = createProductionCoordinator(
      connection,
      productionConfiguration,
      {
        deliveryGateway: gateway,
        smokeRunner: {
          run: async () => {
            throw new Error("smoke must not run during merge dispatch");
          },
        },
      },
    );

    try {
      const review = await enterCompositionReview(connection, coordinator);
      const approval = await coordinator.approveMerge({
        runId: review.id,
        expectedRevision: review.revision,
        operator: "operator@example.test",
        approvedHeadSha: mergeHeadSha,
        observedBaseSha: mergeBaseSha,
        dispatch: false,
        at: "2026-08-10T10:00:00.000Z",
      });
      const settled = coordinator.waitForEffectSettlement(
        approval.effect.key,
        1_000,
      );
      await coordinator.beginEffect({
        effectKey: approval.effect.key,
        expectedRevision: approval.run.revision,
        at: "2026-08-10T10:00:00.000Z",
      });

      const effect = await settled;
      expect(effect.status).toBe("confirmed");
      expect(gateway.mergeMutations()).toHaveLength(1);
      expect(gateway.mergeMutations()[0]?.request.expectedHeadSha).toBe(
        mergeHeadSha,
      );
    } finally {
      await coordinator.close();
    }
  });

  test("composes the Project Todo capability used by the production scheduler", async () => {
    const connection = await createMainCompositionDatabase();
    const projectGateway = new FakeGitHubProjectGateway({
      projectId: "PVT_1",
      projectNumber: 1,
      repository: "owner/repository",
      items: [
        {
          projectItemId: "PVTI_42",
          projectId: "PVT_1",
          projectNumber: 1,
          repository: "owner/repository",
          issueNodeId: "I_42",
          issueNumber: 42,
          isOpen: true,
          status: productionConfiguration.github.lanes.ready,
          revision: "revision-1",
          labels: ["mvp"],
          createdAt: "2026-08-10T09:00:00.000Z",
          dependencies: [],
        },
      ],
    });
    const deliveryGateway = new FakeGitHubDeliveryGateway({
      repository: "owner/repository",
      requiredChecks: ["test"],
      staging: {
        workflow: productionConfiguration.staging.workflow,
        environment: productionConfiguration.staging.environment,
      },
    });
    const coordinator = createProductionCoordinator(
      connection,
      productionConfiguration,
      {
        projectGateway,
        projectId: "PVT_1",
        deliveryGateway,
        smokeRunner: {
          run: async () => ({ outcome: "passed" }),
        },
      },
    );

    try {
      const outcome = await claimNextEligible({
        connection,
        coordinator,
        gateway: projectGateway,
        configuration: {
          projectId: "PVT_1",
          projectNumber: 1,
          repository: "owner/repository",
          readyStatus: productionConfiguration.github.lanes.ready,
          todoStatus: productionConfiguration.github.lanes.todo,
          requiredLabels: productionConfiguration.github.required_labels,
        },
        ownerToken: "scheduler-owner",
        now: () => "2026-08-10T10:00:00.000Z",
        runId: () => "scheduler-run-42",
      });

      expect(outcome.kind).toBe("claimed");
      expect(projectGateway.mutations()).toHaveLength(1);
      expect(
        (
          coordinator as typeof coordinator & {
            productionExecution?: unknown;
            productionReviewPublication?: unknown;
          }
        ).productionExecution,
      ).toBeDefined();
      expect(
        (
          coordinator as typeof coordinator & {
            productionReviewPublication?: unknown;
          }
        ).productionReviewPublication,
      ).toBeDefined();
      await expect(
        readRun(connection.db, "scheduler-run-42"),
      ).resolves.toMatchObject({
        state: "preparing",
      });
    } finally {
      await coordinator.close();
    }
  });

  test("composes a credential-backed discovery callback that fails closed without credentials", async () => {
    let fetchCalls = 0;
    const discoverReady = createProductionReadyDiscovery({
      connection: {} as DatabaseConnection,
      configuration: productionConfiguration,
      token: "",
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("the provider must not be reached without credentials");
      },
    });

    await expect(discoverReady()).rejects.toBeInstanceOf(
      GitHubCredentialsUnavailableError,
    );
    expect(fetchCalls).toBe(0);
  });

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

  test("reconciles after migration and closes the coordinator before app resources", async () => {
    const events: string[] = [];
    const fake = lifecycleFakes({ events });
    const coordinator = {
      async close() {
        events.push("coordinator-close");
      },
    };
    fake.dependencies.createCoordinator = (database) => {
      events.push("coordinator");
      expect(database).toBeDefined();
      return coordinator;
    };
    fake.dependencies.reconcileEffects = (database, actualCoordinator) => {
      events.push("reconcile");
      expect(database).toBeDefined();
      expect(actualCoordinator).toBe(coordinator);
    };

    const service = await startService(
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
      "coordinator",
      "reconcile",
      "build",
      "listen",
      "ready",
      "announce",
    ]);

    await service.close();

    expect(events.slice(-7)).toEqual([
      "not-ready",
      "coordinator-close",
      "app-close",
      "database-close",
      "ownership-release",
      "remove:SIGINT",
      "remove:SIGTERM",
    ]);
  });

  test("starts polling only after reconciliation and stops it before the coordinator", async () => {
    const events: string[] = [];
    const fake = lifecycleFakes({ events });
    const coordinator = {
      async close() {
        events.push("coordinator-close");
      },
    };
    fake.dependencies.createCoordinator = () => {
      events.push("coordinator");
      return coordinator;
    };
    fake.dependencies.reconcileEffects = () => {
      events.push("reconcile");
    };
    fake.dependencies.createScheduler = () => {
      events.push("scheduler");
      return {
        async start() {
          events.push("scheduler-start");
        },
        async stop() {
          events.push("scheduler-stop");
        },
        async tick() {
          events.push("scheduler-tick");
        },
      };
    };

    const service = await startService(
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
      "coordinator",
      "reconcile",
      "scheduler",
      "build",
      "listen",
      "ready",
      "scheduler-start",
      "announce",
    ]);

    await service.close();
    expect(events.slice(-8)).toEqual([
      "not-ready",
      "scheduler-stop",
      "coordinator-close",
      "app-close",
      "database-close",
      "ownership-release",
      "remove:SIGINT",
      "remove:SIGTERM",
    ]);
  });

  test("fails closed before building the listener when reconciliation lacks an adapter", async () => {
    const events: string[] = [];
    const fake = lifecycleFakes({ events });
    const reconciliationFailure = new Error(
      "Startup reconciliation requires a dispatcher",
    );
    const coordinator = {
      async close() {
        events.push("coordinator-close");
      },
    };
    fake.dependencies.createCoordinator = () => {
      events.push("coordinator");
      return coordinator;
    };
    fake.dependencies.reconcileEffects = () => {
      events.push("reconcile");
      throw reconciliationFailure;
    };

    await expect(
      startService(fake.paths.repositoryRoot, fake.dependencies),
    ).rejects.toBe(reconciliationFailure);

    expect(events).toEqual([
      "load-runtime",
      "install:SIGINT",
      "install:SIGTERM",
      "prepare-paths",
      "acquire",
      "open",
      "migrate",
      "coordinator",
      "reconcile",
      "not-ready",
      "coordinator-close",
      "database-close",
      "ownership-release",
      "remove:SIGINT",
      "remove:SIGTERM",
    ]);
  });

  test("rejects a partial coordinator seam before constructing or building", async () => {
    const events: string[] = [];
    const fake = lifecycleFakes({ events });
    let createCalls = 0;
    fake.dependencies.createCoordinator = () => {
      createCalls += 1;
      events.push("coordinator");
      return {
        async close() {
          events.push("coordinator-close");
        },
      };
    };

    await expect(
      startService(fake.paths.repositoryRoot, fake.dependencies),
    ).rejects.toThrow(
      "Coordinator and reconciliation dependencies must be provided together",
    );

    expect(createCalls).toBe(0);
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
    ]);
  });

  test("removes an installed SIGINT handler when SIGTERM registration fails", async () => {
    const events: string[] = [];
    const fake = lifecycleFakes({ events });
    const registrationFailure = new Error("SIGTERM registration failed");
    const originalSignalTarget = fake.dependencies.signalTarget;
    fake.dependencies.signalTarget = {
      once(signal, listener) {
        if (signal === "SIGTERM") {
          events.push("install:SIGTERM");
          throw registrationFailure;
        }
        originalSignalTarget.once(signal, listener);
      },
      removeListener: originalSignalTarget.removeListener,
    };

    await expect(
      startService(fake.paths.repositoryRoot, fake.dependencies),
    ).rejects.toBe(registrationFailure);

    expect(events).toEqual([
      "load-runtime",
      "install:SIGINT",
      "install:SIGTERM",
      "not-ready",
      "remove:SIGINT",
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
    [
      "SIGINT",
      "acquire",
      ["not-ready", "ownership-release", "remove:SIGINT", "remove:SIGTERM"],
    ],
    [
      "SIGTERM",
      "open",
      [
        "not-ready",
        "database-close",
        "ownership-release",
        "remove:SIGINT",
        "remove:SIGTERM",
      ],
    ],
    [
      "SIGINT",
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
      "SIGTERM",
      "build",
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
      "SIGINT",
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
  ] as const)(
    "defers %s shutdown cleanup until the pending %s phase settles",
    async (signal, phase, cleanup) => {
      const events: string[] = [];
      const fake = lifecycleFakes({ events, pauseAt: phase });
      const startup = startService(
        fake.paths.repositoryRoot,
        fake.dependencies,
      );
      await fake.pausedPhaseHasStarted;

      let signalSettled = false;
      const signalCompletion = fake.emitSignal(signal);
      void signalCompletion.then(
        () => {
          signalSettled = true;
        },
        () => {
          signalSettled = true;
        },
      );
      let preReleaseFailure: unknown;
      try {
        await Promise.resolve();

        expect(signalSettled).toBe(false);
        expect(events).not.toContain("not-ready");
        expect(events).not.toContain("app-close");
        expect(events).not.toContain("database-close");
        expect(events).not.toContain("ownership-release");
      } catch (error) {
        preReleaseFailure = error;
      } finally {
        fake.resumePausedPhase();
      }

      await expect(startup).rejects.toMatchObject({
        name: "ShutdownRequestedError",
        message: "startup interrupted by shutdown signal",
      });
      await signalCompletion;

      if (preReleaseFailure !== undefined) throw preReleaseFailure;

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
      ].slice(
        0,
        ["acquire", "open", "migrate", "build", "listen"].indexOf(phase) + 5,
      );
      expect(events).toEqual([...expectedStartup, ...cleanup]);
    },
  );

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
      fake.dependencies.announce = (url: string) => {
        events.push("announce");
        expect(url).toBe("http://127.0.0.1:8765");
      };
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
