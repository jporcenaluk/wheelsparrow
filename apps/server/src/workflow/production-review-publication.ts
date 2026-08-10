import { resolve } from "node:path";
import {
  type Configuration,
  ConfigurationSchema,
} from "@wheelsparrow/contracts";
import { Value } from "typebox/value";
import { renderRepairPrompt, runRepair } from "../agents/repair.js";
import { renderReviewerPrompt, runReviewer } from "../agents/reviewer.js";
import type { DatabaseConnection } from "../database/connection.js";
import type { EffectInsertResult, EffectRecord } from "../database/effects.js";
import { type RunRecord, readRun } from "../database/runs.js";
import { GitHubCredentialsUnavailableError } from "../github/project-client.js";
import {
  assertObserveRequiredChecksRequest,
  assertPublishPullRequestRequest,
  assertPullRequestReceipt,
  assertReadPullRequestRequest,
  assertReconcilePullRequestRequest,
  assertRequiredChecksReceipt,
  type GitHubPublicationGateway,
  type ObserveRequiredChecksRequest,
  type PublishPullRequestRequest,
  type PullRequestReceipt,
  type ReadPullRequestRequest,
  type ReconcilePullRequestRequest,
  type RequiredChecksReceipt,
} from "../github/publication.js";
import {
  type CommittedRunWorktreeReceipt,
  commitAndPushRunWorktree,
  type GitRunner,
  type InspectRunWorktreeInput,
  type RunWorktreeReceipt,
  readRunWorktreeDiff,
  realGit,
} from "../workspaces/git.js";
import type {
  EffectCompletion,
  EffectDispatcherLike,
  EffectObserverLike,
  WorkflowCoordinator,
} from "./coordinator.js";
import {
  type ExecutionCoordinator,
  type IntakeCapture,
  type VerificationAdapter,
  validateIntakeCapture,
  type WorkspaceInspection,
} from "./execution.js";
import type {
  CommitAndPushPublicationEdge,
  PublicationCoordinator,
} from "./publication.js";
import {
  type CiObservationOutcome,
  observePublishedCi,
  type PublicationOutcome,
  publishApprovedRun,
} from "./publication.js";
import type {
  RepairAdapter,
  ReviewDiffReader,
  ReviewerAdapter,
  ReviewFindingReader,
} from "./review.js";
import { executeReviewAndRepair, type ReviewRepairOutcome } from "./review.js";

const shellSyntax = /[;|&<>$`'"\\()[\]{}*?!]/u;
const maximumPublicationBodyBytes = 16 * 1024;
const maximumRepositoryFactsBytes = 16 * 1024;
const checkNamePattern = /^\S.{0,255}$/u;
const shaPattern = /^[0-9a-f]{40}$/u;

interface PullRequestIdentity {
  readonly number: number;
  readonly nodeId: string;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly isDraft: boolean;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly headSha: string;
}

export interface ProductionPublicationClientOptions {
  readonly owner: string;
  readonly repository: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

export interface ProductionReviewPublicationOptions {
  readonly connection: DatabaseConnection;
  readonly coordinator: () => WorkflowCoordinator;
  readonly configuration: Configuration;
  readonly repositoryRoot: string;
  readonly workspaceInspect: WorkspaceInspection;
  readonly publicationGateway?: GitHubPublicationGateway;
  readonly reviewer?: ReviewerAdapter;
  readonly repair?: RepairAdapter;
  readonly verify?: VerificationAdapter;
  readonly readDiff?: ReviewDiffReader;
  readonly readFindings?: ReviewFindingReader;
  readonly commitAndPush?: CommitAndPushPublicationEdge;
  readonly git?: GitRunner;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly restEndpoint?: string;
}

export type ProductionReviewPublicationOutcome =
  | ReviewRepairOutcome
  | PublicationOutcome
  | CiObservationOutcome;

export interface ProductionReviewPublicationRuntime {
  readonly capability: {
    readonly dispatcher: EffectDispatcherLike;
    readonly observer: EffectObserverLike;
  };
  readonly runFromVerification: (
    run: RunRecord,
    verification?: unknown,
  ) => Promise<ProductionReviewPublicationOutcome>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function repositoryName(configuration: Configuration): string {
  return configuration.github.repository.includes("/")
    ? configuration.github.repository
    : `${configuration.github.owner}/${configuration.github.repository}`;
}

function splitCommand(command: string, label: string): readonly string[] {
  const normalized = command.trim();
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.includes("\r") ||
    normalized.includes("\n") ||
    shellSyntax.test(normalized)
  )
    throw new Error(
      `${label} must be an executable command without shell syntax.`,
    );
  return normalized.split(/\s+/u);
}

function worktreeExpected(run: RunRecord): RunWorktreeReceipt {
  if (
    run.worktreePath === null ||
    run.branch === null ||
    run.baseSha === null ||
    run.headSha === null
  )
    throw new Error("The run does not contain a complete worktree receipt.");
  return {
    path: run.worktreePath,
    branch: run.branch,
    baseSha: run.baseSha,
    headSha: run.headSha,
  };
}

function renderPublicationBody(intake: IntakeCapture): string {
  const body = [
    `Closes #${intake.project.issueNumber}`,
    "",
    "Acceptance criteria:",
    ...intake.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ].join("\n");
  if (Buffer.byteLength(body, "utf8") <= maximumPublicationBodyBytes)
    return body;
  let bounded = body;
  while (Buffer.byteLength(bounded, "utf8") > maximumPublicationBodyBytes)
    bounded = bounded.slice(0, -1);
  return bounded;
}

