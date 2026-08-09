import type { DatabaseConnection } from "../database/connection.js";
import type { EffectRecord } from "../database/effects.js";
import {
  CodingSlotOccupiedError,
  listActiveProjectItemIds,
  RunOwnershipConflictError,
  type RunRecord,
  readRun,
} from "../database/runs.js";
import type {
  ConditionalProjectStatusMove,
  GitHubProjectGateway,
  ProjectDependencies,
  ProjectItem,
  ProjectMoveRejection,
  ProjectSnapshot,
  ProjectStatusMoveResult,
} from "../github/project.js";
import type {
  EffectDispatcherLike,
  EffectObserverLike,
  WorkflowCoordinator,
} from "./coordinator.js";
import { EffectSettlementTimeoutError } from "./coordinator.js";
import { type DiscoveryResult, selectProjectCandidate } from "./discovery.js";

export interface ClaimConfiguration {
  readonly projectId: string;
  readonly projectNumber: number;
  readonly repository: string;
  readonly readyStatus: string;
  readonly todoStatus: string;
  readonly requiredLabels: readonly string[];
}

export interface ClaimNextEligibleInput {
  readonly connection: DatabaseConnection;
  readonly coordinator: Pick<
    WorkflowCoordinator,
    | "createClaim"
    | "beginEffect"
    | "waitForEffectSettlement"
    | "abandonEffect"
    | "rejectClaim"
    | "hasEffectDispatcher"
    | "hasEffectObserver"
  > & {
    /** Optional compatibility seam; production coordinators always expose it. */
    readonly quarantineEffect?: WorkflowCoordinator["quarantineEffect"];
  };
  readonly gateway: GitHubProjectGateway;
  readonly configuration: ClaimConfiguration;
  readonly ownerToken: string;
  readonly now: () => string;
  readonly runId: () => string;
  readonly settlementTimeoutMs?: number;
}

export type ClaimOutcome =
  | {
      readonly kind: "claimed";
      readonly run: RunRecord;
      readonly item: ProjectItem;
      readonly effectKey: string;
      readonly intent: ProjectTodoIntent;
    }
  | {
      readonly kind: "no_candidate";
      readonly discovery: DiscoveryResult;
      readonly reason?: "coding_slot_occupied" | "ownership_conflict";
    }
  | {
      readonly kind: "claim_rejected";
      readonly item?: ProjectItem;
      readonly run?: RunRecord;
      readonly discovery?: DiscoveryResult;
      readonly reason: string;
      readonly rejectionKind?: ProjectMoveRejection["kind"];
      readonly cleanupStatus?:
        | "cancelled"
        | "quarantined"
        | "reconciliation_required";
    };

export interface ProjectTodoIntent {
  readonly projectId: string;
  readonly projectNumber: number;
  readonly repository: string;
  readonly projectItemId: string;
  readonly issueNodeId: string;
  readonly issueNumber: number;
  readonly isOpen: boolean;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly priorityRank?: number;
  readonly dependencies: ProjectDependencies;
  readonly expectedRevision: string;
  readonly fromStatus: string;
  readonly toStatus: string;
}

export interface ProjectTodoCapability {
  readonly dispatcher: EffectDispatcherLike;
  readonly observer: EffectObserverLike;
}

interface ProjectTodoReceipt {
  readonly item: ProjectItem;
}

const maximumClaimEvidenceBytes = 4 * 1024;
const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u;

const PROJECT_MOVE_REJECTION_KINDS = new Set<ProjectMoveRejection["kind"]>([
  "wrong_project",
  "unknown_item",
  "revision_mismatch",
  "status_mismatch",
  "issue_mapping_mismatch",
  "invalid_request",
  "already_applied_drift",
  "effect_key_conflict",
]);

