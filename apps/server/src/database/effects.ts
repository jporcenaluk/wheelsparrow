import { createHash } from "node:crypto";

import type { Kysely, Transaction } from "kysely";

import {
  assertEffectObservationTrigger,
  assertEffectTransition,
  EFFECT_KINDS,
  EFFECT_STATUSES,
  type EffectKind,
  type EffectStatus,
  type WorkflowTrigger,
} from "../workflow/state.js";
import {
  createRunMutationRepository,
  type RunRecord,
  readRun,
  type SanitizedSummary,
} from "./runs.js";
import type { DatabaseSchema, SideEffectsTable } from "./schema.js";

const maximumIdentifierBytes = 512;
const maximumEvidenceBytes = 4 * 1024;
const maximumJsonBytes = 1024 * 1024;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const effectKinds = new Set<string>(EFFECT_KINDS);
const effectStatuses = new Set<string>(EFFECT_STATUSES);

type DatabaseHandle = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export interface NewEffectIntent {
  key: string;
  kind: EffectKind;
  targetRevision: number;
  fingerprint?: string;
  intent: unknown;
}

export interface EffectRecord {
  key: string;
  runId: string;
  reworkEpoch: number;
  kind: EffectKind;
  targetRevision: number;
  fingerprint: string;
  intent: string;
  status: EffectStatus;
  executorAttempt: number;
  executorOwnerToken: string | null;
  receipt: string | null;
  processId: number | null;
  requestId: string | null;
  prNumber: number | null;
  prNodeId: string | null;
  workflowRunId: number | null;
  startedAt: string | null;
  completedAt: string | null;
  failure: string | null;
  reconciliationEvidence: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The result is both record-shaped and explicitly exposes the idempotency flag. */
export interface EffectInsertResult extends EffectRecord {
  inserted: boolean;
  record: EffectRecord;
  effect: EffectRecord;
}

export interface EffectObservation {
  runId: string;
  expectedRevision: number;
  effectKey: string;
  outcome: "confirmed" | "failed" | "ambiguous";
  trigger?: WorkflowTrigger | null;
  receipt?: unknown;
  evidence: string;
}

export interface ReconciliationItem {
  effect: EffectRecord;
  run: RunRecord;
}

export class EffectConflictError extends Error {
  readonly effectKey: string;

  constructor(effectKey: string) {
    super("The durable effect key conflicts with an existing intent.");
    this.name = "EffectConflictError";
    this.effectKey = effectKey;
  }
}

export class EffectNotFoundError extends Error {
  readonly effectKey: string;

  constructor(effectKey: string) {
    super("The durable effect was not found.");
    this.name = "EffectNotFoundError";
    this.effectKey = effectKey;
  }
}

export class StaleEffectError extends Error {
  readonly effectKey: string | null;
  readonly expectedRevision: number | null;

