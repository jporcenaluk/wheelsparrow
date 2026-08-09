/**
 * The only GitHub boundary needed by publication and exact-head CI.  This is
 * deliberately a repository-shaped seam: callers provide the repository on
 * every request and implementations must reject any other repository.
 */

const MAX_REPOSITORY_BYTES = 256;
const MAX_EFFECT_KEY_BYTES = 512;
const MAX_TITLE_BYTES = 2_000;
const MAX_BODY_BYTES = 16 * 1_024;
const MAX_BRANCH_BYTES = 256;
const MAX_NODE_ID_BYTES = 256;
const MAX_URL_BYTES = 2_000;
const MAX_CHECK_NAME_BYTES = 256;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const BRANCH_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const NODE_ID_PATTERN = /^[A-Za-z0-9_:-]+$/u;
const CHECK_STATES = ["pending", "success", "failure"] as const;

export type RequiredCheckState = (typeof CHECK_STATES)[number];

export type RequiredChecksAggregate =
  | "pending"
  | "green"
  | "failed"
  | "head_drift";

export type GitHubPublicationFailureKind =
  | "invalid_input"
  | "repository_mismatch"
  | "effect_key_conflict"
  | "pull_request_not_found"
  | "pull_request_mismatch"
  | "pull_request_is_draft"
  | "head_drift"
  | "required_checks_mismatch";

export class GitHubPublicationBoundaryError extends Error {
  readonly kind: GitHubPublicationFailureKind;

  constructor(kind: GitHubPublicationFailureKind, message: string) {
    super(message);
    this.name = "GitHubPublicationBoundaryError";
    this.kind = kind;
  }
}

export interface PublishPullRequestRequest {
  readonly repository: string;
  readonly issueNumber: number;
  readonly effectKey: string;
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly headSha: string;
}

export interface PullRequestReceipt {
  readonly repository: string;
  readonly number: number;
  readonly nodeId: string;
  readonly url: string;
  readonly title: string;
  readonly issueNumber: number;
  readonly isDraft: boolean;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly headSha: string;
}

export interface ReadPullRequestRequest {
  readonly repository: string;
  readonly number: number;
  readonly issueNumber: number;
  readonly expectedNodeId: string;
  readonly expectedTitle: string;
  readonly expectedBaseBranch: string;
  readonly expectedBaseSha: string;
  readonly expectedHeadBranch: string;
  readonly expectedHeadSha: string;
}

export interface ObserveRequiredChecksRequest {
  readonly repository: string;
  readonly number: number;
  readonly nodeId: string;
  readonly expectedBaseBranch: string;
  readonly expectedBaseSha: string;
  readonly expectedHeadSha: string;
}

export interface RequiredCheckReceipt {
  readonly name: string;
  readonly state: RequiredCheckState;
}

export interface RequiredChecksReceipt {
  readonly repository: string;
  readonly number: number;
  readonly nodeId: string;
  /** The head SHA actually observed on the PR, never the requested SHA. */
  readonly headSha: string;
  readonly requiredChecks: readonly RequiredCheckReceipt[];
  /** True when the observed PR identity differs from the expected request. */
  readonly headDrift: boolean;
  readonly aggregate: RequiredChecksAggregate;
}

