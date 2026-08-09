import type {
  Configuration,
  ConfigurationResponse,
  OperatorApproval,
  OperatorEvent,
  OperatorFinding,
  OperatorQueueRun,
  OperatorReviewItem,
  OperatorRun,
  OperatorRunDetail,
  OperatorScheduler,
  OperatorStep,
  QueueResponse,
  ReviewResponse,
} from "@wheelsparrow/contracts";
import type {
  ApprovalRecord,
  EventRecord,
  FindingRecord,
  RunRecord,
  SchedulerControl,
  StepRecord,
} from "../database/runs.js";

const MAX_TEXT_LENGTH = 4096;
const codingStates = new Set<RunRecord["state"]>([
  "claiming",
  "preparing",
  "rolling_back_claim",
  "intaking",
  "building",
  "verifying",
  "reviewing",
  "repairing",
  "publishing",
  "waiting_for_ci",
  "returning_to_todo",
]);

function text(value: string, fallback = "Unavailable"): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  return (candidate.length > 0 ? candidate : fallback).slice(
    0,
    MAX_TEXT_LENGTH,
  );
}

function nullableText(value: string | null): string | null {
  if (value === null) return null;
  const candidate = value.trim();
  return candidate.length === 0 ? null : candidate.slice(0, MAX_TEXT_LENGTH);
}

function nullableSha(value: string | null): string | null {
  if (value === null) return null;
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value) ? value : null;
}

function nullablePositiveInteger(value: number | null): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value : null;
}

function schedulerProjection(control: SchedulerControl): OperatorScheduler {
  return {
    revision: control.revision,
    paused: control.paused,
    stop_after_current: control.stopAfterCurrent,
    updated_at: text(control.updatedAt),
  };
}

function runProjection(run: RunRecord): OperatorRun {
  return {
    run_id: text(run.id),
    issue_number: run.issueNumber,
    repository: text(run.repository),
    state: run.state,
    revision: run.revision,
    rework_epoch: run.reworkEpoch,
    repair_round: run.repairRound,
    branch: nullableText(run.branch),
    pull_request_number: nullablePositiveInteger(run.pullRequestNumber),
    pull_request_title: nullableText(run.pullRequestTitle),
    pull_request_url: nullableText(run.pullRequestUrl),
    required_action: nullableText(run.requiredAction),
    blocked_reason: null,
    updated_at: text(run.updatedAt),
    base_branch: text(run.baseBranch),
    base_sha: nullableSha(run.baseSha),
    head_sha: nullableSha(run.headSha),
    observed_base_sha: nullableSha(run.observedBaseSha),
    merge_sha: nullableSha(run.mergeSha),
    worktree_path: nullableText(run.worktreePath),
    stop_requested_at: nullableText(run.stopRequestedAt),
    started_at: nullableText(run.startedAt),
    handed_off_at: nullableText(run.handedOffAt),
    terminal_at: nullableText(run.terminalAt),
  };
}

function queueProjection(
  run: RunRecord,
  blockedReason: string | null = null,
): OperatorQueueRun {
  const projected = runProjection(run);
  return {
    run_id: projected.run_id,
    issue_number: projected.issue_number,
    repository: projected.repository,
    state: projected.state,
    revision: projected.revision,
    rework_epoch: projected.rework_epoch,
    repair_round: projected.repair_round,
    branch: projected.branch,
    pull_request_number: projected.pull_request_number,
    pull_request_title: projected.pull_request_title,
    pull_request_url: projected.pull_request_url,
    required_action: projected.required_action,
    blocked_reason: nullableText(blockedReason),
    updated_at: projected.updated_at,
  };
}

function byIssueNumber(left: RunRecord, right: RunRecord): number {
  return (
    left.issueNumber - right.issueNumber || left.id.localeCompare(right.id)
  );
}

export interface QueueProjectionInput {
  scheduler: SchedulerControl;
  runs: readonly RunRecord[];
  /** Optional externally-discovered Ready items, already reduced to RunRecord shape. */
  ready?: readonly RunRecord[];
}

export function projectQueue(input: QueueProjectionInput): QueueResponse {
  const sorted = [...input.runs].sort(byIssueNumber);
  const active = sorted.find((run) => codingStates.has(run.state));
  const reviews = sorted.filter((run) => run.state === "review");
  return {
    schema_version: 1,
    scheduler: schedulerProjection(input.scheduler),
    active_todo: active === undefined ? null : queueProjection(active),
    ready: [...(input.ready ?? [])]
      .sort(byIssueNumber)
      .map((run) => queueProjection(run)),
    review: reviews.map((run) => queueProjection(run)),
    review_count: reviews.length,
  };
}

function eventProjection(event: EventRecord): OperatorEvent {
  return {
    id: text(event.id),
    sequence: event.sequence,
    run_revision: event.runRevision,
    kind: text(event.kind),
    summary: text(event.summary),
    created_at: text(event.createdAt),
  };
}