  constructor(
    effectKey: string | null = null,
    expectedRevision: number | null = null,
  ) {
    super("The durable effect or run revision is stale.");
    this.name = "StaleEffectError";
    this.effectKey = effectKey;
    this.expectedRevision = expectedRevision;
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

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${label} must be a non-negative integer.`);
  return value as number;
}

function increment(value: number, label: string): number {
  if (value >= Number.MAX_SAFE_INTEGER)
    throw new RangeError(`${label} cannot exceed the safe integer limit.`);
  return value + 1;
}

function normalizeJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("JSON contains an invalid number.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item));
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError("JSON intent must contain plain objects.");
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).toSorted())
      result[key] = normalizeJson((value as Record<string, unknown>)[key]);
    return result;
  }
  throw new TypeError("JSON intent contains an unsupported value.");
}

function canonicalJson(value: unknown, label: string): string {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new TypeError(`${label} must be valid JSON.`);
    }
  }
  const serialized = JSON.stringify(normalizeJson(parsed));
  if (serialized === undefined)
    throw new TypeError(`${label} must be valid JSON.`);
  if (byteLength(serialized) > maximumJsonBytes)
    throw new RangeError(`${label} exceeds its size limit.`);
  return serialized;
}

function canonicalReceipt(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return canonicalJson(value, "Receipt");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseStatus(value: string): EffectStatus {
  if (!effectStatuses.has(value))
    throw new Error("Invalid persisted effect status.");
  return value as EffectStatus;
}

function parseKind(value: string): EffectKind {
  if (!effectKinds.has(value))
    throw new Error("Invalid persisted effect kind.");
  return value as EffectKind;
}

function mapEffect(row: SideEffectsTable): EffectRecord {
  return {
    key: row.key,
    runId: row.run_id,
    reworkEpoch: row.rework_epoch,
    kind: parseKind(row.kind),
    targetRevision: row.target_revision,
    fingerprint: row.fingerprint,
    intent: row.intent_json,
    status: parseStatus(row.status),
    executorAttempt: row.executor_attempt,
    executorOwnerToken: row.executor_owner_token,
    receipt: row.receipt_json,
    processId: row.process_id,
    requestId: row.request_id,
    prNumber: row.pr_number,
    prNodeId: row.pr_node_id,
    workflowRunId: row.workflow_run_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failure: row.failure,
    reconciliationEvidence: row.reconciliation_evidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readEffectRow(
  db: DatabaseHandle,
  key: string,
): Promise<SideEffectsTable> {
  const row = await db
    .selectFrom("side_effects")
    .selectAll()
    .where("key", "=", key)
    .executeTakeFirst();
  if (row === undefined) throw new EffectNotFoundError(key);
  return row;
}

function makeInsertResult(
  record: EffectRecord,
  inserted: boolean,
): EffectInsertResult {
  return { ...record, inserted, record, effect: record };
}

function sameIntent(
  row: SideEffectsTable,
  run: RunRecord,
  intent: NewEffectIntent,
  fingerprint: string,
  canonicalIntent: string,
): boolean {
  return (
    row.run_id === run.id &&
    row.rework_epoch === run.reworkEpoch &&
    row.kind === intent.kind &&
    row.target_revision === intent.targetRevision &&
    row.fingerprint === fingerprint &&
    row.intent_json === canonicalIntent
  );
}

export interface EffectMutationRepository {
  insertEffectIntent(
    run: RunRecord,
    intent: NewEffectIntent,
    at: string,
  ): Promise<EffectInsertResult>;
  markEffectInFlight(
    key: string,
    ownerToken: string,
    at: string,
  ): Promise<EffectRecord>;
  recordEffectObservation(
    observation: EffectObservation,
    at: string,
  ): Promise<EffectRecord>;
  cancelPendingEffect(
    key: string,
    reason: string,
    at: string,
  ): Promise<EffectRecord>;
  markOwnedInFlightAmbiguous(
    ownerToken: string,
    evidence: string,
    at: string,
  ): Promise<EffectRecord[]>;
  listUnresolvedForReconciliation(
    db?: DatabaseHandle,
  ): Promise<ReconciliationItem[]>;
}

export function createEffectMutationRepository(
  tx: Transaction<DatabaseSchema>,
): EffectMutationRepository {
  return {
    async insertEffectIntent(run, intent, at): Promise<EffectInsertResult> {
      const key = identifier(intent.key, "Effect key");
      const kind = identifier(intent.kind, "Effect kind") as EffectKind;
      if (!effectKinds.has(kind))
        throw new TypeError("Effect kind is invalid.");
      const targetRevision = nonNegativeInteger(
        intent.targetRevision,
        "Effect target revision",
      );
      const timestamp = identifier(at, "Timestamp");
      const canonicalIntent = canonicalJson(intent.intent, "Intent");
      const calculatedFingerprint = sha256(canonicalIntent);
      const fingerprint = intent.fingerprint ?? calculatedFingerprint;
      const existing = await tx
        .selectFrom("side_effects")
        .selectAll()
        .where("key", "=", key)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (
          typeof fingerprint !== "string" ||
          !sha256Pattern.test(fingerprint) ||
          fingerprint !== calculatedFingerprint ||
          !sameIntent(existing, run, intent, fingerprint, canonicalIntent)
        )
          throw new EffectConflictError(key);
        return makeInsertResult(mapEffect(existing), false);
      }
      const durableRun = await readRun(tx, identifier(run.id, "Run ID"));
      if (
        durableRun.revision !== run.revision ||
        durableRun.state !== run.state ||
        durableRun.reworkEpoch !== run.reworkEpoch ||
        targetRevision !== durableRun.revision
      )
        throw new StaleEffectError(key, run.revision);
      if (typeof fingerprint !== "string" || !sha256Pattern.test(fingerprint))
        throw new TypeError(
          "Effect fingerprint must be a lowercase SHA-256 hash.",
        );
      if (fingerprint !== calculatedFingerprint)
        throw new TypeError(
          "Effect fingerprint does not match the canonical intent.",
        );
      try {
        await tx
          .insertInto("side_effects")
          .values({
            key,
            run_id: run.id,
            rework_epoch: run.reworkEpoch,
            kind,
            target_revision: targetRevision,
            fingerprint,
            intent_json: canonicalIntent,
            receipt_json: null,
            status: "pending",
            executor_attempt: 0,
            executor_owner_token: null,
            process_id: null,
            request_id: null,
            pr_number: null,
            pr_node_id: null,
            workflow_run_id: null,
            started_at: null,
            completed_at: null,
            failure: null,
            reconciliation_evidence: null,
            created_at: timestamp,
            updated_at: timestamp,
          })
          .execute();
      } catch {
        // A second SQLite connection may have won the same-key race after our
        // read. Re-read and apply the same idempotency contract without
        // exposing the driver's SQL error or payload.
        let raced: SideEffectsTable | undefined;
        try {
          raced = await tx
            .selectFrom("side_effects")
            .selectAll()
            .where("key", "=", key)
            .executeTakeFirst();
        } catch {
          throw new Error("The durable effect write could not be completed.");
        }
        if (
          raced !== undefined &&
          sameIntent(raced, run, intent, fingerprint, canonicalIntent)
        )
          return makeInsertResult(mapEffect(raced), false);
        if (raced !== undefined) throw new EffectConflictError(key);
        throw new Error("The durable effect write could not be completed.");
      }
      return makeInsertResult(mapEffect(await readEffectRow(tx, key)), true);
    },

    async markEffectInFlight(
      keyInput,
      ownerTokenInput,
      atInput,
    ): Promise<EffectRecord> {
      const key = identifier(keyInput, "Effect key");
      const ownerToken = identifier(ownerTokenInput, "Executor owner token");
      const at = identifier(atInput, "Timestamp");
      const current = await readEffectRow(tx, key);
      if (current.status === "pending") {
        const run = await readRun(tx, current.run_id);
        if (run.revision !== current.target_revision)
          throw new StaleEffectError(key, current.target_revision);
      }
      assertEffectTransition(parseStatus(current.status), "in_flight");
      const attempt = increment(current.executor_attempt, "Executor attempt");
      const update = await tx
        .updateTable("side_effects")
        .set({
          status: "in_flight",
          executor_attempt: attempt,
          executor_owner_token: ownerToken,
          started_at: at,
          updated_at: at,
        })
        .where("key", "=", key)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (Number(update.numUpdatedRows) !== 1) throw new StaleEffectError(key);
      return mapEffect(await readEffectRow(tx, key));
    },

    async recordEffectObservation(observation, atInput): Promise<EffectRecord> {
      const runId = identifier(observation.runId, "Run ID");
      const key = identifier(observation.effectKey, "Effect key");
      const expectedRevision = nonNegativeInteger(
        observation.expectedRevision,
        "Expected revision",
      );
      const at = identifier(atInput, "Timestamp");
      const evidence = boundedText(
        observation.evidence,
        "Observation evidence",
        maximumEvidenceBytes,
      );
      if (!["confirmed", "failed", "ambiguous"].includes(observation.outcome))
        throw new TypeError("Observation outcome is invalid.");
      const nextStatus = observation.outcome as EffectStatus;
      const current = await readEffectRow(tx, key);
      if (current.run_id !== runId)
        throw new StaleEffectError(key, expectedRevision);
      const run = await readRun(tx, runId);
      if (run.revision !== expectedRevision)
        throw new StaleEffectError(key, expectedRevision);
      const trigger = observation.trigger ?? null;
      assertEffectTransition(parseStatus(current.status), nextStatus);
      assertEffectObservationTrigger(
        parseKind(current.kind),
        nextStatus,
        trigger,
      );

      let changedRun = run;
      if (trigger !== null) {
        const summary: SanitizedSummary = { text: evidence };
        changedRun = await createRunMutationRepository(tx).transitionRun({
          runId,
          expectedRevision,
          trigger,
          at,
          summary,
        });
      }
      const receipt = canonicalReceipt(observation.receipt);
      const update = await tx
        .updateTable("side_effects")
        .set({
          status: nextStatus,
          receipt_json: receipt,
          reconciliation_evidence: evidence,
          failure: nextStatus === "failed" ? evidence : current.failure,
          completed_at: nextStatus === "ambiguous" ? null : at,
          updated_at: at,
        })
        .where("key", "=", key)
        .where("run_id", "=", runId)
        .where("status", "=", current.status)
        .executeTakeFirst();
      if (Number(update.numUpdatedRows) !== 1)
        throw new StaleEffectError(key, expectedRevision);
      void changedRun;
      return mapEffect(await readEffectRow(tx, key));
    },

    async cancelPendingEffect(
      keyInput,
      reasonInput,
      atInput,
    ): Promise<EffectRecord> {
      const key = identifier(keyInput, "Effect key");
      const reason = boundedText(
        reasonInput,
        "Cancellation reason",
        maximumEvidenceBytes,
      );
      const at = identifier(atInput, "Timestamp");
      const current = await readEffectRow(tx, key);
      assertEffectTransition(parseStatus(current.status), "cancelled");
      const update = await tx
        .updateTable("side_effects")
        .set({
          status: "cancelled",
          failure: reason,
          completed_at: at,
          updated_at: at,
        })
        .where("key", "=", key)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (Number(update.numUpdatedRows) !== 1) throw new StaleEffectError(key);
      return mapEffect(await readEffectRow(tx, key));
    },

    async markOwnedInFlightAmbiguous(ownerTokenInput, evidenceInput, atInput) {
      const ownerToken = identifier(ownerTokenInput, "Executor owner token");
      const evidence = boundedText(
        evidenceInput,
        "Reconciliation evidence",
        maximumEvidenceBytes,
      );
      const at = identifier(atInput, "Timestamp");
      const rows = await tx
        .selectFrom("side_effects")
        .selectAll()
        .where("status", "=", "in_flight")
        .where("executor_owner_token", "=", ownerToken)
        .orderBy("key", "asc")
        .execute();
      const result: EffectRecord[] = [];
      for (const row of rows) {
        assertEffectTransition(parseStatus(row.status), "ambiguous");
        const update = await tx
          .updateTable("side_effects")
          .set({
            status: "ambiguous",
            reconciliation_evidence: evidence,
            updated_at: at,
          })
          .where("key", "=", row.key)
          .where("status", "=", "in_flight")
          .where("executor_owner_token", "=", ownerToken)
          .executeTakeFirst();
        if (Number(update.numUpdatedRows) === 1)
          result.push(mapEffect(await readEffectRow(tx, row.key)));
      }
      return result;
    },

    async listUnresolvedForReconciliation(db = tx) {
      return listUnresolvedForReconciliation(db);
    },
  };
}

export async function listUnresolvedForReconciliation(
  db: DatabaseHandle,
): Promise<ReconciliationItem[]> {
  const rows = await db
    .selectFrom("side_effects")
    .selectAll()
    .where("status", "in", ["pending", "in_flight", "ambiguous"])
    .orderBy("run_id", "asc")
    .orderBy("key", "asc")
    .execute();
  const result: ReconciliationItem[] = [];
  for (const row of rows) {
    result.push({ effect: mapEffect(row), run: await readRun(db, row.run_id) });
  }
  return result;
}
