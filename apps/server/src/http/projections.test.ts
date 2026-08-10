import { describe, expect, test } from "vitest";

import {
  projectConfiguration,
  projectQueue,
  projectReview,
  projectRunDetail,
} from "./projections.js";

const run = {
  id: "run-1",
  repository: "owner/repo",
  projectItemId: "PVTI_secretish",
  issueNodeId: "I_secretish",
  issueNumber: 42,
  intakeJson: JSON.stringify({ prompt: "do not expose me" }),
  state: "review" as const,
  revision: 4,
  reworkEpoch: 1,
  repairRound: 0,
  ownerToken: "owner-secret",
  ownershipReleasedAt: null,
  stopRequestedAt: null,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  approvedHeadSha: "c".repeat(40),
  observedBaseSha: "d".repeat(40),
  mergeSha: null,
  worktreePath: "/tmp/wheelsparrow/run-1",
  baseBranch: "main",
  branch: "codex/run-1",
  pullRequestNumber: 7,
  pullRequestNodeId: "PR_secretish",
  pullRequestTitle: "Safe change",
  pullRequestUrl: "https://github.com/owner/repo/pull/7",
  requiredAction: "Approve exact head.",
  lastFailureJson: JSON.stringify({ token: "credential" }),
  createdAt: "2026-08-09T08:00:00.000Z",
  updatedAt: "2026-08-09T10:00:00.000Z",
  startedAt: "2026-08-09T08:00:00.000Z",
  handedOffAt: "2026-08-09T10:00:00.000Z",
  terminalAt: null,
};

const scheduler = {
  id: 1 as const,
  revision: 2,
  paused: false,
  stopAfterCurrent: false,
  updatedAt: "2026-08-09T10:00:00.000Z",
};

