import { describe, expect, test } from "vitest";
import { FakeGitHubDeliveryGateway } from "../../../../tests/fakes/github.js";
import {
  assertMergeCandidateReceipt,
  assertMergeCandidateRequest,
  assertMergeReceipt,
  assertObserveStagingRequest,
  assertStagingObservation,
  type ConditionalProjectDoneMoveRequest,
  GitHubDeliveryBoundaryError,
  type MergeCandidateReceipt,
  type MergeCandidateRequest,
  type MergeReceipt,
  type MergeRequest,
  type StagingDeploymentReceipt,
  type StagingWorkflowRunReceipt,
  selectMergeMethod,
} from "./delivery.js";
import type { ProjectItem } from "./project.js";

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

function candidate(
  overrides: Partial<MergeCandidateReceipt> = {},
): MergeCandidateReceipt {
  return {
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
      requiredCheckNames: ["test", "lint"],
      requiredChecks: [
        { name: "test", state: "success" },
        { name: "lint", state: "success" },
      ],
      headDrift: false,
      aggregate: "green",
    },
    threads: [],
    mergeability: "mergeable",
    permittedMergeMethods: ["rebase", "squash"],
    ...overrides,
  };
}

function mergeRequest(overrides: Partial<MergeRequest> = {}): MergeRequest {
  return {
    ...candidateRequest(),
    effectKey: "run:run-1:merge:b".concat("b".repeat(39)),
    method: "squash",
    ...overrides,
  };
}

function projectItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    projectItemId: "PVTI_1",
    projectId: "PVT_1",
    projectNumber: 9,
    repository,
    issueNodeId: "I_42",
    issueNumber: 42,
    isOpen: true,
    status: "Review",
    revision: "revision-1",
    labels: ["mvp"],
    createdAt: "2026-08-09T12:00:00.000Z",
    dependencies: [],
    ...overrides,
  };
}

function doneRequest(
  overrides: Partial<ConditionalProjectDoneMoveRequest> = {},
): ConditionalProjectDoneMoveRequest {
  return {
    repository,
    projectId: "PVT_1",
    projectNumber: 9,
    itemId: "PVTI_1",
    issueNodeId: "I_42",
    issueNumber: 42,
    expectedRevision: "revision-1",
    fromStatus: "Review",
    toStatus: "Done",
    effectKey: "run:run-1:project:done:ccc".replace("ccc", mergeSha),
    mergeSha,
    ...overrides,
  };
}

function fake() {
  return new FakeGitHubDeliveryGateway({
    repository,
    requiredChecks: ["test", "lint"],
    staging: { workflow: "deploy-staging.yml", environment: "staging" },
  });
}

describe("delivery boundary contracts", () => {
  test("selects merge methods in deterministic squash, rebase, merge order", () => {
    expect(
      selectMergeMethod(
        candidate({ permittedMergeMethods: ["merge", "squash"] }),
      ),
    ).toBe("squash");
    expect(
      selectMergeMethod(
        candidate({ permittedMergeMethods: ["merge", "rebase"] }),
      ),
    ).toBe("rebase");
    expect(
      selectMergeMethod(candidate({ permittedMergeMethods: ["merge"] })),
    ).toBe("merge");
  });

  test("fails closed when no permitted merge capability exists", () => {
    expect(() =>
      selectMergeMethod(candidate({ permittedMergeMethods: [] })),
    ).toThrowError(
      expect.objectContaining({ kind: "merge_capability_unavailable" }),
    );
  });

  test("validates exact candidate facts and rejects extra or malformed fields", () => {
    expect(assertMergeCandidateRequest(candidateRequest())).toEqual(
      candidateRequest(),
    );
    expect(() =>
      assertMergeCandidateRequest({
        ...candidateRequest(),
        extra: true,
      } as unknown),
    ).toThrowError(expect.objectContaining({ kind: "invalid_input" }));
    expect(() =>
      assertMergeCandidateReceipt({
        ...candidate(),
        baseSha: "not-a-sha",
      } as unknown),
    ).toThrowError(expect.objectContaining({ kind: "invalid_input" }));
  });

  test("validates merge and staging receipts without accepting provider secrets", () => {
    const receipt: MergeReceipt = {
      repository,
      number: 7,
      issueNumber: 42,
      nodeId: "PR_node_7",
      method: "squash",
      baseBranch: "main",
      baseSha,
      headBranch: "ticket/42",
      headSha,
      mergeSha,
    };
    expect(assertMergeReceipt(receipt)).toEqual(receipt);
    const run: StagingWorkflowRunReceipt = {
      id: "run-7",
      workflow: "deploy-staging.yml",
      headSha: mergeSha,
      status: "completed",
      conclusion: "success",
    };
    const deployment: StagingDeploymentReceipt = {
      id: "deployment-7",
      environment: "staging",
      deployedSha: mergeSha,
      state: "success",
    };
    expect(
      assertStagingObservation({
        repository,
        workflow: "deploy-staging.yml",
        environment: "staging",
        mergeSha,
        workflowRun: run,
        deployment,
        outcome: "deployed",
      }),
    ).toMatchObject({ outcome: "deployed", mergeSha });
    expect(() =>
      assertObserveStagingRequest({
        repository,
        workflow: "deploy-staging.yml",
        environment: "staging",
        mergeSha,
        token: "secret-must-not-be-accepted",
      } as unknown),
    ).toThrowError(expect.objectContaining({ kind: "invalid_input" }));
  });
});