function publicationRepositoryFacts(run: RunRecord): string {
  const value = [
    `repository: ${run.repository}`,
    `base_branch: ${run.baseBranch}`,
    `branch: ${run.branch ?? "unavailable"}`,
    `base_sha: ${run.baseSha ?? "unavailable"}`,
    `head_sha: ${run.headSha ?? "unavailable"}`,
  ].join("\n");
  if (Buffer.byteLength(value, "utf8") <= maximumRepositoryFactsBytes)
    return value;
  return value.slice(0, maximumRepositoryFactsBytes);
}

function defaultReviewer(
  configuration: Configuration,
  workspaceRoot: string,
): ReviewerAdapter {
  return {
    render: async (input) => renderReviewerPrompt(input),
    invoke: async (input) =>
      runReviewer({
        command: splitCommand(configuration.agent.command, "Reviewer command"),
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        timeoutMs: configuration.agent.timeout_minutes * 60_000,
        worktreePath: input.worktreePath,
        workspaceRoot,
        prompt: input.prompt,
      }),
  };
}

function defaultRepair(
  configuration: Configuration,
  workspaceRoot: string,
): RepairAdapter {
  return {
    render: async (input) => renderRepairPrompt(input),
    invoke: async (input) =>
      runRepair({
        command: splitCommand(configuration.agent.command, "Repair command"),
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        timeoutMs: configuration.agent.timeout_minutes * 60_000,
        worktreePath: input.worktreePath,
        workspaceRoot,
        prompt: input.prompt,
      }),
  };
}

function defaultDiffReader(
  options: ProductionReviewPublicationOptions,
  workspaceRoot: string,
): ReviewDiffReader {
  return async (run) => {
    const expected = worktreeExpected(run);
    const input: InspectRunWorktreeInput = {
      repositoryRoot: options.repositoryRoot,
      workspaceRoot,
      runId: run.id,
      issueNumber: run.issueNumber,
      expected,
      git: options.git ?? realGit,
    };
    return readRunWorktreeDiff(input);
  };
}

function defaultCommitAndPush(
  options: ProductionReviewPublicationOptions,
  workspaceRoot: string,
): CommitAndPushPublicationEdge {
  return async (run) => {
    const receipt: CommittedRunWorktreeReceipt = await commitAndPushRunWorktree(
      {
        repositoryRoot: options.repositoryRoot,
        workspaceRoot,
        runId: run.id,
        issueNumber: run.issueNumber,
        expected: worktreeExpected(run),
        git: options.git ?? realGit,
      },
    );
    return receipt;
  };
}

