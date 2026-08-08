import { randomUUID } from "node:crypto";

import type { Kysely, Transaction } from "kysely";
import {
  isCodingState,
  isTerminalState,
  nextState,
  RUN_STATES,
  type RunState,
  type WorkflowTrigger,
} from "../workflow/state.js";
import type {
  ApprovalsTable,
  DatabaseSchema,
  EventsTable,
  FindingsTable,
  RunsTable,
  SchedulerControlTable,
  StepsTable,
} from "./schema.js";

const maximumIdentifierBytes = 512;
const maximumEvidenceBytes = 4 * 1024;
const maximumJsonBytes = 1024 * 1024;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const runStates = new Set<string>(RUN_STATES);
const repairableTriggers = new Set<WorkflowTrigger>([
  "verification_failed_repairable",
  "review_needs_repair",
  "ci_failed_repairable",
]);

export interface SanitizedSummary {
  text: string;
}

export interface CreateClaimInput {
  id: string;
  repository: string;
  projectItemId: string;
  issueNodeId: string;
  issueNumber: number;
  ownerToken: string;
  at: string;
  summary: SanitizedSummary;
}

export interface TransitionRequest {
  runId: string;
  expectedRevision: number;
  trigger: WorkflowTrigger;
  at: string;
  summary: SanitizedSummary;
  requiredAction?: string;
}

export interface SchedulerControlPatch {
  paused?: boolean;
  stopAfterCurrent?: boolean;
}

export interface SchedulerControlUpdateRequest {
  expectedRevision: number;
  patch: SchedulerControlPatch;
  at: string;
}

export interface RunRecord {
  id: string;
  repository: string;
  projectItemId: string;
  issueNodeId: string;
  issueNumber: number;
  intakeJson: string | null;
  state: RunState;
  revision: number;
  reworkEpoch: number;
  repairRound: number;
  ownerToken: string | null;
  ownershipReleasedAt: string | null;
  stopRequestedAt: string | null;
  baseSha: string | null;
  headSha: string | null;
  approvedHeadSha: string | null;
  observedBaseSha: string | null;
  mergeSha: string | null;
  worktreePath: string | null;
  baseBranch: string;
  branch: string | null;
  pullRequestNumber: number | null;
  pullRequestTitle: string | null;
  pullRequestUrl: string | null;
  requiredAction: string | null;
  lastFailureJson: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  handedOffAt: string | null;
  terminalAt: string | null;
}

export interface EventRecord {
  id: string;
  runId: string;
  sequence: number;
  runRevision: number;
  kind: string;
  summary: string;
  detailsJson: string | null;
  logReference: string | null;
  createdAt: string;
}

export interface SchedulerControl {
  id: 1;
  revision: number;
  paused: boolean;
  stopAfterCurrent: boolean;
  updatedAt: string;
}

export interface NewStepRecord {
  id: string;
  runId: string;
  expectedRevision: number;
  reworkEpoch: number;
  role: string;
  logicalStep: string;
  attempt: number;
  statusSequence: number;
  status: string;
  promptHash: string;
  model: string;
  reasoningEffort: string;
  startedAt: string;
  completedAt?: string | null;
  exitResultJson?: string | null;
  summary?: SanitizedSummary | null;
  rawLogReference?: string | null;
}

export interface NewFindingRecord {
  id: string;
  runId: string;
  expectedRevision: number;
  reworkEpoch: number;
  reviewStepId: string;
  stableKey: string;
  dispositionSequence: number;
  severity: string;
  evidence: string;
  disposition: string;
  resolvingStepId?: string | null;
  at: string;
}

export interface NewApprovalRecord {
  id: string;
  runId: string;
  expectedRevision: number;
  operator: string;
  approvedHeadSha: string;
  observedBaseSha: string;
  decision: string;
  invalidationReason?: string | null;
  at: string;
}

export interface StepRecord {
  id: string;
  runId: string;
  reworkEpoch: number;
  role: string;
  logicalStep: string;
  attempt: number;
  statusSequence: number;
  status: string;
  promptHash: string;
  model: string;
  reasoningEffort: string;
  startedAt: string;
  completedAt: string | null;
  exitResultJson: string | null;
  summary: string | null;
  rawLogReference: string | null;
}

