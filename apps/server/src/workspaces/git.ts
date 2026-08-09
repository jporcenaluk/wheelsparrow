import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  openSync,
  realpathSync,
} from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_RAW_DIFF_MAX_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const RAW_DIFF_DEADLINE_MS = 30_000;
const MAX_UNTRACKED_PATHS = 128;
const MAX_UNTRACKED_PATH_BYTES = 512;
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
const shaPattern = /^[0-9a-f]{40}$/u;
const refPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface PreparedWorktree {
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseSha: string;
}

export interface PrepareRunWorktreeInput {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly issueNumber: number;
  readonly baseBranch: string;
  readonly git?: GitRunner;
}

export interface RunWorktreeReceipt {
  readonly path: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
}

export interface InspectRunWorktreeInput {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly issueNumber: number;
  readonly expected: RunWorktreeReceipt;
  readonly git?: GitRunner;
}

export interface ReadRunWorktreeDiffInput extends InspectRunWorktreeInput {
  /** Maximum UTF-8 bytes returned to a reviewer prompt. */
  readonly maxBytes?: number;
}

export interface CommitAndPushRunWorktreeInput
  extends InspectRunWorktreeInput {}

export interface CommittedRunWorktreeReceipt {
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
}

export interface RunWorktreeInspection extends RunWorktreeReceipt {
  readonly baseBranch: "main";
  /** Paths changed from the assigned worktree's base, relative to that worktree. */
  readonly changedFiles: readonly string[];
}

export type GitRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<string>;

export class WorktreeBoundaryError extends Error {
  override name = "WorktreeBoundaryError";
}

function terminateGitProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best-effort cleanup must not replace the boundary failure.
    }
  }
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith("GIT_CONFIG_") ||
      [
        "BASH_ENV",
        "CDPATH",
        "ENV",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG",
        "GIT_COMMON_DIR",
        "GIT_DIR",
        "GIT_EXEC_PATH",
        "GIT_EXTERNAL_DIFF",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_WORK_TREE",
        "SSH_ASKPASS",
      ].includes(key)
    ) {
      delete environment[key];
    }
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

function runGitProcess(
  cwd: string,
  args: readonly string[],
  acceptedExitCodes: readonly number[] = [0],
  timeoutMs = GIT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
): Promise<string> {
  return new Promise((resolveGit, rejectGit) => {
    let cwdFd: number | undefined;
    let spawnCwd = cwd;
    if (process.platform === "linux") {
      try {
        cwdFd = openSync(
          cwd,
          fsConstants.O_RDONLY |
            fsConstants.O_DIRECTORY |
            fsConstants.O_NOFOLLOW,
        );
        const openedPath = realpathSync(`/proc/self/fd/${cwdFd}`);
        if (openedPath !== realpathSync(cwd)) {
          throw new WorktreeBoundaryError(
            "Git working directory changed while it was opened",
          );
        }
        // The child resolves this fd-backed cwd before exec, so replacing the
        // textual worktree path cannot redirect the Git process elsewhere.
        spawnCwd = `/proc/self/fd/${cwdFd}`;
      } catch (cause) {
        if (cwdFd !== undefined) closeSync(cwdFd);
        rejectGit(
          cause instanceof WorktreeBoundaryError
            ? cause
            : new WorktreeBoundaryError("Git working directory is not safe"),
        );
        return;
      }
    }

    // Git can interpret inherited variables such as GIT_DIR, GIT_WORK_TREE,
    // GIT_INDEX_FILE, GIT_SSH_COMMAND, and GIT_CONFIG_* before it reaches the
    // commit/push boundary. Keep the same constrained environment for every
    // child, including read and staging commands.
    const env = safeGitEnvironment();
    let child: ChildProcess;
    try {
      child = spawn("git", [...args], {
        cwd: spawnCwd,
        detached: process.platform !== "win32",
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      if (cwdFd !== undefined) closeSync(cwdFd);
      rejectGit(new WorktreeBoundaryError("Git process could not be started"));
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;

    const closeCwd = (): void => {
      if (cwdFd === undefined) return;
      closeSync(cwdFd);
      cwdFd = undefined;
    };

    const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const current = target === "stdout" ? stdout : stderr;
      const available = maxOutputBytes - current.length;
      if (available <= 0) {
        outputExceeded = true;
        terminateGitProcessTree(child);
        rejectBoundary();
        return;
      }
      const portion = chunk.subarray(0, available);
      const next = Buffer.concat([current, portion]);
      if (target === "stdout") stdout = next;
      else stderr = next;
      if (chunk.length > available) {
        outputExceeded = true;
        terminateGitProcessTree(child);
        rejectBoundary();
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) =>
      capture(
        "stdout",
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
      ),
    );
    child.stderr?.on("data", (chunk: Buffer | string) =>
      capture(
        "stderr",
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
      ),
    );

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateGitProcessTree(child);
      rejectBoundary();
    }, timeoutMs);

    const rejectBoundary = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeCwd();
      // Git can include remotes, credentials, or arbitrary hook output in an
      // exception. Keep the boundary diagnostic deliberately non-sensitive.
      rejectGit(
        new WorktreeBoundaryError(
          outputExceeded
            ? "Git command output exceeded its bound"
            : "Git command failed or timed out",
        ),
      );
    };

    child.once("error", rejectBoundary);
    child.once("close", (exitCode) => {
      if (settled) return;
      if (
        timedOut ||
        outputExceeded ||
        exitCode === null ||
        !acceptedExitCodes.includes(exitCode)
      ) {
        rejectBoundary();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      closeCwd();
      resolveGit(stdout.toString("utf8"));
    });
  });
}