function projectMoveRejectionKind(
  value: unknown,
): ProjectMoveRejection["kind"] | undefined {
  return typeof value === "string" &&
    PROJECT_MOVE_REJECTION_KINDS.has(value as ProjectMoveRejection["kind"])
    ? (value as ProjectMoveRejection["kind"])
    : undefined;
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

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = canonicalTimestampPattern.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milliseconds = Number(match[7] ?? "0");
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  try {
    const parsed = new Date(0);
    parsed.setUTCFullYear(year, month - 1, day);
    parsed.setUTCHours(hour, minute, second, milliseconds);
    const canonical = parsed.toISOString();
    return canonical === value ||
      (milliseconds === 0 && canonical.replace(".000Z", "Z") === value)
      ? canonical
      : undefined;
  } catch {
    return undefined;
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  return canonicalTimestamp(value) !== undefined;
}

function isProjectLabels(value: unknown): value is readonly string[] {
  return (
    isDenseArray(value) &&
    value.length > 0 &&
    value.every((label) => isNonEmptyText(label))
  );
}

function isProjectDependencies(value: unknown): value is ProjectDependencies {
  if (value === "unavailable") return true;
  return (
    isDenseArray(value) &&
    value.every(
      (dependency) =>
        isRecord(dependency) &&
        hasOnlyKeys(dependency, ["issueNodeId", "issueNumber", "isOpen"]) &&
        isNonEmptyText(dependency.issueNodeId) &&
        isPositiveSafeInteger(dependency.issueNumber) &&
        typeof dependency.isOpen === "boolean",
    )
  );
}

function isProjectItem(value: unknown): value is ProjectItem {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [
      "projectItemId",
      "projectId",
      "projectNumber",
      "repository",
      "issueNodeId",
      "issueNumber",
      "isOpen",
      "status",
      "revision",
      "labels",
      "createdAt",
      "priorityRank",
      "dependencies",
    ]) &&
    isNonEmptyText(value.projectItemId) &&
    isNonEmptyText(value.projectId) &&
    isPositiveSafeInteger(value.projectNumber) &&
    isNonEmptyText(value.repository) &&
    isNonEmptyText(value.issueNodeId) &&
    isPositiveSafeInteger(value.issueNumber) &&
    typeof value.isOpen === "boolean" &&
    isNonEmptyText(value.status) &&
    isNonEmptyText(value.revision) &&
    isProjectLabels(value.labels) &&
    isCanonicalTimestamp(value.createdAt) &&
    (value.priorityRank === undefined ||
      Number.isSafeInteger(value.priorityRank)) &&
    isProjectDependencies(value.dependencies)
  );
}

function parseIntent(
  effect: EffectRecord,
  configuration: ClaimConfiguration,
): ProjectTodoIntent | undefined {
  if (
    effect.kind !== "project_todo" ||
    claimConfigurationError(configuration) !== undefined
  )
    return undefined;
  try {
    const parsed: unknown = JSON.parse(effect.intent);
    if (!isRecord(parsed)) return undefined;
    const createdAt = canonicalTimestamp(parsed.createdAt);
    if (
      !hasOnlyKeys(parsed, [
        "projectId",
        "projectNumber",
        "repository",
        "projectItemId",
        "issueNodeId",
        "issueNumber",
        "isOpen",
        "labels",
        "createdAt",
        "priorityRank",
        "dependencies",
        "expectedRevision",
        "fromStatus",
        "toStatus",
      ]) ||
      !isNonEmptyText(parsed.projectId) ||
      !isPositiveSafeInteger(parsed.projectNumber) ||
      !isNonEmptyText(parsed.repository) ||
      !isNonEmptyText(parsed.projectItemId) ||
      !isNonEmptyText(parsed.issueNodeId) ||
      !isPositiveSafeInteger(parsed.issueNumber) ||
      typeof parsed.isOpen !== "boolean" ||
      !isProjectLabels(parsed.labels) ||
      createdAt === undefined ||
      !isProjectDependencies(parsed.dependencies) ||
      !isNonEmptyText(parsed.expectedRevision) ||
      !isNonEmptyText(parsed.fromStatus) ||
      !isNonEmptyText(parsed.toStatus) ||
      (parsed.priorityRank !== undefined && !isSafeInteger(parsed.priorityRank))
    ) {
      return undefined;
    }
    const intent: ProjectTodoIntent = {
      projectId: parsed.projectId,
      projectNumber: parsed.projectNumber,
      repository: parsed.repository,
      projectItemId: parsed.projectItemId,
      issueNodeId: parsed.issueNodeId,
      issueNumber: parsed.issueNumber,
      isOpen: parsed.isOpen,
      labels: parsed.labels,
      createdAt,
      ...(parsed.priorityRank === undefined
        ? {}
        : { priorityRank: parsed.priorityRank }),
      dependencies: parsed.dependencies,
      expectedRevision: parsed.expectedRevision,
      fromStatus: parsed.fromStatus,
      toStatus: parsed.toStatus,
    };
    if (
      intent.projectId !== configuration.projectId ||
      intent.projectNumber !== configuration.projectNumber ||
      intent.repository !== configuration.repository ||
      intent.fromStatus !== configuration.readyStatus ||
      intent.toStatus !== configuration.todoStatus ||
      effect.key !== canonicalEffectKey(effect.runId)
    )
      return undefined;
    if (
      !intent.isOpen ||
      !isDenseArray(configuration.requiredLabels) ||
      configuration.requiredLabels.length === 0 ||
      !configuration.requiredLabels.every(
        (label) => isNonEmptyText(label) && intent.labels.includes(label),
      ) ||
      intent.dependencies === "unavailable" ||
      !intent.dependencies.every((dependency) => dependency.isOpen === false)
    )
      return undefined;
    return intent;
  } catch {
    return undefined;
  }
}

