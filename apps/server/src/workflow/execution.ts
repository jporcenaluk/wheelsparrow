import { createHash } from "node:crypto";

import type { BuilderTerminalResult } from "../agents/builder.js";
import type { EffectRecord } from "../database/effects.js";
import { type RunRecord, StaleRevisionError } from "../database/runs.js";
import type {
  EffectDispatcherLike,
  EffectIntentCommand,
  EffectObserverLike,
  EffectResult,
  WorkflowCoordinator,
} from "./coordinator.js";

const workspaceEffectKey = (runId: string): string =>
  `run:${runId}:workspace:prepare`;
const intakeEffectKey = (runId: string): string =>
  `run:${runId}:intake:capture`;
const builderEffectKey = (runId: string): string =>
  `run:${runId}:agent:builder:attempt:1`;
const verificationEffectKey = (
  runId: string,
  reworkEpoch: number,
  attempt = 1,
): string => `run:${runId}:rework:${reworkEpoch}:verify:attempt:${attempt}`;
const shaPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const maximumTextBytes = 64 * 1024;
const maximumIdentifierBytes = 512;
const maximumAcceptanceCriterionBytes = 16 * 1024;
const maximumIntakeJsonBytes = 1024 * 1024;
const maximumPromptBytes = 1024 * 1024;
const maximumBuilderSummaryBytes = 4 * 1024;
const maximumBuilderEvidenceBytes = 1024;
const maximumBuilderLogBytes = 16 * 1024;
const maximumVerificationLogBytes = 16 * 1024;

/** The receipt required before a run may leave the preparing state. */
export interface WorkspacePreparationReceipt {
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: "main";
  readonly baseSha: string;
  readonly headSha: string;
  readonly changedFiles: readonly string[];
}

/** A narrow edge seam; the edge is called only after its intent is durable. */
export type WorkspacePreparation = (
  run: RunRecord,
) => unknown | PromiseLike<unknown>;

/** A narrow read-back seam; only its inspected result may become durable. */
export type WorkspaceInspection = (
  run: RunRecord,
  expectedReceipt: unknown,
) => unknown | PromiseLike<unknown>;

export interface IntakeDependency {
  readonly issueNodeId: string;
  readonly issueNumber: number;
  readonly isOpen: boolean;
}

export type IntakeDependencyState = readonly IntakeDependency[] | "unavailable";

export interface IntakeProjectFields {
  readonly projectId: string;
  readonly projectNumber: number;
  readonly projectItemId: string;
  readonly issueNodeId: string;
  readonly issueNumber: number;
  readonly status: string;
  readonly revision: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly priorityRank?: number;
}

export interface IntakeBuilderConfiguration {
  readonly command: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly timeoutMinutes: number;
}

/** The complete, durable issue contract consumed by the builder slice. */
export interface IntakeCapture {
  readonly title: string;
  readonly body: string;
  readonly acceptanceCriteria: readonly string[];
  readonly dependencyState: IntakeDependencyState;
  readonly project: IntakeProjectFields;
  readonly repository: string;
  readonly baseSha: string;
  readonly builder: IntakeBuilderConfiguration;
  readonly verificationCommand: string;
}

export interface BuilderRenderInput {
  readonly issueNumber: number;
  readonly worktreePath: string;
  readonly baseSha: string;
  readonly intake: IntakeCapture;
}

export interface BuilderPromptReceipt {
  readonly prompt: string;
  readonly promptHash: string;
}

export interface BuilderInvokeInput {
  readonly issueNumber: number;
  readonly worktreePath: string;
  readonly baseSha: string;
  readonly intake: IntakeCapture;
  readonly prompt: string;
  readonly promptHash: string;
  readonly model: string;
  readonly reasoningEffort: string;
}

/** The narrow adapter seam used by workflow execution tests and the process edge. */
export interface BuilderAdapter {
  readonly render: (
    input: BuilderRenderInput,
  ) => unknown | PromiseLike<unknown>;
  readonly invoke: (
    input: BuilderInvokeInput,
  ) => unknown | PromiseLike<unknown>;
}

export interface BuilderReceipt {
  readonly kind: "succeeded";
  readonly promptHash: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly terminal: BuilderTerminalResult;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: 0;
  readonly headSha: string;
  readonly changedFiles: readonly string[];
}

export interface VerificationInvokeInput {
  readonly command: string;
  readonly worktreePath: string;
  readonly intake: IntakeCapture;
  readonly expectedHeadSha: string;
}

export type VerificationAdapter = (
  input: VerificationInvokeInput,
) => unknown | PromiseLike<unknown>;

export interface VerificationReceipt {
  readonly kind: "succeeded";
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: 0;
  readonly signal: null;
  readonly stdout: string;
  readonly stderr: string;
  readonly headSha: string;
  readonly changedFiles: readonly string[];
}

export interface ExecutionCoordinator
  extends Pick<
    WorkflowCoordinator,
    | "createEffectIntent"
    | "beginEffect"
    | "settleExecution"
    | "transition"
    | "quarantineEffect"
  > {}

interface ExecuteClaimedRunInputBase {
  readonly coordinator: ExecutionCoordinator;
  /** The durable snapshot observed by the caller in `preparing`. */
  readonly run: RunRecord;
  readonly workspacePrepare: WorkspacePreparation;
  readonly workspaceInspect: WorkspaceInspection;
  readonly builder?: BuilderAdapter;
  readonly verify?: VerificationAdapter;
  readonly now?: () => string;
}

export type ExecuteClaimedRunInput = ExecuteClaimedRunInputBase & {
  readonly intake?: IntakeCapture;
  readonly intakeCapture?: IntakeCapture;
};

/** Read-only run access used by the restart capability. */
export type ExecutionRunReader = (
  runId: string,
) => RunRecord | PromiseLike<RunRecord>;

/** A coordinator-facing edge executor for one already-begun effect. */
export type ExecutionEffectExecutor = (
  effect: EffectRecord,
) => unknown | PromiseLike<unknown>;

/**
 * The Block 3 capability is deliberately narrower than the coordinator. It
 * receives a durable effect, reads the current run through this seam, and
 * returns a receipt; all durable settlement remains coordinator-owned.
 */
export interface ExecutionCapabilityInput {
  /** Prefer this seam: the caller supplies the executeClaimedRun/coordinator
   * adapter and retains all durable settlement behavior. */
  readonly execute?: ExecutionEffectExecutor;
  readonly readRun?: ExecutionRunReader;
  readonly workspacePrepare?: WorkspacePreparation;
  readonly workspaceInspect?: WorkspaceInspection;
  readonly builder?: BuilderAdapter;
  readonly verify?: VerificationAdapter;
}

export interface ExecutionCapability {
  readonly dispatcher: EffectDispatcherLike;
  readonly observer: EffectObserverLike;
}

export type ExecutionOutcome =
  | {
      readonly kind: "building";
      readonly run: RunRecord;
      readonly workspace: WorkspacePreparationReceipt;
      readonly intakeJson: string;
    }
  | {
      readonly kind: "workspace_failed";
      readonly run: RunRecord;
      readonly reason: string;
    }
  | {
      readonly kind: "builder_failed";
      readonly run: RunRecord;
      readonly reason: string;
    }
  | {
      readonly kind: "verifying";
      readonly run: RunRecord;
      readonly workspace: WorkspacePreparationReceipt;
      readonly intakeJson: string;
      readonly builder?: BuilderReceipt;
    }
  | {
      readonly kind: "reviewing";
      readonly run: RunRecord;
      readonly verification: VerificationReceipt;
    }
  | {
      readonly kind: "verification_failed";
      readonly run: RunRecord;
      readonly reason: string;
      readonly verification: {
        readonly kind: "failed";
        readonly command: string;
        readonly cwd: string;
        readonly exitCode: number | null;
        readonly signal: string | null;
        readonly stdout: string;
        readonly stderr: string;
        readonly headSha: string;
        readonly changedFiles: readonly string[];
        readonly reason: string;
      };
    }
  | {
      readonly kind: "stale";
      readonly run: RunRecord;
    };

export class WorkspaceReceiptError extends Error {
  override name = "WorkspaceReceiptError";
}

export class IntakeCaptureError extends Error {
  override name = "IntakeCaptureError";
}

