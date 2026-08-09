import {
  type ApproveMergeRequest,
  type ApproveMergeResponse,
  ApproveMergeResponseSchema,
  type ConfigurationResponse,
  ConfigurationResponseSchema,
  type HealthResponse,
  HealthResponseSchema,
  type OperatorErrorResponse,
  OperatorErrorResponseSchema,
  type OperatorRunDetail,
  OperatorRunDetailSchema,
  type QueueResponse,
  QueueResponseSchema,
  type ReviewResponse,
  ReviewResponseSchema,
  type SchedulerControlPatch,
  type SchedulerControlResponse,
  SchedulerControlResponseSchema,
  SseNotificationSchema,
} from "@wheelsparrow/contracts";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

const JSON_MEDIA_TYPE = /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/u;
const OPERATOR_ROOT = "/api/operator";
const DELIVERY_ROOT = "/api/runs";
const GITHUB_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const GITHUB_PULL_REQUEST_PATH =
  /^\/([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\/pull\/([1-9][0-9]*)$/u;
let csrfToken: string | null = null;

export function safeGithubPullRequestUrl(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const match = GITHUB_PULL_REQUEST_PATH.exec(parsed.pathname);
  const owner = match?.[1];
  const repository = match?.[2];
  const number = match?.[3];
  if (
    match === null ||
    owner === undefined ||
    repository === undefined ||
    number === undefined ||
    !GITHUB_PATH_SEGMENT.test(owner) ||
    !GITHUB_PATH_SEGMENT.test(repository) ||
    !Number.isSafeInteger(Number(number)) ||
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.href !== value
  ) {
    return null;
  }
  return value;
}

export class OperatorApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "OperatorApiError";
    this.status = status;
    this.code = code;
  }
}

function rememberCsrf(response: Response): void {
  const token = response.headers.get("x-csrf-token")?.trim();
  if (token) csrfToken = token;
}

function discoveredCsrf(): string | null {
  if (csrfToken) return csrfToken;
  if (typeof document === "undefined") return null;
  return (
    document
      .querySelector('meta[name="csrf-token"]')
      ?.getAttribute("content") ?? null
  );
}

async function ensureCsrf(): Promise<string | null> {
  const existing = discoveredCsrf();
  if (existing) return existing;
  const response = await fetch(`${OPERATOR_ROOT}/session`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (!response.ok || !isJsonResponse(response)) return null;
  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { csrf_token?: unknown }).csrf_token !== "string" ||
    (payload as { csrf_token: string }).csrf_token.trim().length === 0
  )
    return null;
  csrfToken = (payload as { csrf_token: string }).csrf_token;
  return csrfToken;
}

function isJsonResponse(response: Response): boolean {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return (
    mediaType === "application/json" || JSON_MEDIA_TYPE.test(mediaType ?? "")
  );
}

async function requestJson<T>(
  path: string,
  schema: TSchema,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET") {
    const token = await ensureCsrf();
    if (token) headers.set("x-csrf-token", token);
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  rememberCsrf(response);
  if (!response.ok) {
    if (isJsonResponse(response)) {
      try {
        const payload: unknown = await response.json();
        if (Value.Check(OperatorErrorResponseSchema, payload)) {
          const error = (payload as OperatorErrorResponse).error;
          throw new OperatorApiError(
            error.message,
            response.status,
            error.code,
          );
        }
      } catch (error) {
        if (error instanceof OperatorApiError) throw error;
      }
    }
    throw new OperatorApiError(
      `Operator request failed with HTTP ${response.status}`,
      response.status,
    );
  }
  if (!isJsonResponse(response)) {
    throw new OperatorApiError(
      "Operator response must use a JSON media type",
      response.status,
    );
  }
  const payload: unknown = await response.json();
  if (!Value.Check(schema, payload)) {
    throw new OperatorApiError(
      "Operator response did not match the expected schema",
      response.status,
    );
  }
  return payload as T;
}

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

export function fetchQueue(): Promise<QueueResponse> {
  return requestJson<QueueResponse>(
    `${OPERATOR_ROOT}/queue`,
    QueueResponseSchema,
  );
}

export function fetchRun(runId: string): Promise<OperatorRunDetail> {
  return requestJson<OperatorRunDetail>(
    `${OPERATOR_ROOT}/runs/${encodeURIComponent(runId)}`,
    OperatorRunDetailSchema,
  );
}

export function fetchReview(): Promise<ReviewResponse> {
  return requestJson<ReviewResponse>(
    `${OPERATOR_ROOT}/review`,
    ReviewResponseSchema,
  );
}

export function approveRun(
  runId: string,
  request: ApproveMergeRequest,
): Promise<ApproveMergeResponse> {
  return requestJson<ApproveMergeResponse>(
    `${DELIVERY_ROOT}/${encodeURIComponent(runId)}/approve`,
    ApproveMergeResponseSchema,
    { method: "POST", body: JSON.stringify(request) },
  );
}

export function retryStaging(runId: string): Promise<OperatorErrorResponse> {
  return requestJson<OperatorErrorResponse>(
    `${DELIVERY_ROOT}/${encodeURIComponent(runId)}/retry-staging`,
    OperatorErrorResponseSchema,
    { method: "POST" },
  );
}

export function fetchConfiguration() {
  return requestJson<ConfigurationResponse>(
    `${OPERATOR_ROOT}/configuration`,
    ConfigurationResponseSchema,
  );
}

export function updateScheduler(
  patch: SchedulerControlPatch,
): Promise<SchedulerControlResponse> {
  return requestJson<SchedulerControlResponse>(
    `${OPERATOR_ROOT}/scheduler`,
    SchedulerControlResponseSchema,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

export function subscribeToSnapshots(onSnapshot: () => void): () => void {
  if (typeof EventSource === "undefined") return () => undefined;
  let source: EventSource | null = null;
  let cancelled = false;
  const onMessage = (event: MessageEvent<string>) => {
    try {
      const payload: unknown = JSON.parse(event.data);
      if (Value.Check(SseNotificationSchema, payload)) onSnapshot();
    } catch {
      // Notification streams are advisory. The next explicit query remains authoritative.
    }
  };
  const connect = (token: string | null) => {
    if (cancelled) return;
    const query = token ? `?csrf_token=${encodeURIComponent(token)}` : "";
    source = new EventSource(`${OPERATOR_ROOT}/events${query}`);
    source.addEventListener("message", onMessage);
  };
  const existing = discoveredCsrf();
  if (existing) connect(existing);
  else void ensureCsrf().then(connect);
  return () => {
    cancelled = true;
    if (source) {
      source.removeEventListener("message", onMessage);
      source.close();
    }
  };
}
