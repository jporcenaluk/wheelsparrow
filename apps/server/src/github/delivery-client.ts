import {
  assertConditionalProjectDoneMoveRequest,
  assertMergeCandidateReceipt,
  assertMergeCandidateRequest,
  assertMergeReceipt,
  assertMergeRequest,
  assertObserveStagingRequest,
  assertStagingObservation,
  type ConditionalProjectDoneMoveRequest,
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

function checkState(value: Record<string, unknown>): string {
  if (value.__typename === "CheckRun") {
    if (value.status !== "COMPLETED") return "pending";
    return value.conclusion === "SUCCESS" ? "success" : "failure";
  }
  if (value.__typename === "StatusContext") {
    return value.state === "SUCCESS"
      ? "success"
      : value.state === "PENDING"
        ? "pending"
        : "failure";
  }
  return "failure";
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

  constructor(options: GitHubDeliveryClientOptions) {
    this.#owner = options.owner;
    this.#repository = options.repository;
    this.#token = options.token?.trim();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#endpoint = options.endpoint ?? GRAPHQL_ENDPOINT;
    this.#restEndpoint = options.restEndpoint ?? REST_ENDPOINT;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#projectGateway = options.projectGateway;
  }

  async readMergeCandidate(
    request: MergeCandidateRequest,
  ): Promise<MergeCandidateReceipt> {
    const expected = assertMergeCandidateRequest(request);
    this.#scope(expected.repository);
    const data = await this.#graphql(CANDIDATE_QUERY, {
      owner: this.#owner,
      name: this.#repository,
      number: expected.number,
    });
    const repository = record(data)?.repository;
    const pull = record(repository)?.pullRequest;
    const root = record(repository);
    const pr = record(pull);
    if (root === undefined || pr === undefined) this.#invalid();
    const threads = records(record(pr.reviewThreads)?.nodes);
    const checks = records(
      record(records(record(pr.commits)?.nodes)?.[0]?.commit)
        ?.statusCheckRollup &&
        record(
          record(records(record(pr.commits)?.nodes)?.[0]?.commit)
            ?.statusCheckRollup,
        )?.contexts
        ? record(
            record(
              record(records(record(pr.commits)?.nodes)?.[0]?.commit)
                ?.statusCheckRollup,
            )?.contexts,
          )?.nodes
        : undefined,
    );
    const issues = records(record(pr.closingIssuesReferences)?.nodes);
    if (
      threads === undefined ||
      checks === undefined ||
      issues === undefined ||
      record(pr.reviewThreads)?.pageInfo === undefined ||
      record(record(pr.reviewThreads)?.pageInfo)?.hasNextPage !== false ||
      record(
        record(
          record(records(record(pr.commits)?.nodes)?.[0]?.commit)
            ?.statusCheckRollup,
        )?.contexts,
      )?.pageInfo === undefined ||
      record(
        record(
          record(
            record(records(record(pr.commits)?.nodes)?.[0]?.commit)
              ?.statusCheckRollup,
          )?.contexts,
        )?.pageInfo,
      )?.hasNextPage !== false
    )
      this.#invalid();
    const candidate = {
      repository: expected.repository,
      number: pr.number,
      issueNumber: issues.some((item) => item.number === expected.issueNumber)
        ? expected.issueNumber
        : -1,
      nodeId: pr.id,
      isDraft: pr.isDraft,
      title: pr.title,
      baseBranch: pr.baseRefName,
      baseSha: pr.baseRefOid,
      headBranch: pr.headRefName,
      headSha: pr.headRefOid,
      requiredChecks: {
        repository: expected.repository,
        number: expected.number,
        nodeId: expected.nodeId,
        headSha: expected.expectedHeadSha,
        requiredCheckNames: checks.map(
          (check) => text(check.name) ?? text(check.context) ?? "",
        ),
        requiredChecks: checks.map((check) => ({
          name: text(check.name) ?? text(check.context) ?? "",
          state: checkState(check),
        })),
        headDrift: pr.headRefOid !== expected.expectedHeadSha,
        aggregate: checks.every((check) => checkState(check) === "success")
          ? "green"
          : "not_green",
      },
      threads: threads.map((thread) => ({
        id: thread.id,
        resolved: thread.isResolved,
      })),
      mergeability:
        pr.mergeable === "MERGEABLE"
          ? "mergeable"
          : pr.mergeable === "CONFLICTING"
            ? "conflicting"
            : "unknown",
      permittedMergeMethods: [
        ...(root.squashMergeAllowed === true ? ["squash"] : []),
        ...(root.rebaseMergeAllowed === true ? ["rebase"] : []),
        ...(root.mergeCommitAllowed === true ? ["merge"] : []),
      ],
    };
    try {
      return assertMergeCandidateReceipt(candidate);
    } catch {
      this.#invalid();
    }
  }

  async mergePullRequest(request: MergeRequest): Promise<MergeReceipt> {
    const expected = assertMergeRequest(request);
    await this.readMergeCandidate({
      repository: expected.repository,
      number: expected.number,
      issueNumber: expected.issueNumber,
      nodeId: expected.nodeId,
      expectedTitle: expected.expectedTitle,
      expectedBaseBranch: expected.expectedBaseBranch,
      expectedBaseSha: expected.expectedBaseSha,
      expectedHeadBranch: expected.expectedHeadBranch,
      expectedHeadSha: expected.expectedHeadSha,
    });
    let response: Response;
    try {
      response = await this.#rest(
        `/repos/${this.#owner}/${this.#repository}/pulls/${expected.number}/merge`,
        "PUT",
        { merge_method: expected.method, sha: expected.expectedHeadSha },
      );
    } catch {
      throw new GitHubDeliveryClientError(
        "merge_ambiguous",
        "GitHub merge outcome is ambiguous.",
      );
    }
    if (!response.ok)
      throw new GitHubDeliveryClientError(
        "merge_ambiguous",
        "GitHub merge outcome is ambiguous.",
      );
    const body = await this.#json(response, "merge_ambiguous");
    const value = record(body);
    if (value?.merged !== true || !SHA_PATTERN.test(String(value.sha)))
      throw new GitHubDeliveryClientError(
        "merge_ambiguous",
        "GitHub merge outcome is ambiguous.",
      );
    return assertMergeReceipt({
      repository: expected.repository,
      number: expected.number,
      issueNumber: expected.issueNumber,
      nodeId: expected.nodeId,
      method: expected.method,
      baseBranch: expected.expectedBaseBranch,
      baseSha: expected.expectedBaseSha,
      headBranch: expected.expectedHeadBranch,
      headSha: expected.expectedHeadSha,
      mergeSha: value.sha,
    });
  }

  async observeStaging(
    request: ObserveStagingRequest,
  ): Promise<StagingObservation> {
    const expected = assertObserveStagingRequest(request);
    this.#scope(expected.repository);
    const workflow = await this.#restJson(
      `/repos/${this.#owner}/${this.#repository}/actions/workflows/${encodeURIComponent(expected.workflow)}/runs?head_sha=${expected.mergeSha}`,
    );
    const workflowRun = records(record(workflow)?.workflow_runs)?.find(
      (run) => run.head_sha === expected.mergeSha,
    );
    if (workflowRun === undefined)
      return assertStagingObservation({
        ...expected,
        workflowRun: undefined,
        deployment: undefined,
        outcome: "pending",
      });
    const deployments = await this.#restJson(
      `/repos/${this.#owner}/${this.#repository}/deployments?sha=${expected.mergeSha}`,
    );
    const deployment = records(deployments)?.find(
      (item) =>
        item.environment === expected.environment &&
        item.sha === expected.mergeSha,
    );
    if (deployment === undefined)
      return assertStagingObservation({
        ...expected,
        workflowRun: this.#workflowRun(workflowRun, expected),
        deployment: undefined,
        outcome: "pending",
      });
    const statuses = await this.#restJson(
      `/repos/${this.#owner}/${this.#repository}/deployments/${deployment.id}/statuses`,
    );
    const status = records(statuses)?.[0];
    const deploymentReceipt = {
      id: String(deployment.id),
      environment: expected.environment,
      deployedSha: expected.mergeSha,
      state: status?.state,
    };
    const workflowReceipt = this.#workflowRun(workflowRun, expected);
    const outcome =
      workflowReceipt.conclusion === "success" &&
      deploymentReceipt.state === "success"
        ? "deployed"
        : workflowReceipt.conclusion === "failure" ||
            deploymentReceipt.state === "failure"
          ? "failed"
          : "pending";
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
    return projectMove(await gateway.moveProjectItem(move));
  }

  #workflowRun(value: Record<string, unknown>, request: ObserveStagingRequest) {
    return {
      id: String(value.id),
      workflow: request.workflow,
      headSha: request.mergeSha,
      status:
        value.status === "completed"
          ? "completed"
          : value.status === "in_progress"
            ? "in_progress"
            : "queued",
      conclusion:
        value.conclusion === "success"
          ? "success"
          : value.conclusion === "failure"
            ? "failure"
            : "none",
    };
  }

  #scope(repository: string): void {
    if (repository !== `${this.#owner}/${this.#repository}`)
      throw new GitHubDeliveryClientError(
        "invalid_response",
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
