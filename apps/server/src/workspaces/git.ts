import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_OUTPUT_BYTES = 1024 * 1024;
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

export interface RunWorktreeInspection extends RunWorktreeReceipt {
  readonly baseBranch: "main";
}

export type GitRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<string>;

export const realGit: GitRunner = async (cwd, args) => {
  const { stdout } = await execFile("git", [...args], {
    cwd,
    shell: false,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return stdout;
};

export class WorktreeBoundaryError extends Error {
  override name = "WorktreeBoundaryError";
}

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

  const canonicalRepositoryRoot = await realpath(input.repositoryRoot);
  const requestedWorkspaceRoot = resolve(input.workspaceRoot);
  await assertSafeWorkspacePath(
    canonicalRepositoryRoot,
    requestedWorkspaceRoot,
  );
  await mkdir(requestedWorkspaceRoot, { recursive: true, mode: 0o700 });
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
  await git(canonicalRepositoryRoot, ["fetch", "origin", input.baseBranch]);
  const baseSha = requireOutput(
    await git(canonicalRepositoryRoot, [
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${input.baseBranch}^{commit}`,
    ]),
    "base SHA",
  );
  if (!shaPattern.test(baseSha)) {
    throw new WorktreeBoundaryError("git returned an invalid base SHA");
  }

  await git(canonicalRepositoryRoot, [
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    baseSha,
  ]);

  const actualPath = requireOutput(
    await git(worktreePath, ["rev-parse", "--show-toplevel"]),
    "worktree path",
  );
  if (resolve(actualPath) !== worktreePath) {
    throw new WorktreeBoundaryError("created worktree escaped workspace root");
  }
  const actualBranch = requireOutput(
    await git(worktreePath, ["branch", "--show-current"]),
    "worktree branch",
  );
  const actualSha = requireOutput(
    await git(worktreePath, ["rev-parse", "HEAD"]),
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
  try {
    return requireOutput(await git(cwd, args), label);
  } catch (cause) {
    if (cause instanceof WorktreeBoundaryError) throw cause;
    throw new WorktreeBoundaryError(`${label} could not be verified`);
  }
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
    await git(worktreePath, [
      "merge-base",
      "--is-ancestor",
      input.expected.baseSha,
      actualHeadSha,
    ]);
  } catch {
    throw new WorktreeBoundaryError(
      "worktree HEAD does not descend from the origin/main base SHA",
    );
  }

  return {
    path: worktreePath,
    branch: actualBranch,
    baseBranch: "main",
    baseSha: originMainSha,
    headSha: actualHeadSha,
  };
}