function resumedExecutionCoordinator(
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

function resumedPublicationCoordinator(
  coordinator: WorkflowCoordinator,
  effect: EffectRecord,
): PublicationCoordinator {
  return {
    ...resumedExecutionCoordinator(coordinator, effect),
    releaseEffectForRetry: (command) =>
      coordinator.releaseEffectForRetry(command),
  };
}

function parseIntake(run: RunRecord): IntakeCapture {
  if (run.intakeJson === null)
    throw new Error("Durable issue intake is missing.");
  try {
    return validateIntakeCapture(JSON.parse(run.intakeJson) as unknown);
  } catch {
    throw new Error("Durable issue intake is invalid.");
  }
}

function parseVerification(value: string | null): unknown | undefined {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

async function readDurableVerification(
  options: ProductionReviewPublicationOptions,
  run: RunRecord,
): Promise<unknown | undefined> {
  const row = await options.connection.db
    .selectFrom("side_effects")
    .select("receipt_json")
    .where("run_id", "=", run.id)
    .where("kind", "=", "verify")
    .where("status", "=", "confirmed")
    .where("rework_epoch", "=", run.reworkEpoch)
    .orderBy("target_revision", "desc")
    .executeTakeFirst();
  return parseVerification(row?.receipt_json ?? null);
}

async function readDurableFindings(
  options: ProductionReviewPublicationOptions,
  run: RunRecord,
): Promise<readonly unknown[]> {
  const rows = await options.connection.db
    .selectFrom("findings")
    .select(["stable_key", "severity", "evidence"])
    .where("run_id", "=", run.id)
    .where("rework_epoch", "=", run.reworkEpoch)
    .orderBy("disposition_sequence", "asc")
    .execute();
  return rows.map((row) => ({
    stable_key: row.stable_key,
    severity: row.severity,
    evidence: row.evidence,
  }));
}

function hasIssueClosingReference(body: string, issueNumber: number): boolean {
  const escaped = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${escaped}\\b`,
    "iu",
  ).test(body);
}

function checkEndpoint(value: string, testOnly: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("GitHub publication endpoint configuration is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    (parsed.hostname !== "api.github.com" &&
      parsed.hostname !== "api.github.test") ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.hostname === "api.github.test" && !testOnly) ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  )
    throw new Error("GitHub publication endpoint configuration is invalid.");
  return parsed.toString().replace(/\/$/u, "");
}

function checkState(
  value: Record<string, unknown>,
): "pending" | "success" | "failure" {
  if (value.status !== "completed") return "pending";
  return value.conclusion === "success" ? "success" : "failure";
}

class ProductionGitHubPublicationGateway implements GitHubPublicationGateway {
  readonly #owner: string;
  readonly #repository: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #endpoint: string;
  readonly #timeoutMs: number;

  constructor(options: ProductionPublicationClientOptions) {
    const [owner, repository] = options.repository.split("/", 2);
    if (owner !== options.owner || repository === undefined)
      throw new Error(
        "GitHub publication repository must be owner/repository.",
      );
    this.#owner = owner;
    this.#repository = repository;
    this.#token = options.token?.trim();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#endpoint = checkEndpoint(
      options.endpoint ?? "https://api.github.com",
      options.fetch !== undefined,
    );
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async #json(
    path: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.#token === undefined || this.#token.length === 0)
      throw new GitHubCredentialsUnavailableError();
    let response: Response;
    try {
      response = await this.#fetch(
        new URL(path.slice(1), `${this.#endpoint}/`),
        {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${this.#token}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
            "user-agent": "wheelsparrow",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch {
      throw new Error("GitHub publication provider is unavailable.");
    }
    if (!response.ok)
      throw new Error("GitHub publication data is unavailable.");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("GitHub publication response is invalid.");
    }
    const parsed = record(payload);
    if (parsed === undefined)
      throw new Error("GitHub publication response is invalid.");
    return parsed;
  }

  #identity(payload: Record<string, unknown>): PullRequestIdentity {
    const number = payload.number;
    const body = payload.body;
    const base = record(payload.base);
    const head = record(payload.head);
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      typeof payload.node_id !== "string" ||
      payload.node_id.trim().length === 0 ||
      typeof payload.html_url !== "string" ||
      payload.html_url !==
        `https://github.com/${this.#owner}/${this.#repository}/pull/${number}` ||
      typeof payload.title !== "string" ||
      payload.title.trim().length === 0 ||
      typeof body !== "string" ||
      typeof payload.draft !== "boolean" ||
      typeof base?.ref !== "string" ||
      typeof base?.sha !== "string" ||
      !shaPattern.test(base.sha) ||
      typeof head?.ref !== "string" ||
      typeof head?.sha !== "string" ||
      !shaPattern.test(head.sha)
    )
      throw new Error("GitHub pull request data is invalid.");
    return {
      number: number as number,
      nodeId: payload.node_id,
      url: payload.html_url,
      title: payload.title,
      body,
      isDraft: payload.draft,
      baseBranch: base.ref,
      baseSha: base.sha,
      headBranch: head.ref,
      headSha: head.sha,
    };
  }

  #receipt(
    payload: Record<string, unknown>,
    issueNumber: number,
  ): PullRequestReceipt {
    const identity = this.#identity(payload);
    if (!hasIssueClosingReference(identity.body, issueNumber))
      throw new Error("Pull request is not linked to the issue.");
    return assertPullRequestReceipt({
      repository: `${this.#owner}/${this.#repository}`,
      number: identity.number,
      nodeId: identity.nodeId,
      url: identity.url,
      title: identity.title,
      issueNumber,
      isDraft: identity.isDraft,
      baseBranch: identity.baseBranch,
      baseSha: identity.baseSha,
      headBranch: identity.headBranch,
      headSha: identity.headSha,
    });
  }

  async #read(
    number: number,
    issueNumber: number,
  ): Promise<PullRequestReceipt> {
    const payload = await this.#json(
      `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/pulls/${number}`,
      "GET",
    );
    return this.#receipt(payload, issueNumber);
  }

  async #readIdentity(number: number): Promise<PullRequestIdentity> {
    const payload = await this.#json(
      `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/pulls/${number}`,
      "GET",
    );
    return this.#identity(payload);
  }

  #scope(repository: string): void {
    if (repository !== `${this.#owner}/${this.#repository}`)
      throw new Error(
        "GitHub publication repository does not match the request.",
      );
  }

  async #requiredContexts(baseBranch: string): Promise<readonly string[]> {
    const payload = await this.#json(
      `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/branches/${encodeURIComponent(baseBranch)}/protection/required_status_checks`,
      "GET",
    );
    const names: string[] = [];
    if (Array.isArray(payload.contexts)) {
      for (const context of payload.contexts) {
        if (typeof context !== "string" || !checkNamePattern.test(context))
          throw new Error("GitHub required check data is invalid.");
        names.push(context);
      }
    }
    if (Array.isArray(payload.checks)) {
      for (const value of payload.checks) {
        const item = record(value);
        const context = item?.context ?? item?.name;
        if (typeof context !== "string" || !checkNamePattern.test(context))
          throw new Error("GitHub required check data is invalid.");
        names.push(context);
      }
    }
    const unique = [...new Set(names)];
    if (unique.length === 0)
      throw new Error("GitHub required checks are unavailable.");
    return unique;
  }

  async #observedChecks(
    headSha: string,
  ): Promise<ReadonlyMap<string, "pending" | "success" | "failure">> {
    const checkPayload = await this.#json(
      `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/commits/${headSha}/check-runs?per_page=100`,
      "GET",
    );
    const statusPayload = await this.#json(
      `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/commits/${headSha}/status?per_page=100`,
      "GET",
    );
    if (!Array.isArray(checkPayload.check_runs))
      throw new Error("GitHub required check data is invalid.");
    if (!Array.isArray(statusPayload.statuses))
      throw new Error("GitHub required check data is invalid.");
    const observed = new Map<string, "pending" | "success" | "failure">();
    const recordCheck = (
      name: unknown,
      state: "pending" | "success" | "failure",
    ): void => {
      if (typeof name !== "string" || !checkNamePattern.test(name))
        throw new Error("GitHub required check data is invalid.");
      const previous = observed.get(name);
      if (
        previous === "failure" ||
        (previous === "pending" && state === "success")
      )
        return;
      observed.set(name, state);
    };
    for (const value of checkPayload.check_runs) {
      const item = record(value);
      if (item === undefined)
        throw new Error("GitHub required check data is invalid.");
      recordCheck(item.name, checkState(item));
    }
    for (const value of statusPayload.statuses) {
      const item = record(value);
      const state =
        item?.state === "success"
          ? "success"
          : item?.state === "pending" || item?.state === "expected"
            ? "pending"
            : item?.state === "failure" || item?.state === "error"
              ? "failure"
              : undefined;
      if (item === undefined || state === undefined)
        throw new Error("GitHub required check data is invalid.");
      recordCheck(item.context, state);
    }
    return observed;
  }

  async createPullRequest(
    request: PublishPullRequestRequest,
  ): Promise<PullRequestReceipt> {
    const expected = assertPublishPullRequestRequest(request);
    this.#scope(expected.repository);
    const payload = await this.#json(
      `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/pulls`,
      "POST",
      {
        title: expected.title,
        body: expected.body,
        head: expected.headBranch,
        base: expected.baseBranch,
        draft: false,
      },
    );
    return this.#receipt(payload, expected.issueNumber);
  }

  async reconcilePullRequest(
    request: ReconcilePullRequestRequest,
  ): Promise<PullRequestReceipt> {
    const expected = assertReconcilePullRequestRequest(request);
    this.#scope(expected.repository);
    const receipt = await this.#read(
      expected.expectedNumber,
      expected.issueNumber,
    );
    if (receipt.nodeId !== expected.expectedNodeId)
      throw new Error("Pull request identity changed.");
    return receipt;
  }

  async readPullRequest(
    request: ReadPullRequestRequest,
  ): Promise<PullRequestReceipt> {
    const expected = assertReadPullRequestRequest(request);
    this.#scope(expected.repository);
    const receipt = await this.#read(expected.number, expected.issueNumber);
    if (
      receipt.nodeId !== expected.expectedNodeId ||
      receipt.title !== expected.expectedTitle ||
      receipt.baseBranch !== expected.expectedBaseBranch ||
      receipt.baseSha !== expected.expectedBaseSha ||
      receipt.headBranch !== expected.expectedHeadBranch ||
      receipt.headSha !== expected.expectedHeadSha
    )
      throw new Error(
        "Pull request identity does not match the publication request.",
      );
    return receipt;
  }

  async observeRequiredChecks(
    request: ObserveRequiredChecksRequest,
  ): Promise<RequiredChecksReceipt> {
    const expected = assertObserveRequiredChecksRequest(request);
    this.#scope(expected.repository);
    const pullRequest = await this.#readIdentity(expected.number);
    if (pullRequest.nodeId !== expected.nodeId)
      throw new Error("Pull request identity does not match the CI request.");
    const observedHeadSha = pullRequest.headSha;
    const requiredNames = await this.#requiredContexts(
      expected.expectedBaseBranch,
    );
    const observed = await this.#observedChecks(observedHeadSha);
    const headDrift =
      observedHeadSha !== expected.expectedHeadSha ||
      pullRequest.baseBranch !== expected.expectedBaseBranch ||
      pullRequest.baseSha !== expected.expectedBaseSha;
    const requiredChecks = requiredNames.map((name) => ({
      name,
      state: headDrift
        ? ("pending" as const)
        : (observed.get(name) ?? "pending"),
    }));
    const aggregate = headDrift
      ? ("head_drift" as const)
      : requiredChecks.some((check) => check.state === "failure")
        ? ("failed" as const)
        : requiredChecks.every((check) => check.state === "success")
          ? ("green" as const)
          : ("pending" as const);
    return assertRequiredChecksReceipt({
      repository: expected.repository,
      number: pullRequest.number,
      nodeId: pullRequest.nodeId,
      headSha: observedHeadSha,
      requiredCheckNames: requiredChecks.map((check) => check.name),
      requiredChecks,
      headDrift,
      aggregate,
    });
  }
}