export const realGit: GitRunner = (cwd, args) =>
  runGitProcess(cwd, args, args.includes("--no-index") ? [0, 1] : [0]);

function assertRef(value: string, label: string): void {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    !refPattern.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/")
  ) {
    throw new WorktreeBoundaryError(`${label} must be a valid Git ref`);
  }
}

function assertContained(root: string, candidate: string): void {
  const descendant = relative(root, candidate);
  if (
    descendant === "" ||
    descendant === ".." ||
    descendant.startsWith(`..${sep}`) ||
    isAbsolute(descendant)
  ) {
    throw new WorktreeBoundaryError(
      "workspace root must be below the canonical repository root",
    );
  }
}

function assertPrivateDirectory(
  path: string,
  metadata: { readonly mode: number; readonly uid: number },
): void {
  if (
    typeof process.getuid === "function" &&
    (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0)
  ) {
    throw new WorktreeBoundaryError(
      `workspace directory is not private to the current user: ${path}`,
    );
  }
}

async function assertSafeWorkspacePath(
  repositoryRoot: string,
  workspaceRoot: string,
): Promise<void> {
  assertContained(repositoryRoot, workspaceRoot);

  const segments = relative(repositoryRoot, workspaceRoot).split(sep);
  let current = repositoryRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new WorktreeBoundaryError(
          "workspace root must not contain symbolic links",
        );
      }
      if (!metadata.isDirectory()) {
        throw new WorktreeBoundaryError(
          "workspace root components must be directories",
        );
      }
      assertPrivateDirectory(current, metadata);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
  }
}

async function canonicalExistingDirectory(
  path: string,
  label: string,
): Promise<string> {
  const requestedPath = resolve(path);
  try {
    const metadata = await lstat(requestedPath);
    if (metadata.isSymbolicLink()) {
      throw new WorktreeBoundaryError(
        `${label} must not contain symbolic links`,
      );
    }
    if (!metadata.isDirectory()) {
      throw new WorktreeBoundaryError(`${label} must be a directory`);
    }
    const canonicalPath = await realpath(requestedPath);
    if (canonicalPath !== requestedPath) {
      throw new WorktreeBoundaryError(
        `${label} must resolve to its canonical path without symbolic links`,
      );
    }
    return canonicalPath;
  } catch (cause) {
    if (cause instanceof WorktreeBoundaryError) throw cause;
    throw new WorktreeBoundaryError(`${label} is not a usable directory`);
  }
}

function requireOutput(value: string, label: string): string {
  const output = value.trim();
  if (output.length === 0) {
    throw new WorktreeBoundaryError(`git returned no ${label}`);
  }
  return output;
}

async function runGit(
  git: GitRunner,
  cwd: string,
  args: readonly string[],
  label: string,
): Promise<string> {
  try {
    const output = await git(cwd, args);
    if (typeof output !== "string") {
      throw new Error("Git runner returned a non-string result");
    }
    return output;
  } catch (cause) {
    if (cause instanceof WorktreeBoundaryError) throw cause;
    throw new WorktreeBoundaryError(`${label} could not be completed`);
  }
}

