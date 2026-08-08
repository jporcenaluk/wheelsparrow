import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

// The lifecycle helper intentionally remains plain Node ESM so production installs
// do not depend on TypeScript tooling.
// @ts-expect-error This JavaScript lifecycle helper has no declaration file.
import { preparePackage } from "./prepare.mjs";

const temporaryDirectories: string[] = [];
const helperPath = fileURLToPath(new URL("./prepare.mjs", import.meta.url));

async function makePackageDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "wheelsparrow-contracts-prepare-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("preparePackage", () => {
  test("does not run the lifecycle when imported from an unbuilt package", async () => {
    const packageDirectory = await makePackageDirectory();
    const copiedHelperPath = join(packageDirectory, "prepare.mjs");
    copyFileSync(helperPath, copiedHelperPath);

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "await import(process.argv[1]);",
        copiedHelperPath,
      ],
      {
        cwd: packageDirectory,
        env: { ...process.env, npm_execpath: "" },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(join(packageDirectory, "dist", "index.js"))).toBe(false);
  });

  test("does not build an already packaged contract artifact", async () => {
    const packageDirectory = await makePackageDirectory();
    mkdirSync(join(packageDirectory, "dist"));
    writeFileSync(join(packageDirectory, "dist", "index.js"), "export {};\n");
    const run = vi.fn();

    preparePackage({ packageDirectory, run });

    expect(run).not.toHaveBeenCalled();
  });

  test("builds a source checkout and requires its compiled entry point", async () => {
    const packageDirectory = await makePackageDirectory();
    const run = vi.fn(
      (command: string, args: string[], options: { cwd: string }) => {
        expect(command).toBe(process.execPath);
        expect(args).toEqual(["/tmp/pnpm.cjs", "run", "build"]);
        expect(options.cwd).toBe(packageDirectory);
        mkdirSync(join(packageDirectory, "dist"));
        writeFileSync(
          join(packageDirectory, "dist", "index.js"),
          "export {};\n",
        );
        return { status: 0 };
      },
    );

    preparePackage({
      packageDirectory,
      packageManagerPath: "/tmp/pnpm.cjs",
      run,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(join(packageDirectory, "dist", "index.js"))).toBe(true);
  });

  test("propagates a package-manager spawn error", async () => {
    const packageDirectory = await makePackageDirectory();
    const spawnError = new Error("pnpm was not found");

    expect(() =>
      preparePackage({
        packageDirectory,
        packageManagerPath: "/tmp/pnpm.cjs",
        run: () => ({ error: spawnError, status: null }),
      }),
    ).toThrow(spawnError);
  });

  test("requires the current package manager for an unbuilt source checkout", async () => {
    const packageDirectory = await makePackageDirectory();
    vi.stubEnv("npm_execpath", "");

    try {
      expect(() => preparePackage({ packageDirectory })).toThrow(
        "package manager path is unavailable",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("rejects a nonzero package-manager build", async () => {
    const packageDirectory = await makePackageDirectory();

    expect(() =>
      preparePackage({
        packageDirectory,
        packageManagerPath: "/tmp/pnpm.cjs",
        run: () => ({ status: 17 }),
      }),
    ).toThrow("exit status 17");
  });

  test("reports a package-manager process terminated by a signal", async () => {
    const packageDirectory = await makePackageDirectory();

    expect(() =>
      preparePackage({
        packageDirectory,
        packageManagerPath: "/tmp/pnpm.cjs",
        run: () => ({ signal: "SIGTERM", status: null }),
      }),
    ).toThrow("terminated by signal SIGTERM");
  });

  test("rejects a successful build that does not create the compiled entry point", async () => {
    const packageDirectory = await makePackageDirectory();

    expect(() =>
      preparePackage({
        packageDirectory,
        packageManagerPath: "/tmp/pnpm.cjs",
        run: () => ({ status: 0 }),
      }),
    ).toThrow("completed without dist/index.js");
  });
});
