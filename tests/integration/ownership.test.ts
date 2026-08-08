import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import {
  acquireOwnership,
  OwnershipConflictError,
} from "../../apps/server/src/database/ownership.js";

const childFixture = fileURLToPath(
  new URL("../fixtures/ownership-holder.ts", import.meta.url),
);
const temporaryDirectories: string[] = [];
const children = new Set<ChildProcess>();
const readyTimeoutMs = 5_000;
const exitTimeoutMs = 5_000;

async function createLockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-ownership-"));
  temporaryDirectories.push(directory);
  return join(directory, "wheelsparrow.lock");
}

function waitForOutput(
  child: ChildProcess,
  output: "READY" | "RELEASED",
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let collected = "";
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `ownership child did not emit ${output} within ${timeoutMs}ms; child stdout may be suppressed by the managed sandbox`,
        ),
      );
    }, timeoutMs);

    const finish = (callback: () => void): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    };
    const onData = (chunk: Buffer): void => {
      collected += chunk.toString();
      if (collected.includes(`${output}\n`)) finish(resolve);
    };
    const onError = (error: Error): void => finish(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(() =>
        reject(
          new Error(
            `ownership child exited before ${output} (code=${code}, signal=${signal})`,
          ),
        ),
      );

    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(
  child: ChildProcess,
  timeoutMs = exitTimeoutMs,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(new Error(`ownership child did not exit within ${timeoutMs}ms`)),
      timeoutMs,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  await waitForExit(child);
  children.delete(child);
}

async function startHolder(lockPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", childFixture, lockPath],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.add(child);
  await waitForOutput(child, "READY", readyTimeoutMs);
  return child;
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite storage ownership", () => {
  test("acquires a lock and releases it", async () => {
    const lockPath = await createLockPath();
    const ownership = await acquireOwnership(lockPath);

    if (process.platform !== "win32") {
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    }

    await ownership.release();
  });

  test("uses a private existing-or-created regular lock file without truncating or recreating it", async () => {
    const lockPath = await createLockPath();
    const contents = "do not truncate";
    await writeFile(lockPath, contents, { mode: 0o600 });
    const before = await stat(lockPath);

    const ownership = await acquireOwnership(lockPath);
    const after = await stat(lockPath);

    expect(await readFile(lockPath, "utf8")).toBe(contents);
    expect(after.ino).toBe(before.ino);
    if (process.platform !== "win32") expect(after.mode & 0o777).toBe(0o600);

    await ownership.release();
  });

  test("rejects a directory lock path as a hard error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-ownership-"));
    temporaryDirectories.push(directory);

    await expect(acquireOwnership(directory)).rejects.not.toBeInstanceOf(
      OwnershipConflictError,
    );
  });

  test("rejects a symbolic-link lock path as a hard error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-ownership-"));
    temporaryDirectories.push(directory);
    const targetPath = join(directory, "target");
    const symlinkPath = join(directory, "symlink");
    await writeFile(targetPath, "target", { mode: 0o600 });
    await symlink(targetPath, symlinkPath);

    await expect(acquireOwnership(symlinkPath)).rejects.not.toBeInstanceOf(
      OwnershipConflictError,
    );
  });

  test("reports a typed conflict when another process holds the lock", async () => {
    const lockPath = await createLockPath();
    await startHolder(lockPath);

    await expect(acquireOwnership(lockPath)).rejects.toBeInstanceOf(
      OwnershipConflictError,
    );
  });

  test("permits a successor after normal release", async () => {
    const lockPath = await createLockPath();
    const child = await startHolder(lockPath);

    child.stdin?.write("release\n");
    await waitForOutput(child, "RELEASED", exitTimeoutMs);
    await waitForExit(child);
    children.delete(child);

    const successor = await acquireOwnership(lockPath);
    await successor.release();
  });

  test("permits an immediate successor after a holder is SIGKILLed", async () => {
    const lockPath = await createLockPath();
    const child = await startHolder(lockPath);

    child.kill("SIGKILL");
    await waitForExit(child);
    children.delete(child);

    const successor = await acquireOwnership(lockPath);
    await successor.release();
  });

  test("makes release idempotent", async () => {
    const ownership = await acquireOwnership(await createLockPath());

    await ownership.release();
    await expect(ownership.release()).resolves.toBeUndefined();
  });
});
