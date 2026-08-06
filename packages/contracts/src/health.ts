import { type Static, Type } from "typebox";

export const HealthResponseSchema = Type.Object({
  schema_version: Type.Literal(1),
  status: Type.Literal("ok"),
});

export const ReadyResponseSchema = Type.Object({
  schema_version: Type.Literal(1),
  status: Type.Union([Type.Literal("starting"), Type.Literal("ready")]),
});

export type HealthResponse = Static<typeof HealthResponseSchema>;
export type ReadyResponse = Static<typeof ReadyResponseSchema>;
