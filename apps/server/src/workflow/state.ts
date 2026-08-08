/** The complete persisted run-state vocabulary. */
export const RUN_STATES = [
  "claiming",
  "preparing",
  "rolling_back_claim",
  "claim_failed",
  "intaking",
  "building",
  "verifying",
  "reviewing",
  "repairing",
  "publishing",
  "waiting_for_ci",
  "review",
  "queued_rework",
  "returning_to_todo",
  "merging",
  "waiting_for_staging",
  "smoking",
  "completing",
  "done",
  "stopped",
] as const;

export type RunState = (typeof RUN_STATES)[number];

/** Compatibility name for consumers that refer to the domain as WorkflowState. */
export type WorkflowState = RunState;

export const CODING_STATES = [
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
] as const satisfies readonly RunState[];

export type CodingState = (typeof CODING_STATES)[number];

export const TERMINAL_STATES = [
  "claim_failed",
  "done",
  "stopped",
] as const satisfies readonly RunState[];

/** Statuses in the durable external-effect lifecycle. */
export const EFFECT_STATUSES = [
  "pending",
  "in_flight",
  "ambiguous",
  "confirmed",
  "failed",
  "cancelled",
] as const;

export type EffectStatus = (typeof EFFECT_STATUSES)[number];

export const EFFECT_KINDS = [
  "project_todo",
  "project_ready",
  "workspace_prepare",
  "intake_capture",
  "agent_build",
  "verify",
  "agent_review",
  "agent_repair",
  "publish",
  "observe_ci",
  "project_review",
  "project_return_todo",
  "merge",
  "observe_staging",
  "smoke",
  "project_done",
] as const;

export type EffectKind = (typeof EFFECT_KINDS)[number];

export const WORKFLOW_TRIGGERS = [
  "todo_observed",
  "claim_rejected",
  "startup_failed",
  "rollback_ready_observed",
  "workspace_prepared",
  "intake_captured",
  "builder_succeeded",
  "builder_exhausted",
  "verification_passed",
  "verification_failed_repairable",
  "verification_failed_exhausted",
  "review_approved",
  "review_needs_repair",
  "repair_succeeded",
  "pr_observed",
  "ci_passed",
  "ci_failed_repairable",
  "ci_failed_exhausted",
  "return_todo_queued",
  "return_todo_reserved",
  "merge_authorized",
  "staging_retry_authorized",
  "reconciled_merge",
  "reconciled_staging",
  "reconciled_smoke",
  "reconciled_done",
  "coding_slot_available",
  "todo_move_rejected",
  "merge_observed",
  "delivery_failed",
  "staging_succeeded",
  "smoke_succeeded",
  "smoke_failed",
  "done_observed",
  "done_projection_failed",
  "handoff_required",
  "stop_safe",
] as const;

export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];

const EFFECT_KIND_SET = new Set<string>(EFFECT_KINDS);
const EFFECT_STATUS_SET = new Set<string>(EFFECT_STATUSES);
const WORKFLOW_TRIGGER_SET = new Set<string>(WORKFLOW_TRIGGERS);

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.hasOwn(object, key);
}

function isEffectKind(value: unknown): value is EffectKind {
  return typeof value === "string" && EFFECT_KIND_SET.has(value);
}

function isEffectStatus(value: unknown): value is EffectStatus {
  return typeof value === "string" && EFFECT_STATUS_SET.has(value);
}

function isWorkflowTrigger(value: unknown): value is WorkflowTrigger {
  return typeof value === "string" && WORKFLOW_TRIGGER_SET.has(value);
}

type TransitionTable = Readonly<
  Partial<
    Record<RunState, Readonly<Partial<Record<WorkflowTrigger, RunState>>>>
  >
>;

