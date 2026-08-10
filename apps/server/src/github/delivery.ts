/**
 * Repository-bound delivery boundary.
 *
 * This module deliberately returns only the facts the coordinator needs to
 * make a merge/staging/Done decision.  Provider response bodies, tokens, and
 * other unbounded metadata never cross this boundary.
 */

import type { ProjectItem } from "./project.js";
import {
  assertRequiredChecksReceipt,
  type RequiredChecksReceipt,
} from "./publication.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const NODE_ID_PATTERN = /^[A-Za-z0-9_:-]+$/u;
const MERGE_METHODS = ["squash", "rebase", "merge"] as const;
const MERGEABILITIES = ["mergeable", "conflicting", "unknown"] as const;
const WORKFLOW_RUN_STATUSES = ["queued", "in_progress", "completed"] as const;
const WORKFLOW_CONCLUSIONS = [
  "none",
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "neutral",
  "skipped",
  "unknown",
] as const;
const DEPLOYMENT_STATES = [
  "pending",
  "success",
  "failure",
  "inactive",
  "error",
  "unknown",
] as const;
const STAGING_OUTCOMES = [
  "pending",
  "deployed",
  "failed",
  "sha_mismatch",
] as const;

type TupleValue<T extends readonly string[]> = T[number];

export type MergeMethod = TupleValue<typeof MERGE_METHODS>;
export type Mergeability = TupleValue<typeof MERGEABILITIES>;
export type StagingWorkflowRunStatus = TupleValue<typeof WORKFLOW_RUN_STATUSES>;
export type StagingWorkflowRunConclusion = TupleValue<
  typeof WORKFLOW_CONCLUSIONS
>;
export type StagingDeploymentState = TupleValue<typeof DEPLOYMENT_STATES>;
export type StagingObservationOutcome = TupleValue<typeof STAGING_OUTCOMES>;

export type GitHubDeliveryFailureKind =
  | "invalid_input"
  | "repository_mismatch"
  | "pull_request_not_found"
  | "pull_request_mismatch"
  | "pull_request_is_draft"
  | "head_drift"
  | "base_drift"
  | "required_checks_not_green"
  | "unresolved_threads"
  | "merge_conflict"
  | "mergeability_unknown"
  | "merge_capability_unavailable"
  | "merge_method_not_permitted"
  | "merge_prevented"
  | "merge_ambiguous"
  | "effect_key_conflict"
  | "staging_target_mismatch"
  | "staging_not_observed"
  | "staging_failed"
  | "deployed_sha_mismatch"
  | "project_not_found"
  | "project_mapping_mismatch"
  | "project_revision_mismatch"
  | "project_status_mismatch"
  | "merge_not_observed";

export class GitHubDeliveryBoundaryError extends Error {
  readonly kind: GitHubDeliveryFailureKind;

  constructor(kind: GitHubDeliveryFailureKind, message: string) {
    super(message);
    this.name = "GitHubDeliveryBoundaryError";
    this.kind = kind;
  }
}

export interface MergeCandidateRequest {
  readonly repository: string;
  readonly number: number;
  readonly issueNumber: number;
  readonly nodeId: string;
  readonly expectedTitle: string;
  readonly expectedBaseBranch: string;
  readonly expectedBaseSha: string;
  readonly expectedHeadBranch: string;
  readonly expectedHeadSha: string;
}

export interface MergeThreadReceipt {
  readonly id: string;
  readonly resolved: boolean;
}

export interface MergeCandidateReceipt {
  readonly repository: string;
  readonly number: number;
  readonly issueNumber: number;
  readonly nodeId: string;
  readonly isDraft: false;
  readonly title: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly requiredChecks: RequiredChecksReceipt;
  readonly threads: readonly MergeThreadReceipt[];
  readonly mergeability: Mergeability;
  /** Methods currently permitted by the repository's branch policy. */
  readonly permittedMergeMethods: readonly MergeMethod[];
}

export interface MergeRequest extends MergeCandidateRequest {
  /** Durable coordinator-owned idempotency key. */
  readonly effectKey: string;
  readonly method: MergeMethod;
}