describe("FakeGitHubDeliveryGateway", () => {
  test("rereads PR identity, checks, threads, mergeability, and methods", async () => {
    const gateway = fake();
    gateway.seedPullRequest(candidate());
    gateway.setRequiredCheck(7, headSha, "test", "success");
    gateway.setRequiredCheck(7, headSha, "lint", "success");
    const observed = await gateway.readMergeCandidate(candidateRequest());
    expect(observed).toEqual(candidate());
    expect(Object.isFrozen(observed.permittedMergeMethods)).toBe(true);
    expect(Object.isFrozen(observed.threads)).toBe(true);
  });

  test("reports exact drift and unresolved threads without accepting a stale candidate", async () => {
    const gateway = fake();
    gateway.seedPullRequest(candidate());
    gateway.setPullRequestHead(7, "d".repeat(40));
    gateway.setThreads(7, [{ id: "thread-1", resolved: false }]);
    const observed = await gateway.readMergeCandidate(candidateRequest());
    expect(observed.headSha).toBe("d".repeat(40));
    expect(observed.threads).toEqual([{ id: "thread-1", resolved: false }]);
    expect(observed.requiredChecks.aggregate).toBe("head_drift");
    await expect(
      gateway.mergePullRequest(mergeRequest()),
    ).rejects.toMatchObject({
      kind: "head_drift",
    });
  });

  test("fails closed for a draft PR or a mismatched PR identity", async () => {
    const gateway = fake();
    gateway.seedPullRequest(candidate());
    gateway.setPullRequestDraft(7, true);
    await expect(
      gateway.readMergeCandidate(candidateRequest()),
    ).rejects.toMatchObject({
      kind: "pull_request_is_draft",
    });
    gateway.setPullRequestDraft(7, false);
    await expect(
      gateway.readMergeCandidate(candidateRequest({ nodeId: "PR_node_other" })),
    ).rejects.toMatchObject({ kind: "pull_request_mismatch" });
  });

  test("merges once using the preferred permitted capability and replays by effect key", async () => {
    const gateway = fake();
    gateway.seedPullRequest(
      candidate({ permittedMergeMethods: ["merge", "squash"] }),
    );
    gateway.setRequiredCheck(7, headSha, "test", "success");
    gateway.setRequiredCheck(7, headSha, "lint", "success");
    const request = mergeRequest({ method: "squash" });
    const first = await gateway.mergePullRequest(request);
    expect(first).toEqual({
      repository,
      number: 7,
      issueNumber: 42,
      nodeId: "PR_node_7",
      method: "squash",
      baseBranch: "main",
      baseSha,
      headBranch: "ticket/42",
      headSha,
      mergeSha,
    });
    await expect(gateway.mergePullRequest(request)).resolves.toEqual(first);
    expect(gateway.mergeMutations()).toHaveLength(1);
  });

  test("keeps prevented or ambiguous merge mutations fail-closed", async () => {
    const gateway = fake();
    gateway.seedPullRequest(candidate());
    gateway.setMergeFailure("merge_prevented");
    await expect(
      gateway.mergePullRequest(mergeRequest()),
    ).rejects.toMatchObject({
      kind: "merge_prevented",
    });
    expect(gateway.mergeMutations()).toHaveLength(0);
    gateway.setMergeFailure("merge_ambiguous");
    await expect(
      gateway.mergePullRequest(mergeRequest()),
    ).rejects.toMatchObject({
      kind: "merge_ambiguous",
    });
    expect(gateway.mergeMutations()).toHaveLength(0);
  });

  test.each([
    [
      "pending checks",
      (gateway: FakeGitHubDeliveryGateway) =>
        gateway.setRequiredCheck(7, headSha, "test", "pending"),
      "required_checks_not_green",
    ],
    [
      "unresolved threads",
      (gateway: FakeGitHubDeliveryGateway) =>
        gateway.setThreads(7, [{ id: "thread-1", resolved: false }]),
      "unresolved_threads",
    ],
    [
      "conflicting PR",
      (gateway: FakeGitHubDeliveryGateway) =>
        gateway.setMergeability(7, "conflicting"),
      "merge_conflict",
    ],
  ] as const)("rejects merge with %s", async (_label, arrange, kind) => {
    const gateway = fake();
    gateway.seedPullRequest(candidate());
    arrange(gateway);
    await expect(
      gateway.mergePullRequest(mergeRequest()),
    ).rejects.toMatchObject({ kind });
    expect(gateway.mergeMutations()).toHaveLength(0);
  });

  test("observes staging only for the configured workflow/environment and exact merge SHA", async () => {
    const gateway = fake();
    gateway.setWorkflowRun({
      id: "run-7",
      workflow: "deploy-staging.yml",
      headSha: mergeSha,
      status: "completed",
      conclusion: "success",
    });
    gateway.setDeployment({
      id: "deployment-7",
      environment: "staging",
      deployedSha: mergeSha,
      state: "success",
    });
    await expect(
      gateway.observeStaging({
        repository,
        workflow: "deploy-staging.yml",
        environment: "staging",
        mergeSha,
      }),
    ).resolves.toMatchObject({ outcome: "deployed", mergeSha });
    gateway.setDeployment({
      id: "deployment-8",
      environment: "staging",
      deployedSha: "d".repeat(40),
      state: "success",
    });
    await expect(
      gateway.observeStaging({
        repository,
        workflow: "deploy-staging.yml",
        environment: "staging",
        mergeSha,
      }),
    ).resolves.toMatchObject({ outcome: "sha_mismatch" });
  });

  test("moves a project item to Done only with an observed merge and exact revision", async () => {
    const gateway = fake();
    gateway.seedPullRequest(candidate());
    gateway.setRequiredCheck(7, headSha, "test", "success");
    gateway.setRequiredCheck(7, headSha, "lint", "success");
    await gateway.mergePullRequest(mergeRequest());
    gateway.seedProjectItem(projectItem());
    const moved = await gateway.moveProjectItemToDone(doneRequest());
    expect(moved.outcome).toBe("moved");
    if (moved.outcome !== "moved") throw new Error("expected move");
    expect(moved.item.status).toBe("Done");
    await expect(
      gateway.moveProjectItemToDone(doneRequest()),
    ).resolves.toMatchObject({
      outcome: "already_applied",
    });
    expect(gateway.doneMutations()).toHaveLength(1);
  });

  test("rejects Done before merge and on stale project state without mutation", async () => {
    const gateway = fake();
    gateway.seedProjectItem(projectItem());
    await expect(
      gateway.moveProjectItemToDone(doneRequest()),
    ).resolves.toMatchObject({
      outcome: "rejected",
      reason: { kind: "merge_not_observed" },
    });
    gateway.setMergedReceipt({
      repository,
      number: 7,
      issueNumber: 42,
      nodeId: "PR_node_7",
      method: "squash",
      baseBranch: "main",
      baseSha,
      headBranch: "ticket/42",
      headSha,
      mergeSha,
    });
    gateway.simulateProjectDrift("PVTI_1");
    await expect(
      gateway.moveProjectItemToDone(doneRequest()),
    ).resolves.toMatchObject({
      outcome: "rejected",
      reason: { kind: "project_revision_mismatch" },
    });
    expect(gateway.doneMutations()).toHaveLength(0);
  });

  test("never exposes provider errors or credentials in boundary failures", async () => {
    const gateway = fake();
    gateway.seedPullRequest(candidate());
    const error = await gateway
      .mergePullRequest({ ...mergeRequest(), repository: "other/repo" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GitHubDeliveryBoundaryError);
    expect(String((error as Error).message)).not.toMatch(
      /secret|token|authorization|ghp_/iu,
    );
  });
});