const TRANSITIONS: TransitionTable = {
  claiming: {
    todo_observed: "preparing",
    claim_rejected: "claim_failed",
    startup_failed: "rolling_back_claim",
    handoff_required: "review",
    stop_safe: "stopped",
  },
  preparing: {
    workspace_prepared: "intaking",
    startup_failed: "rolling_back_claim",
    handoff_required: "review",
    stop_safe: "stopped",
  },
  rolling_back_claim: {
    rollback_ready_observed: "claim_failed",
    handoff_required: "review",
    stop_safe: "stopped",
  },
  intaking: {
    intake_captured: "building",
    handoff_required: "review",
    stop_safe: "stopped",
  },
  building: {
    builder_succeeded: "verifying",
    builder_exhausted: "review",
    handoff_required: "review",
    stop_safe: "stopped",
  },
  verifying: {
    verification_passed: "reviewing",
    verification_failed_repairable: "repairing",
    verification_failed_exhausted: "review",
    handoff_required: "review",
    stop_safe: "stopped",
  },
  reviewing: {
    review_approved: "publishing",
    review_needs_repair: "repairing",
    handoff_required: "review",
    stop_safe: "stopped",
  },
  repairing: {
    repair_succeeded: "verifying",
    handoff_required: "review",
    stop_safe: "stopped",
  },
  publishing: {
    pr_observed: "waiting_for_ci",
    handoff_required: "review",
    stop_safe: "stopped",
  },
  waiting_for_ci: {
    ci_passed: "review",
    ci_failed_repairable: "repairing",
    ci_failed_exhausted: "review",
    handoff_required: "review",
    stop_safe: "stopped",
  },
  review: {
    return_todo_queued: "queued_rework",
    return_todo_reserved: "returning_to_todo",
    merge_authorized: "merging",
    staging_retry_authorized: "waiting_for_staging",
    reconciled_merge: "waiting_for_staging",
    reconciled_staging: "smoking",
    reconciled_smoke: "completing",
    reconciled_done: "done",
    stop_safe: "stopped",
  },
  queued_rework: {
    coding_slot_available: "returning_to_todo",
    stop_safe: "stopped",
  },
  returning_to_todo: {
    todo_observed: "repairing",
    todo_move_rejected: "review",
    handoff_required: "review",
    stop_safe: "stopped",
  },
  merging: {
    merge_observed: "waiting_for_staging",
    reconciled_merge: "waiting_for_staging",
    delivery_failed: "review",
    stop_safe: "stopped",
  },
  waiting_for_staging: {
    staging_succeeded: "smoking",
    reconciled_staging: "smoking",
    delivery_failed: "review",
    stop_safe: "stopped",
  },
  smoking: {
    smoke_succeeded: "completing",
    reconciled_smoke: "completing",
    smoke_failed: "review",
    delivery_failed: "review",
    stop_safe: "stopped",
  },
  completing: {
    done_observed: "done",
    reconciled_done: "done",
    done_projection_failed: "review",
    delivery_failed: "review",
    stop_safe: "stopped",
  },
};

const EFFECT_TRANSITIONS: Readonly<
  Record<EffectStatus, readonly EffectStatus[]>
> = {
  pending: ["in_flight", "failed", "cancelled"],
  in_flight: ["confirmed", "failed", "ambiguous"],
  ambiguous: ["confirmed", "failed"],
  confirmed: [],
  failed: [],
  cancelled: [],
};

type ObservableStatus = "confirmed" | "failed";
type ObservationTrigger = WorkflowTrigger | null;

const OBSERVATION_TRIGGERS: Readonly<
  Record<
    EffectKind,
    Readonly<Record<ObservableStatus, readonly ObservationTrigger[]>>
  >
> = {
  project_todo: { confirmed: ["todo_observed"], failed: ["claim_rejected"] },
  project_ready: {
    confirmed: ["rollback_ready_observed"],
    failed: ["handoff_required"],
  },
  workspace_prepare: {
    confirmed: ["workspace_prepared"],
    failed: ["startup_failed"],
  },
  intake_capture: {
    confirmed: ["intake_captured"],
    failed: ["handoff_required"],
  },
  agent_build: {
    confirmed: ["builder_succeeded"],
    failed: ["builder_exhausted", "handoff_required"],
  },
  verify: {
    confirmed: ["verification_passed"],
    failed: [
      "verification_failed_repairable",
      "verification_failed_exhausted",
      "handoff_required",
    ],
  },
  agent_review: {
    confirmed: ["review_approved"],
    failed: ["review_needs_repair", "handoff_required"],
  },
  agent_repair: {
    confirmed: ["repair_succeeded"],
    failed: ["handoff_required"],
  },
  publish: { confirmed: ["pr_observed"], failed: ["handoff_required"] },
  observe_ci: {
    confirmed: ["ci_passed"],
    failed: ["ci_failed_repairable", "ci_failed_exhausted", "handoff_required"],
  },
  project_review: { confirmed: [null], failed: [null] },
  project_return_todo: {
    confirmed: ["todo_observed"],
    failed: ["todo_move_rejected"],
  },
  merge: {
    confirmed: ["merge_observed", "reconciled_merge"],
    failed: ["delivery_failed"],
  },
  observe_staging: {
    confirmed: ["staging_succeeded", "reconciled_staging"],
    failed: ["delivery_failed"],
  },
  smoke: {
    confirmed: ["smoke_succeeded", "reconciled_smoke"],
    failed: ["smoke_failed", "delivery_failed"],
  },
  project_done: {
    confirmed: ["done_observed", "reconciled_done"],
    failed: ["done_projection_failed", "delivery_failed"],
  },
};

