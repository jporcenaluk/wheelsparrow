import { Refine, type Static, Type } from "typebox";

const Identifier = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "\\S",
});
const Text = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: "\\S",
});
const NullableText = Type.Union([Text, Type.Null()]);
const NullableSha = Type.Union([
  Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }),
  Type.Null(),
]);
const NullablePositiveInteger = Type.Union([
  Type.Integer({ minimum: 1 }),
  Type.Null(),
]);
const NonNegativeInteger = Type.Integer({ minimum: 0 });
const SchemaVersion = Type.Literal(1);

export const OperatorRunStateSchema = Type.Union([
  Type.Literal("claiming"),
  Type.Literal("preparing"),
  Type.Literal("rolling_back_claim"),
  Type.Literal("claim_failed"),
  Type.Literal("intaking"),
  Type.Literal("building"),
  Type.Literal("verifying"),
  Type.Literal("reviewing"),
  Type.Literal("repairing"),
  Type.Literal("publishing"),
  Type.Literal("waiting_for_ci"),
  Type.Literal("review"),
  Type.Literal("queued_rework"),
  Type.Literal("returning_to_todo"),
  Type.Literal("merging"),
  Type.Literal("waiting_for_staging"),
  Type.Literal("smoking"),
  Type.Literal("completing"),
  Type.Literal("done"),
  Type.Literal("stopped"),
]);

export const OperatorSchedulerSchema = Type.Object(
  {
    revision: NonNegativeInteger,
    paused: Type.Boolean(),
    stop_after_current: Type.Boolean(),
    updated_at: Text,
  },
  { additionalProperties: false },
);

export type OperatorScheduler = Static<typeof OperatorSchedulerSchema>;

export const OperatorQueueRunSchema = Type.Object(
  {
    run_id: Identifier,
    issue_number: Type.Integer({ minimum: 1 }),
    repository: Identifier,
    state: OperatorRunStateSchema,
    revision: NonNegativeInteger,
    rework_epoch: NonNegativeInteger,
    repair_round: NonNegativeInteger,
    branch: NullableText,
    pull_request_number: NullablePositiveInteger,
    pull_request_title: NullableText,
    pull_request_url: NullableText,
    required_action: NullableText,
    blocked_reason: NullableText,
    updated_at: Text,
  },
  { additionalProperties: false },
);

export type OperatorQueueRun = Static<typeof OperatorQueueRunSchema>;
export const QueueItemSchema = OperatorQueueRunSchema;
export type QueueItem = OperatorQueueRun;

export const QueueResponseSchema = Type.Object(
  {
    schema_version: SchemaVersion,
    scheduler: OperatorSchedulerSchema,
    active_todo: Type.Union([OperatorQueueRunSchema, Type.Null()]),
    ready: Type.Array(OperatorQueueRunSchema),
    review: Type.Array(OperatorQueueRunSchema),
    review_count: NonNegativeInteger,
  },
  { additionalProperties: false },
);

export type QueueResponse = Static<typeof QueueResponseSchema>;
export const QueueSnapshotSchema = QueueResponseSchema;
export type QueueSnapshot = QueueResponse;

export const OperatorStepSchema = Type.Object(
  {
    id: Identifier,
    rework_epoch: NonNegativeInteger,
    role: Identifier,
    logical_step: Identifier,
    attempt: Type.Integer({ minimum: 1 }),
    status_sequence: Type.Integer({ minimum: 1 }),
    status: Identifier,
    model: Identifier,
    reasoning_effort: Identifier,
    started_at: Text,
    completed_at: NullableText,
    summary: NullableText,
  },
  { additionalProperties: false },
);

export type OperatorStep = Static<typeof OperatorStepSchema>;

export const OperatorFindingSchema = Type.Object(
  {
    id: Identifier,
    rework_epoch: NonNegativeInteger,
    review_step_id: Identifier,
    stable_key: Identifier,
    disposition_sequence: Type.Integer({ minimum: 1 }),
    severity: Identifier,
    evidence: Text,
    disposition: Identifier,
    resolving_step_id: NullableText,
    created_at: Text,
  },
  { additionalProperties: false },
);

export type OperatorFinding = Static<typeof OperatorFindingSchema>;

export const OperatorApprovalSchema = Type.Object(
  {
    id: Identifier,
    operator: Identifier,
    approved_head_sha: Type.String({
      pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
    }),
    observed_base_sha: Type.String({
      pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
    }),
    decision: Identifier,
    invalidation_reason: NullableText,
    created_at: Text,
  },
  { additionalProperties: false },
);

export type OperatorApproval = Static<typeof OperatorApprovalSchema>;

export const OperatorEventSchema = Type.Object(
  {
    id: Identifier,
    sequence: Type.Integer({ minimum: 1 }),
    run_revision: NonNegativeInteger,
    kind: Identifier,
    summary: Text,
    created_at: Text,
  },
  { additionalProperties: false },
);

export type OperatorEvent = Static<typeof OperatorEventSchema>;
export const EventSchema = OperatorEventSchema;
export type Event = OperatorEvent;

export const OperatorRunSchema = Type.Object(
  {
    run_id: Identifier,
    issue_number: Type.Integer({ minimum: 1 }),
    repository: Identifier,
    state: OperatorRunStateSchema,
    revision: NonNegativeInteger,
    rework_epoch: NonNegativeInteger,
    repair_round: NonNegativeInteger,
    branch: NullableText,
    pull_request_number: NullablePositiveInteger,
    pull_request_title: NullableText,
    pull_request_url: NullableText,
    required_action: NullableText,
    blocked_reason: NullableText,
    updated_at: Text,
    base_branch: Identifier,
    base_sha: NullableSha,
    head_sha: NullableSha,
    observed_base_sha: NullableSha,
    merge_sha: NullableSha,
    worktree_path: NullableText,
    stop_requested_at: NullableText,
    started_at: NullableText,
    handed_off_at: NullableText,
    terminal_at: NullableText,
  },
  { additionalProperties: false },
);

