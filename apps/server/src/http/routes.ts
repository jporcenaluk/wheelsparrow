import type { ServerResponse } from "node:http";
import type {
  OperatorQueueRun,
  ReturnToTodoRequest,
} from "@wheelsparrow/contracts";
import {
  ConfigurationResponseSchema,
  OperatorErrorResponseSchema,
  OperatorQueueRunSchema,
  OperatorSessionResponseSchema,
  QueueResponseSchema,
  ReturnToTodoRequestSchema,
  ReturnToTodoResponseSchema,
  ReviewResponseSchema,
  type SchedulerControlPatch,
  SchedulerControlPatchSchema,
  SchedulerControlResponseSchema,
} from "@wheelsparrow/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Value } from "typebox/value";
import type { DatabaseConnection } from "../database/connection.js";
import type {
  ApprovalRecord,
  FindingRecord,
  StepRecord,
} from "../database/runs.js";
import {
  listEvents,
  RunNotFoundError,
  type RunRecord,
  readRun,
  readSchedulerControl,
  type SchedulerControl,
  StaleRevisionError,
} from "../database/runs.js";
import type { WorkflowCoordinator } from "../workflow/coordinator.js";
import { InvalidTransitionError } from "../workflow/state.js";
import {
  projectConfiguration,
  projectQueue,
  projectReview,
  projectRunDetail,
} from "./projections.js";
import {
  createOperatorSecurity,
  OPERATOR_SCHEMA_VERSION,
  type OperatorSecurityOptions,
} from "./security.js";

export interface OperatorRoutesOptions extends OperatorSecurityOptions {
  connection: DatabaseConnection;
  coordinator: WorkflowCoordinator;
  /** Effective validated configuration; only safe fields are projected. */
  configuration: unknown;
  /** Read-only projection of the current GitHub discovery result. */
  discoverReady?: () => Promise<readonly OperatorQueueRun[]>;
}

export interface OperatorRoutesHandle {
  readonly csrfToken: string;
  notifySnapshotChanged(): void;
}

const OPERATOR_ROOT = "/api/operator";

interface ErrorBody {
  schema_version: typeof OPERATOR_SCHEMA_VERSION;
  error: { code: string; message: string };
}

function errorBody(code: string, message: string): ErrorBody {
  return {
    schema_version: OPERATOR_SCHEMA_VERSION,
    error: { code, message },
  };
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send(errorBody(code, message));
}

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof Error && error.name === "OperatorSecurityError")
    return sendError(
      reply,
      403,
      "csrf_forbidden",
      "The request origin or CSRF token is invalid.",
    );
  if (error instanceof RunNotFoundError)
    return sendError(
      reply,
      404,
      "not_found",
      "The requested run was not found.",
    );
  if (error instanceof StaleRevisionError)
    return sendError(
      reply,
      409,
      "revision_conflict",
      "The durable snapshot is stale; refresh and retry.",
    );
  if (error instanceof InvalidTransitionError)
    return sendError(
      reply,
      409,
      "state_conflict",
      "The requested command is not valid for the current run state.",
    );
  if (error instanceof TypeError || error instanceof RangeError)
    return sendError(
      reply,
      400,
      "invalid_request",
      "The request could not be accepted.",
    );
  return sendError(
    reply,
    503,
    "capability_unavailable",
    "The operator capability is unavailable.",
  );
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: row.id as string,
    repository: row.repository as string,
    projectItemId: row.project_item_id as string,
    issueNodeId: row.issue_node_id as string,
    issueNumber: row.issue_number as number,
    intakeJson: row.intake_json as string | null,
    state: row.state as RunRecord["state"],
    revision: row.revision as number,
    reworkEpoch: row.rework_epoch as number,
    repairRound: row.repair_round as number,
    ownerToken: row.owner_token as string | null,
    ownershipReleasedAt: row.ownership_released_at as string | null,
    stopRequestedAt: row.stop_requested_at as string | null,
    baseSha: row.base_sha as string | null,
    headSha: row.head_sha as string | null,
    approvedHeadSha: row.approved_head_sha as string | null,
    observedBaseSha: row.observed_base_sha as string | null,
    mergeSha: row.merge_sha as string | null,
    worktreePath: row.worktree_path as string | null,
    baseBranch: row.base_branch as string,
    branch: row.branch as string | null,
    pullRequestNumber: row.pull_request_number as number | null,
    pullRequestNodeId: row.pull_request_node_id as string | null,
    pullRequestTitle: row.pull_request_title as string | null,
    pullRequestUrl: row.pull_request_url as string | null,
    requiredAction: row.required_action as string | null,
    lastFailureJson: row.last_failure_json as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    startedAt: row.started_at as string | null,
    handedOffAt: row.handed_off_at as string | null,
    terminalAt: row.terminal_at as string | null,
  };
}

async function listRuns(connection: DatabaseConnection): Promise<RunRecord[]> {
  const rows = await connection.db
    .selectFrom("runs")
    .selectAll()
    .orderBy("issue_number", "asc")
    .orderBy("id", "asc")
    .execute();
  return rows.map((row) => mapRun(row));
}

