import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

import {
  type Configuration,
  ConfigurationSchema,
} from "@wheelsparrow/contracts";
import { Value } from "typebox/value";
import { parse } from "yaml";

export class WorkspaceRootError extends Error {
  override name = "WorkspaceRootError";
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