function sameLabels(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const remaining = new Map<string, number>();
  for (const label of left) {
    if (!isNonEmptyText(label)) return false;
    remaining.set(label, (remaining.get(label) ?? 0) + 1);
  }
  for (const label of right) {
    if (!isNonEmptyText(label)) return false;
    const count = remaining.get(label);
    if (count === undefined) return false;
    if (count === 1) remaining.delete(label);
    else remaining.set(label, count - 1);
  }
  return remaining.size === 0;
}

function dependencyIdentity(value: unknown): string | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["issueNodeId", "issueNumber", "isOpen"]) ||
    !isNonEmptyText(value.issueNodeId) ||
    !isPositiveSafeInteger(value.issueNumber) ||
    typeof value.isOpen !== "boolean"
  ) {
    return undefined;
  }
  return JSON.stringify([value.issueNodeId, value.issueNumber, value.isOpen]);
}

function sameDependencies(
  left: ProjectDependencies,
  right: ProjectDependencies,
): boolean {
  if (left === "unavailable" || right === "unavailable") return left === right;
  if (left.length !== right.length) return false;
  const remaining = new Map<string, number>();
  for (const dependency of left) {
    const identity = dependencyIdentity(dependency);
    if (identity === undefined) return false;
    remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
  }
  for (const dependency of right) {
    const identity = dependencyIdentity(dependency);
    if (identity === undefined) return false;
    const count = remaining.get(identity);
    if (count === undefined) return false;
    if (count === 1) remaining.delete(identity);
    else remaining.set(identity, count - 1);
  }
  return remaining.size === 0;
}

function sameItem(left: ProjectItem, right: ProjectItem): boolean {
  const leftCreatedAt = canonicalTimestamp(left.createdAt);
  const rightCreatedAt = canonicalTimestamp(right.createdAt);
  return (
    leftCreatedAt !== undefined &&
    rightCreatedAt !== undefined &&
    left.projectItemId === right.projectItemId &&
    left.projectId === right.projectId &&
    left.projectNumber === right.projectNumber &&
    left.repository === right.repository &&
    left.issueNodeId === right.issueNodeId &&
    left.issueNumber === right.issueNumber &&
    left.isOpen === right.isOpen &&
    left.status === right.status &&
    left.revision === right.revision &&
    sameLabels(left.labels, right.labels) &&
    leftCreatedAt === rightCreatedAt &&
    left.priorityRank === right.priorityRank &&
    sameDependencies(left.dependencies, right.dependencies)
  );
}

