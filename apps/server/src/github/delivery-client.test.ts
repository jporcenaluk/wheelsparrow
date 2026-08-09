import { describe, expect, test } from "vitest";
import type { MergeCandidateRequest } from "./delivery.js";
import {
  GitHubDeliveryClient,
  GitHubDeliveryClientError,
} from "./delivery-client.js";
import type {
  ConditionalProjectStatusMove,
  GitHubProjectGateway,
  ProjectItem,
} from "./project.js";

const repository = "octo/widget";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const mergeSha = "c".repeat(40);

function candidateRequest(
  overrides: Partial<MergeCandidateRequest> = {},
): MergeCandidateRequest {
  return {
    repository,
    number: 7,
    issueNumber: 42,
    nodeId: "PR_node_7",
    expectedTitle: "feat: deliver the ticket",
    expectedBaseBranch: "main",
    expectedBaseSha: baseSha,
    expectedHeadBranch: "ticket/42",
    expectedHeadSha: headSha,
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetch: typeof globalThis.fetch) {
  return new GitHubDeliveryClient({
    owner: "octo",
    repository: "widget",
    token: "ghs_test_token",
    fetch,
    endpoint: "https://api.github.test/graphql",
    restEndpoint: "https://api.github.test",
  });
}

function graphqlCandidate() {
  return {
    data: {
      repository: {
        pullRequest: {
          id: "PR_node_7",
          number: 7,
          title: "feat: deliver the ticket",
          isDraft: false,
          baseRefName: "main",
          baseRefOid: baseSha,
          headRefName: "ticket/42",
          headRefOid: headSha,
          mergeable: "MERGEABLE",
          closingIssuesReferences: {
            nodes: [{ number: 42 }],
          },
          reviewThreads: {
            nodes: [{ id: "thread-1", isResolved: true }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "checks",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            ],
          },
        },
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
        mergeCommitAllowed: true,
      },
    },
  };
}

describe("GitHubDeliveryClient", () => {
  test("fails closed before fetch when credentials are absent", async () => {
    let calls = 0;
    const gateway = new GitHubDeliveryClient({
      owner: "octo",
      repository: "widget",
      endpoint: "https://api.github.test/graphql",
      restEndpoint: "https://api.github.test",
      fetch: async () => {
        calls += 1;
        return response(graphqlCandidate());
      },
    });
    await expect(
      gateway.readMergeCandidate(candidateRequest()),
    ).rejects.toMatchObject({
      kind: "credentials_unavailable",
    });
    expect(calls).toBe(0);
  });

  test("reads exact PR identity, checks, threads, mergeability, and methods", async () => {
    const calls: Request[] = [];
    const gateway = client(async (input, init) => {
      calls.push(new Request(input, init));
      return response(graphqlCandidate());
    });

    await expect(
      gateway.readMergeCandidate(candidateRequest()),
    ).resolves.toEqual({
      repository,
      number: 7,
      issueNumber: 42,
      nodeId: "PR_node_7",
      isDraft: false,
      title: "feat: deliver the ticket",
      baseBranch: "main",
      baseSha,
      headBranch: "ticket/42",
      headSha,
      requiredChecks: {
        repository,
        number: 7,
        nodeId: "PR_node_7",
        headSha,
        requiredCheckNames: ["checks"],
        requiredChecks: [{ name: "checks", state: "success" }],
        headDrift: false,
        aggregate: "green",
      },
      threads: [{ id: "thread-1", resolved: true }],
      mergeability: "mergeable",
      permittedMergeMethods: ["squash", "merge"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("authorization")).toBe(
      "Bearer ghs_test_token",
    );
    expect(calls[0]?.body).not.toContain("ghs_test_token");
  });

  test("returns an exact merge receipt and fails closed on an ambiguous response", async () => {
    const calls: Request[] = [];
    const gateway = client(async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      if (request.url.endsWith("/graphql")) return response(graphqlCandidate());
      return response({ merged: true, sha: mergeSha });
    });

    await expect(
      gateway.mergePullRequest({
        ...candidateRequest(),
        effectKey: "run:1:merge:1",
        method: "squash",
      }),
    ).resolves.toMatchObject({ mergeSha, method: "squash" });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.method).toBe("PUT");
    expect(await calls[1]?.json()).toEqual({
      merge_method: "squash",
      sha: headSha,
    });

    const ambiguous = client(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/graphql")) return response(graphqlCandidate());
      throw new Error("socket closed with provider body: secret");
    });
    await expect(
      ambiguous.mergePullRequest({
        ...candidateRequest(),
        effectKey: "run:1:merge:2",
        method: "squash",
      }),
    ).rejects.toMatchObject({ kind: "merge_ambiguous" });
    await expect(
      ambiguous.mergePullRequest({
        ...candidateRequest(),
        effectKey: "run:1:merge:3",
        method: "squash",
      }),
    ).rejects.not.toThrow("secret");
  });

  test("correlates one workflow run and deployment to the exact merge SHA", async () => {
    const gateway = client(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.includes("/actions/workflows/")) {
        return response({
          workflow_runs: [
            {
              id: 11,
              path: ".github/workflows/deploy.yml",
              head_sha: mergeSha,
              status: "completed",
              conclusion: "success",
            },
          ],
        });
      }
      if (url.pathname.endsWith("/deployments")) {
        return response([{ id: 21, environment: "staging", sha: mergeSha }]);
      }
      return response([{ id: 22, environment: "staging", state: "success" }]);
    });

    await expect(
      gateway.observeStaging({
        repository,
        workflow: "deploy.yml",
        environment: "staging",
        mergeSha,
      }),
    ).resolves.toMatchObject({
      outcome: "deployed",
      workflowRun: { id: "11", headSha: mergeSha },
      deployment: { id: "21", deployedSha: mergeSha, state: "success" },
    });
  });

  test("does not expose provider response bodies or credentials", async () => {
    const gateway = client(async () =>
      response({ message: "provider token=ghs_response_secret" }, 500),
    );
    let error: unknown;
    try {
      await gateway.readMergeCandidate(candidateRequest());
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(GitHubDeliveryClientError);
    expect(String(error)).not.toContain("ghs_response_secret");
    expect(String(error)).not.toContain("provider token");
  });

  test("rejects exact-head drift before attempting the merge mutation", async () => {
    const calls: Request[] = [];
    const gateway = client(async (input, init) => {
      calls.push(new Request(input, init));
      const body = graphqlCandidate();
      body.data.repository.pullRequest.headRefOid = "d".repeat(40);
      return response(body);
    });

    await expect(
      gateway.mergePullRequest({
        ...candidateRequest(),
        effectKey: "run:1:merge:drift",
        method: "squash",
      }),
    ).rejects.toMatchObject({ kind: "head_drift" });
    expect(calls).toHaveLength(1);
  });

  test("classifies an explicit provider merge rejection as prevented", async () => {
    const gateway = client(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/graphql")) return response(graphqlCandidate());
      return response({ message: "merge conflict: provider details" }, 409);
    });

    await expect(
      gateway.mergePullRequest({
        ...candidateRequest(),
        effectKey: "run:1:merge:prevented",
        method: "squash",
      }),
    ).rejects.toMatchObject({ kind: "merge_prevented" });
  });

  test("classifies an explicit merged-false response as prevented", async () => {
    const gateway = client(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/graphql")) return response(graphqlCandidate());
      return response({ merged: false, sha: null });
    });

    await expect(
      gateway.mergePullRequest({
        ...candidateRequest(),
        effectKey: "run:1:merge:false",
        method: "squash",
      }),
    ).rejects.toMatchObject({ kind: "merge_prevented" });
  });

  test("reports a successful workflow with a different environment SHA as a mismatch", async () => {
    const gateway = client(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.includes("/actions/workflows/")) {
        return response({
          workflow_runs: [
            {
              id: 11,
              path: ".github/workflows/deploy.yml",
              head_sha: mergeSha,
              status: "completed",
              conclusion: "success",
            },
          ],
        });
      }
      if (url.pathname.endsWith("/deployments")) {
        return response([
          { id: 21, environment: "staging", sha: "d".repeat(40) },
        ]);
      }
      return response([
        {
          id: 22,
          environment: "staging",
          state: "success",
          created_at: "2026-08-09T10:00:00Z",
        },
      ]);
    });

    await expect(
      gateway.observeStaging({
        repository,
        workflow: "deploy.yml",
        environment: "staging",
        mergeSha,
      }),
    ).resolves.toMatchObject({
      outcome: "sha_mismatch",
      deployment: { deployedSha: "d".repeat(40) },
    });
  });

  test("fails closed for an arbitrary endpoint override", () => {
    expect(
      () =>
        new GitHubDeliveryClient({
          owner: "octo",
          repository: "widget",
          token: "ghs_test_token",
          endpoint: "https://evil.example/graphql",
        }),
    ).toThrowError(expect.objectContaining({ kind: "invalid_input" }));
  });

  test("requires an observed merge SHA and replays Done by effect key", async () => {
    const doneItem: ProjectItem = {
      projectItemId: "PVTI_1",
      projectId: "PVT_1",
      projectNumber: 9,
      repository,
      issueNodeId: "I_42",
      issueNumber: 42,
      isOpen: true,
      status: "Done",
      revision: "revision-2",
      labels: ["mvp"],
      createdAt: "2026-08-09T12:00:00.000Z",
      dependencies: [],
    };
    let moves = 0;
    const projectGateway: GitHubProjectGateway = {
      readProject: async () => ({
        projectId: "PVT_1",
        projectNumber: 9,
        repository,
        items: [doneItem],
      }),
      readProjectItem: async () => doneItem,
      moveProjectItem: async (_request: ConditionalProjectStatusMove) => {
        moves += 1;
        return { outcome: "moved", item: doneItem };
      },
    };
    const gateway = new GitHubDeliveryClient({
      owner: "octo",
      repository: "widget",
      token: "ghs_test_token",
      endpoint: "https://api.github.test/graphql",
      restEndpoint: "https://api.github.test",
      projectGateway,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/graphql"))
          return response(graphqlCandidate());
        return response({ merged: true, sha: mergeSha });
      },
    });
    const doneRequest = {
      repository,
      projectId: "PVT_1",
      projectNumber: 9,
      itemId: "PVTI_1",
      issueNodeId: "I_42",
      issueNumber: 42,
      expectedRevision: "revision-1",
      fromStatus: "Review",
      toStatus: "Done",
      effectKey: "run:1:done",
      mergeSha,
    } as const;
    await expect(
      gateway.moveProjectItemToDone(doneRequest),
    ).resolves.toMatchObject({
      outcome: "rejected",
      reason: { kind: "merge_not_observed" },
    });
    await gateway.mergePullRequest({
      ...candidateRequest(),
      effectKey: "run:1:merge:done",
      method: "squash",
    });
    await expect(
      gateway.moveProjectItemToDone(doneRequest),
    ).resolves.toMatchObject({
      outcome: "moved",
    });
    await expect(
      gateway.moveProjectItemToDone(doneRequest),
    ).resolves.toMatchObject({
      outcome: "already_applied",
    });
    expect(moves).toBe(1);
  });
});
