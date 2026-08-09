import { createHash } from "node:crypto";

import type { EffectRecord } from "../database/effects.js";
import { StaleEffectError } from "../database/effects.js";
import type { PublicationFactsPatch, RunRecord } from "../database/runs.js";
import { StaleRevisionError } from "../database/runs.js";
import {
  assertPullRequestReceipt,
  assertRequiredChecksReceipt,
  type GitHubPublicationGateway,
  type PullRequestReceipt,
  type RequiredChecksReceipt,
} from "../github/publication.js";
import type { WorkflowCoordinator } from "./coordinator.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const MAX_EVIDENCE_BYTES = 4 * 1024;
const MAX_TITLE_BYTES = 2_000;
const MAX_BODY_BYTES = 16 * 1_024;

export type PublicationCoordinator = Pick<
  WorkflowCoordinator,
  | "createEffectIntent"
  | "beginEffect"
  | "releaseEffectForRetry"
  | "settleExecution"
  | "quarantineEffect"
  | "transition"
>;

/** The receipt returned by the contained commit/push edge in Block 5 Task 1. */
export interface PublicationCommitReceipt {
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
}

export type CommitAndPushPublicationEdge = (
  run: RunRecord,
) => unknown | PromiseLike<unknown>;

export interface PublishApprovedRunInput {
  readonly coordinator: PublicationCoordinator;
  readonly run: RunRecord;
  readonly gateway: GitHubPublicationGateway;
  readonly commitAndPush: CommitAndPushPublicationEdge;
  readonly title: string;
  readonly body: string;
  readonly now?: () => string;
}

export interface ObservePublishedCiInput {
  readonly coordinator: PublicationCoordinator;
  readonly run: RunRecord;
  readonly gateway: GitHubPublicationGateway;
  /** The node ID returned by publishApprovedRun; it is not a mutable run fact. */
  readonly pullRequestNodeId?: string;
  readonly pullRequest?: Pick<PullRequestReceipt, "nodeId">;
  readonly now?: () => string;
}

export type PublicationOutcome =
  | {
      readonly kind: "published";
      readonly run: RunRecord;
      readonly pullRequest: PullRequestReceipt;
      readonly observeCiEffectKey: string;
    }
  | {
      readonly kind: "pending";
      readonly run: RunRecord;
      readonly effectKey: string;
      readonly checks?: RequiredChecksReceipt;
    }
  | {
      readonly kind: "human";
      readonly run: RunRecord;
      readonly reason: string;
    }
  | {
      readonly kind: "stale";
      readonly run: RunRecord;
    };

export type CiObservationOutcome =
  | {
      readonly kind: "ci_passed";
      readonly run: RunRecord;
      readonly checks: RequiredChecksReceipt;
    }
  | {
      readonly kind: "ci_pending";
      readonly run: RunRecord;
      readonly checks?: RequiredChecksReceipt;
      readonly effectKey: string;
    }
  | {
      readonly kind: "ci_failed_repairable" | "ci_failed_exhausted";
      readonly run: RunRecord;
      readonly checks: RequiredChecksReceipt;
      readonly reason: string;
    }
  | {
      readonly kind: "human";
      readonly run: RunRecord;
      readonly reason: string;
    }
  | {
      readonly kind: "stale";
      readonly run: RunRecord;
    };

interface ScheduledEffect {
  readonly effect: EffectRecord;
  readonly started: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmptyText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function bounded(value: string): string {
  let result = value;
  while (Buffer.byteLength(result, "utf8") > MAX_EVIDENCE_BYTES)
    result = result.slice(0, -1);
  return result || "Publication requires human attention.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStale(error: unknown): boolean {
  return (
    error instanceof StaleRevisionError || error instanceof StaleEffectError
  );
}

function json(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "{}" : serialized;
  } catch {
    return "{}";
  }
}

