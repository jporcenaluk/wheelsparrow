import { randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";

export const OPERATOR_SCHEMA_VERSION = 1 as const;

export class OperatorSecurityError extends Error {
  readonly code = "csrf_forbidden" as const;

  constructor(
    message = "The operator request failed origin or CSRF validation.",
  ) {
    super(message);
    this.name = "OperatorSecurityError";
  }
}

export interface OperatorSecurityOptions {
  /** The exact browser origin allowed to mutate this local service. */
  origin?: string;
}

export interface OperatorSecurity {
  readonly csrfToken: string;
  checkMutation(request: FastifyRequest): void;
  checkEvent(request: FastifyRequest): void;
}

function expectedRequestOrigin(request: FastifyRequest): string {
  const protocol = request.protocol || "http";
  const host = request.headers.host;
  if (typeof host !== "string" || host.length === 0)
    throw new OperatorSecurityError("The request host is missing.");
  return `${protocol}://${host}`;
}

function normalizedOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("origin must not contain credentials or a path");
    return parsed.origin;
  } catch {
    throw new TypeError("Operator origin must be an absolute origin.");
  }
}

function hasMatchingToken(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function headerToken(request: FastifyRequest): string | undefined {
  const token = request.headers["x-csrf-token"];
  return Array.isArray(token) ? token[0] : token;
}

function queryToken(request: FastifyRequest): string | undefined {
  const query = request.query;
  if (typeof query !== "object" || query === null) return undefined;
  const candidate = (query as Record<string, unknown>).csrf_token;
  return typeof candidate === "string" ? candidate : undefined;
}

function cookieToken(request: FastifyRequest): string | undefined {
  const cookie = request.headers.cookie;
  if (typeof cookie !== "string") return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "ws_csrf") return value.join("=");
  }
  return undefined;
}

export function createOperatorSecurity(
  options: OperatorSecurityOptions = {},
): OperatorSecurity {
  const csrfToken = randomBytes(32).toString("base64url");
  let configuredOrigin: string | undefined;
  if (options.origin !== undefined)
    configuredOrigin = normalizedOrigin(options.origin);

  const checkOrigin = (request: FastifyRequest): void => {
    const received = request.headers.origin;
    const expected = configuredOrigin ?? expectedRequestOrigin(request);
    if (typeof received !== "string" || received !== expected)
      throw new OperatorSecurityError("The request origin is not allowed.");
  };

  const checkToken = (request: FastifyRequest, allowQuery: boolean): void => {
    const received =
      headerToken(request) ??
      (allowQuery ? (queryToken(request) ?? cookieToken(request)) : undefined);
    if (!hasMatchingToken(csrfToken, received))
      throw new OperatorSecurityError();
  };

  return {
    csrfToken,
    checkMutation(request) {
      checkOrigin(request);
      checkToken(request, false);
    },
    checkEvent(request) {
      checkOrigin(request);
      checkToken(request, true);
    },
  };
}
