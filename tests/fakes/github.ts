import {
  assertConditionalProjectDoneMoveRequest,
  assertMergeCandidateReceipt,
  assertMergeCandidateRequest,
  assertMergeReceipt,
  assertMergeRequest,
  assertObserveStagingRequest,
  assertStagingObservation,
  type ConditionalProjectDoneMoveRequest,
  GitHubDeliveryBoundaryError,
  type GitHubDeliveryGateway,
  type MergeCandidateReceipt,
  type MergeCandidateRequest,
  type MergeMethod,
  type MergeReceipt,
  type MergeRequest,
  type MergeThreadReceipt,
  type ObserveStagingRequest,
  type ProjectDoneMoveResult,
  type StagingDeploymentReceipt,
  type StagingObservation,
  type StagingWorkflowRunReceipt,
} from "../../apps/server/src/github/delivery.js";
import type {
  ConditionalProjectStatusMove,
  GitHubProjectGateway,
  ProjectDependencies,
  ProjectItem,
  ProjectMoveRejection,
  ProjectSnapshot,
  ProjectSnapshotRequest,
  ProjectStatusMoveResult,
  ProjectStatusMutation,
} from "../../apps/server/src/github/project.js";
import {
  assertCheckName,
  assertObserveRequiredChecksRequest,
  assertPublishPullRequestRequest,
  assertReadPullRequestRequest,
  assertReconcilePullRequestRequest,
  assertRequiredCheckState,
  assertRequiredChecksReceipt,
  GitHubPublicationBoundaryError,
  type GitHubPublicationGateway,
  type ObserveRequiredChecksRequest,
  type PublishPullRequestRequest,
  type PullRequestReceipt,
  type ReconcilePullRequestRequest,
  type RequiredCheckState,
  type RequiredChecksReceipt,
} from "../../apps/server/src/github/publication.js";

type MutableProjectItem = {
  projectItemId: string;
  projectId: string;
  projectNumber: number;
  repository: string;
  issueNodeId: string;
  issueNumber: number;
  isOpen: boolean;
  status: string;
  revision: string;
  labels: string[];
  createdAt: string;
  priorityRank?: number;
  dependencies: ProjectDependencies;
};

type Drift = {
  readonly revision?: string;
  readonly status?: string;
  readonly issueNodeId?: string;
  readonly issueNumber?: number;
};

function cloneDependencies(
  dependencies: ProjectDependencies,
): ProjectDependencies {
  if (dependencies === "unavailable") return dependencies;
  return dependencies.map((dependency) => ({ ...dependency }));
}

function cloneItem(item: MutableProjectItem | ProjectItem): ProjectItem {
  const result = {
    projectItemId: item.projectItemId,
    projectId: item.projectId,
    projectNumber: item.projectNumber,
    repository: item.repository,
    issueNodeId: item.issueNodeId,
    issueNumber: item.issueNumber,
    isOpen: item.isOpen,
    status: item.status,
    revision: item.revision,
    labels: [...item.labels],
    createdAt: item.createdAt,
    dependencies: cloneDependencies(item.dependencies),
  } satisfies Omit<ProjectItem, "priorityRank"> & { priorityRank?: number };

  return item.priorityRank === undefined
    ? result
    : { ...result, priorityRank: item.priorityRank };
}

function cloneRequest(
  request: ConditionalProjectStatusMove,
): ConditionalProjectStatusMove {
  return { ...request };
}

function cloneMutation(mutation: ProjectStatusMutation): ProjectStatusMutation {
  return {
    effectKey: mutation.effectKey,
    itemId: mutation.itemId,
    fromStatus: mutation.fromStatus,
    toStatus: mutation.toStatus,
    previousRevision: mutation.previousRevision,
    revision: mutation.revision,
    request: cloneRequest(mutation.request),
    item: cloneItem(mutation.item),
  };
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    if (nested !== null && typeof nested === "object") freezeDeep(nested);
  }
  return Object.freeze(value);
}

function toMutable(item: ProjectItem): MutableProjectItem {
  const mutable: MutableProjectItem = {
    projectItemId: item.projectItemId,
    projectId: item.projectId,
    projectNumber: item.projectNumber,
    repository: item.repository,
    issueNodeId: item.issueNodeId,
    issueNumber: item.issueNumber,
    isOpen: item.isOpen,
    status: item.status,
    revision: item.revision,
    labels: [...item.labels],
    createdAt: item.createdAt,
    dependencies: cloneDependencies(item.dependencies),
  };
  if (item.priorityRank !== undefined) mutable.priorityRank = item.priorityRank;
  return mutable;
}

function requireItem(
  items: ReadonlyMap<string, MutableProjectItem>,
  projectItemId: string,
): MutableProjectItem {
  const item = items.get(projectItemId);
  if (item === undefined)
    throw new Error(`Unknown project item: ${projectItemId}`);
  return item;
}

function sameMoveRequest(
  left: ConditionalProjectStatusMove,
  right: ConditionalProjectStatusMove,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.projectNumber === right.projectNumber &&
    left.itemId === right.itemId &&
    left.issueNodeId === right.issueNodeId &&
    left.issueNumber === right.issueNumber &&
    left.expectedRevision === right.expectedRevision &&
    left.fromStatus === right.fromStatus &&
    left.toStatus === right.toStatus &&
    left.effectKey === right.effectKey
  );
}

export class FakeGitHubProjectGateway implements GitHubProjectGateway {
  readonly #projectId: string;
  readonly #projectNumber: number;
  readonly #repository: string;
  readonly #items = new Map<string, MutableProjectItem>();
  readonly #revisionCounters = new Map<string, number>();
  readonly #mutations: ProjectStatusMutation[] = [];
  readonly #mutationsByEffectKey = new Map<string, ProjectStatusMutation>();