function durableFailureReceipt(
  run: RunRecord,
  reason: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    reworkEpoch: run.reworkEpoch,
    repairRound: run.repairRound,
    worktreePath: run.worktreePath,
    pullRequestNumber: run.pullRequestNumber,
    pullRequestNodeId: run.pullRequestNodeId,
    pullRequestUrl: run.pullRequestUrl,
    ...details,
    evidence: bounded(reason),
    requiredAction: bounded(reason),
  };
}

function effectKey(run: RunRecord, kind: "publish" | "observe-ci"): string {
  return `run:${run.id}:rework:${run.reworkEpoch}:round:${run.repairRound}:${kind}`;
}

function receiptPromptHash(run: RunRecord, kind: string): string {
  return createHash("sha256")
    .update(`${run.id}:${run.reworkEpoch}:${run.repairRound}:${kind}`, "utf8")
    .digest("hex");
}

function assertPublicationRun(run: RunRecord): void {
  if (
    !nonEmptyText(run.repository, 256) ||
    !Number.isSafeInteger(run.issueNumber) ||
    run.issueNumber <= 0 ||
    !nonEmptyText(run.branch, 512) ||
    !BRANCH_PATTERN.test(run.branch) ||
    !nonEmptyText(run.baseSha, 128) ||
    !SHA_PATTERN.test(run.baseSha) ||
    !nonEmptyText(run.worktreePath, 4 * 1024)
  )
    throw new Error(
      "Publishing requires the assigned worktree, branch, and base SHA.",
    );
}

function assertCommitReceipt(
  value: unknown,
  run: RunRecord,
): PublicationCommitReceipt {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["branch", "baseSha", "headSha"]) ||
    !nonEmptyText(value.branch, 512) ||
    !nonEmptyText(value.baseSha, 128) ||
    !nonEmptyText(value.headSha, 128) ||
    !SHA_PATTERN.test(value.baseSha) ||
    !SHA_PATTERN.test(value.headSha) ||
    value.branch !== run.branch ||
    value.baseSha !== run.baseSha ||
    value.headSha === run.headSha
  ) {
    throw new Error(
      "Commit/push receipt does not match the assigned branch and base or did not advance HEAD.",
    );
  }
  return {
    branch: value.branch,
    baseSha: value.baseSha,
    headSha: value.headSha,
  };
}

function assertLinkedPullRequest(
  value: unknown,
  run: RunRecord,
  commit: PublicationCommitReceipt,
  title: string,
): PullRequestReceipt {
  const receipt = assertPullRequestReceipt(value);
  if (
    receipt.repository !== run.repository ||
    receipt.issueNumber !== run.issueNumber ||
    receipt.title !== title ||
    receipt.baseBranch !== run.baseBranch ||
    receipt.baseSha !== commit.baseSha ||
    receipt.headBranch !== commit.branch ||
    receipt.headSha !== commit.headSha ||
    receipt.isDraft
  )
    throw new Error(
      "Pull request receipt is not the linked non-draft PR for the exact branch, base, and head.",
    );
  return receipt;
}

async function handoffScheduledEffect(
  input: PublishApprovedRunInput | ObservePublishedCiInput,
  scheduled: ScheduledEffect,
  reason: string,
  step: ReturnType<typeof publicationStep> | ReturnType<typeof ciStep>,
  now: () => string,
): Promise<PublicationOutcome | CiObservationOutcome> {
  if (scheduled.effect.status === "ambiguous")
    return failClosed(
      input.coordinator,
      input.run,
      scheduled.effect,
      reason,
      durableFailureReceipt(input.run, reason, { kind: "ambiguous" }),
      step,
      now,
    );
  try {
    const handedOff = await input.coordinator.transition({
      runId: input.run.id,
      expectedRevision: input.run.revision,
      trigger: "handoff_required",
      at: now(),
      summary: { text: bounded(reason) },
      requiredAction: bounded(reason),
    });
    return { kind: "human", run: handedOff, reason: bounded(reason) };
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: input.run };
    return { kind: "human", run: input.run, reason: bounded(reason) };
  }
}