export class BuilderReceiptError extends Error {
  override name = "BuilderReceiptError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isNonEmptyText(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    keys.length >= required.length &&
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function boundedText(
  value: unknown,
  _label: string,
  maximumBytes: number,
): value is string {
  return isNonEmptyText(value) && byteLength(value) <= maximumBytes;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null) return true;
  if (typeof value === "string") return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    !Array.isArray(value)
  )
    return false;
  ancestors.add(value);
  if (Array.isArray(value)) {
    const valid =
      isDenseArray(value) &&
      value.every((entry) => isJsonValue(entry, ancestors));
    ancestors.delete(value);
    return valid;
  }
  const valid = Object.entries(value).every(
    ([key, entry]) => key.length > 0 && isJsonValue(entry, ancestors),
  );
  ancestors.delete(value);
  return valid;
}

function validateJsonIntake(value: IntakeCapture): string {
  if (!isJsonValue(value))
    throw new IntakeCaptureError("Intake capture must contain JSON values.");
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new IntakeCaptureError("Intake capture must be JSON serializable.");
  }
  if (serialized === undefined)
    throw new IntakeCaptureError("Intake capture must be JSON serializable.");
  if (byteLength(serialized) > maximumIntakeJsonBytes)
    throw new IntakeCaptureError("Intake capture exceeds its size limit.");
  try {
    JSON.parse(serialized);
  } catch {
    throw new IntakeCaptureError("Intake capture must be valid JSON.");
  }
  return serialized;
}

export function validateIntakeCapture(value: unknown): IntakeCapture {
  if (!isRecord(value))
    throw new IntakeCaptureError("Intake capture must be an object.");
  if (
    !hasExactKeys(value, [
      "title",
      "body",
      "acceptanceCriteria",
      "dependencyState",
      "project",
      "repository",
      "baseSha",
      "builder",
      "verificationCommand",
    ]) ||
    !boundedText(value.title, "Issue title", maximumTextBytes) ||
    !boundedText(value.body, "Issue body", maximumTextBytes) ||
    !isDenseArray(value.acceptanceCriteria) ||
    value.acceptanceCriteria.length === 0 ||
    !value.acceptanceCriteria.every((criterion) =>
      boundedText(
        criterion,
        "Acceptance criterion",
        maximumAcceptanceCriterionBytes,
      ),
    ) ||
    !boundedText(value.repository, "Repository", maximumIdentifierBytes) ||
    typeof value.baseSha !== "string" ||
    !shaPattern.test(value.baseSha) ||
    !boundedText(
      value.verificationCommand,
      "Verification command",
      maximumTextBytes,
    )
  ) {
    throw new IntakeCaptureError(
      "Intake capture must contain bounded title, body, acceptance criteria, repository, base SHA, and verification command.",
    );
  }

  if (value.dependencyState !== "unavailable") {
    if (
      !isDenseArray(value.dependencyState) ||
      !value.dependencyState.every((dependency) => {
        if (!isRecord(dependency)) return false;
        return (
          hasExactKeys(dependency, ["issueNodeId", "issueNumber", "isOpen"]) &&
          boundedText(
            dependency.issueNodeId,
            "Dependency issue node ID",
            maximumIdentifierBytes,
          ) &&
          isPositiveSafeInteger(dependency.issueNumber) &&
          typeof dependency.isOpen === "boolean"
        );
      })
    ) {
      throw new IntakeCaptureError("Intake dependency state is invalid.");
    }
  }

  if (!isRecord(value.project))
    throw new IntakeCaptureError("Intake project fields are required.");
  const project = value.project;
  if (
    !hasExactKeys(
      project,
      [
        "projectId",
        "projectNumber",
        "projectItemId",
        "issueNodeId",
        "issueNumber",
        "status",
        "revision",
        "labels",
        "createdAt",
      ],
      ["priorityRank"],
    ) ||
    !boundedText(project.projectId, "Project ID", maximumIdentifierBytes) ||
    !isPositiveSafeInteger(project.projectNumber) ||
    !boundedText(
      project.projectItemId,
      "Project item ID",
      maximumIdentifierBytes,
    ) ||
    !boundedText(
      project.issueNodeId,
      "Issue node ID",
      maximumIdentifierBytes,
    ) ||
    !isPositiveSafeInteger(project.issueNumber) ||
    !boundedText(project.status, "Project status", maximumIdentifierBytes) ||
    !boundedText(
      project.revision,
      "Project revision",
      maximumIdentifierBytes,
    ) ||
    !isDenseArray(project.labels) ||
    project.labels.length === 0 ||
    !project.labels.every((label) =>
      boundedText(label, "Project label", maximumIdentifierBytes),
    ) ||
    !boundedText(
      project.createdAt,
      "Project creation time",
      maximumIdentifierBytes,
    ) ||
    (project.priorityRank !== undefined &&
      !Number.isSafeInteger(project.priorityRank))
  ) {
    throw new IntakeCaptureError("Intake project fields are invalid.");
  }

  if (!isRecord(value.builder))
    throw new IntakeCaptureError("Intake builder configuration is required.");
  const builder = value.builder;
  const timeoutMinutes = builder.timeoutMinutes;
  if (
    !hasExactKeys(builder, [
      "command",
      "model",
      "reasoningEffort",
      "timeoutMinutes",
    ]) ||
    !boundedText(builder.command, "Builder command", maximumTextBytes) ||
    !boundedText(builder.model, "Builder model", maximumIdentifierBytes) ||
    !boundedText(
      builder.reasoningEffort,
      "Builder reasoning effort",
      maximumIdentifierBytes,
    ) ||
    !Number.isSafeInteger(timeoutMinutes) ||
    (timeoutMinutes as number) < 1 ||
    (timeoutMinutes as number) > 240
  ) {
    throw new IntakeCaptureError("Intake builder configuration is invalid.");
  }

  const intake = value as unknown as IntakeCapture;
  validateJsonIntake(intake);
  return intake;
}

function validateWorkspaceReceipt(value: unknown): WorkspacePreparationReceipt {
  if (!isRecord(value))
    throw new WorkspaceReceiptError("Workspace receipt must be an object.");
  const keys = Object.keys(value).toSorted();
  if (
    keys.join(",") !== "baseBranch,baseSha,branch,changedFiles,headSha,path" ||
    !isNonEmptyText(value.path) ||
    !isNonEmptyText(value.branch) ||
    value.baseBranch !== "main" ||
    typeof value.baseSha !== "string" ||
    !shaPattern.test(value.baseSha) ||
    typeof value.headSha !== "string" ||
    !shaPattern.test(value.headSha) ||
    !validChangedFiles(value.changedFiles)
  ) {
    throw new WorkspaceReceiptError(
      "Workspace receipt must contain bounded path, branch, baseBranch=main, baseSha, headSha, and changedFiles.",
    );
  }
  return {
    path: value.path,
    branch: value.branch,
    baseBranch: "main",
    baseSha: value.baseSha,
    headSha: value.headSha,
    changedFiles: value.changedFiles,
  };
}

function validatePromptReceipt(value: unknown): BuilderPromptReceipt {
  if (!isRecord(value))
    throw new BuilderReceiptError("Builder prompt receipt must be an object.");
  if (
    !hasExactKeys(value, ["prompt", "promptHash"]) ||
    !isNonEmptyText(value.prompt) ||
    byteLength(value.prompt) > maximumPromptBytes ||
    typeof value.promptHash !== "string" ||
    !sha256Pattern.test(value.promptHash)
  ) {
    throw new BuilderReceiptError(
      "Builder prompt receipt must contain a bounded prompt and SHA-256 hash.",
    );
  }
  const expectedHash = createHash("sha256")
    .update(value.prompt, "utf8")
    .digest("hex");
  if (value.promptHash !== expectedHash)
    throw new BuilderReceiptError("Builder prompt hash does not match prompt.");
  return { prompt: value.prompt, promptHash: value.promptHash };
}

function validChangedFiles(value: unknown): value is readonly string[] {
  return (
    isDenseArray(value) &&
    value.length <= 4096 &&
    value.every((path) => {
      if (!isNonEmptyText(path) || byteLength(path) > maximumIdentifierBytes)
        return false;
      const segments = path.split(/[\\/]/u);
      return (
        !path.startsWith("/") &&
        !path.startsWith("\\") &&
        !segments.includes("..") &&
        !segments.includes(".")
      );
    })
  );
}

function boundedBuilderLog(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new BuilderReceiptError(`${label} must be text.`);
  if (byteLength(value) > maximumBuilderLogBytes)
    throw new BuilderReceiptError(`${label} exceeds its size limit.`);
  return value;
}

