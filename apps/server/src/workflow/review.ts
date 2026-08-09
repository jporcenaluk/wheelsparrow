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
import { StaleEffectError } from "../database/effects.js";
import {
  type NewFindingRecord,
  type RunRecord,
  StaleRevisionError,
} from "../database/runs.js";
import {
  type ExecutionCoordinator,
  executeClaimedRun,
  type IntakeCapture,
  type VerificationAdapter,
  validateIntakeCapture,
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
) => readonly unknown[] | PromiseLike<readonly unknown[]>;

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

type ReviewQuarantineCoordinator = ExecutionCoordinator & {
  readonly quarantineEffect?: (command: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly effectKey: string;
    readonly outcome: "ambiguous";
    readonly trigger: null;
    readonly evidence: string;
    readonly at?: string;
  }) => Promise<EffectRecord>;
};

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

function isStaleError(error: unknown): boolean {
  return (
    error instanceof StaleRevisionError || error instanceof StaleEffectError
  );
}

async function handoff(
  input: ReviewRepairInput,
  run: RunRecord,
  reason: string,
  now: () => string,
): Promise<
  | { kind: "human"; run: RunRecord; reason: string }
  | { kind: "stale"; run: RunRecord }
> {
  const safeReason = bounded(reason);
  if (run.state === "review") return { kind: "human", run, reason: safeReason };
  try {
    const handedOff = await input.coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision,
      trigger: "handoff_required",
      at: now(),
      summary: { text: safeReason },
      requiredAction: safeReason,
    });
    return { kind: "human", run: handedOff, reason: safeReason };
  } catch (error) {
    if (isStaleError(error)) return { kind: "stale", run };
    throw error;
  }
}

function bounded(value: string): string {
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maximumEvidenceBytes)
    result = result.slice(0, -1);
  return result || "Review handoff required.";
}

