import { spawn } from "node:child_process";

import type { EffectRecord } from "../database/effects.js";
import { StaleEffectError } from "../database/effects.js";
import type { RunRecord } from "../database/runs.js";
import { StaleRevisionError } from "../database/runs.js";
import {
  assertConditionalProjectDoneMoveRequest,
  assertMergeCandidateReceipt,
  assertMergeReceipt,
  assertObserveStagingRequest,
  assertStagingObservation,
  type ConditionalProjectDoneMoveRequest,
  type GitHubDeliveryGateway,
  type MergeCandidateReceipt,
  type MergeCandidateRequest,
  type MergeReceipt,
  type ObserveStagingRequest,
  type ProjectDoneMoveResult,
  type StagingObservation,
  selectMergeMethod,
} from "../github/delivery.js";
import type {
  EffectDispatcherLike,
  EffectObserverLike,
  WorkflowCoordinator,
} from "./coordinator.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const MAX_EVIDENCE_BYTES = 4 * 1024;
const MAX_COMMAND_BYTES = 4 * 1024;
const MAX_SMOKE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SMOKE_TIMEOUT_MS = 2 * 60 * 1000;

/** Configuration required by delivery observations and the bounded smoke edge. */
export interface DeliveryConfiguration {
  readonly workflow: string;
  readonly environment: string;
  readonly smokeCommand: string;
  readonly smokeTimeoutMs?: number;
  readonly projectId?: string;
  readonly projectNumber?: number;
  readonly expectedProjectRevision?: string;
  readonly reviewStatus?: string;
  readonly doneStatus?: string;
}

/** A deliberately narrow command runner. It does not expose a shell or child process. */
export interface SmokeRunnerRequest {
  readonly command: string;
  readonly timeoutMs: number;
  readonly runId: string;
  readonly mergeSha: string;
}

export interface SmokeRunnerResult {
  readonly outcome: "passed" | "failed";
  readonly exitCode?: number | null;
  readonly durationMs?: number | null;
  /** Human-readable diagnostics; it is redacted and bounded before persistence. */
  readonly output?: string;
}

export interface SmokeRunner {
  run(request: SmokeRunnerRequest): Promise<SmokeRunnerResult>;
}

export interface SafeSmokeRunnerOptions {
  /** Fixed working directory for every invocation. */
  readonly cwd: string;
  /** Explicit environment; ambient process variables are never inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly outputLimitBytes?: number;
  readonly killGraceMs?: number;
}

type DeliveryCoordinator = Pick<
  WorkflowCoordinator,
  | "createEffectIntent"
  | "beginEffect"
  | "releaseEffectForRetry"
  | "settleExecution"
  | "transition"
> & {
  readonly quarantineEffect?: WorkflowCoordinator["quarantineEffect"];
};

export type DeliveryStageResult =
  | {
      readonly kind: "merged";
      readonly run: RunRecord;
      readonly merge: MergeReceipt;
      readonly stagingEffectKey: string;
    }
  | {
      readonly kind: "staged";
      readonly run: RunRecord;
      readonly staging: StagingObservation;
      readonly smokeEffectKey: string;
    }
  | {
      readonly kind: "smoked";
      readonly run: RunRecord;
      readonly smoke: SmokeReceipt;
      readonly doneEffectKey: string;
    }
  | { readonly kind: "done"; readonly run: RunRecord; readonly item: unknown }
  | {
      readonly kind: "pending";
      readonly run: RunRecord;
      readonly effectKey: string;
    }
  | { readonly kind: "human"; readonly run: RunRecord; readonly reason: string }
  | { readonly kind: "stale"; readonly run: RunRecord };

export interface ExecuteMergeStageInput {
  readonly coordinator: DeliveryCoordinator;
  readonly gateway: GitHubDeliveryGateway;
  readonly run: RunRecord;
  readonly configuration: Pick<
    DeliveryConfiguration,
    "workflow" | "environment"
  >;
  readonly now?: () => string;
}

export interface ExecuteStagingStageInput {
  readonly coordinator: DeliveryCoordinator;
  readonly gateway: GitHubDeliveryGateway;
  readonly run: RunRecord;
  readonly configuration: DeliveryConfiguration;
  readonly now?: () => string;
}

export interface ExecuteSmokeStageInput {
  readonly coordinator: DeliveryCoordinator;
  readonly run: RunRecord;
  readonly configuration: DeliveryConfiguration;
  readonly smokeRunner: SmokeRunner;
  readonly now?: () => string;
}

export interface ExecuteProjectDoneStageInput {
  readonly coordinator: DeliveryCoordinator;
  readonly gateway: GitHubDeliveryGateway;
  readonly run: RunRecord;
  readonly configuration: DeliveryConfiguration;
  readonly now?: () => string;
}

export interface SmokeReceipt {
  readonly outcome: "passed" | "failed";
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly summary: string;
}

function strictSmokeReceipt(
  receipt: SmokeReceipt,
  command: string,
  mergeSha: string,
): Record<string, unknown> {
  return { ...receipt, command, mergeSha };
}

export interface DeliveryCapability {
  readonly dispatcher: EffectDispatcherLike;
  readonly observer: EffectObserverLike;
}

export interface DeliveryCapabilityOptions {
  /** Resolve the durable run for an effect; this is the only safe source for issue/title facts omitted by older intents. */
  readonly resolveRun?: (
    effect: EffectRecord,
  ) => RunRecord | Promise<RunRecord>;
}