function validateBuilderTerminal(value: unknown): BuilderTerminalResult {
  if (!isRecord(value))
    throw new BuilderReceiptError("Builder terminal result must be an object.");
  if (
    !hasExactKeys(
      value,
      ["outcome", "summary", "validation"],
      ["requested_action"],
    ) ||
    (value.outcome !== "completed" && value.outcome !== "blocked") ||
    !boundedText(
      value.summary,
      "Builder summary",
      maximumBuilderSummaryBytes,
    ) ||
    !isDenseArray(value.validation) ||
    value.validation.length > 32 ||
    !value.validation.every((entry) =>
      boundedText(
        entry,
        "Builder validation evidence",
        maximumBuilderEvidenceBytes,
      ),
    ) ||
    (value.requested_action !== undefined &&
      !boundedText(
        value.requested_action,
        "Builder requested action",
        maximumBuilderEvidenceBytes,
      ))
  ) {
    throw new BuilderReceiptError(
      "Builder terminal result must be a completed or blocked bounded result.",
    );
  }
  return value as unknown as BuilderTerminalResult;
}

interface ValidatedBuilderSuccess {
  readonly kind: "succeeded";
  readonly terminal: BuilderTerminalResult;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: 0;
}

interface ValidatedBuilderFailure {
  readonly kind: "failed";
  readonly reason: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error?: string;
}

type ValidatedBuilderResult = ValidatedBuilderSuccess | ValidatedBuilderFailure;

interface BuilderFailureDetails {
  readonly terminal?: BuilderTerminalResult;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly error?: string;
}

function validateBuilderResult(value: unknown): ValidatedBuilderResult {
  if (
    !isRecord(value) ||
    (value.kind !== "succeeded" && value.kind !== "failed")
  )
    throw new BuilderReceiptError("Builder invocation result kind is invalid.");
  const stdout = boundedBuilderLog(value.stdout, "Builder stdout");
  const stderr = boundedBuilderLog(value.stderr, "Builder stderr");
  const exitCode = value.exitCode;
  if (value.kind === "failed") {
    const failedExitCode = exitCode === undefined ? null : exitCode;
    if (
      failedExitCode !== null &&
      (typeof failedExitCode !== "number" ||
        !Number.isSafeInteger(failedExitCode) ||
        failedExitCode < 0)
    )
      throw new BuilderReceiptError("Builder exit code is invalid.");
    if (
      typeof value.reason !== "string" ||
      value.reason.trim().length === 0 ||
      byteLength(value.reason) > maximumIdentifierBytes
    )
      throw new BuilderReceiptError("Builder failure reason is invalid.");
    if (value.signal !== null && typeof value.signal !== "string")
      throw new BuilderReceiptError("Builder failure signal is invalid.");
    const error =
      value.error === undefined
        ? undefined
        : boundedBuilderLog(value.error, "Builder error");
    return {
      kind: "failed",
      reason: value.reason,
      stdout,
      stderr,
      exitCode: failedExitCode,
      signal: value.signal,
      ...(error === undefined ? {} : { error }),
    };
  }
  const terminal = validateBuilderTerminal(value.terminal);
  if (exitCode !== 0)
    throw new BuilderReceiptError(
      "Builder success must have exit code exactly zero.",
    );
  return { kind: "succeeded", terminal, stdout, stderr, exitCode: 0 };
}

function persistedWorkspaceReceipt(
  run: RunRecord,
): WorkspacePreparationReceipt {
  try {
    return validateWorkspaceReceipt({
      path: run.worktreePath,
      branch: run.branch,
      baseBranch: run.baseBranch,
      baseSha: run.baseSha,
      headSha: run.headSha,
      changedFiles: [],
    });
  } catch (error) {
    throw new BuilderReceiptError(
      `Persisted workspace facts are invalid: ${errorMessage(error)}`,
    );
  }
}

function assertSameWorkspace(
  expected: WorkspacePreparationReceipt,
  observed: WorkspacePreparationReceipt,
): void {
  if (
    observed.path !== expected.path ||
    observed.branch !== expected.branch ||
    observed.baseBranch !== expected.baseBranch ||
    observed.baseSha !== expected.baseSha
  ) {
    throw new BuilderReceiptError(
      "Builder inspection changed the assigned workspace identity.",
    );
  }
}

function boundedFailureReason(reason: string): string {
  let result = reason;
  while (byteLength(result) > maximumBuilderSummaryBytes)
    result = result.slice(0, -1);
  return result || "Builder failed.";
}

function verificationPromptHash(command: string): string {
  return createHash("sha256")
    .update(`verification:${command}`, "utf8")
    .digest("hex");
}

function boundedVerificationLog(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new BuilderReceiptError(`${label} must be text.`);
  if (byteLength(value) > maximumVerificationLogBytes)
    throw new BuilderReceiptError(`${label} exceeds its size limit.`);
  return value;
}

function normalizedVerificationCommand(
  value: unknown,
  expected: string,
): string {
  if (typeof value === "string" && value === expected) return value;
  if (
    isDenseArray(value) &&
    value.every((argument) => typeof argument === "string") &&
    value.join(" ") === expected
  )
    return value.join(" ");
  throw new BuilderReceiptError(
    "Verification receipt command does not match intake.",
  );
}

interface ValidatedVerificationResult {
  readonly kind: "succeeded" | "failed";
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly headSha: string;
  readonly reason?: string;
}

function validateVerificationResult(
  value: unknown,
  expectedCommand: string,
  expectedCwd: string,
  expectedHeadSha: string,
): ValidatedVerificationResult {
  if (
    !isRecord(value) ||
    (value.kind !== "succeeded" && value.kind !== "failed")
  )
    throw new BuilderReceiptError("Verification receipt kind is invalid.");
  const command = normalizedVerificationCommand(value.command, expectedCommand);
  if (value.cwd !== expectedCwd)
    throw new BuilderReceiptError("Verification receipt cwd is invalid.");
  if (typeof value.exitCode !== "number" && value.exitCode !== null)
    throw new BuilderReceiptError("Verification exit code is invalid.");
  if (
    value.exitCode !== null &&
    (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0)
  )
    throw new BuilderReceiptError("Verification exit code is invalid.");
  if (value.signal !== null && typeof value.signal !== "string")
    throw new BuilderReceiptError("Verification signal is invalid.");
  const stdout = boundedVerificationLog(value.stdout, "Verification stdout");
  const stderr = boundedVerificationLog(value.stderr, "Verification stderr");
  if (typeof value.headSha !== "string" || !shaPattern.test(value.headSha))
    throw new BuilderReceiptError("Verification head SHA is invalid.");
  if (value.headSha !== expectedHeadSha)
    throw new BuilderReceiptError("Verification head SHA does not match.");
  if (
    value.kind === "succeeded" &&
    (value.exitCode !== 0 || value.signal !== null)
  )
    throw new BuilderReceiptError(
      "Verification success must have exit code zero and no signal.",
    );
  const reason =
    value.kind === "failed" &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0
      ? value.reason
      : undefined;
  return {
    kind: value.kind,
    command,
    cwd: value.cwd,
    exitCode: value.exitCode,
    signal: value.signal,
    stdout,
    stderr,
    headSha: value.headSha,
    ...(reason === undefined ? {} : { reason }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workspaceIntent(run: RunRecord): EffectIntentCommand {
  return {
    key: workspaceEffectKey(run.id),
    kind: "workspace_prepare",
    intent: {
      runId: run.id,
      issueNumber: run.issueNumber,
      baseBranch: run.baseBranch,
    },
    dispatch: false,
  };
}

function intakeIntent(
  run: RunRecord,
  intake: IntakeCapture,
): EffectIntentCommand {
  return {
    key: intakeEffectKey(run.id),
    kind: "intake_capture",
    intent: intake,
    dispatch: false,
  };
}

function builderIntent(
  run: RunRecord,
  intake: IntakeCapture,
  workspace: WorkspacePreparationReceipt,
  prompt: BuilderPromptReceipt,
): EffectIntentCommand {
  return {
    key: builderEffectKey(run.id),
    kind: "agent_build",
    intent: {
      runId: run.id,
      issueNumber: run.issueNumber,
      worktreePath: workspace.path,
      branch: workspace.branch,
      baseSha: workspace.baseSha,
      changedFiles: workspace.changedFiles,
      prompt: prompt.prompt,
      promptHash: prompt.promptHash,
      model: intake.builder.model,
      reasoningEffort: intake.builder.reasoningEffort,
      attempt: 1,
    },
    dispatch: false,
  };
}

function verificationIntent(
  run: RunRecord,
  intake: IntakeCapture,
  workspace: WorkspacePreparationReceipt,
): EffectIntentCommand {
  const attempt = run.repairRound + 1;
  return {
    key: verificationEffectKey(run.id, run.reworkEpoch, attempt),
    kind: "verify",
    intent: {
      runId: run.id,
      worktreePath: workspace.path,
      command: intake.verificationCommand,
      expectedHeadSha: workspace.headSha,
      changedFiles: workspace.changedFiles,
      attempt,
    },
    dispatch: false,
  };
}

type ExecutionEffectKind = "workspace_prepare" | "agent_build" | "verify";

interface CapabilityWorkspaceIntent {
  readonly runId: string;
  readonly issueNumber: number;
  readonly baseBranch: "main";
}

interface CapabilityBuilderIntent {
  readonly runId: string;
  readonly issueNumber: number;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly changedFiles: readonly string[];
  readonly prompt: string;
  readonly promptHash: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly attempt: 1;
}

interface CapabilityVerificationIntent {
  readonly runId: string;
  readonly worktreePath: string;
  readonly command: string;
  readonly expectedHeadSha: string;
  readonly changedFiles: readonly string[];
  readonly attempt: number;
}

function canonicalCapabilityJson(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalValue));
  if (!isRecord(value)) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new BuilderReceiptError("Effect intent is not JSON data.");
    return serialized;
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonicalValue(value[key])]),
    ),
  );
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  return value;
}

