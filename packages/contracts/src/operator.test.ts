import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";

import {
  ApproveMergeRequestSchema,
  ApproveMergeResponseSchema,
  ConfigurationResponseSchema,
  OperatorEventSchema,
  OperatorFindingSchema,
  OperatorMergeEffectSchema,
  OperatorMergeIntentSchema,
  OperatorRunDetailSchema,
  OperatorStepSchema,
  QueueResponseSchema,
  ReviewResponseSchema,
  SchedulerControlPatchSchema,
  SchedulerControlResponseSchema,
  SseNotificationSchema,
} from "./operator.js";

const queueRun = {
  run_id: "run-1",
  issue_number: 42,
  repository: "owner/repo",
  state: "review",
  revision: 4,
  rework_epoch: 1,
  repair_round: 0,
  branch: "codex/run-1",
  pull_request_number: 7,
  pull_request_title: "Safe change",
  pull_request_url: "https://github.com/owner/repo/pull/7",
  required_action: "Approve the exact head after review.",
  blocked_reason: null,
  updated_at: "2026-08-09T10:00:00.000Z",
};

const scheduler = {
  revision: 2,
  paused: false,
  stop_after_current: false,
  updated_at: "2026-08-09T10:00:00.000Z",
};

describe("operator contracts", () => {
  test("accepts exact-SHA merge approval and redacted effect summaries", () => {
    expect(
      Value.Check(ApproveMergeRequestSchema, {
        schema_version: 1,
        expected_run_revision: 4,
        approved_head_sha: "b".repeat(40),
        approved_base_sha: "a".repeat(40),
      }),
    ).toBe(true);
    expect(
      Value.Check(OperatorMergeIntentSchema, {
        repository: "owner/repo",
        pull_request_number: 7,
        pull_request_url: "https://github.com/owner/repo/pull/7",
        branch: "codex/run-1",
        base_sha: "a".repeat(40),
        head_sha: "b".repeat(40),
      }),
    ).toBe(true);
    expect(
      Value.Check(OperatorMergeEffectSchema, {
        key: "run:run-1:rework:0:merge",
        kind: "merge",
        target_revision: 5,
        status: "pending",
      }),
    ).toBe(true);
    expect(
      Value.Check(ApproveMergeRequestSchema, {
        schema_version: 1,
        expected_run_revision: 4,
        approved_head_sha: "not-a-sha",
        approved_base_sha: "a".repeat(40),
      }),
    ).toBe(false);
    expect(
      Value.Check(ApproveMergeResponseSchema, {
        schema_version: 1,
        run: {
          ...queueRun,
          state: "merging",
          revision: 5,
          base_branch: "main",
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          observed_base_sha: "a".repeat(40),
          merge_sha: null,
          worktree_path: null,
          stop_requested_at: null,
          started_at: null,
          handed_off_at: null,
          terminal_at: null,
        },
        approval: {
          id: "approval-1",
          operator: "operator",
          approved_head_sha: "b".repeat(40),
          observed_base_sha: "a".repeat(40),
          decision: "approved",
          invalidation_reason: null,
          created_at: "2026-08-09T10:00:00.000Z",
        },
        effect: {
          key: "run:run-1:rework:0:merge",
          kind: "merge",
          target_revision: 5,
          status: "pending",
        },
        merge_intent: {
          repository: "owner/repo",
          pull_request_number: 7,
          pull_request_url: "https://github.com/owner/repo/pull/7",
          branch: "codex/run-1",
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
        },
      }),
    ).toBe(true);
  });

  test("accepts a versioned redacted queue snapshot", () => {
    expect(
      Value.Check(QueueResponseSchema, {
        schema_version: 1,
        scheduler,
        active_todo: null,
        ready: [],
        review: [queueRun],
        review_count: 1,
      }),
    ).toBe(true);
  });

  test("rejects queue snapshots containing ownership or effect internals", () => {
    expect(
      Value.Check(QueueResponseSchema, {
        schema_version: 1,
        scheduler,
        active_todo: null,
        ready: [{ ...queueRun, owner_token: "secret" }],
        review: [],
        review_count: 0,
      }),
    ).toBe(false);
  });

  test("accepts redacted run detail records and rejects raw fields", () => {
    const event = {
      id: "event-1",
      sequence: 1,
      run_revision: 4,
      kind: "review_approved",
      summary: "Reviewer approved the change.",
      created_at: "2026-08-09T10:00:00.000Z",
    };
    const step = {
      id: "step-1",
      rework_epoch: 1,
      role: "reviewer",
      logical_step: "review",
      attempt: 1,
      status_sequence: 1,
      status: "confirmed",
      model: "gpt-5.6",
      reasoning_effort: "xhigh",
      started_at: "2026-08-09T09:00:00.000Z",
      completed_at: "2026-08-09T09:01:00.000Z",
      summary: "No actionable findings.",
    };
    const finding = {
      id: "finding-1",
      rework_epoch: 1,
      review_step_id: "step-1",
      stable_key: "SEC-001",
      disposition_sequence: 1,
      severity: "high",
      evidence: "The boundary rejects malformed input.",
      disposition: "accepted",
      resolving_step_id: null,
      created_at: "2026-08-09T09:01:00.000Z",
    };
    const detail = {
      schema_version: 1,
      run: {
        ...queueRun,
        base_branch: "main",
        base_sha: "a".repeat(40),
        head_sha: "b".repeat(40),
        observed_base_sha: null,
        merge_sha: null,
        worktree_path: "/tmp/wheelsparrow/run-1",
        stop_requested_at: null,
        started_at: "2026-08-09T08:00:00.000Z",
        handed_off_at: "2026-08-09T10:00:00.000Z",
        terminal_at: null,
      },
      steps: [step],
      findings: [finding],
      approvals: [],
      events: [event],
    };

    expect(Value.Check(OperatorRunDetailSchema, detail)).toBe(true);
    expect(
      Value.Check(OperatorRunDetailSchema, {
        ...detail,
        run: { ...detail.run, owner_token: "secret" },
      }),
    ).toBe(false);
    expect(
      Value.Check(OperatorRunDetailSchema, {
        ...detail,
        steps: [{ ...step, exit_result_json: "raw receipt" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(OperatorRunDetailSchema, {
        ...detail,
        events: [{ ...event, details_json: "raw effect" }],
      }),
    ).toBe(false);
  });

  test("accepts review, configuration, scheduler, and notification contracts", () => {
    expect(
      Value.Check(ReviewResponseSchema, {
        schema_version: 1,
        items: [
          {
            ...queueRun,
            findings: [],
            approval: null,
          },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(ConfigurationResponseSchema, {
        schema_version: 1,
        configuration: {
          github: {
            owner: "owner",
            repository: "repo",
            project_number: 1,
            status_field: "Status",
            lanes: {
              ready: "Ready",
              todo: "Todo",
              review: "Review",
              done: "Done",
            },
            required_labels: ["agent-ready"],
            priority_field: "Priority",
          },
          poll_interval_seconds: 60,
          workspace_root: "/workspace",
          agent: {
            command: "codex",
            model: "gpt-5.6",
            reasoning_effort: "xhigh",
            timeout_minutes: 30,
          },
          verification: { command: "pnpm test" },
          staging: {
            workflow: "deploy.yml",
            environment: "staging",
            smoke_command: "pnpm smoke",
          },
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(SchedulerControlResponseSchema, {
        schema_version: 1,
        scheduler,
      }),
    ).toBe(true);
    expect(
      Value.Check(SchedulerControlPatchSchema, {
        schema_version: 1,
        expected_revision: 2,
        paused: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(SseNotificationSchema, {
        schema_version: 1,
        kind: "snapshot_changed",
      }),
    ).toBe(true);
  });

  test("requires an explicit scheduler control patch", () => {
    expect(
      Value.Check(SchedulerControlPatchSchema, {
        schema_version: 1,
        expected_revision: 2,
      }),
    ).toBe(false);
    expect(
      Value.Check(SchedulerControlPatchSchema, {
        schema_version: 1,
        expected_revision: 2,
        paused: true,
        secret: "x",
      }),
    ).toBe(false);
  });

  test("keeps the focused schemas independently available", () => {
    expect(
      Value.Check(OperatorEventSchema, {
        id: "event-1",
        sequence: 1,
        run_revision: 1,
        kind: "state_changed",
        summary: "State changed.",
        created_at: "2026-08-09T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      Value.Check(OperatorStepSchema, {
        id: "step-1",
        rework_epoch: 0,
        role: "builder",
        logical_step: "build",
        attempt: 1,
        status_sequence: 1,
        status: "confirmed",
        model: "gpt-5.6",
        reasoning_effort: "high",
        started_at: "2026-08-09T10:00:00.000Z",
        completed_at: null,
        summary: null,
      }),
    ).toBe(true);
    expect(
      Value.Check(OperatorFindingSchema, {
        id: "finding-1",
        rework_epoch: 0,
        review_step_id: "step-1",
        stable_key: "SEC-001",
        disposition_sequence: 1,
        severity: "low",
        evidence: "bounded",
        disposition: "open",
        resolving_step_id: null,
        created_at: "2026-08-09T10:00:00.000Z",
      }),
    ).toBe(true);
  });
});
