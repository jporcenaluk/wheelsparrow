import { createHash, randomUUID } from "node:crypto";
import type { Transaction } from "kysely";
import type { DatabaseConnection } from "../database/connection.js";
import {
  createEffectMutationRepository,
  type EffectInsertResult,
  type EffectObservation,
  type EffectRecord,
  listUnresolvedForReconciliation,
  type NewEffectIntent,
  StaleEffectError,
} from "../database/effects.js";
import {
  type ApprovalRecord,
  type CreateClaimInput,
  createRunMutationRepository,
  type DeliveryFactsPatch,
  type ExecutionFactsPatch,
  type NewFindingRecord,
  type NewStepRecord,
  type PublicationFactsPatch,
  type RunRecord,
  readRun,
  type SchedulerControl,
  type SchedulerControlUpdateRequest,
  StaleRevisionError,
  type TransitionRequest,
} from "../database/runs.js";
import type { DatabaseSchema, SideEffectsTable } from "../database/schema.js";
import {
  assertEffectObservationTrigger,
  CODING_STATES,
  type EffectKind,
  type EffectStatus,
  WORKFLOW_TRIGGERS,
  type WorkflowTrigger,
} from "./state.js";

export interface EffectResult {
  outcome: "confirmed" | "failed" | "ambiguous";
  trigger?: WorkflowTrigger | null;
  receipt?: unknown;
  evidence?: string;
}

export type EffectCompletion = (result: unknown) => void | Promise<void>;

/** A test seam for a concrete external-effect adapter. */
export interface EffectDispatcher {
  dispatch(effect: EffectRecord, complete: EffectCompletion): unknown;
}

/** A test seam for observing effects that survived a process restart. */
export interface EffectObserver {
  observe(effect: EffectRecord, complete: EffectCompletion): unknown;
}

export type EffectDispatcherLike =
  | EffectDispatcher
  | ((effect: EffectRecord, complete: EffectCompletion) => unknown);

export type EffectObserverLike =
  | EffectObserver
  | ((effect: EffectRecord, complete: EffectCompletion) => unknown);

export interface EffectIntentCommand
  extends Omit<NewEffectIntent, "targetRevision"> {
  targetRevision?: number;
  /** Keep a durable pending intent when false; otherwise begin dispatch. */
  dispatch?: boolean;
}

export interface TransitionCommandOptions {
  effect?: EffectIntentCommand;
}

export interface CreateClaimOptions {
  effect?: EffectIntentCommand;
}

/** A human operator's bounded request to queue or reserve one review run. */
export interface ReturnToTodoCommand {
  runId: string;
  expectedRevision: number;
  feedback: string;
  at?: string;
}

export interface BeginEffectCommand {
  effectKey: string;
  expectedRevision?: number;
  at?: string;
}

export interface ReleaseEffectForRetryCommand {
  effectKey: string;
  runId: string;
  expectedRevision: number;
  evidence: string;
  at?: string;
}

export interface CancelEffectCommand {
  effectKey: string;
  reason: string;
  expectedRevision?: number;
  at?: string;
}

export interface RejectClaimCommand {
  runId: string;
  effectKey: string;
  expectedRevision: number;
  reason: string;
  at?: string;
}

export interface ObserveEffectCommand extends EffectObservation {
  at?: string;
}

/**
 * Settle one execution effect and persist the facts produced by that same
 * edge. All optional writes happen before the existing effect observation
 * transition, inside one coordinator-owned transaction.
 */
export interface ExecutionSettlementCommand {
  runId: string;
  expectedRevision: number;
  effectKey: string;
  outcome: EffectObservation["outcome"];
  trigger?: WorkflowTrigger | null;
  receipt?: unknown;
  evidence: string;
  at?: string;
  facts?: ExecutionFactsPatch;
  /** PR receipt facts may settle only the coordinator-owned publish effect. */
  publicationFacts?: PublicationFactsPatch;
  /** Merge receipt facts may settle only the coordinator-owned merge effect. */
  deliveryFacts?: DeliveryFactsPatch;
  step?: NewStepRecord;
  /** Findings belong to the review step and are appended in this transaction. */
  findings?: readonly NewFindingRecord[];
  /** Durable operator guidance for a handoff to Review. */
  requiredAction?: string;
}

export interface ExecutionSettlement {
  run: RunRecord;
  effect: EffectRecord;
}

/** A human's exact-head approval and the coordinator-owned merge intent. */
export interface ApproveMergeCommand {
  runId: string;
  expectedRevision: number;
  operator: string;
  approvedHeadSha: string;
  /** The base SHA shown to the operator when approval was granted. */
  observedBaseSha?: string;
  /** Compatibility spelling used by the operator/API contract. */
  approvedBaseSha?: string;
  at?: string;
  /** Override is useful for deterministic callers; the default key is stable. */
  effectKey?: string;
  /** Keep the intent pending for an external dispatcher or test. */
  dispatch?: boolean;
}

export interface MergeApprovalResult {
  run: RunRecord;
  approval: ApprovalRecord;
  effect: EffectRecord;
}

/** Quarantine an in-flight effect and advance its run revision atomically. */
export interface QuarantineEffectCommand extends ObserveEffectCommand {}

export interface ObserveAmbiguousEffectCommand {
  effectKey: string;
  expectedRevision?: number;
}

export interface WorkflowCoordinatorOptions {
  connection: DatabaseConnection;
  ownerToken?: string;
  now?: () => string;
  dispatcher?: EffectDispatcherLike;
  observer?: EffectObserverLike;
  onError?: (error: CoordinatorError) => void;
}

export type CoordinatorErrorCode = "closed" | "stale" | "unexpected";

export interface CoordinatorError {
  code: CoordinatorErrorCode;
  source: "dispatcher" | "observer";
  effectKey: string;
  expectedRevision: number;
  error: Error;
}

export class EffectSettlementTimeoutError extends Error {
  readonly effectKey: string;
  readonly timeoutMs: number;

