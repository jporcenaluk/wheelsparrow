import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packagedEntryPoint = (packageDirectory) =>
  join(packageDirectory, "dist", "index.js");

/**
 * Build only source checkouts. A packed production artifact already contains
 * dist, while a workspace checkout needs the existing package build command.
 */
export function preparePackage({
  packageDirectory = dirname(fileURLToPath(import.meta.url)),
  packageManagerPath = process.env.npm_execpath,
  pathExists = existsSync,
  run = spawnSync,
} = {}) {
  const entryPoint = packagedEntryPoint(packageDirectory);
  if (pathExists(entryPoint)) {
    return;
  }

  if (!packageManagerPath) {
    throw new Error(
      "Cannot build contracts: the package manager path is unavailable.",
    );
  }

  const result = run(process.execPath, [packageManagerPath, "run", "build"], {
    cwd: packageDirectory,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(
      `Contracts build was terminated by signal ${result.signal}.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Contracts build failed with exit status ${result.status ?? "unknown"}.`,
    );
  }
  if (!pathExists(entryPoint)) {
    throw new Error("Contracts build completed without dist/index.js.");
  }
}

if (import.meta.main) {
  preparePackage();
}