  constructor(snapshot: ProjectSnapshot) {
    if (snapshot.projectId.length === 0)
      throw new Error("Project ID must not be empty");
    if (
      !Number.isInteger(snapshot.projectNumber) ||
      snapshot.projectNumber <= 0
    )
      throw new Error("Project number must be a positive integer");
    if (snapshot.repository.length === 0)
      throw new Error("Repository must not be empty");
    this.#projectId = snapshot.projectId;
    this.#projectNumber = snapshot.projectNumber;
    this.#repository = snapshot.repository;

    for (const item of snapshot.items) {
      if (
        item.projectId !== this.#projectId ||
        item.projectNumber !== this.#projectNumber
      ) {
        throw new Error(
          `Project item ${item.projectItemId} belongs to another project`,
        );
      }
      if (item.repository !== this.#repository) {
        throw new Error(
          `Project item ${item.projectItemId} belongs to another repository`,
        );
      }
      if (
        typeof item.issueNodeId !== "string" ||
        item.issueNodeId.trim().length === 0
      ) {
        throw new Error("Issue node ID must not be blank");
      }
      if (!Number.isSafeInteger(item.issueNumber) || item.issueNumber <= 0) {
        throw new Error("Issue number must be a positive safe integer");
      }
      if (item.revision.length === 0)
        throw new Error("Item revision must not be empty");
      if (item.projectItemId.length === 0)
        throw new Error("Project item ID must not be empty");
      if (this.#items.has(item.projectItemId)) {
        throw new Error(`Duplicate project item: ${item.projectItemId}`);
      }
      this.#items.set(item.projectItemId, toMutable(item));
      this.#revisionCounters.set(item.projectItemId, 1);
    }
  }

  async readProject(request: ProjectSnapshotRequest): Promise<ProjectSnapshot> {
    if (
      request.projectId !== this.#projectId ||
      request.projectNumber !== this.#projectNumber
    ) {
      throw new Error(`Unknown project: ${request.projectId}`);
    }
    if (request.repository !== this.#repository) {
      throw new Error(`Unknown repository: ${request.repository}`);
    }
    return {
      projectId: this.#projectId,
      projectNumber: this.#projectNumber,
      repository: this.#repository,
      items: [...this.#items.values()].map(cloneItem),
    };
  }

  async readProjectItem(
    projectItemId: string,
  ): Promise<ProjectItem | undefined> {
    const item = this.#items.get(projectItemId);
    return item === undefined ? undefined : cloneItem(item);
  }

  async moveProjectItem(
    request: ConditionalProjectStatusMove,
  ): Promise<ProjectStatusMoveResult> {
    const invalidRequest = this.#validateMoveRequest(request);
    if (invalidRequest !== undefined) {
      return { outcome: "rejected", reason: invalidRequest };
    }
    if (
      request.projectId !== this.#projectId ||
      request.projectNumber !== this.#projectNumber
    ) {
      return {
        outcome: "rejected",
        reason: {
          kind: "wrong_project",
          expectedProjectId: this.#projectId,
          expectedProjectNumber: this.#projectNumber,
        },
      };
    }

    const item = this.#items.get(request.itemId);
    if (item === undefined) {
      return {
        outcome: "rejected",
        reason: { kind: "unknown_item", itemId: request.itemId },
      };
    }

    const previousMutation = this.#mutationsByEffectKey.get(request.effectKey);
    if (previousMutation !== undefined) {
      if (!sameMoveRequest(previousMutation.request, request)) {
        return {
          outcome: "rejected",
          reason: { kind: "effect_key_conflict", effectKey: request.effectKey },
        };
      }
      const mapping = this.#issueMappingRejection(item, request);
      if (mapping !== undefined)
        return { outcome: "rejected", reason: mapping };
      if (
        item.status !== previousMutation.item.status ||
        item.revision !== previousMutation.item.revision
      ) {
        return {
          outcome: "rejected",
          reason: {
            kind: "already_applied_drift",
            expectedStatus: previousMutation.item.status,
            expectedRevision: previousMutation.item.revision,
            actualStatus: item.status,
            actualRevision: item.revision,
          },
        };
      }
      return { outcome: "already_applied", item: cloneItem(item) };
    }

    const mapping = this.#issueMappingRejection(item, request);
    if (mapping !== undefined) return { outcome: "rejected", reason: mapping };
    if (item.revision !== request.expectedRevision) {
      return {
        outcome: "rejected",
        reason: {
          kind: "revision_mismatch",
          expectedRevision: request.expectedRevision,
          actualRevision: item.revision,
        },
      };
    }
    if (item.status !== request.fromStatus) {
      return {
        outcome: "rejected",
        reason: {
          kind: "status_mismatch",
          expectedStatus: request.fromStatus,
          actualStatus: item.status,
        },
      };
    }

    const previousRevision = item.revision;
    item.status = request.toStatus;
    item.revision = this.#nextRevision(request.itemId, item.revision);
    const observed = cloneItem(item);
    const mutation: ProjectStatusMutation = {
      effectKey: request.effectKey,
      itemId: request.itemId,
      fromStatus: request.fromStatus,
      toStatus: request.toStatus,
      previousRevision,
      revision: item.revision,
      request: cloneRequest(request),
      item: observed,
    };
    this.#mutations.push(mutation);
    this.#mutationsByEffectKey.set(request.effectKey, mutation);
    return { outcome: "moved", item: cloneItem(item) };
  }

  mutations(): readonly ProjectStatusMutation[] {
    return Object.freeze(
      this.#mutations.map((mutation) => freezeDeep(cloneMutation(mutation))),
    );
  }

  setStatus(projectItemId: string, status: string): void {
    this.simulateDrift(projectItemId, { status });
  }

  remapIssue(
    projectItemId: string,
    mapping: { readonly issueNodeId: string; readonly issueNumber: number },
  ): void {
    this.simulateDrift(projectItemId, mapping);
  }

  simulateRevisionDrift(projectItemId: string): void {
    this.simulateDrift(projectItemId);
  }

  simulateDrift(projectItemId: string, drift: Drift = {}): void {
    const item = requireItem(this.#items, projectItemId);
    if (drift.revision !== undefined && drift.revision.length === 0) {
      throw new Error("Drift revision must not be empty");
    }
    if (drift.status !== undefined) item.status = drift.status;
    if (drift.issueNodeId !== undefined) item.issueNodeId = drift.issueNodeId;
    if (drift.issueNumber !== undefined) item.issueNumber = drift.issueNumber;
    item.revision =
      drift.revision ?? this.#nextRevision(projectItemId, item.revision);
  }

  #nextRevision(projectItemId: string, currentRevision?: string): string {
    let next = (this.#revisionCounters.get(projectItemId) ?? 1) + 1;
    while (String(next) === currentRevision) next += 1;
    this.#revisionCounters.set(projectItemId, next);
    return String(next);
  }

  #validateMoveRequest(
    request: ConditionalProjectStatusMove,
  ): ProjectMoveRejection | undefined {
    if (
      typeof request.effectKey !== "string" ||
      request.effectKey.trim().length === 0
    ) {
      return { kind: "invalid_request", field: "effectKey" };
    }
    if (
      typeof request.fromStatus !== "string" ||
      request.fromStatus.trim().length === 0
    ) {
      return { kind: "invalid_request", field: "fromStatus" };
    }
    if (
      typeof request.toStatus !== "string" ||
      request.toStatus.trim().length === 0
    ) {
      return { kind: "invalid_request", field: "toStatus" };
    }
    if (
      typeof request.expectedRevision !== "string" ||
      request.expectedRevision.trim().length === 0
    ) {
      return { kind: "invalid_request", field: "expectedRevision" };
    }
    if (
      !Number.isInteger(request.projectNumber) ||
      request.projectNumber <= 0
    ) {
      return { kind: "invalid_request", field: "projectNumber" };
    }
    if (!Number.isInteger(request.issueNumber) || request.issueNumber <= 0) {
      return { kind: "invalid_request", field: "issueNumber" };
    }
    return undefined;
  }

  #issueMappingRejection(
    item: MutableProjectItem,
    request: ConditionalProjectStatusMove,
  ):
    | Extract<ProjectStatusMoveResult, { outcome: "rejected" }>["reason"]
    | undefined {
    if (
      item.issueNodeId === request.issueNodeId &&
      item.issueNumber === request.issueNumber
    ) {
      return undefined;
    }
    return {
      kind: "issue_mapping_mismatch",
      expectedIssueNodeId: request.issueNodeId,
      expectedIssueNumber: request.issueNumber,
      actualIssueNodeId: item.issueNodeId,
      actualIssueNumber: item.issueNumber,
    };
  }
}

