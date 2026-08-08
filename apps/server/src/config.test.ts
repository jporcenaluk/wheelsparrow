import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  deriveLocalPaths,
  loadConfiguration,
  prepareLocalPaths,
  resolveConfigurationPath,
  WorkspaceRootError,
} from "./config.js";

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

function expectedLocalPaths(repositoryRoot: string) {
  const dataRoot = join(repositoryRoot, ".wheelsparrow");
  return {
    repositoryRoot,
    dataRoot,
    workspaceRoot: join(dataRoot, "workspaces"),
    databasePath: join(dataRoot, "wheelsparrow.sqlite3"),
    lockPath: join(dataRoot, "wheelsparrow.lock"),
    logsRoot: join(dataRoot, "logs"),
  };
}

function skipUnsupportedSymlinks(error: unknown, skip: () => never): void {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM" || code === "ENOTSUP") skip();
  throw error;
}

describe("deriveLocalPaths", () => {
  test("derives the canonical repository-owned local storage layout", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-paths-"));
    temporaryDirectories.push(repositoryRoot);

    await expect(
      deriveLocalPaths(repositoryRoot, ".wheelsparrow/workspaces"),
    ).resolves.toEqual(expectedLocalPaths(repositoryRoot));
  });

  test("rejects a one-segment workspace root", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-paths-"));
    temporaryDirectories.push(repositoryRoot);

    await expect(
      deriveLocalPaths(repositoryRoot, "workspaces"),
    ).rejects.toThrow(WorkspaceRootError);
  });

  test("rejects an existing symbolic-link data root", async ({ skip }) => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-paths-"));
    temporaryDirectories.push(repositoryRoot);
    const target = await mkdtemp(join(tmpdir(), "wheelsparrow-link-target-"));
    temporaryDirectories.push(target);
    try {
      await symlink(target, join(repositoryRoot, ".wheelsparrow"));
    } catch (error) {
      skipUnsupportedSymlinks(error, skip);
    }

    await expect(
      deriveLocalPaths(repositoryRoot, ".wheelsparrow/workspaces"),
    ).rejects.toThrow(WorkspaceRootError);
  });

  test("rejects an existing symbolic-link workspace root", async ({ skip }) => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-paths-"));
    temporaryDirectories.push(repositoryRoot);
    const dataRoot = join(repositoryRoot, ".wheelsparrow");
    await mkdir(dataRoot);
    const target = await mkdtemp(join(tmpdir(), "wheelsparrow-link-target-"));
    temporaryDirectories.push(target);
    try {
      await symlink(target, join(dataRoot, "workspaces"));
    } catch (error) {
      skipUnsupportedSymlinks(error, skip);
    }

    await expect(
      deriveLocalPaths(repositoryRoot, ".wheelsparrow/workspaces"),
    ).rejects.toThrow(WorkspaceRootError);
  });

  test("permits missing storage descendants without creating them", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-paths-"));
    temporaryDirectories.push(repositoryRoot);
    const paths = expectedLocalPaths(repositoryRoot);

    await expect(
      deriveLocalPaths(repositoryRoot, ".wheelsparrow/workspaces"),
    ).resolves.toEqual(paths);
    await expect(access(paths.dataRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("canonicalizes a contained repository root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "wheelsparrow-paths-"));
    temporaryDirectories.push(parent);
    const repositoryRoot = join(parent, "repository");
    await mkdir(repositoryRoot);

    await expect(
      deriveLocalPaths(
        join(parent, "nested", "..", "repository"),
        ".wheelsparrow/workspaces",
      ),
    ).resolves.toEqual(expectedLocalPaths(resolve(repositoryRoot)));
  });

  test("canonicalizes a symbolic-link repository root alias", async ({
    skip,
  }) => {
    const parent = await mkdtemp(join(tmpdir(), "wheelsparrow-paths-"));
    temporaryDirectories.push(parent);
    const repositoryRoot = join(parent, "repository");
    const repositoryRootAlias = join(parent, "repository-alias");
    await mkdir(repositoryRoot);
    try {
      await symlink(repositoryRoot, repositoryRootAlias);
    } catch (error) {
      skipUnsupportedSymlinks(error, skip);
    }

    await expect(
      deriveLocalPaths(repositoryRootAlias, ".wheelsparrow/workspaces"),
    ).resolves.toEqual(expectedLocalPaths(repositoryRoot));
  });

  test.each([
    ["absolute", join(tmpdir(), "wheelsparrow-outside")],
    ["traversal", "../wheelsparrow-outside"],
  ])("directly rejects an %s workspace root", async (_, workspaceRoot) => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-paths-"));
    temporaryDirectories.push(repositoryRoot);

    await expect(
      deriveLocalPaths(repositoryRoot, workspaceRoot),
    ).rejects.toThrow(WorkspaceRootError);
  });

  test("permits an existing safe data root without creating its workspace", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-paths-"));
    temporaryDirectories.push(repositoryRoot);
    const paths = expectedLocalPaths(repositoryRoot);
    await mkdir(paths.dataRoot, { mode: 0o700 });

    await expect(
      deriveLocalPaths(repositoryRoot, ".wheelsparrow/workspaces"),
    ).resolves.toEqual(paths);
    await expect(access(paths.workspaceRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test.skipIf(process.platform === "win32")(
    "rejects a group- or world-writable existing data root",
    async () => {
      const repositoryRoot = await mkdtemp(
        join(tmpdir(), "wheelsparrow-paths-"),
      );
      temporaryDirectories.push(repositoryRoot);
      const dataRoot = join(repositoryRoot, ".wheelsparrow");
      await mkdir(dataRoot, { mode: 0o700 });
      await chmod(dataRoot, 0o777);

      try {
        await expect(
          deriveLocalPaths(repositoryRoot, ".wheelsparrow/workspaces"),
        ).rejects.toThrow(WorkspaceRootError);
      } finally {
        await chmod(dataRoot, 0o700);
      }
    },
  );
});

describe("loadConfiguration", () => {
  test("resolves the one repository-owned configuration path", async () => {
    const path = await configurationFile(validConfiguration);
    const root = dirname(path);

    expect(resolveConfigurationPath(root)).toBe(path);
  });

  test("loads configuration relative to an explicit repository root", async () => {
    const path = await configurationFile(validConfiguration);

    const configuration = await loadConfiguration(dirname(path));

    expect(configuration).toEqual(validConfiguration);
  });

  test("loads the approved configuration shape", async () => {
    const path = await configurationFile(validConfiguration);

    const configuration = await loadConfiguration(dirname(path));

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

      await expect(loadConfiguration(dirname(path))).rejects.toThrow(
        `Invalid configuration in ${path}:`,
      );
    },
  );

  test("wraps malformed YAML with its path and cause", async () => {
    const path = await configurationFile(`github: [${sentinelSecret}`);

    const error = await loadConfiguration(dirname(path)).catch(
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

  test("reports schema field paths and constraint names without values", async () => {
    const path = await configurationFile({
      ...validConfiguration,
      github: {
        ...validConfiguration.github,
        owner: { token: sentinelSecret },
      },
    });

    const error = await loadConfiguration(dirname(path)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("$.github.owner: type");
    expect(serializeErrorChain(error)).not.toContain(sentinelSecret);
  });

  test("names the distinct-lane constraint without exposing lane values", async () => {
    const path = await configurationFile({
      ...validConfiguration,
      github: {
        ...validConfiguration.github,
        lanes: {
          ready: sentinelSecret,
          todo: sentinelSecret,
          review: "Review",
          done: "Done",
        },
      },
    });

    const error = await loadConfiguration(dirname(path)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "$.github.lanes: distinctLaneValues",
    );
    expect(serializeErrorChain(error)).not.toContain(sentinelSecret);
  });

  test("does not expose unknown property names in schema diagnostics", async () => {
    const path = await configurationFile({
      ...validConfiguration,
      github: {
        ...validConfiguration.github,
        [sentinelSecret]: sentinelSecret,
      },
    });

    const error = await loadConfiguration(dirname(path)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "$.github: additionalProperties",
    );
    expect(serializeErrorChain(error)).not.toContain(sentinelSecret);
  });

  test("includes the missing file path in read errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "wheelsparrow-missing-config-"));
    temporaryDirectories.push(root);
    const path = join(root, "wheelsparrow.yaml");

    await expect(loadConfiguration(root)).rejects.toThrow(
      `Invalid configuration in ${path}:`,
    );
  });

  test.each([
    ["absolute", "/tmp/wheelsparrow-outside", "WorkspaceRootError"],
    ["traversal", "../wheelsparrow-outside", "WorkspaceRootError"],
    ["repository root", ".", "WorkspaceRootError"],
    ["empty after trimming", "   ", "$.workspace_root: nonWhitespace"],
  ])("rejects an %s workspace root", async (_, workspaceRoot, diagnostic) => {
    const path = await configurationFile({
      ...validConfiguration,
      workspace_root: workspaceRoot,
    });

    const error = await loadConfiguration(dirname(path)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(diagnostic);
  });
});

describe("prepareLocalPaths", () => {
  test("creates the repository-owned storage directories privately and returns canonical paths", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-paths-"));
    temporaryDirectories.push(repositoryRoot);
    const paths = expectedLocalPaths(repositoryRoot);

    await expect(prepareLocalPaths(paths)).resolves.toEqual(paths);

    for (const directory of [
      paths.dataRoot,
      paths.workspaceRoot,
      paths.logsRoot,
    ]) {
      const metadata = await lstat(directory);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      if (process.platform !== "win32")
        expect(metadata.mode & 0o777).toBe(0o700);
      if (typeof process.getuid === "function")
        expect(metadata.uid).toBe(process.getuid());
    }
    await expect(access(paths.databasePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(paths.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test.skipIf(process.platform === "win32")(
    "revalidates safe existing private directories without changing their paths",
    async () => {
      const repositoryRoot = await mkdtemp(
        join(tmpdir(), "wheelsparrow-paths-"),
      );
      temporaryDirectories.push(repositoryRoot);
      const paths = expectedLocalPaths(repositoryRoot);
      await mkdir(paths.workspaceRoot, { recursive: true, mode: 0o700 });
      await mkdir(paths.logsRoot, { recursive: true, mode: 0o700 });
      await chmod(paths.dataRoot, 0o700);
      await chmod(paths.workspaceRoot, 0o700);
      await chmod(paths.logsRoot, 0o700);

      await expect(prepareLocalPaths(paths)).resolves.toEqual(paths);
    },
  );

  test.skipIf(process.platform === "win32")(
    "refuses an unsafe existing component before creating any missing storage directory",
    async () => {
      const repositoryRoot = await mkdtemp(
        join(tmpdir(), "wheelsparrow-paths-"),
      );
      temporaryDirectories.push(repositoryRoot);
      const paths = expectedLocalPaths(repositoryRoot);
      await mkdir(paths.dataRoot, { mode: 0o700 });
      await chmod(paths.dataRoot, 0o777);

      await expect(prepareLocalPaths(paths)).rejects.toThrow(
        WorkspaceRootError,
      );
      expect((await lstat(paths.dataRoot)).mode & 0o777).toBe(0o777);
      await expect(access(paths.workspaceRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(paths.logsRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  test("refuses a symbolic-link logs root before creating a missing workspace or state files", async ({
    skip,
  }) => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-paths-"));
    temporaryDirectories.push(repositoryRoot);
    const paths = expectedLocalPaths(repositoryRoot);
    const target = await mkdtemp(join(tmpdir(), "wheelsparrow-link-target-"));
    temporaryDirectories.push(target);
    await chmod(target, 0o711);
    await mkdir(paths.dataRoot, { mode: 0o700 });
    try {
      await symlink(target, paths.logsRoot);
    } catch (error) {
      skipUnsupportedSymlinks(error, skip);
    }

    await expect(prepareLocalPaths(paths)).rejects.toThrow(WorkspaceRootError);
    expect((await lstat(paths.logsRoot)).isSymbolicLink()).toBe(true);
    expect((await lstat(target)).mode & 0o777).toBe(0o711);
    await expect(access(paths.workspaceRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(paths.databasePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(paths.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("refuses a non-directory logs root before creating a missing workspace or state files", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-paths-"));
    temporaryDirectories.push(repositoryRoot);
    const paths = expectedLocalPaths(repositoryRoot);
    await mkdir(paths.dataRoot, { mode: 0o700 });
    await writeFile(paths.logsRoot, "sentinel", "utf8");

    await expect(prepareLocalPaths(paths)).rejects.toThrow(WorkspaceRootError);
    await expect(access(paths.workspaceRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(paths.databasePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(paths.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("refuses a symbolic-link workspace before creating logs or state files", async ({
    skip,
  }) => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "wheelsparrow-paths-"));
    temporaryDirectories.push(repositoryRoot);
    const paths = expectedLocalPaths(repositoryRoot);
    const target = await mkdtemp(join(tmpdir(), "wheelsparrow-link-target-"));
    temporaryDirectories.push(target);
    await chmod(target, 0o711);
    await mkdir(paths.dataRoot, { mode: 0o700 });
    try {
      await symlink(target, paths.workspaceRoot);
    } catch (error) {
      skipUnsupportedSymlinks(error, skip);
    }

    await expect(prepareLocalPaths(paths)).rejects.toThrow(WorkspaceRootError);
    expect((await lstat(paths.workspaceRoot)).isSymbolicLink()).toBe(true);
    expect((await lstat(target)).mode & 0o777).toBe(0o711);
    await expect(access(paths.logsRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(paths.databasePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(paths.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
