import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import {
  type Configuration,
  ConfigurationSchema,
} from "@wheelsparrow/contracts";
import { Value } from "typebox/value";
import { parse } from "yaml";

export class WorkspaceRootError extends Error {
  override name = "WorkspaceRootError";
}

export interface LocalPaths {
  repositoryRoot: string;
  dataRoot: string;
  workspaceRoot: string;
  databasePath: string;
  lockPath: string;
  logsRoot: string;
}

export interface LoadedRuntimeConfiguration {
  configuration: Configuration;
  paths: LocalPaths;
}

export function resolveConfigurationPath(repositoryRoot: string): string {
  return resolve(repositoryRoot, "wheelsparrow.yaml");
}

class ConfigurationValidationError extends Error {
  override name = "ConfigurationValidationError";
}

export function resolveWorkspaceRoot(
  root: string,
  configuredPath: string,
): string {
  if (
    configuredPath.trim() === "" ||
    isAbsolute(configuredPath) ||
    win32.isAbsolute(configuredPath)
  ) {
    throw new WorkspaceRootError(
      "workspace root must be a relative descendant",
    );
  }
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, configuredPath);
  const descendant = relative(resolvedRoot, candidate);
  if (
    descendant === "" ||
    descendant === ".." ||
    descendant.startsWith(`..${sep}`) ||
    isAbsolute(descendant)
  ) {
    throw new WorkspaceRootError(
      "workspace root must be a relative descendant",
    );
  }
  return candidate;
}

function assertContained(repositoryRoot: string, candidate: string): void {
  const descendant = relative(repositoryRoot, candidate);
  if (
    descendant === "" ||
    descendant === ".." ||
    descendant.startsWith(`..${sep}`) ||
    isAbsolute(descendant)
  ) {
    throw new WorkspaceRootError(
      "workspace root must be a relative descendant",
    );
  }
}

function assertPrivateDirectory(path: string, mode: number, uid: number): void {
  if (typeof process.getuid !== "function") return;
  if (uid !== process.getuid() || (mode & 0o022) !== 0) {
    throw new WorkspaceRootError(
      `workspace storage directory is not private: ${path}`,
    );
  }
}

export async function deriveLocalPaths(
  repositoryRoot: string,
  configuredWorkspaceRoot: string,
): Promise<LocalPaths> {
  // Validate the supplied spelling before resolving physical paths.
  resolveWorkspaceRoot(repositoryRoot, configuredWorkspaceRoot);

  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const workspaceRoot = resolveWorkspaceRoot(
    canonicalRepositoryRoot,
    configuredWorkspaceRoot,
  );
  assertContained(canonicalRepositoryRoot, workspaceRoot);

  const segments = relative(canonicalRepositoryRoot, workspaceRoot).split(sep);
  if (segments.length < 2) {
    throw new WorkspaceRootError(
      "workspace root must have at least two path segments",
    );
  }

  const dataRoot = dirname(workspaceRoot);
  let component = canonicalRepositoryRoot;
  for (const segment of segments) {
    component = join(component, segment);
    try {
      const metadata = await lstat(component);
      if (metadata.isSymbolicLink()) {
        throw new WorkspaceRootError(
          "workspace storage path must not contain symbolic links",
        );
      }
      if (!metadata.isDirectory()) {
        throw new WorkspaceRootError(
          "workspace storage path components must be directories",
        );
      }
      assertPrivateDirectory(component, metadata.mode, metadata.uid);
      assertContained(canonicalRepositoryRoot, await realpath(component));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
  }

  return {
    repositoryRoot: canonicalRepositoryRoot,
    dataRoot,
    workspaceRoot,
    databasePath: join(dataRoot, "wheelsparrow.sqlite3"),
    lockPath: join(dataRoot, "wheelsparrow.lock"),
    logsRoot: join(dataRoot, "logs"),
  };
}

async function validateStorageDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new WorkspaceRootError(
        "workspace storage path must not contain symbolic links",
      );
    }
    if (!metadata.isDirectory()) {
      throw new WorkspaceRootError(
        "workspace storage path components must be directories",
      );
    }
    assertPrivateDirectory(path, metadata.mode, metadata.uid);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