async function schedule(
  coordinator: PublicationCoordinator,
  run: RunRecord,
  key: string,
  kind: "publish" | "observe_ci",
  intent: unknown,
  now: () => string,
): Promise<ScheduledEffect> {
  const created = await coordinator.createEffectIntent({
    runId: run.id,
    expectedRevision: run.revision,
    key,
    kind,
    intent,
    dispatch: false,
    at: now(),
  });
  if (created.status !== "pending") return { effect: created, started: false };
  return {
    effect: await coordinator.beginEffect({
      effectKey: created.key,
      expectedRevision: run.revision,
      at: now(),
    }),
    started: true,
  };
}

function publicationStep(
  run: RunRecord,
  status: "completed" | "failed",
  receipt: unknown,
  summary: string,
  at: string,
) {
  const attempt = run.repairRound + 1;
  return {
    id: `run:${run.id}:rework:${run.reworkEpoch}:round:${run.repairRound}:publication:attempt:${attempt}:step`,
    runId: run.id,
    expectedRevision: run.revision,
    reworkEpoch: run.reworkEpoch,
    role: "publisher",
    logicalStep: "publish",
    attempt,
    statusSequence: 1,
    status,
    promptHash: receiptPromptHash(run, "publish"),
    model: "publication-edge",
    reasoningEffort: "bounded",
    startedAt: at,
    completedAt: at,
    exitResultJson: json(receipt),
    summary: { text: bounded(summary) },
    rawLogReference: `logs/${run.id}/rework-${run.reworkEpoch}/round-${run.repairRound}/publication/attempt-${attempt}.jsonl`,
  } as const;
}

function ciStep(
  run: RunRecord,
  status: "completed" | "failed",
  receipt: unknown,
  summary: string,
  at: string,
) {
  const attempt = run.repairRound + 1;
  return {
    id: `run:${run.id}:rework:${run.reworkEpoch}:round:${run.repairRound}:ci:attempt:${attempt}:step`,
    runId: run.id,
    expectedRevision: run.revision,
    reworkEpoch: run.reworkEpoch,
    role: "ci-observer",
    logicalStep: "observe_ci",
    attempt,
    statusSequence: 1,
    status,
    promptHash: receiptPromptHash(run, "observe-ci"),
    model: "github-required-checks",
    reasoningEffort: "bounded",
    startedAt: at,
    completedAt: at,
    exitResultJson: json(receipt),
    summary: { text: bounded(summary) },
    rawLogReference: `logs/${run.id}/rework-${run.reworkEpoch}/round-${run.repairRound}/ci/attempt-${attempt}.jsonl`,
  } as const;
}

async function failClosed(
  coordinator: PublicationCoordinator,
  run: RunRecord,
  effect: EffectRecord,
  reason: string,
  receipt: unknown,
  step: ReturnType<typeof publicationStep> | ReturnType<typeof ciStep>,
  now: () => string,
): Promise<PublicationOutcome | CiObservationOutcome> {
  try {
    const settled = await coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome: "failed",
      trigger: "handoff_required",
      evidence: bounded(reason),
      receipt,
      step,
      requiredAction: bounded(reason),
      at: now(),
    });
    return { kind: "human", run: settled.run, reason: bounded(reason) };
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run };
    try {
      await coordinator.quarantineEffect({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey: effect.key,
        outcome: "ambiguous",
        trigger: null,
        evidence: bounded(`${reason} Settlement was ambiguous.`),
        at: now(),
      });
    } catch {
      // A failed quarantine is itself a fail-closed handoff; no external edge
      // is retried from this code path.
    }
    return { kind: "human", run, reason: bounded(reason) };
  }
}