function boundedEvidence(value: string): string {
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maximumClaimEvidenceBytes)
    result = result.slice(0, -1);
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function claimConfigurationError(
  configuration: ClaimConfiguration,
): string | undefined {
  if (!isNonEmptyText(configuration.projectId))
    return "Project ID must be non-blank.";
  if (!isPositiveSafeInteger(configuration.projectNumber))
    return "Project number must be a positive integer.";
  if (!isNonEmptyText(configuration.repository))
    return "Repository must be non-blank.";
  if (!isNonEmptyText(configuration.readyStatus))
    return "Ready status must be non-blank.";
  if (!isNonEmptyText(configuration.todoStatus))
    return "Todo status must be non-blank.";
  if (configuration.readyStatus === configuration.todoStatus)
    return "Ready and Todo statuses must be different.";
  if (
    !isDenseArray(configuration.requiredLabels) ||
    configuration.requiredLabels.length === 0 ||
    !configuration.requiredLabels.every((label) => isNonEmptyText(label))
  )
    return "Required labels must be a non-empty dense list of text.";
  return undefined;
}

function canonicalEffectKey(runId: string): string {
  return `run:${runId}:project:todo`;
}

type BeginCleanupResult =
  | { readonly status: "cancelled"; readonly evidence: string }
  | { readonly status: "quarantined"; readonly evidence: string }
  | {
      readonly status: "reconciliation_required";
      readonly evidence: string;
    };

async function cleanupAfterBeginFailure(
  input: ClaimNextEligibleInput,
  run: RunRecord,
  effectKey: string,
  beginFailure: string,
): Promise<BeginCleanupResult> {
  const reason = boundedEvidence(
    `Project Todo effect could not begin: ${beginFailure}`,
  );
  try {
    const rejected = await input.coordinator.rejectClaim({
      runId: run.id,
      effectKey,
      expectedRevision: run.revision,
      reason,
      at: input.now(),
    });
    if (rejected.state === "claim_failed" && rejected.ownerToken === null) {
      return {
        status: "cancelled",
        evidence:
          "The durable effect was canceled and the claim was rejected atomically.",
      };
    }
    return {
      status: "reconciliation_required",
      evidence: boundedEvidence(
        `${reason}. The coordinator returned an unexpected claim state and requires reconciliation.`,
      ),
    };
  } catch (error) {
    return {
      status: "reconciliation_required",
      evidence: boundedEvidence(
        `${reason}. Atomic claim rejection failed (${errorMessage(error)}) and requires reconciliation.`,
      ),
    };
  }
}

async function readRunSafely(
  input: ClaimNextEligibleInput,
  runId: string,
): Promise<RunRecord | undefined> {
  try {
    return await readRun(input.connection.db, runId);
  } catch {
    return undefined;
  }
}

function itemMatchesIntent(
  item: ProjectItem,
  intent: ProjectTodoIntent,
  configuration: ClaimConfiguration,
): boolean {
  const itemCreatedAt = canonicalTimestamp(item.createdAt);
  const intentCreatedAt = canonicalTimestamp(intent.createdAt);
  return (
    itemCreatedAt !== undefined &&
    intentCreatedAt !== undefined &&
    item.projectItemId === intent.projectItemId &&
    item.projectId === intent.projectId &&
    item.projectNumber === intent.projectNumber &&
    item.repository === intent.repository &&
    item.repository === configuration.repository &&
    item.issueNodeId === intent.issueNodeId &&
    item.issueNumber === intent.issueNumber &&
    item.isOpen === intent.isOpen &&
    intent.isOpen &&
    item.status === intent.toStatus &&
    item.status === configuration.todoStatus &&
    sameLabels(item.labels, intent.labels) &&
    itemCreatedAt === intentCreatedAt &&
    item.priorityRank === intent.priorityRank &&
    sameDependencies(item.dependencies, intent.dependencies) &&
    intent.dependencies !== "unavailable" &&
    intent.dependencies.every((dependency) => dependency.isOpen === false) &&
    item.revision.length > 0 &&
    item.revision !== intent.expectedRevision
  );
}

