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
  type GitHubDeliveryFailureKind,
  type GitHubDeliveryGateway,
  type MergeCandidateReceipt,
  type MergeCandidateRequest,
  type MergeReceipt,
  type MergeRequest,
  type ObserveStagingRequest,
  type ProjectDoneMoveResult,
  type StagingObservation,
} from "./delivery.js";
import type {
  ConditionalProjectStatusMove,
  GitHubProjectGateway,
  ProjectStatusMoveResult,
} from "./project.js";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const REST_ENDPOINT = "https://api.github.com";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

const CANDIDATE_QUERY = `
  query WheelsparrowMergeCandidate($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      squashMergeAllowed rebaseMergeAllowed mergeCommitAllowed
      pullRequest(number: $number) {
        id number title isDraft baseRefName baseRefOid headRefName headRefOid mergeable
        closingIssuesReferences(first: 20) { nodes { number } }
        reviewThreads(first: 100) { nodes { id isResolved } pageInfo { hasNextPage } }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          __typename ... on CheckRun { name status conclusion }
          ... on StatusContext { context state }
        } pageInfo { hasNextPage } } } } } }
      }
    }
  }
`;

type ClientFailureKind =
  | "credentials_unavailable"
  | "provider_unavailable"
  | "invalid_response"
  | GitHubDeliveryFailureKind
  | "merge_ambiguous";

export class GitHubDeliveryClientError extends Error {
  readonly kind: ClientFailureKind;

  constructor(kind: ClientFailureKind, message: string) {
    super(message);
    this.name = "GitHubDeliveryClientError";
    this.kind = kind;
  }
}