function stepProjection(step: StepRecord): OperatorStep {
  return {
    id: text(step.id),
    rework_epoch: step.reworkEpoch,
    role: text(step.role),
    logical_step: text(step.logicalStep),
    attempt: step.attempt,
    status_sequence: step.statusSequence,
    status: text(step.status),
    model: text(step.model),
    reasoning_effort: text(step.reasoningEffort),
    started_at: text(step.startedAt),
    completed_at: nullableText(step.completedAt),
    summary: nullableText(step.summary),
  };
}

function findingProjection(finding: FindingRecord): OperatorFinding {
  return {
    id: text(finding.id),
    rework_epoch: finding.reworkEpoch,
    review_step_id: text(finding.reviewStepId),
    stable_key: text(finding.stableKey),
    disposition_sequence: finding.dispositionSequence,
    severity: text(finding.severity),
    evidence: text(finding.evidence),
    disposition: text(finding.disposition),
    resolving_step_id: nullableText(finding.resolvingStepId),
    created_at: text(finding.createdAt),
  };
}

function approvalProjection(approval: ApprovalRecord): OperatorApproval {
  return {
    id: text(approval.id),
    operator: text(approval.operator),
    approved_head_sha: approval.approvedHeadSha,
    observed_base_sha: approval.observedBaseSha,
    decision: text(approval.decision),
    invalidation_reason: nullableText(approval.invalidationReason),
    created_at: text(approval.createdAt),
  };
}

export interface RunDetailProjectionRecords {
  events?: readonly EventRecord[];
  steps?: readonly StepRecord[];
  findings?: readonly FindingRecord[];
  approvals?: readonly ApprovalRecord[];
}

export function projectRunDetail(
  run: RunRecord,
  records: RunDetailProjectionRecords = {},
): OperatorRunDetail {
  return {
    schema_version: 1,
    run: runProjection(run),
    steps: (records.steps ?? []).map(stepProjection),
    findings: (records.findings ?? []).map(findingProjection),
    approvals: (records.approvals ?? []).map(approvalProjection),
    events: (records.events ?? []).map(eventProjection),
  };
}

export interface ReviewProjectionInput {
  runs: readonly RunRecord[];
  findings?: ReadonlyMap<string, readonly FindingRecord[]>;
  approvals?: ReadonlyMap<string, readonly ApprovalRecord[]>;
}

export function projectReview(input: ReviewProjectionInput): ReviewResponse {
  const items: OperatorReviewItem[] = [...input.runs]
    .filter((run) => run.state === "review")
    .sort(byIssueNumber)
    .map((run) => {
      const approvals = input.approvals?.get(run.id) ?? [];
      const latestApproval = approvals.at(-1);
      return {
        ...queueProjection(run),
        findings: (input.findings?.get(run.id) ?? []).map(findingProjection),
        approval:
          latestApproval === undefined
            ? null
            : approvalProjection(latestApproval),
      };
    });
  return { schema_version: 1, items };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function requiredRecord(value: unknown, key: string): Record<string, unknown> {
  const candidate = record(record(value)[key]);
  if (Object.keys(candidate).length === 0)
    throw new TypeError(`Configuration ${key} is missing.`);
  return candidate;
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`Configuration ${key} is missing.`);
  return value;
}

/** Select the validated effective configuration; unknown/credential-shaped keys are discarded. */
export function projectConfiguration(config: unknown): ConfigurationResponse {
  const source = record(config);
  const github = requiredRecord(source, "github");
  const lanes = requiredRecord(github, "lanes");
  const agent = requiredRecord(source, "agent");
  const verification = requiredRecord(source, "verification");
  const staging = requiredRecord(source, "staging");
  const configuration: Configuration = {
    github: {
      owner: requiredString(github.owner, "github.owner"),
      repository: requiredString(github.repository, "github.repository"),
      project_number: github.project_number as number,
      status_field: requiredString(github.status_field, "github.status_field"),
      lanes: {
        ready: requiredString(lanes.ready, "github.lanes.ready"),
        todo: requiredString(lanes.todo, "github.lanes.todo"),
        review: requiredString(lanes.review, "github.lanes.review"),
        done: requiredString(lanes.done, "github.lanes.done"),
      },
      required_labels: Array.isArray(github.required_labels)
        ? github.required_labels.filter(
            (label): label is string => typeof label === "string",
          )
        : [],
      priority_field: requiredString(
        github.priority_field,
        "github.priority_field",
      ),
    },
    poll_interval_seconds: source.poll_interval_seconds as number,
    workspace_root: requiredString(source.workspace_root, "workspace_root"),
    agent: {
      command: requiredString(agent.command, "agent.command"),
      model: requiredString(agent.model, "agent.model"),
      reasoning_effort:
        agent.reasoning_effort as Configuration["agent"]["reasoning_effort"],
      timeout_minutes: agent.timeout_minutes as number,
    },
    verification: {
      command: requiredString(verification.command, "verification.command"),
    },
    staging: {
      workflow: requiredString(staging.workflow, "staging.workflow"),
      environment: requiredString(staging.environment, "staging.environment"),
      smoke_command: requiredString(
        staging.smoke_command,
        "staging.smoke_command",
      ),
    },
  };
  return { schema_version: 1, configuration };
}