function dispatcherFor(
  gateway: GitHubProjectGateway,
  configuration: ClaimConfiguration,
): EffectDispatcherLike {
  return async (effect) => {
    const intent = parseIntent(effect, configuration);
    if (intent === undefined) {
      return {
        outcome: "failed",
        evidence: boundedEvidence(
          `Invalid project_todo intent for ${effect.key}.`,
        ),
      };
    }
    const request: ConditionalProjectStatusMove = {
      projectId: intent.projectId,
      projectNumber: intent.projectNumber,
      itemId: intent.projectItemId,
      issueNodeId: intent.issueNodeId,
      issueNumber: intent.issueNumber,
      expectedRevision: intent.expectedRevision,
      fromStatus: intent.fromStatus,
      toStatus: intent.toStatus,
      effectKey: effect.key,
    };
    let result: ProjectStatusMoveResult;
    try {
      result = await gateway.moveProjectItem(request);
    } catch (error) {
      return {
        outcome: "ambiguous",
        evidence: boundedEvidence(
          `Project Todo mutation outcome is ambiguous after a dispatch error: ${errorMessage(error)}`,
        ),
      };
    }
    if (!isRecord(result)) {
      return {
        outcome: "ambiguous",
        evidence: boundedEvidence(
          `Project Todo mutation returned an invalid receipt for ${effect.key}; external state requires observation.`,
        ),
      };
    }
    if (result.outcome === "rejected") {
      const kind =
        isRecord(result.reason) && typeof result.reason.kind === "string"
          ? result.reason.kind
          : "invalid_rejection";
      const rejectionKind = projectMoveRejectionKind(kind);
      return {
        outcome: "failed",
        evidence: boundedEvidence(`Project Todo mutation rejected: ${kind}.`),
        ...(rejectionKind === undefined ? {} : { receipt: { rejectionKind } }),
      };
    }
    if (result.outcome !== "moved" && result.outcome !== "already_applied") {
      return {
        outcome: "ambiguous",
        evidence: boundedEvidence(
          `Project Todo mutation returned an unknown outcome for ${effect.key}; external state requires observation.`,
        ),
      };
    }
    if (!isProjectItem(result.item)) {
      return {
        outcome: "ambiguous",
        evidence: boundedEvidence(
          `Project Todo mutation returned a malformed receipt for ${effect.key}; external state requires observation.`,
        ),
      };
    }
    if (!itemMatchesIntent(result.item, intent, configuration)) {
      return {
        outcome: "ambiguous",
        evidence: boundedEvidence(
          `Project Todo receipt did not match ${effect.key}; external state requires observation.`,
        ),
      };
    }
    return {
      outcome: "confirmed",
      trigger: "todo_observed",
      receipt: { item: result.item } satisfies ProjectTodoReceipt,
      evidence: boundedEvidence(
        result.outcome === "already_applied"
          ? `Project Todo mutation already applied for ${effect.key}.`
          : `Project Todo mutation confirmed for ${effect.key}.`,
      ),
    };
  };
}

function receiptRejectionKind(
  effect: EffectRecord,
): ProjectMoveRejection["kind"] | undefined {
  if (effect.receipt === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(effect.receipt);
    if (!isRecord(parsed)) return undefined;
    return projectMoveRejectionKind(parsed.rejectionKind);
  } catch {
    return undefined;
  }
}

function receiptItem(effect: EffectRecord): ProjectItem | undefined {
  if (effect.receipt === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(effect.receipt);
    if (!isRecord(parsed) || !isProjectItem(parsed.item)) return undefined;
    return parsed.item;
  } catch {
    return undefined;
  }
}

