import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  type PrepareRunWorktreeInput,
  prepareRunWorktree,
  realGit,
} from "./git.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function temporaryGitRepository(): Promise<{
  repositoryRoot: string;
  remoteRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "wheelsparrow-git-"));
  temporaryDirectories.push(root);
  const repositoryRoot = join(root, "repository");
  const remoteRoot = join(root, "remote.git");
  await runGit(root, "init", "--bare", remoteRoot);
  await runGit(root, "init", "-b", "main", repositoryRoot);
  await runGit(repositoryRoot, "config", "user.email", "test@example.com");
  await runGit(repositoryRoot, "config", "user.name", "Test User");
  await runGit(repositoryRoot, "remote", "add", "origin", remoteRoot);
  await writeFile(join(repositoryRoot, "README.md"), "initial\n", "utf8");
  await runGit(repositoryRoot, "add", "README.md");
  await runGit(repositoryRoot, "commit", "-m", "initial");
  await runGit(repositoryRoot, "push", "-u", "origin", "main");
  await runGit(repositoryRoot, "branch", "develop");
  await runGit(repositoryRoot, "push", "origin", "develop");
  return { repositoryRoot, remoteRoot };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("contained Git worktree boundary", () => {
  test("creates a deterministic worktree from the current origin/main SHA", async () => {
    const { repositoryRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const input: PrepareRunWorktreeInput = {
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      baseBranch: "main",
      git: realGit,
    };

    const prepared = await prepareRunWorktree(input);

    expect(prepared.branch).toBe("wheelsparrow/42-run-7");
    expect(prepared.path.startsWith(`${workspaceRoot}${sep}`)).toBe(true);
    expect(prepared.baseSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(await runGit(prepared.path, "rev-parse", "HEAD")).toBe(
      prepared.baseSha,
    );
    expect(await runGit(prepared.path, "branch", "--show-current")).toBe(
      prepared.branch,
    );
    expect(await readFile(join(prepared.path, "README.md"), "utf8")).toBe(
      "initial\n",
    );
  });

  test("rejects a workspace root outside the repository data root", async () => {
    const { repositoryRoot } = await temporaryGitRepository();
    const outsideRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-outside-"));
    temporaryDirectories.push(outsideRoot);
    const input: PrepareRunWorktreeInput = {
      repositoryRoot,
      workspaceRoot: outsideRoot,
      runId: "run-7",
      issueNumber: 42,
      baseBranch: "main",
      git: realGit,
    };

    await expect(prepareRunWorktree(input)).rejects.toThrow("workspace root");
  });

  test("rejects a base branch other than origin/main", async () => {
    const { repositoryRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const input: PrepareRunWorktreeInput = {
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      baseBranch: "develop",
      git: realGit,
    };

    await expect(prepareRunWorktree(input)).rejects.toThrow("origin/main");
  });
});