  constructor(effectKey: string, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for durable effect ${effectKey} to settle.`,
    );
    this.name = "EffectSettlementTimeoutError";
    this.effectKey = effectKey;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Failure observations need a trigger that is legal for the run state at the
 * effect's target revision. Keep this exhaustive with the state-domain effect
 * vocabulary so an adapter failure can never be swallowed by an invalid
 * observation.
 */
const FAILED_EFFECT_TRIGGERS = {
  project_todo: "claim_rejected",
  project_ready: "handoff_required",
  workspace_prepare: "startup_failed",
  intake_capture: "handoff_required",
  agent_build: "builder_exhausted",
  verify: "verification_failed_exhausted",
  agent_review: "review_needs_repair",
  agent_repair: "handoff_required",
  publish: "handoff_required",
  observe_ci: "ci_failed_exhausted",
  project_review: null,
  project_return_todo: "todo_move_rejected",
  merge: "delivery_failed",
  observe_staging: "delivery_failed",
  smoke: "smoke_failed",
  project_done: "done_projection_failed",
} as const satisfies Readonly<Record<EffectKind, WorkflowTrigger | null>>;

const WORKFLOW_TRIGGER_SET = new Set<string>(WORKFLOW_TRIGGERS);
const maximumEvidenceBytes = 4 * 1024;
const maximumJsonBytes = 1024 * 1024;
const maximumSettlementFindings = 32;
const deliveryEffectKinds = new Set<EffectKind>([
  "merge",
  "observe_staging",
  "smoke",
  "project_done",
]);
const deliveryShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const maximumDeliveryReceiptBytes = 1024 * 1024;
const maximumDeliveryTextBytes = 512;
// A fixed event kind plus structured effect-key details is durable quarantine
// state; adapter evidence remains free-form and is never used as a marker.
const quarantinedEffectEventKind = "effect_quarantined";

function boundedEvidence(value: string): string {
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maximumEvidenceBytes)
    result = result.slice(0, -1);
  return result;
}

function mapSideEffect(row: SideEffectsTable): EffectRecord {
  return {
    key: row.key,
    runId: row.run_id,
    reworkEpoch: row.rework_epoch,
    kind: row.kind as EffectKind,
    targetRevision: row.target_revision,
    fingerprint: row.fingerprint,
    intent: row.intent_json,
    status: row.status as EffectStatus,
    executorAttempt: row.executor_attempt,
    executorOwnerToken: row.executor_owner_token,
    receipt: row.receipt_json,
    processId: row.process_id,
    requestId: row.request_id,
    prNumber: row.pr_number,
    prNodeId: row.pr_node_id,
    workflowRunId: row.workflow_run_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failure: row.failure,
    reconciliationEvidence: row.reconciliation_evidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function errorValue(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value))
    return value.every((item) => isJsonValue(item, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every((item) => isJsonValue(item, seen));
}

function canonicalJsonValue(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON number is invalid.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || seen.has(value))
    throw new TypeError("JSON value is invalid or cyclic.");
  seen.add(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJsonValue(item, seen)).join(",")}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError("JSON object is not plain.");
  return `{${Object.keys(value)
    .toSorted()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJsonValue(
          (value as Record<string, unknown>)[key],
          seen,
        )}`,
    )
    .join(",")}}`;
}

function durableIntent(effect: {
  intent_json: string;
  fingerprint: string;
}): Record<string, unknown> {
  if (
    Buffer.byteLength(effect.intent_json, "utf8") > maximumJsonBytes ||
    !/^[0-9a-f]{64}$/u.test(effect.fingerprint)
  )
    throw new TypeError("Delivery effect intent integrity is invalid.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(effect.intent_json) as unknown;
    if (!isJsonValue(parsed)) throw new TypeError("Intent is not JSON data.");
    const canonical = canonicalJsonValue(parsed);
    if (
      canonical !== effect.intent_json ||
      createHash("sha256").update(canonical, "utf8").digest("hex") !==
        effect.fingerprint
    )
      throw new TypeError("Delivery effect intent integrity is invalid.");
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Delivery effect intent integrity is invalid.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  )
    throw new TypeError("Delivery effect intent must be a plain object.");
  return parsed as Record<string, unknown>;
}

function deliveryRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError(`${label} must be a plain object.`);
  try {
    const serialized = JSON.stringify(value);
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > maximumDeliveryReceiptBytes
    )
      throw new TypeError(`${label} exceeds its size limit.`);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${label} must be JSON data.`);
  }
  return value as Record<string, unknown>;
}

function deliveryKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key)))
    throw new TypeError(`${label} contains unsupported fields.`);
}

function deliveryText(
  value: unknown,
  label: string,
  maximum = maximumDeliveryTextBytes,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum
  )
    throw new TypeError(`${label} is invalid.`);
  return value;
}

function deliverySha(value: unknown, label: string): string {
  if (typeof value !== "string" || !deliveryShaPattern.test(value))
    throw new TypeError(`${label} is invalid.`);
  return value;
}

function deliveryNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new TypeError(`${label} is invalid.`);
  return value as number;
}

function equalDelivery(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  if (actual !== expected)
    throw new TypeError(`${label} does not match intent.`);
}

function intentAlias(
  intent: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): unknown {
  for (const key of keys) {
    if (Object.hasOwn(intent, key)) return intent[key];
  }
  throw new TypeError(`Delivery intent is missing ${label}.`);
}

interface DeliveryObservationFacts {
  mergeSha?: string;
}

function validateDeliveryObservation(
  effect: Pick<SideEffectsTable, "kind" | "intent_json" | "fingerprint">,
  run: RunRecord,
  outcome: EffectObservation["outcome"],
  receipt: unknown,
): DeliveryObservationFacts {
  const kind = effect.kind as EffectKind;
  if (!deliveryEffectKinds.has(kind) || outcome !== "confirmed") return {};
  const intent = durableIntent(effect);
  const value = deliveryRecord(receipt, `${kind} receipt`);
  if (kind === "merge") {
    deliveryKeys(
      value,
      [
        "repository",
        "number",
        "issueNumber",
        "nodeId",
        "method",
        "baseBranch",
        "baseSha",
        "headBranch",
        "headSha",
        "mergeSha",
      ],
      "Merge receipt",
    );
    const repository = deliveryText(value.repository, "Merge repository");
    const number = deliveryNumber(value.number, "Merge pull request number");
    const issueNumber = deliveryNumber(value.issueNumber, "Merge issue number");
    const nodeId = deliveryText(value.nodeId, "Merge pull request node ID");
    const baseBranch = deliveryText(value.baseBranch, "Merge base branch");
    const base = deliverySha(value.baseSha, "Merge base SHA");
    const headBranch = deliveryText(value.headBranch, "Merge head branch");
    const head = deliverySha(value.headSha, "Merge head SHA");
    const merged = deliverySha(value.mergeSha, "Merge SHA");
    const expectedNumber = deliveryNumber(
      intentAlias(
        intent,
        ["pullRequestNumber", "number"],
        "pull request number",
      ),
      "Intent pull request number",
    );
    const expectedNodeId = deliveryText(
      intentAlias(
        intent,
        ["pullRequestNodeId", "nodeId"],
        "pull request node ID",
      ),
      "Intent pull request node ID",
    );
    const expectedBase = deliverySha(intent.baseSha, "Intent base SHA");
    const expectedHead = deliverySha(intent.headSha, "Intent head SHA");
    const expectedBranch = deliveryText(intent.branch, "Intent branch");
    equalDelivery(repository, run.repository, "Merge repository");
    equalDelivery(number, expectedNumber, "Merge pull request number");
    equalDelivery(issueNumber, run.issueNumber, "Merge issue number");
    equalDelivery(nodeId, expectedNodeId, "Merge pull request node ID");
    equalDelivery(baseBranch, run.baseBranch, "Merge base branch");
    equalDelivery(base, expectedBase, "Merge base SHA");
    equalDelivery(base, run.baseSha, "Merge base SHA");
    equalDelivery(headBranch, expectedBranch, "Merge head branch");
    equalDelivery(head, expectedHead, "Merge head SHA");
    equalDelivery(head, run.approvedHeadSha ?? run.headSha, "Merge head SHA");
    return { mergeSha: merged };
  }

  const expectedMergeSha = deliverySha(run.mergeSha, "Durable merge SHA");
  const intentMergeSha = deliverySha(intent.mergeSha, "Intent merge SHA");
  equalDelivery(intentMergeSha, expectedMergeSha, "Delivery merge SHA");
  equalDelivery(intent.runId, run.id, "Delivery run ID");
  if (kind === "observe_staging") {
    const expectedWorkflow = deliveryText(intent.workflow, "Staging workflow");
    const expectedEnvironment = deliveryText(
      intent.environment,
      "Staging environment",
    );
    deliveryKeys(
      value,
      [
        "repository",
        "workflow",
        "environment",
        "mergeSha",
        "workflowRun",
        "deployment",
        "outcome",
      ],
      "Staging receipt",
    );
    equalDelivery(value.repository, run.repository, "Staging repository");
    equalDelivery(value.workflow, expectedWorkflow, "Staging workflow");
    equalDelivery(
      value.environment,
      expectedEnvironment,
      "Staging environment",
    );
    equalDelivery(value.mergeSha, expectedMergeSha, "Staging merge SHA");
    if (value.outcome !== "deployed")
      throw new TypeError("Confirmed staging requires a deployed receipt.");
    const workflowRun = deliveryRecord(
      value.workflowRun,
      "Staging workflow run",
    );
    deliveryKeys(
      workflowRun,
      ["id", "workflow", "headSha", "status", "conclusion"],
      "Staging workflow run",
    );
    deliveryText(workflowRun.id, "Staging workflow run ID");
    equalDelivery(
      workflowRun.workflow,
      expectedWorkflow,
      "Staging workflow run",
    );
    equalDelivery(
      workflowRun.headSha,
      expectedMergeSha,
      "Staging workflow SHA",
    );
    equalDelivery(workflowRun.status, "completed", "Staging workflow status");
    equalDelivery(
      workflowRun.conclusion,
      "success",
      "Staging workflow conclusion",
    );
    const deployment = deliveryRecord(value.deployment, "Staging deployment");
    deliveryKeys(
      deployment,
      ["id", "environment", "deployedSha", "state"],
      "Staging deployment",
    );
    deliveryText(deployment.id, "Staging deployment ID");
    equalDelivery(
      deployment.environment,
      expectedEnvironment,
      "Staging deployment environment",
    );
    equalDelivery(
      deployment.deployedSha,
      expectedMergeSha,
      "Staging deployed SHA",
    );
    equalDelivery(deployment.state, "success", "Staging deployment state");
    return {};
  }

  if (kind === "smoke") {
    deliveryKeys(
      value,
      ["outcome", "exitCode", "durationMs", "summary", "command", "mergeSha"],
      "Smoke receipt",
    );
    if (!["passed", "succeeded", "success"].includes(value.outcome as string))
      throw new TypeError("Confirmed smoke requires a successful receipt.");
    const smokeCommand = deliveryText(value.command, "Smoke command");
    const smokeMergeSha = deliverySha(value.mergeSha, "Smoke merge SHA");
    deliveryText(value.summary, "Smoke summary");
    const expectedCommand = deliveryText(intent.command, "Smoke command");
    equalDelivery(smokeCommand, expectedCommand, "Smoke command");
    equalDelivery(smokeMergeSha, expectedMergeSha, "Smoke merge SHA");
    if (
      value.exitCode !== null &&
      value.exitCode !== undefined &&
      value.exitCode !== 0
    )
      throw new TypeError("Confirmed smoke requires exit code zero.");
    if (
      value.durationMs !== null &&
      value.durationMs !== undefined &&
      (!Number.isSafeInteger(value.durationMs) ||
        (value.durationMs as number) < 0)
    )
      throw new TypeError("Smoke duration is invalid.");
    return {};
  }

  deliveryKeys(value, ["outcome", "mergeSha", "item"], "Done receipt");
  if (!["moved", "already_applied"].includes(value.outcome as string))
    throw new TypeError("Confirmed Done projection requires a move receipt.");
  equalDelivery(
    deliverySha(value.mergeSha, "Done merge SHA"),
    expectedMergeSha,
    "Done merge SHA",
  );
  const item = deliveryRecord(value.item, "Done project item");
  const expectedRepository = deliveryText(intent.repository, "Done repository");
  const expectedProjectId = deliveryText(intent.projectId, "Done project ID");
  const expectedProjectNumber = deliveryNumber(
    intent.projectNumber,
    "Done project number",
  );
  const expectedItemId = intentAlias(
    intent,
    ["itemId", "projectItemId"],
    "project item ID",
  );
  equalDelivery(item.repository, expectedRepository, "Done repository");
  equalDelivery(item.projectId, expectedProjectId, "Done project");
  equalDelivery(
    item.projectNumber,
    expectedProjectNumber,
    "Done project number",
  );
  equalDelivery(item.projectItemId, expectedItemId, "Done project item");
  equalDelivery(item.issueNodeId, run.issueNodeId, "Done issue node");
  equalDelivery(item.issueNumber, run.issueNumber, "Done issue number");
  equalDelivery(item.status, intent.toStatus ?? "Done", "Done project status");
  return {};
}

async function recordValidatedObservation(
  tx: Transaction<DatabaseSchema>,
  effect: SideEffectsTable,
  run: RunRecord,
  observation: EffectObservation,
  at: string,
  expectedMergeSha?: string,
): Promise<EffectRecord> {
  const deliveryFacts = validateDeliveryObservation(
    effect,
    run,
    observation.outcome,
    observation.receipt,
  );
  if (
    effect.kind === "merge" &&
    observation.outcome === "confirmed" &&
    expectedMergeSha !== undefined &&
    expectedMergeSha !== deliveryFacts.mergeSha
  )
    throw new TypeError(
      "Merge delivery facts must match the confirmed receipt.",
    );
  if (deliveryFacts.mergeSha !== undefined)
    await createRunMutationRepository(tx).updateDeliveryFacts({
      runId: run.id,
      expectedRevision: observation.expectedRevision,
      facts: { mergeSha: deliveryFacts.mergeSha },
      at,
    });
  return createEffectMutationRepository(tx).recordEffectObservation(
    observation,
    at,
  );
}

function malformedResult(
  effect: EffectRecord,
  source: "dispatcher" | "observer",
  reason: string,
): EffectResult {
  return {
    outcome: "failed",
    trigger: FAILED_EFFECT_TRIGGERS[effect.kind],
    evidence: boundedEvidence(
      `Malformed ${source} result for ${effect.key}: ${reason}`,
    ),
  };
}

function normalizeAdapterResult(
  value: unknown,
  effect: EffectRecord,
  source: "dispatcher" | "observer",
  allowUndefined: boolean,
): EffectResult | undefined {
  if (value === undefined && allowUndefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return malformedResult(effect, source, "result must be an object");
  const result = value as Record<string, unknown>;
  const outcome = result.outcome;
  if (!["confirmed", "failed", "ambiguous"].includes(outcome as string))
    return malformedResult(effect, source, "outcome is invalid");
  const typedOutcome = outcome as EffectResult["outcome"];
  const rawEvidence = result.evidence;
  if (rawEvidence !== undefined && typeof rawEvidence !== "string")
    return malformedResult(effect, source, "evidence must be text");
  if (result.receipt !== undefined) {
    if (!isJsonValue(result.receipt))
      return malformedResult(effect, source, "receipt must be JSON data");
    try {
      const serialized = JSON.stringify(result.receipt);
      if (
        serialized === undefined ||
        Buffer.byteLength(serialized, "utf8") > maximumJsonBytes
      )
        return malformedResult(
          effect,
          source,
          "receipt exceeds the 1 MiB durable JSON limit",
        );
    } catch {
      return malformedResult(effect, source, "receipt must be JSON data");
    }
  }

  const rawTrigger = result.trigger;
  if (
    rawTrigger !== undefined &&
    rawTrigger !== null &&
    (typeof rawTrigger !== "string" || !WORKFLOW_TRIGGER_SET.has(rawTrigger))
  )
    return malformedResult(effect, source, "trigger is invalid");

  let trigger: WorkflowTrigger | null | undefined =
    rawTrigger === null ? null : (rawTrigger as WorkflowTrigger | undefined);
  if (typedOutcome === "ambiguous") {
    if (trigger !== undefined && trigger !== null)
      return malformedResult(
        effect,
        source,
        "ambiguous results require no trigger",
      );
    trigger = null;
  } else if (trigger === undefined) {
    if (typedOutcome === "failed")
      trigger = FAILED_EFFECT_TRIGGERS[effect.kind];
    else if (effect.kind === "project_review") trigger = null;
    else
      return malformedResult(
        effect,
        source,
        "confirmed result requires a trigger",
      );
  }
  try {
    assertEffectObservationTrigger(effect.kind, typedOutcome, trigger ?? null);
  } catch {
    return malformedResult(
      effect,
      source,
      "trigger is not legal for this effect",
    );
  }
  const evidence =
    rawEvidence === undefined || rawEvidence.trim().length === 0
      ? `${source === "dispatcher" ? "Effect" : "Observed effect"} ${effect.key} ${typedOutcome}.`
      : rawEvidence;
  return {
    outcome: typedOutcome,
    ...(trigger === undefined ? {} : { trigger }),
    ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
    evidence: boundedEvidence(evidence),
  };
}

function safeNormalizeAdapterResult(
  value: unknown,
  effect: EffectRecord,
  source: "dispatcher" | "observer",
  allowUndefined: boolean,
): EffectResult | undefined {
  try {
    return normalizeAdapterResult(value, effect, source, allowUndefined);
  } catch (error) {
    return malformedResult(
      effect,
      source,
      `result validation failed: ${errorValue(error).message}`,
    );
  }
}

export class CoordinatorClosedError extends Error {
  constructor() {
    super("The workflow coordinator is closed and rejects new commands.");
    this.name = "CoordinatorClosedError";
  }
}

export class CoordinatorDispatchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CoordinatorDispatchError";
  }
}

function asTimestamp(now: () => string, at: string | undefined): string {
  return at ?? now();
}

function effectResult(
  result: EffectResult,
  effect: EffectRecord,
): EffectResult {
  const evidence = result.evidence ?? `Effect ${effect.key} ${result.outcome}.`;
  const trigger =
    result.outcome === "failed" && result.trigger === undefined
      ? FAILED_EFFECT_TRIGGERS[effect.kind]
      : result.trigger;
  if (evidence.trim().length === 0)
    return {
      ...result,
      evidence: `Effect ${effect.key} ${result.outcome}.`,
      ...(trigger === undefined ? {} : { trigger }),
    };
  return { ...result, evidence, ...(trigger === undefined ? {} : { trigger }) };
}

/**
 * The one serialized owner of workflow writes.
 *
 * Repositories are deliberately created from each transaction rather than
 * retained on the coordinator. This makes it impossible for an external
 * adapter callback to retain a transaction and accidentally write after the
 * transaction has committed.
 */
export class WorkflowCoordinator {
  private readonly connection: DatabaseConnection;
  private readonly ownerToken: string;
  private readonly now: () => string;
  private readonly dispatcher: EffectDispatcherLike | undefined;
  private readonly observer: EffectObserverLike | undefined;
  private readonly onError: ((error: CoordinatorError) => void) | undefined;
  private readonly observationErrors: CoordinatorError[] = [];
  private readonly effectSettlementWaiters = new Map<
    string,
    Set<(effect: EffectRecord) => void>
  >();
  private readonly commandQueue: Array<{
    command: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private accepting = true;
  private draining = false;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: WorkflowCoordinatorOptions) {
    this.connection = options.connection;
    this.ownerToken = options.ownerToken ?? randomUUID();
    this.now = options.now ?? (() => new Date().toISOString());
    this.dispatcher = options.dispatcher;
    this.observer = options.observer;
    this.onError = options.onError;
  }

  get executorOwnerToken(): string {
    return this.ownerToken;
  }

  get isClosed(): boolean {
    return !this.accepting;
  }

  /** Whether this coordinator owns the external dispatcher capability. */
  get hasEffectDispatcher(): boolean {
    return this.dispatcher !== undefined;
  }

  /** Whether this coordinator owns the external observer capability. */
  get hasEffectObserver(): boolean {
    return this.observer !== undefined;
  }

  get errors(): readonly CoordinatorError[] {
    return [...this.observationErrors];
  }

  /** Resolves after every command accepted so far has settled. */
  async waitForIdle(): Promise<void> {
    await this.idle;
  }

  /**
   * Await a confirmed, failed, canceled, or ambiguous observation for one
   * effect. Ambiguous is a notification that lets restart reconciliation
   * hand the effect to the observer without dispatching it again.
   */
  waitForEffectSettlement(
    effectKey: string,
    timeoutMs = 30_000,
  ): Promise<EffectRecord> {
    if (effectKey.trim().length === 0)
      return Promise.reject(
        new TypeError("Effect key must be non-empty text."),
      );
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      return Promise.reject(
        new TypeError(
          "Effect settlement timeout must be a finite non-negative number.",
        ),
      );
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (effect: EffectRecord): void => {
        if (timer !== undefined) clearTimeout(timer);
        const waiters = this.effectSettlementWaiters.get(effectKey);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.effectSettlementWaiters.delete(effectKey);
        resolve(effect);
      };
      const waiters =
        this.effectSettlementWaiters.get(effectKey) ??
        new Set<(effect: EffectRecord) => void>();
      waiters.add(waiter);
      this.effectSettlementWaiters.set(effectKey, waiters);
      timer = setTimeout(() => {
        waiters.delete(waiter);
        if (waiters.size === 0) this.effectSettlementWaiters.delete(effectKey);
        reject(new EffectSettlementTimeoutError(effectKey, timeoutMs));
      }, timeoutMs);
    });
  }

  createClaim(
    input: CreateClaimInput,
    options: CreateClaimOptions = {},
  ): Promise<RunRecord> {
    return this.enqueue(async () => {
      const result = await this.connection.db
        .transaction()
        .execute(async (tx) => {
          const run = await createRunMutationRepository(tx).createClaim(input);
          if (options.effect === undefined) return { run, effect: undefined };
          const effect = await createEffectMutationRepository(
            tx,
          ).insertEffectIntent(
            run,
            this.withTargetRevision(options.effect, run.revision),
            input.at,
          );
          return { run, effect };
        });
      if (
        result.effect?.inserted === true &&
        result.effect.status === "pending" &&
        options.effect?.dispatch !== false
      )
        await this.beginAndDispatch(result.effect.key, input.at);
      return result.run;
    });
  }

  transition(
    request: TransitionRequest,
    options: TransitionCommandOptions = {},
  ): Promise<RunRecord> {
    if (request.trigger === "merge_authorized")
      return Promise.reject(
        new TypeError(
          "Merge authorization is coordinator-owned; use approveMerge.",
        ),
      );
    return this.enqueue(async () => {
      const result = await this.connection.db
        .transaction()
        .execute(async (tx) => {
          const repository = createRunMutationRepository(tx);
          const run = await repository.transitionRun(request);
          if (options.effect === undefined) return { run, effect: undefined };
          const effect = await createEffectMutationRepository(
            tx,
          ).insertEffectIntent(
            run,
            this.withTargetRevision(options.effect, run.revision),
            request.at,
          );
          return { run, effect };
        });
      if (
        result.effect?.inserted === true &&
        result.effect.status === "pending" &&
        options.effect?.dispatch !== false
      )
        await this.beginAndDispatch(result.effect.key, request.at);
      return result.run;
    });
  }

  /**
   * Atomically approve the exact Review candidate and queue its merge effect.
   *
   * The approval, run facts, state transition, and effect intent are one
   * SQLite transaction.  Dispatch begins only after that transaction commits,
   * so an adapter can never observe a merge intent without its approval and
   * `merging` state.  A later retry must supply the new run revision and can
   * therefore never replay a stale browser approval.
   */
  approveMerge(command: ApproveMergeCommand): Promise<MergeApprovalResult> {
    return this.enqueue(async () => {
      const at = asTimestamp(this.now, command.at);
      const result = await this.connection.db
        .transaction()
        .execute(async (tx) => {
          const current = await readRun(tx, command.runId);
          if (current.revision !== command.expectedRevision)
            throw new StaleRevisionError(command.expectedRevision);
          if (current.state !== "review")
            throw new TypeError("Merge approval requires a Review run.");
          if (
            current.headSha === null ||
            current.baseSha === null ||
            current.pullRequestNumber === null ||
            current.pullRequestNodeId === null ||
            current.pullRequestUrl === null ||
            current.branch === null
          )
            throw new TypeError(
              "Merge approval requires complete pull-request and SHA facts.",
            );
          if (current.mergeSha !== null)
            throw new TypeError(
              "Merge approval cannot repeat after a merge SHA was recorded.",
            );

          const observedBaseSha =
            command.observedBaseSha ?? command.approvedBaseSha;
          if (observedBaseSha === undefined)
            throw new TypeError(
              "Merge approval requires the observed base SHA.",
            );
          if (
            command.approvedHeadSha !== current.headSha ||
            observedBaseSha !== current.baseSha
          )
            throw new TypeError(
              "Merge approval does not match the current exact head and base candidate.",
            );

          const repository = createRunMutationRepository(tx);
          const approval = await repository.appendApproval({
            id: randomUUID(),
            runId: current.id,
            expectedRevision: current.revision,
            operator: command.operator,
            approvedHeadSha: command.approvedHeadSha,
            observedBaseSha,
            decision: "approved",
            at,
          });
          const factsUpdated = await tx
            .updateTable("runs")
            .set({
              approved_head_sha: command.approvedHeadSha,
              observed_base_sha: observedBaseSha,
              updated_at: at,
            })
            .where("id", "=", current.id)
            .where("revision", "=", current.revision)
            .executeTakeFirst();
          if (Number(factsUpdated.numUpdatedRows) !== 1)
            throw new StaleRevisionError(command.expectedRevision);

          const authorized = await repository.transitionRun({
            runId: current.id,
            expectedRevision: current.revision,
            trigger: "merge_authorized",
            at,
            summary: {
              text: `Merge approved for exact head ${command.approvedHeadSha}.`,
            },
          });
          const effectKey =
            command.effectKey ??
            `run:${current.id}:rework:${current.reworkEpoch}:merge`;
          const effect = await createEffectMutationRepository(
            tx,
          ).insertEffectIntent(
            authorized,
            {
              key: effectKey,
              kind: "merge",
              targetRevision: authorized.revision,
              intent: {
                repository: authorized.repository,
                pullRequestNumber: authorized.pullRequestNumber,
                pullRequestNodeId: authorized.pullRequestNodeId,
                pullRequestUrl: authorized.pullRequestUrl,
                branch: authorized.branch,
                baseSha: observedBaseSha,
                headSha: command.approvedHeadSha,
              },
            },
            at,
          );
          return { run: authorized, approval, effect: effect.effect };
        });
      if (result.effect.status === "pending" && command.dispatch !== false)
        await this.beginAndDispatch(result.effect.key, at);
      return result;
    });
  }

  /**
   * Atomically persist execution facts and an optional step with an effect
   * observation. A stale callback rolls back every write in this transaction.
   */
  settleExecution(
    command: ExecutionSettlementCommand,
  ): Promise<ExecutionSettlement> {
    return this.enqueue(async () => {
      const at = asTimestamp(this.now, command.at);
      return this.connection.db.transaction().execute(async (tx) => {
        const current = await readRun(tx, command.runId);
        if (current.revision !== command.expectedRevision)
          throw new StaleRevisionError(command.expectedRevision);
        const currentEffect = await tx
          .selectFrom("side_effects")
          .selectAll()
          .where("key", "=", command.effectKey)
          .executeTakeFirst();
        if (
          currentEffect === undefined ||
          currentEffect.run_id !== current.id ||
          currentEffect.rework_epoch !== current.reworkEpoch ||
          currentEffect.target_revision !== command.expectedRevision
        )
          throw new StaleEffectError(
            command.effectKey,
            command.expectedRevision,
          );
        const hasPublicationFacts = command.publicationFacts !== undefined;
        const hasDeliveryFacts = command.deliveryFacts !== undefined;
        if (hasDeliveryFacts && currentEffect.kind !== "merge")
          throw new TypeError("Delivery facts may settle only a merge effect.");
        if (
          deliveryEffectKinds.has(currentEffect.kind as EffectKind) &&
          command.facts !== undefined
        )
          throw new TypeError(
            "Delivery settlements require the narrow delivery facts patch.",
          );
        if (hasPublicationFacts && currentEffect.kind !== "publish")
          throw new TypeError(
            "Publication facts may settle only a publish effect.",
          );
        if (currentEffect.kind === "publish" && command.facts !== undefined)
          throw new TypeError(
            "Publish settlements require the narrow publication facts patch.",
          );
        if (
          currentEffect.kind === "publish" &&
          command.outcome === "confirmed" &&
          !hasPublicationFacts
        )
          throw new TypeError(
            "A confirmed publish settlement requires publication facts.",
          );
        if (
          currentEffect.kind === "publish" &&
          command.outcome !== "confirmed" &&
          hasPublicationFacts
        )
          throw new TypeError(
            "Publication facts require a confirmed publish settlement.",
          );
        if (
          currentEffect.kind === "merge" &&
          command.outcome === "confirmed" &&
          !hasDeliveryFacts
        )
          throw new TypeError(
            "A confirmed merge settlement requires delivery facts.",
          );
        if (currentEffect.kind === "merge" && command.outcome === "confirmed")
          deliverySha(
            command.deliveryFacts?.mergeSha,
            "Merge delivery facts SHA",
          );
        if (
          currentEffect.kind === "merge" &&
          command.outcome !== "confirmed" &&
          hasDeliveryFacts
        )
          throw new TypeError(
            "Delivery facts require a confirmed merge settlement.",
          );
        if (
          deliveryEffectKinds.has(currentEffect.kind as EffectKind) &&
          command.outcome === "confirmed" &&
          command.receipt === undefined
        )
          throw new TypeError(
            "A confirmed delivery settlement requires its receipt.",
          );
        const repository = createRunMutationRepository(tx);
        if (command.step !== undefined) {
          if (
            command.step.runId !== command.runId ||
            command.step.expectedRevision !== command.expectedRevision
          )
            throw new StaleRevisionError(command.expectedRevision);
          await repository.appendStep(command.step);
        }
        if (command.findings !== undefined) {
          if (
            !Array.isArray(command.findings) ||
            command.findings.length > maximumSettlementFindings
          )
            throw new RangeError(
              `A settlement may append at most ${maximumSettlementFindings} findings.`,
            );
          const exhaustedReviewHandoff =
            command.trigger === "handoff_required" &&
            currentEffect.kind === "agent_review" &&
            current.repairRound >= 2;
          if (
            command.outcome !== "failed" ||
            (command.trigger !== "review_needs_repair" &&
              !exhaustedReviewHandoff &&
              command.trigger !== "handoff_required") ||
            command.findings.length === 0
          )
            throw new TypeError(
              "Findings require failed review_needs_repair with nonempty findings.",
            );
          if (command.step === undefined)
            throw new TypeError("Findings require an appended review step.");
          if (
            currentEffect.kind !== "agent_review" ||
            command.step?.role !== "reviewer" ||
            command.step.logicalStep !== "review"
          )
            throw new TypeError(
              "Findings require an agent_review effect and reviewer review step.",
            );
          if (command.trigger === "handoff_required" && !exhaustedReviewHandoff)
            throw new TypeError(
              "Only an exhausted agent_review may hand off with findings.",
            );
          for (const finding of command.findings) {
            if (finding.expectedRevision !== command.expectedRevision)
              throw new StaleRevisionError(command.expectedRevision);
            if (
              finding.runId !== command.runId ||
              finding.reviewStepId !== command.step?.id
            )
              throw new TypeError(
                "Finding must reference the settled reviewer step.",
              );
            await repository.appendFinding(finding);
          }
        } else if (
          command.outcome === "failed" &&
          command.trigger === "review_needs_repair"
        )
          throw new TypeError(
            "review_needs_repair requires a nonempty findings array.",
          );
        if (command.publicationFacts !== undefined)
          await repository.updatePublicationFacts({
            runId: command.runId,
            expectedRevision: command.expectedRevision,
            facts: command.publicationFacts,
            at,
          });
        else if (command.facts !== undefined)
          await repository.updateExecutionFacts({
            runId: command.runId,
            expectedRevision: command.expectedRevision,
            facts: command.facts,
            at,
          });
        const exhaustedReview =
          currentEffect.kind === "agent_review" &&
          command.trigger === "review_needs_repair" &&
          current.repairRound >= 2;
        const observation: EffectObservation = {
          runId: command.runId,
          expectedRevision: command.expectedRevision,
          effectKey: command.effectKey,
          outcome: command.outcome,
          evidence: command.evidence,
        };
        if (command.trigger !== undefined)
          observation.trigger = exhaustedReview
            ? "handoff_required"
            : command.trigger;
        if (command.receipt !== undefined)
          observation.receipt = command.receipt;
        if (command.requiredAction !== undefined)
          observation.requiredAction = command.requiredAction;
        const effect = await recordValidatedObservation(
          tx,
          currentEffect,
          current,
          observation,
          at,
          command.deliveryFacts?.mergeSha,
        );
        return { run: await readRun(tx, command.runId), effect };
      });
    });
  }

  createEffectIntent(
    command: EffectIntentCommand & {
      runId: string;
      expectedRevision?: number;
      at?: string;
    },
  ): Promise<EffectInsertResult> {
    return this.enqueue(async () => {
      const at = asTimestamp(this.now, command.at);
      const result = await this.connection.db
        .transaction()
        .execute(async (tx) => {
          const run = await readRun(tx, command.runId);
          if (
            command.expectedRevision !== undefined &&
            command.expectedRevision !== run.revision
          )
            throw new StaleRevisionError(command.expectedRevision);
          const existing = await tx
            .selectFrom("side_effects")
            .select("target_revision")
            .where("key", "=", command.key)
            .executeTakeFirst();
          return createEffectMutationRepository(tx).insertEffectIntent(
            run,
            this.withTargetRevision(
              command,
              existing?.target_revision ??
                command.targetRevision ??
                run.revision,
            ),
            at,
          );
        });
      if (result.status === "pending" && command.dispatch !== false)
        await this.beginAndDispatch(result.key, at);
      return result;
    });
  }

  beginEffect(command: BeginEffectCommand | string): Promise<EffectRecord> {
    const normalized =
      typeof command === "string" ? { effectKey: command } : command;
    return this.enqueue(async () => {
      const at = asTimestamp(this.now, normalized.at);
      const inFlight = await this.connection.db
        .transaction()
        .execute(async (tx) => {
          if (normalized.expectedRevision !== undefined) {
            const item = (await listUnresolvedForReconciliation(tx)).find(
              ({ effect }) => effect.key === normalized.effectKey,
            );
            if (
              item !== undefined &&
              item.run.revision !== normalized.expectedRevision
            )
              throw new StaleRevisionError(normalized.expectedRevision);
          }
          return createEffectMutationRepository(tx).markEffectInFlight(
            normalized.effectKey,
            this.ownerToken,
            at,
          );
        });
      this.launchDispatch(inFlight);
      return inFlight;
    });
  }

  /** Release a completed pending observation lease for a later poll. */
  releaseEffectForRetry(
    command: ReleaseEffectForRetryCommand,
  ): Promise<EffectRecord> {
    return this.enqueue(async () => {
      const at = asTimestamp(this.now, command.at);
      return this.connection.db
        .transaction()
        .execute((tx) =>
          createEffectMutationRepository(tx).releaseInFlightForRetry(
            command.effectKey,
            command.runId,
            command.expectedRevision,
            this.ownerToken,
            command.evidence,
            at,
          ),
        );
    });
  }

  observeEffect(command: ObserveEffectCommand): Promise<EffectRecord> {
    return this.submitObservation(command, false).then((effect) => {
      if (effect === undefined)
        throw new Error("Effect observation was unexpectedly skipped.");
      return effect;
    });
  }

  /** Alias emphasizing that observations are commands, never direct writes. */
  recordEffect(command: ObserveEffectCommand): Promise<EffectRecord> {
    return this.observeEffect(command);
  }

  /** Mark an uncertain dispatch ambiguous and ignore any late adapter receipt. */
  abandonEffect(command: ObserveEffectCommand): Promise<EffectRecord> {
    const result = this.enqueuePriority(async () => {
      const at = asTimestamp(this.now, command.at);
      return this.connection.db.transaction().execute(async (tx) => {
        const current = await tx
          .selectFrom("side_effects")
          .selectAll()
          .where("key", "=", command.effectKey)
          .executeTakeFirst();
        if (current === undefined)
          throw new StaleEffectError(
            command.effectKey,
            command.expectedRevision,
          );
        const run = await readRun(tx, current.run_id);
        const effect = await recordValidatedObservation(
          tx,
          current,
          run,
          command,
          at,
        );
        const previous = await tx
          .selectFrom("events")
          .select("sequence")
          .where("run_id", "=", effect.runId)
          .orderBy("sequence", "desc")
          .limit(1)
          .executeTakeFirst();
        await tx
          .insertInto("events")
          .values({
            id: randomUUID(),
            run_id: effect.runId,
            sequence: (previous?.sequence ?? 0) + 1,
            run_revision: run.revision,
            kind: quarantinedEffectEventKind,
            summary: command.evidence,
            details_json: JSON.stringify({ effectKey: command.effectKey }),
            log_reference: null,
            created_at: at,
          })
          .execute();
        return effect;
      });
    });
    return result.then((effect) => {
      this.notifyEffectSettlement(effect);
      return effect;
    });
  }

  /**
   * Quarantine an in-flight effect through the coordinator when a caller
   * cannot use the ordinary observation command. The run revision advance and
   * quarantine marker are one durable transaction, so late callbacks are
   * stale even if they were already queued by an adapter.
   */
  quarantineEffect(command: QuarantineEffectCommand): Promise<EffectRecord> {
    const result = this.enqueuePriority(async () => {
      const at = asTimestamp(this.now, command.at);
      return this.connection.db.transaction().execute(async (tx) => {
        const current = await tx
          .selectFrom("side_effects")
          .selectAll()
          .where("key", "=", command.effectKey)
          .executeTakeFirst();
        if (current === undefined)
          throw new StaleEffectError(
            command.effectKey,
            command.expectedRevision,
          );
        const run = await readRun(tx, current.run_id);
        const effect = await recordValidatedObservation(
          tx,
          current,
          run,
          command,
          at,
        );
        const nextRevision = run.revision + 1;
        const updated = await tx
          .updateTable("runs")
          .set({ revision: nextRevision, updated_at: at })
          .where("id", "=", run.id)
          .where("revision", "=", run.revision)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) !== 1)
          throw new StaleRevisionError(run.revision);
        const previous = await tx
          .selectFrom("events")
          .select("sequence")
          .where("run_id", "=", run.id)
          .orderBy("sequence", "desc")
          .limit(1)
          .executeTakeFirst();
        await tx
          .insertInto("events")
          .values({
            id: randomUUID(),
            run_id: run.id,
            sequence: (previous?.sequence ?? 0) + 1,
            run_revision: nextRevision,
            kind: quarantinedEffectEventKind,
            summary: command.evidence,
            details_json: JSON.stringify({ effectKey: command.effectKey }),
            log_reference: null,
            created_at: at,
          })
          .execute();
        return effect;
      });
    });
    return result.then((effect) => {
      this.notifyEffectSettlement(effect);
      return effect;
    });
  }

  cancelEffect(command: CancelEffectCommand): Promise<EffectRecord> {
    const result = this.enqueue(async () => {
      const at = asTimestamp(this.now, command.at);
      return this.connection.db.transaction().execute(async (tx) => {
        if (command.expectedRevision !== undefined) {
          const item = (await listUnresolvedForReconciliation(tx)).find(
            ({ effect }) => effect.key === command.effectKey,
          );
          if (
            item !== undefined &&
            item.run.revision !== command.expectedRevision
          )
            throw new StaleRevisionError(command.expectedRevision);
        }
        return createEffectMutationRepository(tx).cancelPendingEffect(
          command.effectKey,
          command.reason,
          at,
        );
      });
    });
    return result.then((effect) => {
      this.notifyEffectSettlement(effect);
      return effect;
    });
  }

  /**
   * Reject a just-created claim and its project mutation as one serialized
   * transaction. A late adapter callback observes the advanced run revision
   * and is therefore stale rather than reviving the terminal claim.
   */
  rejectClaim(command: RejectClaimCommand): Promise<RunRecord> {
    const result = this.enqueuePriority(async () => {
      const at = asTimestamp(this.now, command.at);
      return this.connection.db.transaction().execute(async (tx) => {
        const run = await readRun(tx, command.runId);
        if (run.revision !== command.expectedRevision)
          throw new StaleRevisionError(command.expectedRevision);
        if (run.state !== "claiming")
          throw new StaleRevisionError(command.expectedRevision);

        const row = await tx
          .selectFrom("side_effects")
          .selectAll()
          .where("key", "=", command.effectKey)
          .executeTakeFirst();
        if (
          row === undefined ||
          row.run_id !== run.id ||
          row.kind !== "project_todo" ||
          row.target_revision !== run.revision ||
          (row.status !== "pending" && row.status !== "in_flight")
        )
          throw new StaleEffectError(
            command.effectKey,
            command.expectedRevision,
          );

        let effect: EffectRecord;
        if (row.status === "pending") {
          effect = await createEffectMutationRepository(tx).cancelPendingEffect(
            command.effectKey,
            command.reason,
            at,
          );
        } else {
          const updated = await tx
            .updateTable("side_effects")
            .set({
              status: "cancelled",
              failure: command.reason,
              completed_at: at,
              updated_at: at,
            })
            .where("key", "=", command.effectKey)
            .where("run_id", "=", run.id)
            .where("target_revision", "=", run.revision)
            .where("status", "=", "in_flight")
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows) !== 1)
            throw new StaleEffectError(
              command.effectKey,
              command.expectedRevision,
            );
          effect = mapSideEffect({
            ...row,
            status: "cancelled",
            failure: command.reason,
            completed_at: at,
            updated_at: at,
          });
        }

        const rejected = await createRunMutationRepository(tx).transitionRun({
          runId: run.id,
          expectedRevision: run.revision,
          trigger: "claim_rejected",
          at,
          summary: { text: command.reason },
        });
        return { effect, run: rejected };
      });
    });
    return result.then(({ effect, run }) => {
      this.notifyEffectSettlement(effect);
      return run;
    });
  }

  updateSchedulerControl(
    request: SchedulerControlUpdateRequest,
  ): Promise<SchedulerControl> {
    return this.enqueue(async () =>
      this.connection.db
        .transaction()
        .execute((tx) =>
          createRunMutationRepository(tx).updateSchedulerControl(request),
        ),
    );
  }

  /**
   * Queue a review run for rework, reserving the coding slot when it is free.
   *
   * The slot check and state transition share one coordinator-owned SQLite
   * transaction. That makes the selected trigger deterministic with respect
   * to other claims and leaves the operator's bounded feedback in both the
   * required-action projection and the append-only transition evidence.
   */
  returnToTodo(command: ReturnToTodoCommand): Promise<RunRecord> {
    return this.enqueue(async () => {
      const at = asTimestamp(this.now, command.at);
      return this.connection.db.transaction().execute(async (tx) => {
        const activeCodingRun = await tx
          .selectFrom("runs")
          .select("id")
          .where("state", "in", [...CODING_STATES])
          .executeTakeFirst();
        const trigger =
          activeCodingRun === undefined
            ? "return_todo_reserved"
            : "return_todo_queued";
        return createRunMutationRepository(tx).transitionRun({
          runId: command.runId,
          expectedRevision: command.expectedRevision,
          trigger,
          at,
          summary: { text: command.feedback },
          requiredAction: command.feedback,
        });
      });
    });
  }

  /**
   * Ask the injected observer about an unresolved effect. The observer runs
   * after this read transaction commits and its callback is submitted back to
   * this same FIFO queue.
   */
  observeAmbiguousEffect(
    command: ObserveAmbiguousEffectCommand,
  ): Promise<EffectRecord | undefined> {
    return this.enqueue(async () => {
      const unresolved = await listUnresolvedForReconciliation(
        this.connection.db,
      );
      const item = unresolved.find(
        ({ effect }) =>
          effect.key === command.effectKey && effect.status === "ambiguous",
      );
      if (item === undefined) return undefined;
      const run = await readRun(this.connection.db, item.effect.runId);
      if (
        command.expectedRevision !== undefined &&
        command.expectedRevision !== run.revision
      )
        throw new StaleRevisionError(command.expectedRevision);
      if (this.observer === undefined) return undefined;
      const effect = item.effect;
      const expectedRevision = command.expectedRevision ?? run.revision;
      this.launchObservation(effect, expectedRevision, this.observer);
      return effect;
    });
  }

  /**
   * Stop accepting commands, drain accepted commands, then mark effects owned
   * by this process ambiguous. The ambiguity evidence advances each affected
   * run revision and appends a durable event so a late callback is stale.
   */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.accepting = false;
    this.closePromise = this.drainAndMarkAmbiguous();
    return this.closePromise;
  }

  private async drainAndMarkAmbiguous(): Promise<void> {
    await this.waitForIdle();
    await this.markOwnedEffectsAmbiguous(
      "Coordinator closed before an external effect receipt was observed.",
    );
  }

  private async markOwnedEffectsAmbiguous(evidence: string): Promise<void> {
    const changed = await this.connection.db
      .transaction()
      .execute(async (tx) => {
        const changed = await createEffectMutationRepository(
          tx,
        ).markOwnedInFlightAmbiguous(this.ownerToken, evidence, this.now());
        const runIds = new Set(changed.map((effect) => effect.runId));
        for (const runId of runIds) {
          const run = await readRun(tx, runId);
          const nextRevision = run.revision + 1;
          const at = this.now();
          const updated = await tx
            .updateTable("runs")
            .set({ revision: nextRevision, updated_at: at })
            .where("id", "=", runId)
            .where("revision", "=", run.revision)
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows) !== 1) continue;
          const previous = await tx
            .selectFrom("events")
            .select("sequence")
            .where("run_id", "=", runId)
            .orderBy("sequence", "desc")
            .limit(1)
            .executeTakeFirst();
          await tx
            .insertInto("events")
            .values({
              id: randomUUID(),
              run_id: runId,
              sequence: (previous?.sequence ?? 0) + 1,
              run_revision: nextRevision,
              kind: "effect_ambiguous",
              summary: evidence,
              details_json: null,
              log_reference: null,
              created_at: at,
            })
            .execute();
        }
        return changed;
      });
    for (const effect of changed) this.notifyEffectSettlement(effect);
  }

  private enqueueObservation(
    effect: EffectRecord,
    expectedRevision: number,
    source: "dispatcher" | "observer",
    result: EffectResult,
  ): void {
    const normalized = effectResult(result, effect);
    const observation: ObserveEffectCommand = {
      runId: effect.runId,
      expectedRevision,
      effectKey: effect.key,
      outcome: normalized.outcome,
      evidence:
        normalized.evidence ??
        `Observed effect ${effect.key} ${normalized.outcome}.`,
    };
    if (normalized.trigger !== undefined)
      observation.trigger = normalized.trigger;
    if (normalized.receipt !== undefined)
      observation.receipt = normalized.receipt;
    void this.submitObservation(observation, source === "observer").catch(
      (error: unknown) => {
        this.handleObservationFailure(effect, expectedRevision, source, error);
      },
    );
  }

  private submitObservation(
    command: ObserveEffectCommand,
    allowQuarantined = false,
  ): Promise<EffectRecord | undefined> {
    const result = this.enqueue(async () => {
      const at = asTimestamp(this.now, command.at);
      return this.connection.db.transaction().execute(async (tx) => {
        const current = await tx
          .selectFrom("side_effects")
          .selectAll()
          .where("key", "=", command.effectKey)
          .executeTakeFirst();
        if (current === undefined)
          throw new StaleEffectError(
            command.effectKey,
            command.expectedRevision,
          );
        const run = await readRun(tx, current.run_id);
        const effectIsSettled =
          current.status !== "pending" && current.status !== "in_flight";
        const quarantineMarker = JSON.stringify({
          effectKey: command.effectKey,
        });
        const quarantine = await tx
          .selectFrom("events")
          .select("sequence")
          .where("run_id", "=", current.run_id)
          .where("kind", "=", quarantinedEffectEventKind)
          .where("details_json", "=", quarantineMarker)
          .executeTakeFirst();
        if (
          run.revision !== command.expectedRevision ||
          (effectIsSettled && current.status !== "ambiguous") ||
          (quarantine !== undefined && !allowQuarantined)
        )
          throw new StaleEffectError(
            command.effectKey,
            command.expectedRevision,
          );
        if (
          deliveryEffectKinds.has(current.kind as EffectKind) &&
          command.outcome === "confirmed" &&
          command.receipt === undefined
        )
          throw new TypeError(
            "A confirmed delivery settlement requires its receipt.",
          );
        return recordValidatedObservation(tx, current, run, command, at);
      });
    });
    return result.then((effect) => {
      if (effect !== undefined) this.notifyEffectSettlement(effect);
      return effect;
    });
  }

  private handleObservationFailure(
    effect: EffectRecord,
    expectedRevision: number,
    source: "dispatcher" | "observer",
    failure: unknown,
  ): void {
    const error = errorValue(failure);
    const code: CoordinatorErrorCode =
      error instanceof CoordinatorClosedError
        ? "closed"
        : error instanceof StaleEffectError ||
            error instanceof StaleRevisionError
          ? "stale"
          : "unexpected";
    const report: CoordinatorError = {
      code,
      source,
      effectKey: effect.key,
      expectedRevision,
      error,
    };
    this.observationErrors.push(report);
    try {
      this.onError?.(report);
    } catch {
      // Error sinks are diagnostics and cannot become detached async throws.
    }
    if (code === "closed") return;
    const evidence = boundedEvidence(
      `${source} observation for ${effect.key} could not be recorded (${code}): ${error.message}`,
    );
    if (!this.accepting) return;
    void this.enqueue(() =>
      this.markEffectAmbiguous(effect.key, evidence),
    ).catch((markFailure: unknown) => {
      const markError = errorValue(markFailure);
      const markReport: CoordinatorError = {
        code: "unexpected",
        source,
        effectKey: effect.key,
        expectedRevision,
        error: markError,
      };
      this.observationErrors.push(markReport);
      try {
        this.onError?.(markReport);
      } catch {
        // Diagnostics remain best-effort and never escape a callback.
      }
    });
  }

  private async markEffectAmbiguous(
    effectKey: string,
    evidence: string,
  ): Promise<void> {
    await this.connection.db.transaction().execute(async (tx) => {
      const effect = await tx
        .selectFrom("side_effects")
        .selectAll()
        .where("key", "=", effectKey)
        .executeTakeFirst();
      if (
        effect === undefined ||
        effect.status !== "in_flight" ||
        effect.executor_owner_token !== this.ownerToken
      )
        return;
      const at = this.now();
      const updated = await tx
        .updateTable("side_effects")
        .set({
          status: "ambiguous",
          reconciliation_evidence: evidence,
          updated_at: at,
        })
        .where("key", "=", effectKey)
        .where("status", "=", "in_flight")
        .where("executor_owner_token", "=", this.ownerToken)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) return;

      const run = await readRun(tx, effect.run_id);
      const nextRevision = run.revision + 1;
      const updatedRun = await tx
        .updateTable("runs")
        .set({ revision: nextRevision, updated_at: at })
        .where("id", "=", run.id)
        .where("revision", "=", run.revision)
        .executeTakeFirst();
      if (Number(updatedRun.numUpdatedRows) !== 1) return;
      const previous = await tx
        .selectFrom("events")
        .select("sequence")
        .where("run_id", "=", run.id)
        .orderBy("sequence", "desc")
        .limit(1)
        .executeTakeFirst();
      await tx
        .insertInto("events")
        .values({
          id: randomUUID(),
          run_id: run.id,
          sequence: (previous?.sequence ?? 0) + 1,
          run_revision: nextRevision,
          kind: "effect_ambiguous",
          summary: evidence,
          details_json: null,
          log_reference: null,
          created_at: at,
        })
        .execute();
    });
  }

  private withTargetRevision(
    command: EffectIntentCommand,
    targetRevision: number,
  ): NewEffectIntent {
    const {
      dispatch: _dispatch,
      targetRevision: _targetRevision,
      ...intent
    } = command;
    return { ...intent, targetRevision };
  }

  private async beginAndDispatch(
    effectKey: string,
    atInput?: string,
  ): Promise<EffectRecord> {
    const at = asTimestamp(this.now, atInput);
    const inFlight = await this.connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).markEffectInFlight(
          effectKey,
          this.ownerToken,
          at,
        ),
      );
    this.launchDispatch(inFlight);
    return inFlight;
  }

  private launchDispatch(effect: EffectRecord): void {
    const dispatcher = this.dispatcher;
    if (dispatcher === undefined) return;
    let completed = false;
    const complete: EffectCompletion = (result) => {
      if (completed) return;
      completed = true;
      const normalized = safeNormalizeAdapterResult(
        result,
        effect,
        "dispatcher",
        false,
      );
      if (normalized !== undefined)
        this.enqueueObservation(
          effect,
          effect.targetRevision,
          "dispatcher",
          normalized,
        );
    };
    try {
      const result =
        typeof dispatcher === "function"
          ? dispatcher(effect, complete)
          : dispatcher.dispatch(effect, complete);
      void Promise.resolve(result).then(
        (value) => {
          const normalized = safeNormalizeAdapterResult(
            value,
            effect,
            "dispatcher",
            true,
          );
          if (normalized !== undefined) complete(normalized);
        },
        (error: unknown) => {
          complete({
            outcome: "failed",
            evidence: `Effect ${effect.key} dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        },
      );
    } catch (error) {
      complete({
        outcome: "failed",
        evidence: `Effect ${effect.key} dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private launchObservation(
    effect: EffectRecord,
    expectedRevision: number,
    observer: EffectObserverLike,
  ): void {
    let completed = false;
    const complete: EffectCompletion = (result) => {
      if (completed) return;
      completed = true;
      const normalized = safeNormalizeAdapterResult(
        result,
        effect,
        "observer",
        false,
      );
      if (normalized !== undefined)
        this.enqueueObservation(
          effect,
          expectedRevision,
          "observer",
          normalized,
        );
    };
    try {
      const result =
        typeof observer === "function"
          ? observer(effect, complete)
          : observer.observe(effect, complete);
      void Promise.resolve(result).then(
        (value) => {
          const normalized = safeNormalizeAdapterResult(
            value,
            effect,
            "observer",
            true,
          );
          if (normalized !== undefined) complete(normalized);
        },
        (error: unknown) => {
          complete({
            outcome: "failed",
            evidence: `Effect ${effect.key} observation failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        },
      );
    } catch (error) {
      complete({
        outcome: "failed",
        evidence: `Effect ${effect.key} observation failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private notifyEffectSettlement(effect: EffectRecord): void {
    if (
      !new Set<EffectStatus>([
        "confirmed",
        "failed",
        "cancelled",
        "ambiguous",
      ]).has(effect.status)
    )
      return;
    const waiters = this.effectSettlementWaiters.get(effect.key);
    if (waiters === undefined) return;
    this.effectSettlementWaiters.delete(effect.key);
    for (const waiter of waiters) waiter(effect);
  }

  private enqueue<T>(command: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new CoordinatorClosedError());
    return this.enqueueCommand(command, false);
  }

  /**
   * Quarantine commands run before commands waiting in the FIFO, while still
   * waiting for a command already in progress. This lets a durable ambiguity
   * record invalidate callbacks that were queued earlier.
   */
  private enqueuePriority<T>(command: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new CoordinatorClosedError());
    return this.enqueueCommand(command, true);
  }

  private enqueueCommand<T>(
    command: () => Promise<T>,
    priority: boolean,
  ): Promise<T> {
    if (!this.draining && this.commandQueue.length === 0) {
      this.idle = new Promise<void>((resolve) => {
        this.resolveIdle = resolve;
      });
    }
    const result = new Promise<T>((resolve, reject) => {
      const entry = {
        command: async (): Promise<unknown> => command(),
        resolve: (value: unknown): void => resolve(value as T),
        reject,
      };
      if (priority) this.commandQueue.unshift(entry);
      else this.commandQueue.push(entry);
    });
    this.scheduleDrain();
    return result;
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    const entry = this.commandQueue.shift();
    if (entry === undefined) {
      this.draining = false;
      const resolveIdle = this.resolveIdle;
      this.resolveIdle = undefined;
      resolveIdle?.();
      return;
    }
    try {
      entry.resolve(await entry.command());
    } catch (error) {
      entry.reject(error);
    }
    // Yield between commands so callers can enqueue a priority quarantine
    // after a command resolves but before its already-queued callbacks run.
    queueMicrotask(() => {
      void this.drainQueue();
    });
  }
}

export type CoordinatorCommand =
  | ReturnType<WorkflowCoordinator["createClaim"]>
  | ReturnType<WorkflowCoordinator["transition"]>
  | ReturnType<WorkflowCoordinator["approveMerge"]>
  | ReturnType<WorkflowCoordinator["settleExecution"]>
  | ReturnType<WorkflowCoordinator["createEffectIntent"]>
  | ReturnType<WorkflowCoordinator["beginEffect"]>
  | ReturnType<WorkflowCoordinator["observeEffect"]>
  | ReturnType<WorkflowCoordinator["cancelEffect"]>
  | ReturnType<WorkflowCoordinator["rejectClaim"]>
  | ReturnType<WorkflowCoordinator["quarantineEffect"]>
  | ReturnType<WorkflowCoordinator["returnToTodo"]>
  | ReturnType<WorkflowCoordinator["updateSchedulerControl"]>;

export type CoordinatorEffectOutcome = EffectStatus;