async function readDetailRecords(
  connection: DatabaseConnection,
  runId: string,
) {
  const [events, steps, findings, approvals] = await Promise.all([
    listEvents(connection.db, runId),
    connection.db
      .selectFrom("steps")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("started_at", "asc")
      .execute(),
    connection.db
      .selectFrom("findings")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at", "asc")
      .execute(),
    connection.db
      .selectFrom("approvals")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at", "asc")
      .execute(),
  ]);

  return {
    events,
    steps: steps.map(
      (row): StepRecord => ({
        id: row.id,
        runId: row.run_id,
        reworkEpoch: row.rework_epoch,
        role: row.role,
        logicalStep: row.logical_step,
        attempt: row.attempt,
        statusSequence: row.status_sequence,
        status: row.status,
        promptHash: row.prompt_hash,
        model: row.model,
        reasoningEffort: row.reasoning_effort,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        exitResultJson: row.exit_result_json,
        summary: row.summary,
        rawLogReference: row.raw_log_reference,
      }),
    ),
    findings: findings.map(
      (row): FindingRecord => ({
        id: row.id,
        runId: row.run_id,
        reworkEpoch: row.rework_epoch,
        reviewStepId: row.review_step_id,
        stableKey: row.stable_key,
        dispositionSequence: row.disposition_sequence,
        severity: row.severity,
        evidence: row.evidence,
        disposition: row.disposition,
        resolvingStepId: row.resolving_step_id,
        createdAt: row.created_at,
      }),
    ),
    approvals: approvals.map(
      (row): ApprovalRecord => ({
        id: row.id,
        runId: row.run_id,
        operator: row.operator,
        approvedHeadSha: row.approved_head_sha,
        observedBaseSha: row.observed_base_sha,
        decision: row.decision,
        invalidationReason: row.invalidation_reason,
        createdAt: row.created_at,
      }),
    ),
  };
}

function parseRunId(request: FastifyRequest): string {
  const runId = (request.params as { runId?: unknown }).runId;
  if (
    typeof runId !== "string" ||
    runId.trim().length === 0 ||
    runId.length > 512
  )
    throw new TypeError("Run ID is invalid.");
  return runId;
}

function returnTodoRequest(request: FastifyRequest, runId: string) {
  if (!Value.Check(ReturnToTodoRequestSchema, request.body))
    throw new TypeError("The return-to-todo request is invalid.");
  const body = request.body as ReturnToTodoRequest;
  return {
    runId,
    expectedRevision: body.expected_revision,
    feedback: body.feedback,
  };
}

function schedulerRequest(request: FastifyRequest): SchedulerControlPatch {
  const body = request.body;
  if (!Value.Check(SchedulerControlPatchSchema, body))
    throw new TypeError("The scheduler request is invalid.");
  return body as SchedulerControlPatch;
}

function schedulerProjection(control: SchedulerControl) {
  return {
    schema_version: OPERATOR_SCHEMA_VERSION,
    scheduler: {
      revision: control.revision,
      paused: control.paused,
      stop_after_current: control.stopAfterCurrent,
      updated_at: control.updatedAt,
    },
  };
}