function capabilityKeys(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  return Object.keys(value).toSorted().join(",") === keys.toSorted().join(",");
}

function parseCapabilityIntent(
  effect: EffectRecord,
  kind: ExecutionEffectKind,
  keys: string[],
): Record<string, unknown> {
  const expectedKey =
    kind === "workspace_prepare"
      ? workspaceEffectKey(effect.runId)
      : kind === "agent_build"
        ? builderEffectKey(effect.runId)
        : undefined;
  if (
    effect.kind !== kind ||
    (expectedKey !== undefined && effect.key !== expectedKey)
  )
    throw new BuilderReceiptError("Effect is not owned by Block 3.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(effect.intent) as unknown;
  } catch {
    throw new BuilderReceiptError("Effect intent is not valid JSON.");
  }
  if (!isRecord(parsed) || !capabilityKeys(parsed, keys))
    throw new BuilderReceiptError("Effect intent has an invalid shape.");
  if (canonicalCapabilityJson(parsed) !== effect.intent)
    throw new BuilderReceiptError("Effect intent is not canonical JSON.");
  return parsed;
}

function capabilityFailureTrigger(
  kind: ExecutionEffectKind,
): Exclude<EffectResult["trigger"], undefined | null> {
  if (kind === "workspace_prepare") return "startup_failed";
  if (kind === "agent_build") return "builder_exhausted";
  return "verification_failed_exhausted";
}

function capabilityFailure(
  effect: EffectRecord,
  kind: ExecutionEffectKind,
  reason: string,
  receipt?: unknown,
): EffectResult {
  return {
    outcome: "failed",
    trigger: capabilityFailureTrigger(kind),
    ...(receipt === undefined ? {} : { receipt }),
    evidence: boundedFailureReason(`${effect.key}: ${reason}`),
  };
}

function capabilityAmbiguous(
  effect: EffectRecord,
  reason: string,
): EffectResult {
  return {
    outcome: "ambiguous",
    trigger: null,
    evidence: boundedFailureReason(`${effect.key}: ${reason}`),
  };
}

function capabilityWorkspace(
  value: Record<string, unknown>,
  run: RunRecord,
  expectedHeadSha: string,
): WorkspacePreparationReceipt {
  if (
    !isNonEmptyText(value.worktreePath) ||
    !isNonEmptyText(value.branch) ||
    typeof value.baseSha !== "string" ||
    !shaPattern.test(value.baseSha) ||
    !validChangedFiles(value.changedFiles)
  )
    throw new BuilderReceiptError("Effect workspace context is invalid.");
  if (
    run.worktreePath !== value.worktreePath ||
    run.branch !== value.branch ||
    run.baseSha !== value.baseSha
  )
    throw new BuilderReceiptError(
      "Effect workspace context does not match persisted run facts.",
    );
  return {
    path: value.worktreePath,
    branch: value.branch,
    baseBranch: "main",
    baseSha: value.baseSha,
    headSha: expectedHeadSha,
    changedFiles: value.changedFiles,
  };
}

function assertCapabilityWorkspaceStable(
  expected: WorkspacePreparationReceipt,
  observed: WorkspacePreparationReceipt,
): void {
  assertSameWorkspace(expected, observed);
  if (
    observed.headSha !== expected.headSha ||
    observed.changedFiles.length !== expected.changedFiles.length ||
    observed.changedFiles.some(
      (path, index) => path !== expected.changedFiles[index],
    )
  )
    throw new BuilderReceiptError(
      "Observed workspace changed before a restart dispatch.",
    );
}

function parseCapabilityIntake(run: RunRecord): IntakeCapture {
  if (run.intakeJson === null)
    throw new IntakeCaptureError("Effect run has no persisted intake.");
  try {
    return validateIntakeCapture(JSON.parse(run.intakeJson));
  } catch (error) {
    throw new IntakeCaptureError(
      `Persisted effect intake is invalid: ${errorMessage(error)}`,
    );
  }
}

function ensureCapabilityRun(
  effect: EffectRecord,
  run: RunRecord,
  kind: ExecutionEffectKind,
  dispatch: boolean,
): void {
  if (run.id !== effect.runId)
    throw new BuilderReceiptError("Effect run identity does not match.");
  if (dispatch && run.revision !== effect.targetRevision)
    throw new StaleRevisionError(effect.targetRevision);
  const expectedState =
    kind === "workspace_prepare"
      ? "preparing"
      : kind === "agent_build"
        ? "building"
        : "verifying";
  if (run.state !== expectedState)
    throw new BuilderReceiptError("Effect run state does not match its edge.");
}

async function inspectCapabilityWorkspace(
  input: ExecutionCapabilityInput,
  run: RunRecord,
  expected: WorkspacePreparationReceipt,
): Promise<WorkspacePreparationReceipt> {
  if (input.workspaceInspect === undefined)
    throw new BuilderReceiptError(
      "Workspace inspection capability unavailable.",
    );
  const observed = validateWorkspaceReceipt(
    await input.workspaceInspect(run, expected),
  );
  assertSameWorkspace(expected, observed);
  return observed;
}

async function _dispatchWorkspaceEffect(
  input: ExecutionCapabilityInput,
  effect: EffectRecord,
  run: RunRecord,
  intent: CapabilityWorkspaceIntent,
): Promise<EffectResult> {
  if (input.workspacePrepare === undefined)
    return capabilityFailure(
      effect,
      "workspace_prepare",
      "workspace preparation capability unavailable",
    );
  if (
    intent.runId !== run.id ||
    intent.issueNumber !== run.issueNumber ||
    intent.baseBranch !== run.baseBranch
  )
    return capabilityFailure(effect, "workspace_prepare", "intent mismatch");
  let rawReceipt: unknown;
  try {
    rawReceipt = await input.workspacePrepare(run);
    const workspace = await inspectCapabilityWorkspace(
      input,
      run,
      validateWorkspaceReceipt(rawReceipt),
    );
    return {
      outcome: "confirmed",
      trigger: "workspace_prepared",
      receipt: workspace,
      evidence: `Workspace prepared for ${run.id}.`,
    };
  } catch (error) {
    return capabilityFailure(
      effect,
      "workspace_prepare",
      `workspace edge failed: ${errorMessage(error)}`,
    );
  }
}

