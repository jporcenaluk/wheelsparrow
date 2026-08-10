import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  type Configuration,
  ConfigurationSchema,
} from "@wheelsparrow/contracts";
import type { FastifyInstance } from "fastify";
import { Value } from "typebox/value";

import { buildApp } from "./app.js";
import {
  type LocalPaths,
  loadRuntimeConfiguration,
  prepareLocalPaths,
} from "./config.js";
import type { DatabaseConnection } from "./database/connection.js";
import { openDatabase } from "./database/connection.js";
import type { EffectRecord } from "./database/effects.js";
import { migrateDatabase } from "./database/migrate.js";
import { acquireOwnership } from "./database/ownership.js";
import {
  type RunRecord,
  readRun,
  readSchedulerControl,
} from "./database/runs.js";
import type { GitHubDeliveryGateway } from "./github/delivery.js";
import { GitHubDeliveryClient } from "./github/delivery-client.js";
import type { GitHubProjectGateway } from "./github/project.js";
import {
  createGitHubProjectGateway,
  type GitHubProjectClientOptions,
  githubTokenFromEnvironment,
} from "./github/project-client.js";
import { registerOperatorRoutes } from "./http/routes.js";
import { createReadinessGate, type ReadinessGate } from "./readiness.js";
import { registerWeb } from "./web.js";
import {
  type ClaimConfiguration,
  claimNextEligible,
  createProjectTodoCapability,
} from "./workflow/claim.js";
import type {
  EffectCompletion,
  EffectDispatcherLike,
  EffectObserverLike,
} from "./workflow/coordinator.js";
import { WorkflowCoordinator } from "./workflow/coordinator.js";
import {
  createDeliveryCapability,
  createSafeSmokeRunner,
  type SmokeRunner,
} from "./workflow/delivery.js";
import { discoverReadyQueue } from "./workflow/operator-discovery.js";
import {
  createGitHubIssueReader,
  createProductionExecution,
  type ProductionExecutionRuntime,
  type ProductionIssueReader,
} from "./workflow/production-execution.js";
import {
  createProductionReviewPublication,
  type ProductionReviewPublicationRuntime,
} from "./workflow/production-review-publication.js";
import {
  createProductionScheduler,
  type ProductionScheduler,
} from "./workflow/production-scheduler.js";
import { reconcileEffects } from "./workflow/reconciliation.js";

interface Ownership {
  release(): Promise<void>;
}

interface Database {
  close(): Promise<void>;
}

export interface Coordinator {
  close(): Promise<void>;
  productionExecution?: ProductionExecutionRuntime;
  productionReviewPublication?: ProductionReviewPublicationRuntime;
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
  ): Promise<{ paths: LocalPaths; configuration?: unknown }>;
  prepareLocalPaths(paths: LocalPaths): Promise<LocalPaths>;
  acquireOwnership(lockPath: string): Promise<Ownership>;
  openDatabase(databasePath: string): Database | Promise<Database>;
  migrateDatabase(database: Database, directory: string): void | Promise<void>;
  /** Construct and recover the workflow coordinator after migrations. */
  createCoordinator?:
    | ((
        database: Database,
        configuration: unknown,
        repositoryRoot: string,
      ) => Coordinator | Promise<Coordinator>)
    | undefined;
  reconcileEffects?:
    | ((database: Database, coordinator: Coordinator) => void | Promise<void>)
    | undefined;
  createScheduler?:
    | ((
        database: Database,
        coordinator: Coordinator,
        configuration: unknown,
        repositoryRoot: string,
      ) => ProductionScheduler | Promise<ProductionScheduler>)
    | undefined;
  buildApp(options: {
    readiness: ReadinessGate;
    registerOperator?: (app: FastifyInstance) => Promise<void>;
    registerWeb?: (app: FastifyInstance) => Promise<void>;
  }): Promise<Application>;
  createReadinessGate(): ReadinessGate;
  announce(url: string): void;
  signalTarget: SignalTarget;
  registerWeb?:
    | ((app: FastifyInstance, directory: string) => Promise<void>)
    | undefined;
  registerOperator?:
    | ((
        app: FastifyInstance,
        context: {
          database: Database;
          coordinator: Coordinator;
          configuration: unknown;
        },
      ) => Promise<void>)
    | undefined;
}

