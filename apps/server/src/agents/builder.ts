import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const BUILDER_PROMPT = readFileSync(
  new URL("../../../../prompts/builder.md", import.meta.url),
  "utf8",
).trim();

const ISSUE_TITLE_MAX_BYTES = 1_000;
const ISSUE_BODY_MAX_BYTES = 12_000;
const SUMMARY_MAX_LENGTH = 4_000;
const VALIDATION_ENTRY_MAX_LENGTH = 1_024;
const VALIDATION_MAX_ITEMS = 32;
const REQUESTED_ACTION_MAX_LENGTH = 1_024;
const BUILDER_OUTPUT_MAX_BYTES = 16_384;
const BUILDER_JSONL_LINE_MAX_BYTES = 64 * 1_024;
const BUILDER_SAFE_ENV_KEYS = [
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
const UNTRUSTED_OPEN = "<untrusted-issue-context>";
const UNTRUSTED_CLOSE = "</untrusted-issue-context>";

export interface BuilderPromptInput {
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly worktreePath: string;
  readonly baseSha: string;
}

export interface RenderedBuilderPrompt {
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

export const BuilderTerminalResultSchema = Type.Object(
  {
    outcome: Type.Union([Type.Literal("completed"), Type.Literal("blocked")]),
    summary: BoundedSummary,
    validation: Type.Array(BoundedValidationEntry, {
      maxItems: VALIDATION_MAX_ITEMS,
    }),
    requested_action: Type.Optional(
      Type.String({ minLength: 1, maxLength: REQUESTED_ACTION_MAX_LENGTH }),
    ),
  },
  { additionalProperties: false },
);

export type BuilderTerminalResult = Static<typeof BuilderTerminalResultSchema>;

function boundIssueText(value: string, maxBytes: number): string {
  const sanitized = value
    .replaceAll(UNTRUSTED_OPEN, "[opening delimiter removed]")
    .replaceAll(UNTRUSTED_CLOSE, "[closing delimiter removed]");
  const characters: string[] = [];
  let byteLength = 0;

  for (const character of sanitized) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteLength + characterBytes > maxBytes) break;
    characters.push(character);
    byteLength += characterBytes;
  }

  return characters.join("");
}

export function renderBuilderPrompt(
  input: BuilderPromptInput,
): RenderedBuilderPrompt {
  const issueTitle = boundIssueText(input.issueTitle, ISSUE_TITLE_MAX_BYTES);
  const issueBody = boundIssueText(input.issueBody, ISSUE_BODY_MAX_BYTES);
  const prompt = `${BUILDER_PROMPT}

## Trusted assignment facts

- Issue number: ${input.issueNumber}
- Worktree: ${input.worktreePath}
- Base SHA: ${input.baseSha}

${UNTRUSTED_OPEN}
Issue title:
${issueTitle}

Issue body:
${issueBody}
${UNTRUSTED_CLOSE}
`;

  return {
    prompt,
    promptHash: createHash("sha256").update(prompt, "utf8").digest("hex"),
  };
}

export function parseBuilderTerminalResult(
  value: unknown,
): BuilderTerminalResult {
  let candidate: unknown = value;

  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      throw new Error("Invalid builder terminal result");
    }
  }

  if (!Value.Check(BuilderTerminalResultSchema, candidate)) {
    throw new Error("Invalid builder terminal result");
  }

  return candidate as BuilderTerminalResult;
}

export interface BuilderInvocation {
  readonly command: readonly string[];
  readonly model: string;
  readonly reasoningEffort: string;
  readonly timeoutMs: number;
  readonly worktreePath: string;
  readonly prompt: string;
}

export type BuilderRunFailureReason =
  | "nonzero_exit"
  | "missing_terminal"
  | "malformed_terminal"
  | "duplicate_terminal"
  | "spawn_error"
  | "timeout";

export interface BuilderRunSuccess {
  readonly kind: "succeeded";
  readonly terminal: BuilderTerminalResult;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BuilderRunFailure {
  readonly kind: "failed";
  readonly reason: BuilderRunFailureReason;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
}

export type BuilderRunResult = BuilderRunSuccess | BuilderRunFailure;

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
    );
}

function formatCapturedOutput(output: CapturedOutput): string {
  const decoded = utf8Prefix(output.buffer, output.buffer.length).toString(
    "utf8",
  );
  const redacted = redactOutput(decoded);
  return utf8Prefix(
    Buffer.from(redacted, "utf8"),
    BUILDER_OUTPUT_MAX_BYTES,
  ).toString("utf8");
}

