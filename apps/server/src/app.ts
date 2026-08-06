import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  HealthResponseSchema,
  ReadyResponseSchema,
} from "@wheelsparrow/contracts";
import Fastify, { type FastifyInstance } from "fastify";

import type { ReadinessGate } from "./readiness.js";

export interface BuildAppOptions {
  readiness: ReadinessGate;
  registerWeb?: (app: FastifyInstance) => Promise<void>;
}

export async function buildApp({
  readiness,
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

  try {
    await registerWeb?.(app);
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
