import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadConfiguration,
  resolveConfigurationPath,
  resolveWorkspaceRoot,
  WorkspaceRootError,
} from "../apps/server/src/config.js";

const DIAGNOSTIC_LIMIT = 8192;
const TRUNCATION_MARKER = "\n[diagnostic truncated]";
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 10_000;

export interface CommandResult {
  ok: boolean;
  detail: string;
}

export interface Check extends CommandResult {
  name:
    | "node"
    | "pnpm"
    | "git"
    | "github-auth"
    | "codex-auth"
    | "configuration"
    | "workspace-root";
}

export interface Options {
  root: string;
  run: (command: string, args: string[]) => Promise<CommandResult>;
}

export interface PreflightResult {
  ok: boolean;
  checks: Check[];
}

export interface RunCommandOptions {
  timeoutMs?: number;
}

async function prepareWorkspaceRoot(
  root: string,
  configuredPath: string,
): Promise<string> {
  const candidate = resolveWorkspaceRoot(root, configuredPath);
  const descendant = relative(resolve(root), candidate);
  let component = resolve(root);
  for (const segment of descendant.split(sep)) {
    component = resolve(component, segment);
    try {
      if ((await lstat(component)).isSymbolicLink()) {
        throw new WorkspaceRootError("workspace path contains a symbolic link");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }

  const resolvedRoot = await realpath(root);
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  const resolvedCandidate = await realpath(candidate);
  const resolvedDescendant = relative(resolvedRoot, resolvedCandidate);
  if (
    resolvedDescendant === "" ||
    resolvedDescendant === ".." ||
    resolvedDescendant.startsWith(`..${sep}`)
  ) {
    throw new WorkspaceRootError("workspace root escapes repository root");
  }
  await chmod(resolvedCandidate, 0o700);
  await access(
    resolvedCandidate,
    constants.R_OK | constants.W_OK | constants.X_OK,
  );
  return resolvedCandidate;
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

function redactDiagnostic(output: string): string {
  return output
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

function diagnosticDetail(output: Buffer, truncated: boolean): string {
  const decoded = utf8Prefix(output, output.length).toString("utf8").trim();
  const redacted = redactDiagnostic(decoded);
  const encoded = Buffer.from(redacted, "utf8");
  if (!truncated && encoded.length <= DIAGNOSTIC_LIMIT) return redacted;

  const payload = utf8Prefix(
    encoded,
    DIAGNOSTIC_LIMIT - TRUNCATION_MARKER_BYTES,
  )
    .toString("utf8")
    .trimEnd();
  return `${payload}${TRUNCATION_MARKER}`;
}

export function formatCheck(check: Check): string {
  const status = check.ok ? "PASS" : "FAIL";
  return `${status} ${check.name}: ${redactDiagnostic(check.detail)}`;
}

export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_DIAGNOSTIC_TIMEOUT_MS;
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = Buffer.alloc(0);
    let outputTruncated = false;
    let settled = false;

    const capture = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const available = DIAGNOSTIC_LIMIT - output.length;
      if (available > 0) {
        output = Buffer.concat(
          [output, bytes.subarray(0, available)],
          output.length + Math.min(bytes.length, available),
        );
      }
      if (bytes.length > available) outputTruncated = true;
    };

    const closeCaptures = () => {
      child.stdout.removeListener("data", capture);
      child.stderr.removeListener("data", capture);
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const finish = (result: CommandResult, destroyCaptures = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (destroyCaptures) closeCaptures();
      resolveResult(result);
    };

    const terminate = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => {
      finish(
        {
          ok: false,
          detail: diagnosticDetail(Buffer.from(error.message, "utf8"), false),
        },
        true,
      );
    });
    child.once("close", (code) => {
      finish({
        ok: code === 0,
        detail: diagnosticDetail(output, outputTruncated),
      });
    });
    const timeout = setTimeout(() => {
      terminate();
      finish({ ok: false, detail: `timed out after ${timeoutMs}ms` }, true);
    }, timeoutMs);
  });
}

