import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const REPAIR_PROMPT = readFileSync(
  new URL("../../../../prompts/repair.md", import.meta.url),
  "utf8",
).trim();

const ISSUE_TITLE_MAX_BYTES = 1_000;
const ISSUE_BODY_MAX_BYTES = 12_000;
const DIFF_MAX_BYTES = 32 * 1_024;
const REPOSITORY_FACTS_MAX_BYTES = 8 * 1_024;
const VERIFICATION_MAX_BYTES = 8 * 1_024;
const FINDING_KEY_MAX_BYTES = 256;
const FINDING_EVIDENCE_MAX_BYTES = 4 * 1_024;
const FINDINGS_MAX_ITEMS = 32;
const SUMMARY_MAX_LENGTH = 4_000;
const VALIDATION_ENTRY_MAX_LENGTH = 1_024;
const VALIDATION_MAX_ITEMS = 32;
const CHANGED_FILE_MAX_LENGTH = 512;
const CHANGED_FILES_MAX_ITEMS = 128;
const REQUESTED_ACTION_MAX_LENGTH = 1_024;
const REPAIR_OUTPUT_MAX_BYTES = 16_384;
const REPAIR_JSONL_LINE_MAX_BYTES = 64 * 1_024;
const UNTRUSTED_OPEN = "<untrusted-repair-context>";
const UNTRUSTED_CLOSE = "</untrusted-repair-context>";
const SAFE_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "USER",
  "LOGNAME",
  "PWD",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
] as const;

export interface RepairFindingInput {
  readonly stable_key: string;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly evidence: string;
}

export interface RepairPromptInput {
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly worktreePath: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly diff: string;
  readonly repositoryFacts: string;
  readonly verification: string;
  readonly findings: readonly RepairFindingInput[];
}

export interface RenderedRepairPrompt {
  readonly prompt: string;
  readonly promptHash: string;
}

const BoundedSummary = Type.String({
  minLength: 1,
  maxLength: SUMMARY_MAX_LENGTH,
});
const BoundedValidationEntry = Type.String({
  minLength: 1,
  maxLength: VALIDATION_ENTRY_MAX_LENGTH,
});
const BoundedChangedFile = Type.String({
  minLength: 1,
  maxLength: CHANGED_FILE_MAX_LENGTH,
  pattern: "\\S",
});
const BoundedRequestedAction = Type.String({
  minLength: 1,
  maxLength: REQUESTED_ACTION_MAX_LENGTH,
});

const RepairCommon = {
  summary: BoundedSummary,
  validation: Type.Array(BoundedValidationEntry, {
    maxItems: VALIDATION_MAX_ITEMS,
  }),
  changed_files: Type.Array(BoundedChangedFile, {
    maxItems: CHANGED_FILES_MAX_ITEMS,
    uniqueItems: true,
  }),
};

export const RepairTerminalResultSchema = Type.Union([
  Type.Object(
    { outcome: Type.Literal("completed"), ...RepairCommon },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: Type.Literal("blocked"),
      ...RepairCommon,
      requested_action: BoundedRequestedAction,
    },
    { additionalProperties: false },
  ),
]);

export type RepairTerminalResult = Static<typeof RepairTerminalResultSchema>;

function boundUtf8(value: string, maximumBytes: number): string {
  const sanitized = value
    .replaceAll(UNTRUSTED_OPEN, "[opening delimiter removed]")
    .replaceAll(UNTRUSTED_CLOSE, "[closing delimiter removed]");
  const characters: string[] = [];
  let byteLength = 0;
  for (const character of sanitized) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteLength + characterBytes > maximumBytes) break;
    characters.push(character);
    byteLength += characterBytes;
  }
  return characters.join("");
}

function contextSection(
  label: string,
  value: string,
  maximumBytes: number,
): string {
  return `${label}:\n${boundUtf8(value, maximumBytes)}`;
}

function renderFindings(findings: readonly RepairFindingInput[]): string {
  const boundedFindings = findings
    .slice(0, FINDINGS_MAX_ITEMS)
    .map((finding, index) => {
      const stableKey = boundUtf8(finding.stable_key, FINDING_KEY_MAX_BYTES);
      const evidence = boundUtf8(finding.evidence, FINDING_EVIDENCE_MAX_BYTES);
      return [
        `Finding ${index + 1}`,
        `stable_key: ${stableKey}`,
        `severity: ${finding.severity}`,
        `evidence: ${evidence}`,
      ].join("\n");
    });
  return boundedFindings.join("\n\n");
}

