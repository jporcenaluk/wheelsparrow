import type { DatabaseConnection } from "../database/connection.js";
import {
  type EffectRecord,
  listUnresolvedForReconciliation,
  type ReconciliationItem,
} from "../database/effects.js";
import type { WorkflowCoordinator } from "./coordinator.js";
import { EffectSettlementTimeoutError } from "./coordinator.js";
import type { EffectStatus } from "./state.js";

/** A startup adapter that is required for one or more durable effects. */
export type ReconciliationAdapter = "dispatcher" | "observer";

export class ReconciliationAdapterUnavailableError extends Error {
  readonly adapter: ReconciliationAdapter;
  readonly effectKey: string;
  readonly status: EffectStatus;

  constructor(effect: EffectRecord, adapter: ReconciliationAdapter) {
    super(
      `Startup reconciliation requires a ${adapter} for ${effect.status} effect ${effect.key}.`,
    );
    this.name = "ReconciliationAdapterUnavailableError";
    this.adapter = adapter;
    this.effectKey = effect.key;
    this.status = effect.status;
  }
}

/** Compatibility alias for callers that prefer the shorter error name. */
export {
  ReconciliationAdapterUnavailableError as MissingReconciliationAdapterError,
};

export class ReconciliationAdapterResultError extends Error {
  readonly adapter: ReconciliationAdapter;
  readonly effectKey: string;

  constructor(
    effect: EffectRecord,
    adapter: ReconciliationAdapter,
    reason: string,
  ) {
    super(`${adapter} result for ${effect.key} is invalid: ${reason}`);
    this.name = "ReconciliationAdapterResultError";
    this.adapter = adapter;
    this.effectKey = effect.key;
  }
}

export class ReconciliationIncompleteError extends Error {
  readonly effectKeys: readonly string[];

  constructor(effectKeys: readonly string[]) {
    super(
      `Startup reconciliation could not resolve durable effects: ${effectKeys.join(", ")}.`,
    );
    this.name = "ReconciliationIncompleteError";
    this.effectKeys = [...effectKeys];
  }
}

export class ReconciliationTimeoutError extends ReconciliationIncompleteError {
  readonly effectKey: string;
  readonly timeoutMs: number;

  constructor(effectKey: string, timeoutMs: number, cause: unknown) {
    super([effectKey]);
    this.name = "ReconciliationTimeoutError";
    this.effectKey = effectKey;
    this.timeoutMs = timeoutMs;
    this.cause = cause;
  }
}

export interface ReconciliationOptions {
  connection: DatabaseConnection;
  coordinator: Pick<
    WorkflowCoordinator,
    | "beginEffect"
    | "cancelEffect"
    | "observeEffect"
    | "observeAmbiguousEffect"
    | "waitForEffectSettlement"
    | "hasEffectDispatcher"
    | "hasEffectObserver"
  >;
  /**
   * Capability declarations used for startup preflight. The coordinator owns
   * adapter invocation and callback normalization; these values are never
   * called by reconciliation.
   */
  dispatcher?: unknown;
  observer?: unknown;
  now?: () => string;
  settlementTimeoutMs?: number;
}

export interface ReconciliationResult {
  inspected: number;
  canceled: readonly string[];
  dispatched: readonly string[];
  observed: readonly string[];
  unresolved: readonly string[];
}

/**
 * Read unresolved effects in a stable order. This is deliberately a read-only
 * operation; every mutation made by reconciliation is submitted to the
 * serialized WorkflowCoordinator below.
 */
export async function listReconciliationItems(
  connection: DatabaseConnection,
): Promise<ReconciliationItem[]> {
  const items = await listUnresolvedForReconciliation(connection.db);
  return items.toSorted((left, right) => {
    const runOrder = left.run.id.localeCompare(right.run.id);
    if (runOrder !== 0) return runOrder;
    const keyOrder = left.effect.key.localeCompare(right.effect.key);
    if (keyOrder !== 0) return keyOrder;
    return left.effect.status.localeCompare(right.effect.status);
  });
}

function timestamp(now: () => string): string {
  return now();
}

function ambiguityEvidence(effect: EffectRecord): string {
  return `Effect ${effect.key} was in flight during startup; external state requires observation.`;
}

/**
 * Reconcile durable effects before the listener starts.
 *
 * Pending effects whose target revision is still current are safe to begin,
 * but only with a dispatcher. A pending intent targeting any other revision
 * is stale and is canceled with evidence. In-flight effects are first moved
 * to ambiguous through the coordinator, then observed; neither in-flight nor
 * ambiguous effects is ever dispatched again.
 */
