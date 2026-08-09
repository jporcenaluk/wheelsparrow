import { createHash } from "node:crypto";
import {
  parseRepairTerminalResult,
  type RepairFindingInput,
  type RepairPromptInput,
  type RepairTerminalResult,
} from "../agents/repair.js";
import {
  parseReviewerTerminalResult,
  type ReviewerPromptInput,
  type ReviewerTerminalResult,
} from "../agents/reviewer.js";
import type { EffectRecord } from "../database/effects.js";
import type { NewFindingRecord, RunRecord } from "../database/runs.js";
import {
  type ExecutionCoordinator,
  executeClaimedRun,
  type IntakeCapture,
  type VerificationAdapter,
  type WorkspaceInspection,
  type WorkspacePreparationReceipt,
} from "./execution.js";

const sha256Pattern = /^[0-9a-f]{64}$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const maximumEvidenceBytes = 4 * 1024;

export interface ReviewerRenderReceipt {
  readonly prompt: string;
  readonly promptHash: string;
}

export interface ReviewerInvokeInput {
  readonly issueNumber: number;
  readonly worktreePath: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly prompt: string;
  readonly promptHash: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly attempt: number;
}

export interface ReviewerAdapter {
  readonly render: (
    input: ReviewerPromptInput,
  ) => unknown | PromiseLike<unknown>;
  readonly invoke: (
    input: ReviewerInvokeInput,
  ) => unknown | PromiseLike<unknown>;
}

export interface RepairRenderReceipt {
  readonly prompt: string;
  readonly promptHash: string;
}

export interface RepairInvokeInput {
  readonly issueNumber: number;
  readonly worktreePath: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly prompt: string;
  readonly promptHash: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly attempt: number;
  readonly findings: readonly RepairFindingInput[];
}

export interface RepairAdapter {
  readonly render: (input: RepairPromptInput) => unknown | PromiseLike<unknown>;
  readonly invoke: (input: RepairInvokeInput) => unknown | PromiseLike<unknown>;
}

export type ReviewDiffReader = (run: RunRecord) => string | PromiseLike<string>;

export type ReviewFindingReader = (
  run: RunRecord,
) => readonly RepairFindingInput[] | PromiseLike<readonly RepairFindingInput[]>;

export interface ReviewRepairInput {
  readonly coordinator: ExecutionCoordinator;
  readonly run: RunRecord;
  readonly intake?: IntakeCapture;
  /** The last successful verification receipt, deliberately separate from builder output. */
  readonly verification?: unknown;
  readonly repositoryFacts?: string;
  readonly readDiff: ReviewDiffReader;
  readonly readFindings?: ReviewFindingReader;
  readonly reviewer: ReviewerAdapter;
  readonly repair?: RepairAdapter;
  readonly workspaceInspect?: WorkspaceInspection;
  readonly verify?: VerificationAdapter;
  readonly now?: () => string;
}

export type ReviewRepairOutcome =
  | {
      readonly kind: "approved";
      readonly run: RunRecord;
      readonly review: ReviewerTerminalResult;
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

export type ReviewStageOutcome =
  | {
      readonly kind: "approved";
      readonly run: RunRecord;
      readonly review: ReviewerTerminalResult;
    }
  | {
      readonly kind: "needs_repair";
      readonly run: RunRecord;
      readonly findings: readonly RepairFindingInput[];
    }
  | {
      readonly kind: "human";
      readonly run: RunRecord;
      readonly reason: string;
    }
  | { readonly kind: "stale"; readonly run: RunRecord };

type AdapterResult = Record<string, unknown>;

function isRecord(value: unknown): value is AdapterResult {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value: string): string {
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maximumEvidenceBytes)
    result = result.slice(0, -1);
  return result || "Review handoff required.";
}

function json(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  } catch {
    return "null";
  }
}

function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function renderReceipt(value: unknown, label: string): ReviewerRenderReceipt {
  if (
    !isRecord(value) ||
    typeof value.prompt !== "string" ||
    value.prompt.length === 0 ||
    typeof value.promptHash !== "string" ||
    !sha256Pattern.test(value.promptHash) ||
    value.promptHash !== promptHash(value.prompt)
  )
    throw new Error(`${label} prompt receipt is invalid.`);
  return { prompt: value.prompt, promptHash: value.promptHash };
}