export function renderRepairPrompt(
  input: RepairPromptInput,
): RenderedRepairPrompt {
  const dynamicContext = [
    contextSection("Issue title", input.issueTitle, ISSUE_TITLE_MAX_BYTES),
    contextSection("Issue body", input.issueBody, ISSUE_BODY_MAX_BYTES),
    contextSection("Current raw diff", input.diff, DIFF_MAX_BYTES),
    contextSection(
      "Relevant repository facts",
      input.repositoryFacts,
      REPOSITORY_FACTS_MAX_BYTES,
    ),
    contextSection(
      "Verification receipt",
      input.verification,
      VERIFICATION_MAX_BYTES,
    ),
    `Review findings:\n${renderFindings(input.findings)}`,
  ].join("\n\n");
  const prompt = `${REPAIR_PROMPT}

## Trusted assignment facts

- Issue number: ${input.issueNumber}
- Worktree: ${input.worktreePath}
- Base SHA: ${input.baseSha}
- Head SHA: ${input.headSha}

${UNTRUSTED_OPEN}
${dynamicContext}
${UNTRUSTED_CLOSE}
`;
  return {
    prompt,
    promptHash: createHash("sha256").update(prompt, "utf8").digest("hex"),
  };
}

function redactOutput(output: string): string {
  return output
    .replace(/\b(?:gh[opusr]|github_pat)_[A-Za-z0-9_-]+/giu, "[REDACTED]")
    .replace(
      /\b(authorization)([^\S\r\n]*[:=][^\S\r\n]*)[^\r\n]*/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /\b((?:[a-z0-9]+_)+(?:token|api_key))(\s*[:=]\s*)\S+/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /\b(authorization|access[_ -]?token|api[_ -]?key|token)(\s*[:=]\s*)\S+/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /\b((?:[a-z0-9]+_)*(?:access[_ -]?key(?:[_ -]?id)?|secret[_ -]?access[_ -]?key|client[_ -]?secret|password|credential(?:s)?))(\s*[:=]\s*)\S+/gi,
      "$1$2[REDACTED]",
    );
}

export function parseRepairTerminalResult(
  value: unknown,
): RepairTerminalResult {
  let candidate: unknown = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      throw new Error("Invalid repair terminal result");
    }
  }
  if (!Value.Check(RepairTerminalResultSchema, candidate)) {
    throw new Error("Invalid repair terminal result");
  }
  const result = candidate as RepairTerminalResult;
  const sanitized: RepairTerminalResult =
    result.outcome === "blocked"
      ? {
          outcome: result.outcome,
          summary: redactOutput(result.summary),
          validation: result.validation.map(redactOutput),
          changed_files: result.changed_files.map(redactOutput),
          requested_action: redactOutput(result.requested_action),
        }
      : {
          outcome: result.outcome,
          summary: redactOutput(result.summary),
          validation: result.validation.map(redactOutput),
          changed_files: result.changed_files.map(redactOutput),
        };
  if (!Value.Check(RepairTerminalResultSchema, sanitized)) {
    throw new Error("Invalid repair terminal result");
  }
  return sanitized;
}

export interface RepairInvocation {
  readonly command: readonly string[];
  readonly model: string;
  readonly reasoningEffort: string;
  readonly timeoutMs: number;
  readonly worktreePath: string;
  readonly workspaceRoot: string;
  readonly prompt: string;
}

export type RepairRunFailureReason =
  | "nonzero_exit"
  | "missing_terminal"
  | "malformed_terminal"
  | "duplicate_terminal"
  | "spawn_error"
  | "timeout";