export const createProductionGitHubPublicationGateway = (
  options: ProductionPublicationClientOptions,
): GitHubPublicationGateway => new ProductionGitHubPublicationGateway(options);

export function createProductionReviewPublication(
  options: ProductionReviewPublicationOptions,
): ProductionReviewPublicationRuntime {
  if (!Value.Check(ConfigurationSchema, options.configuration))
    throw new Error("Validated runtime configuration is unavailable.");
  const workspaceRoot = resolve(
    options.repositoryRoot,
    options.configuration.workspace_root,
  );
  const reviewer =
    options.reviewer ?? defaultReviewer(options.configuration, workspaceRoot);
  const repair =
    options.repair ?? defaultRepair(options.configuration, workspaceRoot);
  const readDiff =
    options.readDiff ?? defaultDiffReader(options, workspaceRoot);
  const commitAndPush =
    options.commitAndPush ?? defaultCommitAndPush(options, workspaceRoot);
  const publicationGateway =
    options.publicationGateway ??
    createProductionGitHubPublicationGateway({
      owner: options.configuration.github.owner,
      repository: repositoryName(options.configuration),
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.restEndpoint === undefined
        ? {}
        : { endpoint: options.restEndpoint }),
    });
  const activeRuns = new Set<string>();

  const runPublication = async (
    run: RunRecord,
    verification: unknown,
    effect?: EffectRecord,
  ): Promise<ProductionReviewPublicationOutcome> => {
    const intake = parseIntake(run);
    const executionCoordinator = effect
      ? resumedExecutionCoordinator(options.coordinator(), effect)
      : options.coordinator();
    const review = await executeReviewAndRepair({
      coordinator: executionCoordinator,
      run,
      verification,
      repositoryFacts: publicationRepositoryFacts(run),
      readDiff,
      readFindings:
        options.readFindings ??
        ((current) => readDurableFindings(options, current)),
      reviewer,
      repair,
      workspaceInspect: options.workspaceInspect,
      ...(options.verify === undefined ? {} : { verify: options.verify }),
    });
    if (review.kind !== "approved") return review;
    const publicationCoordinator = options.coordinator();
    const publication = await publishApprovedRun({
      coordinator: publicationCoordinator,
      run: review.run,
      gateway: publicationGateway,
      commitAndPush,
      title: intake.title,
      body: renderPublicationBody(intake),
    });
    if (publication.kind !== "published") return publication;
    const publishedRun = await readRun(
      options.connection.db,
      publication.run.id,
    );
    const observeEffect = await publicationCoordinator.beginEffect({
      effectKey: publication.observeCiEffectKey,
      expectedRevision: publishedRun.revision,
    });
    const observed = await observePublishedCi({
      coordinator: resumedPublicationCoordinator(
        publicationCoordinator,
        observeEffect,
      ),
      run: publishedRun,
      gateway: publicationGateway,
      pullRequestNodeId: publication.pullRequest.nodeId,
    });
    return observed;
  };

  const runFromVerification = async (
    run: RunRecord,
    verification?: unknown,
  ): Promise<ProductionReviewPublicationOutcome> => {
    if (activeRuns.has(run.id))
      throw new Error(
        "Production review/publication is already active for this run.",
      );
    activeRuns.add(run.id);
    try {
      const durableVerification =
        verification ?? (await readDurableVerification(options, run));
      return await runPublication(run, durableVerification);
    } finally {
      activeRuns.delete(run.id);
    }
  };

  const execute = async (effect: EffectRecord): Promise<void> => {
    if (activeRuns.has(effect.runId)) return;
    activeRuns.add(effect.runId);
    try {
      const coordinator = options.coordinator();
      const run = await readRun(options.connection.db, effect.runId);
      if (effect.kind === "agent_review" || effect.kind === "agent_repair") {
        await runPublication(
          run,
          await readDurableVerification(options, run),
          effect,
        );
      } else if (effect.kind === "publish") {
        const intake = parseIntake(run);
        await publishApprovedRun({
          coordinator: resumedPublicationCoordinator(coordinator, effect),
          run,
          gateway: publicationGateway,
          commitAndPush,
          title: intake.title,
          body: renderPublicationBody(intake),
        });
      } else if (effect.kind === "observe_ci") {
        await observePublishedCi({
          coordinator: resumedPublicationCoordinator(coordinator, effect),
          run,
          gateway: publicationGateway,
        });
      }
    } finally {
      activeRuns.delete(effect.runId);
    }
  };

  const dispatch: EffectDispatcherLike = (effect) => {
    if (
      effect.kind !== "agent_review" &&
      effect.kind !== "agent_repair" &&
      effect.kind !== "publish" &&
      effect.kind !== "observe_ci"
    )
      return undefined;
    return execute(effect);
  };
  const observe: EffectObserverLike = (effect, complete: EffectCompletion) =>
    dispatch(effect, complete);

  return {
    capability: { dispatcher: dispatch, observer: observe },
    runFromVerification,
  };
}