export interface ProductionDiscoveryOptions {
  readonly connection: DatabaseConnection;
  readonly configuration: Configuration;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoint?: string;
}

export interface ProductionCoordinatorOptions {
  /** The repository root is the fixed working directory for smoke commands. */
  readonly repositoryRoot?: string;
  /** Optional seams are intentionally limited to deterministic composition tests. */
  readonly projectGateway?: GitHubProjectGateway;
  /** The configured Project ID, resolved during production startup. */
  readonly projectId?: string;
  /** Optional issue source seam for deterministic composition tests. */
  readonly issueReader?: ProductionIssueReader;
  readonly deliveryGateway?: GitHubDeliveryGateway;
  readonly smokeRunner?: SmokeRunner;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoint?: string;
  readonly restEndpoint?: string;
}

function dispatchEffectAdapter(
  adapter: EffectDispatcherLike,
  effect: EffectRecord,
  complete: EffectCompletion,
): unknown {
  return typeof adapter === "function"
    ? adapter(effect, complete)
    : adapter.dispatch(effect, complete);
}

function observeEffectAdapter(
  adapter: EffectObserverLike,
  effect: EffectRecord,
  complete: EffectCompletion,
): unknown {
  return typeof adapter === "function"
    ? adapter(effect, complete)
    : adapter.observe(effect, complete);
}

/**
 * Return only executable lookup variables for smoke processes. Credentials,
 * configuration overrides, and runtime flags must never cross this boundary.
 */
export function createProductionSmokeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const projected: Record<string, string> = {};
  const pathValue = environment.PATH ?? environment.Path;
  if (typeof pathValue === "string" && pathValue.trim().length > 0)
    projected.PATH = pathValue;
  if (process.platform === "win32") {
    for (const key of ["PATHEXT", "SystemRoot", "SYSTEMROOT"] as const) {
      const value = environment[key];
      if (typeof value === "string" && value.trim().length > 0)
        projected[key] = value;
    }
  }
  return projected;
}

type DoneProjectRunFacts = Pick<
  RunRecord,
  "repository" | "projectItemId" | "issueNodeId" | "issueNumber"
>;

export interface ResolvedDoneProject {
  readonly projectId: string;
  readonly projectNumber: number;
  readonly expectedProjectRevision: string;
}

/** Resolve the current Review item immediately before scheduling Project Done. */
export function createProductionDoneProjectResolver(
  gateway: GitHubProjectGateway,
  configuration: Configuration,
): (run: DoneProjectRunFacts) => Promise<ResolvedDoneProject> {
  const validated = requireConfiguration(configuration);
  return async (run) => {
    let item: Awaited<ReturnType<GitHubProjectGateway["readProjectItem"]>>;
    try {
      item = await gateway.readProjectItem(run.projectItemId);
    } catch {
      throw new Error("The current Review project item could not be read.");
    }
    if (
      item === undefined ||
      item.projectItemId !== run.projectItemId ||
      item.projectNumber !== validated.github.project_number ||
      item.repository !== run.repository ||
      item.issueNodeId !== run.issueNodeId ||
      item.issueNumber !== run.issueNumber ||
      item.status !== validated.github.lanes.review ||
      item.projectId.trim().length === 0 ||
      item.revision.trim().length === 0
    ) {
      throw new Error(
        "The current Review project item does not match the durable run.",
      );
    }
    return {
      projectId: item.projectId,
      projectNumber: item.projectNumber,
      expectedProjectRevision: item.revision,
    };
  };
}

function requireConfiguration(value: unknown): Configuration {
  if (!Value.Check(ConfigurationSchema, value)) {
    throw new Error("Validated runtime configuration is unavailable.");
  }
  return value as Configuration;
}