export interface RepairRunSuccess {
  readonly kind: "succeeded";
  readonly terminal: RepairTerminalResult;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RepairRunFailure {
  readonly kind: "failed";
  readonly reason: RepairRunFailureReason;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
}

export type RepairRunResult = RepairRunSuccess | RepairRunFailure;

interface CapturedOutput {
  buffer: Buffer;
}

function utf8Prefix(buffer: Buffer, maximumBytes: number): Buffer {
  let end = Math.min(buffer.length, maximumBytes);
  if (end === 0) return buffer.subarray(0, 0);
  let sequenceStart = end - 1;
  while (
    sequenceStart > 0 &&
    (buffer[sequenceStart] ?? 0) >= 0x80 &&
    (buffer[sequenceStart] ?? 0) < 0xc0
  ) {
    sequenceStart -= 1;
  }
  const lead = buffer[sequenceStart] ?? 0;
  const expectedLength =
    lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 1;
  if (expectedLength > end - sequenceStart) end = sequenceStart;
  return buffer.subarray(0, end);
}

function formatCapturedOutput(output: CapturedOutput): string {
  const decoded = utf8Prefix(output.buffer, output.buffer.length).toString(
    "utf8",
  );
  const redacted = redactOutput(decoded);
  return utf8Prefix(
    Buffer.from(redacted, "utf8"),
    REPAIR_OUTPUT_MAX_BYTES,
  ).toString("utf8");
}

function repairEnvironment(worktreePath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { HOME: worktreePath };
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export class RepairBoundaryError extends Error {
  override name = "RepairBoundaryError";
}

function assertContained(root: string, candidate: string): void {
  const descendant = relative(root, candidate);
  if (
    descendant === "" ||
    descendant === ".." ||
    descendant.startsWith("..\\") ||
    descendant.startsWith("../") ||
    isAbsolute(descendant)
  ) {
    throw new RepairBoundaryError(
      "repair worktree must be a contained descendant of workspace root",
    );
  }
}

async function canonicalDirectory(
  path: string,
  label: string,
): Promise<string> {
  try {
    const requestedPath = resolve(path);
    const metadata = await lstat(requestedPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new RepairBoundaryError(
        `${label} must be a real directory without symbolic links`,
      );
    }
    const canonicalPath = await realpath(requestedPath);
    if (canonicalPath !== requestedPath) {
      throw new RepairBoundaryError(
        `${label} must not resolve through a symbolic link`,
      );
    }
    return canonicalPath;
  } catch (cause) {
    if (cause instanceof RepairBoundaryError) throw cause;
    throw new RepairBoundaryError(`${label} is not a usable directory`);
  }
}

async function validateWorktree(input: RepairInvocation): Promise<string> {
  const workspaceRoot = await canonicalDirectory(
    input.workspaceRoot,
    "workspace root",
  );
  const worktreePath = await canonicalDirectory(
    input.worktreePath,
    "repair worktree",
  );
  assertContained(workspaceRoot, worktreePath);
  return worktreePath;
}

function terminateRepairProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best-effort cleanup must not replace the timeout result.
    }
  }
}

interface TerminalScanState {
  terminalCount: number;
  terminal: RepairTerminalResult | undefined;
  malformed: boolean;
}