export interface FindingRecord {
  id: string;
  runId: string;
  reworkEpoch: number;
  reviewStepId: string;
  stableKey: string;
  dispositionSequence: number;
  severity: string;
  evidence: string;
  disposition: string;
  resolvingStepId: string | null;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  operator: string;
  approvedHeadSha: string;
  observedBaseSha: string;
  decision: string;
  invalidationReason: string | null;
  createdAt: string;
}

export class RunNotFoundError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super("Run was not found.");
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

export class StaleRevisionError extends Error {
  readonly expectedRevision: number;

  constructor(expectedRevision: number) {
    super("The durable revision is stale.");
    this.name = "StaleRevisionError";
    this.expectedRevision = expectedRevision;
  }
}

export class StaleReworkEpochError extends StaleRevisionError {
  readonly expectedReworkEpoch: number;

  constructor(expectedReworkEpoch: number) {
    super(expectedReworkEpoch);
    this.message = "The durable rework epoch is stale.";
    this.name = "StaleReworkEpochError";
    this.expectedReworkEpoch = expectedReworkEpoch;
  }
}

export class RepairRoundLimitError extends Error {
  constructor() {
    super("The maximum of two repair rounds has been reached.");
    this.name = "RepairRoundLimitError";
  }
}

export class CodingSlotOccupiedError extends Error {
  constructor() {
    super("The coding execution slot is already occupied.");
    this.name = "CodingSlotOccupiedError";
  }
}

export class RunOwnershipConflictError extends Error {
  constructor() {
    super("Another active run owns this project item.");
    this.name = "RunOwnershipConflictError";
  }
}

/** Compatibility name for callers that use the shorter ownership error. */
export {
  RunOwnershipConflictError as OwnershipConflictError,
  RunOwnershipConflictError as ProjectOwnershipConflictError,
};

class DurableRunWriteError extends Error {
  constructor() {
    super("The durable run write could not be completed.");
    this.name = "DurableRunWriteError";
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`${label} must be non-empty text.`);
  if (byteLength(value) > maximum)
    throw new RangeError(`${label} exceeds its size limit.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  return boundedText(value, label, maximumIdentifierBytes);
}

function summaryText(summary: unknown): string {
  if (
    typeof summary !== "object" ||
    summary === null ||
    !Object.hasOwn(summary, "text")
  ) {
    throw new TypeError("Summary must contain non-empty text.");
  }
  return boundedText(
    (summary as { text?: unknown }).text,
    "Summary",
    maximumEvidenceBytes,
  );
}

function optionalText(
  value: unknown,
  label: string,
  maximum = maximumIdentifierBytes,
): string | null {
  if (value === undefined || value === null) return null;
  return boundedText(value, label, maximum);
}

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${label} must be a non-negative integer.`);
  return value as number;
}

function incrementRevision(value: number, label: string): number {
  if (value >= Number.MAX_SAFE_INTEGER)
    throw new RangeError(`${label} cannot exceed the safe integer limit.`);
  return value + 1;
}

function calculateRepairRound(
  current: number,
  trigger: WorkflowTrigger,
): number {
  if (!repairableTriggers.has(trigger)) return current;
  if (current >= 2) throw new RepairRoundLimitError();
  return current + 1;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new TypeError(`${label} must be a positive integer.`);
  return value as number;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value))
    throw new TypeError(`${label} must be a lowercase Git SHA.`);
  return value;
}

function parseRunState(value: string): RunState {
  if (!runStates.has(value)) throw new DurableRunWriteError();
  return value as RunState;
}