function observerFor(
  gateway: GitHubProjectGateway,
  configuration: ClaimConfiguration,
): EffectObserverLike {
  return async (effect) => {
    const intent = parseIntent(effect, configuration);
    if (intent === undefined) {
      return {
        outcome: "failed",
        evidence: boundedEvidence(
          `Invalid project_todo intent for ${effect.key}.`,
        ),
      };
    }
    let observed: ProjectItem | undefined;
    try {
      observed = await gateway.readProjectItem(intent.projectItemId);
    } catch (error) {
      return {
        outcome: "ambiguous",
        evidence: boundedEvidence(
          `Project Todo observation threw; external state requires observation: ${errorMessage(error)}`,
        ),
      };
    }
    if (!isProjectItem(observed)) {
      return {
        outcome: "ambiguous",
        evidence: boundedEvidence(
          `Project Todo observation returned malformed data for ${effect.key}; external state requires observation.`,
        ),
      };
    }
    if (!itemMatchesIntent(observed, intent, configuration)) {
      if (observed.status !== configuration.todoStatus) {
        return {
          outcome: "failed",
          evidence: boundedEvidence(
            `Project Todo observation definitively found status ${observed.status} for ${effect.key}.`,
          ),
        };
      }
      return {
        outcome: "ambiguous",
        evidence: boundedEvidence(
          `Project Todo observation did not match ${effect.key}; external state requires observation.`,
        ),
      };
    }
    return {
      outcome: "confirmed",
      trigger: "todo_observed",
      receipt: { item: observed } satisfies ProjectTodoReceipt,
      evidence: boundedEvidence(
        `Project Todo observation confirmed for ${effect.key}.`,
      ),
    };
  };
}

export function createProjectTodoCapability(
  gateway: GitHubProjectGateway,
  configuration: ClaimConfiguration,
): ProjectTodoCapability {
  return {
    dispatcher: dispatcherFor(gateway, configuration),
    observer: observerFor(gateway, configuration),
  };
}

async function discovery(
  input: ClaimNextEligibleInput,
  snapshot: ProjectSnapshot,
): Promise<DiscoveryResult> {
  return selectProjectCandidate(snapshot, {
    projectId: input.configuration.projectId,
    projectNumber: input.configuration.projectNumber,
    repository: input.configuration.repository,
    readyStatus: input.configuration.readyStatus,
    requiredLabels: input.configuration.requiredLabels,
    ownedProjectItemIds: await listActiveProjectItemIds(input.connection.db),
  });
}

function driftReason(
  candidate: ProjectItem,
  fresh: ProjectItem,
): string | undefined {
  if (!sameItem(candidate, fresh))
    return "selected project item drifted before claim";
  return undefined;
}

async function quarantineAfterSettlementFailure(
  input: ClaimNextEligibleInput,
  run: RunRecord,
  effectKey: string,
  error: unknown,
): Promise<BeginCleanupResult> {
  const failure = errorMessage(error);
  const timeout = error instanceof EffectSettlementTimeoutError;
  const quarantineEvidence = boundedEvidence(
    timeout
      ? `Project Todo effect ${effectKey} timed out and was quarantined for observation.`
      : `Project Todo effect ${effectKey} settlement failed (${failure}) and was quarantined for observation.`,
  );
  let abandonFailure: string | undefined;
  try {
    const abandoned = await input.coordinator.abandonEffect({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey,
      outcome: "ambiguous",
      trigger: null,
      evidence: quarantineEvidence,
      at: input.now(),
    });
    if (abandoned?.status === "ambiguous") {
      return {
        status: "quarantined",
        evidence: timeout
          ? "The timed-out durable effect is awaiting reconciliation."
          : "The failed-settlement durable effect is awaiting reconciliation.",
      };
    }
    abandonFailure = `abandon returned ${
      isRecord(abandoned) && typeof abandoned.status === "string"
        ? abandoned.status
        : "an invalid result"
    }`;
  } catch (abandonError) {
    abandonFailure = errorMessage(abandonError);
  }

  if (input.coordinator.quarantineEffect !== undefined) {
    try {
      const quarantined = await input.coordinator.quarantineEffect({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey,
        outcome: "ambiguous",
        trigger: null,
        evidence: quarantineEvidence,
        at: input.now(),
      });
      if (quarantined?.status === "ambiguous") {
        return {
          status: "reconciliation_required",
          evidence: boundedEvidence(
            `${quarantineEvidence} The quarantine was recorded with a durable revision advance${
              abandonFailure === undefined
                ? ""
                : ` after abandon failed (${abandonFailure})`
            }.`,
          ),
        };
      }
      abandonFailure = `quarantine returned ${
        isRecord(quarantined) && typeof quarantined.status === "string"
          ? quarantined.status
          : "an invalid result"
      }`;
    } catch (quarantineError) {
      abandonFailure = `${abandonFailure ?? "abandon failed"}; quarantine failed: ${errorMessage(quarantineError)}`;
    }
  }

  return {
    status: "reconciliation_required",
    evidence: boundedEvidence(
      `${timeout ? "Project Todo effect timed out" : `Project Todo effect settlement failed (${failure})`}; quarantine failed${
        abandonFailure === undefined ? "" : ` (${abandonFailure})`
      } and requires reconciliation.`,
    ),
  };
}