async function _dispatchBuilderEffect(
  input: ExecutionCapabilityInput,
  effect: EffectRecord,
  run: RunRecord,
  intent: CapabilityBuilderIntent,
): Promise<EffectResult> {
  if (input.builder === undefined)
    return capabilityFailure(
      effect,
      "agent_build",
      "builder capability unavailable",
    );
  let intake: IntakeCapture;
  let expected: WorkspacePreparationReceipt;
  try {
    intake = parseCapabilityIntake(run);
    if (
      intent.runId !== run.id ||
      intent.issueNumber !== run.issueNumber ||
      intent.model !== intake.builder.model ||
      intent.reasoningEffort !== intake.builder.reasoningEffort
    )
      throw new BuilderReceiptError("Builder intent does not match intake.");
    const promptReceipt = validatePromptReceipt({
      prompt: intent.prompt,
      promptHash: intent.promptHash,
    });
    expected = capabilityWorkspace(
      intent as unknown as Record<string, unknown>,
      run,
      run.headSha ?? intent.baseSha,
    );
    const before = await inspectCapabilityWorkspace(input, run, expected);
    assertCapabilityWorkspaceStable(expected, before);
    let rawResult: unknown;
    try {
      rawResult = await input.builder.invoke({
        issueNumber: run.issueNumber,
        worktreePath: expected.path,
        baseSha: expected.baseSha,
        intake,
        prompt: promptReceipt.prompt,
        promptHash: promptReceipt.promptHash,
        model: intake.builder.model,
        reasoningEffort: intake.builder.reasoningEffort,
      });
    } catch (error) {
      return capabilityFailure(
        effect,
        "agent_build",
        `builder edge failed: ${errorMessage(error)}`,
      );
    }
    if (!isRecord(rawResult))
      throw new BuilderReceiptError("Builder receipt must be an object.");
    if (
      rawResult.promptHash !== undefined &&
      rawResult.promptHash !== promptReceipt.promptHash
    )
      throw new BuilderReceiptError("Builder prompt hash does not match.");
    if (
      rawResult.model !== undefined &&
      rawResult.model !== intake.builder.model
    )
      throw new BuilderReceiptError("Builder model does not match intake.");
    if (
      rawResult.reasoningEffort !== undefined &&
      rawResult.reasoningEffort !== intake.builder.reasoningEffort
    )
      throw new BuilderReceiptError(
        "Builder reasoning effort does not match intake.",
      );
    const result = validateBuilderResult(rawResult);
    if (result.kind === "failed") {
      return capabilityFailure(
        effect,
        "agent_build",
        `Builder failed: ${result.reason}`,
        {
          kind: "failed",
          promptHash: promptReceipt.promptHash,
          model: intake.builder.model,
          reasoningEffort: intake.builder.reasoningEffort,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          signal: result.signal,
          ...(result.error === undefined ? {} : { error: result.error }),
        },
      );
    }
    if (result.terminal.outcome === "blocked")
      return capabilityFailure(
        effect,
        "agent_build",
        "Builder returned a blocked terminal",
        {
          kind: "failed",
          promptHash: promptReceipt.promptHash,
          model: intake.builder.model,
          reasoningEffort: intake.builder.reasoningEffort,
          terminal: result.terminal,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          signal: null,
        },
      );
    const after = await inspectCapabilityWorkspace(input, run, expected);
    if (isRecord(rawResult) && rawResult.headSha !== undefined) {
      if (rawResult.headSha !== after.headSha)
        throw new BuilderReceiptError(
          "Builder head SHA does not match workspace.",
        );
    }
    const receipt: BuilderReceipt = {
      kind: "succeeded",
      promptHash: promptReceipt.promptHash,
      model: intake.builder.model,
      reasoningEffort: intake.builder.reasoningEffort,
      terminal: result.terminal,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
      headSha: after.headSha,
      changedFiles: after.changedFiles,
    };
    return {
      outcome: "confirmed",
      trigger: "builder_succeeded",
      receipt,
      evidence: boundedFailureReason(result.terminal.summary),
    };
  } catch (error) {
    return capabilityFailure(
      effect,
      "agent_build",
      `Malformed builder effect context or receipt: ${errorMessage(error)}`,
    );
  }
}

async function _dispatchVerificationEffect(
  input: ExecutionCapabilityInput,
  effect: EffectRecord,
  run: RunRecord,
  intent: CapabilityVerificationIntent,
): Promise<EffectResult> {
  if (input.verify === undefined)
    return capabilityFailure(
      effect,
      "verify",
      "verification capability unavailable",
    );
  try {
    const intake = parseCapabilityIntake(run);
    if (
      intent.runId !== run.id ||
      intent.worktreePath !== run.worktreePath ||
      intent.expectedHeadSha !== run.headSha ||
      intent.command !== intake.verificationCommand ||
      intent.attempt !== run.repairRound + 1
    )
      throw new BuilderReceiptError(
        "Verification intent does not match run facts.",
      );
    const expected = capabilityWorkspace(
      {
        worktreePath: intent.worktreePath,
        branch: run.branch,
        baseSha: run.baseSha,
        changedFiles: intent.changedFiles,
      },
      run,
      intent.expectedHeadSha,
    );
    await inspectCapabilityWorkspace(input, run, expected);
    let rawResult: unknown;
    try {
      rawResult = await input.verify({
        command: intent.command,
        worktreePath: intent.worktreePath,
        intake,
        expectedHeadSha: intent.expectedHeadSha,
      });
      const inspected = await inspectCapabilityWorkspace(input, run, expected);
      assertCapabilityWorkspaceStable(expected, inspected);
    } catch (error) {
      return capabilityFailure(
        effect,
        "verify",
        `verification edge failed: ${errorMessage(error)}`,
      );
    }
    const result = validateVerificationResult(
      rawResult,
      intent.command,
      intent.worktreePath,
      intent.expectedHeadSha,
    );
    if (result.kind === "failed")
      return capabilityFailure(
        effect,
        "verify",
        `Verification failed: ${result.reason ?? "command failed"}`,
        {
          kind: "failed",
          command: result.command,
          cwd: result.cwd,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
          headSha: result.headSha,
          changedFiles: intent.changedFiles,
          reason: result.reason ?? "command failed",
        },
      );
    const receipt: VerificationReceipt = {
      kind: "succeeded",
      command: result.command,
      cwd: result.cwd,
      exitCode: 0,
      signal: null,
      stdout: result.stdout,
      stderr: result.stderr,
      headSha: result.headSha,
      changedFiles: intent.changedFiles,
    };
    return {
      outcome: "confirmed",
      trigger: "verification_passed",
      receipt,
      evidence: "Verification passed.",
    };
  } catch (error) {
    return capabilityFailure(
      effect,
      "verify",
      `Malformed verification effect context or receipt: ${errorMessage(error)}`,
    );
  }
}

async function readCapabilityRun(
  input: ExecutionCapabilityInput,
  effect: EffectRecord,
): Promise<RunRecord> {
  if (input.readRun === undefined)
    throw new BuilderReceiptError(
      "Execution capability read seam unavailable.",
    );
  const run = await input.readRun(effect.runId);
  if (!isRecord(run) || run.id !== effect.runId)
    throw new BuilderReceiptError("Read run does not match effect identity.");
  return run as unknown as RunRecord;
}

function ownedExecutionKind(
  kind: EffectRecord["kind"],
): kind is ExecutionEffectKind {
  return (
    kind === "workspace_prepare" || kind === "agent_build" || kind === "verify"
  );
}

function capabilityIntentKeys(kind: ExecutionEffectKind): string[] {
  if (kind === "workspace_prepare")
    return ["baseBranch", "issueNumber", "runId"];
  if (kind === "agent_build")
    return [
      "attempt",
      "baseSha",
      "branch",
      "changedFiles",
      "issueNumber",
      "model",
      "prompt",
      "promptHash",
      "reasoningEffort",
      "runId",
      "worktreePath",
    ];
  return [
    "attempt",
    "changedFiles",
    "command",
    "expectedHeadSha",
    "runId",
    "worktreePath",
  ];
}