function mapRun(row: RunsTable): RunRecord {
  return {
    id: row.id,
    repository: row.repository,
    projectItemId: row.project_item_id,
    issueNodeId: row.issue_node_id,
    issueNumber: row.issue_number,
    intakeJson: row.intake_json,
    state: parseRunState(row.state),
    revision: row.revision,
    reworkEpoch: row.rework_epoch,
    repairRound: row.repair_round,
    ownerToken: row.owner_token,
    ownershipReleasedAt: row.ownership_released_at,
    stopRequestedAt: row.stop_requested_at,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    approvedHeadSha: row.approved_head_sha,
    observedBaseSha: row.observed_base_sha,
    mergeSha: row.merge_sha,
    worktreePath: row.worktree_path,
    baseBranch: row.base_branch,
    branch: row.branch,
    pullRequestNumber: row.pull_request_number,
    pullRequestTitle: row.pull_request_title,
    pullRequestUrl: row.pull_request_url,
    requiredAction: row.required_action,
    lastFailureJson: row.last_failure_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    handedOffAt: row.handed_off_at,
    terminalAt: row.terminal_at,
  };
}

function mapEvent(row: EventsTable): EventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    runRevision: row.run_revision,
    kind: row.kind,
    summary: row.summary,
    detailsJson: row.details_json,
    logReference: row.log_reference,
    createdAt: row.created_at,
  };
}

function mapSchedulerControl(row: SchedulerControlTable): SchedulerControl {
  if (
    row.id !== 1 ||
    (row.paused !== 0 && row.paused !== 1) ||
    (row.stop_after_current !== 0 && row.stop_after_current !== 1)
  ) {
    throw new DurableRunWriteError();
  }
  return {
    id: 1,
    revision: row.revision,
    paused: row.paused === 1,
    stopAfterCurrent: row.stop_after_current === 1,
    updatedAt: row.updated_at,
  };
}

function mapStep(row: StepsTable): StepRecord {
  return {
    id: row.id,
    runId: row.run_id,
    reworkEpoch: row.rework_epoch,
    role: row.role,
    logicalStep: row.logical_step,
    attempt: row.attempt,
    statusSequence: row.status_sequence,
    status: row.status,
    promptHash: row.prompt_hash,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    exitResultJson: row.exit_result_json,
    summary: row.summary,
    rawLogReference: row.raw_log_reference,
  };
}

function mapFinding(row: FindingsTable): FindingRecord {
  return {
    id: row.id,
    runId: row.run_id,
    reworkEpoch: row.rework_epoch,
    reviewStepId: row.review_step_id,
    stableKey: row.stable_key,
    dispositionSequence: row.disposition_sequence,
    severity: row.severity,
    evidence: row.evidence,
    disposition: row.disposition,
    resolvingStepId: row.resolving_step_id,
    createdAt: row.created_at,
  };
}

function mapApproval(row: ApprovalsTable): ApprovalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    operator: row.operator,
    approvedHeadSha: row.approved_head_sha,
    observedBaseSha: row.observed_base_sha,
    decision: row.decision,
    invalidationReason: row.invalidation_reason,
    createdAt: row.created_at,
  };
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const cause = error.cause;
  return `${error.message} ${cause instanceof Error ? cause.message : ""}`.toLowerCase();
}

function translateWriteError(error: unknown): never {
  const text = errorText(error);
  if (
    text.includes("runs_coding_slot_index") ||
    text.includes("unique constraint failed: runs.1")
  ) {
    throw new CodingSlotOccupiedError();
  }
  if (
    text.includes("runs_active_project_owner_index") ||
    text.includes("unique constraint failed: runs.project_item_id")
  ) {
    throw new RunOwnershipConflictError();
  }
  if (error instanceof DurableRunWriteError) throw error;
  throw new DurableRunWriteError();
}

async function nextEventSequence(
  db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  runId: string,
): Promise<number> {
  const previous = await db
    .selectFrom("events")
    .select("sequence")
    .where("run_id", "=", runId)
    .orderBy("sequence", "desc")
    .limit(1)
    .executeTakeFirst();
  return incrementRevision(previous?.sequence ?? 0, "Event sequence");
}

async function appendEvent(
  db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  runId: string,
  runRevision: number,
  kind: string,
  summary: string,
  at: string,
  id: string = randomUUID(),
  sequence?: number,
): Promise<void> {
  await db
    .insertInto("events")
    .values({
      id,
      run_id: runId,
      sequence: sequence ?? (await nextEventSequence(db, runId)),
      run_revision: runRevision,
      kind,
      summary,
      details_json: null,
      log_reference: null,
      created_at: at,
    })
    .execute();
}

