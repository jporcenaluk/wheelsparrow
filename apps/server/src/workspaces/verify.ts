import { type ChildProcess, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_OUTPUT_BYTES = 16_384;
const SHELL_SYNTAX = /[;|&<>$`'"\\()[\]{}*?!]/u;
const VERIFICATION_SAFE_ENV_KEYS = [
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

function containsCommandControl(value: string): boolean {
  return (
    value.includes(String.fromCharCode(0)) ||
    value.includes(String.fromCharCode(13)) ||
    value.includes(String.fromCharCode(10))
  );
}

/** An executable and its arguments. Arguments are never interpreted by a shell. */
export type VerificationCommand = string | readonly string[];

export interface VerificationInvocation {
  readonly command: VerificationCommand;
  readonly args?: readonly string[];
  readonly worktreePath: string;
  readonly workspaceRoot: string;
  readonly timeoutMs: number;
  /** Shell execution is intentionally unsupported for this narrow runner. */
  readonly shell?: boolean;
}

export type VerificationFailureReason =
  | "nonzero_exit"
  | "spawn_error"
  | "timeout";

interface VerificationReceiptBase {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VerificationRunSuccess extends VerificationReceiptBase {
  readonly kind: "succeeded";
}

export interface VerificationRunFailure extends VerificationReceiptBase {
  readonly kind: "failed";
  readonly reason: VerificationFailureReason;
  readonly error?: string;
}

export type VerificationRunResult =
  | VerificationRunSuccess
  | VerificationRunFailure;

export class VerificationBoundaryError extends Error {
  override name = "VerificationBoundaryError";
}

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
  return utf8Prefix(Buffer.from(redacted, "utf8"), MAX_OUTPUT_BYTES).toString(
    "utf8",
  );
}

function assertSafeExecutable(executable: string): void {
  if (
    executable.length === 0 ||
    executable.trim() !== executable ||
    SHELL_SYNTAX.test(executable)
  ) {
    throw new VerificationBoundaryError(
      "verification command must be an executable without shell syntax",
    );
  }
}

function normalizeCommand(input: VerificationInvocation): readonly string[] {
  if (input.shell === true) {
    throw new VerificationBoundaryError(
      "shell execution is not supported by the verification runner",
    );
  }

  if (typeof input.command === "string") {
    if (input.args?.some((argument) => typeof argument !== "string")) {
      throw new VerificationBoundaryError(
        "verification arguments must be strings",
      );
    }
    const configuredCommand = input.command.trim();
    if (
      configuredCommand.length === 0 ||
      containsCommandControl(configuredCommand) ||
      SHELL_SYNTAX.test(configuredCommand)
    ) {
      throw new VerificationBoundaryError(
        "configured command strings must contain only an executable and simple arguments",
      );
    }
    const [executable, ...configuredArgs] = configuredCommand.split(/\s+/u);
    assertSafeExecutable(executable as string);
    return [executable as string, ...configuredArgs, ...(input.args ?? [])];
  }

  if (input.args !== undefined) {
    throw new VerificationBoundaryError(
      "provide verification arguments in the command array only",
    );
  }
  if (input.command.length === 0) {
    throw new VerificationBoundaryError("verification command cannot be empty");
  }
  const [executable, ...args] = input.command;
  if (typeof executable !== "string") {
    throw new VerificationBoundaryError(
      "verification executable must be a string",
    );
  }
  assertSafeExecutable(executable);
  if (args.some((argument) => typeof argument !== "string")) {
    throw new VerificationBoundaryError(
      "verification arguments must be strings",
    );
  }
  return [executable, ...args];
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
    throw new VerificationBoundaryError(
      "verification worktree must be a contained descendant of workspace root",
    );
  }
}

function verificationEnvironment(worktreePath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: worktreePath,
  };
  for (const key of VERIFICATION_SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function canonicalDirectory(
  path: string,
  label: string,
): Promise<string> {
  const requestedPath = resolve(path);
  try {
    const metadata = await lstat(requestedPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new VerificationBoundaryError(
        `${label} must be a real directory without symbolic links`,
      );
    }
    const canonicalPath = await realpath(requestedPath);
    if (canonicalPath !== requestedPath) {
      throw new VerificationBoundaryError(
        `${label} must not resolve through a symbolic link`,
      );
    }
    return canonicalPath;
  } catch (cause) {
    if (cause instanceof VerificationBoundaryError) throw cause;
    throw new VerificationBoundaryError(`${label} is not a usable directory`);
  }
}

async function validateWorktree(
  input: VerificationInvocation,
): Promise<string> {
  const workspaceRoot = await canonicalDirectory(
    input.workspaceRoot,
    "workspace root",
  );
  const worktreePath = await canonicalDirectory(
    input.worktreePath,
    "verification worktree",
  );
  assertContained(workspaceRoot, worktreePath);
  return worktreePath;
}

function terminateVerificationProcessTree(child: ChildProcess): void {
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

function failedResult(
  reason: VerificationFailureReason,
  command: readonly string[],
  cwd: string,
  stdout: CapturedOutput,
  stderr: CapturedOutput,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  error?: string,
): VerificationRunFailure {
  return {
    kind: "failed",
    reason,
    command,
    cwd,
    exitCode,
    signal,
    stdout: formatCapturedOutput(stdout),
    stderr: formatCapturedOutput(stderr),
    ...(error === undefined ? {} : { error: redactOutput(error) }),
  };
}

export async function runVerification(
  input: VerificationInvocation,
): Promise<VerificationRunResult> {
  const command = normalizeCommand(input);
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0) {
    throw new VerificationBoundaryError(
      "verification timeout must be a non-negative finite number",
    );
  }
  const cwd = await validateWorktree(input);
  const stdout: CapturedOutput = { buffer: Buffer.alloc(0) };
  const stderr: CapturedOutput = { buffer: Buffer.alloc(0) };

  return new Promise((resolveResult) => {
    const [executable, ...args] = command;
    const child = spawn(executable as string, args, {
      cwd,
      detached: process.platform !== "win32",
      env: verificationEnvironment(cwd),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;

    const capture = (target: CapturedOutput, chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const available = MAX_OUTPUT_BYTES - target.buffer.length;
      if (available <= 0) return;
      const portion = bytes.subarray(0, available);
      target.buffer = Buffer.concat(
        [target.buffer, portion],
        target.buffer.length + portion.length,
      );
    };

    const finish = (result: VerificationRunResult, destroyStreams = false) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (destroyStreams) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      resolveResult(result);
    };

    child.stdout.on("data", (chunk: Buffer | string) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer | string) => capture(stderr, chunk));
    child.once("error", (error) => {
      finish(
        failedResult(
          "spawn_error",
          command,
          cwd,
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
        if (timedOut) {
          finish(
            failedResult(
              "timeout",
              command,
              cwd,
              stdout,
              stderr,
              exitCode,
              signal,
            ),
          );
        } else if (exitCode !== 0 || signal !== null) {
          finish(
            failedResult(
              "nonzero_exit",
              command,
              cwd,
              stdout,
              stderr,
              exitCode,
              signal,
            ),
          );
        } else {
          finish({
            kind: "succeeded",
            command,
            cwd,
            exitCode,
            signal,
            stdout: formatCapturedOutput(stdout),
            stderr: formatCapturedOutput(stderr),
          });
        }
      });
    });

    timeout = setTimeout(
      () => {
        timedOut = true;
        terminateVerificationProcessTree(child);
        finish(
          failedResult("timeout", command, cwd, stdout, stderr, null, null),
          true,
        );
      },
      Math.max(0, input.timeoutMs),
    );
  });
}