export interface MergeReceipt {
  readonly repository: string;
  readonly number: number;
  readonly issueNumber: number;
  readonly nodeId: string;
  readonly method: MergeMethod;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly headSha: string;
  /** The exact commit SHA reported by the merge mutation. */
  readonly mergeSha: string;
}

export interface ObserveStagingRequest {
  readonly repository: string;
  readonly workflow: string;
  readonly environment: string;
  readonly mergeSha: string;
}

export interface StagingWorkflowRunReceipt {
  readonly id: string;
  readonly workflow: string;
  readonly headSha: string;
  readonly status: StagingWorkflowRunStatus;
  readonly conclusion: StagingWorkflowRunConclusion;
}

export interface StagingDeploymentReceipt {
  readonly id: string;
  readonly environment: string;
  readonly deployedSha: string;
  readonly state: StagingDeploymentState;
}

export interface StagingObservation {
  readonly repository: string;
  readonly workflow: string;
  readonly environment: string;
  readonly mergeSha: string;
  readonly workflowRun: StagingWorkflowRunReceipt | undefined;
  readonly deployment: StagingDeploymentReceipt | undefined;
  readonly outcome: StagingObservationOutcome;
}

export interface ConditionalProjectDoneMoveRequest {
  readonly repository: string;
  readonly projectId: string;
  readonly projectNumber: number;
  readonly itemId: string;
  readonly issueNodeId: string;
  readonly issueNumber: number;
  readonly expectedRevision: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly effectKey: string;
  readonly mergeSha: string;
}

export type ProjectDoneMoveRejection =
  | { readonly kind: "invalid_request"; readonly field: string }
  | { readonly kind: "repository_mismatch" }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "project_mapping_mismatch" }
  | {
      readonly kind: "project_revision_mismatch";
      readonly expectedRevision: string;
      readonly actualRevision: string;
    }
  | {
      readonly kind: "project_status_mismatch";
      readonly expectedStatus: string;
      readonly actualStatus: string;
    }
  | { readonly kind: "merge_not_observed" }
  | { readonly kind: "effect_key_conflict" };

export type ProjectDoneMoveResult =
  | { readonly outcome: "moved"; readonly item: ProjectItem }
  | { readonly outcome: "already_applied"; readonly item: ProjectItem }
  | { readonly outcome: "rejected"; readonly reason: ProjectDoneMoveRejection };

