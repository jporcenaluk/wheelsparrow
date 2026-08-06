import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfiguration } from "./config.js";

const temporaryDirectories: string[] = [];
const sentinelSecret = "SENTINEL_CONFIG_SECRET_7f31";

function serializeErrorChain(error: unknown): string {
  const chain: Array<{ name: string; message: string; code?: string }> = [];
  const visited = new Set<Error>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    const code = (current as NodeJS.ErrnoException).code;
    chain.push({
      name: current.name,
      message: current.message,
      ...(code === undefined ? {} : { code }),
    });
    current = current.cause;
  }
  return JSON.stringify(chain);
}

const validConfiguration = {
  github: {
    owner: "jporcenaluk",
    repository: "wheelsparrow",
    project_number: 2,
    status_field: "Status",
    lanes: { ready: "Ready", todo: "Todo", review: "Review", done: "Done" },
    required_labels: ["mvp"],
    priority_field: "Priority",
  },
  poll_interval_seconds: 30,
  workspace_root: ".wheelsparrow/workspaces",
  agent: {
    command: "codex",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    timeout_minutes: 45,
  },
  verification: { command: "make verify-agent" },
  staging: {
    workflow: "deploy-staging.yml",
    environment: "staging",
    smoke_command: "make smoke-staging",
  },
};

async function configurationFile(contents: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "wheelsparrow.yaml");
  await writeFile(
    path,
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("loadConfiguration", () => {
  test("loads the approved configuration shape", async () => {
    const path = await configurationFile(validConfiguration);

    const configuration = await loadConfiguration(path);

    expect(configuration.github.owner).toBe("jporcenaluk");
    expect(configuration).toEqual(validConfiguration);
  });

  test.each([
    ["root", { ...validConfiguration, token: "secret" }],
    [
      "nested",
      {
        ...validConfiguration,
        github: { ...validConfiguration.github, token: "secret" },
      },
    ],
  ])(
    "rejects a fully valid document with an unknown %s key",
    async (_, value) => {
      const path = await configurationFile(value);

      await expect(loadConfiguration(path)).rejects.toThrow(
        `Invalid configuration in ${path}:`,
      );
    },
  );

  test("wraps malformed YAML with its path and cause", async () => {
    const path = await configurationFile(`github: [${sentinelSecret}`);

    const error = await loadConfiguration(path).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      `Invalid configuration in ${path}:`,
    );
    expect((error as Error).message).toContain("YAMLParseError");
    expect((error as Error).message).not.toContain(sentinelSecret);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(serializeErrorChain(error)).not.toContain(sentinelSecret);
  });

  test("includes the missing file path in read errors", async () => {
    const path = join(tmpdir(), "missing-wheelsparrow.yaml");

    await expect(loadConfiguration(path)).rejects.toThrow(
      `Invalid configuration in ${path}:`,
    );
  });

  test.each([
    ["absolute", "/tmp/wheelsparrow-outside"],
    ["traversal", "../wheelsparrow-outside"],
    ["repository root", "."],
    ["empty after trimming", "   "],
  ])("rejects an %s workspace root", async (_, workspaceRoot) => {
    const path = await configurationFile({
      ...validConfiguration,
      workspace_root: workspaceRoot,
    });

    const error = await loadConfiguration(path).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("WorkspaceRootError");
  });
});