export interface GitHubDeliveryClientOptions {
  readonly owner: string;
  readonly repository: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoint?: string;
  readonly restEndpoint?: string;
  readonly timeoutMs?: number;
  /** Reuse the established Project gateway for conditional Done mutations. */
  readonly projectGateway?: GitHubProjectGateway;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function records(
  value: unknown,
): readonly Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(record);
  return parsed.some((item) => item === undefined)
    ? undefined
    : (parsed as readonly Record<string, unknown>[]);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function sha(value: unknown): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function checkState(
  value: Record<string, unknown>,
): "pending" | "success" | "failure" {
  if (value.__typename === "CheckRun") {
    if (value.status !== "COMPLETED") return "pending";
    return value.conclusion === "SUCCESS" ? "success" : "failure";
  }
  if (value.__typename === "StatusContext") {
    if (value.state === "SUCCESS") return "success";
    if (value.state === "PENDING" || value.state === "EXPECTED")
      return "pending";
    return "failure";
  }
  throw new GitHubDeliveryClientError(
    "invalid_response",
    "GitHub delivery response is invalid.",
  );
}

function deliveryFailure(
  kind: GitHubDeliveryFailureKind,
  message: string,
): never {
  throw new GitHubDeliveryBoundaryError(kind, message);
}

function sameMergeRequest(left: MergeRequest, right: MergeRequest): boolean {
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

function sameDoneRequest(
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

function checkedEndpoint(value: string, graphql: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GitHubDeliveryClientError(
      "invalid_input",
      "GitHub delivery endpoint configuration is invalid.",
    );
  }
  // Production traffic is pinned to GitHub. The .test host is retained only
  // for the deterministic HTTP contract tests in this package.
  if (
    parsed.protocol !== "https:" ||
    (parsed.hostname !== "api.github.com" &&
      parsed.hostname !== "api.github.test") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new GitHubDeliveryClientError(
      "invalid_input",
      "GitHub delivery endpoint configuration is invalid.",
    );
  }
  const expectedPath = graphql ? "/graphql" : "";
  if (graphql && parsed.pathname !== expectedPath) {
    throw new GitHubDeliveryClientError(
      "invalid_input",
      "GitHub delivery endpoint configuration is invalid.",
    );
  }
  if (!graphql && parsed.pathname.endsWith("/graphql")) {
    throw new GitHubDeliveryClientError(
      "invalid_input",
      "GitHub delivery endpoint configuration is invalid.",
    );
  }
  return parsed.toString().replace(/\/$/u, "");
}

function projectMove(result: ProjectStatusMoveResult): ProjectDoneMoveResult {
  if (result.outcome === "moved") return result;
  if (result.outcome === "already_applied") return result;
  const reason = result.reason;
  switch (reason.kind) {
    case "wrong_project":
      return {
        outcome: "rejected",
        reason: { kind: "project_mapping_mismatch" },
      };
    case "unknown_item":
      return { outcome: "rejected", reason: { kind: "project_not_found" } };
    case "revision_mismatch":
    case "already_applied_drift":
      return {
        outcome: "rejected",
        reason: {
          kind: "project_revision_mismatch",
          expectedRevision: reason.expectedRevision,
          actualRevision: reason.actualRevision,
        },
      };
    case "status_mismatch":
      return {
        outcome: "rejected",
        reason: {
          kind: "project_status_mismatch",
          expectedStatus: reason.expectedStatus,
          actualStatus: reason.actualStatus,
        },
      };
    case "issue_mapping_mismatch":
      return {
        outcome: "rejected",
        reason: { kind: "project_mapping_mismatch" },
      };
    case "effect_key_conflict":
      return { outcome: "rejected", reason: { kind: "effect_key_conflict" } };
    case "invalid_request":
      return {
        outcome: "rejected",
        reason: { kind: "invalid_request", field: reason.field },
      };
  }
}

export class GitHubDeliveryClient implements GitHubDeliveryGateway {
  readonly #owner: string;
  readonly #repository: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #endpoint: string;
  readonly #restEndpoint: string;
  readonly #timeoutMs: number;
  readonly #projectGateway: GitHubProjectGateway | undefined;
  readonly #mergeReceipts = new Map<
    string,
    { request: MergeRequest; receipt: MergeReceipt }
  >();
  readonly #doneReceipts = new Map<
    string,
    {
      request: ConditionalProjectDoneMoveRequest;
      result: ProjectDoneMoveResult;
    }
  >();

  constructor(options: GitHubDeliveryClientOptions) {
    if (
      typeof options.owner !== "string" ||
      options.owner.trim().length === 0 ||
      typeof options.repository !== "string" ||
      options.repository.trim().length === 0
    ) {
      throw new GitHubDeliveryClientError(
        "invalid_input",
        "GitHub delivery repository configuration is invalid.",
      );
    }
    const repositoryParts = options.repository.split("/");
    if (repositoryParts.length === 2 && repositoryParts[0] !== options.owner) {
      throw new GitHubDeliveryClientError(
        "invalid_input",
        "GitHub delivery repository configuration is invalid.",
      );
    }
    this.#owner = options.owner;
    this.#repository =
      repositoryParts.length === 2
        ? (repositoryParts[1] as string)
        : options.repository;
    if (!REPOSITORY_PATTERN.test(`${this.#owner}/${this.#repository}`)) {
      throw new GitHubDeliveryClientError(
        "invalid_input",
        "GitHub delivery repository configuration is invalid.",
      );
    }
    this.#token = options.token?.trim();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#endpoint = checkedEndpoint(
      options.endpoint ?? GRAPHQL_ENDPOINT,
      true,
    );
    this.#restEndpoint = checkedEndpoint(
      options.restEndpoint ?? REST_ENDPOINT,
      false,
    );
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#projectGateway = options.projectGateway;
  }