interface ScheduledEffect {
  readonly effect: EffectRecord;
  readonly started: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function text(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function bounded(value: string): string {
  let result = value;
  while (Buffer.byteLength(result, "utf8") > MAX_EVIDENCE_BYTES)
    result = result.slice(0, -1);
  return result || "Delivery requires human attention.";
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maximumBytes)
    result = result.slice(0, -1);
  return result;
}

function redacted(value: string): string {
  return bounded(value)
    .replace(/(authorization\s*[:=]\s*)([^\s,]+)/giu, "$1[REDACTED]")
    .replace(/(bearer\s+)([^\s,]+)/giu, "$1[REDACTED]")
    .replace(
      /(token|secret|password|api[-_]?key)\s*[:=]\s*[^\s,]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/gh[pousr]_[A-Za-z0-9_]+/gu, "[REDACTED]");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStale(error: unknown): boolean {
  return (
    error instanceof StaleRevisionError || error instanceof StaleEffectError
  );
}

function isAmbiguous(error: unknown): boolean {
  return isRecord(error) && error.kind === "merge_ambiguous";
}

function parseArgv(command: string): string[] {
  if (!text(command, MAX_COMMAND_BYTES))
    throw new Error("Smoke command is unavailable.");
  if (/[;&|<>`$()\r\n]/u.test(command))
    throw new Error("Smoke command contains shell syntax.");
  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current.length > 0) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaped || quote !== undefined)
    throw new Error("Smoke command quoting is malformed.");
  if (current.length > 0) argv.push(current);
  if (argv.length === 0) throw new Error("Smoke command is unavailable.");
  return argv;
}

function killProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

/** Production-capable shell-free smoke runner with bounded output and tree cleanup. */
export function createSafeSmokeRunner(
  options: SafeSmokeRunnerOptions,
): SmokeRunner {
  if (!text(options.cwd, 4 * 1024))
    throw new TypeError("Smoke runner cwd is required.");
  const outputLimit = options.outputLimitBytes ?? 16 * 1024;
  const killGraceMs = options.killGraceMs ?? 250;
  if (
    !Number.isSafeInteger(outputLimit) ||
    outputLimit <= 0 ||
    outputLimit > 16 * 1024
  )
    throw new RangeError(
      "Smoke output limit must be between 1 and 16384 bytes.",
    );
  if (
    !Number.isSafeInteger(killGraceMs) ||
    killGraceMs < 0 ||
    killGraceMs > 5_000
  )
    throw new RangeError("Smoke kill grace is outside its safe bound.");
  const fixedEnv = { ...options.env };
  return {
    run(request) {
      const argv = parseArgv(request.command);
      if (
        !Number.isSafeInteger(request.timeoutMs) ||
        request.timeoutMs <= 0 ||
        request.timeoutMs > MAX_SMOKE_TIMEOUT_MS
      )
        return Promise.reject(
          new Error("Smoke timeout is outside its safe bound."),
        );
      const started = Date.now();
      return new Promise<SmokeRunnerResult>((resolve, reject) => {
        let timedOut = false;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let stdout = "";
        let stderr = "";
        const append = (
          value: string,
          existing: string,
          other: string,
        ): string => {
          const remaining =
            outputLimit -
            Buffer.byteLength(existing, "utf8") -
            Buffer.byteLength(other, "utf8");
          if (remaining <= 0) return existing;
          return existing + truncateUtf8(value, remaining);
        };
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(argv[0] as string, argv.slice(1), {
            cwd: options.cwd,
            env: fixedEnv,
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          reject(new Error(redacted(errorMessage(error))));
          return;
        }
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (value: string) => {
          stdout = append(value, stdout, stderr);
        });
        child.stderr?.on("data", (value: string) => {
          stderr = append(value, stderr, stdout);
        });
        const finish = (result: SmokeRunnerResult): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          if (killTimer !== undefined) clearTimeout(killTimer);
          resolve(result);
        };
        child.once("error", (error) => {
          if (timedOut) return;
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          reject(new Error(redacted(errorMessage(error))));
        });
        child.once("close", (code) => {
          const output = redacted(
            `${stdout}${stderr.length > 0 ? `\n${stderr}` : ""}`,
          );
          finish({
            outcome: timedOut || code !== 0 ? "failed" : "passed",
            exitCode: timedOut ? null : code,
            durationMs: Date.now() - started,
            output: timedOut ? `${output}\nSmoke timed out.` : output,
          });
        });
        timer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          killProcessTree(child, "SIGTERM");
          killTimer = setTimeout(
            () => killProcessTree(child, "SIGKILL"),
            killGraceMs,
          );
        }, request.timeoutMs);
      });
    },
  };
}

function configError(configuration: DeliveryConfiguration): string | undefined {
  if (!text(configuration.workflow, 512))
    return "Staging workflow is unavailable.";
  if (!text(configuration.environment, 256))
    return "Staging environment is unavailable.";
  if (!text(configuration.smokeCommand, MAX_COMMAND_BYTES))
    return "Staging smoke command is unavailable.";
  if (
    configuration.smokeTimeoutMs !== undefined &&
    (!Number.isSafeInteger(configuration.smokeTimeoutMs) ||
      configuration.smokeTimeoutMs <= 0 ||
      configuration.smokeTimeoutMs > MAX_SMOKE_TIMEOUT_MS)
  )
    return "Staging smoke timeout is outside the safe bound.";
  return undefined;
}

function doneConfigError(
  configuration: DeliveryConfiguration,
): string | undefined {
  const base = configError(configuration);
  if (base !== undefined) return base;
  if (!text(configuration.projectId, 256))
    return "Project identity is unavailable.";
  if (!positiveInteger(configuration.projectNumber))
    return "Project number is unavailable.";
  if (!text(configuration.expectedProjectRevision, 512))
    return "Project revision is unavailable.";
  if (!text(configuration.reviewStatus, 256))
    return "Review status is unavailable.";
  if (!text(configuration.doneStatus, 256))
    return "Done status is unavailable.";
  return undefined;
}

function parseIntent(
  effect: EffectRecord,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(effect.intent);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseStrictIntent(
  effect: EffectRecord,
  kind: string,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (effect.kind !== kind) return undefined;
  const intent = parseIntent(effect);
  return intent !== undefined && hasOnlyKeys(intent, keys) ? intent : undefined;
}

function mergeRequestFromRun(
  run: RunRecord,
  effectKey: string,
): MergeCandidateRequest & {
  readonly effectKey: string;
  readonly method?: never;
} {
  if (
    !text(run.repository, 256) ||
    !positiveInteger(run.pullRequestNumber) ||
    !text(run.pullRequestNodeId, 256) ||
    !text(run.pullRequestTitle, 2_000) ||
    !text(run.baseBranch, 512) ||
    !SHA_PATTERN.test(run.baseSha ?? "") ||
    !BRANCH_PATTERN.test(run.branch ?? "") ||
    !SHA_PATTERN.test(run.headSha ?? "") ||
    run.approvedHeadSha !== run.headSha ||
    run.observedBaseSha !== run.baseSha
  )
    throw new Error(
      "Merge requires complete exact pull-request, base, and approved-head facts.",
    );
  const base = run.baseSha;
  const branch = run.branch;
  const head = run.headSha;
  if (base === null || branch === null || head === null)
    throw new Error(
      "Merge requires complete exact pull-request, base, and approved-head facts.",
    );
  return {
    repository: run.repository,
    number: run.pullRequestNumber,
    issueNumber: run.issueNumber,
    nodeId: run.pullRequestNodeId,
    expectedTitle: run.pullRequestTitle,
    expectedBaseBranch: run.baseBranch,
    expectedBaseSha: base,
    expectedHeadBranch: branch,
    expectedHeadSha: head,
    effectKey,
  };
}

function verifyCandidate(
  candidate: MergeCandidateReceipt,
  request: MergeCandidateRequest,
): void {
  if (
    candidate.repository !== request.repository ||
    candidate.number !== request.number ||
    candidate.issueNumber !== request.issueNumber ||
    candidate.nodeId !== request.nodeId ||
    candidate.title !== request.expectedTitle ||
    candidate.baseBranch !== request.expectedBaseBranch ||
    candidate.baseSha !== request.expectedBaseSha ||
    candidate.headBranch !== request.expectedHeadBranch ||
    candidate.headSha !== request.expectedHeadSha ||
    candidate.isDraft
  )
    throw new Error("Merge candidate changed after exact-head approval.");
  selectMergeMethod(candidate);
}

function verifyMergeReceipt(
  receipt: MergeReceipt,
  request: MergeCandidateRequest,
  method: string,
): void {
  if (
    receipt.repository !== request.repository ||
    receipt.number !== request.number ||
    receipt.issueNumber !== request.issueNumber ||
    receipt.nodeId !== request.nodeId ||
    receipt.method !== method ||
    receipt.baseBranch !== request.expectedBaseBranch ||
    receipt.baseSha !== request.expectedBaseSha ||
    receipt.headBranch !== request.expectedHeadBranch ||
    receipt.headSha !== request.expectedHeadSha
  )
    throw new Error(
      "Merge receipt does not match the exact approved candidate.",
    );
}

function effectKey(
  run: RunRecord,
  stage: "staging" | "smoke" | "done",
): string {
  return `run:${run.id}:rework:${run.reworkEpoch}:${stage}:${run.revision}`;
}

async function schedule(
  coordinator: DeliveryCoordinator,
  run: RunRecord,
  key: string,
  kind: "merge" | "observe_staging" | "smoke" | "project_done",
  intent: unknown,
  now: () => string,
): Promise<ScheduledEffect> {
  const created = await coordinator.createEffectIntent({
    runId: run.id,
    expectedRevision: run.revision,
    key,
    kind,
    intent,
    dispatch: false,
    at: now(),
  });
  if (created.status !== "pending") return { effect: created, started: false };
  return {
    effect: await coordinator.beginEffect({
      effectKey: key,
      expectedRevision: run.revision,
      at: now(),
    }),
    started: true,
  };
}

async function handoff(
  coordinator: DeliveryCoordinator,
  run: RunRecord,
  reason: string,
  now: () => string,
): Promise<DeliveryStageResult> {
  try {
    const next = await coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision,
      trigger: "handoff_required",
      summary: { text: bounded(reason) },
      requiredAction: bounded(reason),
      at: now(),
    });
    return { kind: "human", run: next, reason: bounded(reason) };
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run };
    return { kind: "human", run, reason: bounded(reason) };
  }
}

async function failEffect(
  coordinator: DeliveryCoordinator,
  run: RunRecord,
  effect: EffectRecord,
  trigger: "delivery_failed" | "smoke_failed" | "done_projection_failed",
  reason: string,
  receipt: unknown,
  now: () => string,
): Promise<DeliveryStageResult> {
  try {
    const settled = await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome: "failed",
      trigger,
      evidence: bounded(reason),
      requiredAction: bounded(reason),
      receipt,
      at: now(),
    });
    return { kind: "human", run: settled.run, reason: bounded(reason) };
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run };
    return handoff(
      coordinator,
      run,
      `${reason} Durable settlement failed closed.`,
      now,
    );
  }
}

/** Execute the coordinator-owned exact merge edge. */
export async function executeMergeStage(
  input: ExecuteMergeStageInput,
): Promise<DeliveryStageResult> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.run.state !== "merging") return { kind: "stale", run: input.run };
  const key = `run:${input.run.id}:rework:${input.run.reworkEpoch}:merge`;
  let request: ReturnType<typeof mergeRequestFromRun>;
  try {
    request = mergeRequestFromRun(input.run, key);
  } catch (error) {
    return failEffect(
      input.coordinator,
      input.run,
      { key, runId: input.run.id } as EffectRecord,
      "delivery_failed",
      errorMessage(error),
      { kind: "invalid_merge_facts" },
      now,
    );
  }
  let scheduled: ScheduledEffect;
  try {
    scheduled = await schedule(
      input.coordinator,
      input.run,
      key,
      "merge",
      {
        repository: input.run.repository,
        pullRequestNumber: input.run.pullRequestNumber,
        pullRequestNodeId: input.run.pullRequestNodeId,
        pullRequestUrl: input.run.pullRequestUrl,
        branch: input.run.branch,
        baseSha: input.run.baseSha,
        headSha: input.run.headSha,
      },
      now,
    );
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: input.run };
    return handoff(
      input.coordinator,
      input.run,
      `Merge scheduling failed closed: ${errorMessage(error)}`,
      now,
    );
  }
  if (!scheduled.started) {
    if (scheduled.effect.status === "in_flight")
      return { kind: "pending", run: input.run, effectKey: key };
    if (scheduled.effect.status === "ambiguous")
      return handoff(
        input.coordinator,
        input.run,
        `Merge effect ${key} requires reconciliation before retry.`,
        now,
      );
    return { kind: "stale", run: input.run };
  }

  let merged: MergeReceipt;
  let mutationAttempted = false;
  try {
    const { effectKey: _effectKey, ...candidateRequest } = request;
    const observed = assertMergeCandidateReceipt(
      await input.gateway.readMergeCandidate(candidateRequest),
    );
    verifyCandidate(observed, candidateRequest);
    const method = selectMergeMethod(observed);
    mutationAttempted = true;
    const receipt = assertMergeReceipt(
      await input.gateway.mergePullRequest({ ...request, method }),
    );
    verifyMergeReceipt(receipt, candidateRequest, method);
    merged = receipt;
  } catch (error) {
    if (mutationAttempted || isAmbiguous(error))
      return failEffect(
        input.coordinator,
        input.run,
        scheduled.effect,
        "delivery_failed",
        `Merge mutation outcome is ambiguous; the effect is not retried: ${redacted(errorMessage(error))}`,
        { kind: "ambiguous_merge" },
        now,
      );
    return failEffect(
      input.coordinator,
      input.run,
      scheduled.effect,
      "delivery_failed",
      `Merge failed closed: ${errorMessage(error)}`,
      { kind: "merge_failed" },
      now,
    );
  }

  let settled: Awaited<ReturnType<WorkflowCoordinator["settleExecution"]>>;
  try {
    settled = await input.coordinator.settleExecution({
      runId: input.run.id,
      expectedRevision: input.run.revision,
      effectKey: scheduled.effect.key,
      outcome: "confirmed",
      trigger: "merge_observed",
      deliveryFacts: { mergeSha: merged.mergeSha },
      receipt: merged,
      evidence:
        "Merged the exact approved candidate and observed the merge SHA.",
      at: now(),
    });
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: input.run };
    return failEffect(
      input.coordinator,
      input.run,
      scheduled.effect,
      "delivery_failed",
      `Merge receipt was obtained but durable settlement failed; the external outcome is ambiguous and the effect will not be retried: ${redacted(errorMessage(error))}`,
      { kind: "ambiguous_merge_settlement", mergeSha: merged.mergeSha },
      now,
    );
  }

  const stagingKey = effectKey(settled.run, "staging");
  try {
    await input.coordinator.createEffectIntent({
      runId: settled.run.id,
      expectedRevision: settled.run.revision,
      key: stagingKey,
      kind: "observe_staging",
      intent: {
        runId: settled.run.id,
        reworkEpoch: settled.run.reworkEpoch,
        repository: settled.run.repository,
        workflow: input.configuration.workflow,
        environment: input.configuration.environment,
        mergeSha: merged.mergeSha,
      },
      dispatch: false,
      at: now(),
    });
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: settled.run };
    return handoff(
      input.coordinator,
      settled.run,
      `Staging observation could not be scheduled: ${errorMessage(error)}`,
      now,
    );
  }
  return {
    kind: "merged",
    run: settled.run,
    merge: merged,
    stagingEffectKey: stagingKey,
  };
}

function stagingRequest(
  run: RunRecord,
  configuration: DeliveryConfiguration,
): ObserveStagingRequest {
  if (!SHA_PATTERN.test(run.mergeSha ?? ""))
    throw new Error("Staging requires the durable merge SHA.");
  const error = configError(configuration);
  if (error !== undefined) throw new Error(error);
  return assertObserveStagingRequest({
    repository: run.repository,
    workflow: configuration.workflow,
    environment: configuration.environment,
    mergeSha: run.mergeSha,
  });
}

/** Observe the configured staging workflow and exact deployed merge SHA. */
export async function executeStagingStage(
  input: ExecuteStagingStageInput,
): Promise<DeliveryStageResult> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.run.state !== "waiting_for_staging")
    return { kind: "stale", run: input.run };
  let request: ObserveStagingRequest;
  try {
    request = stagingRequest(input.run, input.configuration);
  } catch (error) {
    return handoff(
      input.coordinator,
      input.run,
      `Staging configuration failed closed: ${errorMessage(error)}`,
      now,
    );
  }
  const key = effectKey(input.run, "staging");
  let scheduled: ScheduledEffect;
  try {
    scheduled = await schedule(
      input.coordinator,
      input.run,
      key,
      "observe_staging",
      { runId: input.run.id, reworkEpoch: input.run.reworkEpoch, ...request },
      now,
    );
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: input.run };
    return handoff(
      input.coordinator,
      input.run,
      `Staging scheduling failed closed: ${errorMessage(error)}`,
      now,
    );
  }
  if (!scheduled.started) {
    if (scheduled.effect.status === "in_flight")
      return { kind: "pending", run: input.run, effectKey: key };
    if (scheduled.effect.status === "ambiguous")
      return handoff(
        input.coordinator,
        input.run,
        `Staging effect ${key} requires reconciliation before retry.`,
        now,
      );
    return { kind: "stale", run: input.run };
  }
  let observed: StagingObservation;
  try {
    observed = assertStagingObservation(
      await input.gateway.observeStaging(request),
    );
    if (
      observed.repository !== request.repository ||
      observed.workflow !== request.workflow ||
      observed.environment !== request.environment ||
      observed.mergeSha !== request.mergeSha
    )
      throw new Error(
        "Staging observation is not bound to the configured target and merge SHA.",
      );
  } catch (error) {
    return failEffect(
      input.coordinator,
      input.run,
      scheduled.effect,
      "delivery_failed",
      `Staging observation failed closed: ${errorMessage(error)}`,
      { kind: "staging_failed" },
      now,
    );
  }
  if (observed.outcome === "pending") {
    try {
      await input.coordinator.releaseEffectForRetry({
        runId: input.run.id,
        expectedRevision: input.run.revision,
        effectKey: key,
        evidence:
          "Staging is still pending; the observation lease was released for a later poll.",
        at: now(),
      });
      return { kind: "pending", run: input.run, effectKey: key };
    } catch (error) {
      if (isStale(error)) return { kind: "stale", run: input.run };
      return failEffect(
        input.coordinator,
        input.run,
        scheduled.effect,
        "delivery_failed",
        `Staging pending lease failed: ${errorMessage(error)}`,
        { observed },
        now,
      );
    }
  }
  if (observed.outcome !== "deployed")
    return failEffect(
      input.coordinator,
      input.run,
      scheduled.effect,
      "delivery_failed",
      observed.outcome === "sha_mismatch"
        ? "Staging deployed a different SHA than the durable merge."
        : "Staging workflow or deployment failed.",
      { observed },
      now,
    );
  let settled: Awaited<ReturnType<WorkflowCoordinator["settleExecution"]>>;
  try {
    settled = await input.coordinator.settleExecution({
      runId: input.run.id,
      expectedRevision: input.run.revision,
      effectKey: key,
      outcome: "confirmed",
      trigger: "staging_succeeded",
      receipt: observed,
      evidence: "Staging deployed the exact durable merge SHA.",
      at: now(),
    });
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: input.run };
    return handoff(
      input.coordinator,
      input.run,
      `Staging settlement failed closed: ${errorMessage(error)}`,
      now,
    );
  }
  const smokeKey = effectKey(settled.run, "smoke");
  try {
    await input.coordinator.createEffectIntent({
      runId: settled.run.id,
      expectedRevision: settled.run.revision,
      key: smokeKey,
      kind: "smoke",
      intent: {
        runId: settled.run.id,
        reworkEpoch: settled.run.reworkEpoch,
        repository: settled.run.repository,
        mergeSha: settled.run.mergeSha,
        command: input.configuration.smokeCommand,
      },
      dispatch: false,
      at: now(),
    });
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: settled.run };
    return handoff(
      input.coordinator,
      settled.run,
      `Smoke could not be scheduled: ${errorMessage(error)}`,
      now,
    );
  }
  return {
    kind: "staged",
    run: settled.run,
    staging: observed,
    smokeEffectKey: smokeKey,
  };
}

function smokeReceipt(result: SmokeRunnerResult): SmokeReceipt {
  if (
    !isRecord(result) ||
    (result.outcome !== "passed" && result.outcome !== "failed")
  )
    throw new Error("Smoke runner returned an invalid outcome.");
  const exitCode = result.exitCode;
  if (
    exitCode !== undefined &&
    exitCode !== null &&
    (!Number.isSafeInteger(exitCode) || exitCode < 0)
  )
    throw new Error("Smoke runner returned an invalid exit code.");
  const durationMs = result.durationMs;
  if (
    durationMs !== undefined &&
    durationMs !== null &&
    (!Number.isSafeInteger(durationMs) || durationMs < 0)
  )
    throw new Error("Smoke runner returned an invalid duration.");
  return {
    outcome: result.outcome,
    exitCode: exitCode ?? null,
    durationMs: durationMs ?? null,
    summary:
      result.output === undefined
        ? `Smoke ${result.outcome}.`
        : redacted(result.output),
  };
}

/** Run the injected bounded smoke edge and only persist its redacted receipt. */
export async function executeSmokeStage(
  input: ExecuteSmokeStageInput,
): Promise<DeliveryStageResult> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.run.state !== "smoking") return { kind: "stale", run: input.run };
  const error = configError(input.configuration);
  if (error !== undefined || !SHA_PATTERN.test(input.run.mergeSha ?? ""))
    return handoff(
      input.coordinator,
      input.run,
      error ?? "Smoke requires the durable merge SHA.",
      now,
    );
  const key = effectKey(input.run, "smoke");
  let scheduled: ScheduledEffect;
  try {
    scheduled = await schedule(
      input.coordinator,
      input.run,
      key,
      "smoke",
      {
        runId: input.run.id,
        reworkEpoch: input.run.reworkEpoch,
        repository: input.run.repository,
        mergeSha: input.run.mergeSha,
        command: input.configuration.smokeCommand,
      },
      now,
    );
  } catch (scheduleError) {
    if (isStale(scheduleError)) return { kind: "stale", run: input.run };
    return handoff(
      input.coordinator,
      input.run,
      `Smoke scheduling failed closed: ${errorMessage(scheduleError)}`,
      now,
    );
  }
  if (!scheduled.started) {
    if (scheduled.effect.status === "in_flight")
      return { kind: "pending", run: input.run, effectKey: key };
    if (scheduled.effect.status === "ambiguous")
      return handoff(
        input.coordinator,
        input.run,
        `Smoke effect ${key} requires reconciliation; it will not be rerun.`,
        now,
      );
    return { kind: "stale", run: input.run };
  }
  let receipt: SmokeReceipt;
  try {
    const result = await input.smokeRunner.run({
      command: input.configuration.smokeCommand,
      timeoutMs: input.configuration.smokeTimeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS,
      runId: input.run.id,
      mergeSha: input.run.mergeSha as string,
    });
    receipt = smokeReceipt(result);
  } catch (runnerError) {
    return failEffect(
      input.coordinator,
      input.run,
      scheduled.effect,
      "delivery_failed",
      `Smoke execution outcome is ambiguous and will not be rerun: ${redacted(errorMessage(runnerError))}`,
      { kind: "ambiguous_smoke" },
      now,
    );
  }
  if (receipt.outcome === "failed")
    return failEffect(
      input.coordinator,
      input.run,
      scheduled.effect,
      "smoke_failed",
      "Configured staging smoke failed.",
      receipt,
      now,
    );
  let settled: Awaited<ReturnType<WorkflowCoordinator["settleExecution"]>>;
  try {
    settled = await input.coordinator.settleExecution({
      runId: input.run.id,
      expectedRevision: input.run.revision,
      effectKey: key,
      outcome: "confirmed",
      trigger: "smoke_succeeded",
      receipt: strictSmokeReceipt(
        receipt,
        input.configuration.smokeCommand,
        input.run.mergeSha as string,
      ),
      evidence: "Configured staging smoke passed for the exact merge SHA.",
      at: now(),
    });
  } catch (settleError) {
    if (isStale(settleError)) return { kind: "stale", run: input.run };
    return failEffect(
      input.coordinator,
      input.run,
      scheduled.effect,
      "delivery_failed",
      `Smoke passed but durable settlement failed; the external outcome is ambiguous and will not be rerun: ${redacted(errorMessage(settleError))}`,
      { kind: "ambiguous_smoke_settlement" },
      now,
    );
  }
  const doneKey = effectKey(settled.run, "done");
  try {
    const { effectKey: _effectKey, ...doneIntent } = doneRequest(
      settled.run,
      input.configuration,
      doneKey,
    );
    await input.coordinator.createEffectIntent({
      runId: settled.run.id,
      expectedRevision: settled.run.revision,
      key: doneKey,
      kind: "project_done",
      intent: doneIntent,
      dispatch: false,
      at: now(),
    });
  } catch (doneError) {
    if (isStale(doneError)) return { kind: "stale", run: settled.run };
    return handoff(
      input.coordinator,
      settled.run,
      `Done projection could not be scheduled: ${errorMessage(doneError)}`,
      now,
    );
  }
  return {
    kind: "smoked",
    run: settled.run,
    smoke: receipt,
    doneEffectKey: doneKey,
  };
}

function doneRequest(
  run: RunRecord,
  configuration: DeliveryConfiguration,
  effectKeyValue: string,
): ConditionalProjectDoneMoveRequest {
  const error = doneConfigError(configuration);
  if (error !== undefined) throw new Error(error);
  if (!SHA_PATTERN.test(run.mergeSha ?? ""))
    throw new Error("Done projection requires the durable merge SHA.");
  return assertConditionalProjectDoneMoveRequest({
    repository: run.repository,
    projectId: configuration.projectId,
    projectNumber: configuration.projectNumber,
    itemId: run.projectItemId,
    issueNodeId: run.issueNodeId,
    issueNumber: run.issueNumber,
    expectedRevision: configuration.expectedProjectRevision,
    fromStatus: configuration.reviewStatus,
    toStatus: configuration.doneStatus,
    effectKey: effectKeyValue,
    mergeSha: run.mergeSha,
  });
}

function assertDoneResult(
  result: ProjectDoneMoveResult,
  request: ConditionalProjectDoneMoveRequest,
): unknown {
  if (result.outcome === "rejected")
    throw new Error(`Project Done projection rejected: ${result.reason.kind}.`);
  if (!isRecord(result.item))
    throw new Error("Project Done projection returned a malformed item.");
  if (
    result.item.repository !== request.repository ||
    result.item.projectId !== request.projectId ||
    result.item.projectNumber !== request.projectNumber ||
    result.item.projectItemId !== request.itemId ||
    result.item.issueNodeId !== request.issueNodeId ||
    result.item.issueNumber !== request.issueNumber ||
    result.item.status !== request.toStatus
  )
    throw new Error(
      "Project Done projection receipt is not bound to the requested item.",
    );
  return result.item;
}

/** Conditionally project the linked item to Done only after smoke success. */
export async function executeProjectDoneStage(
  input: ExecuteProjectDoneStageInput,
): Promise<DeliveryStageResult> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.run.state !== "completing")
    return { kind: "stale", run: input.run };
  const key = effectKey(input.run, "done");
  let request: ConditionalProjectDoneMoveRequest;
  try {
    request = doneRequest(input.run, input.configuration, key);
  } catch (error) {
    return handoff(
      input.coordinator,
      input.run,
      `Done projection configuration failed closed: ${errorMessage(error)}`,
      now,
    );
  }
  let scheduled: ScheduledEffect;
  try {
    const { effectKey: _effectKey, ...doneIntent } = request;
    scheduled = await schedule(
      input.coordinator,
      input.run,
      key,
      "project_done",
      doneIntent,
      now,
    );
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: input.run };
    return handoff(
      input.coordinator,
      input.run,
      `Done projection scheduling failed closed: ${errorMessage(error)}`,
      now,
    );
  }
  if (!scheduled.started) {
    if (scheduled.effect.status === "in_flight")
      return { kind: "pending", run: input.run, effectKey: key };
    if (scheduled.effect.status === "ambiguous")
      return handoff(
        input.coordinator,
        input.run,
        `Done effect ${key} requires reconciliation before retry.`,
        now,
      );
    return { kind: "stale", run: input.run };
  }
  let item: unknown;
  try {
    item = assertDoneResult(
      await input.gateway.moveProjectItemToDone(request),
      request,
    );
  } catch (error) {
    return failEffect(
      input.coordinator,
      input.run,
      scheduled.effect,
      "done_projection_failed",
      `Done projection failed closed: ${errorMessage(error)}`,
      { kind: "done_projection_failed" },
      now,
    );
  }
  try {
    const settled = await input.coordinator.settleExecution({
      runId: input.run.id,
      expectedRevision: input.run.revision,
      effectKey: key,
      outcome: "confirmed",
      trigger: "done_observed",
      receipt: { outcome: "moved", item },
      evidence: "Project item is conditionally recorded as Done.",
      at: now(),
    });
    return { kind: "done", run: settled.run, item };
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: input.run };
    return failEffect(
      input.coordinator,
      input.run,
      scheduled.effect,
      "delivery_failed",
      `Done projection receipt was obtained but durable settlement failed; the external outcome is ambiguous and will not be retried: ${redacted(errorMessage(error))}`,
      { kind: "ambiguous_done_settlement" },
      now,
    );
  }
}

function mergeIntentRequest(
  effect: EffectRecord,
  run?: RunRecord,
): (MergeCandidateRequest & { readonly effectKey: string }) | undefined {
  const intent = parseStrictIntent(effect, "merge", [
    "repository",
    "pullRequestNumber",
    "pullRequestNodeId",
    "pullRequestUrl",
    "branch",
    "baseSha",
    "headSha",
    "expectedTitle",
    "baseBranch",
    "issueNumber",
  ]);
  if (intent === undefined) return undefined;
  const issueNumber = positiveInteger(intent.issueNumber)
    ? intent.issueNumber
    : run?.issueNumber;
  const expectedTitle = text(intent.expectedTitle, 2_000)
    ? intent.expectedTitle
    : run?.pullRequestTitle;
  const baseBranch = text(intent.baseBranch, 512)
    ? intent.baseBranch
    : run?.baseBranch;
  if (
    !text(intent.repository, 256) ||
    !positiveInteger(intent.pullRequestNumber) ||
    !text(intent.pullRequestNodeId, 256) ||
    !positiveInteger(issueNumber) ||
    !text(expectedTitle, 2_000) ||
    !text(baseBranch, 512) ||
    !SHA_PATTERN.test(String(intent.baseSha)) ||
    !SHA_PATTERN.test(String(intent.headSha)) ||
    !BRANCH_PATTERN.test(String(intent.branch))
  )
    return undefined;
  const request = {
    repository: intent.repository,
    number: intent.pullRequestNumber,
    issueNumber,
    nodeId: intent.pullRequestNodeId,
    expectedTitle,
    expectedBaseBranch: baseBranch,
    expectedBaseSha: intent.baseSha as string,
    expectedHeadBranch: intent.branch as string,
    expectedHeadSha: intent.headSha as string,
    effectKey: effect.key,
  };
  if (
    run !== undefined &&
    (request.repository !== run.repository ||
      request.number !== run.pullRequestNumber ||
      request.issueNumber !== run.issueNumber ||
      request.nodeId !== run.pullRequestNodeId ||
      request.expectedTitle !== run.pullRequestTitle ||
      request.expectedBaseBranch !== run.baseBranch ||
      request.expectedBaseSha !== run.baseSha ||
      request.expectedHeadBranch !== run.branch ||
      request.expectedHeadSha !== run.headSha)
  )
    return undefined;
  return request;
}

async function dispatchEffect(
  effect: EffectRecord,
  gateway: GitHubDeliveryGateway,
  configuration: DeliveryConfiguration,
  smokeRunner: SmokeRunner,
  resolveRun?: DeliveryCapabilityOptions["resolveRun"],
): Promise<unknown> {
  if (effect.kind === "merge") {
    let run: RunRecord | undefined;
    if (resolveRun !== undefined) {
      try {
        run = await resolveRun(effect);
      } catch {
        return {
          outcome: "failed",
          evidence: `Durable run facts were unavailable for merge ${effect.key}.`,
        };
      }
    }
    const request = mergeIntentRequest(effect, run);
    if (request === undefined)
      return {
        outcome: "failed",
        evidence: `Invalid merge intent for ${effect.key}.`,
      };
    let mutationAttempted = false;
    try {
      const { effectKey: _effectKey, ...candidateRequest } = request;
      const candidate = assertMergeCandidateReceipt(
        await gateway.readMergeCandidate(candidateRequest),
      );
      verifyCandidate(candidate, candidateRequest);
      const method = selectMergeMethod(candidate);
      mutationAttempted = true;
      const receipt = assertMergeReceipt(
        await gateway.mergePullRequest({ ...request, method }),
      );
      verifyMergeReceipt(receipt, candidateRequest, method);
      return {
        outcome: "confirmed",
        trigger: "merge_observed",
        receipt,
        evidence: `Merge ${effect.key} confirmed.`,
      };
    } catch (error) {
      if (mutationAttempted || isAmbiguous(error))
        return {
          outcome: "ambiguous",
          evidence: `Merge ${effect.key} is ambiguous and requires reconciliation; it will not be retried.`,
        };
      return {
        outcome: "failed",
        trigger: "delivery_failed",
        evidence: `Merge ${effect.key} failed closed.`,
      };
    }
  }
  if (effect.kind === "observe_staging") {
    const intent = parseStrictIntent(effect, "observe_staging", [
      "runId",
      "reworkEpoch",
      "repository",
      "workflow",
      "environment",
      "mergeSha",
    ]);
    if (
      intent === undefined ||
      !text(intent.repository, 256) ||
      !text(intent.workflow, 512) ||
      !text(intent.environment, 256) ||
      !SHA_PATTERN.test(String(intent.mergeSha))
    )
      return {
        outcome: "failed",
        evidence: `Invalid staging intent for ${effect.key}.`,
      };
    try {
      const observation = assertStagingObservation(
        await gateway.observeStaging(
          assertObserveStagingRequest({
            repository: intent.repository,
            workflow: intent.workflow,
            environment: intent.environment,
            mergeSha: intent.mergeSha,
          }),
        ),
      );
      if (observation.outcome === "pending")
        return {
          outcome: "ambiguous",
          evidence: `Staging ${effect.key} remains pending.`,
        };
      if (observation.outcome !== "deployed")
        return {
          outcome: "failed",
          trigger: "delivery_failed",
          evidence: `Staging ${effect.key} failed or deployed a different SHA.`,
        };
      return {
        outcome: "confirmed",
        trigger: "staging_succeeded",
        receipt: observation,
        evidence: `Staging ${effect.key} confirmed.`,
      };
    } catch {
      return {
        outcome: "failed",
        trigger: "delivery_failed",
        evidence: `Staging ${effect.key} failed closed.`,
      };
    }
  }
  if (effect.kind === "smoke") {
    const intent = parseStrictIntent(effect, "smoke", [
      "runId",
      "reworkEpoch",
      "repository",
      "mergeSha",
      "command",
    ]);
    if (
      intent === undefined ||
      !text(intent.runId, 512) ||
      !SHA_PATTERN.test(String(intent.mergeSha)) ||
      !text(intent.command, MAX_COMMAND_BYTES)
    )
      return {
        outcome: "failed",
        evidence: `Invalid smoke intent for ${effect.key}.`,
      };
    try {
      const receipt = smokeReceipt(
        await smokeRunner.run({
          command: intent.command,
          timeoutMs: configuration.smokeTimeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS,
          runId: intent.runId,
          mergeSha: intent.mergeSha as string,
        }),
      );
      return receipt.outcome === "passed"
        ? {
            outcome: "confirmed",
            trigger: "smoke_succeeded",
            receipt: strictSmokeReceipt(
              receipt,
              intent.command,
              intent.mergeSha as string,
            ),
            evidence: `Smoke ${effect.key} passed.`,
          }
        : {
            outcome: "failed",
            trigger: "smoke_failed",
            receipt,
            evidence: `Smoke ${effect.key} failed.`,
          };
    } catch {
      return {
        outcome: "ambiguous",
        evidence: `Smoke ${effect.key} is ambiguous and will not be rerun.`,
      };
    }
  }
  if (effect.kind === "project_done") {
    const intent = parseStrictIntent(effect, "project_done", [
      "runId",
      "reworkEpoch",
      "repository",
      "projectId",
      "projectNumber",
      "itemId",
      "issueNodeId",
      "issueNumber",
      "expectedRevision",
      "fromStatus",
      "toStatus",
      "mergeSha",
    ]);
    if (intent === undefined)
      return {
        outcome: "failed",
        evidence: `Invalid Done intent for ${effect.key}.`,
      };
    try {
      const request = assertConditionalProjectDoneMoveRequest({
        ...intent,
        effectKey: effect.key,
      });
      const result = await gateway.moveProjectItemToDone(request);
      const item = assertDoneResult(result, request);
      return {
        outcome: "confirmed",
        trigger: "done_observed",
        receipt: { outcome: result.outcome, item },
        evidence: `Done projection ${effect.key} confirmed.`,
      };
    } catch {
      return {
        outcome: "failed",
        trigger: "done_projection_failed",
        evidence: `Done projection ${effect.key} failed closed.`,
      };
    }
  }
  return {
    outcome: "failed",
    evidence: `Unsupported delivery effect ${effect.kind}.`,
  };
}

async function observeEffect(
  effect: EffectRecord,
  gateway: GitHubDeliveryGateway,
  _configuration: DeliveryConfiguration,
): Promise<unknown> {
  if (effect.kind === "merge")
    return {
      outcome: "failed",
      trigger: "delivery_failed",
      evidence: `Ambiguous merge ${effect.key} was not retried; Review must reconcile the external merge.`,
    };
  if (effect.kind === "smoke")
    return {
      outcome: "failed",
      trigger: "delivery_failed",
      evidence: `Ambiguous smoke ${effect.key} was not rerun; Review must reconcile the external smoke.`,
    };
  if (effect.kind === "observe_staging") {
    const intent = parseStrictIntent(effect, "observe_staging", [
      "runId",
      "reworkEpoch",
      "repository",
      "workflow",
      "environment",
      "mergeSha",
    ]);
    if (intent === undefined)
      return {
        outcome: "failed",
        trigger: "delivery_failed",
        evidence: `Invalid staging intent ${effect.key}.`,
      };
    try {
      const observation = assertStagingObservation(
        await gateway.observeStaging({
          repository: intent.repository as string,
          workflow: intent.workflow as string,
          environment: intent.environment as string,
          mergeSha: intent.mergeSha as string,
        }),
      );
      if (observation.outcome === "deployed")
        return {
          outcome: "confirmed",
          trigger: "reconciled_staging",
          receipt: observation,
          evidence: `Staging ${effect.key} reconciled.`,
        };
      if (observation.outcome === "pending")
        return {
          outcome: "ambiguous",
          evidence: `Staging ${effect.key} remains pending.`,
        };
      return {
        outcome: "failed",
        trigger: "delivery_failed",
        evidence: `Staging ${effect.key} definitively failed.`,
      };
    } catch {
      return {
        outcome: "ambiguous",
        evidence: `Staging ${effect.key} could not be reconciled.`,
      };
    }
  }
  if (effect.kind === "project_done") {
    const intent = parseStrictIntent(effect, "project_done", [
      "runId",
      "reworkEpoch",
      "repository",
      "projectId",
      "projectNumber",
      "itemId",
      "issueNodeId",
      "issueNumber",
      "expectedRevision",
      "fromStatus",
      "toStatus",
      "mergeSha",
    ]);
    if (intent === undefined)
      return {
        outcome: "failed",
        trigger: "delivery_failed",
        evidence: `Invalid Done intent ${effect.key}.`,
      };
    try {
      const request = assertConditionalProjectDoneMoveRequest({
        ...intent,
        effectKey: effect.key,
      });
      const item = assertDoneResult(
        await gateway.moveProjectItemToDone(request),
        request,
      );
      return {
        outcome: "confirmed",
        trigger: "reconciled_done",
        receipt: { outcome: "already_applied", item },
        evidence: `Done ${effect.key} reconciled.`,
      };
    } catch {
      return {
        outcome: "failed",
        trigger: "delivery_failed",
        evidence: `Done ${effect.key} could not be reconciled.`,
      };
    }
  }
  return {
    outcome: "failed",
    trigger: "delivery_failed",
    evidence: `Unsupported ambiguous delivery effect ${effect.kind}.`,
  };
}

/** Build coordinator-owned delivery adapters for startup dispatch and restart reconciliation. */
export function createDeliveryCapability(
  gateway: GitHubDeliveryGateway,
  configuration: DeliveryConfiguration,
  smokeRunner: SmokeRunner,
  options: DeliveryCapabilityOptions = {},
): DeliveryCapability {
  return {
    dispatcher: async (effect) =>
      dispatchEffect(
        effect,
        gateway,
        configuration,
        smokeRunner,
        options.resolveRun,
      ),
    observer: async (effect) => observeEffect(effect, gateway, configuration),
  };
}

export const executeMerge = executeMergeStage;
export const observeStaging = executeStagingStage;
export const executeStaging = executeStagingStage;
export const runSmoke = executeSmokeStage;
export const executeSmoke = executeSmokeStage;
export const projectDone = executeProjectDoneStage;
export const executeDone = executeProjectDoneStage;
