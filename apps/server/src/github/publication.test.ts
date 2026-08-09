import { describe, expect, test } from "vitest";
import { FakeGitHubPublicationGateway } from "../../../../tests/fakes/github.js";
import {
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
      fake.setRequiredCheck("test", statuses.test);
      fake.setRequiredCheck("lint", statuses.lint);

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
    fake.setRequiredCheck("test", "success");

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
      { name: "lint", state: "missing" },
    ]);
  });

  test("reports exact-head drift and never accepts checks from another SHA", async () => {
    const fake = gateway();
    const pr = await fake.createPullRequest(publishRequest());
    fake.setPullRequestHead(pr.number, "c".repeat(40));
    fake.setRequiredCheck("test", "success");
    fake.setRequiredCheck("lint", "success");

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
      { name: "test", state: "missing" },
      { name: "lint", state: "missing" },
    ]);
  });

  test("reports base drift as non-green check evidence", async () => {
    const fake = gateway(["test"]);
    const pr = await fake.createPullRequest(publishRequest());
    fake.setRequiredCheck("test", "success");
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
      { name: "test", state: "missing" },
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
    fake.setRequiredCheck("test", "success");

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
});
