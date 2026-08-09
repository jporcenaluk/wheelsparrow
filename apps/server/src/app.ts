import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  HealthResponseSchema,
  ReadyResponseSchema,
} from "@wheelsparrow/contracts";
import Fastify, { type FastifyInstance } from "fastify";

import type { ReadinessGate } from "./readiness.js";

export interface BuildAppOptions {
  readiness: ReadinessGate;
  /** Register the guarded operator API once the durable coordinator is ready. */
  registerOperator?: (app: FastifyInstance) => Promise<void>;
  registerWeb?: (app: FastifyInstance) => Promise<void>;
}

export async function buildApp({
  readiness,
  registerOperator,
  registerWeb,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    requestTimeout: 120_000,
    logger: {
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "password",
          "token",
          "secret",
        ],
        censor: "[REDACTED]",
      },
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.get(
    "/health",
    { schema: { response: { 200: HealthResponseSchema } } },
    async () => ({ schema_version: 1, status: "ok" }) as const,
  );

  app.get(
    "/ready",
    {
      schema: {
        response: { 200: ReadyResponseSchema, 503: ReadyResponseSchema },
      },
    },
    async (_, reply) => {
      if (readiness.isReady()) {
        return { schema_version: 1, status: "ready" } as const;
      }
      return reply
        .code(503)
        .send({ schema_version: 1, status: "starting" } as const);
    },
  );

  app.setErrorHandler((error, _request, reply) => {
    const status =
      (error as { statusCode?: number }).statusCode === 400 ? 400 : 500;
    return reply
      .code(status)
      .type("application/json")
      .send({
        schema_version: 1,
        error: {
          code: status === 400 ? "invalid_request" : "internal_error",
          message:
            status === 400
              ? "The request could not be parsed or validated."
              : "The operator capability is unavailable.",
        },
      });
  });

  try {
    await registerOperator?.(app);
    await registerWeb?.(app);
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