type MutablePullRequest = {
  -readonly [Key in keyof PullRequestReceipt]: PullRequestReceipt[Key];
} & { body: string };

export interface FakeGitHubPublicationConfiguration {
  readonly repository: string;
  readonly requiredChecks: readonly string[];
}

export interface PublicationMutation {
  readonly effectKey: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly number: number;
  readonly nodeId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly request: PublishPullRequestRequest;
}

function clonePullRequest(request: MutablePullRequest): PullRequestReceipt {
  return {
    repository: request.repository,
    number: request.number,
    nodeId: request.nodeId,
    url: request.url,
    title: request.title,
    issueNumber: request.issueNumber,
    isDraft: request.isDraft,
    baseBranch: request.baseBranch,
    baseSha: request.baseSha,
    headBranch: request.headBranch,
    headSha: request.headSha,
  };
}

function clonePublishRequest(
  request: PublishPullRequestRequest,
): PublishPullRequestRequest {
  return { ...request };
}

function samePublishRequest(
  left: PublishPullRequestRequest,
  right: PublishPullRequestRequest,
): boolean {
  return (
    left.repository === right.repository &&
    left.issueNumber === right.issueNumber &&
    left.effectKey === right.effectKey &&
    left.title === right.title &&
    left.body === right.body &&
    left.baseBranch === right.baseBranch &&
    left.baseSha === right.baseSha &&
    left.headBranch === right.headBranch &&
    left.headSha === right.headSha
  );
}

function sameRequestTarget(
  request: PublishPullRequestRequest,
  pullRequest: MutablePullRequest,
): boolean {
  return (
    request.repository === pullRequest.repository &&
    request.issueNumber === pullRequest.issueNumber &&
    request.title === pullRequest.title &&
    request.baseBranch === pullRequest.baseBranch &&
    request.baseSha === pullRequest.baseSha &&
    request.headBranch === pullRequest.headBranch &&
    request.headSha === pullRequest.headSha
  );
}

function publicationFailure(
  kind: ConstructorParameters<typeof GitHubPublicationBoundaryError>[0],
  message: string,
): never {
  throw new GitHubPublicationBoundaryError(kind, message);
}

/**
 * Stateful, network-free GitHub publication fake. It deliberately stores PR
 * and check state separately so tests can model a provider-side head change
 * or partial check suite without mutating the caller's receipts.
 */
export class FakeGitHubPublicationGateway implements GitHubPublicationGateway {
  readonly #repository: string;
  readonly #requiredCheckNames: readonly string[];
  readonly #pullRequests = new Map<number, MutablePullRequest>();
  readonly #checkStates = new Map<
    number,
    { headSha: string; states: Map<string, RequiredCheckState> }
  >();
  readonly #mutations: PublicationMutation[] = [];
  readonly #mutationsByEffectKey = new Map<string, PublicationMutation>();
  #nextNumber = 1;

  constructor(configuration: FakeGitHubPublicationConfiguration) {
    if (
      typeof configuration.repository !== "string" ||
      configuration.repository.trim().length === 0
    ) {
      throw new Error("Publication repository must not be blank");
    }
    if (
      !Array.isArray(configuration.requiredChecks) ||
      configuration.requiredChecks.length === 0
    ) {
      throw new Error("At least one required check is needed");
    }
    const names = configuration.requiredChecks.map((name) =>
      assertCheckName(name),
    );
    if (new Set(names).size !== names.length) {
      throw new Error("Required check names must be unique");
    }
    this.#repository = configuration.repository;
    this.#requiredCheckNames = Object.freeze([...names]);
  }

