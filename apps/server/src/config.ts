import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

import {
  type Configuration,
  ConfigurationSchema,
} from "@wheelsparrow/contracts";
import { Value } from "typebox/value";
import { parse } from "yaml";

export class WorkspaceRootError extends Error {
  override name = "WorkspaceRootError";
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

export async function loadConfiguration(path: string): Promise<Configuration> {
  try {
    const contents = await readFile(path, "utf8");
    const configuration = Value.Parse(ConfigurationSchema, parse(contents));
    resolveWorkspaceRoot(dirname(path), configuration.workspace_root);
    return configuration;
  } catch (cause) {
    const sanitizedCause = sanitizedError(cause);
    throw new Error(
      `Invalid configuration in ${path}: ${sanitizedCause.message}`,
      { cause: sanitizedCause },
    );
  }
}