async function quarantineReviewEffect(
  input: ReviewRepairInput,
  run: RunRecord,
  effect: EffectRecord,
  reason: string,
  now: () => string,
): Promise<ReviewStageOutcome> {
  const coordinator = input.coordinator as ReviewQuarantineCoordinator;
  if (coordinator.quarantineEffect === undefined) return { kind: "stale", run };
  const evidence = bounded(
    `Review effect ${effect.key} was quarantined after settlement failed: ${reason}`,
  );
  try {
    const quarantined = await coordinator.quarantineEffect({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome: "ambiguous",
      trigger: null,
      evidence,
      at: now(),
    });
    if (quarantined.status !== "ambiguous") return { kind: "stale", run };
    const handedOff = await input.coordinator.transition({
      runId: run.id,
      expectedRevision: run.revision + 1,
      trigger: "handoff_required",
      at: now(),
      summary: { text: evidence },
      requiredAction: evidence,
    });
    return { kind: "human", run: handedOff, reason: evidence };
  } catch {
    return { kind: "stale", run };
  }
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
    run.baseBranch !== "main" ||
    run.worktreePath.trim() !== run.worktreePath ||
    run.branch.trim() !== run.branch ||
    run.worktreePath.length === 0 ||
    run.branch.length === 0 ||
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

function durableIntake(run: RunRecord): IntakeCapture {
  if (run.intakeJson === null)
    throw new Error("Durable issue contract is missing.");
  return validateIntakeCapture(JSON.parse(run.intakeJson));
}

function assertSameObservedFiles(
  expected: WorkspacePreparationReceipt,
  observed: WorkspacePreparationReceipt,
): void {
  if (
    expected.changedFiles.length !== observed.changedFiles.length ||
    expected.changedFiles.some(
      (path, index) => path !== observed.changedFiles[index],
    )
  )
    throw new Error("Observed worktree files changed during the operation.");
}

function strictChangedFiles(value: unknown): readonly string[] {
  if (!Array.isArray(value))
    throw new Error("Workspace changed files are invalid.");
  if (
    value.some((path) => {
      if (
        typeof path !== "string" ||
        path.trim() !== path ||
        path.length === 0 ||
        path.length > 512
      )
        return true;
      const segments = path.split(/[\\/]/u);
      return (
        path.startsWith("/") ||
        path.startsWith("\\") ||
        segments.includes("..") ||
        segments.includes(".")
      );
    })
  )
    throw new Error("Workspace changed files are invalid.");
  if (value.length > 4096)
    throw new Error("Workspace changed files are invalid.");
  return value as string[];
}

function inspectWorkspaceReceipt(
  value: unknown,
  expected: WorkspacePreparationReceipt,
  allowHeadChange: boolean,
): WorkspacePreparationReceipt {
  if (!isRecord(value)) throw new Error("Workspace receipt is invalid.");
  const keys = Object.keys(value).toSorted();
  if (keys.join(",") !== "baseBranch,baseSha,branch,changedFiles,headSha,path")
    throw new Error("Workspace receipt shape is invalid.");
  if (
    value.baseBranch !== "main" ||
    value.path !== expected.path ||
    value.branch !== expected.branch ||
    value.baseSha !== expected.baseSha ||
    (!allowHeadChange && value.headSha !== expected.headSha) ||
    typeof value.path !== "string" ||
    typeof value.branch !== "string" ||
    typeof value.baseSha !== "string" ||
    typeof value.headSha !== "string" ||
    !shaPattern.test(value.baseSha) ||
    !shaPattern.test(value.headSha)
  )
    throw new Error("Workspace identity changed or is invalid.");
  return {
    path: value.path,
    branch: value.branch,
    baseBranch: "main",
    baseSha: value.baseSha,
    headSha: value.headSha,
    changedFiles: strictChangedFiles(value.changedFiles),
  };
}

function verificationEvidence(
  value: unknown,
  run: RunRecord,
  intake: IntakeCapture,
  workspace: WorkspacePreparationReceipt,
): string | undefined {
  if (!isRecord(value) || value.kind !== "succeeded") return undefined;
  if (
    value.command !== intake.verificationCommand ||
    value.cwd !== workspace.path ||
    typeof value.command !== "string" ||
    typeof value.cwd !== "string" ||
    value.exitCode !== 0 ||
    value.signal !== null ||
    typeof value.headSha !== "string" ||
    !shaPattern.test(value.headSha) ||
    !Array.isArray(value.changedFiles)
  )
    return undefined;
  let changedFiles: readonly string[];
  try {
    changedFiles = strictChangedFiles(value.changedFiles);
  } catch {
    return undefined;
  }
  if (
    value.headSha !== run.headSha ||
    changedFiles.length !== workspace.changedFiles.length ||
    changedFiles.some((path, index) => path !== workspace.changedFiles[index])
  )
    return undefined;
  return json(value);
}

function findingInput(value: unknown): RepairFindingInput {
  const record = isRecord(value) ? value : undefined;
  const stableKey = record?.stable_key ?? record?.stableKey;
  if (
    record === undefined ||
    typeof stableKey !== "string" ||
    stableKey.trim().length === 0 ||
    !["low", "medium", "high", "critical"].includes(
      record.severity as string,
    ) ||
    typeof record.evidence !== "string" ||
    record.evidence.trim().length === 0
  )
    throw new Error("Repair finding is invalid.");
  return {
    stable_key: stableKey,
    severity: record.severity as RepairFindingInput["severity"],
    evidence: record.evidence,
  };
}

function findingsFromTerminal(
  terminal: ReviewerTerminalResult,
): readonly RepairFindingInput[] {
  if (terminal.outcome !== "needs_repair") return [];
  return terminal.findings.map((finding) => findingInput(finding));
}

function reviewEffectKey(run: RunRecord): string {
  return `run:${run.id}:rework:${run.reworkEpoch}:agent:review:attempt:${run.repairRound + 1}`;
}

function repairEffectKey(run: RunRecord): string {
  return `run:${run.id}:rework:${run.reworkEpoch}:agent:repair:attempt:${run.repairRound}`;
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
  model: string,
  reasoningEffort: string,
  status: "completed" | "failed",
  startedAt: string,
  completedAt: string,
  summary: string,
) {
  return {
    id: `run:${run.id}:rework:${run.reworkEpoch}:review:attempt:${attempt}:step`,
    runId: run.id,
    expectedRevision: run.revision,
    reworkEpoch: run.reworkEpoch,
    role: "reviewer",
    logicalStep: "review",
    attempt,
    statusSequence: 1,
    status,
    promptHash: prompt.promptHash,
    model,
    reasoningEffort,
    startedAt,
    completedAt,
    exitResultJson: json(receipt),
    summary: { text: bounded(summary) },
    rawLogReference: `logs/${run.id}/rework-${run.reworkEpoch}/review/attempt-${attempt}.jsonl`,
  } as const;
}

function repairStep(
  run: RunRecord,
  attempt: number,
  receipt: unknown,
  prompt: RepairRenderReceipt,
  model: string,
  reasoningEffort: string,
  status: "completed" | "failed",
  startedAt: string,
  completedAt: string,
  summary: string,
) {
  return {
    id: `run:${run.id}:rework:${run.reworkEpoch}:repair:attempt:${attempt}:step`,
    runId: run.id,
    expectedRevision: run.revision,
    reworkEpoch: run.reworkEpoch,
    role: "repairer",
    logicalStep: "repair",
    attempt,
    statusSequence: 1,
    status,
    promptHash: prompt.promptHash,
    model,
    reasoningEffort,
    startedAt,
    completedAt,
    exitResultJson: json(receipt),
    summary: { text: bounded(summary) },
    rawLogReference: `logs/${run.id}/rework-${run.reworkEpoch}/repair/attempt-${attempt}.jsonl`,
  } as const;
}

function toFindings(
  run: RunRecord,
  stepId: string,
  findings: readonly RepairFindingInput[],
  at: string,
): readonly NewFindingRecord[] {
  return findings.map((finding, index) => ({
    id: `run:${run.id}:rework:${run.reworkEpoch}:finding:review:${run.repairRound + 1}:${index + 1}`,
    runId: run.id,
    expectedRevision: run.revision,
    reworkEpoch: run.reworkEpoch,
    reviewStepId: stepId,
    stableKey: finding.stable_key,
    dispositionSequence: run.repairRound + 1,
    severity: finding.severity,
    evidence: finding.evidence,
    disposition: "open",
    at,
  }));
}

async function settleReviewHandoff(
  input: ReviewRepairInput,
  run: RunRecord,
  effect: EffectRecord,
  prompt: ReviewerRenderReceipt,
  startedAt: string,
  receipt: unknown,
  model: string,
  reasoningEffort: string,
  reason: string,
  now: () => string,
): Promise<ReviewStageOutcome> {
  const completedAt = now();
  const safeReason = bounded(reason);
  try {
    const settled = await input.coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome: "failed",
      trigger: "handoff_required",
      evidence: safeReason,
      receipt,
      step: reviewStep(
        run,
        run.repairRound + 1,
        receipt,
        prompt,
        model,
        reasoningEffort,
        "failed",
        startedAt,
        completedAt,
        safeReason,
      ),
      requiredAction: safeReason,
      at: completedAt,
    });
    return { kind: "human", run: settled.run, reason: safeReason };
  } catch (error) {
    if (isStaleError(error)) return { kind: "stale", run };
    return quarantineReviewEffect(
      input,
      run,
      effect,
      `Independent review handoff settlement failed closed: ${errorMessage(error)}`,
      now,
    );
  }
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
  const model = input.intake?.builder.model ?? run.repository;
  const reasoningEffort = input.intake?.builder.reasoningEffort ?? "bounded";
  const completedAt = now();
  const reviewReceipt = {
    ...outputReceipt(rawResult),
    ...(terminal === undefined ? {} : { terminal }),
    ...(reason === undefined ? {} : { reason }),
  };
  let findings: readonly RepairFindingInput[];
  try {
    findings = terminal === undefined ? [] : findingsFromTerminal(terminal);
  } catch (error) {
    return settleReviewHandoff(
      input,
      run,
      effect,
      prompt,
      startedAt,
      reviewReceipt,
      model,
      reasoningEffort,
      `Independent review findings are invalid: ${errorMessage(error)}`,
      now,
    );
  }
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
  const shouldRepair = terminal?.outcome === "needs_repair" && !exhausted;
  const persistFindings =
    terminal?.outcome === "needs_repair" && findings.length > 0;
  const trigger = persistFindings
    ? "review_needs_repair"
    : terminal?.outcome === "approved"
      ? "review_approved"
      : "handoff_required";
  try {
    const settled = await input.coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome:
        terminal?.outcome === "approved" && !exhausted ? "confirmed" : "failed",
      trigger,
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
        model,
        reasoningEffort,
        terminal === undefined ||
          (terminal.outcome !== "approved" &&
            terminal.outcome !== "needs_repair")
          ? "failed"
          : "completed",
        startedAt,
        completedAt,
        terminal?.summary ?? handoffReason,
      ),
      ...(persistFindings
        ? {
            findings: toFindings(
              run,
              `run:${run.id}:rework:${run.reworkEpoch}:review:attempt:${attempt}:step`,
              findings,
              completedAt,
            ),
          }
        : {}),
      ...(trigger === "handoff_required" || exhausted
        ? { requiredAction: bounded(handoffReason) }
        : {}),
      at: completedAt,
    });
    if (shouldRepair)
      return { kind: "needs_repair", run: settled.run, findings };
    if (terminal?.outcome === "approved")
      return { kind: "approved", run: settled.run, review: terminal };
    return { kind: "human", run: settled.run, reason: handoffReason };
  } catch (error) {
    if (isStaleError(error)) return { kind: "stale", run };
    return handoff(
      input,
      run,
      `Independent review settlement failed closed: ${errorMessage(error)}`,
      now,
    );
  }
}