/**
 * Compose the production read-only Ready queue from configured GitHub scope,
 * existing credentials, and the durable ownership query. The returned
 * callback deliberately performs no work until the operator reads Queue.
 */
export function createProductionReadyDiscovery(
  options: ProductionDiscoveryOptions,
): () => ReturnType<typeof discoverReadyQueue> {
  const configuredRepository = options.configuration.github.repository.includes(
    "/",
  )
    ? options.configuration.github.repository
    : `${options.configuration.github.owner}/${options.configuration.github.repository}`;
  const clientOptions: GitHubProjectClientOptions = {
    owner: options.configuration.github.owner,
    repository: configuredRepository,
    projectNumber: options.configuration.github.project_number,
    statusField: options.configuration.github.status_field,
    readyStatus: options.configuration.github.lanes.ready,
    requiredLabels: options.configuration.github.required_labels,
    priorityField: options.configuration.github.priority_field,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
  };
  const gateway = createGitHubProjectGateway(clientOptions);
  return () =>
    discoverReadyQueue({
      connection: options.connection,
      gateway,
      configuration: {
        repository: clientOptions.repository,
        projectNumber: clientOptions.projectNumber,
        readyStatus: clientOptions.readyStatus,
        requiredLabels: clientOptions.requiredLabels,
      },
    });
}

/**
 * Compose the production coordinator with both external delivery adapters.
 * Runtime configuration is checked again at this boundary so callers cannot
 * accidentally construct a delivery capability from an unvalidated object.
 */
