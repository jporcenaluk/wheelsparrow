import { type ChildProcess, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  evaluatePreflight,
  formatCheck,
  runCommand,
  terminateProcessTree,
} from "./preflight.js";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wheelsparrow-preflight-"));
  temporaryDirectories.push(root);
  return root;
}

async function writePins(
  root: string,
  nodeVersion = "24.18.0",
  pnpmVersion = "11.15.1",
): Promise<void> {
  await Promise.all([
    writeFile(join(root, ".node-version"), `${nodeVersion}\n`, "utf8"),
    writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: `pnpm@${pnpmVersion}` }),
      "utf8",
    ),
  ]);
}

async function successfulRun(command: string): Promise<{
  ok: boolean;
  detail: string;
}> {
  if (command === "node") return { ok: true, detail: "v24.18.0" };
  if (command === "corepack") return { ok: true, detail: "11.15.1" };
  return { ok: true, detail: "available" };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processExists(pid)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  return !processExists(pid);
}

async function waitForPidFile(file: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number(await readFile(file, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("timed out waiting for detached process fixture readiness");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("evaluatePreflight", () => {
  test("keeps malformed configuration values out of check details and output", async () => {
    const root = await temporaryRoot();
    const sentinelSecret = "SENTINEL_PREFLIGHT_SECRET_b952";
    await writeFile(
      join(root, "wheelsparrow.yaml"),
      `github: [${sentinelSecret}`,
      "utf8",
    );

    const result = await evaluatePreflight({
      root,
      run: async () => ({ ok: false, detail: "unavailable" }),
    });
    const configurationCheck = result.checks.find(
      ({ name }) => name === "configuration",
    );

    expect(configurationCheck).toBeDefined();
    expect(configurationCheck?.detail).not.toContain(sentinelSecret);
    expect(configurationCheck?.detail).toContain("YAMLParseError");
    if (configurationCheck === undefined) throw new Error("missing check");
    expect(formatCheck(configurationCheck)).not.toContain(sentinelSecret);
  });

  test("reports all seven ordered failures when commands and configuration fail", async () => {
    const root = await temporaryRoot();
    const calls: Array<[string, string[]]> = [];
    const result = await evaluatePreflight({
      root,
      run: async (command, args) => {
        calls.push([command, args]);
        return { ok: false, detail: "unavailable" };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.checks.map(({ name }) => name)).toEqual([
      "node",
      "pnpm",
      "git",
      "github-auth",
      "codex-auth",
      "configuration",
      "workspace-root",
    ]);
    expect(result.checks.every(({ ok }) => !ok)).toBe(true);
    expect(result.checks.at(-1)?.detail).toBe("configuration unavailable");
    expect(calls).toEqual([
      ["node", ["--version"]],
      ["corepack", ["pnpm", "--version"]],
      ["git", ["--version"]],
      ["gh", ["auth", "status"]],
      ["codex", ["login", "status"]],
    ]);
  });

  test("validates configuration and creates an accessible private workspace", async () => {
    const root = await temporaryRoot();
    await writePins(root);
    await writeFile(
      join(root, "wheelsparrow.yaml"),
      `github:\n  owner: jporcenaluk\n  repository: wheelsparrow\n  project_number: 2\n  status_field: Status\n  lanes:\n    ready: Ready\n    todo: Todo\n    review: Review\n    done: Done\n  required_labels: [mvp]\n  priority_field: Priority\npoll_interval_seconds: 30\nworkspace_root: .wheelsparrow/workspaces\nagent:\n  command: codex\n  model: gpt-5.6-sol\n  reasoning_effort: high\n  timeout_minutes: 45\nverification:\n  command: make verify-agent\nstaging:\n  workflow: deploy-staging.yml\n  environment: staging\n  smoke_command: make smoke-staging\n`,
      "utf8",
    );

    const result = await evaluatePreflight({
      root,
      run: successfulRun,
    });

    const workspace = join(root, ".wheelsparrow/workspaces");
    expect(result.ok).toBe(true);
    expect(result.checks.at(-1)).toEqual({
      name: "workspace-root",
      ok: true,
      detail: workspace,
    });
    expect((await stat(workspace)).mode & 0o777).toBe(0o700);
  });

  test("validates the repository-owned configuration when an override is set", async () => {
    const root = await temporaryRoot();
    const externalRoot = await temporaryRoot();
    await writePins(root);
    await writeFile(
      join(root, "wheelsparrow.yaml"),
      await readFile(join(import.meta.dirname, "../wheelsparrow.yaml"), "utf8"),
      "utf8",
    );
    const externalConfiguration = join(externalRoot, "wheelsparrow.yaml");
    await writeFile(externalConfiguration, "github: [invalid", "utf8");
    const previousConfiguration = process.env.WHEELSPARROW_CONFIG;

    try {
      process.env.WHEELSPARROW_CONFIG = externalConfiguration;
      const result = await evaluatePreflight({ root, run: successfulRun });

      expect(
        result.checks.find(({ name }) => name === "configuration"),
      ).toEqual({
        name: "configuration",
        ok: true,
        detail: join(root, "wheelsparrow.yaml"),
      });
    } finally {
      if (previousConfiguration === undefined) {
        delete process.env.WHEELSPARROW_CONFIG;
      } else {
        process.env.WHEELSPARROW_CONFIG = previousConfiguration;
      }
    }
  });

  test("secures an existing workspace before reporting success", async () => {
    const root = await temporaryRoot();
    await writePins(root);
    await writeFile(
      join(root, "wheelsparrow.yaml"),
      await readFile(join(import.meta.dirname, "../wheelsparrow.yaml"), "utf8"),
      "utf8",
    );
    const workspace = join(root, ".wheelsparrow/workspaces");
    await mkdir(workspace, { recursive: true });
    await chmod(workspace, 0o755);

    const result = await evaluatePreflight({
      root,
      run: successfulRun,
    });

    expect(result.checks.at(-1)?.ok).toBe(true);
    expect((await stat(workspace)).mode & 0o777).toBe(0o700);
  });

  test("aggregates a single command failure without skipping later checks", async () => {
    const root = await temporaryRoot();
    await writePins(root);
    await writeFile(
      join(root, "wheelsparrow.yaml"),
      await readFile(join(import.meta.dirname, "../wheelsparrow.yaml"), "utf8"),
      "utf8",
    );
    await chmod(root, 0o700);

    const result = await evaluatePreflight({
      root,
      run: async (command) => {
        const result = await successfulRun(command);
        return command === "git" ? { ok: false, detail: command } : result;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.checks.find(({ name }) => name === "git")?.ok).toBe(false);
    expect(
      result.checks.find(({ name }) => name === "workspace-root")?.ok,
    ).toBe(true);
  });

  test("diagnoses Node and pnpm versions that differ from repository pins", async () => {
    const root = await temporaryRoot();
    await writePins(root);

    const result = await evaluatePreflight({
      root,
      run: async (command) => {
        if (command === "node") return { ok: true, detail: "v24.14.1" };
        if (command === "corepack") return { ok: true, detail: "11.14.0" };
        return { ok: false, detail: "unavailable" };
      },
    });

    expect(result.checks[0]).toEqual({
      name: "node",
      ok: false,
      detail: "version mismatch: expected 24.18.0, received 24.14.1",
    });
    expect(result.checks[1]).toEqual({
      name: "pnpm",
      ok: false,
      detail: "version mismatch: expected 11.15.1, received 11.14.0",
    });
  });

  test("fails successful version commands when repository pins are unavailable", async () => {
    const root = await temporaryRoot();

    const result = await evaluatePreflight({ root, run: successfulRun });

    expect(result.checks[0]).toMatchObject({ name: "node", ok: false });
    expect(result.checks[0]?.detail).toContain(".node-version");
    expect(result.checks[1]).toMatchObject({ name: "pnpm", ok: false });
    expect(result.checks[1]?.detail).toContain("package.json");
  });

  test("fails malformed repository version pins", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, ".node-version"), "latest\n", "utf8");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "npm@11.0.0" }),
      "utf8",
    );

    const result = await evaluatePreflight({ root, run: successfulRun });

    expect(result.checks[0]).toEqual({
      name: "node",
      ok: false,
      detail: "invalid .node-version pin",
    });
    expect(result.checks[1]).toEqual({
      name: "pnpm",
      ok: false,
      detail: "invalid packageManager pin",
    });
  });

  test.each([
    ["absolute", "/tmp/wheelsparrow-outside"],
    ["traversal", "../wheelsparrow-outside"],
  ])(
    "fails closed for an %s configured workspace",
    async (_, workspaceRoot) => {
      const root = await temporaryRoot();
      await writePins(root);
      const configuration = (
        await readFile(
          join(import.meta.dirname, "../wheelsparrow.yaml"),
          "utf8",
        )
      ).replace(
        "workspace_root: .wheelsparrow/workspaces",
        `workspace_root: ${workspaceRoot}`,
      );
      await writeFile(join(root, "wheelsparrow.yaml"), configuration, "utf8");

      const result = await evaluatePreflight({ root, run: successfulRun });

      expect(
        result.checks.find(({ name }) => name === "configuration"),
      ).toMatchObject({ ok: false });
      expect(result.checks.at(-1)).toEqual({
        name: "workspace-root",
        ok: false,
        detail: "configuration unavailable",
      });
    },
  );

  test("rejects an existing workspace symlink without touching its target", async () => {
    const root = await temporaryRoot();
    const external = await temporaryRoot();
    await writePins(root);
    await writeFile(
      join(root, "wheelsparrow.yaml"),
      await readFile(join(import.meta.dirname, "../wheelsparrow.yaml"), "utf8"),
      "utf8",
    );
    await chmod(external, 0o755);
    await writeFile(join(external, "sentinel.txt"), "untouched", "utf8");
    await mkdir(join(root, ".wheelsparrow"));
    await symlink(external, join(root, ".wheelsparrow/workspaces"));

    const result = await evaluatePreflight({ root, run: successfulRun });

    expect(result.checks.at(-1)).toEqual({
      name: "workspace-root",
      ok: false,
      detail: "workspace path contains a symbolic link",
    });
    expect((await stat(external)).mode & 0o777).toBe(0o755);
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(
      "untouched",
    );
  });
});

describe("runCommand", () => {
  test("combines bounded stdout and stderr without using a shell", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err')",
    ]);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("out");
    expect(result.detail).toContain("err");
  });

  test("returns spawn errors instead of throwing", async () => {
    await expect(
      runCommand("wheelsparrow-command-that-does-not-exist", []),
    ).resolves.toMatchObject({ ok: false });
  });

  test("marks diagnostics truncated at the output ceiling", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(20_000))",
    ]);

    expect(Buffer.byteLength(result.detail, "utf8")).toBeLessThanOrEqual(8192);
    expect(result.detail).toContain("truncated");
  });

  test("bounds multibyte diagnostics without splitting UTF-8", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('😀'.repeat(5_000))",
    ]);

    expect(Buffer.byteLength(result.detail, "utf8")).toBeLessThanOrEqual(8192);
    expect(result.detail).toContain("[diagnostic truncated]");
    expect(result.detail).not.toContain("�");
  });

  test("redacts captured standard credential diagnostics", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('Bearer sentinel-bearer\\nauthorization: sentinel-auth\\naccess-token=sentinel-access\\napi-key: sentinel-api\\ntoken=sentinel-token')",
    ]);

    expect(result.detail).toContain("Bearer [REDACTED]");
    expect(result.detail).toContain("authorization: [REDACTED]");
    expect(result.detail).toContain("access-token=[REDACTED]");
    expect(result.detail).toContain("api-key: [REDACTED]");
    expect(result.detail).toContain("token=[REDACTED]");
    expect(result.detail).not.toContain("sentinel-");
    expect(Buffer.byteLength(result.detail, "utf8")).toBeLessThanOrEqual(8192);
  });

  test("redacts a multi-part authorization value without swallowing the next line", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('authorization: Basic c2VjcmV0 trailing-fragment\\nstatus: failed')",
    ]);

    expect(result.detail).toBe("authorization: [REDACTED]\nstatus: failed");
    expect(result.detail).not.toContain("Basic");
    expect(result.detail).not.toContain("c2VjcmV0");
    expect(result.detail).not.toContain("trailing-fragment");
    expect(Buffer.byteLength(result.detail, "utf8")).toBeLessThanOrEqual(8192);
  });

  test("redacts namespaced token and API key diagnostics", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('GH_TOKEN=sentinel-gh\\nGITHUB_TOKEN: sentinel-github\\nOPENAI_API_KEY=sentinel-openai')",
    ]);

    expect(result.detail).toContain("GH_TOKEN=[REDACTED]");
    expect(result.detail).toContain("GITHUB_TOKEN: [REDACTED]");
    expect(result.detail).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(result.detail).not.toContain("sentinel-");
    expect(Buffer.byteLength(result.detail, "utf8")).toBeLessThanOrEqual(8192);
  });

  test("formatCheck redacts namespaced credential values", () => {
    const output = formatCheck({
      name: "github-auth",
      ok: false,
      detail:
        "GH_TOKEN=sentinel-gh GITHUB_TOKEN=sentinel-github OPENAI_API_KEY=sentinel-openai",
    });

    expect(output).toContain("GH_TOKEN=[REDACTED]");
    expect(output).toContain("GITHUB_TOKEN=[REDACTED]");
    expect(output).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(output).not.toContain("sentinel-");
  });

  test("reports a hanging command timeout promptly", async () => {
    const startedAt = Date.now();
    const result = await runCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      { timeoutMs: 150 },
    );

    expect(result).toEqual({ ok: false, detail: "timed out after 150ms" });
    expect(Date.now() - startedAt).toBeLessThan(700);
  });

  test.skipIf(process.platform === "win32")(
    "times out a ready process group through runCommand",
    async () => {
      const root = await temporaryRoot();
      const pidFile = join(root, "descendant.pid");
      const script = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'],",
        "  { stdio: ['ignore', process.stdout, process.stderr] });",
        "writeFileSync(process.argv[1], String(child.pid));",
        "setTimeout(() => {}, 10000);",
      ].join("\n");
      const startedAt = Date.now();
      const resultPromise = runCommand(
        process.execPath,
        ["-e", script, pidFile],
        { timeoutMs: 2000 },
      );
      let descendantPid: number | undefined;

      try {
        descendantPid = await waitForPidFile(pidFile);
        const result = await resultPromise;

        expect(result).toEqual({ ok: false, detail: "timed out after 2000ms" });
        expect(Date.now() - startedAt).toBeLessThan(2700);
        expect(await waitForProcessExit(descendantPid)).toBe(true);
      } finally {
        if (descendantPid !== undefined && processExists(descendantPid)) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The timeout may have won the race with this cleanup.
          }
        }
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "terminates a ready detached process group",
    async () => {
      expect(terminateProcessTree).toBeTypeOf("function");
      if (typeof terminateProcessTree !== "function") return;

      const root = await temporaryRoot();
      const pidFile = join(root, "descendant.pid");
      const script = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });",
        "writeFileSync(process.argv[1], String(child.pid));",
        "setTimeout(() => {}, 10000);",
      ].join("\n");
      const leader = spawn(process.execPath, ["-e", script, pidFile], {
        detached: true,
        stdio: "ignore",
      });
      const leaderPid = leader.pid;
      if (leaderPid === undefined) {
        throw new Error("detached process fixture did not start");
      }
      let descendantPid: number | undefined;

      try {
        descendantPid = await waitForPidFile(pidFile);
        terminateProcessTree(leader);

        expect(await waitForProcessExit(leaderPid)).toBe(true);
        expect(await waitForProcessExit(descendantPid)).toBe(true);
        expect(() => terminateProcessTree(leader)).not.toThrow();
      } finally {
        terminateProcessTree(leader);
        if (descendantPid !== undefined && processExists(descendantPid)) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The group cleanup may have won the race with this cleanup.
          }
        }
      }
    },
  );

  test("uses direct child termination on Windows", () => {
    expect(terminateProcessTree).toBeTypeOf("function");
    if (typeof terminateProcessTree !== "function") return;
    const kill = vi.fn(() => true);
    const child = { pid: 1234, kill } as unknown as ChildProcess;

    terminateProcessTree(child, "win32");

    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  test.skipIf(process.platform === "win32")(
    "does not let cleanup errors replace the caller result",
    () => {
      expect(terminateProcessTree).toBeTypeOf("function");
      if (typeof terminateProcessTree !== "function") return;
      const groupKill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("group cleanup failed");
      });
      const kill = vi.fn(() => {
        throw new Error("fallback cleanup failed");
      });
      const child = { pid: 1234, kill } as unknown as ChildProcess;

      expect(() => terminateProcessTree(child, "linux")).not.toThrow();
      expect(groupKill).toHaveBeenCalledExactlyOnceWith(-1234, "SIGKILL");
      expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    },
  );
});
