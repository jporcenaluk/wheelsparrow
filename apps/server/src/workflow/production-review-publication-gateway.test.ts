import { describe, expect, test } from "vitest";

import { createProductionGitHubPublicationGateway } from "./production-review-publication.js";

const repository = "owner/repository";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function gateway(fetch: typeof globalThis.fetch) {
  return createProductionGitHubPublicationGateway({
    owner: "owner",
    repository,
    token: "ghs_test_token",
    fetch,
    endpoint: "https://api.github.test",
  });
}

function pullRequest() {
  return {
    number: 7,
    node_id: "PR_node_7",
    html_url: "https://github.com/owner/repository/pull/7",
    title: "feat: deliver issue 42",
    body: "Closes #42",
    draft: false,
    base: { ref: "main", sha: baseSha },
    head: { ref: "ticket/42", sha: headSha },
  };
}

describe("production GitHub publication gateway", () => {
  test("observes every configured base-branch check and marks missing checks pending", async () => {
    const requests: Request[] = [];
    const publication = gateway(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/pulls/7")) return response(pullRequest());
      if (
        request.url.endsWith("/branches/main/protection/required_status_checks")
      )
        return response({ contexts: ["unit", "lint"] });
      if (request.url.endsWith(`/commits/${headSha}/check-runs?per_page=100`))
        return response({
          check_runs: [
            { name: "unit", status: "completed", conclusion: "success" },
          ],
        });
      if (request.url.endsWith(`/commits/${headSha}/status?per_page=100`))
        return response({ statuses: [] });
      throw new Error(`unexpected URL: ${request.url}`);
    });

    await expect(
      publication.observeRequiredChecks({
        repository,
        number: 7,
        nodeId: "PR_node_7",
        expectedBaseBranch: "main",
        expectedBaseSha: baseSha,
        expectedHeadSha: headSha,
      }),
    ).resolves.toEqual({
      repository,
      number: 7,
      nodeId: "PR_node_7",
      headSha,
      requiredCheckNames: ["unit", "lint"],
      requiredChecks: [
        { name: "unit", state: "success" },
        { name: "lint", state: "pending" },
      ],
      headDrift: false,
      aggregate: "pending",
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toContain(
      "/repos/owner/repository/pulls/7",
    );
    expect(
      requests.map((request) => new URL(request.url).pathname),
    ).not.toContain("/repos/owner/repository/pulls/1");
  });

  test("fails closed when the base branch required-status-check set is unavailable", async () => {
    const requests: Request[] = [];
    const publication = gateway(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/pulls/7")) return response(pullRequest());
      return response({ message: "Branch protection unavailable" }, 404);
    });

    await expect(
      publication.observeRequiredChecks({
        repository,
        number: 7,
        nodeId: "PR_node_7",
        expectedBaseBranch: "main",
        expectedBaseSha: baseSha,
        expectedHeadSha: headSha,
      }),
    ).rejects.toThrow("GitHub publication data is unavailable");
    expect(requests).toHaveLength(2);
  });
});