export interface GitHubDeliveryGateway {
  readMergeCandidate(
    request: MergeCandidateRequest,
  ): Promise<MergeCandidateReceipt>;
  mergePullRequest(request: MergeRequest): Promise<MergeReceipt>;
  observeStaging(request: ObserveStagingRequest): Promise<StagingObservation>;
  moveProjectItemToDone(
    request: ConditionalProjectDoneMoveRequest,
  ): Promise<ProjectDoneMoveResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function text(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    byteLength(value) <= maximumBytes
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function sha(value: unknown): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function repository(value: unknown): value is string {
  return typeof value === "string" && REPOSITORY_PATTERN.test(value);
}

function branch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    BRANCH_PATTERN.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

function nodeId(value: unknown): value is string {
  return text(value, 256) && NODE_ID_PATTERN.test(value);
}

function stringEnum<T extends readonly string[]>(
  value: unknown,
  values: T,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function invalid(message: string): never {
  throw new GitHubDeliveryBoundaryError("invalid_input", message);
}

function failure(kind: GitHubDeliveryFailureKind, message: string): never {
  throw new GitHubDeliveryBoundaryError(kind, message);
}

function plainInput(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) invalid(`${label} must be a plain object`);
  return value;
}

function assertCommonCandidateFields(
  input: Record<string, unknown>,
  label: string,
): void {
  if (
    !repository(input.repository) ||
    !positiveInteger(input.number) ||
    !positiveInteger(input.issueNumber) ||
    !nodeId(input.nodeId) ||
    !text(input.expectedTitle, 2_000) ||
    !branch(input.expectedBaseBranch) ||
    !sha(input.expectedBaseSha) ||
    !branch(input.expectedHeadBranch) ||
    !sha(input.expectedHeadSha)
  ) {
    invalid(`${label} is malformed or exceeds its bounds`);
  }
}

export function assertMergeCandidateRequest(
  value: unknown,
): MergeCandidateRequest {
  const input = plainInput(value, "Merge candidate request");
  if (
    !hasOnlyKeys(input, [
      "repository",
      "number",
      "issueNumber",
      "nodeId",
      "expectedTitle",
      "expectedBaseBranch",
      "expectedBaseSha",
      "expectedHeadBranch",
      "expectedHeadSha",
    ])
  ) {
    invalid("Merge candidate request is malformed or exceeds its bounds");
  }
  assertCommonCandidateFields(input, "Merge candidate request");
  return {
    repository: input.repository as string,
    number: input.number as number,
    issueNumber: input.issueNumber as number,
    nodeId: input.nodeId as string,
    expectedTitle: input.expectedTitle as string,
    expectedBaseBranch: input.expectedBaseBranch as string,
    expectedBaseSha: input.expectedBaseSha as string,
    expectedHeadBranch: input.expectedHeadBranch as string,
    expectedHeadSha: input.expectedHeadSha as string,
  };
}

function assertThreads(value: unknown): value is readonly MergeThreadReceipt[] {
  if (!isDenseArray(value) || value.length > 256) return false;
  const ids = new Set<string>();
  for (const thread of value) {
    if (
      !isPlainRecord(thread) ||
      !hasOnlyKeys(thread, ["id", "resolved"]) ||
      !nodeId(thread.id) ||
      typeof thread.resolved !== "boolean" ||
      ids.has(thread.id)
    ) {
      return false;
    }
    ids.add(thread.id);
  }
  return true;
}

function assertMethods(value: unknown): value is readonly MergeMethod[] {
  if (!isDenseArray(value) || value.length > MERGE_METHODS.length) return false;
  const methods = value as readonly unknown[];
  return (
    methods.every((method) => stringEnum(method, MERGE_METHODS)) &&
    new Set(methods).size === methods.length
  );
}

export function assertMergeCandidateReceipt(
  value: unknown,
): MergeCandidateReceipt {
  const input = plainInput(value, "Merge candidate receipt");
  if (
    !hasOnlyKeys(input, [
      "repository",
      "number",
      "issueNumber",
      "nodeId",
      "isDraft",
      "title",
      "baseBranch",
      "baseSha",
      "headBranch",
      "headSha",
      "requiredChecks",
      "threads",
      "mergeability",
      "permittedMergeMethods",
    ]) ||
    !repository(input.repository) ||
    !positiveInteger(input.number) ||
    !positiveInteger(input.issueNumber) ||
    !nodeId(input.nodeId) ||
    input.isDraft !== false ||
    !text(input.title, 2_000) ||
    !branch(input.baseBranch) ||
    !sha(input.baseSha) ||
    !branch(input.headBranch) ||
    !sha(input.headSha) ||
    !assertThreads(input.threads) ||
    !stringEnum(input.mergeability, MERGEABILITIES) ||
    !assertMethods(input.permittedMergeMethods)
  ) {
    invalid("Merge candidate receipt is malformed or exceeds its bounds");
  }
  let requiredChecks: RequiredChecksReceipt;
  try {
    requiredChecks = assertRequiredChecksReceipt(input.requiredChecks);
  } catch {
    invalid("Merge candidate receipt has invalid check evidence");
  }
  if (
    requiredChecks.repository !== input.repository ||
    requiredChecks.number !== input.number ||
    requiredChecks.nodeId !== input.nodeId ||
    requiredChecks.headSha !== input.headSha
  ) {
    invalid("Merge candidate receipt check evidence is not bound to the PR");
  }
  return {
    repository: input.repository,
    number: input.number,
    issueNumber: input.issueNumber,
    nodeId: input.nodeId,
    isDraft: input.isDraft,
    title: input.title,
    baseBranch: input.baseBranch,
    baseSha: input.baseSha,
    headBranch: input.headBranch,
    headSha: input.headSha,
    requiredChecks,
    threads: input.threads.map((thread) => ({
      id: thread.id,
      resolved: thread.resolved,
    })),
    mergeability: input.mergeability,
    permittedMergeMethods: [...input.permittedMergeMethods],
  };
}

export function assertMergeRequest(value: unknown): MergeRequest {
  const input = plainInput(value, "Merge request");
  if (
    !hasOnlyKeys(input, [
      "repository",
      "number",
      "issueNumber",
      "nodeId",
      "expectedTitle",
      "expectedBaseBranch",
      "expectedBaseSha",
      "expectedHeadBranch",
      "expectedHeadSha",
      "effectKey",
      "method",
    ]) ||
    !text(input.effectKey, 512) ||
    !stringEnum(input.method, MERGE_METHODS)
  ) {
    invalid("Merge request is malformed or exceeds its bounds");
  }
  const candidateInput = { ...input };
  delete candidateInput.effectKey;
  delete candidateInput.method;
  const candidate = assertMergeCandidateRequest(candidateInput);
  return { ...candidate, effectKey: input.effectKey, method: input.method };
}

export function assertMergeReceipt(value: unknown): MergeReceipt {
  const input = plainInput(value, "Merge receipt");
  if (
    !hasOnlyKeys(input, [
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
    ]) ||
    !repository(input.repository) ||
    !positiveInteger(input.number) ||
    !positiveInteger(input.issueNumber) ||
    !nodeId(input.nodeId) ||
    !stringEnum(input.method, MERGE_METHODS) ||
    !branch(input.baseBranch) ||
    !sha(input.baseSha) ||
    !branch(input.headBranch) ||
    !sha(input.headSha) ||
    !sha(input.mergeSha)
  ) {
    invalid("Merge receipt is malformed or exceeds its bounds");
  }
  return {
    repository: input.repository,
    number: input.number,
    issueNumber: input.issueNumber,
    nodeId: input.nodeId,
    method: input.method,
    baseBranch: input.baseBranch,
    baseSha: input.baseSha,
    headBranch: input.headBranch,
    headSha: input.headSha,
    mergeSha: input.mergeSha,
  };
}

export function assertObserveStagingRequest(
  value: unknown,
): ObserveStagingRequest {
  const input = plainInput(value, "Staging observation request");
  if (
    !hasOnlyKeys(input, [
      "repository",
      "workflow",
      "environment",
      "mergeSha",
    ]) ||
    !repository(input.repository) ||
    !text(input.workflow, 512) ||
    !text(input.environment, 256) ||
    !sha(input.mergeSha)
  ) {
    invalid("Staging observation request is malformed or exceeds its bounds");
  }
  return {
    repository: input.repository,
    workflow: input.workflow,
    environment: input.environment,
    mergeSha: input.mergeSha,
  };
}

function assertWorkflowRun(value: unknown): value is StagingWorkflowRunReceipt {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ["id", "workflow", "headSha", "status", "conclusion"]) &&
    nodeId(value.id) &&
    text(value.workflow, 512) &&
    sha(value.headSha) &&
    stringEnum(value.status, WORKFLOW_RUN_STATUSES) &&
    stringEnum(value.conclusion, WORKFLOW_CONCLUSIONS)
  );
}