function parseRunTerminal(
  value: unknown,
  parse: (value: unknown) => ReviewerTerminalResult | RepairTerminalResult,
): ReviewerTerminalResult | RepairTerminalResult {
  if (isRecord(value) && value.kind === "succeeded")
    return parse(value.terminal);
  return parse(value);
}

function outputReceipt(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return {
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    ...(value.stdout === undefined ? {} : { stdout: value.stdout }),
    ...(value.stderr === undefined ? {} : { stderr: value.stderr }),
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.signal === undefined ? {} : { signal: value.signal }),
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}

function workspaceFor(run: RunRecord): WorkspacePreparationReceipt {
  if (
    run.worktreePath === null ||
    run.branch === null ||
    run.baseSha === null ||
    run.headSha === null ||
    !shaPattern.test(run.baseSha) ||
    !shaPattern.test(run.headSha)
  )
    throw new Error("Review run has incomplete workspace facts.");
  return {
    path: run.worktreePath,
    branch: run.branch,
    baseBranch: "main",
    baseSha: run.baseSha,
    headSha: run.headSha,
    changedFiles: [],
  };
}

function findingInput(value: RepairFindingInput): RepairFindingInput {
  if (
    !isRecord(value) ||
    typeof value.stable_key !== "string" ||
    value.stable_key.trim().length === 0 ||
    !["low", "medium", "high", "critical"].includes(value.severity as string) ||
    typeof value.evidence !== "string" ||
    value.evidence.trim().length === 0
  )
    throw new Error("Repair finding is invalid.");
  return {
    stable_key: value.stable_key,
    severity: value.severity,
    evidence: value.evidence,
  };
}

function findingsFromTerminal(
  terminal: ReviewerTerminalResult,
): readonly RepairFindingInput[] {
  if (terminal.outcome !== "needs_repair") return [];
  return terminal.findings.map((finding) => findingInput(finding));
}

function reviewEffectKey(run: RunRecord): string {
  return `run:${run.id}:agent:review:attempt:${run.repairRound + 1}`;
}

function repairEffectKey(run: RunRecord): string {
  return `run:${run.id}:agent:repair:attempt:${run.repairRound}`;
}

async function schedule(
  coordinator: ExecutionCoordinator,
  run: RunRecord,
  key: string,
  kind: "agent_review" | "agent_repair",
  intent: unknown,
  now: () => string,
): Promise<EffectRecord | undefined> {
  const created = await coordinator.createEffectIntent({
    runId: run.id,
    expectedRevision: run.revision,
    key,
    kind,
    intent,
    dispatch: false,
    at: now(),
  });
  if (created.status !== "pending") return undefined;
  return coordinator.beginEffect({
    effectKey: created.key,
    expectedRevision: run.revision,
    at: now(),
  });
}

function reviewStep(
  run: RunRecord,
  attempt: number,
  receipt: unknown,
  prompt: ReviewerRenderReceipt,
  status: "completed" | "failed",
  startedAt: string,
  completedAt: string,
  summary: string,
) {
  return {
    id: `run:${run.id}:review:attempt:${attempt}:step`,
    runId: run.id,
    expectedRevision: run.revision,
    reworkEpoch: run.reworkEpoch,
    role: "reviewer",
    logicalStep: "review",
    attempt,
    statusSequence: 1,
    status,
    promptHash: prompt.promptHash,
    model: run.repository,
    reasoningEffort: "independent",
    startedAt,
    completedAt,
    exitResultJson: json(receipt),
    summary: { text: bounded(summary) },
    rawLogReference: `logs/${run.id}/review/attempt-${attempt}.jsonl`,
  } as const;
}

function repairStep(
  run: RunRecord,
  attempt: number,
  receipt: unknown,
  prompt: RepairRenderReceipt,
  status: "completed" | "failed",
  startedAt: string,
  completedAt: string,
  summary: string,
) {
  return {
    id: `run:${run.id}:repair:attempt:${attempt}:step`,
    runId: run.id,
    expectedRevision: run.revision,
    reworkEpoch: run.reworkEpoch,
    role: "repairer",
    logicalStep: "repair",
    attempt,
    statusSequence: 1,
    status,
    promptHash: prompt.promptHash,
    model: run.repository,
    reasoningEffort: "bounded",
    startedAt,
    completedAt,
    exitResultJson: json(receipt),
    summary: { text: bounded(summary) },
    rawLogReference: `logs/${run.id}/repair/attempt-${attempt}.jsonl`,
  } as const;
}