  async readMergeCandidate(
    request: MergeCandidateRequest,
  ): Promise<MergeCandidateReceipt> {
    const expected = assertMergeCandidateRequest(request);
    this.#scope(expected.repository);
    return (await this.#readCandidate(expected)).candidate;
  }

  async mergePullRequest(request: MergeRequest): Promise<MergeReceipt> {
    const expected = assertMergeRequest(request);
    this.#scope(expected.repository);
    const previous = this.#mergeReceipts.get(expected.effectKey);
    if (previous !== undefined) {
      if (!sameMergeRequest(previous.request, expected))
        deliveryFailure(
          "effect_key_conflict",
          "Merge effect key was reused with different request facts",
        );
      return { ...previous.receipt };
    }
    const observed = await this.#readCandidate(expected);
    const candidate = observed.candidate;
    if (
      candidate.repository !== expected.repository ||
      candidate.number !== expected.number ||
      candidate.issueNumber !== expected.issueNumber ||
      candidate.nodeId !== expected.nodeId ||
      candidate.title !== expected.expectedTitle ||
      candidate.headBranch !== expected.expectedHeadBranch
    )
      deliveryFailure(
        "pull_request_mismatch",
        "The merge candidate identity changed",
      );
    if (candidate.headSha !== expected.expectedHeadSha)
      deliveryFailure(
        "head_drift",
        "The pull request head changed after approval",
      );
    if (
      candidate.baseBranch !== expected.expectedBaseBranch ||
      candidate.baseSha !== expected.expectedBaseSha
    )
      deliveryFailure(
        "base_drift",
        "The pull request base changed after approval",
      );
    if (candidate.requiredChecks.aggregate !== "green")
      deliveryFailure(
        "required_checks_not_green",
        "The merge candidate does not have green required checks",
      );
    if (candidate.threads.some((thread) => !thread.resolved))
      deliveryFailure(
        "unresolved_threads",
        "The merge candidate has unresolved review threads",
      );
    if (candidate.mergeability === "conflicting")
      deliveryFailure("merge_conflict", "The merge candidate is not mergeable");
    if (candidate.mergeability === "unknown")
      deliveryFailure(
        "mergeability_unknown",
        "The merge candidate mergeability is unknown",
      );
    if (!candidate.permittedMergeMethods.includes(expected.method))
      deliveryFailure(
        "merge_method_not_permitted",
        "The requested merge method is not permitted",
      );
    if (observed.mergedSha !== undefined) {
      const receipt = assertMergeReceipt({
        repository: candidate.repository,
        number: candidate.number,
        issueNumber: candidate.issueNumber,
        nodeId: candidate.nodeId,
        method: expected.method,
        baseBranch: candidate.baseBranch,
        baseSha: candidate.baseSha,
        headBranch: candidate.headBranch,
        headSha: candidate.headSha,
        mergeSha: observed.mergedSha,
      });
      this.#mergeReceipts.set(expected.effectKey, {
        request: expected,
        receipt,
      });
      return { ...receipt };
    }
    let response: Response;
    try {
      response = await this.#rest(
        `/repos/${this.#owner}/${this.#repository}/pulls/${expected.number}/merge`,
        "PUT",
        { merge_method: expected.method, sha: candidate.headSha },
      );
    } catch {
      throw new GitHubDeliveryClientError(
        "merge_ambiguous",
        "GitHub merge outcome is ambiguous.",
      );
    }
    if (!response.ok) {
      // The mutation was explicitly rejected by GitHub. A transport failure
      // above is the only path that remains ambiguous.
      throw new GitHubDeliveryClientError(
        "merge_prevented",
        "GitHub prevented the merge.",
      );
    }
    const value = record(await this.#json(response, "merge_ambiguous"));
    if (value?.merged === false)
      throw new GitHubDeliveryClientError(
        "merge_prevented",
        "GitHub prevented the merge.",
      );
    if (value?.merged !== true || !sha(value.sha))
      throw new GitHubDeliveryClientError(
        "merge_ambiguous",
        "GitHub merge outcome is ambiguous.",
      );
    const receipt = assertMergeReceipt({
      repository: candidate.repository,
      number: candidate.number,
      issueNumber: candidate.issueNumber,
      nodeId: candidate.nodeId,
      method: expected.method,
      baseBranch: candidate.baseBranch,
      baseSha: candidate.baseSha,
      headBranch: candidate.headBranch,
      headSha: candidate.headSha,
      mergeSha: value.sha,
    });
    this.#mergeReceipts.set(expected.effectKey, { request: expected, receipt });
    return { ...receipt };
  }

  async #readCandidate(
    request: MergeCandidateRequest,
  ): Promise<{ candidate: MergeCandidateReceipt; mergedSha?: string }> {
    const data = await this.#graphql(CANDIDATE_QUERY, {
      owner: this.#owner,
      name: this.#repository,
      number: request.number,
    });
    const root = record(data)?.repository;
    const repository = record(root);
    const pr = record(repository?.pullRequest);
    if (repository === undefined || pr === undefined)
      deliveryFailure(
        "pull_request_not_found",
        "The requested pull request was not found",
      );
    const threadsContainer = record(pr.reviewThreads);
    const threads = records(threadsContainer?.nodes);
    const threadPage = record(threadsContainer?.pageInfo);
    const issues = records(record(pr.closingIssuesReferences)?.nodes);
    const commits = records(record(pr.commits)?.nodes);
    const commit = record(commits?.[0]?.commit);
    const rollup = record(commit?.statusCheckRollup);
    const contexts = record(rollup?.contexts);
    const checks = records(contexts?.nodes);
    if (
      threads === undefined ||
      threadPage?.hasNextPage !== false ||
      issues === undefined ||
      issues.some(
        (item) =>
          !Number.isSafeInteger(item.number) || (item.number as number) < 1,
      ) ||
      commits === undefined ||
      commits.length !== 1 ||
      commit === undefined ||
      rollup === undefined ||
      contexts === undefined ||
      contexts.pageInfo === undefined ||
      record(contexts.pageInfo)?.hasNextPage !== false ||
      checks === undefined ||
      checks.length === 0
    )
      this.#invalid();
    if (pr.isDraft === true)
      deliveryFailure(
        "pull_request_is_draft",
        "The pull request is still a draft",
      );
    if (
      pr.id !== request.nodeId ||
      pr.number !== request.number ||
      !issues.some((item) => item.number === request.issueNumber) ||
      pr.title !== request.expectedTitle ||
      pr.headRefName !== request.expectedHeadBranch
    )
      deliveryFailure(
        "pull_request_mismatch",
        "The merge candidate identity changed",
      );
    if (
      typeof repository.squashMergeAllowed !== "boolean" ||
      typeof repository.rebaseMergeAllowed !== "boolean" ||
      typeof repository.mergeCommitAllowed !== "boolean"
    )
      this.#invalid();
    const parsedChecks = checks.map((check) => {
      const name = text(check.name) ?? text(check.context);
      if (name === undefined) this.#invalid();
      return { name, state: checkState(check) } as const;
    });
    const observedHead = pr.headRefOid;
    const observedBase = pr.baseRefOid;
    const headDrift =
      observedHead !== request.expectedHeadSha ||
      observedBase !== request.expectedBaseSha ||
      pr.baseRefName !== request.expectedBaseBranch;
    const requiredChecks = {
      repository: request.repository,
      number: request.number,
      nodeId: request.nodeId,
      headSha: observedHead,
      requiredCheckNames: parsedChecks.map((check) => check.name),
      requiredChecks: parsedChecks.map((check) => ({
        name: check.name,
        state: headDrift ? ("pending" as const) : check.state,
      })),
      headDrift,
      aggregate: headDrift
        ? ("head_drift" as const)
        : parsedChecks.some((check) => check.state === "failure")
          ? ("failed" as const)
          : parsedChecks.every((check) => check.state === "success")
            ? ("green" as const)
            : ("pending" as const),
    };
    const candidateValue = {
      repository: request.repository,
      number: pr.number,
      issueNumber: request.issueNumber,
      nodeId: pr.id,
      isDraft: pr.isDraft,
      title: pr.title,
      baseBranch: pr.baseRefName,
      baseSha: pr.baseRefOid,
      headBranch: pr.headRefName,
      headSha: pr.headRefOid,
      requiredChecks,
      threads: threads.map((thread) => ({
        id: thread.id,
        resolved: thread.isResolved,
      })),
      mergeability:
        pr.mergeable === "MERGEABLE"
          ? "mergeable"
          : pr.mergeable === "CONFLICTING"
            ? "conflicting"
            : pr.mergeable === "UNKNOWN"
              ? "unknown"
              : undefined,
      permittedMergeMethods: [
        ...(repository.squashMergeAllowed ? (["squash"] as const) : []),
        ...(repository.rebaseMergeAllowed ? (["rebase"] as const) : []),
        ...(repository.mergeCommitAllowed ? (["merge"] as const) : []),
      ],
    };
    let candidate: MergeCandidateReceipt;
    try {
      candidate = assertMergeCandidateReceipt(candidateValue);
    } catch {
      this.#invalid();
    }
    const mergeCommitSha =
      pr.merged === true ? record(pr.mergeCommit)?.oid : undefined;
    if (pr.merged !== undefined && typeof pr.merged !== "boolean")
      this.#invalid();
    if (pr.merged === true && !sha(mergeCommitSha)) this.#invalid();
    return {
      candidate,
      ...(sha(mergeCommitSha) ? { mergedSha: mergeCommitSha } : {}),
    };
  }

  async observeStaging(
    request: ObserveStagingRequest,
  ): Promise<StagingObservation> {
    const expected = assertObserveStagingRequest(request);
    this.#scope(expected.repository);
    const workflow = await this.#restJson(
      `/repos/${this.#owner}/${this.#repository}/actions/workflows/${encodeURIComponent(expected.workflow)}/runs?head_sha=${expected.mergeSha}`,
    );
    const workflowRuns = records(record(workflow)?.workflow_runs);
    if (workflowRuns === undefined) this.#invalid();
    const workflowRun = workflowRuns.find((run) => {
      const path = text(run.path) ?? text(run.name);
      return (
        path !== undefined &&
        (path === expected.workflow || path.endsWith(`/${expected.workflow}`))
      );
    });
    const workflowReceipt =
      workflowRun === undefined
        ? undefined
        : this.#workflowRun(workflowRun, expected);
    if (workflowRun === undefined)
      return assertStagingObservation({
        ...expected,
        workflowRun: undefined,
        deployment: undefined,
        outcome: "pending",
      });
    if (workflowReceipt === undefined) this.#invalid();
    const deployments = await this.#restJson(
      `/repos/${this.#owner}/${this.#repository}/deployments?environment=${encodeURIComponent(expected.environment)}&per_page=100`,
    );
    const deploymentList = records(deployments);
    if (deploymentList === undefined) this.#invalid();
    const deployment = deploymentList.find(
      (item) => item.environment === expected.environment,
    );
    if (deployment === undefined)
      return assertStagingObservation({
        ...expected,
        workflowRun: workflowReceipt,
        deployment: undefined,
        outcome:
          workflowReceipt.headSha !== expected.mergeSha
            ? "sha_mismatch"
            : workflowReceipt.status === "completed" &&
                workflowReceipt.conclusion !== "success"
              ? "failed"
              : "pending",
      });
    if (!sha(deployment.sha)) this.#invalid();
    const statuses = await this.#restJson(
      `/repos/${this.#owner}/${this.#repository}/deployments/${deployment.id}/statuses?per_page=100`,
    );
    const statusList = records(statuses);
    if (statusList === undefined) this.#invalid();
    const status = [...statusList].sort((left, right) => {
      const leftTime = text(left.created_at);
      const rightTime = text(right.created_at);
      if (leftTime === undefined || rightTime === undefined) return 0;
      return rightTime.localeCompare(leftTime);
    })[0];
    const state = status?.state ?? deployment.state;
    if (state !== undefined && typeof state !== "string") this.#invalid();
    const deploymentReceipt = {
      id: String(deployment.id),
      environment: expected.environment,
      deployedSha: deployment.sha,
      state: state ?? "pending",
    };
    const outcome =
      workflowReceipt.headSha !== expected.mergeSha ||
      deploymentReceipt.deployedSha !== expected.mergeSha
        ? "sha_mismatch"
        : workflowReceipt.conclusion === "success" &&
            deploymentReceipt.state === "success"
          ? "deployed"
          : workflowReceipt.status !== "completed" ||
              workflowReceipt.conclusion === "none" ||
              deploymentReceipt.state === "pending"
            ? "pending"
            : "failed";
    return assertStagingObservation({
      ...expected,
      workflowRun: workflowReceipt,
      deployment: deploymentReceipt,
      outcome,
    });
  }

  async moveProjectItemToDone(
    request: ConditionalProjectDoneMoveRequest,
  ): Promise<ProjectDoneMoveResult> {
    const expected = assertConditionalProjectDoneMoveRequest(request);
    this.#scope(expected.repository);
    const previous = this.#doneReceipts.get(expected.effectKey);
    if (previous !== undefined) {
      if (!sameDoneRequest(previous.request, expected))
        return { outcome: "rejected", reason: { kind: "effect_key_conflict" } };
      if (previous.result.outcome === "rejected") return previous.result;
      return { outcome: "already_applied", item: previous.result.item };
    }
    const merged = [...this.#mergeReceipts.values()].find(
      (entry) =>
        entry.receipt.repository === expected.repository &&
        entry.receipt.issueNumber === expected.issueNumber &&
        entry.receipt.mergeSha === expected.mergeSha,
    );
    if (merged === undefined)
      return { outcome: "rejected", reason: { kind: "merge_not_observed" } };
    const gateway = this.#projectGateway;
    if (gateway === undefined)
      return { outcome: "rejected", reason: { kind: "project_not_found" } };
    const move: ConditionalProjectStatusMove = {
      projectId: expected.projectId,
      projectNumber: expected.projectNumber,
      itemId: expected.itemId,
      issueNodeId: expected.issueNodeId,
      issueNumber: expected.issueNumber,
      expectedRevision: expected.expectedRevision,
      fromStatus: expected.fromStatus,
      toStatus: expected.toStatus,
      effectKey: expected.effectKey,
    };
    const result = projectMove(await gateway.moveProjectItem(move));
    if (result.outcome === "moved" || result.outcome === "already_applied") {
      this.#doneReceipts.set(expected.effectKey, { request: expected, result });
    }
    return result;
  }

  #workflowRun(value: Record<string, unknown>, request: ObserveStagingRequest) {
    const headSha = value.head_sha;
    if (!sha(headSha)) this.#invalid();
    const status = value.status;
    if (
      status !== "queued" &&
      status !== "in_progress" &&
      status !== "completed"
    )
      this.#invalid();
    const rawConclusion = value.conclusion;
    let conclusion:
      | "none"
      | "success"
      | "failure"
      | "cancelled"
      | "timed_out"
      | "neutral"
      | "skipped"
      | "unknown";
    if (rawConclusion === null || rawConclusion === undefined)
      conclusion = "none";
    else if (rawConclusion === "success") conclusion = "success";
    else if (rawConclusion === "failure") conclusion = "failure";
    else if (rawConclusion === "cancelled") conclusion = "cancelled";
    else if (rawConclusion === "timed_out") conclusion = "timed_out";
    else if (rawConclusion === "neutral") conclusion = "neutral";
    else if (rawConclusion === "skipped") conclusion = "skipped";
    else conclusion = "unknown";
    if (status === "completed" && conclusion === "none") this.#invalid();
    return {
      id: String(value.id),
      workflow: request.workflow,
      headSha,
      status,
      conclusion,
    };
  }

  #scope(repository: string): void {
    if (repository !== `${this.#owner}/${this.#repository}`)
      deliveryFailure(
        "repository_mismatch",
        "GitHub delivery request is outside configured scope.",
      );
  }

  #invalid(): never {
    throw new GitHubDeliveryClientError(
      "invalid_response",
      "GitHub delivery response is invalid.",
    );
  }

  async #graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.#rest(
      this.#endpoint,
      "POST",
      { query, variables },
      true,
    );
    if (!response.ok)
      throw new GitHubDeliveryClientError(
        "provider_unavailable",
        "GitHub delivery provider is unavailable.",
      );
    const payload = record(await this.#json(response, "invalid_response"));
    if (
      payload === undefined ||
      payload.errors !== undefined ||
      payload.data === undefined
    )
      this.#invalid();
    return payload.data;
  }

  async #restJson(path: string): Promise<unknown> {
    const response = await this.#rest(path, "GET");
    if (!response.ok)
      throw new GitHubDeliveryClientError(
        "provider_unavailable",
        "GitHub delivery provider is unavailable.",
      );
    return this.#json(response, "invalid_response");
  }

  async #rest(
    path: string,
    method: string,
    body?: unknown,
    absolute = false,
  ): Promise<Response> {
    const token = this.#token;
    if (token === undefined || token.length === 0)
      throw new GitHubDeliveryClientError(
        "credentials_unavailable",
        "GitHub delivery credentials are unavailable.",
      );
    try {
      return await this.#fetch(
        absolute ? path : `${this.#restEndpoint}${path}`,
        {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "user-agent": "wheelsparrow",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch {
      throw new GitHubDeliveryClientError(
        "provider_unavailable",
        "GitHub delivery provider is unavailable.",
      );
    }
  }

  async #json(response: Response, kind: ClientFailureKind): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new GitHubDeliveryClientError(
        kind,
        "GitHub delivery response is invalid.",
      );
    }
  }
}