const commandChecks = [
  { name: "node", command: "node", args: ["--version"] },
  { name: "pnpm", command: "corepack", args: ["pnpm", "--version"] },
  { name: "git", command: "git", args: ["--version"] },
  { name: "github-auth", command: "gh", args: ["auth", "status"] },
  { name: "codex-auth", command: "codex", args: ["login", "status"] },
] as const;

function safeFileFailure(file: string, cause: unknown): CommandResult {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  const suffix =
    code !== undefined && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : "";
  return { ok: false, detail: `unable to read ${file}${suffix}` };
}

async function validateNodeVersion(
  root: string,
  result: CommandResult,
): Promise<CommandResult> {
  if (!result.ok) return result;
  let pin: string;
  try {
    pin = (await readFile(resolve(root, ".node-version"), "utf8")).trim();
  } catch (error) {
    return safeFileFailure(".node-version", error);
  }
  if (!/^\d+\.\d+\.\d+$/.test(pin)) {
    return { ok: false, detail: "invalid .node-version pin" };
  }
  const actual = /^v?(\d+\.\d+\.\d+)$/.exec(result.detail.trim())?.[1];
  if (actual === undefined) {
    return { ok: false, detail: "invalid node version output" };
  }
  if (actual !== pin) {
    return {
      ok: false,
      detail: `version mismatch: expected ${pin}, received ${actual}`,
    };
  }
  return { ok: true, detail: actual };
}

async function validatePnpmVersion(
  root: string,
  result: CommandResult,
): Promise<CommandResult> {
  if (!result.ok) return result;
  let packageManager: unknown;
  try {
    const packageJson = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as { packageManager?: unknown };
    packageManager = packageJson.packageManager;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined) return safeFileFailure("package.json", error);
    return { ok: false, detail: "invalid package.json pin" };
  }
  const pin =
    typeof packageManager === "string"
      ? /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageManager)?.[1]
      : undefined;
  if (pin === undefined) {
    return { ok: false, detail: "invalid packageManager pin" };
  }
  const actual = /^(\d+\.\d+\.\d+)$/.exec(result.detail.trim())?.[1];
  if (actual === undefined) {
    return { ok: false, detail: "invalid pnpm version output" };
  }
  if (actual !== pin) {
    return {
      ok: false,
      detail: `version mismatch: expected ${pin}, received ${actual}`,
    };
  }
  return { ok: true, detail: actual };
}

export async function evaluatePreflight({
  root,
  run,
}: Options): Promise<PreflightResult> {
  const checks: Check[] = [];

  for (const check of commandChecks) {
    let result = await run(check.command, [...check.args]);
    if (check.name === "node") result = await validateNodeVersion(root, result);
    if (check.name === "pnpm") result = await validatePnpmVersion(root, result);
    checks.push({ name: check.name, ...result });
  }

  let configuredWorkspaceRoot: string | undefined;
  const configurationPath = resolveConfigurationPath(root);
  try {
    const configuration = await loadConfiguration(root);
    resolveWorkspaceRoot(root, configuration.workspace_root);
    configuredWorkspaceRoot = configuration.workspace_root;
    checks.push({
      name: "configuration",
      ok: true,
      detail: configurationPath,
    });
  } catch (error) {
    checks.push({
      name: "configuration",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (configuredWorkspaceRoot === undefined) {
    checks.push({
      name: "workspace-root",
      ok: false,
      detail: "configuration unavailable",
    });
  } else {
    try {
      const preparedWorkspace = await prepareWorkspaceRoot(
        root,
        configuredWorkspaceRoot,
      );
      checks.push({
        name: "workspace-root",
        ok: true,
        detail: preparedWorkspace,
      });
    } catch (error) {
      checks.push({
        name: "workspace-root",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ok: checks.every(({ ok }) => ok), checks };
}

async function main(): Promise<void> {
  const result = await evaluatePreflight({
    root: process.cwd(),
    run: runCommand,
  });
  for (const check of result.checks) {
    console.log(formatCheck(check));
  }
  process.exitCode = result.ok ? 0 : 1;
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  fileURLToPath(import.meta.url) === resolve(entryPath)
) {
  await main();
}
