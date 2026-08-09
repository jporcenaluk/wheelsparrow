import type { EffectRecord } from "../database/effects.js";
import { type RunRecord, StaleRevisionError } from "../database/runs.js";
import type {
  EffectIntentCommand,
  WorkflowCoordinator,
} from "./coordinator.js";

const workspaceEffectKey = (runId: string): string =>
  `run:${runId}:workspace:prepare`;
const intakeEffectKey = (runId: string): string =>
  `run:${runId}:intake:capture`;
const shaPattern = /^[0-9a-f]{40}$/u;
const maximumTextBytes = 64 * 1024;
const maximumIdentifierBytes = 512;
const maximumAcceptanceCriterionBytes = 16 * 1024;
const maximumIntakeJsonBytes = 1024 * 1024;

/** The receipt required before a run may leave the preparing state. */
export interface WorkspacePreparationReceipt {
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: "main";
  readonly baseSha: string;
  readonly headSha: string;
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

export interface ExecutionCoordinator
  extends Pick<
    WorkflowCoordinator,
    "createEffectIntent" | "beginEffect" | "settleExecution"
  > {}

interface ExecuteClaimedRunInputBase {
  readonly coordinator: ExecutionCoordinator;
  /** The durable snapshot observed by the caller in `preparing`. */
  readonly run: RunRecord;
  readonly workspacePrepare: WorkspacePreparation;
  readonly workspaceInspect: WorkspaceInspection;
  readonly now?: () => string;
}

export type ExecuteClaimedRunInput = ExecuteClaimedRunInputBase &
  (
    | { readonly intake: IntakeCapture; readonly intakeCapture?: never }
    | { readonly intakeCapture: IntakeCapture; readonly intake?: never }
  );

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
      readonly kind: "stale";
      readonly run: RunRecord;
    };

export class WorkspaceReceiptError extends Error {
  override name = "WorkspaceReceiptError";
}

export class IntakeCaptureError extends Error {
  override name = "IntakeCaptureError";
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

function validateIntakeCapture(value: unknown): IntakeCapture {
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
    keys.join(",") !== "baseBranch,baseSha,branch,headSha,path" ||
    !isNonEmptyText(value.path) ||
    !isNonEmptyText(value.branch) ||
    value.baseBranch !== "main" ||
    typeof value.baseSha !== "string" ||
    !shaPattern.test(value.baseSha) ||
    typeof value.headSha !== "string" ||
    !shaPattern.test(value.headSha)
  ) {
    throw new WorkspaceReceiptError(
      "Workspace receipt must contain path, branch, baseBranch=main, baseSha, and headSha.",
    );
  }
  return {
    path: value.path,
    branch: value.branch,
    baseBranch: "main",
    baseSha: value.baseSha,
    headSha: value.headSha,
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

export async function executeClaimedRun(
  input: ExecuteClaimedRunInput,
): Promise<ExecutionOutcome> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.run.state !== "preparing") return { kind: "stale", run: input.run };
  const intake = validateIntakeCapture(input.intake ?? input.intakeCapture);
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
  return {
    kind: "building",
    run: intakeSettled.run,
    workspace,
    intakeJson,
  };
}