export async function executeReviewStage(
  input: ReviewRepairInput,
): Promise<ReviewStageOutcome> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.run.state !== "reviewing") return { kind: "stale", run: input.run };
  let intake: IntakeCapture;
  try {
    intake = durableIntake(input.run);
  } catch (error) {
    return handoff(
      input,
      input.run,
      `Review cannot use the durable issue contract: ${errorMessage(error)}`,
      now,
    );
  }
  const effectiveInput = { ...input, intake };
  let workspace: WorkspacePreparationReceipt;
  try {
    workspace = workspaceFor(input.run);
  } catch (error) {
    return handoff(
      effectiveInput,
      input.run,
      `Review workspace facts are invalid: ${errorMessage(error)}`,
      now,
    );
  }
  if (input.workspaceInspect === undefined)
    return handoff(
      effectiveInput,
      input.run,
      "Independent review cannot prove the assigned worktree identity; human Review must inspect it.",
      now,
    );
  let diff: string;
  try {
    const before = inspectWorkspaceReceipt(
      await input.workspaceInspect(input.run, workspace),
      workspace,
      false,
    );
    diff = await input.readDiff(input.run);
    const after = inspectWorkspaceReceipt(
      await input.workspaceInspect(input.run, before),
      before,
      false,
    );
    assertSameObservedFiles(before, after);
    workspace = after;
  } catch (error) {
    return handoff(
      effectiveInput,
      input.run,
      `Independent review cannot safely read the assigned worktree diff: ${errorMessage(error)}`,
      now,
    );
  }
  const repositoryFacts =
    input.repositoryFacts ?? "No additional repository facts were supplied.";
  const verification = verificationEvidence(
    input.verification,
    input.run,
    intake,
    workspace,
  );
  if (verification === undefined)
    return handoff(
      effectiveInput,
      input.run,
      "Independent review lacks the actual successful durable verification receipt.",
      now,
    );
  const attempt = input.run.repairRound + 1;
  let rendered: ReviewerRenderReceipt;
  try {
    rendered = renderReceipt(
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
  } catch (error) {
    return handoff(
      effectiveInput,
      input.run,
      `Independent reviewer prompt rendering failed: ${errorMessage(error)}`,
      now,
    );
  }
  let effect: EffectRecord | undefined;
  try {
    effect = await schedule(
      effectiveInput.coordinator,
      input.run,
      reviewEffectKey(input.run),
      "agent_review",
      {
        attempt,
        baseSha: workspace.baseSha,
        headSha: workspace.headSha,
        model: intake.builder.model,
        reasoningEffort: intake.builder.reasoningEffort,
        prompt: rendered.prompt,
        promptHash: rendered.promptHash,
        runId: input.run.id,
        worktreePath: workspace.path,
      },
      now,
    );
  } catch (error) {
    if (isStaleError(error)) return { kind: "stale", run: input.run };
    return handoff(
      effectiveInput,
      input.run,
      `Independent review could not create its durable effect: ${errorMessage(error)}`,
      now,
    );
  }
  if (effect === undefined)
    return handoff(
      effectiveInput,
      input.run,
      "Independent review was replayed or ambiguous; human Review must reconcile the prior effect.",
      now,
    );
  try {
    const beforeInvoke = inspectWorkspaceReceipt(
      await input.workspaceInspect(input.run, workspace),
      workspace,
      false,
    );
    assertSameObservedFiles(workspace, beforeInvoke);
  } catch (error) {
    return settleReview(
      effectiveInput,
      input.run,
      effect,
      rendered,
      now(),
      undefined,
      undefined,
      `Reviewer worktree changed before invocation: ${errorMessage(error)}`,
      now,
    );
  }
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
      effectiveInput,
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
  try {
    const afterInvoke = inspectWorkspaceReceipt(
      await input.workspaceInspect(input.run, workspace),
      workspace,
      false,
    );
    assertSameObservedFiles(workspace, afterInvoke);
  } catch (error) {
    return settleReview(
      effectiveInput,
      input.run,
      effect,
      rendered,
      startedAt,
      undefined,
      rawResult,
      `Reviewer changed or lost the assigned worktree: ${errorMessage(error)}`,
      now,
    );
  }
  // Keep invocation/receipt parsing separate from durable settlement. A
  // coordinator validation or stale error must never relaunch settlement.
  return settleReview(
    effectiveInput,
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

async function settleRepairHandoff(
  input: ReviewRepairInput,
  run: RunRecord,
  effect: EffectRecord,
  prompt: RepairRenderReceipt,
  attempt: number,
  receipt: unknown,
  model: string,
  reasoningEffort: string,
  startedAt: string,
  reason: string,
  now: () => string,
): Promise<
  | { kind: "human"; run: RunRecord; reason: string }
  | { kind: "stale"; run: RunRecord }
> {
  const completedAt = now();
  const safeReason = bounded(reason);
  try {
    const settled = await input.coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome: "failed",
      trigger: "handoff_required",
      evidence: safeReason,
      receipt,
      step: repairStep(
        run,
        attempt,
        receipt,
        prompt,
        model,
        reasoningEffort,
        "failed",
        startedAt,
        completedAt,
        safeReason,
      ),
      requiredAction: safeReason,
      at: completedAt,
    });
    return { kind: "human", run: settled.run, reason: safeReason };
  } catch (error) {
    if (isStaleError(error)) return { kind: "stale", run };
    return handoff(
      input,
      run,
      `Repair handoff settlement failed closed: ${errorMessage(error)}`,
      now,
    );
  }
}