export async function publishApprovedRun(
  input: PublishApprovedRunInput,
): Promise<PublicationOutcome> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.run.state !== "publishing")
    return { kind: "stale", run: input.run };
  const key = effectKey(input.run, "publish");
  const title = input.title;
  const body = input.body;
  const intent = {
    runId: input.run.id,
    reworkEpoch: input.run.reworkEpoch,
    repository: input.run.repository,
    issueNumber: input.run.issueNumber,
    worktreePath: input.run.worktreePath,
    branch: input.run.branch,
    baseBranch: input.run.baseBranch,
    baseSha: input.run.baseSha,
    previousHeadSha: input.run.headSha,
    title,
    body,
  };
  let scheduled: ScheduledEffect;
  try {
    scheduled = await schedule(
      input.coordinator,
      input.run,
      key,
      "publish",
      intent,
      now,
    );
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: input.run };
    return {
      kind: "human",
      run: input.run,
      reason: bounded(errorMessage(error)),
    };
  }
  if (!scheduled.started) {
    if (
      scheduled.effect.status === "confirmed" ||
      scheduled.effect.status === "failed"
    )
      return { kind: "stale", run: input.run };
    if (scheduled.effect.status === "in_flight")
      return { kind: "pending", run: input.run, effectKey: key };
    if (
      scheduled.effect.status === "ambiguous" ||
      scheduled.effect.status === "cancelled"
    )
      return (await handoffScheduledEffect(
        input,
        scheduled,
        `Publication effect ${scheduled.effect.status} requires reconciliation before any external mutation is attempted.`,
        publicationStep(
          input.run,
          "failed",
          { effectStatus: scheduled.effect.status },
          "Publication was handed off without retrying an uncertain effect.",
          now(),
        ),
        now,
      )) as PublicationOutcome;
    return {
      kind: "human",
      run: input.run,
      reason: "Unknown publication effect status.",
    };
  }

  let commit: PublicationCommitReceipt | undefined;
  let pullRequest: PullRequestReceipt | undefined;
  let createdPullRequest: PullRequestReceipt | undefined;
  try {
    assertPublicationRun(input.run);
    if (
      !nonEmptyText(title, MAX_TITLE_BYTES) ||
      !nonEmptyText(body, MAX_BODY_BYTES)
    )
      throw new Error(
        "Publication title and body must be bounded non-empty text.",
      );
    commit = assertCommitReceipt(
      await input.commitAndPush(input.run),
      input.run,
    );
    const request = {
      repository: input.run.repository,
      issueNumber: input.run.issueNumber,
      effectKey: key,
      title,
      body,
      baseBranch: input.run.baseBranch,
      baseSha: commit.baseSha,
      headBranch: commit.branch,
      headSha: commit.headSha,
    } as const;
    const created = await input.gateway.createPullRequest(request);
    createdPullRequest = assertLinkedPullRequest(
      created,
      input.run,
      commit,
      title,
    );
    pullRequest = assertLinkedPullRequest(
      await input.gateway.readPullRequest({
        repository: input.run.repository,
        number: createdPullRequest.number,
        issueNumber: input.run.issueNumber,
        expectedNodeId: createdPullRequest.nodeId,
        expectedTitle: title,
        expectedBaseBranch: input.run.baseBranch,
        expectedBaseSha: commit.baseSha,
        expectedHeadBranch: commit.branch,
        expectedHeadSha: commit.headSha,
      }),
      input.run,
      commit,
      title,
    );
    if (
      pullRequest.number !== createdPullRequest.number ||
      pullRequest.nodeId !== createdPullRequest.nodeId
    )
      throw new Error(
        "Pull request reread identity does not match the create receipt.",
      );
  } catch (error) {
    const reason = `Publication failed closed: ${errorMessage(error)}`;
    return (await failClosed(
      input.coordinator,
      input.run,
      scheduled.effect,
      reason,
      durableFailureReceipt(input.run, reason, {
        kind: "failed",
        ...(createdPullRequest === undefined
          ? {}
          : {
              pullRequest: createdPullRequest,
              pullRequestNumber: createdPullRequest.number,
              pullRequestNodeId: createdPullRequest.nodeId,
              pullRequestUrl: createdPullRequest.url,
            }),
        ...(commit === undefined ? {} : { commit }),
      }),
      publicationStep(
        input.run,
        "failed",
        { kind: "failed", reason },
        reason,
        now(),
      ),
      now,
    )) as PublicationOutcome;
  }

  if (commit === undefined || pullRequest === undefined)
    return { kind: "stale", run: input.run };

  const publicationFacts: PublicationFactsPatch = {
    pullRequestNumber: pullRequest.number,
    pullRequestNodeId: pullRequest.nodeId,
    pullRequestTitle: pullRequest.title,
    pullRequestUrl: pullRequest.url,
    baseSha: pullRequest.baseSha,
    headSha: pullRequest.headSha,
    branch: pullRequest.headBranch,
  };
  let settled: Awaited<ReturnType<WorkflowCoordinator["settleExecution"]>>;
  try {
    settled = await input.coordinator.settleExecution({
      runId: input.run.id,
      expectedRevision: input.run.revision,
      effectKey: scheduled.effect.key,
      outcome: "confirmed",
      trigger: "pr_observed",
      evidence: "Published and reread the linked non-draft pull request.",
      receipt: {
        reworkEpoch: input.run.reworkEpoch,
        worktreePath: input.run.worktreePath,
        commit,
        pullRequest,
        evidence: "Published and reread the linked non-draft pull request.",
        requiredAction: null,
      },
      publicationFacts,
      step: publicationStep(
        input.run,
        "completed",
        { commit, pullRequest },
        "Published the linked non-draft pull request.",
        now(),
      ),
      at: now(),
    });
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: input.run };
    return (await failClosed(
      input.coordinator,
      input.run,
      scheduled.effect,
      `Publication settlement failed closed: ${errorMessage(error)}`,
      durableFailureReceipt(input.run, errorMessage(error), {
        kind: "failed",
        ...(commit === undefined ? {} : { commit }),
        ...(pullRequest === undefined
          ? createdPullRequest === undefined
            ? {}
            : {
                pullRequest: createdPullRequest,
                pullRequestNumber: createdPullRequest.number,
                pullRequestNodeId: createdPullRequest.nodeId,
                pullRequestUrl: createdPullRequest.url,
              }
          : {
              pullRequest,
              pullRequestNumber: pullRequest.number,
              pullRequestNodeId: pullRequest.nodeId,
              pullRequestUrl: pullRequest.url,
            }),
      }),
      publicationStep(
        input.run,
        "failed",
        { kind: "failed", reason: errorMessage(error) },
        "Publication settlement failed closed.",
        now(),
      ),
      now,
    )) as PublicationOutcome;
  }

  const observeKey = effectKey(settled.run, "observe-ci");
  try {
    await input.coordinator.createEffectIntent({
      runId: settled.run.id,
      expectedRevision: settled.run.revision,
      key: observeKey,
      kind: "observe_ci",
      intent: {
        runId: settled.run.id,
        reworkEpoch: settled.run.reworkEpoch,
        repository: settled.run.repository,
        pullRequestNumber: pullRequest.number,
        pullRequestNodeId: pullRequest.nodeId,
        baseBranch: pullRequest.baseBranch,
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
      },
      dispatch: false,
      at: now(),
    });
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: input.run };
    const reason = bounded(
      `CI observation could not be scheduled: ${errorMessage(error)}`,
    );
    try {
      const handedOff = await input.coordinator.transition({
        runId: settled.run.id,
        expectedRevision: settled.run.revision,
        trigger: "handoff_required",
        at: now(),
        summary: { text: reason },
        requiredAction: reason,
      });
      return { kind: "human", run: handedOff, reason };
    } catch (handoffError) {
      if (isStale(handoffError)) return { kind: "stale", run: settled.run };
      return { kind: "human", run: settled.run, reason };
    }
  }
  return {
    kind: "published",
    run: settled.run,
    pullRequest,
    observeCiEffectKey: observeKey,
  };
}