function assertDeployment(value: unknown): value is StagingDeploymentReceipt {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ["id", "environment", "deployedSha", "state"]) &&
    nodeId(value.id) &&
    text(value.environment, 256) &&
    sha(value.deployedSha) &&
    stringEnum(value.state, DEPLOYMENT_STATES)
  );
}

export function assertStagingObservation(value: unknown): StagingObservation {
  const input = plainInput(value, "Staging observation");
  if (
    !hasOnlyKeys(input, [
      "repository",
      "workflow",
      "environment",
      "mergeSha",
      "workflowRun",
      "deployment",
      "outcome",
    ]) ||
    !repository(input.repository) ||
    !text(input.workflow, 512) ||
    !text(input.environment, 256) ||
    !sha(input.mergeSha) ||
    (input.workflowRun !== undefined &&
      !assertWorkflowRun(input.workflowRun)) ||
    (input.deployment !== undefined && !assertDeployment(input.deployment)) ||
    !stringEnum(input.outcome, STAGING_OUTCOMES)
  ) {
    invalid("Staging observation is malformed or exceeds its bounds");
  }
  if (
    input.workflowRun !== undefined &&
    input.workflowRun.workflow !== input.workflow
  ) {
    invalid(
      "Staging workflow evidence is not bound to the configured workflow",
    );
  }
  if (
    input.deployment !== undefined &&
    input.deployment.environment !== input.environment
  ) {
    invalid(
      "Staging deployment evidence is not bound to the configured environment",
    );
  }
  if (input.outcome === "deployed") {
    if (
      input.workflowRun === undefined ||
      input.deployment === undefined ||
      input.workflowRun.headSha !== input.mergeSha ||
      input.workflowRun.status !== "completed" ||
      input.workflowRun.conclusion !== "success" ||
      input.deployment.deployedSha !== input.mergeSha ||
      input.deployment.state !== "success"
    ) {
      invalid(
        "Deployed staging evidence must prove a successful exact-SHA workflow and deployment",
      );
    }
  }
  return {
    repository: input.repository,
    workflow: input.workflow,
    environment: input.environment,
    mergeSha: input.mergeSha,
    workflowRun: input.workflowRun,
    deployment: input.deployment,
    outcome: input.outcome,
  };
}

