import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  type InspectRunWorktreeInput,
  inspectRunWorktree,
  type PrepareRunWorktreeInput,
  prepareRunWorktree,
  realGit,
  WorktreeBoundaryError,
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

  test("reports tracked and untracked changes relative to the assigned worktree", async () => {
    const { repositoryRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const prepared = await prepareRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      baseBranch: "main",
      git: realGit,
    });
    await writeFile(join(prepared.path, "README.md"), "changed\n", "utf8");
    await writeFile(join(prepared.path, "new-file.txt"), "new\n", "utf8");

    const inspected = await inspectRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      expected: {
        path: prepared.path,
        branch: prepared.branch,
        baseSha: prepared.baseSha,
        headSha: prepared.baseSha,
      },
      git: realGit,
    });

    expect(inspected.changedFiles).toEqual(["README.md", "new-file.txt"]);
    expect(
      inspected.changedFiles.every((path) => !path.startsWith("../")),
    ).toBe(true);
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

  test("rejects an existing workspace root that is not private", async () => {
    if (typeof process.getuid !== "function") return;
    const { repositoryRoot } = await temporaryGitRepository();
    const dataRoot = join(repositoryRoot, ".wheelsparrow");
    const workspaceRoot = join(dataRoot, "workspaces");
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    await chmod(dataRoot, 0o700);
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    await chmod(workspaceRoot, 0o755);

    await expect(
      prepareRunWorktree({
        repositoryRoot,
        workspaceRoot,
        runId: "run-7",
        issueNumber: 42,
        baseBranch: "main",
        git: realGit,
      }),
    ).rejects.toThrow(/private|permission/u);
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

  test("rejects duplicate ownership of a deterministic worktree", async () => {
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

    await prepareRunWorktree(input);
    await expect(prepareRunWorktree(input)).rejects.toBeInstanceOf(
      WorktreeBoundaryError,
    );
  });

  test("revalidates a prepared worktree and returns its current receipt", async () => {
    const { repositoryRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const prepared = await prepareRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      baseBranch: "main",
      git: realGit,
    });
    const expected = {
      path: prepared.path,
      branch: prepared.branch,
      baseSha: prepared.baseSha,
      headSha: prepared.baseSha,
    };

    const inspected = await inspectRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      expected,
      git: realGit,
    });

    expect(inspected).toEqual({
      ...expected,
      baseBranch: "main",
      changedFiles: [],
    });
  });

  test("rejects a receipt whose base is no longer origin/main", async () => {
    const { repositoryRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const prepared = await prepareRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      baseBranch: "main",
      git: realGit,
    });
    await writeFile(join(repositoryRoot, "README.md"), "advanced\n", "utf8");
    await runGit(repositoryRoot, "add", "README.md");
    await runGit(repositoryRoot, "commit", "-m", "advance main");
    await runGit(repositoryRoot, "push", "origin", "main");

    await expect(
      inspectRunWorktree({
        repositoryRoot,
        workspaceRoot,
        runId: "run-7",
        issueNumber: 42,
        expected: {
          path: prepared.path,
          branch: prepared.branch,
          baseSha: prepared.baseSha,
          headSha: prepared.baseSha,
        },
        git: realGit,
      }),
    ).rejects.toThrow(/origin\/main|base SHA/u);
  });

  test("rejects when Git reports a different branch for the deterministic path", async () => {
    const { repositoryRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const prepared = await prepareRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      baseBranch: "main",
      git: realGit,
    });
    await runGit(prepared.path, "branch", "-m", "wheelsparrow/42-other-run");

    await expect(
      inspectRunWorktree({
        repositoryRoot,
        workspaceRoot,
        runId: "run-7",
        issueNumber: 42,
        expected: {
          path: prepared.path,
          branch: prepared.branch,
          baseSha: prepared.baseSha,
          headSha: prepared.baseSha,
        },
        git: realGit,
      }),
    ).rejects.toThrow(/git worktree branch/u);
  });

  test("rejects a worktree from a different Git repository at the deterministic path", async () => {
    const { repositoryRoot, remoteRoot } = await temporaryGitRepository();
    const foreignRoot = await mkdtemp(
      join(tmpdir(), "wheelsparrow-foreign-git-"),
    );
    temporaryDirectories.push(foreignRoot);
    const foreignRepositoryRoot = join(foreignRoot, "repository");
    await runGit(
      foreignRoot,
      "clone",
      "-b",
      "main",
      remoteRoot,
      foreignRepositoryRoot,
    );

    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const worktreePath = join(workspaceRoot, "42-run-7");
    await mkdir(workspaceRoot, { recursive: true });
    const baseSha = await runGit(
      repositoryRoot,
      "rev-parse",
      "refs/remotes/origin/main^{commit}",
    );
    await runGit(
      foreignRepositoryRoot,
      "worktree",
      "add",
      "-b",
      "wheelsparrow/42-run-7",
      worktreePath,
      baseSha,
    );

    await expect(
      inspectRunWorktree({
        repositoryRoot,
        workspaceRoot,
        runId: "run-7",
        issueNumber: 42,
        expected: {
          path: worktreePath,
          branch: "wheelsparrow/42-run-7",
          baseSha,
          headSha: baseSha,
        },
        git: realGit,
      }),
    ).rejects.toThrow(/configured repository/u);
  });

  test("rejects an inspected worktree outside the canonical workspace root", async () => {
    const { repositoryRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const prepared = await prepareRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      baseBranch: "main",
      git: realGit,
    });
    const outsideRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-outside-"));
    temporaryDirectories.push(outsideRoot);
    const expected = {
      path: join(outsideRoot, "42-run-7"),
      branch: prepared.branch,
      baseSha: prepared.baseSha,
      headSha: prepared.baseSha,
    };

    await expect(
      inspectRunWorktree({
        repositoryRoot,
        workspaceRoot,
        runId: "run-7",
        issueNumber: 42,
        expected,
        git: realGit,
      }),
    ).rejects.toBeInstanceOf(WorktreeBoundaryError);
  });

  test("rejects a workspace root that resolves through a symbolic link", async () => {
    const { repositoryRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const prepared = await prepareRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      baseBranch: "main",
      git: realGit,
    });
    const linkedWorkspaceRoot = join(repositoryRoot, ".wheelsparrow", "linked");
    await symlink(workspaceRoot, linkedWorkspaceRoot, "junction");

    await expect(
      inspectRunWorktree({
        repositoryRoot,
        workspaceRoot: linkedWorkspaceRoot,
        runId: "run-7",
        issueNumber: 42,
        expected: {
          path: join(linkedWorkspaceRoot, "42-run-7"),
          branch: prepared.branch,
          baseSha: prepared.baseSha,
          headSha: prepared.baseSha,
        },
        git: realGit,
      }),
    ).rejects.toThrow(/symbolic link|canonical/u);
  });

  test("rejects a worktree destination that is a symbolic link", async () => {
    const { repositoryRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const outsideRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-outside-"));
    temporaryDirectories.push(outsideRoot);
    await mkdir(workspaceRoot, { recursive: true });
    await symlink(outsideRoot, join(workspaceRoot, "42-run-7"), "junction");

    await expect(
      inspectRunWorktree({
        repositoryRoot,
        workspaceRoot,
        runId: "run-7",
        issueNumber: 42,
        expected: {
          path: join(workspaceRoot, "42-run-7"),
          branch: "wheelsparrow/42-run-7",
          baseSha: "0".repeat(40),
          headSha: "0".repeat(40),
        },
        git: realGit,
      }),
    ).rejects.toThrow(/symbolic link|canonical/u);
  });

  test("normalizes Git failures to a typed boundary error", async () => {
    const { repositoryRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");

    await expect(
      realGit(repositoryRoot, ["definitely-not-a-real-git-subcommand"]),
    ).rejects.toBeInstanceOf(WorktreeBoundaryError);

    await expect(
      prepareRunWorktree({
        repositoryRoot,
        workspaceRoot,
        runId: "run-7",
        issueNumber: 42,
        baseBranch: "main",
        git: async () => {
          throw new Error("private remote details must not escape");
        },
      }),
    ).rejects.toBeInstanceOf(WorktreeBoundaryError);
  });

  test.each([
    ["wrong deterministic path", { path: "wrong-run" }],
    ["wrong deterministic branch", { branch: "wheelsparrow/42-other-run" }],
  ])("rejects a %s", async (_, override) => {
    const { repositoryRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const prepared = await prepareRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      baseBranch: "main",
      git: realGit,
    });
    const expected = {
      path: prepared.path,
      branch: prepared.branch,
      baseSha: prepared.baseSha,
      headSha: prepared.baseSha,
      ...override,
    };

    await expect(
      inspectRunWorktree({
        repositoryRoot,
        workspaceRoot,
        runId: "run-7",
        issueNumber: 42,
        expected,
        git: realGit,
      } as InspectRunWorktreeInput),
    ).rejects.toThrow(/path|branch|run/u);
  });

  test.each([
    ["head", { headSha: "f".repeat(40) }],
    ["base", { baseSha: "f".repeat(40) }],
  ])("rejects a receipt with a mismatched %s SHA", async (_, override) => {
    const { repositoryRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const prepared = await prepareRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      baseBranch: "main",
      git: realGit,
    });

    await expect(
      inspectRunWorktree({
        repositoryRoot,
        workspaceRoot,
        runId: "run-7",
        issueNumber: 42,
        expected: {
          path: prepared.path,
          branch: prepared.branch,
          baseSha: prepared.baseSha,
          headSha: prepared.baseSha,
          ...override,
        },
        git: realGit,
      }),
    ).rejects.toThrow(/SHA|base|HEAD/u);
  });
});