export async function observePublishedCi(
  input: ObservePublishedCiInput,
): Promise<CiObservationOutcome> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.run.state !== "waiting_for_ci")
    return { kind: "stale", run: input.run };
  const key = effectKey(input.run, "observe-ci");
  const suppliedPullRequestNodeId =
    input.pullRequestNodeId ?? input.pullRequest?.nodeId;
  if (
    input.run.pullRequestNodeId !== null &&
    suppliedPullRequestNodeId !== undefined &&
    suppliedPullRequestNodeId !== input.run.pullRequestNodeId
  )
    return {
      kind: "human",
      run: input.run,
      reason:
        "The supplied pull request node ID conflicts with the durable PR identity.",
    };
  const pullRequestNodeId =
    input.run.pullRequestNodeId ?? suppliedPullRequestNodeId;
  let scheduled: ScheduledEffect;
  try {
    if (!nonEmptyText(pullRequestNodeId, 256))
      throw new Error(
        "The recorded pull request node ID is required for CI observation.",
      );
    scheduled = await schedule(
      input.coordinator,
      input.run,
      key,
      "observe_ci",
      {
        runId: input.run.id,
        reworkEpoch: input.run.reworkEpoch,
        repository: input.run.repository,
        pullRequestNumber: input.run.pullRequestNumber,
        pullRequestNodeId,
        baseBranch: input.run.baseBranch,
        baseSha: input.run.baseSha,
        headSha: input.run.headSha,
      },
      now,
    );
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: input.run };
    return {
      kind: "human",
      run: input.run,
      reason: bounded(errorMessage(error)),
    };
  }
  if (
    scheduled.effect.status === "confirmed" ||
    scheduled.effect.status === "failed"
  )
    return { kind: "stale", run: input.run };
  if (!scheduled.started) {
    if (scheduled.effect.status === "in_flight")
      return { kind: "ci_pending", run: input.run, effectKey: key };
    if (
      scheduled.effect.status === "ambiguous" ||
      scheduled.effect.status === "cancelled"
    )
      return (await handoffScheduledEffect(
        input,
        scheduled,
        `CI observation effect ${scheduled.effect.status} requires reconciliation before another check read is attempted.`,
        ciStep(
          input.run,
          "failed",
          { effectStatus: scheduled.effect.status },
          "CI observation was handed off without retrying an uncertain effect.",
          now(),
        ),
        now,
      )) as CiObservationOutcome;
    return {
      kind: "human",
      run: input.run,
      reason: "Unknown CI observation effect status.",
    };
  }

  let checks: RequiredChecksReceipt;
  try {
    if (
      input.run.pullRequestNumber === null ||
      input.run.pullRequestUrl === null ||
      input.run.baseSha === null ||
      input.run.headSha === null
    )
      throw new Error("Recorded pull request facts are incomplete.");
    const intent = JSON.parse(scheduled.effect.intent) as Record<
      string,
      unknown
    >;
    const intentNodeId = intent.pullRequestNodeId;
    if (
      typeof intentNodeId !== "string" ||
      pullRequestNodeId === undefined ||
      intentNodeId !== pullRequestNodeId ||
      input.run.pullRequestNodeId !== intentNodeId
    )
      throw new Error(
        "The CI observation intent is not bound to the durable pull request node ID.",
      );
    checks = assertRequiredChecksReceipt(
      await input.gateway.observeRequiredChecks({
        repository: input.run.repository,
        number: input.run.pullRequestNumber,
        nodeId: intentNodeId,
        expectedBaseBranch: input.run.baseBranch,
        expectedBaseSha: input.run.baseSha,
        expectedHeadSha: input.run.headSha,
      }),
    );
    if (
      checks.repository !== input.run.repository ||
      checks.number !== input.run.pullRequestNumber ||
      checks.nodeId !== pullRequestNodeId ||
      checks.headSha !== input.run.headSha ||
      checks.headDrift
    )
      throw new Error(
        "Required checks are not evidence for the exact recorded PR head.",
      );
  } catch (error) {
    const reason = `CI observation failed closed: ${errorMessage(error)}`;
    return (await failClosed(
      input.coordinator,
      input.run,
      scheduled.effect,
      reason,
      durableFailureReceipt(input.run, reason, { kind: "failed" }),
      ciStep(input.run, "failed", { kind: "failed", reason }, reason, now()),
      now,
    )) as CiObservationOutcome;
  }

  if (checks.aggregate === "pending")
    try {
      await input.coordinator.releaseEffectForRetry({
        runId: input.run.id,
        expectedRevision: input.run.revision,
        effectKey: scheduled.effect.key,
        evidence:
          "Required checks remain pending; the observation lease was released for a later poll.",
        at: now(),
      });
      return { kind: "ci_pending", run: input.run, checks, effectKey: key };
    } catch (error) {
      if (isStale(error)) return { kind: "stale", run: input.run };
      const reason = `CI pending lease could not be released: ${errorMessage(error)}`;
      return (await failClosed(
        input.coordinator,
        input.run,
        scheduled.effect,
        reason,
        durableFailureReceipt(input.run, reason, { checks }),
        ciStep(input.run, "failed", { checks }, reason, now()),
        now,
      )) as CiObservationOutcome;
    }
  if (checks.aggregate === "head_drift") {
    const reason = "CI observation detected pull-request head drift.";
    return (await failClosed(
      input.coordinator,
      input.run,
      scheduled.effect,
      reason,
      durableFailureReceipt(input.run, reason, { checks }),
      ciStep(input.run, "failed", checks, reason, now()),
      now,
    )) as CiObservationOutcome;
  }

  const failed = checks.aggregate === "failed";
  const trigger = failed
    ? input.run.repairRound < 2
      ? "ci_failed_repairable"
      : "ci_failed_exhausted"
    : "ci_passed";
  try {
    const settled = await input.coordinator.settleExecution({
      runId: input.run.id,
      expectedRevision: input.run.revision,
      effectKey: scheduled.effect.key,
      outcome: failed ? "failed" : "confirmed",
      trigger,
      evidence: failed
        ? "Required CI checks failed."
        : "Required CI checks passed for the exact PR head.",
      receipt: {
        reworkEpoch: input.run.reworkEpoch,
        worktreePath: input.run.worktreePath,
        pullRequestNumber: input.run.pullRequestNumber,
        pullRequestNodeId: input.run.pullRequestNodeId,
        pullRequestUrl: input.run.pullRequestUrl,
        checks,
        evidence: failed
          ? "Required CI checks failed."
          : "Required CI checks passed for the exact PR head.",
        requiredAction:
          failed && input.run.repairRound >= 2
            ? "Required CI checks failed after the shared two-round repair budget; human Review must decide."
            : null,
      },
      step: ciStep(
        input.run,
        failed ? "failed" : "completed",
        checks,
        failed ? "Required CI checks failed." : "Required CI checks passed.",
        now(),
      ),
      ...(failed && input.run.repairRound >= 2
        ? {
            requiredAction:
              "Required CI checks failed after the shared two-round repair budget; human Review must decide.",
          }
        : {}),
      at: now(),
    });
    if (!failed) return { kind: "ci_passed", run: settled.run, checks };
    return {
      kind: trigger,
      run: settled.run,
      checks,
      reason:
        input.run.repairRound < 2
          ? "Required CI checks failed; the run entered the bounded repair loop."
          : "Required CI checks failed after the shared repair budget; human Review must decide.",
    };
  } catch (error) {
    if (isStale(error)) return { kind: "stale", run: input.run };
    return (await failClosed(
      input.coordinator,
      input.run,
      scheduled.effect,
      `CI settlement failed closed: ${errorMessage(error)}`,
      durableFailureReceipt(
        input.run,
        `CI settlement failed closed: ${errorMessage(error)}`,
        { checks },
      ),
      ciStep(
        input.run,
        "failed",
        checks,
        "CI settlement failed closed.",
        now(),
      ),
      now,
    )) as CiObservationOutcome;
  }
}

export const executePublicationStage = publishApprovedRun;
export const executeCiObservationStage = observePublishedCi;
export const observeCi = observePublishedCi;
