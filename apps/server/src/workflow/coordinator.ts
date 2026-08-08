import { randomUUID } from "node:crypto";

import type { DatabaseConnection } from "../database/connection.js";
import {
  createEffectMutationRepository,
  type EffectInsertResult,
  type EffectObservation,
  type EffectRecord,
  listUnresolvedForReconciliation,
  type NewEffectIntent,
  StaleEffectError,
} from "../database/effects.js";
import {
  type CreateClaimInput,
  createRunMutationRepository,
  type RunRecord,
  readRun,
  type SchedulerControl,
  type SchedulerControlUpdateRequest,
  StaleRevisionError,
  type TransitionRequest,
} from "../database/runs.js";
import {
  assertEffectObservationTrigger,
  type EffectKind,
  type EffectStatus,
  WORKFLOW_TRIGGERS,
  type WorkflowTrigger,
} from "./state.js";

export interface EffectResult {
  outcome: "confirmed" | "failed" | "ambiguous";
  trigger?: WorkflowTrigger | null;
  receipt?: unknown;
  evidence?: string;
}

export type EffectCompletion = (result: unknown) => void | Promise<void>;

/** A test seam for a concrete external-effect adapter. */
export interface EffectDispatcher {
  dispatch(effect: EffectRecord, complete: EffectCompletion): unknown;
}

/** A test seam for observing effects that survived a process restart. */
export interface EffectObserver {
  observe(effect: EffectRecord, complete: EffectCompletion): unknown;
}

export type EffectDispatcherLike =
  | EffectDispatcher
  | ((effect: EffectRecord, complete: EffectCompletion) => unknown);

export type EffectObserverLike =
  | EffectObserver
  | ((effect: EffectRecord, complete: EffectCompletion) => unknown);

export interface EffectIntentCommand
  extends Omit<NewEffectIntent, "targetRevision"> {
  targetRevision?: number;
  /** Keep a durable pending intent when false; otherwise begin dispatch. */
  dispatch?: boolean;
}

export interface TransitionCommandOptions {
  effect?: EffectIntentCommand;
}

export interface CreateClaimOptions {
  effect?: EffectIntentCommand;
}

export interface BeginEffectCommand {
  effectKey: string;
  expectedRevision?: number;
  at?: string;
}

export interface CancelEffectCommand {
  effectKey: string;
  reason: string;
  expectedRevision?: number;
  at?: string;
}

export interface ObserveEffectCommand extends EffectObservation {
  at?: string;
}

export interface ObserveAmbiguousEffectCommand {
  effectKey: string;
  expectedRevision?: number;
}

export interface WorkflowCoordinatorOptions {
  connection: DatabaseConnection;
  ownerToken?: string;
  now?: () => string;
  dispatcher?: EffectDispatcherLike;
  observer?: EffectObserverLike;
  onError?: (error: CoordinatorError) => void;
}

export type CoordinatorErrorCode = "closed" | "stale" | "unexpected";

export interface CoordinatorError {
  code: CoordinatorErrorCode;
  source: "dispatcher" | "observer";
  effectKey: string;
  expectedRevision: number;
  error: Error;
}

export class EffectSettlementTimeoutError extends Error {
  readonly effectKey: string;
  readonly timeoutMs: number;