export async function claimNextEligible(
  input: ClaimNextEligibleInput,
): Promise<ClaimOutcome> {
  const configurationError = claimConfigurationError(input.configuration);
  if (configurationError !== undefined)
    return {
      kind: "claim_rejected",
      reason: boundedEvidence(configurationError),
    };
  if (
    !input.coordinator.hasEffectDispatcher ||
    !input.coordinator.hasEffectObserver
  ) {
    return {
      kind: "claim_rejected",
      reason:
        "Project Todo dispatcher and observer capabilities are both required at coordinator startup.",
    };
  }
  const projectRequest = {
    projectId: input.configuration.projectId,
    projectNumber: input.configuration.projectNumber,
    repository: input.configuration.repository,
  } as const;
  let snapshot: ProjectSnapshot;
  try {
    snapshot = await input.gateway.readProject(projectRequest);
  } catch (error) {
    return {
      kind: "claim_rejected",
      reason: boundedEvidence(
        `Project snapshot read failed: ${errorMessage(error)}`,
      ),
    };
  }
  const selected = await discovery(input, snapshot);
  const candidate = selected.selected;
  if (candidate === undefined)
    return { kind: "no_candidate", discovery: selected };

  let freshItem: ProjectItem | undefined;
  try {
    freshItem = await input.gateway.readProjectItem(candidate.projectItemId);
  } catch (error) {
    return {
      kind: "claim_rejected",
      item: candidate,
      discovery: selected,
      reason: boundedEvidence(
        `Selected project item reread failed: ${errorMessage(error)}`,
      ),
    };
  }
  if (!isProjectItem(freshItem)) {
    return {
      kind: "claim_rejected",
      item: candidate,
      discovery: selected,
      reason: "selected project item reread was malformed or unavailable",
    };
  }

  const freshSnapshot: ProjectSnapshot = { ...snapshot, items: [freshItem] };
  const freshDiscovery = await discovery(input, freshSnapshot);
  const drift = driftReason(candidate, freshItem);
  if (
    drift !== undefined ||
    freshDiscovery.selected?.projectItemId !== candidate.projectItemId
  ) {
    return {
      kind: "claim_rejected",
      item: candidate,
      discovery: freshDiscovery,
      reason: drift ?? "selected project item is no longer eligible",
    };
  }

  const createdAt = canonicalTimestamp(candidate.createdAt);
  if (createdAt === undefined) {
    return {
      kind: "claim_rejected",
      item: candidate,
      discovery: freshDiscovery,
      reason: "selected project item timestamp was invalid",
    };
  }

  const runId = input.runId();
  const effectKey = canonicalEffectKey(runId);
  const intent: ProjectTodoIntent = {
    projectId: input.configuration.projectId,
    projectNumber: input.configuration.projectNumber,
    repository: input.configuration.repository,
    projectItemId: candidate.projectItemId,
    issueNodeId: candidate.issueNodeId,
    issueNumber: candidate.issueNumber,
    isOpen: candidate.isOpen,
    labels: candidate.labels,
    createdAt,
    ...(candidate.priorityRank === undefined
      ? {}
      : { priorityRank: candidate.priorityRank }),
    dependencies: candidate.dependencies,
    expectedRevision: candidate.revision,
    fromStatus: input.configuration.readyStatus,
    toStatus: input.configuration.todoStatus,
  };
  let run: RunRecord;
  try {
    run = await input.coordinator.createClaim(
      {
        id: runId,
        repository: input.configuration.repository,
        projectItemId: candidate.projectItemId,
        issueNodeId: candidate.issueNodeId,
        issueNumber: candidate.issueNumber,
        ownerToken: input.ownerToken,
        at: input.now(),
        summary: { text: `Claim issue #${candidate.issueNumber}.` },
      },
      {
        effect: {
          dispatch: false,
          key: effectKey,
          kind: "project_todo",
          intent,
        },
      },
    );
  } catch (error) {
    if (error instanceof CodingSlotOccupiedError) {
      return {
        kind: "no_candidate",
        discovery: selected,
        reason: "coding_slot_occupied",
      };
    }
    if (error instanceof RunOwnershipConflictError) {
      return {
        kind: "no_candidate",
        discovery: selected,
        reason: "ownership_conflict",
      };
    }
    throw error;
  }

  let begun = false;
  try {
    await input.coordinator.beginEffect({
      effectKey,
      expectedRevision: run.revision,
      at: input.now(),
    });
    begun = true;
    let settled: EffectRecord;
    try {
      settled = await input.coordinator.waitForEffectSettlement(
        effectKey,
        input.settlementTimeoutMs ?? 30_000,
      );
    } catch (error) {
      const cleanup = await quarantineAfterSettlementFailure(
        input,
        run,
        effectKey,
        error,
      );
      const currentRun = await readRunSafely(input, run.id);
      return {
        kind: "claim_rejected",
        item: candidate,
        ...(currentRun === undefined ? {} : { run: currentRun }),
        reason: cleanup.evidence,
        cleanupStatus: cleanup.status,
      };
    }
    const currentRun = await readRun(input.connection.db, run.id);
    if (settled.status !== "confirmed") {
      const rejectionKind = receiptRejectionKind(settled);
      return {
        kind: "claim_rejected",
        item: candidate,
        run: currentRun,
        reason: settled.failure ?? `Project Todo effect ${settled.status}.`,
        ...(rejectionKind === undefined ? {} : { rejectionKind }),
      };
    }
    const observed = receiptItem(settled);
    if (
      observed === undefined ||
      !itemMatchesIntent(observed, intent, input.configuration)
    ) {
      return {
        kind: "claim_rejected",
        item: candidate,
        run: currentRun,
        reason: "Project Todo effect receipt was invalid.",
      };
    }
    return {
      kind: "claimed",
      run: currentRun,
      item: observed,
      effectKey,
      intent,
    };
  } catch (error) {
    const beginFailure = errorMessage(error);
    let cleanupStatus:
      | "cancelled"
      | "quarantined"
      | "reconciliation_required"
      | undefined;
    let cleanupEvidence: string | undefined;
    if (!begun) {
      const cleanup = await cleanupAfterBeginFailure(
        input,
        run,
        effectKey,
        beginFailure,
      );
      cleanupStatus = cleanup.status;
      cleanupEvidence = cleanup.evidence;
    }
    const reason = boundedEvidence(
      cleanupEvidence === undefined
        ? `Project Todo effect failed: ${beginFailure}`
        : `Project Todo effect begin failed: ${beginFailure}. ${cleanupEvidence}`,
    );
    const currentRun = await readRunSafely(input, run.id);
    return {
      kind: "claim_rejected",
      item: candidate,
      reason,
      ...(currentRun === undefined ? {} : { run: currentRun }),
      ...(cleanupStatus === undefined ? {} : { cleanupStatus }),
    };
  }
}
