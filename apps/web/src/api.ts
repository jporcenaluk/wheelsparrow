import {
  type HealthResponse,
  HealthResponseSchema,
} from "@wheelsparrow/contracts";
import { Value } from "typebox/value";

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/health", {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Health request failed with HTTP ${response.status}`);
  }

  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const isJson =
    mediaType === "application/json" ||
    /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType ?? "");
  if (!isJson) {
    throw new Error("Health response must use a JSON media type");
  }

  const payload: unknown = await response.json();
  if (!Value.Check(HealthResponseSchema, payload)) {
    throw new Error("Health response did not match the expected schema");
  }

  return payload;
}