  async createPullRequest(
    value: PublishPullRequestRequest,
  ): Promise<PullRequestReceipt> {
    const request = assertPublishPullRequestRequest(value);
    this.#assertRepository(request.repository);

    const previousMutation = this.#mutationsByEffectKey.get(request.effectKey);
    if (previousMutation !== undefined) {
      if (!samePublishRequest(previousMutation.request, request)) {
        publicationFailure(
          "effect_key_conflict",
          "Publication effect key was reused with different request facts",
        );
      }
      const existing = this.#pullRequests.get(previousMutation.number);
      if (existing?.isDraft === true) {
        publicationFailure(
          "pull_request_is_draft",
          "Publication replay requires a non-draft pull request",
        );
      }
      if (existing === undefined || !sameRequestTarget(request, existing)) {
        publicationFailure(
          "head_drift",
          "The replayed publication no longer matches the recorded PR",
        );
      }
      return clonePullRequest(existing);
    }

    const existing = [...this.#pullRequests.values()].find(
      (pullRequest) =>
        pullRequest.repository === request.repository &&
        pullRequest.issueNumber === request.issueNumber &&
        pullRequest.headBranch === request.headBranch,
    );
    if (existing !== undefined) {
      if (!sameRequestTarget(request, existing) || existing.isDraft) {
        publicationFailure(
          "pull_request_mismatch",
          "An existing linked PR does not match the requested publication",
        );
      }
      return clonePullRequest(existing);
    }

    const number = this.#nextNumber;
    this.#nextNumber += 1;
    const created: MutablePullRequest = {
      repository: request.repository,
      number,
      nodeId: `PR_node_${number}`,
      url: `https://github.com/${request.repository}/pull/${number}`,
      title: request.title,
      issueNumber: request.issueNumber,
      isDraft: false,
      baseBranch: request.baseBranch,
      baseSha: request.baseSha,
      headBranch: request.headBranch,
      headSha: request.headSha,
      body: request.body,
    };
    this.#pullRequests.set(number, created);
    this.#checkStates.set(number, {
      headSha: created.headSha,
      states: new Map(),
    });
    const mutation: PublicationMutation = {
      effectKey: request.effectKey,
      repository: request.repository,
      issueNumber: request.issueNumber,
      number,
      nodeId: created.nodeId,
      baseSha: created.baseSha,
      headSha: created.headSha,
      request: clonePublishRequest(request),
    };
    this.#mutations.push(mutation);
    this.#mutationsByEffectKey.set(request.effectKey, mutation);
    return clonePullRequest(created);
  }

  async reconcilePullRequest(
    value: ReconcilePullRequestRequest,
  ): Promise<PullRequestReceipt> {
    const request = assertReconcilePullRequestRequest(value);
    this.#assertRepository(request.repository);
    const pullRequest = this.#pullRequests.get(request.expectedNumber);
    if (pullRequest === undefined) {
      publicationFailure(
        "pull_request_not_found",
        "The recorded pull request was not found for reconciliation",
      );
    }
    if (
      pullRequest.nodeId !== request.expectedNodeId ||
      pullRequest.repository !== request.repository ||
      pullRequest.issueNumber !== request.issueNumber ||
      pullRequest.title !== request.title ||
      pullRequest.baseBranch !== request.baseBranch ||
      pullRequest.baseSha !== request.baseSha ||
      pullRequest.headBranch !== request.headBranch ||
      pullRequest.headSha !== request.headSha ||
      pullRequest.isDraft
    ) {
      publicationFailure(
        "pull_request_mismatch",
        "The recorded pull request does not match the repaired publication",
      );
    }
    return clonePullRequest(pullRequest);
  }

  async readPullRequest(value: unknown): Promise<PullRequestReceipt> {
    const request = assertReadPullRequestRequest(value);
    this.#assertRepository(request.repository);
    const pullRequest = this.#pullRequests.get(request.number);
    if (pullRequest === undefined) {
      publicationFailure(
        "pull_request_not_found",
        "The requested pull request was not found",
      );
    }
    if (pullRequest.isDraft) {
      publicationFailure(
        "pull_request_is_draft",
        "Publication requires a non-draft pull request",
      );
    }
    if (
      pullRequest.repository !== request.repository ||
      pullRequest.issueNumber !== request.issueNumber ||
      pullRequest.nodeId !== request.expectedNodeId ||
      pullRequest.title !== request.expectedTitle ||
      pullRequest.baseBranch !== request.expectedBaseBranch ||
      pullRequest.baseSha !== request.expectedBaseSha ||
      pullRequest.headBranch !== request.expectedHeadBranch
    ) {
      publicationFailure(
        "pull_request_mismatch",
        "The pull request identity or base does not match the expected receipt",
      );
    }
    if (pullRequest.headSha !== request.expectedHeadSha) {
      publicationFailure(
        "head_drift",
        "The pull request head changed after publication",
      );
    }
    return clonePullRequest(pullRequest);
  }

  async observeRequiredChecks(
    value: ObserveRequiredChecksRequest,
  ): Promise<RequiredChecksReceipt> {
    const request = assertObserveRequiredChecksRequest(value);
    this.#assertRepository(request.repository);
    const pullRequest = this.#pullRequests.get(request.number);
    if (pullRequest === undefined) {
      publicationFailure(
        "pull_request_not_found",
        "The requested pull request was not found",
      );
    }
    if (pullRequest.nodeId !== request.nodeId) {
      publicationFailure(
        "pull_request_mismatch",
        "The observed pull request node does not match the expected PR",
      );
    }
    if (pullRequest.isDraft) {
      publicationFailure(
        "pull_request_is_draft",
        "Publication checks require a non-draft pull request",
      );
    }
    const checkState = this.#checkStates.get(request.number);
    if (checkState === undefined) {
      publicationFailure(
        "required_checks_mismatch",
        "Required check state is unavailable for the pull request",
      );
    }
    const headDrifted =
      pullRequest.headSha !== request.expectedHeadSha ||
      pullRequest.baseBranch !== request.expectedBaseBranch ||
      pullRequest.baseSha !== request.expectedBaseSha;
    const requiredChecks = this.#requiredCheckNames.map((name) => ({
      name,
      state: headDrifted
        ? ("pending" as const)
        : checkState.headSha === pullRequest.headSha
          ? (checkState.states.get(name) ?? "pending")
          : "pending",
    }));
    const aggregate: RequiredChecksReceipt["aggregate"] = headDrifted
      ? "head_drift"
      : requiredChecks.some((check) => check.state === "failure")
        ? "failed"
        : requiredChecks.every((check) => check.state === "success")
          ? "green"
          : "pending";
    const receipt: RequiredChecksReceipt = {
      repository: pullRequest.repository,
      number: pullRequest.number,
      nodeId: pullRequest.nodeId,
      headSha: pullRequest.headSha,
      requiredCheckNames: [...this.#requiredCheckNames],
      requiredChecks,
      headDrift: headDrifted,
      aggregate,
    };
    return assertRequiredChecksReceipt(receipt);
  }

  setRequiredCheck(
    number: number,
    headSha: string,
    name: string,
    state: RequiredCheckState,
  ): void {
    const checkName = assertCheckName(name);
    const checkState = assertRequiredCheckState(state);
    if (!this.#requiredCheckNames.includes(checkName)) {
      throw new Error(`Unknown required check: ${checkName}`);
    }
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error("Pull request number must be a positive integer");
    if (!/^[0-9a-f]{40}$/u.test(headSha))
      throw new Error("Required check head must be a SHA-1");
    const states = this.#checkStates.get(number);
    const pullRequest = this.#pullRequests.get(number);
    if (states === undefined || pullRequest === undefined)
      throw new Error("Required check state is missing");
    if (pullRequest.headSha !== headSha)
      publicationFailure(
        "head_drift",
        "Required check mutation targets a stale PR head",
      );
    if (states.headSha !== headSha) {
      states.headSha = headSha;
      states.states = new Map();
    }
    states.states.set(checkName, checkState);
  }

  setPullRequestHead(number: number, headSha: string): void {
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new Error("Pull request number must be a positive integer");
    }
    if (!/^[0-9a-f]{40}$/u.test(headSha)) {
      throw new Error("Pull request head must be a SHA-1");
    }
    const pullRequest = this.#pullRequests.get(number);
    if (pullRequest === undefined) throw new Error("Unknown pull request");
    pullRequest.headSha = headSha;
    const checkState = this.#checkStates.get(number);
    if (checkState !== undefined) {
      checkState.headSha = headSha;
      checkState.states = new Map();
    }
  }

  /** Advance the linked PR head between bounded repair rounds. */
  advancePullRequestHead(number: number, headSha: string): void {
    this.setPullRequestHead(number, headSha);
  }

  setPullRequestBase(number: number, baseSha: string): void {
    if (!/^[0-9a-f]{40}$/u.test(baseSha)) {
      throw new Error("Pull request base must be a SHA-1");
    }
    const pullRequest = this.#pullRequests.get(number);
    if (pullRequest === undefined) throw new Error("Unknown pull request");
    pullRequest.baseSha = baseSha;
  }

  setPullRequestDraft(number: number, isDraft: boolean): void {
    const pullRequest = this.#pullRequests.get(number);
    if (pullRequest === undefined) throw new Error("Unknown pull request");
    pullRequest.isDraft = isDraft;
  }

  publicationMutations(): readonly PublicationMutation[] {
    return Object.freeze(
      this.#mutations.map((mutation) =>
        Object.freeze({
          ...mutation,
          request: clonePublishRequest(mutation.request),
        }),
      ),
    );
  }

  #assertRepository(repository: string): void {
    if (repository !== this.#repository) {
      publicationFailure(
        "repository_mismatch",
        "The publication request targets a different repository",
      );
    }
  }
}

