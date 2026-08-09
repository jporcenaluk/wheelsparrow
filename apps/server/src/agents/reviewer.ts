import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const REVIEWER_PROMPT = readFileSync(
  new URL("../../../../prompts/reviewer.md", import.meta.url),
  "utf8",
).trim();

const ISSUE_TITLE_MAX_BYTES = 1_000;
const ISSUE_BODY_MAX_BYTES = 12_000;
const DIFF_MAX_BYTES = 32 * 1_024;
const REPOSITORY_FACTS_MAX_BYTES = 8 * 1_024;
const VERIFICATION_MAX_BYTES = 8 * 1_024;
const FINDING_KEY_MAX_LENGTH = 256;
const FINDING_EVIDENCE_MAX_LENGTH = 4 * 1_024;
const SUMMARY_MAX_LENGTH = 4_000;
const VALIDATION_ENTRY_MAX_LENGTH = 1_024;
const VALIDATION_MAX_ITEMS = 32;
const REQUESTED_ACTION_MAX_LENGTH = 1_024;
const REVIEWER_OUTPUT_MAX_BYTES = 16_384;
const REVIEWER_JSONL_LINE_MAX_BYTES = 64 * 1_024;
const UNTRUSTED_OPEN = "<untrusted-review-context>";
const UNTRUSTED_CLOSE = "</untrusted-review-context>";
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

export interface ReviewerPromptInput {
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly worktreePath: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly diff: string;
  readonly repositoryFacts: string;
  readonly verification: string;
}

export interface RenderedReviewerPrompt {
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
const BoundedRequestedAction = Type.String({
  minLength: 1,
  maxLength: REQUESTED_ACTION_MAX_LENGTH,
});

export const ReviewerFindingSchema = Type.Object(
  {
    stable_key: Type.String({
      minLength: 1,
      maxLength: FINDING_KEY_MAX_LENGTH,
      pattern: "\\S",
    }),
    severity: Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("critical"),
    ]),
    evidence: Type.String({
      minLength: 1,
      maxLength: FINDING_EVIDENCE_MAX_LENGTH,
    }),
  },
  { additionalProperties: false },
);

const ReviewerCommon = {
  summary: BoundedSummary,
  validation: Type.Array(BoundedValidationEntry, {
    maxItems: VALIDATION_MAX_ITEMS,
  }),
};