function parseOwnedCapabilityIntent(
  effect: EffectRecord,
):
  | CapabilityWorkspaceIntent
  | CapabilityBuilderIntent
  | CapabilityVerificationIntent {
  if (!ownedExecutionKind(effect.kind))
    throw new BuilderReceiptError("Effect kind is outside Block 3 ownership.");
  const parsed = parseCapabilityIntent(
    effect,
    effect.kind,
    capabilityIntentKeys(effect.kind),
  );
  if (
    effect.kind === "verify" &&
    (typeof parsed.attempt !== "number" ||
      !Number.isSafeInteger(parsed.attempt) ||
      parsed.attempt < 1 ||
      effect.key !==
        verificationEffectKey(
          effect.runId,
          effect.reworkEpoch,
          parsed.attempt as number,
        ))
  )
    throw new BuilderReceiptError(
      "Verification effect key does not match attempt.",
    );
  if (effect.kind === "workspace_prepare") {
    if (
      typeof parsed.runId !== "string" ||
      !isPositiveSafeInteger(parsed.issueNumber) ||
      parsed.baseBranch !== "main"
    )
      throw new BuilderReceiptError("Workspace effect intent is invalid.");
    return parsed as unknown as CapabilityWorkspaceIntent;
  }
  if (effect.kind === "agent_build") {
    if (
      typeof parsed.runId !== "string" ||
      !isPositiveSafeInteger(parsed.issueNumber) ||
      !isNonEmptyText(parsed.worktreePath) ||
      !isNonEmptyText(parsed.branch) ||
      typeof parsed.baseSha !== "string" ||
      !shaPattern.test(parsed.baseSha) ||
      !validChangedFiles(parsed.changedFiles) ||
      !isNonEmptyText(parsed.prompt) ||
      !isNonEmptyText(parsed.promptHash) ||
      !sha256Pattern.test(parsed.promptHash) ||
      !isNonEmptyText(parsed.model) ||
      !isNonEmptyText(parsed.reasoningEffort) ||
      parsed.attempt !== 1
    )
      throw new BuilderReceiptError("Builder effect intent is invalid.");
    validatePromptReceipt({
      prompt: parsed.prompt,
      promptHash: parsed.promptHash,
    });
    return parsed as unknown as CapabilityBuilderIntent;
  }
  if (
    typeof parsed.runId !== "string" ||
    !isNonEmptyText(parsed.worktreePath) ||
    !isNonEmptyText(parsed.command) ||
    typeof parsed.expectedHeadSha !== "string" ||
    !shaPattern.test(parsed.expectedHeadSha) ||
    !validChangedFiles(parsed.changedFiles) ||
    !Number.isSafeInteger(parsed.attempt) ||
    (parsed.attempt as number) < 1
  )
    throw new BuilderReceiptError("Verification effect intent is invalid.");
  return parsed as unknown as CapabilityVerificationIntent;
}

/**
 * Build the restart-safe Block 3 edge capability. Pending effects are
 * dispatchable only after their canonical intent and current run are checked.
 * In-flight and ambiguous process effects are observed fail-closed; neither
 * builder nor verifier is relaunched or adopted from process state.
 */
export function createExecutionCapability(
  input: ExecutionCapabilityInput,
): ExecutionCapability {
  const dispatch = async (
    effect: EffectRecord,
  ): Promise<EffectResult | undefined> => {
    if (!ownedExecutionKind(effect.kind))
      throw new BuilderReceiptError(
        "Execution capability does not own effect kind.",
      );
    if (effect.status !== "in_flight")
      return capabilityAmbiguous(effect, "effect is not safely dispatchable");
    try {
      const run = await readCapabilityRun(input, effect);
      ensureCapabilityRun(effect, run, effect.kind, true);
      parseOwnedCapabilityIntent(effect);
    } catch (error) {
      if (error instanceof StaleRevisionError)
        return capabilityAmbiguous(effect, "effect revision is stale");
      return capabilityFailure(
        effect,
        effect.kind,
        `invalid canonical effect context: ${errorMessage(error)}`,
      );
    }
    if (input.execute === undefined)
      return capabilityAmbiguous(
        effect,
        "coordinator-owned execution settlement capability is unavailable",
      );
    try {
      // This seam owns the actual edge and must settle its receipt through
      // WorkflowCoordinator.settleExecution. Returning undefined prevents the
      // generic coordinator callback from advancing state without its facts
      // and append-only step record.
      await input.execute(effect);
      return undefined;
    } catch (error) {
      return capabilityAmbiguous(
        effect,
        `coordinator-owned execution settlement failed: ${errorMessage(error)}`,
      );
    }
  };

  const observe = async (effect: EffectRecord): Promise<EffectResult> => {
    if (!ownedExecutionKind(effect.kind))
      throw new BuilderReceiptError(
        "Execution capability does not own effect kind.",
      );
    if (effect.status !== "in_flight" && effect.status !== "ambiguous")
      return capabilityAmbiguous(effect, "effect is not observable");
    try {
      const run = await readCapabilityRun(input, effect);
      ensureCapabilityRun(effect, run, effect.kind, false);
      parseOwnedCapabilityIntent(effect);
    } catch (error) {
      return capabilityAmbiguous(
        effect,
        `cannot prove canonical context or ownership: ${errorMessage(error)}`,
      );
    }
    return capabilityAmbiguous(
      effect,
      "external process completion is not provable after restart; no process was relaunched or adopted",
    );
  };
  return { dispatcher: dispatch, observer: observe };
}

function isDispatchable(effect: EffectRecord): boolean {
  return effect.status === "pending";
}

async function schedule(
  coordinator: ExecutionCoordinator,
  run: RunRecord,
  command: EffectIntentCommand,
  now: () => string,
): Promise<EffectRecord | undefined> {
  const result = await coordinator.createEffectIntent({
    ...command,
    runId: run.id,
    expectedRevision: run.revision,
    at: now(),
  });
  // A confirmed, failed, canceled, in-flight, or ambiguous effect belongs to
  // an earlier attempt. Never call an edge again for that durable key.
  if (!isDispatchable(result)) return undefined;
  return coordinator.beginEffect({
    effectKey: result.key,
    expectedRevision: run.revision,
    at: now(),
  });
}

async function settleVerificationFailure(
  input: ExecuteClaimedRunInput,
  run: RunRecord,
  intake: IntakeCapture,
  workspace: WorkspacePreparationReceipt,
  effect: EffectRecord,
  reason: string,
  stdout: string,
  stderr: string,
  details:
    | Pick<
        ValidatedVerificationResult,
        "command" | "cwd" | "exitCode" | "signal" | "headSha"
      >
    | undefined,
  startedAt: string,
  now: () => string,
): Promise<ExecutionOutcome> {
  const boundedReason = boundedFailureReason(
    `${reason} stdout=${stdout} stderr=${stderr}`,
  );
  const attempt = run.repairRound + 1;
  const trigger =
    run.repairRound >= 2
      ? "verification_failed_exhausted"
      : "verification_failed_repairable";
  const failureReceipt = {
    kind: "failed" as const,
    command: details?.command ?? intake.verificationCommand,
    cwd: details?.cwd ?? workspace.path,
    exitCode: details?.exitCode ?? null,
    signal: details?.signal ?? null,
    stdout,
    stderr,
    headSha: details?.headSha ?? workspace.headSha,
    changedFiles: workspace.changedFiles,
    reason: boundedFailureReason(reason),
  };
  try {
    const settled = await input.coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome: "failed",
      trigger,
      evidence: boundedReason,
      receipt: failureReceipt,
      step: {
        id: `run:${run.id}:rework:${run.reworkEpoch}:verify:attempt:${attempt}:step`,
        runId: run.id,
        expectedRevision: run.revision,
        reworkEpoch: run.reworkEpoch,
        role: "verifier",
        logicalStep: "verify",
        attempt,
        statusSequence: 1,
        status: "failed",
        promptHash: verificationPromptHash(intake.verificationCommand),
        model: intake.builder.model,
        reasoningEffort: intake.builder.reasoningEffort,
        startedAt,
        completedAt: now(),
        exitResultJson: JSON.stringify(failureReceipt),
        summary: { text: boundedReason },
        rawLogReference: `logs/${run.id}/rework-${run.reworkEpoch}/verifier/attempt-${attempt}.jsonl`,
      },
      at: now(),
    });
    return {
      kind: "verification_failed",
      run: settled.run,
      reason: boundedReason,
      verification: failureReceipt,
    };
  } catch (error) {
    if (error instanceof StaleRevisionError) return { kind: "stale", run };
    throw error;
  }
}

