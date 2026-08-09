import { describe, expect, test } from "vitest";
import { FakeGitHubPublicationGateway } from "../../../../tests/fakes/github.js";
import {
  assertPullRequestReceipt,
  assertRequiredChecksReceipt,
  GitHubPublicationBoundaryError,
  type GitHubPublicationGateway,
  type PublishPullRequestRequest,
  type PullRequestReceipt,
  type RequiredChecksReceipt,
} from "./publication.js";

const repository = "octo/widget";
const issueNumber = 42;

function publishRequest(
  overrides: Partial<PublishPullRequestRequest> = {},
): PublishPullRequestRequest {
  return {
    repository,
    issueNumber,
    effectKey: "run:run-1:pr:create",
    title: "feat: publish the ticket",
    body: "Closes #42",
    baseBranch: "main",
    baseSha: "a".repeat(40),
    headBranch: "ticket/42-publish",
    headSha: "b".repeat(40),
    ...overrides,
  };
}

function readRequest(receipt: PullRequestReceipt) {
  return {
    repository: receipt.repository,
    number: receipt.number,
    issueNumber: receipt.issueNumber,
    expectedNodeId: receipt.nodeId,
    expectedTitle: receipt.title,
    expectedBaseBranch: receipt.baseBranch,
    expectedBaseSha: receipt.baseSha,
    expectedHeadBranch: receipt.headBranch,
    expectedHeadSha: receipt.headSha,
  };
}

function gateway(
  requiredChecks: readonly string[] = ["test", "lint"],
): FakeGitHubPublicationGateway {
  return new FakeGitHubPublicationGateway({ repository, requiredChecks });
}