export function createProductionCoordinator(
  connection: DatabaseConnection,
  configuration: Configuration,
  options: ProductionCoordinatorOptions = {},
): Coordinator & WorkflowCoordinator {
  const validated = requireConfiguration(configuration);
  const repository = validated.github.repository.includes("/")
    ? validated.github.repository
    : `${validated.github.owner}/${validated.github.repository}`;
  const token = options.token ?? githubTokenFromEnvironment();
  const projectGateway =
    options.projectGateway ??
    createGitHubProjectGateway({
      owner: validated.github.owner,
      repository,
      projectNumber: validated.github.project_number,
      statusField: validated.github.status_field,
      readyStatus: validated.github.lanes.ready,
      requiredLabels: validated.github.required_labels,
      priorityField: validated.github.priority_field,
      ...(token === undefined ? {} : { token }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    });
  const deliveryGateway =
    options.deliveryGateway ??
    new GitHubDeliveryClient({
      owner: validated.github.owner,
      repository,
      ...(token === undefined ? {} : { token }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.restEndpoint === undefined
        ? {}
        : { restEndpoint: options.restEndpoint }),
      projectGateway,
    });
  const deliveryConfiguration = {
    workflow: validated.staging.workflow,
    environment: validated.staging.environment,
    smokeCommand: validated.staging.smoke_command,
    projectNumber: validated.github.project_number,
    reviewStatus: validated.github.lanes.review,
    doneStatus: validated.github.lanes.done,
    resolveDoneProject: createProductionDoneProjectResolver(
      projectGateway,
      validated,
    ),
  };
  const smokeRunner =
    options.smokeRunner ??
    createSafeSmokeRunner({
      cwd: options.repositoryRoot ?? process.cwd(),
      env: createProductionSmokeEnvironment(),
    });
  const capability = createDeliveryCapability(
    deliveryGateway,
    deliveryConfiguration,
    smokeRunner,
    {
      resolveRun: (effect) => {
        if (effect.runId.trim().length === 0)
          throw new Error("Durable delivery effect has no run ID.");
        return readRun(connection.db, effect.runId);
      },
    },
  );
  const projectTodoCapability =
    options.projectId === undefined
      ? undefined
      : createProjectTodoCapability(projectGateway, {
          projectId: options.projectId,
          projectNumber: validated.github.project_number,
          repository,
          readyStatus: validated.github.lanes.ready,
          todoStatus: validated.github.lanes.todo,
          requiredLabels: validated.github.required_labels,
        } satisfies ClaimConfiguration);
  let coordinator!: Coordinator & WorkflowCoordinator;
  const productionExecution =
    options.projectId === undefined
      ? undefined
      : createProductionExecution({
          connection,
          coordinator: () => coordinator,
          configuration: validated,
          repositoryRoot: options.repositoryRoot ?? process.cwd(),
          projectGateway,
          projectId: options.projectId,
          issueReader:
            options.issueReader ??
            createGitHubIssueReader({
              owner: validated.github.owner,
              repository,
              ...(token === undefined ? {} : { token }),
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
              ...(options.restEndpoint === undefined
                ? {}
                : { endpoint: options.restEndpoint }),
            }),
        });
  const productionReviewPublication =
    productionExecution === undefined
      ? undefined
      : createProductionReviewPublication({
          connection,
          coordinator: () => coordinator,
          configuration: validated,
          repositoryRoot: options.repositoryRoot ?? process.cwd(),
          workspaceInspect: productionExecution.workspaceInspect,
          verify: productionExecution.verify,
          ...(options.token === undefined ? {} : { token: options.token }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.restEndpoint === undefined
            ? {}
            : { restEndpoint: options.restEndpoint }),
        });
  const executionKinds = new Set([
    "workspace_prepare",
    "intake_capture",
    "agent_build",
    "verify",
  ]);
  const reviewPublicationKinds = new Set([
    "agent_review",
    "agent_repair",
    "publish",
    "observe_ci",
  ]);
  const dispatcher: EffectDispatcherLike = (effect, complete) => {
    if (effect.kind === "project_todo" && projectTodoCapability !== undefined)
      return dispatchEffectAdapter(
        projectTodoCapability.dispatcher,
        effect,
        complete,
      );
    if (productionExecution !== undefined && executionKinds.has(effect.kind))
      return dispatchEffectAdapter(
        productionExecution.capability.dispatcher,
        effect,
        complete,
      );
    if (
      productionReviewPublication !== undefined &&
      reviewPublicationKinds.has(effect.kind)
    )
      return dispatchEffectAdapter(
        productionReviewPublication.capability.dispatcher,
        effect,
        complete,
      );
    return dispatchEffectAdapter(capability.dispatcher, effect, complete);
  };
  const observer: EffectObserverLike = (effect, complete) => {
    if (effect.kind === "project_todo" && projectTodoCapability !== undefined)
      return observeEffectAdapter(
        projectTodoCapability.observer,
        effect,
        complete,
      );
    if (productionExecution !== undefined && executionKinds.has(effect.kind))
      return observeEffectAdapter(
        productionExecution.capability.observer,
        effect,
        complete,
      );
    if (
      productionReviewPublication !== undefined &&
      reviewPublicationKinds.has(effect.kind)
    )
      return observeEffectAdapter(
        productionReviewPublication.capability.observer,
        effect,
        complete,
      );
    return observeEffectAdapter(capability.observer, effect, complete);
  };
  coordinator = new WorkflowCoordinator({
    connection,
    dispatcher,
    observer,
  });
  if (productionExecution !== undefined)
    coordinator.productionExecution = productionExecution;
  if (productionReviewPublication !== undefined)
    coordinator.productionReviewPublication = productionReviewPublication;
  return coordinator;
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
  let coordinator: Coordinator | undefined;
  let scheduler: ProductionScheduler | undefined;
  let app: Application | undefined;
  let sigintHandlerInstalled = false;
  let sigtermHandlerInstalled = false;
  let shutdownRequested = false;
  let runtimeConfiguration: unknown;
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

      if (
        (sigintHandlerInstalled || sigtermHandlerInstalled) &&
        readiness !== undefined
      ) {
        await attempt(() => readiness?.markNotReady());
      }
      if (scheduler !== undefined) await attempt(() => scheduler?.stop());
      if (coordinator !== undefined) await attempt(() => coordinator?.close());
      if (app !== undefined) await attempt(() => app?.close());
      if (database !== undefined) await attempt(() => database?.close());
      if (ownership !== undefined) await attempt(() => ownership?.release());
      if (sigintHandlerInstalled) {
        await attempt(() =>
          dependencies.signalTarget.removeListener(
            "SIGINT",
            signalHandlers.SIGINT,
          ),
        );
      }
      if (sigtermHandlerInstalled) {
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
      const runtime =
        await dependencies.loadRuntimeConfiguration(repositoryRoot);
      const { paths } = runtime;
      runtimeConfiguration = runtime.configuration;
      readiness = dependencies.createReadinessGate();
      dependencies.signalTarget.once("SIGINT", signalHandlers.SIGINT);
      sigintHandlerInstalled = true;
      dependencies.signalTarget.once("SIGTERM", signalHandlers.SIGTERM);
      sigtermHandlerInstalled = true;
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
      const createCoordinator = dependencies.createCoordinator;
      const reconcile = dependencies.reconcileEffects;
      const createScheduler = dependencies.createScheduler;
      const hasCoordinatorFactory = createCoordinator !== undefined;
      const hasReconciler = reconcile !== undefined;
      const hasSchedulerFactory = createScheduler !== undefined;
      if (hasCoordinatorFactory !== hasReconciler) {
        throw new Error(
          "Coordinator and reconciliation dependencies must be provided together",
        );
      }
      if (hasSchedulerFactory && !hasCoordinatorFactory) {
        throw new Error(
          "Scheduler requires coordinator and reconciliation dependencies",
        );
      }
      if (hasCoordinatorFactory && hasReconciler) {
        coordinator = await createCoordinator(
          database,
          runtimeConfiguration,
          repositoryRoot,
        );
        stopIfRequested();
        await reconcile(database, coordinator);
        stopIfRequested();
        if (createScheduler !== undefined) {
          scheduler = await createScheduler(
            database,
            coordinator,
            runtimeConfiguration,
            repositoryRoot,
          );
          stopIfRequested();
        }
      }
      const appOptions: {
        readiness: ReadinessGate;
        registerOperator?: (server: FastifyInstance) => Promise<void>;
        registerWeb?: (server: FastifyInstance) => Promise<void>;
      } = { readiness };
      const activeDatabase = database;
      const activeCoordinator = coordinator;
      const registerOperator = dependencies.registerOperator;
      if (
        activeDatabase !== undefined &&
        activeCoordinator !== undefined &&
        registerOperator !== undefined
      ) {
        appOptions.registerOperator = (server) =>
          registerOperator(server, {
            database: activeDatabase,
            coordinator: activeCoordinator,
            configuration: runtimeConfiguration,
          });
      }
      if (process.env.NODE_ENV !== "development") {
        appOptions.registerWeb = async (server) => {
          await dependencies.registerWeb?.(
            server,
            resolve(import.meta.dirname, "../../web/dist"),
          );
        };
      }
      app = await dependencies.buildApp(appOptions);
      stopIfRequested();
      address = await app.listen({
        host: "127.0.0.1",
        port: parsePort(process.env.WHEELSPARROW_PORT),
      });
      stopIfRequested();
      readiness.markReady();
      if (scheduler !== undefined) {
        await scheduler.start();
        stopIfRequested();
      }
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
  async createCoordinator(database, configuration, repositoryRoot) {
    const validated = requireConfiguration(configuration);
    const token = githubTokenFromEnvironment();
    const repository = validated.github.repository.includes("/")
      ? validated.github.repository
      : `${validated.github.owner}/${validated.github.repository}`;
    const projectGateway = createGitHubProjectGateway({
      owner: validated.github.owner,
      repository,
      projectNumber: validated.github.project_number,
      statusField: validated.github.status_field,
      readyStatus: validated.github.lanes.ready,
      requiredLabels: validated.github.required_labels,
      priorityField: validated.github.priority_field,
      ...(token === undefined ? {} : { token }),
    });
    const project = await projectGateway.readConfiguredProject();
    return createProductionCoordinator(
      database as DatabaseConnection,
      validated,
      {
        repositoryRoot,
        projectGateway,
        projectId: project.projectId,
        ...(token === undefined ? {} : { token }),
      },
    );
  },
  async reconcileEffects(database, coordinator) {
    await reconcileEffects({
      connection: database as DatabaseConnection,
      coordinator: coordinator as WorkflowCoordinator,
    });
  },
  createScheduler(database, coordinator, configuration) {
    const validated = requireConfiguration(configuration);
    const token = githubTokenFromEnvironment();
    const repository = validated.github.repository.includes("/")
      ? validated.github.repository
      : `${validated.github.owner}/${validated.github.repository}`;
    const projectGateway = createGitHubProjectGateway({
      owner: validated.github.owner,
      repository,
      projectNumber: validated.github.project_number,
      statusField: validated.github.status_field,
      readyStatus: validated.github.lanes.ready,
      requiredLabels: validated.github.required_labels,
      priorityField: validated.github.priority_field,
      ...(token === undefined ? {} : { token }),
    });
    const connection = database as DatabaseConnection;
    const ownerToken = randomUUID();
    return createProductionScheduler({
      intervalMs: validated.poll_interval_seconds * 1_000,
      readControl: () => readSchedulerControl(connection.db),
      claim: async (at, control) => {
        const project = await projectGateway.readConfiguredProject();
        const outcome = await claimNextEligible({
          connection,
          coordinator: coordinator as WorkflowCoordinator,
          gateway: projectGateway,
          configuration: {
            projectId: project.projectId,
            projectNumber: validated.github.project_number,
            repository,
            readyStatus: validated.github.lanes.ready,
            todoStatus: validated.github.lanes.todo,
            requiredLabels: validated.github.required_labels,
          },
          ownerToken,
          expectedSchedulerControlRevision: control.revision,
          now: () => at,
          runId: randomUUID,
        });
        if (outcome.kind === "claimed") {
          const execution = coordinator.productionExecution;
          if (execution === undefined)
            throw new Error("Production execution capability is unavailable.");
          const executionOutcome = await execution.runClaimedRun(outcome.run);
          if (executionOutcome.kind === "reviewing") {
            const reviewPublication = coordinator.productionReviewPublication;
            if (reviewPublication === undefined)
              throw new Error(
                "Production review/publication capability is unavailable.",
              );
            await reviewPublication.runFromVerification(
              executionOutcome.run,
              executionOutcome.verification,
            );
          }
        }
        return outcome;
      },
      onError: (error) => {
        process.stderr.write(
          `WHEELSPARROW_SCHEDULER_ERROR=${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    });
  },
  buildApp,
  createReadinessGate,
  announce(url) {
    process.stdout.write(`WHEELSPARROW_URL=${url}\n`);
  },
  signalTarget: productionSignalTarget(),
  registerWeb,
  async registerOperator(app, context) {
    const configuration = requireConfiguration(context.configuration);
    const discoverReady = createProductionReadyDiscovery({
      connection: context.database as DatabaseConnection,
      configuration,
    });
    registerOperatorRoutes(app, {
      connection: context.database as DatabaseConnection,
      coordinator: context.coordinator as WorkflowCoordinator,
      configuration,
      discoverReady,
    });
  },
};

/**
 * Local production-smoke proof exercises daemon lifecycle and assets without
 * making network calls or requiring an operator's credential store.
 */
export function resolveRuntimeDependencies(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): StartDependencies {
  if (environment.WHEELSPARROW_LOCAL_SMOKE !== "1")
    return productionDependencies;
  const {
    createCoordinator: _createCoordinator,
    reconcileEffects: _reconcileEffects,
    createScheduler: _createScheduler,
    registerOperator: _registerOperator,
    ...localSmokeDependencies
  } = productionDependencies;
  return localSmokeDependencies;
}

export async function start(repositoryRoot = process.cwd()): Promise<void> {
  try {
    await startService(repositoryRoot, resolveRuntimeDependencies());
  } catch (error) {
    if (!(error instanceof ShutdownRequestedError)) throw error;
  }
}

if (import.meta.main) await start();