function toFindings(
  run: RunRecord,
  stepId: string,
  findings: readonly RepairFindingInput[],
  at: string,
): readonly NewFindingRecord[] {
  return findings.map((finding, index) => ({
    id: `run:${run.id}:finding:review:${run.repairRound + 1}:${index + 1}`,
    runId: run.id,
    expectedRevision: run.revision,
    reworkEpoch: run.reworkEpoch,
    reviewStepId: stepId,
    stableKey: finding.stable_key,
    dispositionSequence: 1,
    severity: finding.severity,
    evidence: finding.evidence,
    disposition: "open",
    at,
  }));
}

async function settleReview(
  input: ReviewRepairInput,
  run: RunRecord,
  effect: EffectRecord,
  prompt: ReviewerRenderReceipt,
  startedAt: string,
  terminal: ReviewerTerminalResult | undefined,
  rawResult: unknown,
  reason: string | undefined,
  now: () => string,
): Promise<ReviewStageOutcome> {
  const attempt = run.repairRound + 1;
  const completedAt = now();
  const findings = terminal === undefined ? [] : findingsFromTerminal(terminal);
  const exhausted =
    terminal?.outcome === "needs_repair" && run.repairRound >= 2;
  const handoffReason = exhausted
    ? "Independent review found another repair after the shared two-round budget was exhausted. Human Review must decide the next action."
    : (reason ??
      (terminal?.outcome === "needs_human"
        ? `Independent review requires human action: ${terminal.requested_action}`
        : terminal?.outcome === "blocked"
          ? `Independent review is blocked: ${terminal.requested_action}`
          : "Independent review could not produce a trustworthy result."));
  const reviewReceipt = {
    ...outputReceipt(rawResult),
    ...(terminal === undefined ? {} : { terminal }),
    ...(reason === undefined ? {} : { reason }),
  };
  const shouldRepair = terminal?.outcome === "needs_repair" && !exhausted;
  try {
    const settled = await input.coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome:
        shouldRepair || terminal === undefined || !shouldRepair
          ? terminal?.outcome === "approved" && !exhausted
            ? "confirmed"
            : "failed"
          : "failed",
      trigger: shouldRepair
        ? "review_needs_repair"
        : terminal?.outcome === "approved" && !exhausted
          ? "review_approved"
          : "handoff_required",
      evidence: bounded(
        shouldRepair
          ? (terminal?.summary ?? "Independent review requires a repair.")
          : (terminal?.summary ?? handoffReason),
      ),
      receipt: reviewReceipt,
      step: reviewStep(
        run,
        attempt,
        reviewReceipt,
        prompt,
        terminal === undefined ||
          (!shouldRepair && terminal.outcome !== "approved")
          ? "failed"
          : "completed",
        startedAt,
        completedAt,
        terminal?.summary ?? handoffReason,
      ),
      ...(shouldRepair
        ? {
            findings: toFindings(
              run,
              `run:${run.id}:review:attempt:${attempt}:step`,
              findings,
              completedAt,
            ),
          }
        : {}),
      at: completedAt,
    });
    if (shouldRepair)
      return { kind: "needs_repair", run: settled.run, findings };
    if (terminal?.outcome === "approved")
      return { kind: "approved", run: settled.run, review: terminal };
    return { kind: "human", run: settled.run, reason: handoffReason };
  } catch (error) {
    if (error instanceof Error && /stale|revision|effect/iu.test(error.message))
      return { kind: "stale", run };
    throw error;
  }
}

