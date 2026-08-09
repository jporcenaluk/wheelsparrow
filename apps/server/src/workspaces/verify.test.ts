import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { runVerification, type VerificationInvocation } from "./verify.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

async function temporaryWorktree(): Promise<{
  root: string;
  worktree: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "wheelsparrow-verify-"));
  temporaryDirectories.push(root);
  const worktree = join(root, "workspace", "run-7");
  await mkdir(worktree, { recursive: true });
  return { root, worktree };
}

function invocation(
  command: readonly string[] | string,
  worktreePath: string,
  workspaceRoot: string,
  timeoutMs = 1_000,
): VerificationInvocation {
  return {
    command,
    worktreePath,
    workspaceRoot,
    timeoutMs,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("contained verification process", () => {
  test("runs the configured executable with explicit args and cwd", async () => {
    const { root, worktree } = await temporaryWorktree();
    const outputPath = join(root, "result.json");
    const result = await runVerification(
      invocation(
        [
          process.execPath,
          "-e",
          `
            const fs = require("node:fs");
            fs.writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
          `,
          outputPath,
          "fixed-arg",
        ],
        worktree,
        join(root, "workspace"),
      ),
    );

    expect(result).toMatchObject({
      kind: "succeeded",
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
    });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({
      cwd: worktree,
      args: ["fixed-arg"],
    });
  });

  test("classifies a nonzero exit with its exit code and output", async () => {
    const { root, worktree } = await temporaryWorktree();
    const result = await runVerification(
      invocation(
        [
          process.execPath,
          "-e",
          'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7;',
        ],
        worktree,
        join(root, "workspace"),
      ),
    );

    expect(result).toMatchObject({
      kind: "failed",
      reason: "nonzero_exit",
      exitCode: 7,
      signal: null,
      stdout: "out",
      stderr: "err",
    });
  });

  test("classifies a spawn error without throwing", async () => {
    const { root, worktree } = await temporaryWorktree();
    const result = await runVerification(
      invocation(
        ["/definitely/missing/wheelsparrow-verification"],
        worktree,
        join(root, "workspace"),
      ),
    );

    expect(result).toMatchObject({ kind: "failed", reason: "spawn_error" });
    if (result.kind !== "failed") return;
    expect(result.error).toBeTruthy();
  });

  test("times out and terminates a process tree", async () => {
    const { root, worktree } = await temporaryWorktree();
    const descendantPidPath = join(root, "descendant.pid");
    const result = await runVerification(
      invocation(
        [
          process.execPath,
          "-e",
          `
            const fs = require("node:fs");
            const { spawn } = require("node:child_process");
            const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
            fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
            setInterval(() => {}, 1000);
          `,
        ],
        worktree,
        join(root, "workspace"),
        100,
      ),
    );

    expect(result).toMatchObject({ kind: "failed", reason: "timeout" });
    expect(result.stdout.length).toBeLessThanOrEqual(16_384);
    if (process.platform !== "win32") {
      const { stdout: descendantPid } = await execFile("cat", [
        descendantPidPath,
      ]);
      await expect(
        execFile(process.execPath, [
          "-e",
          `process.kill(${Number(descendantPid.trim())}, 0)`,
        ]),
      ).rejects.toBeTruthy();
    }
  });

  test("redacts secrets and bounds captured output", async () => {
    const { root, worktree } = await temporaryWorktree();
    const result = await runVerification(
      invocation(
        [
          process.execPath,
          "-e",
          `
            process.stdout.write("token=ghp_this-must-not-escape gho_standalone\\n" + "x".repeat(100_000));
            process.stderr.write("Bearer secret-value ghs_standalone\\n" + "y".repeat(100_000));
          `,
        ],
        worktree,
        join(root, "workspace"),
      ),
    );

    expect(result.kind).toBe("succeeded");
    expect(result.stdout).not.toContain("ghp_this-must-not-escape");
    expect(result.stdout).not.toContain("gho_standalone");
    expect(result.stderr).not.toContain("secret-value");
    expect(result.stderr).not.toContain("ghs_standalone");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(
      16_384,
    );
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(
      16_384,
    );
  });

  test("rejects an unsafe worktree and shell-like command string", async () => {
    const { root, worktree } = await temporaryWorktree();
    const outside = await mkdtemp(join(tmpdir(), "wheelsparrow-outside-"));
    temporaryDirectories.push(outside);

    await expect(
      runVerification(
        invocation(
          [process.execPath, "-e", ""],
          outside,
          join(root, "workspace"),
        ),
      ),
    ).rejects.toThrow(/worktree|workspace/u);

    await expect(
      runVerification(
        invocation("node fixture.js", worktree, join(root, "workspace")),
      ),
    ).rejects.toThrow(/command|shell/u);
  });
});