async function appendApprovalInvalidations(
  db: Transaction<DatabaseSchema>,
  runId: string,
  at: string,
  reason: string,
): Promise<void> {
  const approvals = await db
    .selectFrom("approvals")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .execute();
  const availableInvalidations = new Map<string, number>();
  for (const approval of approvals) {
    if (approval.decision !== "invalidated") continue;
    const key = `${approval.approved_head_sha}:${approval.observed_base_sha}`;
    availableInvalidations.set(key, (availableInvalidations.get(key) ?? 0) + 1);
  }
  for (const approval of approvals) {
    if (
      !["approved", "approve"].includes(approval.decision) ||
      approval.invalidation_reason !== null
    )
      continue;
    const key = `${approval.approved_head_sha}:${approval.observed_base_sha}`;
    const available = availableInvalidations.get(key) ?? 0;
    if (available > 0) {
      availableInvalidations.set(key, available - 1);
      continue;
    }
    await db
      .insertInto("approvals")
      .values({
        id: randomUUID(),
        run_id: runId,
        operator: "system",
        approved_head_sha: approval.approved_head_sha,
        observed_base_sha: approval.observed_base_sha,
        decision: "invalidated",
        invalidation_reason: reason,
        created_at: at,
      })
      .execute();
  }
}

async function readRunRow(
  db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  runId: string,
): Promise<RunsTable> {
  const row = await db
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst();
  if (row === undefined) throw new RunNotFoundError(runId);
  return row;
}

async function assertRunRevision(
  db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  runId: string,
  expectedRevisionInput: unknown,
): Promise<RunsTable> {
  const expectedRevision = revision(expectedRevisionInput, "Expected revision");
  const current = await readRunRow(db, runId);
  if (current.revision !== expectedRevision)
    throw new StaleRevisionError(expectedRevision);
  return current;
}

function assertRunReworkEpoch(
  current: RunsTable,
  expectedReworkEpochInput: unknown,
): void {
  const expectedReworkEpoch = revision(
    expectedReworkEpochInput,
    "Expected rework epoch",
  );
  if (current.rework_epoch !== expectedReworkEpoch)
    throw new StaleReworkEpochError(expectedReworkEpoch);
}

async function readApprovalRow(
  db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  id: string,
): Promise<ApprovalRecord> {
  const row = await db
    .selectFrom("approvals")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return mapApproval(row);
}

export async function readRun(
  db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  runId: string,
): Promise<RunRecord> {
  return mapRun(await readRunRow(db, identifier(runId, "Run ID")));
}

export async function listEvents(
  db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  runId: string,
): Promise<EventRecord[]> {
  const normalizedRunId = identifier(runId, "Run ID");
  const rows = await db
    .selectFrom("events")
    .selectAll()
    .where("run_id", "=", normalizedRunId)
    .orderBy("sequence", "asc")
    .execute();
  return rows.map(mapEvent);
}

export async function readSchedulerControl(
  db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
): Promise<SchedulerControl> {
  const row = await db
    .selectFrom("scheduler_control")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirst();
  if (row === undefined) throw new DurableRunWriteError();
  return mapSchedulerControl(row);
}

export interface RunMutationRepository {
  createClaim(input: CreateClaimInput): Promise<RunRecord>;
  transitionRun(request: TransitionRequest): Promise<RunRecord>;
  appendStep(input: NewStepRecord): Promise<StepRecord>;
  appendFinding(input: NewFindingRecord): Promise<FindingRecord>;
  appendApproval(input: NewApprovalRecord): Promise<ApprovalRecord>;
  updateSchedulerControl(
    expectedRevisionOrRequest: number | SchedulerControlUpdateRequest,
    patch?: SchedulerControlPatch,
    at?: string,
  ): Promise<SchedulerControl>;
}

export interface RunMutationRepositoryOptions {
  /** Narrow real-SQLite atomicity seam for deterministic event-insert failures. */
  eventIdFactory?: () => string;
}

