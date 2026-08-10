import { resolve } from "node:path";
import type { Configuration } from "@wheelsparrow/contracts";
import { ConfigurationSchema } from "@wheelsparrow/contracts";
import { Value } from "typebox/value";
import { renderBuilderPrompt, runBuilder } from "../agents/builder.js";
import type { DatabaseConnection } from "../database/connection.js";
import type { EffectInsertResult, EffectRecord } from "../database/effects.js";
import { type RunRecord, readRun } from "../database/runs.js";
import type { GitHubProjectGateway, ProjectItem } from "../github/project.js";
import {
  GitHubCredentialsUnavailableError,
  githubTokenFromEnvironment,
} from "../github/project-client.js";
import {
  type GitRunner,
  inspectRunWorktree,
  prepareRunWorktree,
  type RunWorktreeReceipt,
  realGit,
} from "../workspaces/git.js";
import { runVerification } from "../workspaces/verify.js";
import type {
  EffectDispatcherLike,
  EffectObserverLike,
} from "./coordinator.js";
import {
  type BuilderAdapter,
  createExecutionCapability,
  type ExecutionCapability,
  type ExecutionCoordinator,
  type ExecutionOutcome,
  executeClaimedRun,
  type IntakeCapture,
  type VerificationAdapter,
  validateIntakeCapture,
  type WorkspaceInspection,
  type WorkspacePreparation,
  type WorkspacePreparationReceipt,
} from "./execution.js";

const shaPattern = /^[0-9a-f]{40}$/u;
const shellSyntax = /[;|&<>$`'"\\()[\]{}*?!]/u;
const maximumIssueBodyBytes = 1024 * 1024;

export type ProductionProjectGateway = Pick<
  GitHubProjectGateway,
  "readProjectItem"
>;

export interface ProductionIssueSnapshot {
  readonly issueNumber: number;
  readonly title: string;
  readonly body: string;
}

export interface ProductionIssueReader {
  readIssue(issueNumber: number): Promise<ProductionIssueSnapshot>;
}

export interface GitHubIssueReaderOptions {
  readonly owner: string;
  readonly repository: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

export interface ProductionExecutionRuntime {
  readonly capability: ExecutionCapability;
  readonly workspaceInspect: WorkspaceInspection;
  readonly verify: VerificationAdapter;
  readonly runClaimedRun: (run: RunRecord) => Promise<ExecutionOutcome>;
}

export interface ProductionExecutionOptions {
  readonly connection: DatabaseConnection;
  /** A provider avoids constructing the coordinator before its dispatcher. */
  readonly coordinator: () => ExecutionCoordinator;
  readonly configuration: Configuration;
  readonly repositoryRoot: string;
  readonly projectGateway: ProductionProjectGateway;
  readonly projectId: string;
  readonly issueReader?: ProductionIssueReader;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly restEndpoint?: string;
  readonly git?: GitRunner;
  readonly readBaseSha?: (repositoryRoot: string) => Promise<string>;
  /** Deterministic seams for composition tests; production uses real edges. */
  readonly workspacePrepare?: WorkspacePreparation;
  readonly workspaceInspect?: WorkspaceInspection;
  readonly builder?: BuilderAdapter;
  readonly verify?: VerificationAdapter;
}

function repositoryName(configuration: Configuration): string {
  return configuration.github.repository.includes("/")
    ? configuration.github.repository
    : `${configuration.github.owner}/${configuration.github.repository}`;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} is unavailable.`);
  return value;
}

function issueBody(value: unknown): string {
  if (value === null || value === undefined) return "(Issue has no body.)";
  const body = text(value, "Issue body");
  if (Buffer.byteLength(body, "utf8") > maximumIssueBodyBytes)
    throw new Error("Issue body exceeds its size limit.");
  return body;
}

/**
 * Extract the explicit acceptance-criteria list when an issue has one. A
 * bounded body is retained as one criterion for issues that use prose only;
 * the durable execution validator applies the final size and JSON limits.
 */
export function parseAcceptanceCriteria(body: string): readonly string[] {
  const lines = body.split(/\r?\n/u);
  const criteria: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading !== null) {
      const normalized = heading[1]?.trim().toLocaleLowerCase();
      inSection = normalized === "acceptance criteria";
      continue;
    }
    if (!inSection) continue;
    const criterion =
      /^\s*(?:[-*+]\s+)?\[[ xX]\]\s+(.+?)\s*$/u.exec(line)?.[1] ??
      /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/u.exec(line)?.[1];
    if (criterion !== undefined && criterion.length > 0)
      criteria.push(criterion);
  }
  if (criteria.length > 0) return criteria;
  const fallback = body.trim();
  return fallback.length > 0 ? [fallback] : ["The issue contract is captured."];
}