export async function executeReviewStage(
  input: ReviewRepairInput,
): Promise<ReviewStageOutcome> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.run.state !== "reviewing") return { kind: "stale", run: input.run };
  const intake = input.intake;
  if (intake === undefined) throw new Error("Review intake is required.");
  const workspace = workspaceFor(input.run);
  const diff = await input.readDiff(input.run);
  const repositoryFacts =
    input.repositoryFacts ?? "No additional repository facts were supplied.";
  const verification =
    typeof input.verification === "string"
      ? input.verification
      : json(
          input.verification ?? { state: "verification evidence unavailable" },
        );
  const attempt = input.run.repairRound + 1;
  const rendered = renderReceipt(
    await input.reviewer.render({
      issueNumber: input.run.issueNumber,
      issueTitle: intake.title,
      issueBody: intake.body,
      worktreePath: workspace.path,
      baseSha: workspace.baseSha,
      headSha: workspace.headSha,
      diff,
      repositoryFacts,
      verification,
    }),
    "Reviewer",
  );
  let effect: EffectRecord | undefined;
  try {
    effect = await schedule(
      input.coordinator,
      input.run,
      reviewEffectKey(input.run),
      "agent_review",
      {
        attempt,
        baseSha: workspace.baseSha,
        headSha: workspace.headSha,
        prompt: rendered.prompt,
        promptHash: rendered.promptHash,
        runId: input.run.id,
        worktreePath: workspace.path,
      },
      now,
    );
  } catch (error) {
    if (error instanceof Error && /stale|revision|effect/iu.test(error.message))
      return { kind: "stale", run: input.run };
    throw error;
  }
  if (effect === undefined) return { kind: "stale", run: input.run };
  const startedAt = now();
  let rawResult: unknown;
  let terminal: ReviewerTerminalResult;
  try {
    rawResult = await input.reviewer.invoke({
      issueNumber: input.run.issueNumber,
      worktreePath: workspace.path,
      baseSha: workspace.baseSha,
      headSha: workspace.headSha,
      prompt: rendered.prompt,
      promptHash: rendered.promptHash,
      model: intake.builder.model,
      reasoningEffort: intake.builder.reasoningEffort,
      attempt,
    });
    terminal = parseRunTerminal(
      rawResult,
      parseReviewerTerminalResult,
    ) as ReviewerTerminalResult;
  } catch (error) {
    return settleReview(
      input,
      input.run,
      effect,
      rendered,
      startedAt,
      undefined,
      rawResult,
      `Independent reviewer failed: ${errorMessage(error)}`,
      now,
    );
  }
  // Keep invocation/receipt parsing separate from durable settlement. A
  // coordinator validation or stale error must never relaunch settlement.
  return settleReview(
    input,
    input.run,
    effect,
    rendered,
    startedAt,
    terminal,
    rawResult,
    undefined,
    now,
  );
}

async function executeRepairStage(
  input: ReviewRepairInput,
  run: RunRecord,
  findingsOverride?: readonly RepairFindingInput[],
): Promise<
  | { kind: "repaired"; run: RunRecord }
  | { kind: "human"; run: RunRecord; reason: string }
  | { kind: "stale"; run: RunRecord }