function isTerminalPrefix(line: string): boolean {
  return /^\s*\{\s*["']type["']\s*:\s*["']terminal["']/u.test(line);
}

function inspectTerminalLine(line: string, state: TerminalScanState): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let event: unknown;
  try {
    event = JSON.parse(trimmed) as unknown;
  } catch {
    if (isTerminalPrefix(trimmed)) state.malformed = true;
    return;
  }
  if (typeof event !== "object" || event === null || Array.isArray(event))
    return;
  const record = event as Record<string, unknown>;
  if (!("type" in record)) {
    try {
      state.terminal = parseRepairTerminalResult(event);
      state.terminalCount += 1;
    } catch {
      state.malformed = true;
    }
    return;
  }
  if (record.type !== "terminal") return;
  state.terminalCount += 1;
  try {
    if (!("result" in record)) throw new Error("Missing terminal result");
    state.terminal = parseRepairTerminalResult(record.result);
  } catch {
    state.malformed = true;
  }
}

function failedRepairResult(
  reason: RepairRunFailureReason,
  stdout: CapturedOutput,
  stderr: CapturedOutput,
  exitCode: number | null = null,
  signal: NodeJS.Signals | null = null,
  error?: string,
): RepairRunFailure {
  return {
    kind: "failed",
    reason,
    stdout: formatCapturedOutput(stdout),
    stderr: formatCapturedOutput(stderr),
    exitCode,
    signal,
    ...(error === undefined ? {} : { error: redactOutput(error) }),
  };
}

export async function runRepair(
  input: RepairInvocation,
): Promise<RepairRunResult> {
  const stdout: CapturedOutput = { buffer: Buffer.alloc(0) };
  const stderr: CapturedOutput = { buffer: Buffer.alloc(0) };
  if (input.command.length === 0) {
    return failedRepairResult(
      "spawn_error",
      stdout,
      stderr,
      null,
      null,
      "empty command",
    );
  }
  const cwd = await validateWorktree(input);
  return new Promise((resolveResult) => {
    const [executable, ...args] = input.command;
    const child = spawn(
      executable as string,
      [
        ...args,
        "--model",
        input.model,
        "--reasoning-effort",
        input.reasoningEffort,
      ],
      {
        cwd,
        detached: process.platform !== "win32",
        env: repairEnvironment(cwd),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let pendingLine = "";
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    const state: TerminalScanState = {
      terminalCount: 0,
      terminal: undefined,
      malformed: false,
    };
    const capture = (target: CapturedOutput, chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const available = REPAIR_OUTPUT_MAX_BYTES - target.buffer.length;
      if (available > 0) {
        target.buffer = Buffer.concat(
          [target.buffer, bytes.subarray(0, available)],
          target.buffer.length + Math.min(bytes.length, available),
        );
      }
    };
    const consumeStdout = (chunk: Buffer | string): void => {
      capture(stdout, chunk);
      pendingLine += Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : Buffer.from(chunk, "utf8").toString("utf8");
      let newlineIndex = pendingLine.indexOf("\n");
      while (newlineIndex !== -1) {
        inspectTerminalLine(pendingLine.slice(0, newlineIndex), state);
        pendingLine = pendingLine.slice(newlineIndex + 1);
        newlineIndex = pendingLine.indexOf("\n");
      }
      if (
        Buffer.byteLength(pendingLine, "utf8") > REPAIR_JSONL_LINE_MAX_BYTES
      ) {
        state.malformed ||= isTerminalPrefix(pendingLine);
        pendingLine = "";
      }
    };
    const finish = (result: RepairRunResult, destroyStreams = false): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (destroyStreams) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      resolveResult(result);
    };
    child.stdout.on("data", consumeStdout);
    child.stderr.on("data", (chunk: Buffer | string) => capture(stderr, chunk));
    child.stdin.once("error", () => {
      // The child can exit before consuming the prompt; this is not a spawn failure.
    });
    child.once("error", (error) => {
      finish(
        failedRepairResult(
          "spawn_error",
          stdout,
          stderr,
          null,
          null,
          error.message,
        ),
        true,
      );
    });
    child.once("close", (exitCode, signal) => {
      setImmediate(() => {
        if (settled) return;
        if (pendingLine.length > 0) inspectTerminalLine(pendingLine, state);
        if (timedOut) {
          finish(
            failedRepairResult("timeout", stdout, stderr, exitCode, signal),
          );
        } else if (exitCode !== 0 || signal !== null) {
          finish(
            failedRepairResult(
              "nonzero_exit",
              stdout,
              stderr,
              exitCode,
              signal,
            ),
          );
        } else if (state.terminalCount === 0) {
          finish(
            failedRepairResult(
              state.malformed ? "malformed_terminal" : "missing_terminal",
              stdout,
              stderr,
              exitCode,
              signal,
            ),
          );
        } else if (state.terminalCount !== 1) {
          finish(
            failedRepairResult(
              "duplicate_terminal",
              stdout,
              stderr,
              exitCode,
              signal,
            ),
          );
        } else if (state.malformed || state.terminal === undefined) {
          finish(
            failedRepairResult(
              "malformed_terminal",
              stdout,
              stderr,
              exitCode,
              signal,
            ),
          );
        } else {
          finish({
            kind: "succeeded",
            terminal: state.terminal,
            stdout: formatCapturedOutput(stdout),
            stderr: formatCapturedOutput(stderr),
          });
        }
      });
    });
    child.stdin.end(input.prompt);
    timeout = setTimeout(
      () => {
        timedOut = true;
        terminateRepairProcessTree(child);
        finish(failedRepairResult("timeout", stdout, stderr), true);
      },
      Math.max(0, input.timeoutMs),
    );
  });
}