/** A typed failure for any state, effect, or observation transition not in the domain tables. */
export class InvalidTransitionError extends Error {
  readonly from: string;
  readonly trigger: string;

  constructor(from: string, trigger: string | null) {
    super(
      `Invalid workflow transition from ${from} on ${trigger ?? "no trigger"}`,
    );
    this.name = "InvalidTransitionError";
    this.from = from;
    this.trigger = trigger ?? "none";
  }
}

export function canTransition(
  from: RunState,
  trigger: WorkflowTrigger,
): RunState | false {
  if (!hasOwn(TRANSITIONS, from)) return false;
  const transitions = TRANSITIONS[from];
  if (transitions === undefined || !hasOwn(transitions, trigger)) return false;
  return transitions[trigger] ?? false;
}

export function nextState(from: RunState, trigger: WorkflowTrigger): RunState {
  const next = canTransition(from, trigger);
  if (next === false) throw new InvalidTransitionError(from, trigger);
  return next;
}

export function isCodingState(state: RunState): state is CodingState {
  return (CODING_STATES as readonly RunState[]).includes(state);
}

export function isTerminalState(state: RunState): boolean {
  return (TERMINAL_STATES as readonly RunState[]).includes(state);
}

export function consumesCodingSlot(state: RunState): boolean {
  return isCodingState(state);
}

export function assertEffectTransition(
  from: EffectStatus,
  to: EffectStatus,
): void {
  if (
    !isEffectStatus(from) ||
    !isEffectStatus(to) ||
    !EFFECT_TRANSITIONS[from].includes(to)
  )
    throw new InvalidTransitionError(from, to);
}

export function assertEffectObservationTrigger(
  kind: EffectKind,
  status: EffectStatus,
  trigger: ObservationTrigger,
): void;
export function assertEffectObservationTrigger(
  kind: EffectKind,
  trigger: ObservationTrigger,
  status: EffectStatus,
): void;
export function assertEffectObservationTrigger(
  kind: EffectKind,
  statusOrTrigger: EffectStatus | ObservationTrigger,
  triggerOrStatus?: EffectStatus | ObservationTrigger,
): void {
  const status = isEffectStatus(statusOrTrigger)
    ? (statusOrTrigger as EffectStatus)
    : (triggerOrStatus as EffectStatus);
  const trigger = isEffectStatus(statusOrTrigger)
    ? (triggerOrStatus as ObservationTrigger | undefined)
    : (statusOrTrigger as ObservationTrigger);

  if (!isEffectKind(kind)) {
    throw new InvalidTransitionError(String(kind), null);
  }
  if (!isEffectStatus(status)) {
    throw new InvalidTransitionError(`${kind}:${String(status)}`, null);
  }
  if (trigger === undefined) {
    throw new InvalidTransitionError(`${kind}:${status}`, null);
  }

  const normalizedTrigger = trigger ?? null;
  if (normalizedTrigger !== null && !isWorkflowTrigger(normalizedTrigger)) {
    throw new InvalidTransitionError(
      `${kind}:${status}`,
      String(normalizedTrigger),
    );
  }

  if (status === "ambiguous") {
    if (normalizedTrigger === null) return;
    throw new InvalidTransitionError(`${kind}:${status}`, normalizedTrigger);
  }
  if (status !== "confirmed" && status !== "failed") {
    throw new InvalidTransitionError(`${kind}:${status}`, normalizedTrigger);
  }

  if (OBSERVATION_TRIGGERS[kind][status].includes(normalizedTrigger)) return;
  throw new InvalidTransitionError(`${kind}:${status}`, normalizedTrigger);
}