describe("operator read projections", () => {
  test("projects only safe queue fields", () => {
    const projection = projectQueue({ scheduler, runs: [run] });

    expect(projection.review[0]).toEqual(
      expect.objectContaining({
        run_id: "run-1",
        issue_number: 42,
        state: "review",
      }),
    );
    expect(JSON.stringify(projection)).not.toContain("owner-secret");
    expect(JSON.stringify(projection)).not.toContain("PVTI_secretish");
  });

  test("redacts credential-shaped values in JSON-ish actions", () => {
    const secrets = [
      "SECRET_JSON_TOKEN",
      "SECRET_JSON_CREDENTIAL",
      "SECRET_JSON_SECRET",
      "SECRET_JSON_PASSWORD",
      "SECRET_JSON_BEARER",
      "SECRET_NESTED_TOKEN",
      "SECRET_LABELED_TOKEN",
      "SECRET_BEARER",
      "ghp_123456789012345678901234567890123456",
    ];
    const requiredAction = [
      "Safe fact: deployment is ready.",
      "Keep the token budget at 10.",
      '{"token":"SECRET_JSON_TOKEN","credential":"SECRET_JSON_CREDENTIAL","secret":"SECRET_JSON_SECRET","password":"SECRET_JSON_PASSWORD","authorization":"Bearer SECRET_JSON_BEARER","nested":{"token":"SECRET_NESTED_TOKEN"}}',
      "token: SECRET_LABELED_TOKEN",
      "authorization: Bearer SECRET_BEARER",
      "ghp_123456789012345678901234567890123456",
    ].join(" ");

    const [review] = projectQueue({
      scheduler,
      runs: [{ ...run, requiredAction }],
    }).review;
    if (review === undefined) throw new Error("Expected Review projection.");
    const projected = review.required_action;

    expect(projected).toContain("Safe fact: deployment is ready.");
    expect(projected).toContain("Keep the token budget at 10.");
    for (const secret of secrets) expect(projected).not.toContain(secret);
    expect(projected).toContain("[REDACTED]");
  });

  test("redacts before applying the bounded text limit", () => {
    const requiredAction = `{"token":"SECRET_BOUNDED"} ${"safe ".repeat(2_000)}`;
    const [review] = projectQueue({
      scheduler,
      runs: [{ ...run, requiredAction }],
    }).review;
    if (review === undefined) throw new Error("Expected Review projection.");
    const projected = review.required_action;

    expect(projected).not.toContain("SECRET_BOUNDED");
    expect(projected).toHaveLength(4096);
  });

  test("keeps durable-only ready merging deterministic while preserving discovery order", () => {
    const first = { ...run, id: "durable-2", issueNumber: 20 };
    const second = { ...run, id: "durable-1", issueNumber: 10 };
    const projection = projectQueue({
      scheduler,
      runs: [],
      ready: [first, second],
      discoveredReady: [
        {
          run_id: "priority-1-issue-99",
          issue_number: 99,
          repository: "owner/repo",
          state: "claiming",
          revision: 0,
          rework_epoch: 0,
          repair_round: 0,
          branch: null,
          pull_request_number: null,
          pull_request_title: null,
          pull_request_url: null,
          required_action: null,
          blocked_reason: null,
          updated_at: run.updatedAt,
        },
        {
          run_id: "priority-2-issue-1",
          issue_number: 1,
          repository: "owner/repo",
          state: "claiming",
          revision: 0,
          rework_epoch: 0,
          repair_round: 0,
          branch: null,
          pull_request_number: null,
          pull_request_title: null,
          pull_request_url: null,
          required_action: null,
          blocked_reason: null,
          updated_at: run.updatedAt,
        },
      ],
    });

    expect(projection.ready.map((item) => item.run_id)).toEqual([
      "durable-1",
      "durable-2",
      "priority-1-issue-99",
      "priority-2-issue-1",
    ]);
  });

  test("projects run detail without raw intake, effects, ownership, or logs", () => {
    const projection = projectRunDetail(run, {
      events: [
        {
          id: "event-1",
          runId: run.id,
          sequence: 1,
          runRevision: run.revision,
          kind: "state_changed",
          summary: "token: super-secret",
          detailsJson: JSON.stringify({ receipt: "raw" }),
          logReference: "/tmp/raw.log",
          createdAt: run.updatedAt,
        },
      ],
      steps: [
        {
          id: "step-1",
          runId: run.id,
          reworkEpoch: 1,
          role: "reviewer",
          logicalStep: "review",
          attempt: 1,
          statusSequence: 1,
          status: "confirmed",
          promptHash: "e".repeat(64),
          model: "gpt-5.6",
          reasoningEffort: "xhigh",
          startedAt: run.updatedAt,
          completedAt: run.updatedAt,
          exitResultJson: JSON.stringify({ process_id: 123 }),
          summary: "Safe summary",
          rawLogReference: "/tmp/raw.log",
        },
      ],
      findings: [
        {
          id: "finding-1",
          runId: run.id,
          reworkEpoch: 1,
          reviewStepId: "step-1",
          stableKey: "SEC-1",
          dispositionSequence: 1,
          severity: "high",
          evidence: "password=super-secret",
          disposition: "open",
          resolvingStepId: null,
          createdAt: run.updatedAt,
        },
      ],
      approvals: [
        {
          id: "approval-1",
          runId: run.id,
          operator: "operator",
          approvedHeadSha: run.approvedHeadSha,
          observedBaseSha: run.observedBaseSha,
          decision: "approved",
          invalidationReason: null,
          createdAt: run.updatedAt,
        },
      ],
    });

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("owner-secret");
    expect(serialized).not.toContain("do not expose me");
    expect(serialized).not.toContain("raw");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("process_id");
    expect(projection.run.worktree_path).toBe("/tmp/wheelsparrow/run-1");
    expect(projection.events[0]).not.toHaveProperty("details_json");
    expect(projection.steps[0]).not.toHaveProperty("exit_result_json");
  });

  test("projects review items and explicitly selects safe configuration fields", () => {
    const review = projectReview({
      runs: [run],
      findings: new Map([[run.id, []]]),
      approvals: new Map([[run.id, []]]),
    });
    expect(review.items).toHaveLength(1);
    expect(review.items[0]).not.toHaveProperty("owner_token");

    const configuration = projectConfiguration({
      github: {
        owner: "owner",
        repository: "repo",
        project_number: 1,
        status_field: "Status",
        lanes: { ready: "Ready", todo: "Todo", review: "Review", done: "Done" },
        required_labels: ["agent-ready"],
        priority_field: "Priority",
        token: "credential",
      },
      poll_interval_seconds: 60,
      workspace_root: "/workspace",
      agent: {
        command: "codex",
        model: "gpt-5.6",
        reasoning_effort: "high",
        timeout_minutes: 30,
        token: "credential",
      },
      verification: { command: "pnpm test", secret: "credential" },
      staging: {
        workflow: "deploy.yml",
        environment: "staging",
        smoke_command: "pnpm smoke",
        password: "credential",
      },
    });
    expect(JSON.stringify(configuration)).not.toContain("credential");
    expect(configuration.configuration.github).not.toHaveProperty("token");
  });

  test("includes terminal and handoff runs in the human-attention inbox", () => {
    const stopped = { ...run, id: "stopped", state: "stopped" as const };
    const failed = { ...run, id: "failed", state: "claim_failed" as const };
    const handoff = {
      ...run,
      id: "handoff",
      state: "building" as const,
      requiredAction: "secret=never-show-this",
    };

    const review = projectReview({
      runs: [stopped, failed, handoff],
      findings: new Map(),
      approvals: new Map(),
    });

    expect(review.items.map((item) => item.run_id)).toEqual([
      "failed",
      "handoff",
      "stopped",
    ]);
    expect(
      review.items.find((item) => item.run_id === "failed")?.blocked_reason,
    ).toBe("claim_failed");
    expect(JSON.stringify(review)).not.toContain("never-show-this");
  });
});