describe("GitHub publication gateway seam", () => {
  test("creates and rereads a linked non-draft PR with exact identity and heads", async () => {
    const publication: GitHubPublicationGateway = gateway();

    const created = await publication.createPullRequest(publishRequest());
    expect(created).toEqual({
      repository,
      number: 1,
      nodeId: "PR_node_1",
      url: "https://github.com/octo/widget/pull/1",
      title: "feat: publish the ticket",
      issueNumber,
      isDraft: false,
      baseBranch: "main",
      baseSha: "a".repeat(40),
      headBranch: "ticket/42-publish",
      headSha: "b".repeat(40),
    });

    await expect(
      publication.readPullRequest(readRequest(created)),
    ).resolves.toEqual(created);
  });

  test("replays an identical create mutation by effect key without creating a second PR", async () => {
    const fake = gateway();
    const request = publishRequest();

    const first = await fake.createPullRequest(request);
    const replay = await fake.createPullRequest({ ...request });

    expect(replay).toEqual(first);
    expect(fake.publicationMutations()).toHaveLength(1);
    expect(fake.publicationMutations()[0]).toMatchObject({
      effectKey: request.effectKey,
      headSha: request.headSha,
    });
  });

  test("rejects an effect-key replay after the provider changes the PR head", async () => {
    const fake = gateway();
    const request = publishRequest();
    const first = await fake.createPullRequest(request);
    fake.setPullRequestHead(first.number, "c".repeat(40));

    await expect(fake.createPullRequest(request)).rejects.toMatchObject({
      kind: "head_drift",
    });
    expect(fake.publicationMutations()).toHaveLength(1);
  });

  test("rejects an effect-key replay after the provider makes the PR a draft", async () => {
    const fake = gateway();
    const request = publishRequest();
    const first = await fake.createPullRequest(request);
    fake.setPullRequestDraft(first.number, true);

    await expect(fake.createPullRequest(request)).rejects.toMatchObject({
      kind: "pull_request_is_draft",
    });
    expect(fake.publicationMutations()).toHaveLength(1);
  });

  test("rejects an effect key reused for a different publication request", async () => {
    const fake = gateway();
    await fake.createPullRequest(publishRequest());

    await expect(
      fake.createPullRequest(
        publishRequest({ headSha: "c".repeat(40), title: "different" }),
      ),
    ).rejects.toMatchObject({ kind: "effect_key_conflict" });
    expect(fake.publicationMutations()).toHaveLength(1);
  });

  test.each([
    ["pending", { test: "pending", lint: "success" }, "pending"],
    ["green", { test: "success", lint: "success" }, "green"],
    ["failed", { test: "failure", lint: "success" }, "failed"],
  ] as const)(
    "aggregates required checks as %s for the exact PR head",
    async (_label, statuses, aggregate) => {
      const fake = gateway();
      const pr = await fake.createPullRequest(publishRequest());
      fake.setRequiredCheck(pr.number, pr.headSha, "test", statuses.test);
      fake.setRequiredCheck(pr.number, pr.headSha, "lint", statuses.lint);

      const observed = await fake.observeRequiredChecks({
        repository,
        number: pr.number,
        nodeId: pr.nodeId,
        expectedBaseBranch: pr.baseBranch,
        expectedBaseSha: pr.baseSha,
        expectedHeadSha: pr.headSha,
      });

      expect(observed.aggregate).toBe(aggregate);
      expect(observed.requiredChecks).toEqual([
        { name: "test", state: statuses.test },
        { name: "lint", state: statuses.lint },
      ]);
    },
  );

  test("keeps a missing required check pending instead of treating partial evidence as green", async () => {
    const fake = gateway();
    const pr = await fake.createPullRequest(publishRequest());
    fake.setRequiredCheck(pr.number, pr.headSha, "test", "success");

    const observed = await fake.observeRequiredChecks({
      repository,
      number: pr.number,
      nodeId: pr.nodeId,
      expectedBaseBranch: pr.baseBranch,
      expectedBaseSha: pr.baseSha,
      expectedHeadSha: pr.headSha,
    });

    expect(observed).toMatchObject({ aggregate: "pending" });
    expect(observed.requiredChecks).toEqual([
      { name: "test", state: "success" },
      { name: "lint", state: "pending" },
    ]);
  });

  test("reports exact-head drift and never accepts checks from another SHA", async () => {
    const fake = gateway();
    const pr = await fake.createPullRequest(publishRequest());
    fake.setPullRequestHead(pr.number, "c".repeat(40));
    fake.setRequiredCheck(pr.number, "c".repeat(40), "test", "success");
    fake.setRequiredCheck(pr.number, "c".repeat(40), "lint", "success");

    const observed = await fake.observeRequiredChecks({
      repository,
      number: pr.number,
      nodeId: pr.nodeId,
      expectedBaseBranch: pr.baseBranch,
      expectedBaseSha: pr.baseSha,
      expectedHeadSha: pr.headSha,
    });

    expect(observed).toMatchObject({
      aggregate: "head_drift",
      headSha: "c".repeat(40),
    });
    expect(observed.requiredChecks).toEqual([
      { name: "test", state: "pending" },
      { name: "lint", state: "pending" },
    ]);
  });

  test("reports base drift as non-green check evidence", async () => {
    const fake = gateway(["test"]);
    const pr = await fake.createPullRequest(publishRequest());
    fake.setRequiredCheck(pr.number, pr.headSha, "test", "success");
    fake.setPullRequestBase(pr.number, "c".repeat(40));

    const observed = await fake.observeRequiredChecks({
      repository,
      number: pr.number,
      nodeId: pr.nodeId,
      expectedBaseBranch: pr.baseBranch,
      expectedBaseSha: pr.baseSha,
      expectedHeadSha: pr.headSha,
    });

    expect(observed.aggregate).toBe("head_drift");
    expect(observed.requiredChecks).toEqual([
      { name: "test", state: "pending" },
    ]);
  });

  test.each([
    ["repository", { repository: "other/repo" }],
    ["base SHA", { expectedBaseSha: "c".repeat(40) }],
    ["head SHA", { expectedHeadSha: "c".repeat(40) }],
  ] as const)(
    "fails closed on %s mismatch while rereading a PR",
    async (_label, change) => {
      const fake = gateway();
      const pr = await fake.createPullRequest(publishRequest());
      await expect(
        fake.readPullRequest({ ...readRequest(pr), ...change }),
      ).rejects.toBeInstanceOf(GitHubPublicationBoundaryError);
    },
  );

  test("rejects malformed or over-bounded mutation input before changing state", async () => {
    const fake = gateway();
    const malformed = {
      ...publishRequest(),
      title: "x".repeat(2_001),
      unexpected: true,
    } as unknown as PublishPullRequestRequest;

    await expect(fake.createPullRequest(malformed)).rejects.toMatchObject({
      kind: "invalid_input",
    });
    expect(fake.publicationMutations()).toHaveLength(0);
  });

  test("returns a defensive plain check receipt", async () => {
    const fake = gateway(["test"]);
    const pr = await fake.createPullRequest(publishRequest());
    fake.setRequiredCheck(pr.number, pr.headSha, "test", "success");

    const observed: RequiredChecksReceipt = await fake.observeRequiredChecks({
      repository,
      number: pr.number,
      nodeId: pr.nodeId,
      expectedBaseBranch: pr.baseBranch,
      expectedBaseSha: pr.baseSha,
      expectedHeadSha: pr.headSha,
    });
    expect(Object.getPrototypeOf(observed)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(observed.requiredChecks[0])).toBe(
      Object.prototype,
    );
  });

  test("targets check progression to the explicit PR and head", async () => {
    const fake = gateway(["test"]);
    const first = await fake.createPullRequest(
      publishRequest({ issueNumber: 42, headBranch: "ticket/42-first" }),
    );
    const second = await fake.createPullRequest(
      publishRequest({
        issueNumber: 43,
        effectKey: "run:run-2:pr:create",
        headBranch: "ticket/43-second",
        headSha: "c".repeat(40),
      }),
    );
    fake.setRequiredCheck(second.number, second.headSha, "test", "success");

    const firstChecks = await fake.observeRequiredChecks({
      repository,
      number: first.number,
      nodeId: first.nodeId,
      expectedBaseBranch: first.baseBranch,
      expectedBaseSha: first.baseSha,
      expectedHeadSha: first.headSha,
    });
    const secondChecks = await fake.observeRequiredChecks({
      repository,
      number: second.number,
      nodeId: second.nodeId,
      expectedBaseBranch: second.baseBranch,
      expectedBaseSha: second.baseSha,
      expectedHeadSha: second.headSha,
    });

    expect(firstChecks.aggregate).toBe("pending");
    expect(secondChecks.aggregate).toBe("green");
  });

  test.each([
    ["draft", { isDraft: true }],
    ["non-canonical URL", { url: "https://example.test/octo/widget/pull/1" }],
    ["double-slash branch", { headBranch: "ticket//publish" }],
    ["dot-dot branch", { headBranch: "ticket/../publish" }],
    ["lock component branch", { headBranch: "foo.lock/bar" }],
    ["dot component branch", { headBranch: "foo./bar" }],
    ["dash-leading component branch", { headBranch: "foo/-bar" }],
    ["underscore-leading component branch", { headBranch: "foo/_bar" }],
    ["leading punctuation branch", { headBranch: "-foo/bar" }],
    ["trailing-slash branch", { headBranch: "ticket/publish/" }],
    ["trailing-space branch", { headBranch: "ticket/publish " }],
    ["URL query", { url: "https://github.com/octo/widget/pull/1?x=1" }],
    ["URL fragment", { url: "https://github.com/octo/widget/pull/1#x" }],
    ["URL userinfo", { url: "https://user@github.com/octo/widget/pull/1" }],
    ["URL default port", { url: "https://github.com:443/octo/widget/pull/1" }],
    [
      "URL leading whitespace",
      { url: " https://github.com/octo/widget/pull/1" },
    ],
    [
      "URL trailing whitespace",
      { url: "https://github.com/octo/widget/pull/1 " },
    ],
    [
      "URL embedded newline",
      { url: "https://github.com/octo/\nwidget/pull/1" },
    ],
    [
      "URL trailing newline",
      { url: "https://github.com/octo/widget/pull/1\n" },
    ],
    [
      "URL path delimiter",
      { url: "https://github.com/octo/widget/pull/1/extra" },
    ],
    [
      "URL encoded path delimiter",
      { url: "https://github.com/octo%2Fwidget/pull/1" },
    ],
    ["repository query", { repository: "octo/widget?x=1" }],
    ["repository fragment", { repository: "octo/widget#x" }],
    ["repository userinfo", { repository: "octo@widget/repo" }],
    ["repository path delimiter", { repository: "octo/widget/extra" }],
    ["repository trailing owner punctuation", { repository: "owner-/repo" }],
    ["repository trailing name punctuation", { repository: "owner/repo_" }],
  ] as const)("rejects %s pull request receipts", (_label, change) => {
    const valid = {
      repository,
      number: 1,
      nodeId: "PR_node_1",
      url: "https://github.com/octo/widget/pull/1",
      title: "feat: publish the ticket",
      issueNumber,
      isDraft: false,
      baseBranch: "main",
      baseSha: "a".repeat(40),
      headBranch: "ticket/42-publish",
      headSha: "b".repeat(40),
    };
    expect(() => assertPullRequestReceipt({ ...valid, ...change })).toThrow(
      /receipt|draft|url|branch/i,
    );
  });

  test("derives and enforces the required-check aggregate", () => {
    const valid = {
      repository,
      number: 1,
      nodeId: "PR_node_1",
      headSha: "b".repeat(40),
      requiredChecks: [{ name: "test", state: "success" as const }],
      headDrift: false,
      aggregate: "green" as const,
    };
    expect(assertRequiredChecksReceipt(valid).aggregate).toBe("green");
    expect(() =>
      assertRequiredChecksReceipt({ ...valid, aggregate: "pending" }),
    ).toThrow(/aggregate|check/i);
    expect(() =>
      assertRequiredChecksReceipt({ ...valid, requiredChecks: [] }),
    ).toThrow(/check/i);
    expect(() =>
      assertRequiredChecksReceipt({ ...valid, headDrift: true }),
    ).toThrow(/aggregate|check/i);
    expect(
      assertRequiredChecksReceipt({
        ...valid,
        headDrift: true,
        aggregate: "head_drift",
      }).aggregate,
    ).toBe("head_drift");
  });

  test.each(["owner-/repo", "owner/repo_"])(
    "rejects a repository segment with trailing punctuation: %s",
    (unsafeRepository) => {
      const receipt = {
        repository: unsafeRepository,
        number: 1,
        nodeId: "PR_node_1",
        url: `https://github.com/${unsafeRepository}/pull/1`,
        title: "feat: publish the ticket",
        issueNumber,
        isDraft: false,
        baseBranch: "main",
        baseSha: "a".repeat(40),
        headBranch: "ticket/42-publish",
        headSha: "b".repeat(40),
      };
      expect(() => assertPullRequestReceipt(receipt)).toThrow(
        /receipt|repository/i,
      );
    },
  );
});