export function assertConditionalProjectDoneMoveRequest(
  value: unknown,
): ConditionalProjectDoneMoveRequest {
  const input = plainInput(value, "Project Done move request");
  if (
    !hasOnlyKeys(input, [
      "repository",
      "projectId",
      "projectNumber",
      "itemId",
      "issueNodeId",
      "issueNumber",
      "expectedRevision",
      "fromStatus",
      "toStatus",
      "effectKey",
      "mergeSha",
    ]) ||
    !repository(input.repository) ||
    !nodeId(input.projectId) ||
    !positiveInteger(input.projectNumber) ||
    !nodeId(input.itemId) ||
    !nodeId(input.issueNodeId) ||
    !positiveInteger(input.issueNumber) ||
    !text(input.expectedRevision, 512) ||
    !text(input.fromStatus, 256) ||
    !text(input.toStatus, 256) ||
    !text(input.effectKey, 512) ||
    !sha(input.mergeSha)
  ) {
    invalid("Project Done move request is malformed or exceeds its bounds");
  }
  return {
    repository: input.repository,
    projectId: input.projectId,
    projectNumber: input.projectNumber,
    itemId: input.itemId,
    issueNodeId: input.issueNodeId,
    issueNumber: input.issueNumber,
    expectedRevision: input.expectedRevision,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    effectKey: input.effectKey,
    mergeSha: input.mergeSha,
  };
}

/**
 * Select the repository-permitted merge capability without trusting provider
 * ordering.  The candidate must already contain a complete green, exact-head
 * review snapshot; mergePullRequest repeats these guards before mutation.
 */
export function selectMergeMethod(value: MergeCandidateReceipt): MergeMethod {
  const candidate = assertMergeCandidateReceipt(value);
  if (candidate.requiredChecks.aggregate !== "green") {
    failure(
      "required_checks_not_green",
      "The merge candidate does not have green required checks",
    );
  }
  if (candidate.threads.some((thread) => !thread.resolved)) {
    failure(
      "unresolved_threads",
      "The merge candidate has unresolved review threads",
    );
  }
  if (candidate.mergeability === "conflicting") {
    failure("merge_conflict", "The merge candidate is not mergeable");
  }
  if (candidate.mergeability === "unknown") {
    failure(
      "mergeability_unknown",
      "The merge candidate mergeability is unknown",
    );
  }
  for (const method of MERGE_METHODS) {
    if (candidate.permittedMergeMethods.includes(method)) return method;
  }
  failure(
    "merge_capability_unavailable",
    "No permitted merge capability is available",
  );
}

export function cloneMergeCandidate(
  value: MergeCandidateReceipt,
): MergeCandidateReceipt {
  const candidate = assertMergeCandidateReceipt(value);
  return {
    ...candidate,
    requiredChecks: {
      ...candidate.requiredChecks,
      requiredCheckNames: [...candidate.requiredChecks.requiredCheckNames],
      requiredChecks: candidate.requiredChecks.requiredChecks.map((check) => ({
        ...check,
      })),
    },
    threads: candidate.threads.map((thread) => ({ ...thread })),
    permittedMergeMethods: [...candidate.permittedMergeMethods],
  };
}

export function cloneMergeReceipt(value: MergeReceipt): MergeReceipt {
  return { ...assertMergeReceipt(value) };
}