export function registerOperatorRoutes(
  app: FastifyInstance,
  options: OperatorRoutesOptions,
): OperatorRoutesHandle {
  const security = createOperatorSecurity(options);
  const clients = new Set<ServerResponse>();
  const notificationPayload = (): string =>
    `data: ${JSON.stringify({
      schema_version: OPERATOR_SCHEMA_VERSION,
      kind: "snapshot_changed",
    })}\n\n`;

  const removeClient = (client: ServerResponse, destroy = false): void => {
    clients.delete(client);
    if (destroy && !client.destroyed) client.destroy();
  };

  const notifySnapshotChanged = (): void => {
    const payload = notificationPayload();
    for (const client of clients) {
      if (client.destroyed || client.writableEnded || !client.writable) {
        removeClient(client);
        continue;
      }
      try {
        client.write(payload);
      } catch {
        removeClient(client, true);
      }
    }
  };
  // Workflow adapters are deliberately outside the HTTP layer. A bounded
  // notification heartbeat lets browser snapshots converge after those
  // durable changes without carrying a replayable event log over SSE.
  const heartbeat = setInterval(notifySnapshotChanged, 5_000);
  heartbeat.unref();
  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    for (const client of clients) removeClient(client, true);
  });

  app.get(
    `${OPERATOR_ROOT}/session`,
    { schema: { response: { 200: OperatorSessionResponseSchema } } },
    async (_, reply) => {
      reply.header("x-csrf-token", security.csrfToken);
      reply.header(
        "set-cookie",
        `ws_csrf=${security.csrfToken}; Path=${OPERATOR_ROOT}; HttpOnly; SameSite=Strict`,
      );
      return {
        schema_version: OPERATOR_SCHEMA_VERSION,
        csrf_token: security.csrfToken,
      };
    },
  );

  app.get(
    `${OPERATOR_ROOT}/queue`,
    {
      schema: {
        response: {
          200: QueueResponseSchema,
          400: OperatorErrorResponseSchema,
          503: OperatorErrorResponseSchema,
        },
      },
    },
    async (_, reply) => {
      try {
        if (options.discoverReady === undefined)
          throw new Error("Ready discovery is unavailable.");
        const [scheduler, runs] = await Promise.all([
          readSchedulerControl(options.connection.db),
          listRuns(options.connection),
        ]);
        const discoveredReady = await options.discoverReady();
        if (
          !discoveredReady.every((item) =>
            Value.Check(OperatorQueueRunSchema, item),
          )
        )
          throw new Error("Ready discovery returned an invalid projection.");
        return projectQueue({ scheduler, runs, discoveredReady });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.get(
    `${OPERATOR_ROOT}/review`,
    {
      schema: {
        response: {
          200: ReviewResponseSchema,
          503: OperatorErrorResponseSchema,
        },
      },
    },
    async (_, reply) => {
      try {
        const runs = await listRuns(options.connection);
        const findings = new Map<string, FindingRecord[]>();
        const approvals = new Map<string, ApprovalRecord[]>();
        for (const run of runs) {
          const records = await readDetailRecords(options.connection, run.id);
          findings.set(run.id, records.findings);
          approvals.set(run.id, records.approvals);
        }
        return projectReview({ runs, findings, approvals });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.get(
    `${OPERATOR_ROOT}/configuration`,
    {
      schema: {
        response: {
          200: ConfigurationResponseSchema,
          503: OperatorErrorResponseSchema,
        },
      },
    },
    async (_, reply) => {
      try {
        return projectConfiguration(options.configuration);
      } catch (error) {
        if (error instanceof TypeError) return handleError(error, reply);
        return sendError(
          reply,
          503,
          "capability_unavailable",
          "The configuration capability is unavailable.",
        );
      }
    },
  );

  app.get(
    `${OPERATOR_ROOT}/runs/:runId`,
    {
      schema: {
        response: {
          200: ReturnToTodoResponseSchema,
          400: OperatorErrorResponseSchema,
          404: OperatorErrorResponseSchema,
          503: OperatorErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const runId = parseRunId(request);
        const [run, records] = await Promise.all([
          readRun(options.connection.db, runId),
          readDetailRecords(options.connection, runId),
        ]);
        return projectRunDetail(run, records);
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.patch(
    `${OPERATOR_ROOT}/scheduler`,
    {
      schema: {
        body: SchedulerControlPatchSchema,
        response: {
          200: SchedulerControlResponseSchema,
          400: OperatorErrorResponseSchema,
          403: OperatorErrorResponseSchema,
          409: OperatorErrorResponseSchema,
          503: OperatorErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        security.checkMutation(request);
        const patch = schedulerRequest(request);
        const scheduler = await options.coordinator.updateSchedulerControl({
          expectedRevision: patch.expected_revision,
          patch: {
            ...(patch.paused === undefined ? {} : { paused: patch.paused }),
            ...(patch.stop_after_current === undefined
              ? {}
              : { stopAfterCurrent: patch.stop_after_current }),
          },
          at: new Date().toISOString(),
        });
        notifySnapshotChanged();
        return schedulerProjection(scheduler);
      } catch (error) {
        if (error instanceof Error && error.name === "OperatorSecurityError")
          return sendError(
            reply,
            403,
            "csrf_forbidden",
            "The request origin or CSRF token is invalid.",
          );
        return handleError(error, reply);
      }
    },
  );

  app.post(
    `${OPERATOR_ROOT}/runs/:runId/return-to-todo`,
    {
      schema: {
        body: ReturnToTodoRequestSchema,
        response: {
          200: ReturnToTodoResponseSchema,
          400: OperatorErrorResponseSchema,
          403: OperatorErrorResponseSchema,
          404: OperatorErrorResponseSchema,
          409: OperatorErrorResponseSchema,
          503: OperatorErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        security.checkMutation(request);
        const runId = parseRunId(request);
        const command = returnTodoRequest(request, runId);
        const run = await options.coordinator.returnToTodo({
          ...command,
          at: new Date().toISOString(),
        });
        notifySnapshotChanged();
        return projectRunDetail(run);
      } catch (error) {
        if (error instanceof Error && error.name === "OperatorSecurityError")
          return sendError(
            reply,
            403,
            "csrf_forbidden",
            "The request origin or CSRF token is invalid.",
          );
        return handleError(error, reply);
      }
    },
  );

  app.get(`${OPERATOR_ROOT}/events`, async (request, reply) => {
    try {
      security.checkEvent(request);
      reply.hijack();
      reply.raw.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      });
      reply.raw.write(notificationPayload());
      clients.add(reply.raw);
      request.raw.once("close", () => removeClient(reply.raw));
      request.raw.once("error", () => removeClient(reply.raw, true));
    } catch (error) {
      return handleError(error, reply);
    }
  });

  return { csrfToken: security.csrfToken, notifySnapshotChanged };
}