export type OperatorRun = Static<typeof OperatorRunSchema>;

export const OperatorRunDetailSchema = Type.Object(
  {
    schema_version: SchemaVersion,
    run: OperatorRunSchema,
    steps: Type.Array(OperatorStepSchema),
    findings: Type.Array(OperatorFindingSchema),
    approvals: Type.Array(OperatorApprovalSchema),
    events: Type.Array(OperatorEventSchema),
  },
  { additionalProperties: false },
);

export type OperatorRunDetail = Static<typeof OperatorRunDetailSchema>;
export const RunDetailResponseSchema = OperatorRunDetailSchema;
export type RunDetailResponse = OperatorRunDetail;

export const OperatorReviewItemSchema = Type.Object(
  {
    ...OperatorQueueRunSchema.properties,
    findings: Type.Array(OperatorFindingSchema),
    approval: Type.Union([OperatorApprovalSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export type OperatorReviewItem = Static<typeof OperatorReviewItemSchema>;

export const ReviewResponseSchema = Type.Object(
  {
    schema_version: SchemaVersion,
    items: Type.Array(OperatorReviewItemSchema),
  },
  { additionalProperties: false },
);

export type ReviewResponse = Static<typeof ReviewResponseSchema>;
export const ReviewInboxSchema = ReviewResponseSchema;
export type ReviewInbox = ReviewResponse;

export const ConfigurationResponseSchema = Type.Object(
  {
    schema_version: SchemaVersion,
    configuration: Type.Object(
      {
        github: Type.Object(
          {
            owner: Text,
            repository: Text,
            project_number: Type.Integer({ minimum: 1 }),
            status_field: Text,
            lanes: Type.Object(
              {
                ready: Text,
                todo: Text,
                review: Text,
                done: Text,
              },
              { additionalProperties: false },
            ),
            required_labels: Type.Array(Text, {
              minItems: 1,
              uniqueItems: true,
            }),
            priority_field: Text,
          },
          { additionalProperties: false },
        ),
        poll_interval_seconds: Type.Integer({ minimum: 5, maximum: 3600 }),
        workspace_root: Text,
        agent: Type.Object(
          {
            command: Text,
            model: Text,
            reasoning_effort: Type.Union([
              Type.Literal("low"),
              Type.Literal("medium"),
              Type.Literal("high"),
              Type.Literal("xhigh"),
              Type.Literal("max"),
            ]),
            timeout_minutes: Type.Integer({ minimum: 1, maximum: 240 }),
          },
          { additionalProperties: false },
        ),
        verification: Type.Object(
          { command: Text },
          { additionalProperties: false },
        ),
        staging: Type.Object(
          {
            workflow: Text,
            environment: Text,
            smoke_command: Text,
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ConfigurationResponse = Static<typeof ConfigurationResponseSchema>;
export const ConfigurationSnapshotSchema = ConfigurationResponseSchema;
export type ConfigurationSnapshot = ConfigurationResponse;

export const SchedulerControlResponseSchema = Type.Object(
  { schema_version: SchemaVersion, scheduler: OperatorSchedulerSchema },
  { additionalProperties: false },
);
export type SchedulerControlResponse = Static<
  typeof SchedulerControlResponseSchema
>;

export const SchedulerControlPatchSchema = Refine(
  Type.Object(
    {
      schema_version: SchemaVersion,
      expected_revision: NonNegativeInteger,
      paused: Type.Optional(Type.Boolean()),
      stop_after_current: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  (value) =>
    value.paused !== undefined || value.stop_after_current !== undefined,
  () => "at least one scheduler control must be supplied",
);

export type SchedulerControlPatch = Static<typeof SchedulerControlPatchSchema>;
export const SchedulerControlRequestSchema = SchedulerControlPatchSchema;
export type SchedulerControlRequest = SchedulerControlPatch;

export const ReturnToTodoRequestSchema = Type.Object(
  {
    schema_version: SchemaVersion,
    expected_revision: NonNegativeInteger,
    feedback: Text,
  },
  { additionalProperties: false },
);
export type ReturnToTodoRequest = Static<typeof ReturnToTodoRequestSchema>;

/** The command returns the same redacted snapshot as a run-detail read. */
export const ReturnToTodoResponseSchema = OperatorRunDetailSchema;
export type ReturnToTodoResponse = Static<typeof ReturnToTodoResponseSchema>;

export const OperatorSessionResponseSchema = Type.Object(
  { schema_version: SchemaVersion, csrf_token: Text },
  { additionalProperties: false },
);
export type OperatorSessionResponse = Static<
  typeof OperatorSessionResponseSchema
>;

export const OperatorErrorResponseSchema = Type.Object(
  {
    schema_version: SchemaVersion,
    error: Type.Object(
      { code: Identifier, message: Text },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type OperatorErrorResponse = Static<typeof OperatorErrorResponseSchema>;

export const SseNotificationSchema = Type.Object(
  { schema_version: SchemaVersion, kind: Type.Literal("snapshot_changed") },
  { additionalProperties: false },
);
export type SseNotification = Static<typeof SseNotificationSchema>;
