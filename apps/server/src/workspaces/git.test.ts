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
  commitAndPushRunWorktree,
  type InspectRunWorktreeInput,
  inspectRunWorktree,
  type PrepareRunWorktreeInput,
  prepareRunWorktree,
  readRunWorktreeDiff,
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

  test("reads a bounded canonical diff only after revalidating the assigned worktree", async () => {
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

    const diff = await readRunWorktreeDiff({
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

    expect(diff).toContain("diff --git a/README.md b/README.md");
    expect(diff).toContain("+changed");
    expect(Buffer.byteLength(diff, "utf8")).toBeLessThanOrEqual(256 * 1024);
  });

  test("includes safe untracked files in the bounded canonical diff", async () => {
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
    await writeFile(join(prepared.path, "new-file.txt"), "untracked\n", "utf8");

    const diff = await readRunWorktreeDiff({
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

    expect(diff).toContain("new-file.txt");
    expect(diff).toContain("+untracked");

    await writeFile(
      join(prepared.path, "new-file.txt"),
      `${"x".repeat(2_000)}\n`,
      "utf8",
    );
    await expect(
      readRunWorktreeDiff({
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
        maxBytes: 128,
        git: realGit,
      }),
    ).rejects.toThrow(/raw diff|size|bound/u);
  });

  test("rejects untracked symlinks instead of reading outside the worktree", async () => {
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
    const outside = join(repositoryRoot, "outside-secret.txt");
    await writeFile(outside, "secret\n", "utf8");
    await symlink(outside, join(prepared.path, "leak.txt"));

    await expect(
      readRunWorktreeDiff({
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
    ).rejects.toThrow(/symbolic|symlink|contained|outside/u);
  });

  test("rejects an untracked file replaced during the Git diff read", async () => {
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
    const path = join(prepared.path, "race.txt");
    const outside = join(repositoryRoot, "race-secret.txt");
    await writeFile(path, "safe\n", "utf8");
    await writeFile(outside, "secret\n", "utf8");
    let replaced = false;
    const racingGit = async (cwd: string, args: readonly string[]) => {
      const output = await realGit(cwd, args);
      if (!replaced && args.includes("--no-index")) {
        replaced = true;
        await rm(path);
        await symlink(outside, path);
      }
      return output;
    };

    await expect(
      readRunWorktreeDiff({
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
        git: racingGit,
      }),
    ).rejects.toThrow(/changed|symbolic|symlink|outside/u);
  });

  test("rejects an assigned worktree with unrelated history before reading its diff", async () => {
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
    await runGit(prepared.path, "checkout", "--orphan", "unrelated-history");
    await writeFile(join(prepared.path, "README.md"), "unrelated\n", "utf8");
    await runGit(prepared.path, "add", "README.md");
    await runGit(prepared.path, "commit", "-m", "unrelated history");
    const unrelatedHead = await runGit(prepared.path, "rev-parse", "HEAD");
    await runGit(prepared.path, "branch", "-f", prepared.branch, unrelatedHead);
    await runGit(prepared.path, "checkout", prepared.branch);

    await expect(
      readRunWorktreeDiff({
        repositoryRoot,
        workspaceRoot,
        runId: "run-7",
        issueNumber: 42,
        expected: {
          path: prepared.path,
          branch: prepared.branch,
          baseSha: prepared.baseSha,
          headSha: unrelatedHead,
        },
        git: realGit,
      }),
    ).rejects.toThrow(/ancestry|descend|origin\/main|base/u);
  });

  test("bounds the number of untracked files before launching per-file diffs", async () => {
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
    await Promise.all(
      Array.from({ length: 129 }, (_, index) =>
        writeFile(join(prepared.path, `untracked-${index}.txt`), "x\n", "utf8"),
      ),
    );

    await expect(
      readRunWorktreeDiff({
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
    ).rejects.toThrow(/more than 128|untracked/u);
  });

  test("rejects a raw diff that exceeds its bounded readback limit", async () => {
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
    await writeFile(
      join(prepared.path, "README.md"),
      `${"x".repeat(2_000)}\n`,
      "utf8",
    );

    await expect(
      readRunWorktreeDiff({
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
        maxBytes: 128,
        git: realGit,
      }),
    ).rejects.toThrow(/raw diff|size|bound/u);
  });

  test("revalidates worktree identity before reading the diff", async () => {
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
      readRunWorktreeDiff({
        repositoryRoot,
        workspaceRoot,
        runId: "run-7",
        issueNumber: 42,
        expected: {
          path: prepared.path,
          branch: prepared.branch,
          baseSha: prepared.baseSha,
          headSha: "b".repeat(40),
        },
        git: realGit,
      }),
    ).rejects.toThrow(/HEAD|SHA|receipt/u);
  });

  test("rejects a tracked diff when HEAD changes during the raw read", async () => {
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
    let raced = false;
    const racingGit = async (cwd: string, args: readonly string[]) => {
      const output = await realGit(cwd, args);
      if (!raced && args.includes("--binary") && !args.includes("--no-index")) {
        raced = true;
        await writeFile(join(prepared.path, "README.md"), "raced\n", "utf8");
        await runGit(prepared.path, "add", "README.md");
        await runGit(prepared.path, "commit", "-m", "raced HEAD");
      }
      return output;
    };

    await expect(
      readRunWorktreeDiff({
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
        git: racingGit,
      }),
    ).rejects.toThrow(/HEAD|SHA|receipt/u);
  });

  test("rejects a tracked diff when the assigned worktree is replaced during the raw read", async () => {
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
    let raced = false;
    const racingGit = async (cwd: string, args: readonly string[]) => {
      const output = await realGit(cwd, args);
      if (!raced && args.includes("--binary") && !args.includes("--no-index")) {
        raced = true;
        await rm(prepared.path, { recursive: true, force: true });
        await symlink(repositoryRoot, prepared.path);
      }
      return output;
    };

    await expect(
      readRunWorktreeDiff({
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
        git: racingGit,
      }),
    ).rejects.toThrow(/symbolic|symlink|worktree|boundary/u);
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

  test("commits intentional changes and pushes the exact ticket branch", async () => {
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
    await writeFile(join(prepared.path, "README.md"), "published\n", "utf8");
    await writeFile(join(prepared.path, "new-file.txt"), "new\n", "utf8");
    const gitCalls: string[][] = [];
    const recordingGit = async (cwd: string, args: readonly string[]) => {
      gitCalls.push([...args]);
      return realGit(cwd, args);
    };

    const receipt = await commitAndPushRunWorktree({
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
      git: recordingGit,
    });

    expect(receipt).toEqual({
      branch: prepared.branch,
      baseSha: prepared.baseSha,
      headSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
    });
    expect(receipt.headSha).not.toBe(prepared.baseSha);
    expect(await runGit(prepared.path, "log", "-1", "--pretty=%s")).toBe(
      "feat: publish issue #42 run run-7",
    );
    expect(await runGit(prepared.path, "status", "--porcelain")).toBe("");
    expect(gitCalls).toContainEqual(["add", "--", "README.md", "new-file.txt"]);
    expect(gitCalls).toContainEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "--no-verify",
      "origin",
      prepared.branch,
    ]);
    expect(gitCalls.some((args) => args.includes("--force"))).toBe(false);
    expect(
      await runGit(prepared.path, "ls-remote", "origin", prepared.branch),
    ).toBe(`${receipt.headSha}\trefs/heads/${prepared.branch}`);
  });

  test("rejects an empty worktree without creating or pushing a commit", async () => {
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
      commitAndPushRunWorktree({
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
    ).rejects.toThrow(/change/u);
    expect(await runGit(prepared.path, "rev-parse", "HEAD")).toBe(
      prepared.baseSha,
    );
    expect(await runGit(prepared.path, "diff", "--cached", "--name-only")).toBe(
      "",
    );
    expect(
      await runGit(prepared.path, "ls-remote", "origin", prepared.branch),
    ).toBe("");
  });

  test("rejects an untracked symlink before staging any changes", async () => {
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
    const outside = join(repositoryRoot, "outside-secret.txt");
    await writeFile(outside, "secret\n", "utf8");
    await symlink(outside, join(prepared.path, "leak.txt"));

    await expect(
      commitAndPushRunWorktree({
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
    ).rejects.toThrow(/symbolic|symlink/u);
    expect(await runGit(prepared.path, "rev-parse", "HEAD")).toBe(
      prepared.baseSha,
    );
    expect(
      await runGit(prepared.path, "ls-remote", "origin", prepared.branch),
    ).toBe("");
  });

  test("rejects a worktree replacement between staging and its identity reread", async () => {
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
    let replaced = false;
    const racingGit = async (cwd: string, args: readonly string[]) => {
      const output = await realGit(cwd, args);
      if (!replaced && args[0] === "add") {
        replaced = true;
        await rm(prepared.path, { recursive: true, force: true });
        await symlink(repositoryRoot, prepared.path);
      }
      return output;
    };

    await expect(
      commitAndPushRunWorktree({
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
        git: racingGit,
      }),
    ).rejects.toThrow(/symbolic|worktree|boundary/u);
  });

  test("ignores inherited Git directory and index overrides during publication", async () => {
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
    await writeFile(join(prepared.path, "README.md"), "safe-env\n", "utf8");
    const alternateIndex = join(repositoryRoot, "outside-index");
    const previousGitDir = process.env.GIT_DIR;
    const previousGitIndex = process.env.GIT_INDEX_FILE;
    let publishedHead = "";
    process.env.GIT_DIR = repositoryRoot;
    process.env.GIT_INDEX_FILE = alternateIndex;
    try {
      const receipt = await commitAndPushRunWorktree({
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
      publishedHead = receipt.headSha;
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
      if (previousGitIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previousGitIndex;
    }
    expect(publishedHead).toMatch(/^[0-9a-f]{40}$/u);
    expect(publishedHead).not.toBe(prepared.baseSha);
    expect(await runGit(prepared.path, "status", "--porcelain")).toBe("");
  });

  test("suppresses repository hooks during commit and push", async () => {
    const { repositoryRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const hooksRoot = join(repositoryRoot, "failing-hooks");
    await mkdir(hooksRoot, { mode: 0o700 });
    for (const hook of [
      "pre-commit",
      "commit-msg",
      "post-commit",
      "pre-push",
    ]) {
      const hookPath = join(hooksRoot, hook);
      await writeFile(hookPath, "#!/bin/sh\nexit 97\n", "utf8");
      await chmod(hookPath, 0o700);
    }
    await runGit(repositoryRoot, "config", "core.hooksPath", hooksRoot);
    const prepared = await prepareRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      baseBranch: "main",
      git: realGit,
    });
    await writeFile(join(prepared.path, "README.md"), "hook-safe\n", "utf8");

    const receipt = await commitAndPushRunWorktree({
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

    expect(receipt.headSha).not.toBe(prepared.baseSha);
    expect(
      await runGit(prepared.path, "ls-remote", "origin", prepared.branch),
    ).toBe(`${receipt.headSha}\trefs/heads/${prepared.branch}`);
  });

  test("fails closed when the ticket branch push is not fast-forwardable", async () => {
    const { repositoryRoot, remoteRoot } = await temporaryGitRepository();
    const workspaceRoot = join(repositoryRoot, ".wheelsparrow", "workspaces");
    const prepared = await prepareRunWorktree({
      repositoryRoot,
      workspaceRoot,
      runId: "run-7",
      issueNumber: 42,
      baseBranch: "main",
      git: realGit,
    });

    const foreignRoot = await mkdtemp(
      join(tmpdir(), "wheelsparrow-push-race-"),
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
    await runGit(
      foreignRepositoryRoot,
      "config",
      "user.email",
      "test@example.com",
    );
    await runGit(foreignRepositoryRoot, "config", "user.name", "Test User");
    await runGit(foreignRepositoryRoot, "checkout", "-b", prepared.branch);
    await writeFile(
      join(foreignRepositoryRoot, "remote.txt"),
      "remote\n",
      "utf8",
    );
    await runGit(foreignRepositoryRoot, "add", "remote.txt");
    await runGit(foreignRepositoryRoot, "commit", "-m", "remote branch commit");
    await runGit(foreignRepositoryRoot, "push", "origin", prepared.branch);

    await writeFile(join(prepared.path, "README.md"), "local\n", "utf8");
    await expect(
      commitAndPushRunWorktree({
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
    ).rejects.toBeInstanceOf(WorktreeBoundaryError);
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
