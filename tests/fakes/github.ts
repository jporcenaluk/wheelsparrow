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
  assertRequiredCheckState,
  assertRequiredChecksReceipt,
  GitHubPublicationBoundaryError,
  type GitHubPublicationGateway,
  type ObserveRequiredChecksRequest,
  type PublishPullRequestRequest,
  type PullRequestReceipt,
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
        ? ("missing" as const)
        : checkState.headSha === pullRequest.headSha
          ? (checkState.states.get(name) ?? "missing")
          : "missing",
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
      requiredChecks,
      aggregate,
    };
    return assertRequiredChecksReceipt(receipt);
  }

  setRequiredCheck(name: string, state: RequiredCheckState): void {
    const checkName = assertCheckName(name);
    const checkState = assertRequiredCheckState(state);
    if (!this.#requiredCheckNames.includes(checkName)) {
      throw new Error(`Unknown required check: ${checkName}`);
    }
    if (this.#pullRequests.size === 0) {
      throw new Error("Cannot set a check before creating a pull request");
    }
    const latest = Math.max(...this.#pullRequests.keys());
    const states = this.#checkStates.get(latest);
    const pullRequest = this.#pullRequests.get(latest);
    if (states === undefined || pullRequest === undefined)
      throw new Error("Required check state is missing");
    if (states.headSha !== pullRequest.headSha) {
      states.headSha = pullRequest.headSha;
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