async function executeRepairStage(
  input: ReviewRepairInput,
  run: RunRecord,
  findingsOverride?: readonly unknown[],
): Promise<
  | { kind: "repaired"; run: RunRecord }
  | { kind: "human"; run: RunRecord; reason: string }
  | { kind: "stale"; run: RunRecord }
> {
  const now = input.now ?? (() => new Date().toISOString());
  if (run.state !== "repairing") return { kind: "stale", run };
  if (run.repairRound < 1 || run.repairRound > 2)
    return handoff(
      input,
      run,
      "Repair round is outside the shared bounded budget.",
      now,
    );
  let intake: IntakeCapture;
  try {
    intake = durableIntake(run);
  } catch (error) {
    return handoff(
      input,
      run,
      `Repair cannot use the durable issue contract: ${errorMessage(error)}`,
      now,
    );
  }
  const effectiveInput = { ...input, intake };
  if (input.repair === undefined)
    return handoff(
      effectiveInput,
      run,
      "No repair capability is available; human Review must repair the recorded findings.",
      now,
    );
  let findings: readonly unknown[] | undefined;
  try {
    findings =
      findingsOverride ??
      (input.readFindings === undefined
        ? undefined
        : await input.readFindings(run));
  } catch (error) {
    return handoff(
      effectiveInput,
      run,
      `Durable review findings could not be read: ${errorMessage(error)}`,
      now,
    );
  }
  if (findings === undefined || findings.length === 0)
    return handoff(
      effectiveInput,
      run,
      "No durable review findings are available for repair.",
      now,
    );
  let normalizedFindings: readonly RepairFindingInput[];
  try {
    normalizedFindings = findings.map(findingInput);
  } catch (error) {
    return handoff(
      effectiveInput,
      run,
      `Durable review findings are invalid: ${errorMessage(error)}`,
      now,
    );
  }
  let workspace: WorkspacePreparationReceipt;
  try {
    workspace = workspaceFor(run);
  } catch (error) {
    return handoff(
      effectiveInput,
      run,
      `Repair workspace facts are invalid: ${errorMessage(error)}`,
      now,
    );
  }
  if (input.workspaceInspect === undefined)
    return handoff(
      effectiveInput,
      run,
      "Repair cannot prove the assigned worktree identity before reading its diff.",
      now,
    );
  let observedBeforeDiff: WorkspacePreparationReceipt;
  try {
    observedBeforeDiff = inspectWorkspaceReceipt(
      await input.workspaceInspect(run, workspace),
      workspace,
      false,
    );
  } catch (error) {
    return handoff(
      effectiveInput,
      run,
      `Repair worktree inspection before diff failed: ${errorMessage(error)}`,
      now,
    );
  }
  const verification = verificationEvidence(
    input.verification,
    run,
    intake,
    observedBeforeDiff,
  );
  if (verification === undefined)
    return handoff(
      effectiveInput,
      run,
      "Repair lacks actual verification evidence from the preceding durable step.",
      now,
    );
  let diff: string;
  try {
    diff = await input.readDiff(run);
    const observedAfterDiff = inspectWorkspaceReceipt(
      await input.workspaceInspect(run, observedBeforeDiff),
      observedBeforeDiff,
      false,
    );
    assertSameObservedFiles(observedBeforeDiff, observedAfterDiff);
    workspace = observedAfterDiff;
  } catch (error) {
    return handoff(
      effectiveInput,
      run,
      `Repair cannot safely read the assigned worktree diff: ${errorMessage(error)}`,
      now,
    );
  }
  const repositoryFacts =
    input.repositoryFacts ?? "No additional repository facts were supplied.";
  const attempt = run.repairRound;
  const model = intake.builder.model;
  const reasoningEffort = intake.builder.reasoningEffort;
  let rendered: RepairRenderReceipt;
  try {
    rendered = renderReceipt(
      await input.repair.render({
        issueNumber: run.issueNumber,
        issueTitle: intake.title,
        issueBody: intake.body,
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
  } catch (error) {
    return handoff(
      effectiveInput,
      run,
      `Repair prompt rendering failed: ${errorMessage(error)}`,
      now,
    );
  }
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
        model,
        reasoningEffort,
        findings: normalizedFindings,
        prompt: rendered.prompt,
        promptHash: rendered.promptHash,
        runId: run.id,
        worktreePath: workspace.path,
      },
      now,
    );
  } catch (error) {
    if (isStaleError(error)) return { kind: "stale", run };
    return handoff(
      effectiveInput,
      run,
      `Repair could not create its durable effect: ${errorMessage(error)}`,
      now,
    );
  }
  if (effect === undefined)
    return handoff(
      effectiveInput,
      run,
      "Repair was replayed or ambiguous; human Review must reconcile the prior effect.",
      now,
    );
  try {
    const beforeInvoke = inspectWorkspaceReceipt(
      await input.workspaceInspect(run, workspace),
      workspace,
      false,
    );
    assertSameObservedFiles(workspace, beforeInvoke);
  } catch (error) {
    const handoffReason = `Repair worktree changed before invocation: ${errorMessage(error)}`;
    return settleRepairHandoff(
      effectiveInput,
      run,
      effect,
      rendered,
      attempt,
      {},
      model,
      reasoningEffort,
      now(),
      handoffReason,
      now,
    );
  }
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
      model,
      reasoningEffort,
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
          model,
          reasoningEffort,
          "failed",
          startedAt,
          completedAt,
          handoffReason,
        ),
        requiredAction: bounded(handoffReason),
        at: completedAt,
      });
      return { kind: "human", run: settled.run, reason: handoffReason };
    } catch (error) {
      if (isStaleError(error)) return { kind: "stale", run };
      return handoff(
        effectiveInput,
        run,
        `Repair handoff settlement failed closed: ${errorMessage(error)}`,
        now,
      );
    }
  }
  if (input.workspaceInspect === undefined) {
    const reasonText =
      "Repair completed but workspace inspection is unavailable.";
    return settleRepairHandoff(
      effectiveInput,
      run,
      effect,
      rendered,
      attempt,
      receipt,
      model,
      reasoningEffort,
      startedAt,
      reasonText,
      now,
    );
  }
  let inspected: WorkspacePreparationReceipt;
  try {
    inspected = inspectWorkspaceReceipt(
      await input.workspaceInspect(run, workspace),
      workspace,
      true,
    );
    if (inspected.headSha === workspace.headSha)
      throw new Error("Repair did not produce a new worktree head.");
    const reportedFiles = [...terminal.changed_files].toSorted();
    const observedFiles = [...inspected.changedFiles].toSorted();
    if (
      reportedFiles.length === 0 ||
      reportedFiles.length !== observedFiles.length ||
      reportedFiles.some((path, index) => path !== observedFiles[index])
    )
      throw new Error(
        "Repair terminal files do not exactly match the observed worktree diff.",
      );
  } catch (error) {
    const handoffReason = `Repair workspace inspection failed: ${errorMessage(error)}`;
    return settleRepairHandoff(
      effectiveInput,
      run,
      effect,
      rendered,
      attempt,
      receipt,
      model,
      reasoningEffort,
      startedAt,
      handoffReason,
      now,
    );
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
        model,
        reasoningEffort,
        "completed",
        startedAt,
        completedAt,
        terminal.summary,
      ),
      at: completedAt,
    });
    return { kind: "repaired", run: settled.run };
  } catch (error) {
    if (isStaleError(error)) return { kind: "stale", run };
    return handoff(
      effectiveInput,
      run,
      `Repair settlement failed closed: ${errorMessage(error)}`,
      now,
    );
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
        return handoff(
          input,
          run,
          "Verification capability is unavailable.",
          now,
        );
      let verificationResult: Awaited<ReturnType<typeof executeClaimedRun>>;
      try {
        verificationResult = await executeClaimedRun({
          coordinator: input.coordinator,
          run,
          workspacePrepare: async () => workspaceFor(run),
          workspaceInspect: input.workspaceInspect,
          verify: input.verify,
          now,
        });
      } catch (error) {
        return handoff(
          input,
          run,
          `Verification could not safely resume: ${errorMessage(error)}`,
          now,
        );
      }
      if (verificationResult.kind === "stale")
        return { kind: "stale", run: verificationResult.run };
      run = verificationResult.run;
      if (verificationResult.kind === "reviewing") {
        verification = verificationResult.verification;
        continue;
      }
      if (verificationResult.kind === "verification_failed")
        verification = verificationResult.verification;
      if (run.state !== "repairing")
        return handoff(
          input,
          run,
          "Verification did not reach the review gate.",
          now,
        );
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
      return handoff(
        input,
        run,
        "Review loop reached an unexpected state.",
        now,
      );
    const repair = await executeRepairStage(
      { ...input, run, verification },
      run,
      findings,
    );
    if (repair.kind === "human" || repair.kind === "stale") return repair;
    run = repair.run;
    findings = undefined;
    if (input.verify === undefined || input.workspaceInspect === undefined)
      return handoff(
        input,
        run,
        "Repair completed but verification capability is unavailable.",
        now,
      );
    let verificationResult: Awaited<ReturnType<typeof executeClaimedRun>>;
    try {
      verificationResult = await executeClaimedRun({
        coordinator: input.coordinator,
        run,
        workspacePrepare: async () => workspaceFor(run),
        workspaceInspect: input.workspaceInspect,
        verify: input.verify,
        now,
      });
    } catch (error) {
      return handoff(
        input,
        run,
        `Verification after repair could not safely run: ${errorMessage(error)}`,
        now,
      );
    }
    if (verificationResult.kind === "stale")
      return { kind: "stale", run: verificationResult.run };
    run = verificationResult.run;
    if (verificationResult.kind === "reviewing") {
      verification = verificationResult.verification;
      continue;
    }
    if (verificationResult.kind === "verification_failed") {
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
  return handoff(
    input,
    run,
    "Review loop exceeded its bounded sequencing guard.",
    now,
  );
}

export const executeReviewAndRepair = executeReviewRepair;