> {
  const now = input.now ?? (() => new Date().toISOString());
  if (run.state !== "repairing") return { kind: "stale", run };
  if (run.repairRound < 1 || run.repairRound > 2)
    return {
      kind: "human",
      run,
      reason: "Repair round is outside the shared bounded budget.",
    };
  if (input.repair === undefined)
    return {
      kind: "human",
      run,
      reason:
        "No repair capability is available; human Review must repair the recorded findings.",
    };
  const findings =
    findingsOverride ??
    (input.readFindings === undefined
      ? undefined
      : await input.readFindings(run));
  if (findings === undefined || findings.length === 0)
    return {
      kind: "human",
      run,
      reason: "No durable review findings are available for repair.",
    };
  const normalizedFindings = findings.map(findingInput);
  const workspace = workspaceFor(run);
  const diff = await input.readDiff(run);
  const repositoryFacts =
    input.repositoryFacts ?? "No additional repository facts were supplied.";
  const verification =
    typeof input.verification === "string"
      ? input.verification
      : json(
          input.verification ?? { state: "verification evidence unavailable" },
        );
  const attempt = run.repairRound;
  const rendered = renderReceipt(
    await input.repair.render({
      issueNumber: run.issueNumber,
      issueTitle: input.intake?.title ?? "Issue contract unavailable",
      issueBody: input.intake?.body ?? "Issue contract unavailable",
      worktreePath: workspace.path,
      baseSha: workspace.baseSha,
      headSha: workspace.headSha,
      diff,
      repositoryFacts,
      verification,
      findings: normalizedFindings,
    }),
    "Repair",
  );
  let effect: EffectRecord | undefined;
  try {
    effect = await schedule(
      input.coordinator,
      run,
      repairEffectKey(run),
      "agent_repair",
      {
        attempt,
        baseSha: workspace.baseSha,
        headSha: workspace.headSha,
        findings: normalizedFindings,
        prompt: rendered.prompt,
        promptHash: rendered.promptHash,
        runId: run.id,
        worktreePath: workspace.path,
      },
      now,
    );
  } catch (error) {
    if (error instanceof Error && /stale|revision|effect/iu.test(error.message))
      return { kind: "stale", run };
    throw error;
  }
  if (effect === undefined) return { kind: "stale", run };
  const startedAt = now();
  let rawResult: unknown;
  let terminal: RepairTerminalResult | undefined;
  let reason: string | undefined;
  try {
    rawResult = await input.repair.invoke({
      issueNumber: run.issueNumber,
      worktreePath: workspace.path,
      baseSha: workspace.baseSha,
      headSha: workspace.headSha,
      prompt: rendered.prompt,
      promptHash: rendered.promptHash,
      model: input.intake?.builder.model ?? run.repository,
      reasoningEffort: input.intake?.builder.reasoningEffort ?? "bounded",
      attempt,
      findings: normalizedFindings,
    });
    terminal = parseRunTerminal(
      rawResult,
      parseRepairTerminalResult,
    ) as RepairTerminalResult;
    if (terminal.outcome === "blocked")
      reason = `Repair is blocked: ${terminal.requested_action}`;
  } catch (error) {
    reason = `Repair failed: ${errorMessage(error)}`;
  }
  const completedAt = now();
  const receipt = {
    ...outputReceipt(rawResult),
    ...(terminal === undefined ? {} : { terminal }),
    ...(reason === undefined ? {} : { reason }),
  };
  if (terminal?.outcome !== "completed") {
    const handoffReason = reason ?? "Repair did not complete.";
    try {
      const settled = await input.coordinator.settleExecution({
        runId: run.id,
        expectedRevision: run.revision,
        effectKey: effect.key,
        outcome: "failed",
        trigger: "handoff_required",
        evidence: bounded(handoffReason),
        receipt,
        step: repairStep(
          run,
          attempt,
          receipt,
          rendered,
          "failed",
          startedAt,
          completedAt,
          handoffReason,
        ),
        at: completedAt,
      });
      return { kind: "human", run: settled.run, reason: handoffReason };
    } catch (error) {
      if (
        error instanceof Error &&
        /stale|revision|effect/iu.test(error.message)
      )
        return { kind: "stale", run };
      throw error;
    }
  }
  if (input.workspaceInspect === undefined) {
    const reasonText =
      "Repair completed but workspace inspection is unavailable.";
    const settled = await input.coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome: "failed",
      trigger: "handoff_required",
      evidence: reasonText,
      receipt,
      step: repairStep(
        run,
        attempt,
        receipt,
        rendered,
        "failed",
        startedAt,
        completedAt,
        reasonText,
      ),
      at: completedAt,
    });
    return { kind: "human", run: settled.run, reason: reasonText };
  }
  let inspected: WorkspacePreparationReceipt;
  try {
    const value = await input.workspaceInspect(run, workspace);
    if (
      !isRecord(value) ||
      typeof value.path !== "string" ||
      typeof value.branch !== "string" ||
      typeof value.baseSha !== "string" ||
      typeof value.headSha !== "string"
    )
      throw new Error("Repair workspace receipt is invalid.");
    inspected = {
      path: value.path,
      branch: value.branch,
      baseBranch: value.baseBranch === "main" ? "main" : "main",
      baseSha: value.baseSha,
      headSha: value.headSha,
      changedFiles: Array.isArray(value.changedFiles)
        ? value.changedFiles.filter(
            (path): path is string => typeof path === "string",
          )
        : [],
    };
    if (
      inspected.path !== workspace.path ||
      inspected.branch !== workspace.branch ||
      inspected.baseSha !== workspace.baseSha ||
      !shaPattern.test(inspected.headSha)
    )
      throw new Error("Repair changed the assigned workspace identity.");
  } catch (error) {
    const handoffReason = `Repair workspace inspection failed: ${errorMessage(error)}`;
    const settled = await input.coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome: "failed",
      trigger: "handoff_required",
      evidence: bounded(handoffReason),
      receipt,
      step: repairStep(
        run,
        attempt,
        receipt,
        rendered,
        "failed",
        startedAt,
        completedAt,
        handoffReason,
      ),
      at: completedAt,
    });
    return { kind: "human", run: settled.run, reason: handoffReason };
  }
  try {
    const settled = await input.coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome: "confirmed",
      trigger: "repair_succeeded",
      evidence: bounded(terminal.summary),
      receipt: {
        ...receipt,
        headSha: inspected.headSha,
        changedFiles: inspected.changedFiles,
      },
      facts: { headSha: inspected.headSha },
      step: repairStep(
        run,
        attempt,
        receipt,
        rendered,
        "completed",
        startedAt,
        completedAt,
        terminal.summary,
      ),
      at: completedAt,
    });
    return { kind: "repaired", run: settled.run };
  } catch (error) {
    if (error instanceof Error && /stale|revision|effect/iu.test(error.message))
      return { kind: "stale", run };
    throw error;
  }
}