async function executeVerificationStage(
  input: ExecuteClaimedRunInput,
  run: RunRecord,
  intake: IntakeCapture,
  intakeJson: string,
  workspace: WorkspacePreparationReceipt,
  now: () => string,
): Promise<ExecutionOutcome> {
  if (input.verify === undefined)
    return { kind: "verifying", run, workspace, intakeJson };

  let verificationEffect: EffectRecord | undefined;
  try {
    verificationEffect = await schedule(
      input.coordinator,
      run,
      verificationIntent(run, intake, workspace),
      now,
    );
  } catch (error) {
    if (error instanceof StaleRevisionError) return { kind: "stale", run };
    throw error;
  }
  if (verificationEffect === undefined) return { kind: "stale", run };

  const startedAt = now();
  const attempt = run.repairRound + 1;
  let rawResult: unknown;
  try {
    rawResult = await input.verify({
      command: intake.verificationCommand,
      worktreePath: workspace.path,
      intake,
      expectedHeadSha: workspace.headSha,
    });
  } catch (error) {
    return settleVerificationFailure(
      input,
      run,
      intake,
      workspace,
      verificationEffect,
      `Verification invocation failed: ${errorMessage(error)}`,
      "",
      "",
      undefined,
      startedAt,
      now,
    );
  }

  try {
    const inspected = validateWorkspaceReceipt(
      await input.workspaceInspect(run, workspace),
    );
    assertCapabilityWorkspaceStable(workspace, inspected);
    workspace = inspected;
  } catch (error) {
    return settleVerificationFailure(
      input,
      run,
      intake,
      workspace,
      verificationEffect,
      `Verification workspace changed after the command: ${errorMessage(error)}`,
      "",
      "",
      undefined,
      startedAt,
      now,
    );
  }

  let result: ValidatedVerificationResult;
  try {
    result = validateVerificationResult(
      rawResult,
      intake.verificationCommand,
      workspace.path,
      workspace.headSha,
    );
  } catch (error) {
    return settleVerificationFailure(
      input,
      run,
      intake,
      workspace,
      verificationEffect,
      `Malformed verification receipt: ${errorMessage(error)}`,
      "",
      "",
      undefined,
      startedAt,
      now,
    );
  }

  if (result.kind === "failed")
    return settleVerificationFailure(
      input,
      run,
      intake,
      workspace,
      verificationEffect,
      `Verification failed: ${result.reason ?? "verification command failed"}`,
      result.stdout,
      result.stderr,
      result,
      startedAt,
      now,
    );

  const verification: VerificationReceipt = {
    kind: "succeeded",
    command: result.command,
    cwd: result.cwd,
    exitCode: 0,
    signal: null,
    stdout: result.stdout,
    stderr: result.stderr,
    headSha: result.headSha,
    changedFiles: workspace.changedFiles,
  };
  const completedAt = now();
  try {
    const settled = await input.coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: verificationEffect.key,
      outcome: "confirmed",
      trigger: "verification_passed",
      evidence: "Verification passed.",
      receipt: verification,
      facts: { headSha: verification.headSha },
      step: {
        id: `run:${run.id}:rework:${run.reworkEpoch}:verify:attempt:${attempt}:step`,
        runId: run.id,
        expectedRevision: run.revision,
        reworkEpoch: run.reworkEpoch,
        role: "verifier",
        logicalStep: "verify",
        attempt,
        statusSequence: 1,
        status: "completed",
        promptHash: verificationPromptHash(intake.verificationCommand),
        model: intake.builder.model,
        reasoningEffort: intake.builder.reasoningEffort,
        startedAt,
        completedAt,
        exitResultJson: JSON.stringify(verification),
        summary: { text: "Verification passed." },
        rawLogReference: `logs/${run.id}/rework-${run.reworkEpoch}/verifier/attempt-${attempt}.jsonl`,
      },
      at: completedAt,
    });
    return { kind: "reviewing", run: settled.run, verification };
  } catch (error) {
    if (error instanceof StaleRevisionError) return { kind: "stale", run };
    throw error;
  }
}

async function settleBuilderFailure(
  input: ExecuteClaimedRunInput,
  run: RunRecord,
  intake: IntakeCapture,
  workspace: WorkspacePreparationReceipt,
  prompt: BuilderPromptReceipt,
  effect: EffectRecord,
  reason: string,
  details: BuilderFailureDetails | undefined,
  startedAt: string,
  now: () => string,
): Promise<ExecutionOutcome> {
  const boundedReason = boundedFailureReason(reason);
  const failureReceipt = {
    kind: "failed" as const,
    promptHash: prompt.promptHash,
    model: intake.builder.model,
    reasoningEffort: intake.builder.reasoningEffort,
    summary: boundedReason,
    headSha: workspace.headSha,
    changedFiles: workspace.changedFiles,
    ...(details?.terminal === undefined ? {} : { terminal: details.terminal }),
    stdout: details?.stdout ?? "",
    stderr: details?.stderr ?? "",
    exitCode: details?.exitCode ?? null,
    signal: details?.signal ?? null,
    ...(details?.error === undefined ? {} : { error: details.error }),
  };
  try {
    const settled = await input.coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: effect.key,
      outcome: "failed",
      trigger: "builder_exhausted",
      evidence: boundedReason,
      receipt: failureReceipt,
      step: {
        id: `run:${run.id}:builder:attempt:1:step`,
        runId: run.id,
        expectedRevision: run.revision,
        reworkEpoch: run.reworkEpoch,
        role: "builder",
        logicalStep: "build",
        attempt: 1,
        statusSequence: 1,
        status: "failed",
        promptHash: prompt.promptHash,
        model: intake.builder.model,
        reasoningEffort: intake.builder.reasoningEffort,
        startedAt,
        completedAt: now(),
        exitResultJson: JSON.stringify(failureReceipt),
        summary: { text: boundedReason },
        rawLogReference: `logs/${run.id}/builder/attempt-1.jsonl`,
      },
      at: now(),
    });
    return { kind: "builder_failed", run: settled.run, reason: boundedReason };
  } catch (error) {
    if (error instanceof StaleRevisionError) return { kind: "stale", run };
    throw error;
  }
}