export const ReviewerTerminalResultSchema = Type.Union([
  Type.Object(
    { outcome: Type.Literal("approved"), ...ReviewerCommon },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: Type.Literal("needs_repair"),
      ...ReviewerCommon,
      findings: Type.Array(ReviewerFindingSchema, {
        minItems: 1,
        maxItems: 32,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: Type.Literal("needs_human"),
      ...ReviewerCommon,
      requested_action: BoundedRequestedAction,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: Type.Literal("blocked"),
      ...ReviewerCommon,
      requested_action: BoundedRequestedAction,
    },
    { additionalProperties: false },
  ),
]);

export type ReviewerFinding = Static<typeof ReviewerFindingSchema>;
export type ReviewerTerminalResult = Static<
  typeof ReviewerTerminalResultSchema
>;

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

export function renderReviewerPrompt(
  input: ReviewerPromptInput,
): RenderedReviewerPrompt {
  const dynamicContext = [
    contextSection("Issue title", input.issueTitle, ISSUE_TITLE_MAX_BYTES),
    contextSection("Issue body", input.issueBody, ISSUE_BODY_MAX_BYTES),
    contextSection("Raw diff", input.diff, DIFF_MAX_BYTES),
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
  ].join("\n\n");
  const prompt = `${REVIEWER_PROMPT}

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

export function parseReviewerTerminalResult(
  value: unknown,
): ReviewerTerminalResult {
  let candidate: unknown = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      throw new Error("Invalid reviewer terminal result");
    }
  }
  if (!Value.Check(ReviewerTerminalResultSchema, candidate)) {
    throw new Error("Invalid reviewer terminal result");
  }
  const result = candidate as ReviewerTerminalResult;
  const sanitized: ReviewerTerminalResult = (() => {
    switch (result.outcome) {
      case "needs_repair":
        return {
          outcome: result.outcome,
          summary: redactOutput(result.summary),
          validation: result.validation.map(redactOutput),
          findings: result.findings.map((finding) => ({
            stable_key: redactOutput(finding.stable_key),
            severity: finding.severity,
            evidence: redactOutput(finding.evidence),
          })),
        };
      case "needs_human":
      case "blocked":
        return {
          outcome: result.outcome,
          summary: redactOutput(result.summary),
          validation: result.validation.map(redactOutput),
          requested_action: redactOutput(result.requested_action),
        };
      case "approved":
        return {
          outcome: result.outcome,
          summary: redactOutput(result.summary),
          validation: result.validation.map(redactOutput),
        };
    }
  })();
  if (!Value.Check(ReviewerTerminalResultSchema, sanitized)) {
    throw new Error("Invalid reviewer terminal result");
  }
  return sanitized;
}

export interface ReviewerInvocation {
  readonly command: readonly string[];
  readonly model: string;
  readonly reasoningEffort: string;
  readonly timeoutMs: number;
  readonly worktreePath: string;
  readonly workspaceRoot: string;
  readonly prompt: string;
}

export type ReviewerRunFailureReason =
  | "nonzero_exit"
  | "missing_terminal"
  | "malformed_terminal"
  | "duplicate_terminal"
  | "spawn_error"
  | "timeout";

export interface ReviewerRunSuccess {
  readonly kind: "succeeded";
  readonly terminal: ReviewerTerminalResult;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ReviewerRunFailure {
  readonly kind: "failed";
  readonly reason: ReviewerRunFailureReason;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
}

export type ReviewerRunResult = ReviewerRunSuccess | ReviewerRunFailure;

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
    REVIEWER_OUTPUT_MAX_BYTES,
  ).toString("utf8");
}

function reviewerEnvironment(worktreePath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { HOME: worktreePath };
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export class ReviewerBoundaryError extends Error {
  override name = "ReviewerBoundaryError";
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
    throw new ReviewerBoundaryError(
      "reviewer worktree must be a contained descendant of workspace root",
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
      throw new ReviewerBoundaryError(
        `${label} must be a real directory without symbolic links`,
      );
    }
    const canonicalPath = await realpath(requestedPath);
    if (canonicalPath !== requestedPath) {
      throw new ReviewerBoundaryError(
        `${label} must not resolve through a symbolic link`,
      );
    }
    return canonicalPath;
  } catch (cause) {
    if (cause instanceof ReviewerBoundaryError) throw cause;
    throw new ReviewerBoundaryError(`${label} is not a usable directory`);
  }
}

async function validateWorktree(input: ReviewerInvocation): Promise<string> {
  const workspaceRoot = await canonicalDirectory(
    input.workspaceRoot,
    "workspace root",
  );
  const worktreePath = await canonicalDirectory(
    input.worktreePath,
    "reviewer worktree",
  );
  assertContained(workspaceRoot, worktreePath);
  return worktreePath;
}

function terminateReviewerProcessTree(child: ChildProcess): void {
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
  terminal: ReviewerTerminalResult | undefined;
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
      state.terminal = parseReviewerTerminalResult(event);
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
    state.terminal = parseReviewerTerminalResult(record.result);
  } catch {
    state.malformed = true;
  }
}

function failedReviewerResult(
  reason: ReviewerRunFailureReason,
  stdout: CapturedOutput,
  stderr: CapturedOutput,
  exitCode: number | null = null,
  signal: NodeJS.Signals | null = null,
  error?: string,
): ReviewerRunFailure {
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

export async function runReviewer(
  input: ReviewerInvocation,
): Promise<ReviewerRunResult> {
  const stdout: CapturedOutput = { buffer: Buffer.alloc(0) };
  const stderr: CapturedOutput = { buffer: Buffer.alloc(0) };
  if (input.command.length === 0) {
    return failedReviewerResult(
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
        env: reviewerEnvironment(cwd),
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
      const available = REVIEWER_OUTPUT_MAX_BYTES - target.buffer.length;
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
        Buffer.byteLength(pendingLine, "utf8") > REVIEWER_JSONL_LINE_MAX_BYTES
      ) {
        state.malformed ||= isTerminalPrefix(pendingLine);
        pendingLine = "";
      }
    };
    const finish = (
      result: ReviewerRunResult,
      destroyStreams = false,
    ): void => {
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
        failedReviewerResult(
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
            failedReviewerResult("timeout", stdout, stderr, exitCode, signal),
          );
        } else if (exitCode !== 0 || signal !== null) {
          finish(
            failedReviewerResult(
              "nonzero_exit",
              stdout,
              stderr,
              exitCode,
              signal,
            ),
          );
        } else if (state.terminalCount === 0) {
          finish(
            failedReviewerResult(
              state.malformed ? "malformed_terminal" : "missing_terminal",
              stdout,
              stderr,
              exitCode,
              signal,
            ),
          );
        } else if (state.terminalCount !== 1) {
          finish(
            failedReviewerResult(
              "duplicate_terminal",
              stdout,
              stderr,
              exitCode,
              signal,
            ),
          );
        } else if (state.malformed || state.terminal === undefined) {
          finish(
            failedReviewerResult(
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
        terminateReviewerProcessTree(child);
        finish(failedReviewerResult("timeout", stdout, stderr), true);
      },
      Math.max(0, input.timeoutMs),
    );
  });
}