type MutableDeliveryPullRequest = {
  repository: string;
  number: number;
  issueNumber: number;
  nodeId: string;
  isDraft: boolean;
  title: string;
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  headSha: string;
};

type DeliveryMutation = {
  effectKey: string;
  request: MergeRequest;
  receipt: MergeReceipt;
};

type DoneMutation = {
  effectKey: string;
  request: ConditionalProjectDoneMoveRequest;
  item: ProjectItem;
};

type FakeGitHubDeliveryConfiguration = {
  readonly repository: string;
  readonly requiredChecks: readonly string[];
  readonly staging: {
    readonly workflow: string;
    readonly environment: string;
  };
};

function cloneDeliveryRequest(request: MergeRequest): MergeRequest {
  return { ...request };
}

function sameDeliveryRequest(left: MergeRequest, right: MergeRequest): boolean {
  return (
    left.repository === right.repository &&
    left.number === right.number &&
    left.issueNumber === right.issueNumber &&
    left.nodeId === right.nodeId &&
    left.expectedTitle === right.expectedTitle &&
    left.expectedBaseBranch === right.expectedBaseBranch &&
    left.expectedBaseSha === right.expectedBaseSha &&
    left.expectedHeadBranch === right.expectedHeadBranch &&
    left.expectedHeadSha === right.expectedHeadSha &&
    left.effectKey === right.effectKey &&
    left.method === right.method
  );
}

function deliveryFailure(
  kind: ConstructorParameters<typeof GitHubDeliveryBoundaryError>[0],
  message: string,
): never {
  throw new GitHubDeliveryBoundaryError(kind, message);
}

function cloneDeliveryReceipt(receipt: MergeReceipt): MergeReceipt {
  return { ...receipt };
}

function cloneThreads(
  threads: readonly MergeThreadReceipt[],
): readonly MergeThreadReceipt[] {
  return Object.freeze(threads.map((thread) => Object.freeze({ ...thread })));
}

/**
 * Stateful, network-free fake for the Block 7 delivery boundary.  PR facts,
 * provider-side drift, merge effects, deployments, and conditional project
 * moves are independent mutable state so tests can exercise reconciliation.
 */
