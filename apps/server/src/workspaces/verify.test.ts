import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
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

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`expected ${path} to be written before timeout`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
    const resultPromise = runVerification(
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
        1_000,
      ),
    );
    await waitForFile(descendantPidPath);
    const result = await resultPromise;

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

  test("does not pass authority-bearing credentials to verification", async () => {
    const { root, worktree } = await temporaryWorktree();
    const credentialNames = [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_PAT",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "CLOUDSDK_AUTH_ACCESS_TOKEN",
      "AZURE_CLIENT_SECRET",
    ] as const;
    const previous = new Map<string, string | undefined>();
    for (const name of credentialNames) {
      previous.set(name, process.env[name]);
      process.env[name] = `sentinel-${name.toLowerCase()}`;
    }

    try {
      const result = await runVerification(
        invocation(
          [
            process.execPath,
            "-e",
            `
              const fs = require("node:fs");
              const forbidden = ${JSON.stringify(credentialNames)}.filter(
                (name) => process.env[name] !== undefined,
              );
              fs.writeFileSync(process.argv[1], forbidden.length === 0 ? "safe environment" : forbidden.join(","));
            `,
            join(root, "verification-env.txt"),
          ],
          worktree,
          join(root, "workspace"),
        ),
      );

      expect(result).toMatchObject({
        kind: "succeeded",
      });
      expect(await readFile(join(root, "verification-env.txt"), "utf8")).toBe(
        "safe environment",
      );
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("accepts the configured make command as argv and rejects shell syntax", async () => {
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

    const configured = await runVerification(
      invocation("make verify-agent", worktree, join(root, "workspace")),
    );
    expect(configured.command).toEqual(["make", "verify-agent"]);

    await expect(
      runVerification(
        invocation(
          "make verify-agent && touch unsafe",
          worktree,
          join(root, "workspace"),
        ),
      ),
    ).rejects.toThrow(/command|shell/u);

    const linked = join(root, "linked-worktree");
    await symlink(worktree, linked, "junction");
    await expect(
      runVerification(
        invocation(
          [process.execPath, "-e", ""],
          linked,
          join(root, "workspace"),
        ),
      ),
    ).rejects.toThrow(/symbolic link|worktree/u);
  });
});