export async function reconcileEffects(
  options: ReconciliationOptions,
): Promise<ReconciliationResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const settlementTimeoutMs = options.settlementTimeoutMs ?? 30_000;
  const items = await listReconciliationItems(options.connection);

  // Validate all capabilities before taking any action. A failed startup
  // should not leave a partially reconciled database behind.
  for (const item of items) {
    if (
      item.effect.status === "pending" &&
      item.effect.targetRevision === item.run.revision
    ) {
      if (!options.coordinator.hasEffectDispatcher)
        throw new ReconciliationAdapterUnavailableError(
          item.effect,
          "dispatcher",
        );
      continue;
    }
    if (
      item.effect.status === "in_flight" ||
      item.effect.status === "ambiguous"
    ) {
      if (!options.coordinator.hasEffectObserver)
        throw new ReconciliationAdapterUnavailableError(
          item.effect,
          "observer",
        );
    }
  }

  const canceled: string[] = [];
  const dispatched: string[] = [];
  const observed: string[] = [];

  for (const initialItem of items) {
    // A prior confirmation may advance this run's revision. Re-read before
    // every action so a later effect is classified against current state.
    const item = (await listReconciliationItems(options.connection)).find(
      ({ effect }) => effect.key === initialItem.effect.key,
    );
    if (item === undefined) continue;
    const { effect, run } = item;
    if (effect.status === "pending") {
      if (effect.targetRevision !== run.revision) {
        await options.coordinator.cancelEffect({
          effectKey: effect.key,
          expectedRevision: run.revision,
          reason: `Canceled stale pending effect at startup: target revision ${effect.targetRevision}, current revision ${run.revision}.`,
          at: timestamp(now),
        });
        canceled.push(effect.key);
        continue;
      }

      await options.coordinator.beginEffect({
        effectKey: effect.key,
        expectedRevision: run.revision,
        at: timestamp(now),
      });
      dispatched.push(effect.key);
      // beginEffect marks the intent in flight and lets the coordinator's
      // injected dispatcher callback re-enter the same FIFO queue. Waiting
      // here keeps startup behind that receipt without invoking an adapter a
      // second time.
      let settled: Awaited<
        ReturnType<
          ReconciliationOptions["coordinator"]["waitForEffectSettlement"]
        >
      >;
      try {
        settled = await options.coordinator.waitForEffectSettlement(
          effect.key,
          settlementTimeoutMs,
        );
      } catch (error) {
        if (error instanceof EffectSettlementTimeoutError)
          throw new ReconciliationTimeoutError(
            effect.key,
            settlementTimeoutMs,
            error,
          );
        throw error;
      }
      if (settled.status === "ambiguous") {
        if (!options.coordinator.hasEffectObserver)
          throw new ReconciliationAdapterUnavailableError(effect, "observer");
        await options.coordinator.observeAmbiguousEffect({
          effectKey: effect.key,
          expectedRevision: run.revision,
        });
        try {
          await options.coordinator.waitForEffectSettlement(
            effect.key,
            settlementTimeoutMs,
          );
        } catch (error) {
          if (error instanceof EffectSettlementTimeoutError)
            throw new ReconciliationTimeoutError(
              effect.key,
              settlementTimeoutMs,
              error,
            );
          throw error;
        }
      }
      continue;
    }

    if (effect.status === "in_flight") {
      await options.coordinator.observeEffect({
        runId: effect.runId,
        expectedRevision: run.revision,
        effectKey: effect.key,
        outcome: "ambiguous",
        trigger: null,
        evidence: ambiguityEvidence(effect),
        at: timestamp(now),
      });
    }
    await options.coordinator.observeAmbiguousEffect({
      effectKey: effect.key,
      expectedRevision: run.revision,
    });
    try {
      await options.coordinator.waitForEffectSettlement(
        effect.key,
        settlementTimeoutMs,
      );
    } catch (error) {
      if (error instanceof EffectSettlementTimeoutError)
        throw new ReconciliationTimeoutError(
          effect.key,
          settlementTimeoutMs,
          error,
        );
      throw error;
    }
    if (
      !(await listReconciliationItems(options.connection)).some(
        ({ effect: current }) => current.key === effect.key,
      )
    )
      observed.push(effect.key);
  }

  const unresolved = (await listReconciliationItems(options.connection)).map(
    ({ effect }) => effect.key,
  );
  if (unresolved.length > 0)
    throw new ReconciliationIncompleteError(unresolved);

  return {
    inspected: items.length,
    canceled,
    dispatched,
    observed,
    unresolved,
  };
}
