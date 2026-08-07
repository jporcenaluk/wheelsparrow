import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exactVersionPattern = /^\d+\.\d+\.\d+$/;

function assertExactVersion(version, source) {
  if (!exactVersionPattern.test(version)) {
    throw new Error(`${source} must contain an exact semantic version`);
  }
  return version;
}

export function evaluateToolchainVersions(expected, actual) {
  const diagnostics = [];
  if (actual.node !== expected.node) {
    diagnostics.push(
      `Node version mismatch: expected ${expected.node}, received ${actual.node}`,
    );
  }
  if (actual.pnpm !== expected.pnpm) {
    diagnostics.push(
      `pnpm version mismatch: expected ${expected.pnpm}, received ${actual.pnpm}`,
    );
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export function parsePnpmVersion(userAgent) {
  const version = /^pnpm\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(userAgent ?? "")?.[1];
  if (version === undefined) {
    throw new Error("unable to determine the invoking pnpm version");
  }
  return version;
}

export function readToolchainPins(root) {
  let nodePin;
  try {
    nodePin = readFileSync(resolve(root, ".node-version"), "utf8").trim();
  } catch {
    throw new Error("unable to read .node-version");
  }

  let packageManager;
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    );
    packageManager = manifest.packageManager;
  } catch {
    throw new Error("unable to read packageManager from package.json");
  }
  if (typeof packageManager !== "string") {
    throw new Error(
      "packageManager must pin pnpm to an exact semantic version",
    );
  }
  const pnpmMatch = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageManager);
  if (pnpmMatch?.[1] === undefined) {
    throw new Error(
      "packageManager must pin pnpm to an exact semantic version",
    );
  }

  return {
    node: assertExactVersion(nodePin, ".node-version"),
    pnpm: assertExactVersion(pnpmMatch[1], "packageManager"),
  };
}

export function readActualToolchainVersions() {
  return {
    node: assertExactVersion(process.versions.node, "Node runtime"),
    pnpm: parsePnpmVersion(process.env.npm_config_user_agent),
  };
}

export function verifyCurrentToolchain(
  root = resolve(import.meta.dirname, ".."),
) {
  return evaluateToolchainVersions(
    readToolchainPins(root),
    readActualToolchainVersions(),
  );
}

function run() {
  try {
    const result = verifyCurrentToolchain();
    if (!result.ok) {
      for (const diagnostic of result.diagnostics) console.error(diagnostic);
      process.exitCode = 1;
      return;
    }
    console.log("Toolchain versions match the repository pins.");
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "toolchain verification failed",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run();
}