export function createRunMutationRepository(
  tx: Transaction<DatabaseSchema>,
  options: RunMutationRepositoryOptions = {},
): RunMutationRepository {
  return {
    async createClaim(input): Promise<RunRecord> {
      const id = identifier(input.id, "Run ID");
      const repository = identifier(input.repository, "Repository");
      const projectItemId = identifier(input.projectItemId, "Project item ID");
      const issueNodeId = identifier(input.issueNodeId, "Issue node ID");
      const ownerToken = identifier(input.ownerToken, "Owner token");
      const at = identifier(input.at, "Timestamp");
      const summary = summaryText(input.summary);
      const issueNumber = positiveInteger(input.issueNumber, "Issue number");

      try {
        await tx
          .insertInto("runs")
          .values({
            id,
            repository,
            project_item_id: projectItemId,
            issue_node_id: issueNodeId,
            issue_number: issueNumber,
            intake_json: null,
            state: "claiming",
            revision: 1,
            rework_epoch: 0,
            repair_round: 0,
            owner_token: ownerToken,
            ownership_released_at: null,
            stop_requested_at: null,
            base_sha: null,
            head_sha: null,
            approved_head_sha: null,
            observed_base_sha: null,
            merge_sha: null,
            worktree_path: null,
            base_branch: "main",
            branch: null,
            pull_request_number: null,
            pull_request_title: null,
            pull_request_url: null,
            required_action: null,
            last_failure_json: null,
            created_at: at,
            updated_at: at,
            started_at: at,
            handed_off_at: null,
            terminal_at: null,
          })
          .execute();
        await appendEvent(
          tx,
          id,
          1,
          "claim_created",
          summary,
          at,
          options.eventIdFactory?.(),
        );
        return mapRun(await readRunRow(tx, id));
      } catch (error) {
        translateWriteError(error);
      }
    },

    async transitionRun(request): Promise<RunRecord> {
      const runId = identifier(request.runId, "Run ID");
      const expectedRevision = revision(
        request.expectedRevision,
        "Expected revision",
      );
      const at = identifier(request.at, "Timestamp");
      const summary = summaryText(request.summary);
      const requiredAction =
        request.requiredAction === undefined
          ? undefined
          : boundedText(
              request.requiredAction,
              "Required action",
              maximumEvidenceBytes,
            );
      const currentRow = await readRunRow(tx, runId);
      if (currentRow.revision !== expectedRevision)
        throw new StaleRevisionError(expectedRevision);
      const currentState = parseRunState(currentRow.state);
      const next = nextState(currentState, request.trigger);
      const nextRevision = incrementRevision(expectedRevision, "Run revision");
      const eventSequence = await nextEventSequence(tx, runId);
      const nextReworkEpoch =
        next === "returning_to_todo"
          ? incrementRevision(currentRow.rework_epoch, "Rework epoch")
          : currentRow.rework_epoch;
      const nextRepairRound =
        next === "returning_to_todo"
          ? 0
          : calculateRepairRound(currentRow.repair_round, request.trigger);
      const terminal = isTerminalState(next);
      // Review is a durable handoff and must never consume the coding slot.
      const handoff = next === "review" && !isCodingState(next);

      try {
        const update = await tx
          .updateTable("runs")
          .set({
            state: next,
            revision: nextRevision,
            rework_epoch: nextReworkEpoch,
            repair_round: nextRepairRound,
            owner_token: terminal ? null : currentRow.owner_token,
            ownership_released_at: terminal
              ? at
              : currentRow.ownership_released_at,
            stop_requested_at:
              request.trigger === "stop_safe"
                ? at
                : currentRow.stop_requested_at,
            updated_at: at,
            required_action:
              requiredAction === undefined
                ? currentRow.required_action
                : requiredAction,
            handed_off_at: handoff ? at : currentRow.handed_off_at,
            terminal_at: terminal ? at : currentRow.terminal_at,
          })
          .where("id", "=", runId)
          .where("revision", "=", expectedRevision)
          .executeTakeFirst();
        if (Number(update.numUpdatedRows) === 0)
          throw new StaleRevisionError(expectedRevision);

        if (next === "queued_rework" || next === "returning_to_todo")
          await appendApprovalInvalidations(tx, runId, at, summary);
        await appendEvent(
          tx,
          runId,
          nextRevision,
          request.trigger,
          summary,
          at,
          options.eventIdFactory?.(),
          eventSequence,
        );
        return mapRun(await readRunRow(tx, runId));
      } catch (error) {
        if (
          error instanceof StaleRevisionError ||
          error instanceof RunNotFoundError ||
          error instanceof StaleReworkEpochError
        )
          throw error;
        if (
          errorText(error).includes("database is locked") ||
          errorText(error).includes("database table is locked")
        )
          throw new StaleRevisionError(expectedRevision);
        translateWriteError(error);
      }
    },

    async appendStep(input): Promise<StepRecord> {
      const id = identifier(input.id, "Step ID");
      const runId = identifier(input.runId, "Run ID");
      const current = await assertRunRevision(
        tx,
        runId,
        input.expectedRevision,
      );
      assertRunReworkEpoch(current, input.reworkEpoch);
      const role = identifier(input.role, "Step role");
      const logicalStep = identifier(input.logicalStep, "Logical step");
      const status = identifier(input.status, "Step status");
      const model = identifier(input.model, "Model");
      const reasoningEffort = identifier(
        input.reasoningEffort,
        "Reasoning effort",
      );
      const promptHash = boundedText(
        input.promptHash,
        "Prompt hash",
        maximumIdentifierBytes,
      );
      if (!/^[0-9a-f]{64}$/u.test(promptHash))
        throw new TypeError("Prompt hash must be a lowercase SHA-256 hash.");
      const startedAt = identifier(input.startedAt, "Step timestamp");
      const completedAt = optionalText(
        input.completedAt,
        "Completion timestamp",
      );
      const exitResultJson = optionalText(
        input.exitResultJson,
        "Step result",
        maximumJsonBytes,
      );
      const summary =
        input.summary === undefined || input.summary === null
          ? null
          : summaryText(input.summary);
      const rawLogReference = optionalText(
        input.rawLogReference,
        "Raw log reference",
      );
      const reworkEpoch = revision(input.reworkEpoch, "Rework epoch");
      const attempt = positiveInteger(input.attempt, "Step attempt");
      const statusSequence = positiveInteger(
        input.statusSequence,
        "Step status sequence",
      );
      try {
        await tx
          .insertInto("steps")
          .values({
            id,
            run_id: runId,
            rework_epoch: reworkEpoch,
            role,
            logical_step: logicalStep,
            attempt,
            status_sequence: statusSequence,
            status,
            prompt_hash: promptHash,
            model,
            reasoning_effort: reasoningEffort,
            started_at: startedAt,
            completed_at: completedAt,
            exit_result_json: exitResultJson,
            summary,
            raw_log_reference: rawLogReference,
          })
          .execute();
        const row = await tx
          .selectFrom("steps")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        return mapStep(row);
      } catch (error) {
        translateWriteError(error);
      }
    },

    async appendFinding(input): Promise<FindingRecord> {
      const id = identifier(input.id, "Finding ID");
      const runId = identifier(input.runId, "Run ID");
      const current = await assertRunRevision(
        tx,
        runId,
        input.expectedRevision,
      );
      assertRunReworkEpoch(current, input.reworkEpoch);
      const reviewStepId = identifier(input.reviewStepId, "Review step ID");
      const stableKey = identifier(input.stableKey, "Finding key");
      const severity = identifier(input.severity, "Finding severity");
      const disposition = identifier(input.disposition, "Finding disposition");
      const evidence = boundedText(
        input.evidence,
        "Finding evidence",
        maximumEvidenceBytes,
      );
      const at = identifier(input.at, "Finding timestamp");
      const resolvingStepId = optionalText(
        input.resolvingStepId,
        "Resolving step ID",
      );
      const reworkEpoch = revision(input.reworkEpoch, "Rework epoch");
      const dispositionSequence = positiveInteger(
        input.dispositionSequence,
        "Disposition sequence",
      );
      try {
        await tx
          .insertInto("findings")
          .values({
            id,
            run_id: runId,
            rework_epoch: reworkEpoch,
            review_step_id: reviewStepId,
            stable_key: stableKey,
            disposition_sequence: dispositionSequence,
            severity,
            evidence,
            disposition,
            resolving_step_id: resolvingStepId,
            created_at: at,
          })
          .execute();
        const row = await tx
          .selectFrom("findings")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        return mapFinding(row);
      } catch (error) {
        translateWriteError(error);
      }
    },

    async appendApproval(input): Promise<ApprovalRecord> {
      const id = identifier(input.id, "Approval ID");
      const runId = identifier(input.runId, "Run ID");
      await assertRunRevision(tx, runId, input.expectedRevision);
      const operator = identifier(input.operator, "Approval operator");
      const approvedHeadSha = sha(input.approvedHeadSha, "Approved head SHA");
      const observedBaseSha = sha(input.observedBaseSha, "Observed base SHA");
      const decision = identifier(input.decision, "Approval decision");
      const invalidationReason =
        input.invalidationReason === undefined ||
        input.invalidationReason === null
          ? null
          : boundedText(
              input.invalidationReason,
              "Invalidation reason",
              maximumEvidenceBytes,
            );
      const at = identifier(input.at, "Approval timestamp");
      try {
        await tx
          .insertInto("approvals")
          .values({
            id,
            run_id: runId,
            operator,
            approved_head_sha: approvedHeadSha,
            observed_base_sha: observedBaseSha,
            decision,
            invalidation_reason: invalidationReason,
            created_at: at,
          })
          .execute();
        return readApprovalRow(tx, id);
      } catch (error) {
        translateWriteError(error);
      }
    },

    async updateSchedulerControl(
      expectedRevisionOrRequest: number | SchedulerControlUpdateRequest,
      patchInput?: SchedulerControlPatch,
      atInput?: string,
    ): Promise<SchedulerControl> {
      const expectedRevisionInput =
        typeof expectedRevisionOrRequest === "number"
          ? expectedRevisionOrRequest
          : expectedRevisionOrRequest.expectedRevision;
      const patch =
        typeof expectedRevisionOrRequest === "number"
          ? patchInput
          : expectedRevisionOrRequest.patch;
      const schedulerAt =
        typeof expectedRevisionOrRequest === "number"
          ? atInput
          : expectedRevisionOrRequest.at;
      const expectedRevision = revision(
        expectedRevisionInput,
        "Expected scheduler revision",
      );
      if (
        patch === undefined ||
        patch === null ||
        typeof patch !== "object" ||
        (patch.paused === undefined && patch.stopAfterCurrent === undefined)
      ) {
        throw new TypeError("Scheduler control patch must be non-empty.");
      }
      if (
        (patch.paused !== undefined && typeof patch.paused !== "boolean") ||
        (patch.stopAfterCurrent !== undefined &&
          typeof patch.stopAfterCurrent !== "boolean")
      ) {
        throw new TypeError("Scheduler control values must be booleans.");
      }
      const at = identifier(schedulerAt, "Scheduler timestamp");
      const current = await readSchedulerControl(tx);
      if (current.revision !== expectedRevision)
        throw new StaleRevisionError(expectedRevision);
      const updatedRevision = incrementRevision(
        expectedRevision,
        "Scheduler revision",
      );
      try {
        const update = await tx
          .updateTable("scheduler_control")
          .set({
            revision: updatedRevision,
            paused:
              patch.paused === undefined
                ? current.paused
                  ? 1
                  : 0
                : patch.paused
                  ? 1
                  : 0,
            stop_after_current:
              patch.stopAfterCurrent === undefined
                ? current.stopAfterCurrent
                  ? 1
                  : 0
                : patch.stopAfterCurrent
                  ? 1
                  : 0,
            updated_at: at,
          })
          .where("id", "=", 1)
          .where("revision", "=", expectedRevision)
          .executeTakeFirst();
        if (Number(update.numUpdatedRows) === 0)
          throw new StaleRevisionError(expectedRevision);
        return readSchedulerControl(tx);
      } catch (error) {
        if (error instanceof StaleRevisionError) throw error;
        translateWriteError(error);
      }
    },
  };
}