export async function prepareLocalPaths(
  paths: LocalPaths,
): Promise<LocalPaths> {
  const directories = [paths.dataRoot, paths.workspaceRoot, paths.logsRoot];

  // Validate every existing target before this function creates anything. This
  // keeps an unsafe later target from causing an earlier missing one to appear.
  const existing = await Promise.all(
    directories.map((directory) => validateStorageDirectory(directory)),
  );
  for (const [index, directory] of directories.entries()) {
    if (existing[index] === false) {
      await mkdir(directory, { mode: 0o700, recursive: true });
      if (process.platform !== "win32") await chmod(directory, 0o700);
    }
  }

  await Promise.all(directories.map(validateStorageDirectory));
  return paths;
}

function sanitizedError(cause: unknown): Error {
  if (
    cause instanceof ConfigurationValidationError ||
    cause instanceof WorkspaceRootError
  ) {
    const sanitized = new Error(`${cause.name}: ${cause.message}`);
    sanitized.name = cause.name;
    return sanitized;
  }
  const rawName = cause instanceof Error ? cause.name : "UnknownError";
  const name = /^[A-Za-z][A-Za-z0-9]*$/.test(rawName)
    ? rawName
    : "UnknownError";
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  const classification =
    code !== undefined && /^[A-Z0-9_]+$/.test(code)
      ? `${name} (${code})`
      : name;
  const sanitized = new Error(classification);
  sanitized.name = name;
  if (code !== undefined && /^[A-Z0-9_]+$/.test(code)) {
    (sanitized as NodeJS.ErrnoException).code = code;
  }
  return sanitized;
}

function fieldPath(instancePath: string): string {
  if (instancePath === "") return "$";
  const segments = instancePath.split("/").slice(1);
  if (
    segments.length === 0 ||
    segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))
  ) {
    return "$";
  }
  return `$.${segments.join(".")}`;
}

function constraintName(keyword: string): string {
  if (keyword === "pattern") return "nonWhitespace";
  if (keyword === "~refine") return "distinctLaneValues";
  return /^[A-Za-z][A-Za-z0-9]*$/.test(keyword) ? keyword : "schemaConstraint";
}

function validationError(value: unknown): ConfigurationValidationError {
  const errors = Value.Errors(ConfigurationSchema, value)
    .slice(0, 8)
    .map(
      (error) =>
        `${fieldPath(error.instancePath)}: ${constraintName(error.keyword)}`,
    );
  const detail = errors.length === 0 ? "schemaConstraint" : errors.join(", ");
  return new ConfigurationValidationError(
    `schema validation failed: ${detail}`,
  );
}

export async function loadConfiguration(
  repositoryRoot: string,
): Promise<Configuration> {
  const path = resolveConfigurationPath(repositoryRoot);
  try {
    const contents = await readFile(path, "utf8");
    const value: unknown = parse(contents);
    if (!Value.Check(ConfigurationSchema, value)) throw validationError(value);
    const configuration = value as Configuration;
    resolveWorkspaceRoot(repositoryRoot, configuration.workspace_root);
    return configuration;
  } catch (cause) {
    const sanitizedCause = sanitizedError(cause);
    throw new Error(
      `Invalid configuration in ${path}: ${sanitizedCause.message}`,
      { cause: sanitizedCause },
    );
  }
}

export async function loadRuntimeConfiguration(
  repositoryRoot: string,
): Promise<LoadedRuntimeConfiguration> {
  const configuration = await loadConfiguration(repositoryRoot);
  const paths = await deriveLocalPaths(
    repositoryRoot,
    configuration.workspace_root,
  );
  return { configuration, paths };
}