async function executeBuilderStage(
  input: ExecuteClaimedRunInput,
  run: RunRecord,
  intake: IntakeCapture,
  intakeJson: string,
  workspace: WorkspacePreparationReceipt,
  now: () => string,
): Promise<ExecutionOutcome> {
  if (input.builder === undefined)
    return { kind: "building", run, workspace, intakeJson };

  let prompt: BuilderPromptReceipt;
  try {
    prompt = validatePromptReceipt(
      await input.builder.render({
        issueNumber: run.issueNumber,
        worktreePath: workspace.path,
        baseSha: workspace.baseSha,
        intake,
      }),
    );
  } catch (error) {
    throw new BuilderReceiptError(
      `Builder prompt rendering failed: ${errorMessage(error)}`,
    );
  }

  let builderEffect: EffectRecord | undefined;
  try {
    builderEffect = await schedule(
      input.coordinator,
      run,
      builderIntent(run, intake, workspace, prompt),
      now,
    );
  } catch (error) {
    if (error instanceof StaleRevisionError) return { kind: "stale", run };
    throw error;
  }
  if (builderEffect === undefined) return { kind: "stale", run };

  const startedAt = now();
  let rawResult: unknown;
  try {
    rawResult = await input.builder.invoke({
      issueNumber: run.issueNumber,
      worktreePath: workspace.path,
      baseSha: workspace.baseSha,
      intake,
      prompt: prompt.prompt,
      promptHash: prompt.promptHash,
      model: intake.builder.model,
      reasoningEffort: intake.builder.reasoningEffort,
    });
  } catch (error) {
    return settleBuilderFailure(
      input,
      run,
      intake,
      workspace,
      prompt,
      builderEffect,
      `Builder invocation failed: ${errorMessage(error)}`,
      undefined,
      startedAt,
      now,
    );
  }

  let result: ValidatedBuilderResult;
  try {
    if (!isRecord(rawResult))
      throw new BuilderReceiptError("Builder receipt must be an object.");
    if (
      rawResult.promptHash !== undefined &&
      rawResult.promptHash !== prompt.promptHash
    )
      throw new BuilderReceiptError("Builder prompt hash does not match.");
    if (
      rawResult.model !== undefined &&
      rawResult.model !== intake.builder.model
    )
      throw new BuilderReceiptError("Builder model does not match intake.");
    if (
      rawResult.reasoningEffort !== undefined &&
      rawResult.reasoningEffort !== intake.builder.reasoningEffort
    )
      throw new BuilderReceiptError(
        "Builder reasoning effort does not match intake.",
      );
    result = validateBuilderResult(rawResult);
  } catch (error) {
    return settleBuilderFailure(
      input,
      run,
      intake,
      workspace,
      prompt,
      builderEffect,
      `Malformed builder receipt: ${errorMessage(error)}`,
      undefined,
      startedAt,
      now,
    );
  }

  if (result.kind === "failed")
    return settleBuilderFailure(
      input,
      run,
      intake,
      workspace,
      prompt,
      builderEffect,
      `Builder failed: ${result.reason}`,
      result,
      startedAt,
      now,
    );

  if (result.terminal.outcome === "blocked")
    return settleBuilderFailure(
      input,
      run,
      intake,
      workspace,
      prompt,
      builderEffect,
      `Builder blocked: ${result.terminal.summary}${
        result.terminal.requested_action === undefined
          ? ""
          : ` Requested action: ${result.terminal.requested_action}`
      }`,
      {
        terminal: result.terminal,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
      startedAt,
      now,
    );

  let observedWorkspace: WorkspacePreparationReceipt;
  try {
    observedWorkspace = validateWorkspaceReceipt(
      await input.workspaceInspect(run, workspace),
    );
    assertSameWorkspace(workspace, observedWorkspace);
    if (isRecord(rawResult) && rawResult.headSha !== undefined) {
      if (
        typeof rawResult.headSha !== "string" ||
        !shaPattern.test(rawResult.headSha) ||
        rawResult.headSha !== observedWorkspace.headSha
      )
        throw new BuilderReceiptError(
          "Builder head SHA does not match workspace.",
        );
    }
  } catch (error) {
    return settleBuilderFailure(
      input,
      run,
      intake,
      workspace,
      prompt,
      builderEffect,
      `Builder workspace inspection failed: ${errorMessage(error)}`,
      undefined,
      startedAt,
      now,
    );
  }

  const completedAt = now();
  const builder: BuilderReceipt = {
    kind: "succeeded",
    promptHash: prompt.promptHash,
    model: intake.builder.model,
    reasoningEffort: intake.builder.reasoningEffort,
    terminal: result.terminal,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    headSha: observedWorkspace.headSha,
    changedFiles: observedWorkspace.changedFiles,
  };
  try {
    const settled = await input.coordinator.settleExecution({
      runId: run.id,
      expectedRevision: run.revision,
      effectKey: builderEffect.key,
      outcome: "confirmed",
      trigger: "builder_succeeded",
      evidence: boundedFailureReason(result.terminal.summary),
      receipt: builder,
      facts: { headSha: observedWorkspace.headSha },
      step: {
        id: `run:${run.id}:builder:attempt:1:step`,
        runId: run.id,
        expectedRevision: run.revision,
        reworkEpoch: run.reworkEpoch,
        role: "builder",
        logicalStep: "build",
        attempt: 1,
        statusSequence: 1,
        status: "completed",
        promptHash: prompt.promptHash,
        model: intake.builder.model,
        reasoningEffort: intake.builder.reasoningEffort,
        startedAt,
        completedAt,
        exitResultJson: JSON.stringify(builder),
        summary: { text: result.terminal.summary },
        rawLogReference: `logs/${run.id}/builder/attempt-1.jsonl`,
      },
      at: completedAt,
    });
    return executeVerificationStage(
      input,
      settled.run,
      intake,
      intakeJson,
      observedWorkspace,
      now,
    );
  } catch (error) {
    if (error instanceof StaleRevisionError) return { kind: "stale", run };
    throw error;
  }
}

export async function executeClaimedRun(
  input: ExecuteClaimedRunInput,
): Promise<ExecutionOutcome> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.run.state === "verifying") {
    let intake: IntakeCapture;
    let intakeJson: string;
    let workspace: WorkspacePreparationReceipt;
    try {
      if (input.run.intakeJson === null)
        throw new IntakeCaptureError("Verifying run has no persisted intake.");
      intake = validateIntakeCapture(JSON.parse(input.run.intakeJson));
      intakeJson = validateJsonIntake(intake);
      workspace = persistedWorkspaceReceipt(input.run);
    } catch (error) {
      throw new BuilderReceiptError(
        `Verifying run cannot be resumed: ${errorMessage(error)}`,
      );
    }
    if (input.verify !== undefined) {
      try {
        const inspected = validateWorkspaceReceipt(
          await input.workspaceInspect(input.run, workspace),
        );
        assertSameWorkspace(workspace, inspected);
        workspace = inspected;
      } catch (error) {
        throw new BuilderReceiptError(
          `Verifying workspace cannot be resumed: ${errorMessage(error)}`,
        );
      }
    }
    return executeVerificationStage(
      input,
      input.run,
      intake,
      intakeJson,
      workspace,
      now,
    );
  }
  if (input.run.state === "building") {
    let intake: IntakeCapture;
    let intakeJson: string;
    let workspace: WorkspacePreparationReceipt;
    try {
      if (input.run.intakeJson === null)
        throw new IntakeCaptureError("Building run has no persisted intake.");
      intake = validateIntakeCapture(JSON.parse(input.run.intakeJson));
      intakeJson = validateJsonIntake(intake);
      workspace = persistedWorkspaceReceipt(input.run);
    } catch (error) {
      throw new BuilderReceiptError(
        `Building run cannot be resumed: ${errorMessage(error)}`,
      );
    }
    if (input.builder !== undefined) {
      try {
        const inspected = validateWorkspaceReceipt(
          await input.workspaceInspect(input.run, workspace),
        );
        assertSameWorkspace(workspace, inspected);
        workspace = inspected;
      } catch (error) {
        throw new BuilderReceiptError(
          `Building workspace cannot be resumed: ${errorMessage(error)}`,
        );
      }
    }
    return executeBuilderStage(
      input,
      input.run,
      intake,
      intakeJson,
      workspace,
      now,
    );
  }
  if (input.run.state !== "preparing") return { kind: "stale", run: input.run };
  const intakeValue = input.intake ?? input.intakeCapture;
  if (intakeValue === undefined)
    throw new IntakeCaptureError(
      "Intake capture is required before preparing.",
    );
  const intake = validateIntakeCapture(intakeValue);
  const intakeJson = validateJsonIntake(intake);

  let workspaceEffect: EffectRecord | undefined;
  try {
    workspaceEffect = await schedule(
      input.coordinator,
      input.run,
      workspaceIntent(input.run),
      now,
    );
  } catch (error) {
    if (error instanceof StaleRevisionError)
      return { kind: "stale", run: input.run };
    throw error;
  }
  if (workspaceEffect === undefined) return { kind: "stale", run: input.run };

  let rawReceipt: unknown;
  try {
    rawReceipt = await input.workspacePrepare(input.run);
  } catch (error) {
    const reason = `Workspace preparation failed: ${errorMessage(error)}`;
    const settled = await input.coordinator.settleExecution({
      runId: input.run.id,
      expectedRevision: input.run.revision,
      effectKey: workspaceEffect.key,
      outcome: "failed",
      trigger: "startup_failed",
      evidence: reason,
      at: now(),
    });
    return { kind: "workspace_failed", run: settled.run, reason };
  }

  let workspace: WorkspacePreparationReceipt;
  try {
    const inspectedReceipt = await input.workspaceInspect(
      input.run,
      rawReceipt,
    );
    workspace = validateWorkspaceReceipt(inspectedReceipt);
  } catch (error) {
    const reason = `Workspace inspection failed: ${errorMessage(error)}`;
    const settled = await input.coordinator.settleExecution({
      runId: input.run.id,
      expectedRevision: input.run.revision,
      effectKey: workspaceEffect.key,
      outcome: "failed",
      trigger: "startup_failed",
      evidence: reason,
      at: now(),
    });
    return { kind: "workspace_failed", run: settled.run, reason };
  }

  const workspaceSettled = await input.coordinator.settleExecution({
    runId: input.run.id,
    expectedRevision: input.run.revision,
    effectKey: workspaceEffect.key,
    outcome: "confirmed",
    trigger: "workspace_prepared",
    evidence: `Workspace prepared for ${input.run.id}.`,
    receipt: workspace,
    facts: {
      worktreePath: workspace.path,
      baseSha: workspace.baseSha,
      branch: workspace.branch,
      headSha: workspace.headSha,
    },
    at: now(),
  });

  const intakeRun = workspaceSettled.run;
  const intakeEffect = await schedule(
    input.coordinator,
    intakeRun,
    intakeIntent(intakeRun, intake),
    now,
  );
  if (intakeEffect === undefined) return { kind: "stale", run: intakeRun };

  const intakeSettled = await input.coordinator.settleExecution({
    runId: intakeRun.id,
    expectedRevision: intakeRun.revision,
    effectKey: intakeEffect.key,
    outcome: "confirmed",
    trigger: "intake_captured",
    evidence: `Intake captured for ${intakeRun.id}.`,
    receipt: { intakeJson },
    facts: { intakeJson },
    at: now(),
  });
  return executeBuilderStage(
    input,
    intakeSettled.run,
    intake,
    intakeJson,
    workspace,
    now,
  );
}