export async function executeReviewRepair(
  input: ReviewRepairInput,
): Promise<ReviewRepairOutcome> {
  const now = input.now ?? (() => new Date().toISOString());
  let run = input.run;
  let verification = input.verification;
  let findings: readonly RepairFindingInput[] | undefined;
  for (let guard = 0; guard < 8; guard += 1) {
    if (run.state === "verifying") {
      if (input.verify === undefined || input.workspaceInspect === undefined)
        return {
          kind: "human",
          run,
          reason: "Verification capability is unavailable.",
        };
      const verificationResult = await executeClaimedRun({
        coordinator: input.coordinator,
        run,
        workspacePrepare: async () => workspaceFor(run),
        workspaceInspect: input.workspaceInspect,
        verify: input.verify,
        now,
      });
      if (verificationResult.kind === "stale")
        return { kind: "stale", run: verificationResult.run };
      run = verificationResult.run;
      if (verificationResult.kind === "reviewing") {
        verification = verificationResult.verification;
        continue;
      }
      if (run.state !== "repairing")
        return {
          kind: "human",
          run,
          reason: "Verification did not reach the review gate.",
        };
    }
    if (run.state === "reviewing") {
      const review = await executeReviewStage({ ...input, run, verification });
      if (
        review.kind === "approved" ||
        review.kind === "human" ||
        review.kind === "stale"
      )
        return review;
      run = review.run;
      findings = review.findings;
    }
    if (run.state !== "repairing")
      return {
        kind: "human",
        run,
        reason: "Review loop reached an unexpected state.",
      };
    const repair = await executeRepairStage(
      { ...input, run, verification },
      run,
      findings,
    );
    if (repair.kind === "human" || repair.kind === "stale") return repair;
    run = repair.run;
    findings = undefined;
    if (input.verify === undefined || input.workspaceInspect === undefined)
      return {
        kind: "human",
        run,
        reason: "Repair completed but verification capability is unavailable.",
      };
    const verificationResult = await executeClaimedRun({
      coordinator: input.coordinator,
      run,
      workspacePrepare: async () => workspaceFor(run),
      workspaceInspect: input.workspaceInspect,
      verify: input.verify,
      now,
    });
    if (verificationResult.kind === "stale")
      return { kind: "stale", run: verificationResult.run };
    run = verificationResult.run;
    if (verificationResult.kind === "reviewing") {
      verification = verificationResult.verification;
      continue;
    }
    if (run.state === "review")
      return {
        kind: "human",
        run,
        reason: "Verification exhausted the shared repair budget.",
      };
  }
  return {
    kind: "human",
    run,
    reason: "Review loop exceeded its bounded sequencing guard.",
  };
}

export const executeReviewAndRepair = executeReviewRepair;
