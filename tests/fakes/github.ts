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