function terminateBuilderProcessTree(child: ChildProcess): void {
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

function failedBuilderResult(
  reason: BuilderRunFailureReason,
  stdout: CapturedOutput,
  stderr: CapturedOutput,
  exitCode: number | null = null,
  signal: NodeJS.Signals | null = null,
  error?: string,
): BuilderRunFailure {
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

function isTerminalPrefix(line: string): boolean {
  return /^\s*\{\s*["']type["']\s*:\s*["']terminal["']/u.test(line);
}

function builderEnvironment(worktreePath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: worktreePath,
  };
  for (const key of BUILDER_SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
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

  if (typeof event !== "object" || event === null) {
    return;
  }

  const eventRecord = event as Record<string, unknown>;
  if (!("type" in eventRecord)) {
    try {
      state.terminal = parseBuilderTerminalResult(event);
      state.terminalCount += 1;
    } catch {
      // Other untyped JSONL output is progress or diagnostic output.
    }
    return;
  }
  if (eventRecord.type !== "terminal") return;

  state.terminalCount += 1;
  try {
    const candidate =
      "result" in eventRecord
        ? eventRecord.result
        : Object.fromEntries(
            Object.entries(eventRecord).filter(([key]) => key !== "type"),
          );
    state.terminal = parseBuilderTerminalResult(candidate);
  } catch {
    state.malformed = true;
  }
}

interface TerminalScanState {
  terminalCount: number;
  terminal: BuilderTerminalResult | undefined;
  malformed: boolean;
}

export function runBuilder(
  input: BuilderInvocation,
): Promise<BuilderRunResult> {
  const stdout: CapturedOutput = { buffer: Buffer.alloc(0) };
  const stderr: CapturedOutput = { buffer: Buffer.alloc(0) };
  if (input.command.length === 0) {
    return Promise.resolve(
      failedBuilderResult(
        "spawn_error",
        stdout,
        stderr,
        null,
        null,
        "empty command",
      ),
    );
  }

  return new Promise((resolve) => {
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
        cwd: input.worktreePath,
        detached: process.platform !== "win32",
        env: builderEnvironment(input.worktreePath),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let pendingLine = "";
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    const terminalState = {
      terminalCount: 0,
      terminal: undefined as BuilderTerminalResult | undefined,
      malformed: false,
    };

    const capture = (target: CapturedOutput, chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const available = BUILDER_OUTPUT_MAX_BYTES - target.buffer.length;
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
        inspectTerminalLine(pendingLine.slice(0, newlineIndex), terminalState);
        pendingLine = pendingLine.slice(newlineIndex + 1);
        newlineIndex = pendingLine.indexOf("\n");
      }
      if (
        Buffer.byteLength(pendingLine, "utf8") > BUILDER_JSONL_LINE_MAX_BYTES
      ) {
        terminalState.malformed ||= isTerminalPrefix(pendingLine);
        pendingLine = "";
      }
    };

    const finish = (result: BuilderRunResult, destroyStreams = false): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (destroyStreams) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      resolve(result);
    };

    child.stdout.on("data", consumeStdout);
    child.stderr.on("data", (chunk: Buffer | string) => capture(stderr, chunk));
    child.stdin.once("error", () => {
      // The builder may exit before consuming the prompt; this is not a spawn failure.
    });
    child.once("error", (error) => {
      finish(
        failedBuilderResult(
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
        if (pendingLine.length > 0)
          inspectTerminalLine(pendingLine, terminalState);
        if (timedOut) {
          finish(
            failedBuilderResult("timeout", stdout, stderr, exitCode, signal),
          );
        } else if (exitCode !== 0 || signal !== null) {
          finish(
            failedBuilderResult(
              "nonzero_exit",
              stdout,
              stderr,
              exitCode,
              signal,
            ),
          );
        } else if (terminalState.terminalCount === 0) {
          finish(
            failedBuilderResult(
              terminalState.malformed
                ? "malformed_terminal"
                : "missing_terminal",
              stdout,
              stderr,
              exitCode,
              signal,
            ),
          );
        } else if (terminalState.terminalCount !== 1) {
          finish(
            failedBuilderResult(
              "duplicate_terminal",
              stdout,
              stderr,
              exitCode,
              signal,
            ),
          );
        } else if (
          terminalState.malformed ||
          terminalState.terminal === undefined
        ) {
          finish(
            failedBuilderResult(
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
            terminal: terminalState.terminal,
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
        terminateBuilderProcessTree(child);
        finish(failedBuilderResult("timeout", stdout, stderr), true);
      },
      Math.max(0, input.timeoutMs),
    );
  });
}