function assertConfiguredIssue(
  item: ProjectItem | undefined,
  run: RunRecord,
  configuration: Configuration,
  projectId: string,
): asserts item is ProjectItem {
  const repository = repositoryName(configuration);
  if (
    item === undefined ||
    item.projectId !== projectId ||
    item.projectNumber !== configuration.github.project_number ||
    item.repository !== repository ||
    item.projectItemId !== run.projectItemId ||
    item.issueNodeId !== run.issueNodeId ||
    item.issueNumber !== run.issueNumber ||
    !item.isOpen ||
    item.status !== configuration.github.lanes.todo
  ) {
    throw new Error(
      "The current Todo project item does not match the durable run.",
    );
  }
}

function createIssueReader(
  options: GitHubIssueReaderOptions,
): ProductionIssueReader {
  const token = options.token ?? githubTokenFromEnvironment();
  const fetcher = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? "https://api.github.com";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const [owner, repository] = options.repository.split("/", 2);
  if (
    owner === undefined ||
    repository === undefined ||
    owner.length === 0 ||
    repository.length === 0
  ) {
    throw new Error("GitHub repository must be owner/repository.");
  }

  return {
    async readIssue(issueNumber) {
      if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
        throw new Error("Issue number must be a positive integer.");
      if (token === undefined || token.length === 0)
        throw new GitHubCredentialsUnavailableError();
      const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
      const url = new URL(
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issueNumber}`,
        base,
      );
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "GET",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "wheelsparrow",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new Error("GitHub issue provider is unavailable.");
      }
      if (!response.ok) throw new Error("GitHub issue data is unavailable.");
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("GitHub issue data is invalid.");
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      )
        throw new Error("GitHub issue data is invalid.");
      const record = payload as Record<string, unknown>;
      if (record.number !== issueNumber)
        throw new Error("GitHub issue identity does not match the run.");
      return {
        issueNumber,
        title: text(record.title, "Issue title"),
        body: issueBody(record.body),
      };
    },
  };
}

export const createGitHubIssueReader = createIssueReader;

async function readOriginMainSha(
  repositoryRoot: string,
  git: GitRunner,
): Promise<string> {
  await git(repositoryRoot, ["fetch", "origin", "main"]);
  const baseSha = (
    await git(repositoryRoot, [
      "rev-parse",
      "--verify",
      "refs/remotes/origin/main^{commit}",
    ])
  ).trim();
  if (!shaPattern.test(baseSha))
    throw new Error("origin/main returned an invalid SHA.");
  return baseSha;
}

function splitCommand(command: string, label: string): readonly string[] {
  const normalized = command.trim();
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.includes("\r") ||
    normalized.includes("\n") ||
    shellSyntax.test(normalized)
  ) {
    throw new Error(
      `${label} must be an executable command without shell syntax.`,
    );
  }
  return normalized.split(/\s+/u);
}

function issueIntake(
  run: RunRecord,
  item: ProjectItem,
  issue: ProductionIssueSnapshot,
  baseSha: string,
  configuration: Configuration,
): IntakeCapture {
  const body = issueBody(issue.body);
  if (issue.issueNumber !== run.issueNumber)
    throw new Error("Issue identity does not match the durable run.");
  return validateIntakeCapture({
    title: text(issue.title, "Issue title"),
    body,
    acceptanceCriteria: parseAcceptanceCriteria(body),
    dependencyState: item.dependencies,
    project: {
      projectId: item.projectId,
      projectNumber: item.projectNumber,
      projectItemId: item.projectItemId,
      issueNodeId: item.issueNodeId,
      issueNumber: item.issueNumber,
      status: item.status,
      revision: item.revision,
      labels: item.labels,
      createdAt: item.createdAt,
      ...(item.priorityRank === undefined
        ? {}
        : { priorityRank: item.priorityRank }),
    },
    repository: item.repository,
    baseSha,
    builder: {
      command: configuration.agent.command,
      model: configuration.agent.model,
      reasoningEffort: configuration.agent.reasoning_effort,
      timeoutMinutes: configuration.agent.timeout_minutes,
    },
    verificationCommand: configuration.verification.command,
  });
}

function createProductionWorkspace(
  repositoryRoot: string,
  workspaceRoot: string,
  git: GitRunner,
): {
  readonly prepare: WorkspacePreparation;
  readonly inspect: WorkspaceInspection;
} {
  const prepare: WorkspacePreparation = async (run) => {
    if (run.baseBranch !== "main")
      throw new Error("Production execution requires the main base branch.");
    const prepared = await prepareRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: run.id,
      issueNumber: run.issueNumber,
      baseBranch: run.baseBranch,
      git,
    });
    const headSha = (await git(prepared.path, ["rev-parse", "HEAD"])).trim();
    const expected: RunWorktreeReceipt = { ...prepared, headSha };
    return inspectRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: run.id,
      issueNumber: run.issueNumber,
      expected,
      git,
    });
  };

  const inspect: WorkspaceInspection = async (run, expectedReceipt) => {
    const expected = expectedReceipt as WorkspacePreparationReceipt;
    return inspectRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: run.id,
      issueNumber: run.issueNumber,
      expected: {
        path: expected.path,
        branch: expected.branch,
        baseSha: expected.baseSha,
        headSha: expected.headSha,
      },
      git,
    });
  };
  return { prepare, inspect };
}

function createProductionBuilder(
  configuration: Configuration,
  workspaceRoot: string,
): BuilderAdapter {
  return {
    render: async (input) =>
      renderBuilderPrompt({
        issueNumber: input.issueNumber,
        issueTitle: input.intake.title,
        issueBody: input.intake.body,
        worktreePath: input.worktreePath,
        baseSha: input.baseSha,
      }),
    invoke: async (input) =>
      runBuilder({
        command: splitCommand(input.intake.builder.command, "Builder command"),
        model: configuration.agent.model,
        reasoningEffort: configuration.agent.reasoning_effort,
        timeoutMs: configuration.agent.timeout_minutes * 60_000,
        worktreePath: input.worktreePath,
        workspaceRoot,
        prompt: input.prompt,
      }),
  };
}

function createProductionVerifier(
  configuration: Configuration,
  workspaceRoot: string,
): NonNullable<ProductionExecutionOptions["verify"]> {
  return async (input) =>
    runVerification({
      command: configuration.verification.command,
      worktreePath: input.worktreePath,
      workspaceRoot,
      timeoutMs: configuration.agent.timeout_minutes * 60_000,
    });
}

function resumedCoordinator(
  coordinator: ExecutionCoordinator,
  effect: EffectRecord,
): ExecutionCoordinator {
  return {
    createEffectIntent: async (command) => {
      const result = await coordinator.createEffectIntent(command);
      if (command.key !== effect.key) return result;
      const pending = { ...result, status: "pending" as const };
      return {
        ...pending,
        inserted: false,
        record: pending,
        effect: pending,
      } satisfies EffectInsertResult;
    },
    beginEffect: async (command) => {
      const key = typeof command === "string" ? command : command.effectKey;
      if (key === effect.key) return effect;
      return coordinator.beginEffect(command);
    },
    settleExecution: (command) => coordinator.settleExecution(command),
    transition: (command) => coordinator.transition(command),
    quarantineEffect: (command) => coordinator.quarantineEffect(command),
  };
}

function assertConfiguration(configuration: Configuration): void {
  if (!Value.Check(ConfigurationSchema, configuration))
    throw new Error("Validated runtime configuration is unavailable.");
}

export function createProductionExecution(
  options: ProductionExecutionOptions,
): ProductionExecutionRuntime {
  assertConfiguration(options.configuration);
  const workspaceRoot = resolve(
    options.repositoryRoot,
    options.configuration.workspace_root,
  );
  const git = options.git ?? realGit;
  const workspaces = createProductionWorkspace(
    options.repositoryRoot,
    workspaceRoot,
    git,
  );
  const workspacePrepareEdge = options.workspacePrepare ?? workspaces.prepare;
  const workspaceInspectEdge = options.workspaceInspect ?? workspaces.inspect;
  const expectedBaseByRun = new Map<string, string>();
  const baseMatchesIntake = (run: RunRecord, receipt: unknown): boolean => {
    const expectedBase = expectedBaseByRun.get(run.id);
    if (expectedBase === undefined) return true;
    return (
      typeof receipt === "object" &&
      receipt !== null &&
      !Array.isArray(receipt) &&
      (receipt as { baseSha?: unknown }).baseSha === expectedBase
    );
  };
  const workspacePrepare: WorkspacePreparation = async (run) => {
    const receipt = await workspacePrepareEdge(run);
    if (!baseMatchesIntake(run, receipt))
      throw new Error(
        "Prepared worktree base SHA does not match the captured intake base SHA.",
      );
    return receipt;
  };
  const workspaceInspect: WorkspaceInspection = async (run, expected) => {
    const receipt = await workspaceInspectEdge(run, expected);
    if (!baseMatchesIntake(run, receipt))
      throw new Error(
        "Inspected worktree base SHA does not match the captured intake base SHA.",
      );
    return receipt;
  };
  const builder =
    options.builder ??
    createProductionBuilder(options.configuration, workspaceRoot);
  const verify =
    options.verify ??
    createProductionVerifier(options.configuration, workspaceRoot);
  const issueReader =
    options.issueReader ??
    createIssueReader({
      owner: options.configuration.github.owner,
      repository: repositoryName(options.configuration),
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.restEndpoint === undefined
        ? {}
        : { endpoint: options.restEndpoint }),
    });
  const readBase =
    options.readBaseSha ??
    ((repositoryRoot) => readOriginMainSha(repositoryRoot, git));
  const activeRuns = new Set<string>();

  const readIntake = async (
    run: RunRecord,
    baseSha: string,
  ): Promise<IntakeCapture> => {
    expectedBaseByRun.set(run.id, baseSha);
    const item = await options.projectGateway.readProjectItem(
      run.projectItemId,
    );
    assertConfiguredIssue(item, run, options.configuration, options.projectId);
    const issue = await issueReader.readIssue(run.issueNumber);
    return issueIntake(run, item, issue, baseSha, options.configuration);
  };

  const execute = async (effect: EffectRecord): Promise<void> => {
    // Normal execution already owns the edge and its durable settlement. The
    // capability callback from beginEffect is intentionally a no-op in that
    // case; this prevents a second builder or verifier process.
    if (activeRuns.has(effect.runId)) return;
    activeRuns.add(effect.runId);
    try {
      const coordinator = options.coordinator();
      const run = await readRun(options.connection.db, effect.runId);
      const intake =
        run.state === "preparing"
          ? await readIntake(run, await readBase(options.repositoryRoot))
          : undefined;
      await executeClaimedRun({
        coordinator: resumedCoordinator(coordinator, effect),
        run,
        workspacePrepare,
        workspaceInspect,
        builder,
        verify,
        ...(intake === undefined ? {} : { intake }),
      });
    } finally {
      expectedBaseByRun.delete(effect.runId);
      activeRuns.delete(effect.runId);
    }
  };

  const edgeCapability = createExecutionCapability({
    readRun: async (runId) => {
      return readRun(options.connection.db, runId);
    },
    workspacePrepare,
    workspaceInspect,
    builder,
    verify,
    execute,
  });

  const settleIntakeCapture = async (effect: EffectRecord): Promise<void> => {
    if (activeRuns.has(effect.runId)) return;
    const coordinator = options.coordinator();
    const run = await readRun(options.connection.db, effect.runId);
    if (run.state !== "intaking")
      throw new Error("Intake capture effect is not in the intaking state.");
    let intake: IntakeCapture;
    try {
      intake = validateIntakeCapture(JSON.parse(effect.intent) as unknown);
    } catch {
      throw new Error("Intake capture effect intent is invalid.");
    }
    const intakeJson = JSON.stringify(intake);
    await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome: "confirmed",
      trigger: "intake_captured",
      evidence: `Intake captured for ${run.id}.`,
      receipt: { intakeJson },
      facts: { intakeJson },
    });
  };

  const dispatcher: EffectDispatcherLike = (effect, complete) => {
    if (effect.kind !== "intake_capture")
      return typeof edgeCapability.dispatcher === "function"
        ? edgeCapability.dispatcher(effect, complete)
        : edgeCapability.dispatcher.dispatch(effect, complete);
    if (activeRuns.has(effect.runId)) return undefined;
    return settleIntakeCapture(effect);
  };
  const observer: EffectObserverLike = (effect, complete) => {
    if (effect.kind !== "intake_capture")
      return typeof edgeCapability.observer === "function"
        ? edgeCapability.observer(effect, complete)
        : edgeCapability.observer.observe(effect, complete);
    if (activeRuns.has(effect.runId)) return undefined;
    return settleIntakeCapture(effect);
  };
  const capability: ExecutionCapability = { dispatcher, observer };

  const runClaimedRun = async (run: RunRecord): Promise<ExecutionOutcome> => {
    if (activeRuns.has(run.id))
      throw new Error("Production execution is already active for this run.");
    activeRuns.add(run.id);
    try {
      const intake =
        run.state === "preparing"
          ? await readIntake(run, await readBase(options.repositoryRoot))
          : undefined;
      return await executeClaimedRun({
        coordinator: options.coordinator(),
        run,
        workspacePrepare,
        workspaceInspect,
        builder,
        verify,
        ...(intake === undefined ? {} : { intake }),
      });
    } finally {
      expectedBaseByRun.delete(run.id);
      activeRuns.delete(run.id);
    }
  };

  return {
    capability,
    workspaceInspect,
    verify,
    runClaimedRun,
  };
}