export async function prepareRunWorktree(
  input: PrepareRunWorktreeInput,
): Promise<PreparedWorktree> {
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) {
    throw new WorktreeBoundaryError("issue number must be a positive integer");
  }
  if (!runIdPattern.test(input.runId)) {
    throw new WorktreeBoundaryError("run ID must be a safe path segment");
  }
  if (input.baseBranch !== "main") {
    throw new WorktreeBoundaryError("base branch must be origin/main");
  }
  assertRef(input.baseBranch, "base branch");

  const canonicalRepositoryRoot = await canonicalExistingDirectory(
    input.repositoryRoot,
    "repository root",
  );
  const requestedWorkspaceRoot = resolve(input.workspaceRoot);
  await assertSafeWorkspacePath(
    canonicalRepositoryRoot,
    requestedWorkspaceRoot,
  );
  await mkdir(requestedWorkspaceRoot, { recursive: true, mode: 0o700 });
  // Re-check every component after creation. This closes the gap where a
  // parent is replaced by a symlink between the preflight and mkdir calls.
  await assertSafeWorkspacePath(
    canonicalRepositoryRoot,
    requestedWorkspaceRoot,
  );
  const canonicalWorkspaceRoot = await realpath(requestedWorkspaceRoot);
  assertContained(canonicalRepositoryRoot, canonicalWorkspaceRoot);
  if (canonicalWorkspaceRoot !== requestedWorkspaceRoot) {
    throw new WorktreeBoundaryError(
      "workspace root must resolve to its canonical path",
    );
  }

  const branch = `wheelsparrow/${input.issueNumber}-${input.runId}`;
  const worktreePath = join(
    canonicalWorkspaceRoot,
    `${input.issueNumber}-${input.runId}`,
  );
  assertContained(canonicalWorkspaceRoot, worktreePath);

  const git = input.git ?? realGit;
  await runGit(
    git,
    canonicalRepositoryRoot,
    ["fetch", "origin", input.baseBranch],
    "fetch origin/main",
  );
  const baseSha = requireOutput(
    await runGit(
      git,
      canonicalRepositoryRoot,
      [
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${input.baseBranch}^{commit}`,
      ],
      "resolve origin/main",
    ),
    "base SHA",
  );
  if (!shaPattern.test(baseSha)) {
    throw new WorktreeBoundaryError("git returned an invalid base SHA");
  }

  await runGit(
    git,
    canonicalRepositoryRoot,
    ["worktree", "add", "-b", branch, worktreePath, baseSha],
    "create worktree",
  );

  // A worktree may be inspected only when its path itself is a canonical,
  // non-symlink directory. Git's reported top-level path is not sufficient:
  // a symlink can make a textual path appear contained while resolving out.
  const canonicalCreatedPath = await canonicalExistingDirectory(
    worktreePath,
    "created worktree path",
  );
  if (canonicalCreatedPath !== worktreePath) {
    throw new WorktreeBoundaryError("created worktree escaped workspace root");
  }

  const actualPath = requireOutput(
    await runGit(
      git,
      worktreePath,
      ["rev-parse", "--show-toplevel"],
      "verify worktree path",
    ),
    "worktree path",
  );
  if (resolve(actualPath) !== worktreePath) {
    throw new WorktreeBoundaryError("created worktree escaped workspace root");
  }
  const actualBranch = requireOutput(
    await runGit(
      git,
      worktreePath,
      ["branch", "--show-current"],
      "verify worktree branch",
    ),
    "worktree branch",
  );
  const actualSha = requireOutput(
    await runGit(
      git,
      worktreePath,
      ["rev-parse", "HEAD"],
      "verify worktree SHA",
    ),
    "worktree SHA",
  );
  if (actualBranch !== branch || actualSha !== baseSha) {
    throw new WorktreeBoundaryError(
      "created worktree did not match the requested branch and base",
    );
  }

  return {
    path: worktreePath,
    branch,
    baseBranch: input.baseBranch,
    baseSha,
  };
}

function assertReceiptSha(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    throw new WorktreeBoundaryError(`${label} must be a 40-character SHA`);
  }
}

function assertReceiptText(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0
  ) {
    throw new WorktreeBoundaryError(`${label} must be non-empty text`);
  }
}

async function inspectGit(
  git: GitRunner,
  cwd: string,
  args: readonly string[],
  label: string,
): Promise<string> {
  return requireOutput(
    await runGit(git, cwd, args, `${label} verification`),
    label,
  );
}

function assertChangedPathContained(
  worktreePath: string,
  changedPath: string,
): string {
  if (changedPath.length === 0 || changedPath.includes("\0")) {
    throw new WorktreeBoundaryError("Git reported an invalid changed path");
  }
  if (Buffer.byteLength(changedPath, "utf8") > MAX_UNTRACKED_PATH_BYTES) {
    throw new WorktreeBoundaryError(
      "Git reported an excessively long changed path",
    );
  }
  // Git's -z output uses slash separators even on Windows.
  const nativePath = changedPath.split("/").join(sep);
  if (isAbsolute(nativePath)) {
    throw new WorktreeBoundaryError(
      "Git reported a changed path outside the worktree",
    );
  }
  const absolutePath = resolve(worktreePath, nativePath);
  const relativePath = relative(worktreePath, absolutePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath) ||
    relativePath !== nativePath
  ) {
    throw new WorktreeBoundaryError(
      "Git reported a changed path outside the worktree",
    );
  }
  return changedPath;
}

async function inspectChangedFiles(
  git: GitRunner,
  worktreePath: string,
): Promise<readonly string[]> {
  const trackedOutput = await runGit(
    git,
    worktreePath,
    ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"],
    "inspect tracked changes",
  );
  const untrackedPaths = await inspectUntrackedFiles(git, worktreePath);
  const paths = [...trackedOutput.split("\0"), ...untrackedPaths]
    .filter((path) => path.length > 0)
    .map((path) => assertChangedPathContained(worktreePath, path));
  return [...new Set(paths)].toSorted();
}

function parseChangedPathOutput(
  worktreePath: string,
  output: string,
): readonly string[] {
  return output
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => assertChangedPathContained(worktreePath, path))
    .toSorted();
}

async function inspectUntrackedFiles(
  git: GitRunner,
  worktreePath: string,
): Promise<readonly string[]> {
  const untrackedOutput = await runGit(
    git,
    worktreePath,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "inspect untracked changes",
  );
  const paths = untrackedOutput
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => assertChangedPathContained(worktreePath, path))
    .toSorted();
  if (paths.length > MAX_UNTRACKED_PATHS)
    throw new WorktreeBoundaryError(
      `worktree has more than ${MAX_UNTRACKED_PATHS} untracked files`,
    );
  return paths;
}

interface UntrackedFileIdentity {
  readonly path: string;
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface DirectoryIdentity {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly ctimeMs: number;
}

async function inspectDirectoryIdentity(
  path: string,
  label: string,
): Promise<DirectoryIdentity> {
  const requestedPath = resolve(path);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  let canonicalPath: string;
  try {
    metadata = await lstat(requestedPath);
    if (metadata.isSymbolicLink())
      throw new WorktreeBoundaryError(`${label} must not be a symbolic link`);
    if (!metadata.isDirectory())
      throw new WorktreeBoundaryError(`${label} must be a directory`);
    canonicalPath = await realpath(requestedPath);
    if (canonicalPath !== requestedPath)
      throw new WorktreeBoundaryError(
        `${label} must resolve to its canonical path`,
      );
  } catch (cause) {
    if (cause instanceof WorktreeBoundaryError) throw cause;
    throw new WorktreeBoundaryError(`${label} is not a stable directory`);
  }
  return {
    requestedPath,
    canonicalPath,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    ctimeMs: metadata.ctimeMs,
  };
}

function sameDirectoryIdentity(
  before: DirectoryIdentity,
  after: DirectoryIdentity,
): boolean {
  return (
    before.requestedPath === after.requestedPath &&
    before.canonicalPath === after.canonicalPath &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.ctimeMs === after.ctimeMs
  );
}

async function inspectReadableUntrackedFile(
  worktreePath: string,
  path: string,
): Promise<UntrackedFileIdentity> {
  const safePath = assertChangedPathContained(worktreePath, path);
  const requestedPath = resolve(worktreePath, safePath.split("/").join(sep));
  let metadata: Awaited<ReturnType<typeof lstat>>;
  let canonicalPath: string;
  try {
    metadata = await lstat(requestedPath);
    if (metadata.isSymbolicLink())
      throw new WorktreeBoundaryError(
        "untracked diff path must not be a symbolic link",
      );
    if (!metadata.isFile())
      throw new WorktreeBoundaryError("untracked diff path must be a file");
    if (metadata.size > MAX_UNTRACKED_FILE_BYTES)
      throw new WorktreeBoundaryError(
        "untracked diff file exceeds its bounded readback limit",
      );
    canonicalPath = await realpath(requestedPath);
    if (canonicalPath !== requestedPath)
      throw new WorktreeBoundaryError(
        "untracked diff path must resolve within the worktree",
      );
  } catch (cause) {
    if (cause instanceof WorktreeBoundaryError) throw cause;
    throw new WorktreeBoundaryError("untracked diff path is not readable");
  }
  return {
    path: safePath,
    requestedPath,
    canonicalPath,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}

function sameUntrackedIdentity(
  before: UntrackedFileIdentity,
  after: UntrackedFileIdentity,
): boolean {
  return (
    before.path === after.path &&
    before.requestedPath === after.requestedPath &&
    before.canonicalPath === after.canonicalPath &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function boundedRawDiffGit(
  git: GitRunner,
  deadline: number,
  maximumBytes: number,
): GitRunner {
  if (git !== realGit) return git;
  return (cwd, args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      return Promise.reject(
        new WorktreeBoundaryError("raw diff read exceeded its time limit"),
      );
    return runGitProcess(
      cwd,
      args,
      args.includes("--no-index") ? [0, 1] : [0],
      Math.min(GIT_TIMEOUT_MS, remaining),
      Math.min(MAX_OUTPUT_BYTES, maximumBytes + 1),
    );
  };
}

async function inspectGitCommonDirectory(
  git: GitRunner,
  cwd: string,
  label: string,
): Promise<string> {
  const commonDirectory = await inspectGit(
    git,
    cwd,
    ["rev-parse", "--git-common-dir"],
    label,
  );
  return canonicalExistingDirectory(resolve(cwd, commonDirectory), label);
}

export async function inspectRunWorktree(
  input: InspectRunWorktreeInput,
): Promise<RunWorktreeInspection> {
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) {
    throw new WorktreeBoundaryError("issue number must be a positive integer");
  }
  if (!runIdPattern.test(input.runId)) {
    throw new WorktreeBoundaryError("run ID must be a safe path segment");
  }
  if (
    typeof input.expected !== "object" ||
    input.expected === null ||
    Array.isArray(input.expected)
  ) {
    throw new WorktreeBoundaryError("worktree receipt must be an object");
  }
  assertReceiptText(input.expected.path, "worktree path");
  assertReceiptText(input.expected.branch, "worktree branch");
  assertReceiptSha(input.expected.baseSha, "base SHA");
  assertReceiptSha(input.expected.headSha, "head SHA");

  const canonicalRepositoryRoot = await canonicalExistingDirectory(
    input.repositoryRoot,
    "repository root",
  );
  const canonicalWorkspaceRoot = await canonicalExistingDirectory(
    input.workspaceRoot,
    "workspace root",
  );
  assertContained(canonicalRepositoryRoot, canonicalWorkspaceRoot);

  const expectedBranch = `wheelsparrow/${input.issueNumber}-${input.runId}`;
  const expectedPath = join(
    canonicalWorkspaceRoot,
    `${input.issueNumber}-${input.runId}`,
  );
  if (resolve(input.expected.path) !== expectedPath) {
    throw new WorktreeBoundaryError(
      "worktree receipt path does not match the run workspace",
    );
  }
  if (input.expected.branch !== expectedBranch) {
    throw new WorktreeBoundaryError(
      "worktree receipt branch does not match the run",
    );
  }

  const worktreePath = await canonicalExistingDirectory(
    input.expected.path,
    "worktree path",
  );
  assertContained(canonicalWorkspaceRoot, worktreePath);
  if (worktreePath !== expectedPath) {
    throw new WorktreeBoundaryError(
      "worktree path must resolve to its deterministic canonical path",
    );
  }

  const git = input.git ?? realGit;
  const actualPath = await inspectGit(
    git,
    worktreePath,
    ["rev-parse", "--show-toplevel"],
    "worktree path",
  );
  if (resolve(actualPath) !== worktreePath) {
    throw new WorktreeBoundaryError("git worktree path escaped its boundary");
  }
  const repositoryGitDirectory = await inspectGitCommonDirectory(
    git,
    canonicalRepositoryRoot,
    "repository Git directory",
  );
  const worktreeGitDirectory = await inspectGitCommonDirectory(
    git,
    worktreePath,
    "worktree Git directory",
  );
  if (worktreeGitDirectory !== repositoryGitDirectory) {
    throw new WorktreeBoundaryError(
      "worktree does not belong to the configured repository",
    );
  }
  const actualBranch = await inspectGit(
    git,
    worktreePath,
    ["branch", "--show-current"],
    "worktree branch",
  );
  if (actualBranch !== expectedBranch) {
    throw new WorktreeBoundaryError(
      "git worktree branch does not match the run",
    );
  }

  const originMainSha = await inspectGit(
    git,
    canonicalRepositoryRoot,
    ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
    "origin/main base SHA",
  );
  assertReceiptSha(originMainSha, "origin/main base SHA");
  if (originMainSha !== input.expected.baseSha) {
    throw new WorktreeBoundaryError(
      "worktree base SHA does not match origin/main",
    );
  }

  const actualHeadSha = await inspectGit(
    git,
    worktreePath,
    ["rev-parse", "HEAD"],
    "worktree HEAD",
  );
  assertReceiptSha(actualHeadSha, "worktree HEAD");
  if (actualHeadSha !== input.expected.headSha) {
    throw new WorktreeBoundaryError(
      "worktree HEAD does not match the expected head SHA",
    );
  }
  try {
    await runGit(
      git,
      worktreePath,
      ["merge-base", "--is-ancestor", input.expected.baseSha, actualHeadSha],
      "verify worktree ancestry",
    );
  } catch {
    throw new WorktreeBoundaryError(
      "worktree HEAD does not descend from the origin/main base SHA",
    );
  }

  const changedFiles = await inspectChangedFiles(git, worktreePath);

  return {
    path: worktreePath,
    branch: actualBranch,
    baseBranch: "main",
    baseSha: originMainSha,
    headSha: actualHeadSha,
    changedFiles,
  };
}

/**
 * Revalidate the assigned worktree before reading its canonical tracked diff.
 *
 * The receipt is intentionally inspected again rather than trusting a caller's
 * path or SHA. The raw patch is read from the recorded origin/main base to the
 * current worktree HEAD, and is rejected if it exceeds the prompt boundary.
 */
export async function readRunWorktreeDiff(
  input: ReadRunWorktreeDiffInput,
): Promise<string> {
  const maximumBytes = input.maxBytes ?? DEFAULT_RAW_DIFF_MAX_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > DEFAULT_RAW_DIFF_MAX_BYTES
  ) {
    throw new WorktreeBoundaryError(
      `raw diff byte limit must be an integer between 1 and ${DEFAULT_RAW_DIFF_MAX_BYTES}`,
    );
  }

  const git = input.git ?? realGit;
  const deadline = Date.now() + RAW_DIFF_DEADLINE_MS;
  const rawGit = boundedRawDiffGit(git, deadline, maximumBytes);
  const inspected = await inspectRunWorktree({ ...input, git: rawGit });
  let rawDiff = await runGit(
    rawGit,
    inspected.path,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--binary",
      "--full-index",
      "--no-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      inspected.baseSha,
      "--",
    ],
    "read worktree raw diff",
  );
  if (Buffer.byteLength(rawDiff, "utf8") > maximumBytes) {
    throw new WorktreeBoundaryError(
      "raw diff exceeds its bounded readback limit",
    );
  }

  // The tracked diff reads the worktree/index, not just an immutable pair of
  // commits. Revalidate every assigned identity after the read so a branch,
  // repository, base, HEAD, or worktree replacement cannot make the returned
  // patch belong to a different checkout than the inspected receipt.
  const revalidated = await inspectRunWorktree({ ...input, git: rawGit });
  if (
    revalidated.path !== inspected.path ||
    revalidated.branch !== inspected.branch ||
    revalidated.baseSha !== inspected.baseSha ||
    revalidated.headSha !== inspected.headSha
  ) {
    throw new WorktreeBoundaryError(
      "assigned worktree identity changed while reading its tracked diff",
    );
  }

  const untrackedPaths = await inspectUntrackedFiles(rawGit, inspected.path);
  for (const path of untrackedPaths) {
    const before = await inspectReadableUntrackedFile(inspected.path, path);
    const untrackedDiff = await rawGit(inspected.path, [
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--binary",
      "--full-index",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--",
      process.platform === "win32" ? "NUL" : "/dev/null",
      before.path,
    ]);
    const after = await inspectReadableUntrackedFile(inspected.path, path);
    if (!sameUntrackedIdentity(before, after))
      throw new WorktreeBoundaryError(
        "untracked diff path changed while it was being read",
      );
    rawDiff += `${rawDiff.length === 0 ? "" : "\n"}${untrackedDiff}`;
    if (Buffer.byteLength(rawDiff, "utf8") > maximumBytes) {
      throw new WorktreeBoundaryError(
        "raw diff exceeds its bounded readback limit",
      );
    }
  }
  return rawDiff;
}

/**
 * Commit and publish only the assigned run worktree after revalidating every
 * persisted identity. The operation never force-pushes and returns only the
 * exact branch/base/head facts needed by the publication boundary.
 */
export async function commitAndPushRunWorktree(
  input: CommitAndPushRunWorktreeInput,
): Promise<CommittedRunWorktreeReceipt> {
  const git = input.git ?? realGit;
  const inspected = await inspectRunWorktree({ ...input, git });
  if (inspected.changedFiles.length === 0) {
    throw new WorktreeBoundaryError(
      "cannot publish a worktree with no intentional changes",
    );
  }

  const beforeStage = await inspectRunWorktree({ ...input, git });
  if (
    beforeStage.path !== inspected.path ||
    beforeStage.branch !== inspected.branch ||
    beforeStage.baseSha !== inspected.baseSha ||
    beforeStage.headSha !== inspected.headSha ||
    beforeStage.changedFiles.length !== inspected.changedFiles.length ||
    beforeStage.changedFiles.some(
      (path, index) => path !== inspected.changedFiles[index],
    )
  ) {
    throw new WorktreeBoundaryError(
      "assigned worktree identity or changes changed before staging",
    );
  }

  const worktreeBeforeStage = await inspectDirectoryIdentity(
    beforeStage.path,
    "worktree path",
  );
  const untrackedPaths = await inspectUntrackedFiles(git, beforeStage.path);
  const untrackedBeforeStage = await Promise.all(
    untrackedPaths.map((path) =>
      inspectReadableUntrackedFile(beforeStage.path, path),
    ),
  );
  if (
    untrackedPaths.some((path) => !beforeStage.changedFiles.includes(path)) ||
    untrackedPaths.length !==
      beforeStage.changedFiles.filter((path) => untrackedPaths.includes(path))
        .length
  ) {
    throw new WorktreeBoundaryError("untracked changes changed before staging");
  }

  await runGit(
    git,
    beforeStage.path,
    ["add", "--", ...beforeStage.changedFiles],
    "stage worktree changes",
  );

  const worktreeAfterStage = await inspectDirectoryIdentity(
    beforeStage.path,
    "worktree path",
  );
  if (!sameDirectoryIdentity(worktreeBeforeStage, worktreeAfterStage)) {
    throw new WorktreeBoundaryError(
      "worktree path changed while staging changes",
    );
  }
  for (const before of untrackedBeforeStage) {
    const after = await inspectReadableUntrackedFile(
      beforeStage.path,
      before.path,
    );
    if (!sameUntrackedIdentity(before, after)) {
      throw new WorktreeBoundaryError(
        "untracked path changed while staging changes",
      );
    }
  }

  const stagedFiles = parseChangedPathOutput(
    beforeStage.path,
    await runGit(
      git,
      beforeStage.path,
      ["diff", "--cached", "--name-only", "-z", "--"],
      "inspect staged changes",
    ),
  );
  if (
    stagedFiles.length !== beforeStage.changedFiles.length ||
    stagedFiles.some((path, index) => path !== beforeStage.changedFiles[index])
  ) {
    throw new WorktreeBoundaryError(
      "staged changes do not match the assigned worktree changes",
    );
  }

  const stagedInspection = await inspectRunWorktree({
    ...input,
    git,
  });
  if (
    stagedInspection.path !== beforeStage.path ||
    stagedInspection.branch !== beforeStage.branch ||
    stagedInspection.baseSha !== beforeStage.baseSha ||
    stagedInspection.headSha !== beforeStage.headSha ||
    stagedInspection.changedFiles.length !== beforeStage.changedFiles.length ||
    stagedInspection.changedFiles.some(
      (path, index) => path !== beforeStage.changedFiles[index],
    )
  ) {
    throw new WorktreeBoundaryError(
      "assigned worktree identity or changes changed while staging",
    );
  }

  const worktreeBeforeCommit = await inspectDirectoryIdentity(
    stagedInspection.path,
    "worktree path",
  );
  for (const before of untrackedBeforeStage) {
    const after = await inspectReadableUntrackedFile(
      stagedInspection.path,
      before.path,
    );
    if (!sameUntrackedIdentity(before, after)) {
      throw new WorktreeBoundaryError(
        "untracked path changed before creating the publication commit",
      );
    }
  }

  await runGit(
    git,
    stagedInspection.path,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--no-verify",
      "-m",
      `feat: publish issue #${input.issueNumber} run ${input.runId}`,
    ],
    "commit worktree changes",
  );

  const committedHeadSha = await inspectGit(
    git,
    stagedInspection.path,
    ["rev-parse", "HEAD"],
    "committed worktree HEAD",
  );
  assertReceiptSha(committedHeadSha, "committed worktree HEAD");
  if (committedHeadSha === stagedInspection.headSha) {
    throw new WorktreeBoundaryError("Git commit did not advance worktree HEAD");
  }
  const worktreeAfterCommit = await inspectDirectoryIdentity(
    stagedInspection.path,
    "worktree path",
  );
  if (!sameDirectoryIdentity(worktreeBeforeCommit, worktreeAfterCommit)) {
    throw new WorktreeBoundaryError(
      "worktree path changed while creating the publication commit",
    );
  }

  const committedExpected = {
    path: stagedInspection.path,
    branch: stagedInspection.branch,
    baseSha: stagedInspection.baseSha,
    headSha: committedHeadSha,
  };
  const committedInspection = await inspectRunWorktree({
    ...input,
    expected: committedExpected,
    git,
  });
  if (committedInspection.changedFiles.length !== 0) {
    throw new WorktreeBoundaryError(
      "worktree changed while creating its publication commit",
    );
  }

  const worktreeBeforePush = await inspectDirectoryIdentity(
    committedInspection.path,
    "worktree path",
  );
  await runGit(
    git,
    committedInspection.path,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "--no-verify",
      "origin",
      committedInspection.branch,
    ],
    "push ticket branch",
  );
  const worktreeAfterPush = await inspectDirectoryIdentity(
    committedInspection.path,
    "worktree path",
  );
  if (!sameDirectoryIdentity(worktreeBeforePush, worktreeAfterPush)) {
    throw new WorktreeBoundaryError(
      "worktree path changed while pushing the ticket branch",
    );
  }

  const remoteOutput = await runGit(
    git,
    committedInspection.path,
    ["ls-remote", "--heads", "origin", committedInspection.branch],
    "verify pushed ticket branch",
  );
  const remoteLines = remoteOutput
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  if (remoteLines.length !== 1) {
    throw new WorktreeBoundaryError(
      "Git returned an invalid pushed ticket branch",
    );
  }
  const remoteParts = remoteLines[0]?.split(/\s+/u);
  if (
    remoteParts === undefined ||
    remoteParts.length !== 2 ||
    remoteParts[1] !== `refs/heads/${committedInspection.branch}`
  ) {
    throw new WorktreeBoundaryError(
      "Git returned an invalid pushed ticket branch",
    );
  }
  assertReceiptSha(remoteParts[0], "pushed ticket branch SHA");
  if (remoteParts[0] !== committedHeadSha) {
    throw new WorktreeBoundaryError(
      "pushed ticket branch HEAD does not match the committed HEAD",
    );
  }

  const finalInspection = await inspectRunWorktree({
    ...input,
    expected: committedExpected,
    git,
  });
  if (finalInspection.changedFiles.length !== 0) {
    throw new WorktreeBoundaryError(
      "assigned worktree changed while publishing its ticket branch",
    );
  }
  return {
    branch: finalInspection.branch,
    baseSha: finalInspection.baseSha,
    headSha: finalInspection.headSha,
  };
}
