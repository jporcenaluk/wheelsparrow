import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");

const requiredPaths = [
  ".node-version",
  "Makefile",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
];

const forbiddenPaths = [
  "packages/domain",
  "packages/orchestration",
  "packages/persistence",
  "packages/adapters",
  "packages/observability",
  "packages/test-support",
];

describe("repository policy", () => {
  test("requires the foundation paths and excludes deferred package boundaries", () => {
    const missingPaths = requiredPaths.filter(
      (path) => !existsSync(resolve(root, path)),
    );
    const presentForbiddenPaths = forbiddenPaths.filter((path) =>
      existsSync(resolve(root, path)),
    );

    expect(missingPaths).toEqual([]);
    expect(presentForbiddenPaths).toEqual([]);
  });

  test("pins the Node and pnpm toolchain", () => {
    const nodeVersion = readFileSync(
      resolve(root, ".node-version"),
      "utf8",
    ).trim();
    const packageJson = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    ) as {
      packageManager?: string;
    };

    expect(nodeVersion).toBe("24.18.0");
    expect(packageJson.packageManager).toBe("pnpm@11.15.1");
  });

  test("keeps Node type declarations on the pinned runtime major", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    ) as {
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.devDependencies?.["@types/node"]).toMatch(
      /^24\.\d+\.\d+$/,
    );
  });

  test("excludes generated workspace output recursively from both linters", () => {
    const generatedDirectories = [
      "node_modules",
      "dist",
      "coverage",
      "playwright-report",
      "test-results",
    ];
    const biomeConfig = JSON.parse(
      readFileSync(resolve(root, "biome.json"), "utf8"),
    ) as {
      files?: { includes?: string[] };
    };
    const markdownlintConfig = JSON.parse(
      readFileSync(resolve(root, ".markdownlint-cli2.jsonc"), "utf8"),
    ) as {
      ignores?: string[];
    };

    expect(biomeConfig.files?.includes).toEqual(
      expect.arrayContaining(
        generatedDirectories.map((directory) => `!!**/${directory}`),
      ),
    );
    expect(markdownlintConfig.ignores).toEqual(
      expect.arrayContaining(
        generatedDirectories.map((directory) => `**/${directory}/**`),
      ),
    );
  });
});
