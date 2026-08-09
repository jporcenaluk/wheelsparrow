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
