import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { start } from "./main.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("start", () => {
  test("validates the repository-owned configuration even when an override is set", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "wheelsparrow-main-root-"),
    );
    const externalRoot = await mkdtemp(
      join(tmpdir(), "wheelsparrow-main-external-"),
    );
    temporaryDirectories.push(repositoryRoot, externalRoot);
    const repositoryConfiguration = join(repositoryRoot, "wheelsparrow.yaml");
    await writeFile(repositoryConfiguration, "github: [invalid", "utf8");
    const externalConfiguration = join(externalRoot, "wheelsparrow.yaml");
    await writeFile(externalConfiguration, "{}", "utf8");
    const previousConfiguration = process.env.WHEELSPARROW_CONFIG;
    try {
      process.env.WHEELSPARROW_CONFIG = externalConfiguration;

      await expect(start(repositoryRoot)).rejects.toThrow(
        `Invalid configuration in ${repositoryConfiguration}:`,
      );
    } finally {
      if (previousConfiguration === undefined) {
        delete process.env.WHEELSPARROW_CONFIG;
      } else {
        process.env.WHEELSPARROW_CONFIG = previousConfiguration;
      }
    }
  });
});