/** One concrete repository-bound PR and required-check gateway. */
export interface GitHubPublicationGateway {
  createPullRequest(
    request: PublishPullRequestRequest,
  ): Promise<PullRequestReceipt>;
  readPullRequest(request: ReadPullRequestRequest): Promise<PullRequestReceipt>;
  observeRequiredChecks(
    request: ObserveRequiredChecksRequest,
  ): Promise<RequiredChecksReceipt>;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
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

function text(
  value: unknown,
  _label: string,
  maximumBytes: number,
): value is string {
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
  if (!text(value, "repository", MAX_REPOSITORY_BYTES)) return false;
  const components = value.split("/");
  return (
    components.length === 2 &&
    components.every((component) => REPOSITORY_SEGMENT_PATTERN.test(component))
  );
}

function branch(value: unknown): value is string {
  if (!text(value, "branch", MAX_BRANCH_BYTES)) return false;
  const components = value.split("/");
  return (
    components.every(
      (component) =>
        BRANCH_COMPONENT_PATTERN.test(component) &&
        !component.endsWith(".") &&
        !component.endsWith(".lock"),
    ) &&
    !value.includes("..") &&
    !value.includes("@{")
  );
}

function nodeId(value: unknown): value is string {
  return (
    text(value, "node ID", MAX_NODE_ID_BYTES) && NODE_ID_PATTERN.test(value)
  );
}

function canonicalPullRequestUrl(
  value: unknown,
  repositoryName: string,
  number: number,
): value is string {
  if (!text(value, "pull request URL", MAX_URL_BYTES)) return false;
  const canonical = `https://github.com/${repositoryName}/pull/${number}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === "github.com" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.pathname === `/${repositoryName}/pull/${number}` &&
    parsed.href === canonical
  );
}

function derivedChecksAggregate(
  checks: readonly RequiredCheckReceipt[],
  headDrift: boolean,
): RequiredChecksAggregate {
  if (headDrift) return "head_drift";
  if (checks.some((check) => check.state === "failure")) return "failed";
  if (checks.every((check) => check.state === "success")) return "green";
  return "pending";
}

function failure(kind: GitHubPublicationFailureKind, message: string): never {
  throw new GitHubPublicationBoundaryError(kind, message);
}

function invalid(message: string): never {
  return failure("invalid_input", message);
}

function requirePlainInput(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) invalid(`${label} must be a plain object`);
  return value;
}

export function assertPublishPullRequestRequest(
  value: unknown,
): PublishPullRequestRequest {
  const input = requirePlainInput(value, "Create pull request request");
  if (
    !hasOnlyKeys(input, [
      "repository",
      "issueNumber",
      "effectKey",
      "title",
      "body",
      "baseBranch",
      "baseSha",
      "headBranch",
      "headSha",
    ]) ||
    !repository(input.repository) ||
    !positiveInteger(input.issueNumber) ||
    !text(input.effectKey, "effect key", MAX_EFFECT_KEY_BYTES) ||
    !text(input.title, "title", MAX_TITLE_BYTES) ||
    !text(input.body, "body", MAX_BODY_BYTES) ||
    !branch(input.baseBranch) ||
    !sha(input.baseSha) ||
    !branch(input.headBranch) ||
    !sha(input.headSha)
  ) {
    invalid("Create pull request request is malformed or exceeds its bounds");
  }
  return {
    repository: input.repository,
    issueNumber: input.issueNumber,
    effectKey: input.effectKey,
    title: input.title,
    body: input.body,
    baseBranch: input.baseBranch,
    baseSha: input.baseSha,
    headBranch: input.headBranch,
    headSha: input.headSha,
  };
}

export function assertReadPullRequestRequest(
  value: unknown,
): ReadPullRequestRequest {
  const input = requirePlainInput(value, "Read pull request request");
  if (
    !hasOnlyKeys(input, [
      "repository",
      "number",
      "issueNumber",
      "expectedNodeId",
      "expectedTitle",
      "expectedBaseBranch",
      "expectedBaseSha",
      "expectedHeadBranch",
      "expectedHeadSha",
    ]) ||
    !repository(input.repository) ||
    !positiveInteger(input.number) ||
    !positiveInteger(input.issueNumber) ||
    !nodeId(input.expectedNodeId) ||
    !text(input.expectedTitle, "expected title", MAX_TITLE_BYTES) ||
    !branch(input.expectedBaseBranch) ||
    !sha(input.expectedBaseSha) ||
    !branch(input.expectedHeadBranch) ||
    !sha(input.expectedHeadSha)
  ) {
    invalid("Read pull request request is malformed or exceeds its bounds");
  }
  return {
    repository: input.repository,
    number: input.number,
    issueNumber: input.issueNumber,
    expectedNodeId: input.expectedNodeId,
    expectedTitle: input.expectedTitle,
    expectedBaseBranch: input.expectedBaseBranch,
    expectedBaseSha: input.expectedBaseSha,
    expectedHeadBranch: input.expectedHeadBranch,
    expectedHeadSha: input.expectedHeadSha,
  };
}

export function assertObserveRequiredChecksRequest(
  value: unknown,
): ObserveRequiredChecksRequest {
  const input = requirePlainInput(value, "Observe required checks request");
  if (
    !hasOnlyKeys(input, [
      "repository",
      "number",
      "nodeId",
      "expectedBaseBranch",
      "expectedBaseSha",
      "expectedHeadSha",
    ]) ||
    !repository(input.repository) ||
    !positiveInteger(input.number) ||
    !nodeId(input.nodeId) ||
    !branch(input.expectedBaseBranch) ||
    !sha(input.expectedBaseSha) ||
    !sha(input.expectedHeadSha)
  ) {
    invalid(
      "Observe required checks request is malformed or exceeds its bounds",
    );
  }
  return {
    repository: input.repository,
    number: input.number,
    nodeId: input.nodeId,
    expectedBaseBranch: input.expectedBaseBranch,
    expectedBaseSha: input.expectedBaseSha,
    expectedHeadSha: input.expectedHeadSha,
  };
}

export function assertRequiredCheckState(value: unknown): RequiredCheckState {
  if (
    typeof value !== "string" ||
    !CHECK_STATES.includes(value as RequiredCheckState)
  ) {
    invalid("Required check state is invalid");
  }
  return value as RequiredCheckState;
}

export function assertCheckName(value: unknown): string {
  if (!text(value, "check name", MAX_CHECK_NAME_BYTES))
    invalid("Check name is malformed or exceeds its bounds");
  return value;
}

export function assertPullRequestReceipt(value: unknown): PullRequestReceipt {
  const receipt = requirePlainInput(value, "Pull request receipt");
  if (
    !hasOnlyKeys(receipt, [
      "repository",
      "number",
      "nodeId",
      "url",
      "title",
      "issueNumber",
      "isDraft",
      "baseBranch",
      "baseSha",
      "headBranch",
      "headSha",
    ]) ||
    !repository(receipt.repository) ||
    !positiveInteger(receipt.number) ||
    !nodeId(receipt.nodeId) ||
    !canonicalPullRequestUrl(receipt.url, receipt.repository, receipt.number) ||
    !text(receipt.title, "pull request title", MAX_TITLE_BYTES) ||
    !positiveInteger(receipt.issueNumber) ||
    receipt.isDraft !== false ||
    !branch(receipt.baseBranch) ||
    !sha(receipt.baseSha) ||
    !branch(receipt.headBranch) ||
    !sha(receipt.headSha)
  ) {
    invalid("Pull request receipt is malformed or exceeds its bounds");
  }
  return {
    repository: receipt.repository,
    number: receipt.number,
    nodeId: receipt.nodeId,
    url: receipt.url,
    title: receipt.title,
    issueNumber: receipt.issueNumber,
    isDraft: receipt.isDraft,
    baseBranch: receipt.baseBranch,
    baseSha: receipt.baseSha,
    headBranch: receipt.headBranch,
    headSha: receipt.headSha,
  };
}

export function assertRequiredChecksReceipt(
  value: unknown,
): RequiredChecksReceipt {
  const receipt = requirePlainInput(value, "Required checks receipt");
  if (
    !hasOnlyKeys(receipt, [
      "repository",
      "number",
      "nodeId",
      "headSha",
      "requiredChecks",
      "headDrift",
      "aggregate",
    ]) ||
    !repository(receipt.repository) ||
    !positiveInteger(receipt.number) ||
    !nodeId(receipt.nodeId) ||
    !sha(receipt.headSha) ||
    typeof receipt.headDrift !== "boolean" ||
    !isDenseArray(receipt.requiredChecks) ||
    receipt.requiredChecks.length === 0 ||
    receipt.requiredChecks.length > 128 ||
    receipt.requiredChecks.some((check) => {
      if (!isPlainRecord(check)) return true;
      return (
        !hasOnlyKeys(check, ["name", "state"]) ||
        !text(check.name, "check name", MAX_CHECK_NAME_BYTES) ||
        !CHECK_STATES.includes(check.state as RequiredCheckState)
      );
    }) ||
    new Set(
      receipt.requiredChecks.map((check) =>
        isPlainRecord(check) ? check.name : undefined,
      ),
    ).size !== receipt.requiredChecks.length ||
    !["pending", "green", "failed", "head_drift"].includes(
      receipt.aggregate as string,
    ) ||
    derivedChecksAggregate(
      receipt.requiredChecks as RequiredCheckReceipt[],
      receipt.headDrift,
    ) !== receipt.aggregate
  ) {
    invalid("Required checks receipt is malformed or exceeds its bounds");
  }
  return {
    repository: receipt.repository,
    number: receipt.number,
    nodeId: receipt.nodeId,
    headSha: receipt.headSha,
    requiredChecks: receipt.requiredChecks.map((check) => ({
      name: (check as Record<string, unknown>).name as string,
      state: (check as Record<string, unknown>).state as RequiredCheckState,
    })),
    headDrift: receipt.headDrift,
    aggregate: receipt.aggregate as RequiredChecksAggregate,
  };
}