export class FakeGitHubDeliveryGateway implements GitHubDeliveryGateway {
  readonly #repository: string;
  readonly #requiredCheckNames: readonly string[];
  readonly #stagingWorkflow: string;
  readonly #stagingEnvironment: string;
  readonly #pullRequests = new Map<number, MutableDeliveryPullRequest>();
  readonly #checkStates = new Map<
    number,
    { headSha: string; states: Map<string, RequiredCheckState> }
  >();
  readonly #threads = new Map<number, MergeThreadReceipt[]>();
  readonly #mergeability = new Map<
    number,
    MergeCandidateReceipt["mergeability"]
  >();
  readonly #permittedMethods = new Map<number, MergeMethod[]>();
  readonly #mergeMutations: DeliveryMutation[] = [];
  readonly #mergeMutationsByEffectKey = new Map<string, DeliveryMutation>();
  readonly #mergedReceipts = new Map<number, MergeReceipt>();
  readonly #workflowRuns = new Map<string, StagingWorkflowRunReceipt>();
  readonly #deployment: { current: StagingDeploymentReceipt | undefined } = {
    current: undefined,
  };
  readonly #projectItems = new Map<string, MutableProjectItem>();
  readonly #doneMutations: DoneMutation[] = [];
  readonly #doneMutationsByEffectKey = new Map<string, DoneMutation>();
  readonly #revisionCounters = new Map<string, number>();
  #nextMergeSha = "c".repeat(40);
  #mergeFailure: "merge_prevented" | "merge_ambiguous" | undefined;

  constructor(configuration: FakeGitHubDeliveryConfiguration) {
    if (
      typeof configuration.repository !== "string" ||
      configuration.repository.trim().length === 0
    ) {
      throw new Error("Delivery repository must not be blank");
    }
    if (
      !Array.isArray(configuration.requiredChecks) ||
      configuration.requiredChecks.length === 0
    ) {
      throw new Error("At least one required check is needed");
    }
    const names = configuration.requiredChecks.map((name) =>
      assertCheckName(name),
    );
    if (new Set(names).size !== names.length) {
      throw new Error("Required check names must be unique");
    }
    if (
      typeof configuration.staging?.workflow !== "string" ||
      configuration.staging.workflow.trim().length === 0 ||
      typeof configuration.staging?.environment !== "string" ||
      configuration.staging.environment.trim().length === 0
    ) {
      throw new Error("Staging workflow and environment are required");
    }
    this.#repository = configuration.repository;
    this.#requiredCheckNames = Object.freeze([...names]);
    this.#stagingWorkflow = configuration.staging.workflow;
    this.#stagingEnvironment = configuration.staging.environment;
  }

  seedPullRequest(value: MergeCandidateReceipt): void {
    const candidate = assertMergeCandidateReceipt(value);
    this.#assertRepository(candidate.repository);
    if (
      candidate.requiredChecks.requiredCheckNames.join("\u0000") !==
      this.#requiredCheckNames.join("\u0000")
    ) {
      throw new Error("Seeded checks do not match configured required checks");
    }
    this.#pullRequests.set(candidate.number, {
      repository: candidate.repository,
      number: candidate.number,
      issueNumber: candidate.issueNumber,
      nodeId: candidate.nodeId,
      isDraft: candidate.isDraft,
      title: candidate.title,
      baseBranch: candidate.baseBranch,
      baseSha: candidate.baseSha,
      headBranch: candidate.headBranch,
      headSha: candidate.headSha,
    });
    this.#checkStates.set(candidate.number, {
      headSha: candidate.headSha,
      states: new Map(
        candidate.requiredChecks.requiredChecks.map((check) => [
          check.name,
          check.state,
        ]),
      ),
    });
    this.#threads.set(
      candidate.number,
      candidate.threads.map((thread) => ({ ...thread })),
    );
    this.#mergeability.set(candidate.number, candidate.mergeability);
    this.#permittedMethods.set(candidate.number, [
      ...candidate.permittedMergeMethods,
    ]);
  }

  async readMergeCandidate(
    value: MergeCandidateRequest,
  ): Promise<MergeCandidateReceipt> {
    const request = assertMergeCandidateRequest(value);
    this.#assertRepository(request.repository);
    return this.#readCandidate(request);
  }

  async mergePullRequest(value: MergeRequest): Promise<MergeReceipt> {
    const request = assertMergeRequest(value);
    this.#assertRepository(request.repository);
    const previous = this.#mergeMutationsByEffectKey.get(request.effectKey);
    if (previous !== undefined) {
      if (!sameDeliveryRequest(previous.request, request)) {
        deliveryFailure(
          "effect_key_conflict",
          "Merge effect key was reused with different request facts",
        );
      }
      return cloneDeliveryReceipt(previous.receipt);
    }
    const candidate = this.#readCandidate(request);
    this.#assertMergeRequestMatchesCandidate(request, candidate);
    if (candidate.requiredChecks.aggregate !== "green") {
      deliveryFailure(
        "required_checks_not_green",
        "The merge candidate does not have green required checks",
      );
    }
    if (candidate.threads.some((thread) => !thread.resolved)) {
      deliveryFailure(
        "unresolved_threads",
        "The merge candidate has unresolved review threads",
      );
    }
    if (candidate.mergeability === "conflicting") {
      deliveryFailure("merge_conflict", "The merge candidate is not mergeable");
    }
    if (candidate.mergeability === "unknown") {
      deliveryFailure(
        "mergeability_unknown",
        "The merge candidate mergeability is unknown",
      );
    }
    if (!candidate.permittedMergeMethods.includes(request.method)) {
      deliveryFailure(
        "merge_method_not_permitted",
        "The requested merge method is not permitted",
      );
    }
    if (this.#mergeFailure !== undefined) {
      deliveryFailure(
        this.#mergeFailure,
        this.#mergeFailure === "merge_prevented"
          ? "The repository prevented the merge"
          : "The merge result was ambiguous",
      );
    }
    const receipt = assertMergeReceipt({
      repository: candidate.repository,
      number: candidate.number,
      issueNumber: candidate.issueNumber,
      nodeId: candidate.nodeId,
      method: request.method,
      baseBranch: candidate.baseBranch,
      baseSha: candidate.baseSha,
      headBranch: candidate.headBranch,
      headSha: candidate.headSha,
      mergeSha: this.#nextMergeSha,
    });
    this.#nextMergeSha = this.#nextSha(receipt.mergeSha);
    const mutation: DeliveryMutation = {
      effectKey: request.effectKey,
      request: cloneDeliveryRequest(request),
      receipt,
    };
    this.#mergeMutations.push(mutation);
    this.#mergeMutationsByEffectKey.set(request.effectKey, mutation);
    this.#mergedReceipts.set(receipt.number, receipt);
    return cloneDeliveryReceipt(receipt);
  }

  async observeStaging(
    value: ObserveStagingRequest,
  ): Promise<StagingObservation> {
    const request = assertObserveStagingRequest(value);
    this.#assertRepository(request.repository);
    if (
      request.workflow !== this.#stagingWorkflow ||
      request.environment !== this.#stagingEnvironment
    ) {
      deliveryFailure(
        "staging_target_mismatch",
        "The staging observation target does not match configuration",
      );
    }
    const workflowRun = this.#workflowRuns.get(request.mergeSha);
    const deployment = this.#deployment.current;
    let outcome: StagingObservation["outcome"] = "pending";
    if (
      workflowRun?.status === "completed" &&
      workflowRun.conclusion !== "success"
    ) {
      outcome = "failed";
    } else if (
      workflowRun?.status === "completed" &&
      workflowRun.conclusion === "success" &&
      deployment?.state === "failure"
    ) {
      outcome = "failed";
    } else if (
      workflowRun?.status === "completed" &&
      workflowRun.conclusion === "success" &&
      deployment !== undefined &&
      deployment.state === "success" &&
      deployment.deployedSha !== request.mergeSha
    ) {
      outcome = "sha_mismatch";
    } else if (
      workflowRun?.status === "completed" &&
      workflowRun.conclusion === "success" &&
      deployment?.state === "success" &&
      deployment.deployedSha === request.mergeSha
    ) {
      outcome = "deployed";
    }
    return assertStagingObservation({
      repository: request.repository,
      workflow: request.workflow,
      environment: request.environment,
      mergeSha: request.mergeSha,
      workflowRun,
      deployment,
      outcome,
    });
  }

  async moveProjectItemToDone(
    value: ConditionalProjectDoneMoveRequest,
  ): Promise<ProjectDoneMoveResult> {
    const request = assertConditionalProjectDoneMoveRequest(value);
    if (request.repository !== this.#repository) {
      return { outcome: "rejected", reason: { kind: "repository_mismatch" } };
    }
    const previous = this.#doneMutationsByEffectKey.get(request.effectKey);
    if (previous !== undefined) {
      if (!this.#sameDoneRequest(previous.request, request)) {
        return { outcome: "rejected", reason: { kind: "effect_key_conflict" } };
      }
      const current = this.#projectItems.get(request.itemId);
      if (
        current === undefined ||
        current.status !== previous.item.status ||
        current.revision !== previous.item.revision
      ) {
        return {
          outcome: "rejected",
          reason: {
            kind: "project_revision_mismatch",
            expectedRevision: previous.item.revision,
            actualRevision: current?.revision ?? "missing",
          },
        };
      }
      return { outcome: "already_applied", item: cloneItem(current) };
    }
    const item = this.#projectItems.get(request.itemId);
    if (item === undefined) {
      return { outcome: "rejected", reason: { kind: "project_not_found" } };
    }
    if (
      item.repository !== request.repository ||
      item.projectId !== request.projectId ||
      item.projectNumber !== request.projectNumber ||
      item.issueNodeId !== request.issueNodeId ||
      item.issueNumber !== request.issueNumber
    ) {
      return {
        outcome: "rejected",
        reason: { kind: "project_mapping_mismatch" },
      };
    }
    if (!this.#mergedReceiptsBySha(request.mergeSha)) {
      return { outcome: "rejected", reason: { kind: "merge_not_observed" } };
    }
    if (item.revision !== request.expectedRevision) {
      return {
        outcome: "rejected",
        reason: {
          kind: "project_revision_mismatch",
          expectedRevision: request.expectedRevision,
          actualRevision: item.revision,
        },
      };
    }
    if (item.status !== request.fromStatus) {
      return {
        outcome: "rejected",
        reason: {
          kind: "project_status_mismatch",
          expectedStatus: request.fromStatus,
          actualStatus: item.status,
        },
      };
    }
    item.status = request.toStatus;
    item.revision = this.#nextRevision(request.itemId, item.revision);
    const observed = cloneItem(item);
    const mutation: DoneMutation = {
      effectKey: request.effectKey,
      request: { ...request },
      item: observed,
    };
    this.#doneMutations.push(mutation);
    this.#doneMutationsByEffectKey.set(request.effectKey, mutation);
    return { outcome: "moved", item: cloneItem(item) };
  }

  setRequiredCheck(
    number: number,
    headSha: string,
    name: string,
    state: RequiredCheckState,
  ): void {
    const checkName = assertCheckName(name);
    const checkState = assertRequiredCheckState(state);
    const pullRequest = this.#pullRequests.get(number);
    const states = this.#checkStates.get(number);
    if (pullRequest === undefined || states === undefined) {
      throw new Error("Required check state is missing");
    }
    if (!this.#requiredCheckNames.includes(checkName)) {
      throw new Error("Unknown required check");
    }
    if (pullRequest.headSha !== headSha) {
      deliveryFailure(
        "head_drift",
        "Required check mutation targets a stale PR head",
      );
    }
    states.headSha = headSha;
    states.states.set(checkName, checkState);
  }

  setPullRequestHead(number: number, headSha: string): void {
    if (!/^[0-9a-f]{40}$/u.test(headSha))
      throw new Error("Pull request head must be a SHA-1");
    const pullRequest = this.#pullRequests.get(number);
    if (pullRequest === undefined) throw new Error("Unknown pull request");
    pullRequest.headSha = headSha;
    this.#checkStates.get(number)?.states.clear();
    const states = this.#checkStates.get(number);
    if (states !== undefined) states.headSha = headSha;
  }

  setThreads(number: number, threads: readonly MergeThreadReceipt[]): void {
    if (threads.some((thread) => thread.id.trim().length === 0)) {
      throw new Error("Thread IDs must not be blank");
    }
    this.#requirePullRequest(number);
    this.#threads.set(
      number,
      threads.map((thread) => ({ ...thread })),
    );
  }

  setPullRequestDraft(number: number, isDraft: boolean): void {
    const pullRequest = this.#requirePullRequest(number);
    pullRequest.isDraft = isDraft;
  }

  setMergeFailure(
    failure: "merge_prevented" | "merge_ambiguous" | undefined,
  ): void {
    this.#mergeFailure = failure;
  }

  setMergeability(
    number: number,
    mergeability: MergeCandidateReceipt["mergeability"],
  ): void {
    this.#requirePullRequest(number);
    this.#mergeability.set(number, mergeability);
  }

  setPermittedMergeMethods(
    number: number,
    methods: readonly MergeMethod[],
  ): void {
    this.#requirePullRequest(number);
    this.#permittedMethods.set(number, [...methods]);
  }

  setWorkflowRun(run: StagingWorkflowRunReceipt): void {
    if (run.workflow !== this.#stagingWorkflow)
      throw new Error("Workflow is not configured");
    this.#workflowRuns.set(run.headSha, { ...run });
  }

  setDeployment(deployment: StagingDeploymentReceipt): void {
    this.#deployment.current = { ...deployment };
  }

  setMergedReceipt(receipt: MergeReceipt): void {
    const validated = assertMergeReceipt(receipt);
    this.#assertRepository(validated.repository);
    this.#mergedReceipts.set(validated.number, validated);
  }

  seedProjectItem(item: ProjectItem): void {
    if (item.repository !== this.#repository)
      throw new Error("Project repository mismatch");
    this.#projectItems.set(item.projectItemId, {
      projectItemId: item.projectItemId,
      projectId: item.projectId,
      projectNumber: item.projectNumber,
      repository: item.repository,
      issueNodeId: item.issueNodeId,
      issueNumber: item.issueNumber,
      isOpen: item.isOpen,
      status: item.status,
      revision: item.revision,
      labels: [...item.labels],
      createdAt: item.createdAt,
      ...(item.priorityRank === undefined
        ? {}
        : { priorityRank: item.priorityRank }),
      dependencies: cloneDependencies(item.dependencies),
    });
    this.#revisionCounters.set(item.projectItemId, 1);
  }

  simulateProjectDrift(itemId: string): void {
    const item = this.#projectItems.get(itemId);
    if (item === undefined) throw new Error("Unknown project item");
    item.revision = this.#nextRevision(itemId, item.revision);
  }

  mergeMutations(): readonly DeliveryMutation[] {
    return Object.freeze(
      this.#mergeMutations.map((mutation) =>
        Object.freeze({
          effectKey: mutation.effectKey,
          request: cloneDeliveryRequest(mutation.request),
          receipt: cloneDeliveryReceipt(mutation.receipt),
        }),
      ),
    );
  }

  doneMutations(): readonly DoneMutation[] {
    return Object.freeze(
      this.#doneMutations.map((mutation) =>
        Object.freeze({
          effectKey: mutation.effectKey,
          request: { ...mutation.request },
          item: cloneItem(mutation.item),
        }),
      ),
    );
  }

  #readCandidate(request: MergeCandidateRequest): MergeCandidateReceipt {
    const pullRequest = this.#pullRequests.get(request.number);
    if (pullRequest === undefined) {
      deliveryFailure(
        "pull_request_not_found",
        "The requested pull request was not found",
      );
    }
    if (pullRequest.repository !== request.repository) {
      deliveryFailure(
        "repository_mismatch",
        "The pull request belongs to another repository",
      );
    }
    if (pullRequest.isDraft) {
      deliveryFailure(
        "pull_request_is_draft",
        "The pull request is still a draft",
      );
    }
    if (
      pullRequest.nodeId !== request.nodeId ||
      pullRequest.issueNumber !== request.issueNumber ||
      pullRequest.title !== request.expectedTitle ||
      pullRequest.headBranch !== request.expectedHeadBranch
    ) {
      deliveryFailure(
        "pull_request_mismatch",
        "The merge candidate identity changed",
      );
    }
    const checkState = this.#checkStates.get(request.number);
    if (checkState === undefined) {
      deliveryFailure(
        "required_checks_not_green",
        "Required check state is unavailable",
      );
    }
    const headDrift =
      pullRequest.headSha !== request.expectedHeadSha ||
      pullRequest.baseSha !== request.expectedBaseSha ||
      pullRequest.baseBranch !== request.expectedBaseBranch;
    const requiredChecks = assertRequiredChecksReceipt({
      repository: pullRequest.repository,
      number: pullRequest.number,
      nodeId: pullRequest.nodeId,
      headSha: pullRequest.headSha,
      requiredCheckNames: [...this.#requiredCheckNames],
      requiredChecks: this.#requiredCheckNames.map((name) => ({
        name,
        state:
          headDrift || checkState.headSha !== pullRequest.headSha
            ? "pending"
            : (checkState.states.get(name) ?? "pending"),
      })),
      headDrift,
      aggregate: headDrift
        ? "head_drift"
        : this.#requiredCheckNames.every(
              (name) => checkState.states.get(name) === "success",
            )
          ? "green"
          : this.#requiredCheckNames.some(
                (name) => checkState.states.get(name) === "failure",
              )
            ? "failed"
            : "pending",
    });
    const candidate = assertMergeCandidateReceipt({
      repository: pullRequest.repository,
      number: pullRequest.number,
      issueNumber: pullRequest.issueNumber,
      nodeId: pullRequest.nodeId,
      isDraft: false,
      title: pullRequest.title,
      baseBranch: pullRequest.baseBranch,
      baseSha: pullRequest.baseSha,
      headBranch: pullRequest.headBranch,
      headSha: pullRequest.headSha,
      requiredChecks,
      threads: cloneThreads(this.#threads.get(request.number) ?? []),
      mergeability: this.#mergeability.get(request.number) ?? "unknown",
      permittedMergeMethods: [
        ...(this.#permittedMethods.get(request.number) ?? []),
      ],
    });
    return {
      ...candidate,
      threads: cloneThreads(candidate.threads),
      permittedMergeMethods: Object.freeze([
        ...candidate.permittedMergeMethods,
      ]),
    };
  }

  #assertMergeRequestMatchesCandidate(
    request: MergeRequest,
    candidate: MergeCandidateReceipt,
  ): void {
    if (candidate.headSha !== request.expectedHeadSha) {
      deliveryFailure(
        "head_drift",
        "The pull request head changed after approval",
      );
    }
    if (
      candidate.baseSha !== request.expectedBaseSha ||
      candidate.baseBranch !== request.expectedBaseBranch
    ) {
      deliveryFailure(
        "base_drift",
        "The pull request base changed after approval",
      );
    }
    if (
      candidate.repository !== request.repository ||
      candidate.number !== request.number ||
      candidate.issueNumber !== request.issueNumber ||
      candidate.nodeId !== request.nodeId ||
      candidate.title !== request.expectedTitle ||
      candidate.headBranch !== request.expectedHeadBranch
    ) {
      deliveryFailure(
        "pull_request_mismatch",
        "The merge candidate identity changed",
      );
    }
  }

  #requirePullRequest(number: number): MutableDeliveryPullRequest {
    const pullRequest = this.#pullRequests.get(number);
    if (pullRequest === undefined) throw new Error("Unknown pull request");
    return pullRequest;
  }

  #assertRepository(repository: string): void {
    if (repository !== this.#repository) {
      deliveryFailure(
        "repository_mismatch",
        "The delivery request targets another repository",
      );
    }
  }

  #mergedReceiptsBySha(mergeSha: string): MergeReceipt | undefined {
    return [...this.#mergedReceipts.values()].find(
      (receipt) => receipt.mergeSha === mergeSha,
    );
  }

  #sameDoneRequest(
    left: ConditionalProjectDoneMoveRequest,
    right: ConditionalProjectDoneMoveRequest,
  ): boolean {
    return (
      left.repository === right.repository &&
      left.projectId === right.projectId &&
      left.projectNumber === right.projectNumber &&
      left.itemId === right.itemId &&
      left.issueNodeId === right.issueNodeId &&
      left.issueNumber === right.issueNumber &&
      left.expectedRevision === right.expectedRevision &&
      left.fromStatus === right.fromStatus &&
      left.toStatus === right.toStatus &&
      left.effectKey === right.effectKey &&
      left.mergeSha === right.mergeSha
    );
  }

  #nextRevision(itemId: string, currentRevision: string): string {
    const next = (this.#revisionCounters.get(itemId) ?? 1) + 1;
    this.#revisionCounters.set(itemId, next);
    const result = String(next);
    return result === currentRevision ? String(next + 1) : result;
  }

  #nextSha(previous: string): string {
    const first = previous[0] ?? "c";
    const next = String.fromCharCode(
      Math.min("f".charCodeAt(0), first.charCodeAt(0) + 1),
    );
    return next.repeat(40);
  }
}