  constructor(effectKey: string, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for durable effect ${effectKey} to settle.`,
    );
    this.name = "EffectSettlementTimeoutError";
    this.effectKey = effectKey;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Failure observations need a trigger that is legal for the run state at the
 * effect's target revision. Keep this exhaustive with the state-domain effect
 * vocabulary so an adapter failure can never be swallowed by an invalid
 * observation.
 */
const FAILED_EFFECT_TRIGGERS = {
  project_todo: "claim_rejected",
  project_ready: "handoff_required",
  workspace_prepare: "startup_failed",
  intake_capture: "handoff_required",
  agent_build: "builder_exhausted",
  verify: "verification_failed_exhausted",
  agent_review: "review_needs_repair",
  agent_repair: "handoff_required",
  publish: "handoff_required",
  observe_ci: "ci_failed_exhausted",
  project_review: null,
  project_return_todo: "todo_move_rejected",
  merge: "delivery_failed",
  observe_staging: "delivery_failed",
  smoke: "smoke_failed",
  project_done: "done_projection_failed",
} as const satisfies Readonly<Record<EffectKind, WorkflowTrigger | null>>;

const WORKFLOW_TRIGGER_SET = new Set<string>(WORKFLOW_TRIGGERS);
const maximumEvidenceBytes = 4 * 1024;
const maximumJsonBytes = 1024 * 1024;
// A fixed event kind plus structured effect-key details is durable quarantine
// state; adapter evidence remains free-form and is never used as a marker.
const quarantinedEffectEventKind = "effect_quarantined";

function boundedEvidence(value: string): string {
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maximumEvidenceBytes)
    result = result.slice(0, -1);
  return result;
}

function errorValue(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value))
    return value.every((item) => isJsonValue(item, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every((item) => isJsonValue(item, seen));
}

function malformedResult(
  effect: EffectRecord,
  source: "dispatcher" | "observer",
  reason: string,
): EffectResult {
  return {
    outcome: "failed",
    trigger: FAILED_EFFECT_TRIGGERS[effect.kind],
    evidence: boundedEvidence(
      `Malformed ${source} result for ${effect.key}: ${reason}`,
    ),
  };
}

function normalizeAdapterResult(
  value: unknown,
  effect: EffectRecord,
  source: "dispatcher" | "observer",
  allowUndefined: boolean,
): EffectResult | undefined {
  if (value === undefined && allowUndefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return malformedResult(effect, source, "result must be an object");
  const result = value as Record<string, unknown>;
  const outcome = result.outcome;
  if (!["confirmed", "failed", "ambiguous"].includes(outcome as string))
    return malformedResult(effect, source, "outcome is invalid");
  const typedOutcome = outcome as EffectResult["outcome"];
  const rawEvidence = result.evidence;
  if (rawEvidence !== undefined && typeof rawEvidence !== "string")
    return malformedResult(effect, source, "evidence must be text");
  if (result.receipt !== undefined) {
    if (!isJsonValue(result.receipt))
      return malformedResult(effect, source, "receipt must be JSON data");
    try {
      const serialized = JSON.stringify(result.receipt);
      if (
        serialized === undefined ||
        Buffer.byteLength(serialized, "utf8") > maximumJsonBytes
      )
        return malformedResult(
          effect,
          source,
          "receipt exceeds the 1 MiB durable JSON limit",
        );
    } catch {
      return malformedResult(effect, source, "receipt must be JSON data");
    }
  }

  const rawTrigger = result.trigger;
  if (
    rawTrigger !== undefined &&
    rawTrigger !== null &&
    (typeof rawTrigger !== "string" || !WORKFLOW_TRIGGER_SET.has(rawTrigger))
  )
    return malformedResult(effect, source, "trigger is invalid");

  let trigger: WorkflowTrigger | null | undefined =
    rawTrigger === null ? null : (rawTrigger as WorkflowTrigger | undefined);
  if (typedOutcome === "ambiguous") {
    if (trigger !== undefined && trigger !== null)
      return malformedResult(
        effect,
        source,
        "ambiguous results require no trigger",
      );
    trigger = null;
  } else if (trigger === undefined) {
    if (typedOutcome === "failed")
      trigger = FAILED_EFFECT_TRIGGERS[effect.kind];
    else if (effect.kind === "project_review") trigger = null;
    else
      return malformedResult(
        effect,
        source,
        "confirmed result requires a trigger",
      );
  }
  try {
    assertEffectObservationTrigger(effect.kind, typedOutcome, trigger ?? null);
  } catch {
    return malformedResult(
      effect,
      source,
      "trigger is not legal for this effect",
    );
  }
  const evidence =
    rawEvidence === undefined || rawEvidence.trim().length === 0
      ? `${source === "dispatcher" ? "Effect" : "Observed effect"} ${effect.key} ${typedOutcome}.`
      : rawEvidence;
  return {
    outcome: typedOutcome,
    ...(trigger === undefined ? {} : { trigger }),
    ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
    evidence: boundedEvidence(evidence),
  };
}

function safeNormalizeAdapterResult(
  value: unknown,
  effect: EffectRecord,
  source: "dispatcher" | "observer",
  allowUndefined: boolean,
): EffectResult | undefined {
  try {
    return normalizeAdapterResult(value, effect, source, allowUndefined);
  } catch (error) {
    return malformedResult(
      effect,
      source,
      `result validation failed: ${errorValue(error).message}`,
    );
  }
}

export class CoordinatorClosedError extends Error {
  constructor() {
    super("The workflow coordinator is closed and rejects new commands.");
    this.name = "CoordinatorClosedError";
  }
}

export class CoordinatorDispatchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CoordinatorDispatchError";
  }
}

function asTimestamp(now: () => string, at: string | undefined): string {
  return at ?? now();
}

function effectResult(
  result: EffectResult,
  effect: EffectRecord,
): EffectResult {
  const evidence = result.evidence ?? `Effect ${effect.key} ${result.outcome}.`;
  const trigger =
    result.outcome === "failed" && result.trigger === undefined
      ? FAILED_EFFECT_TRIGGERS[effect.kind]
      : result.trigger;
  if (evidence.trim().length === 0)
    return {
      ...result,
      evidence: `Effect ${effect.key} ${result.outcome}.`,
      ...(trigger === undefined ? {} : { trigger }),
    };
  return { ...result, evidence, ...(trigger === undefined ? {} : { trigger }) };
}

/**
 * The one serialized owner of workflow writes.
 *
 * Repositories are deliberately created from each transaction rather than
 * retained on the coordinator. This makes it impossible for an external
 * adapter callback to retain a transaction and accidentally write after the
 * transaction has committed.
 */
export class WorkflowCoordinator {
  private readonly connection: DatabaseConnection;
  private readonly ownerToken: string;
  private readonly now: () => string;
  private readonly dispatcher: EffectDispatcherLike | undefined;
  private readonly observer: EffectObserverLike | undefined;
  private readonly onError: ((error: CoordinatorError) => void) | undefined;
  private readonly observationErrors: CoordinatorError[] = [];
  private readonly effectSettlementWaiters = new Map<
    string,
    Set<(effect: EffectRecord) => void>
  >();
  private readonly commandQueue: Array<{
    command: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private accepting = true;
  private draining = false;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: WorkflowCoordinatorOptions) {
    this.connection = options.connection;
    this.ownerToken = options.ownerToken ?? randomUUID();
    this.now = options.now ?? (() => new Date().toISOString());
    this.dispatcher = options.dispatcher;
    this.observer = options.observer;
    this.onError = options.onError;
  }

  get executorOwnerToken(): string {
    return this.ownerToken;
  }

  get isClosed(): boolean {
    return !this.accepting;
  }

  /** Whether this coordinator owns the external dispatcher capability. */
  get hasEffectDispatcher(): boolean {
    return this.dispatcher !== undefined;
  }

  /** Whether this coordinator owns the external observer capability. */
  get hasEffectObserver(): boolean {
    return this.observer !== undefined;
  }

  get errors(): readonly CoordinatorError[] {
    return [...this.observationErrors];
  }

  /** Resolves after every command accepted so far has settled. */
  async waitForIdle(): Promise<void> {
    await this.idle;
  }

  /**
   * Await a confirmed, failed, canceled, or ambiguous observation for one
   * effect. Ambiguous is a notification that lets restart reconciliation
   * hand the effect to the observer without dispatching it again.
   */
  waitForEffectSettlement(
    effectKey: string,
    timeoutMs = 30_000,
  ): Promise<EffectRecord> {
    if (effectKey.trim().length === 0)
      return Promise.reject(
        new TypeError("Effect key must be non-empty text."),
      );
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      return Promise.reject(
        new TypeError(
          "Effect settlement timeout must be a finite non-negative number.",
        ),
      );
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (effect: EffectRecord): void => {
        if (timer !== undefined) clearTimeout(timer);
        const waiters = this.effectSettlementWaiters.get(effectKey);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.effectSettlementWaiters.delete(effectKey);
        resolve(effect);
      };
      const waiters =
        this.effectSettlementWaiters.get(effectKey) ??
        new Set<(effect: EffectRecord) => void>();
      waiters.add(waiter);
      this.effectSettlementWaiters.set(effectKey, waiters);
      timer = setTimeout(() => {
        waiters.delete(waiter);
        if (waiters.size === 0) this.effectSettlementWaiters.delete(effectKey);
        reject(new EffectSettlementTimeoutError(effectKey, timeoutMs));
      }, timeoutMs);
    });
  }

  createClaim(
    input: CreateClaimInput,
    options: CreateClaimOptions = {},
  ): Promise<RunRecord> {
    return this.enqueue(async () => {
      const result = await this.connection.db
        .transaction()
        .execute(async (tx) => {
          const run = await createRunMutationRepository(tx).createClaim(input);
          if (options.effect === undefined) return { run, effect: undefined };
          const effect = await createEffectMutationRepository(
            tx,
          ).insertEffectIntent(
            run,
            this.withTargetRevision(options.effect, run.revision),
            input.at,
          );
          return { run, effect };
        });
      if (
        result.effect?.inserted === true &&
        result.effect.status === "pending" &&
        options.effect?.dispatch !== false
      )
        await this.beginAndDispatch(result.effect.key, input.at);
      return result.run;
    });
  }

  transition(
    request: TransitionRequest,
    options: TransitionCommandOptions = {},
  ): Promise<RunRecord> {
    return this.enqueue(async () => {
      const result = await this.connection.db
        .transaction()
        .execute(async (tx) => {
          const repository = createRunMutationRepository(tx);
          const run = await repository.transitionRun(request);
          if (options.effect === undefined) return { run, effect: undefined };
          const effect = await createEffectMutationRepository(
            tx,
          ).insertEffectIntent(
            run,
            this.withTargetRevision(options.effect, run.revision),
            request.at,
          );
          return { run, effect };
        });
      if (
        result.effect?.inserted === true &&
        result.effect.status === "pending" &&
        options.effect?.dispatch !== false
      )
        await this.beginAndDispatch(result.effect.key, request.at);
      return result.run;
    });
  }

  createEffectIntent(
    command: EffectIntentCommand & {
      runId: string;
      expectedRevision?: number;
      at?: string;
    },
  ): Promise<EffectInsertResult> {
    return this.enqueue(async () => {
      const at = asTimestamp(this.now, command.at);
      const result = await this.connection.db
        .transaction()
        .execute(async (tx) => {
          const run = await readRun(tx, command.runId);
          if (
            command.expectedRevision !== undefined &&
            command.expectedRevision !== run.revision
          )
            throw new StaleRevisionError(command.expectedRevision);
          const existing = await tx
            .selectFrom("side_effects")
            .select("target_revision")
            .where("key", "=", command.key)
            .executeTakeFirst();
          return createEffectMutationRepository(tx).insertEffectIntent(
            run,
            this.withTargetRevision(
              command,
              existing?.target_revision ??
                command.targetRevision ??
                run.revision,
            ),
            at,
          );
        });
      if (result.status === "pending" && command.dispatch !== false)
        await this.beginAndDispatch(result.key, at);
      return result;
    });
  }

  beginEffect(command: BeginEffectCommand | string): Promise<EffectRecord> {
    const normalized =
      typeof command === "string" ? { effectKey: command } : command;
    return this.enqueue(async () => {
      const at = asTimestamp(this.now, normalized.at);
      const inFlight = await this.connection.db
        .transaction()
        .execute(async (tx) => {
          if (normalized.expectedRevision !== undefined) {
            const item = (await listUnresolvedForReconciliation(tx)).find(
              ({ effect }) => effect.key === normalized.effectKey,
            );
            if (
              item !== undefined &&
              item.run.revision !== normalized.expectedRevision
            )
              throw new StaleRevisionError(normalized.expectedRevision);
          }
          return createEffectMutationRepository(tx).markEffectInFlight(
            normalized.effectKey,
            this.ownerToken,
            at,
          );
        });
      this.launchDispatch(inFlight);
      return inFlight;
    });
  }

  observeEffect(command: ObserveEffectCommand): Promise<EffectRecord> {
    return this.submitObservation(command, false).then((effect) => {
      if (effect === undefined)
        throw new Error("Effect observation was unexpectedly skipped.");
      return effect;
    });
  }

  /** Alias emphasizing that observations are commands, never direct writes. */
  recordEffect(command: ObserveEffectCommand): Promise<EffectRecord> {
    return this.observeEffect(command);
  }

  /** Mark an uncertain dispatch ambiguous and ignore any late adapter receipt. */
  abandonEffect(command: ObserveEffectCommand): Promise<EffectRecord> {
    const result = this.enqueuePriority(async () => {
      const at = asTimestamp(this.now, command.at);
      return this.connection.db.transaction().execute(async (tx) => {
        const effect = await createEffectMutationRepository(
          tx,
        ).recordEffectObservation(command, at);
        const run = await readRun(tx, effect.runId);
        const previous = await tx
          .selectFrom("events")
          .select("sequence")
          .where("run_id", "=", effect.runId)
          .orderBy("sequence", "desc")
          .limit(1)
          .executeTakeFirst();
        await tx
          .insertInto("events")
          .values({
            id: randomUUID(),
            run_id: effect.runId,
            sequence: (previous?.sequence ?? 0) + 1,
            run_revision: run.revision,
            kind: quarantinedEffectEventKind,
            summary: command.evidence,
            details_json: JSON.stringify({ effectKey: command.effectKey }),
            log_reference: null,
            created_at: at,
          })
          .execute();
        return effect;
      });
    });
    return result.then((effect) => {
      this.notifyEffectSettlement(effect);
      return effect;
    });
  }

  cancelEffect(command: CancelEffectCommand): Promise<EffectRecord> {
    const result = this.enqueue(async () => {
      const at = asTimestamp(this.now, command.at);
      return this.connection.db.transaction().execute(async (tx) => {
        if (command.expectedRevision !== undefined) {
          const item = (await listUnresolvedForReconciliation(tx)).find(
            ({ effect }) => effect.key === command.effectKey,
          );
          if (
            item !== undefined &&
            item.run.revision !== command.expectedRevision
          )
            throw new StaleRevisionError(command.expectedRevision);
        }
        return createEffectMutationRepository(tx).cancelPendingEffect(
          command.effectKey,
          command.reason,
          at,
        );
      });
    });
    return result.then((effect) => {
      this.notifyEffectSettlement(effect);
      return effect;
    });
  }

  updateSchedulerControl(
    request: SchedulerControlUpdateRequest,
  ): Promise<SchedulerControl> {
    return this.enqueue(async () =>
      this.connection.db
        .transaction()
        .execute((tx) =>
          createRunMutationRepository(tx).updateSchedulerControl(request),
        ),
    );
  }

  /**
   * Ask the injected observer about an unresolved effect. The observer runs
   * after this read transaction commits and its callback is submitted back to
   * this same FIFO queue.
   */
  observeAmbiguousEffect(
    command: ObserveAmbiguousEffectCommand,
  ): Promise<EffectRecord | undefined> {
    return this.enqueue(async () => {
      const unresolved = await listUnresolvedForReconciliation(
        this.connection.db,
      );
      const item = unresolved.find(
        ({ effect }) =>
          effect.key === command.effectKey && effect.status === "ambiguous",
      );
      if (item === undefined) return undefined;
      const run = await readRun(this.connection.db, item.effect.runId);
      if (
        command.expectedRevision !== undefined &&
        command.expectedRevision !== run.revision
      )
        throw new StaleRevisionError(command.expectedRevision);
      if (this.observer === undefined) return undefined;
      const effect = item.effect;
      const expectedRevision = command.expectedRevision ?? run.revision;
      this.launchObservation(effect, expectedRevision, this.observer);
      return effect;
    });
  }

  /**
   * Stop accepting commands, drain accepted commands, then mark effects owned
   * by this process ambiguous. The ambiguity evidence advances each affected
   * run revision and appends a durable event so a late callback is stale.
   */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.accepting = false;
    this.closePromise = this.drainAndMarkAmbiguous();
    return this.closePromise;
  }

  private async drainAndMarkAmbiguous(): Promise<void> {
    await this.waitForIdle();
    await this.markOwnedEffectsAmbiguous(
      "Coordinator closed before an external effect receipt was observed.",
    );
  }

  private async markOwnedEffectsAmbiguous(evidence: string): Promise<void> {
    const changed = await this.connection.db
      .transaction()
      .execute(async (tx) => {
        const changed = await createEffectMutationRepository(
          tx,
        ).markOwnedInFlightAmbiguous(this.ownerToken, evidence, this.now());
        const runIds = new Set(changed.map((effect) => effect.runId));
        for (const runId of runIds) {
          const run = await readRun(tx, runId);
          const nextRevision = run.revision + 1;
          const at = this.now();
          const updated = await tx
            .updateTable("runs")
            .set({ revision: nextRevision, updated_at: at })
            .where("id", "=", runId)
            .where("revision", "=", run.revision)
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows) !== 1) continue;
          const previous = await tx
            .selectFrom("events")
            .select("sequence")
            .where("run_id", "=", runId)
            .orderBy("sequence", "desc")
            .limit(1)
            .executeTakeFirst();
          await tx
            .insertInto("events")
            .values({
              id: randomUUID(),
              run_id: runId,
              sequence: (previous?.sequence ?? 0) + 1,
              run_revision: nextRevision,
              kind: "effect_ambiguous",
              summary: evidence,
              details_json: null,
              log_reference: null,
              created_at: at,
            })
            .execute();
        }
        return changed;
      });
    for (const effect of changed) this.notifyEffectSettlement(effect);
  }

  private enqueueObservation(
    effect: EffectRecord,
    expectedRevision: number,
    source: "dispatcher" | "observer",
    result: EffectResult,
  ): void {
    const normalized = effectResult(result, effect);
    const observation: ObserveEffectCommand = {
      runId: effect.runId,
      expectedRevision,
      effectKey: effect.key,
      outcome: normalized.outcome,
      evidence:
        normalized.evidence ??
        `Observed effect ${effect.key} ${normalized.outcome}.`,
    };
    if (normalized.trigger !== undefined)
      observation.trigger = normalized.trigger;
    if (normalized.receipt !== undefined)
      observation.receipt = normalized.receipt;
    void this.submitObservation(observation, source === "observer").catch(
      (error: unknown) => {
        this.handleObservationFailure(effect, expectedRevision, source, error);
      },
    );
  }

  private submitObservation(
    command: ObserveEffectCommand,
    allowQuarantined = false,
  ): Promise<EffectRecord | undefined> {
    const result = this.enqueue(async () => {
      const at = asTimestamp(this.now, command.at);
      return this.connection.db.transaction().execute(async (tx) => {
        const current = await tx
          .selectFrom("side_effects")
          .select(["run_id", "status"])
          .where("key", "=", command.effectKey)
          .executeTakeFirst();
        if (current === undefined)
          throw new StaleEffectError(
            command.effectKey,
            command.expectedRevision,
          );
        const run = await readRun(tx, current.run_id);
        const effectIsSettled =
          current.status !== "pending" && current.status !== "in_flight";
        const quarantineMarker = JSON.stringify({
          effectKey: command.effectKey,
        });
        const quarantine = await tx
          .selectFrom("events")
          .select("sequence")
          .where("run_id", "=", current.run_id)
          .where("kind", "=", quarantinedEffectEventKind)
          .where("details_json", "=", quarantineMarker)
          .executeTakeFirst();
        if (
          run.revision !== command.expectedRevision ||
          (effectIsSettled && current.status !== "ambiguous") ||
          (quarantine !== undefined && !allowQuarantined)
        )
          throw new StaleEffectError(
            command.effectKey,
            command.expectedRevision,
          );
        return createEffectMutationRepository(tx).recordEffectObservation(
          command,
          at,
        );
      });
    });
    return result.then((effect) => {
      if (effect !== undefined) this.notifyEffectSettlement(effect);
      return effect;
    });
  }

  private handleObservationFailure(
    effect: EffectRecord,
    expectedRevision: number,
    source: "dispatcher" | "observer",
    failure: unknown,
  ): void {
    const error = errorValue(failure);
    const code: CoordinatorErrorCode =
      error instanceof CoordinatorClosedError
        ? "closed"
        : error instanceof StaleEffectError ||
            error instanceof StaleRevisionError
          ? "stale"
          : "unexpected";
    const report: CoordinatorError = {
      code,
      source,
      effectKey: effect.key,
      expectedRevision,
      error,
    };
    this.observationErrors.push(report);
    try {
      this.onError?.(report);
    } catch {
      // Error sinks are diagnostics and cannot become detached async throws.
    }
    if (code === "closed") return;
    const evidence = boundedEvidence(
      `${source} observation for ${effect.key} could not be recorded (${code}): ${error.message}`,
    );
    if (!this.accepting) return;
    void this.enqueue(() =>
      this.markEffectAmbiguous(effect.key, evidence),
    ).catch((markFailure: unknown) => {
      const markError = errorValue(markFailure);
      const markReport: CoordinatorError = {
        code: "unexpected",
        source,
        effectKey: effect.key,
        expectedRevision,
        error: markError,
      };
      this.observationErrors.push(markReport);
      try {
        this.onError?.(markReport);
      } catch {
        // Diagnostics remain best-effort and never escape a callback.
      }
    });
  }

  private async markEffectAmbiguous(
    effectKey: string,
    evidence: string,
  ): Promise<void> {
    await this.connection.db.transaction().execute(async (tx) => {
      const effect = await tx
        .selectFrom("side_effects")
        .selectAll()
        .where("key", "=", effectKey)
        .executeTakeFirst();
      if (
        effect === undefined ||
        effect.status !== "in_flight" ||
        effect.executor_owner_token !== this.ownerToken
      )
        return;
      const at = this.now();
      const updated = await tx
        .updateTable("side_effects")
        .set({
          status: "ambiguous",
          reconciliation_evidence: evidence,
          updated_at: at,
        })
        .where("key", "=", effectKey)
        .where("status", "=", "in_flight")
        .where("executor_owner_token", "=", this.ownerToken)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) return;

      const run = await readRun(tx, effect.run_id);
      const nextRevision = run.revision + 1;
      const updatedRun = await tx
        .updateTable("runs")
        .set({ revision: nextRevision, updated_at: at })
        .where("id", "=", run.id)
        .where("revision", "=", run.revision)
        .executeTakeFirst();
      if (Number(updatedRun.numUpdatedRows) !== 1) return;
      const previous = await tx
        .selectFrom("events")
        .select("sequence")
        .where("run_id", "=", run.id)
        .orderBy("sequence", "desc")
        .limit(1)
        .executeTakeFirst();
      await tx
        .insertInto("events")
        .values({
          id: randomUUID(),
          run_id: run.id,
          sequence: (previous?.sequence ?? 0) + 1,
          run_revision: nextRevision,
          kind: "effect_ambiguous",
          summary: evidence,
          details_json: null,
          log_reference: null,
          created_at: at,
        })
        .execute();
    });
  }

  private withTargetRevision(
    command: EffectIntentCommand,
    targetRevision: number,
  ): NewEffectIntent {
    const {
      dispatch: _dispatch,
      targetRevision: _targetRevision,
      ...intent
    } = command;
    return { ...intent, targetRevision };
  }

  private async beginAndDispatch(
    effectKey: string,
    atInput?: string,
  ): Promise<EffectRecord> {
    const at = asTimestamp(this.now, atInput);
    const inFlight = await this.connection.db
      .transaction()
      .execute((tx) =>
        createEffectMutationRepository(tx).markEffectInFlight(
          effectKey,
          this.ownerToken,
          at,
        ),
      );
    this.launchDispatch(inFlight);
    return inFlight;
  }

  private launchDispatch(effect: EffectRecord): void {
    const dispatcher = this.dispatcher;
    if (dispatcher === undefined) return;
    let completed = false;
    const complete: EffectCompletion = (result) => {
      if (completed) return;
      completed = true;
      const normalized = safeNormalizeAdapterResult(
        result,
        effect,
        "dispatcher",
        false,
      );
      if (normalized !== undefined)
        this.enqueueObservation(
          effect,
          effect.targetRevision,
          "dispatcher",
          normalized,
        );
    };
    try {
      const result =
        typeof dispatcher === "function"
          ? dispatcher(effect, complete)
          : dispatcher.dispatch(effect, complete);
      void Promise.resolve(result).then(
        (value) => {
          const normalized = safeNormalizeAdapterResult(
            value,
            effect,
            "dispatcher",
            true,
          );
          if (normalized !== undefined) complete(normalized);
        },
        (error: unknown) => {
          complete({
            outcome: "failed",
            evidence: `Effect ${effect.key} dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        },
      );
    } catch (error) {
      complete({
        outcome: "failed",
        evidence: `Effect ${effect.key} dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private launchObservation(
    effect: EffectRecord,
    expectedRevision: number,
    observer: EffectObserverLike,
  ): void {
    let completed = false;
    const complete: EffectCompletion = (result) => {
      if (completed) return;
      completed = true;
      const normalized = safeNormalizeAdapterResult(
        result,
        effect,
        "observer",
        false,
      );
      if (normalized !== undefined)
        this.enqueueObservation(
          effect,
          expectedRevision,
          "observer",
          normalized,
        );
    };
    try {
      const result =
        typeof observer === "function"
          ? observer(effect, complete)
          : observer.observe(effect, complete);
      void Promise.resolve(result).then(
        (value) => {
          const normalized = safeNormalizeAdapterResult(
            value,
            effect,
            "observer",
            true,
          );
          if (normalized !== undefined) complete(normalized);
        },
        (error: unknown) => {
          complete({
            outcome: "failed",
            evidence: `Effect ${effect.key} observation failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        },
      );
    } catch (error) {
      complete({
        outcome: "failed",
        evidence: `Effect ${effect.key} observation failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private notifyEffectSettlement(effect: EffectRecord): void {
    if (
      !new Set<EffectStatus>([
        "confirmed",
        "failed",
        "cancelled",
        "ambiguous",
      ]).has(effect.status)
    )
      return;
    const waiters = this.effectSettlementWaiters.get(effect.key);
    if (waiters === undefined) return;
    this.effectSettlementWaiters.delete(effect.key);
    for (const waiter of waiters) waiter(effect);
  }

  private enqueue<T>(command: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new CoordinatorClosedError());
    return this.enqueueCommand(command, false);
  }

  /**
   * Quarantine commands run before commands waiting in the FIFO, while still
   * waiting for a command already in progress. This lets a durable ambiguity
   * record invalidate callbacks that were queued earlier.
   */
  private enqueuePriority<T>(command: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new CoordinatorClosedError());
    return this.enqueueCommand(command, true);
  }

  private enqueueCommand<T>(
    command: () => Promise<T>,
    priority: boolean,
  ): Promise<T> {
    if (!this.draining && this.commandQueue.length === 0) {
      this.idle = new Promise<void>((resolve) => {
        this.resolveIdle = resolve;
      });
    }
    const result = new Promise<T>((resolve, reject) => {
      const entry = {
        command: async (): Promise<unknown> => command(),
        resolve: (value: unknown): void => resolve(value as T),
        reject,
      };
      if (priority) this.commandQueue.unshift(entry);
      else this.commandQueue.push(entry);
    });
    this.scheduleDrain();
    return result;
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    const entry = this.commandQueue.shift();
    if (entry === undefined) {
      this.draining = false;
      const resolveIdle = this.resolveIdle;
      this.resolveIdle = undefined;
      resolveIdle?.();
      return;
    }
    try {
      entry.resolve(await entry.command());
    } catch (error) {
      entry.reject(error);
    }
    // Yield between commands so callers can enqueue a priority quarantine
    // after a command resolves but before its already-queued callbacks run.
    queueMicrotask(() => {
      void this.drainQueue();
    });
  }
}

export type CoordinatorCommand =
  | ReturnType<WorkflowCoordinator["createClaim"]>
  | ReturnType<WorkflowCoordinator["transition"]>
  | ReturnType<WorkflowCoordinator["createEffectIntent"]>
  | ReturnType<WorkflowCoordinator["beginEffect"]>
  | ReturnType<WorkflowCoordinator["observeEffect"]>
  | ReturnType<WorkflowCoordinator["cancelEffect"]>
  | ReturnType<WorkflowCoordinator["updateSchedulerControl"]>;

export type CoordinatorEffectOutcome = EffectStatus;
