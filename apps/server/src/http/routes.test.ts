import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type OperatorQueueRun,
  ReturnToTodoRequestSchema,
} from "@wheelsparrow/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, test } from "vitest";
import { buildApp } from "../app.js";

import {
  type DatabaseConnection,
  openDatabase,
} from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import { createReadinessGate } from "../readiness.js";
import { WorkflowCoordinator } from "../workflow/coordinator.js";
import { registerOperatorRoutes } from "./routes.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: DatabaseConnection[] = [];
const apps: FastifyInstance[] = [];

const configuration = {
  github: {
    owner: "owner",
    repository: "repository",
    project_number: 1,
    status_field: "Status",
    lanes: { ready: "Ready", todo: "Todo", review: "Review", done: "Done" },
    required_labels: ["agent-ready"],
    priority_field: "Priority",
  },
  poll_interval_seconds: 60,
  workspace_root: ".wheelsparrow/workspaces",
  agent: {
    command: "codex",
    model: "gpt-5.6",
    reasoning_effort: "xhigh",
    timeout_minutes: 30,
  },
  verification: { command: "pnpm test" },
  staging: {
    workflow: "deploy.yml",
    environment: "staging",
    smoke_command: "pnpm smoke",
  },
};

async function createDatabase(): Promise<DatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-routes-"));
  directories.push(directory);
  const migrationsDirectory = join(directory, "migrations");
  await cp(migrationSource, migrationsDirectory, { recursive: true });
  const connection = openDatabase(join(directory, "wheelsparrow.sqlite3"));
  migrateDatabase(connection, migrationsDirectory);
  connections.push(connection);
  return connection;
}

async function createApp() {
  const connection = await createDatabase();
  const coordinator = new WorkflowCoordinator({
    connection,
    ownerToken: "route-test-owner",
  });
  let routes!: ReturnType<typeof registerOperatorRoutes>;
  const app = await buildApp({
    readiness: createReadinessGate(),
    registerOperator: async (server) => {
      routes = registerOperatorRoutes(server, {
        connection,
        configuration,
        coordinator,
        origin: "http://localhost:4321",
        discoverReady: async () => [
          {
            run_id: "priority-1-issue-99",
            issue_number: 99,
            repository: "owner/repository",
            state: "claiming",
            revision: 0,
            rework_epoch: 0,
            repair_round: 0,
            branch: null,
            pull_request_number: null,
            pull_request_title: null,
            pull_request_url: null,
            required_action: null,
            blocked_reason: null,
            updated_at: "2026-08-09T10:00:00.000Z",
          } satisfies OperatorQueueRun,
          {
            run_id: "priority-2-issue-1",
            issue_number: 1,
            repository: "owner/repository",
            state: "claiming",
            revision: 0,
            rework_epoch: 0,
            repair_round: 0,
            branch: null,
            pull_request_number: null,
            pull_request_title: null,
            pull_request_url: null,
            required_action: null,
            blocked_reason: "blocked_dependency_open",
            updated_at: "2026-08-09T10:00:00.000Z",
          } satisfies OperatorQueueRun,
        ],
      });
    },
  });
  apps.push(app);
  return { app, coordinator, routes, connection };
}

function insertReviewRun(connection: DatabaseConnection, id = "run-1") {
  connection.native
    .prepare(
      `INSERT INTO runs (
        id, repository, project_item_id, issue_node_id, issue_number,
        intake_json, state, revision, rework_epoch, repair_round,
        owner_token, ownership_released_at, stop_requested_at,
        base_sha, head_sha, approved_head_sha, observed_base_sha, merge_sha,
        worktree_path, base_branch, branch, pull_request_number,
        pull_request_node_id, pull_request_title, pull_request_url,
        required_action, last_failure_json, created_at, updated_at,
        started_at, handed_off_at, terminal_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL,
        NULL, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, NULL, NULL, NULL)`,
    )
    .run(
      id,
      "owner/repository",
      `project-${id}`,
      `issue-${id}`,
      42,
      null,
      "review",
      3,
      0,
      0,
      "owner-secret",
      "a".repeat(40),
      "b".repeat(40),
      "main",
      `codex/${id}`,
      "Approve exact head.",
      "2026-08-09T10:00:00.000Z",
      "2026-08-09T10:00:00.000Z",
    );
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const connection of connections.splice(0)) await connection.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("operator routes", () => {
  test("returns a per-process session token and a redacted queue snapshot", async () => {
    const { app, routes, connection } = await createApp();
    insertReviewRun(connection);

    const session = await app.inject({
      method: "GET",
      url: "/api/operator/session",
    });
    const queue = await app.inject({
      method: "GET",
      url: "/api/operator/queue",
    });

    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ schema_version: 1 });
    expect(session.json().csrf_token).toBe(routes.csrfToken);
    expect(session.headers["x-csrf-token"]).toBe(routes.csrfToken);
    expect(session.headers["set-cookie"]).toContain("ws_csrf=");
    expect(queue.statusCode).toBe(200);
    expect(queue.json().review[0]).toMatchObject({
      run_id: "run-1",
      state: "review",
    });
    expect(queue.body).not.toContain("owner-secret");
    expect(queue.body).not.toContain("project-run-1");
    expect(
      queue.json().ready.map((item: OperatorQueueRun) => item.issue_number),
    ).toEqual([99, 1]);
    expect(queue.json().ready[1].blocked_reason).toBe(
      "blocked_dependency_open",
    );
  });

  test("returns a versioned malformed JSON error", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/operator/scheduler",
      headers: {
        origin: "http://localhost:4321",
        "content-type": "application/json",
      },
      payload: '{"schema_version":1',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      schema_version: 1,
      error: { code: "invalid_request" },
    });
  });

  test("uses the contract for Return-to-Todo requests", async () => {
    expect(ReturnToTodoRequestSchema).toBeDefined();
    const { app, routes, connection } = await createApp();
    insertReviewRun(connection);
    const response = await app.inject({
      method: "POST",
      url: "/api/operator/runs/run-1/return-to-todo",
      headers: {
        origin: "http://localhost:4321",
        "x-csrf-token": routes.csrfToken,
      },
      payload: {
        schema_version: 1,
        expected_revision: 3,
        feedback: "",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("requires same-origin and CSRF for scheduler mutations", async () => {
    const { app, routes } = await createApp();
    const body = {
      schema_version: 1,
      expected_revision: 0,
      paused: true,
    };

    const missingToken = await app.inject({
      method: "PATCH",
      url: "/api/operator/scheduler",
      headers: { origin: "http://localhost:4321" },
      payload: body,
    });
    const wrongOrigin = await app.inject({
      method: "PATCH",
      url: "/api/operator/scheduler",
      headers: {
        origin: "https://evil.example",
        "x-csrf-token": routes.csrfToken,
      },
      payload: body,
    });

    expect(missingToken.statusCode).toBe(403);
    expect(wrongOrigin.statusCode).toBe(403);
    expect(missingToken.json()).toMatchObject({
      schema_version: 1,
      error: { code: "csrf_forbidden" },
    });
  });

  test("maps stale scheduler revisions to a versioned conflict", async () => {
    const { app, routes } = await createApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/operator/scheduler",
      headers: {
        origin: "http://localhost:4321",
        "x-csrf-token": routes.csrfToken,
      },
      payload: {
        schema_version: 1,
        expected_revision: 99,
        paused: true,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      schema_version: 1,
      error: { code: "revision_conflict" },
    });
  });

  test("serves run, review, and configuration snapshots through redacted projections", async () => {
    const { app, connection } = await createApp();
    insertReviewRun(connection);

    const run = await app.inject({
      method: "GET",
      url: "/api/operator/runs/run-1",
    });
    const review = await app.inject({
      method: "GET",
      url: "/api/operator/review",
    });
    const config = await app.inject({
      method: "GET",
      url: "/api/operator/configuration",
    });

    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      schema_version: 1,
      run: { run_id: "run-1", state: "review" },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().items).toHaveLength(1);
    expect(config.statusCode).toBe(200);
    expect(config.json().configuration.github.repository).toBe("repository");
    expect(run.body).not.toContain("owner-secret");
  });

  test("returns a review run to todo through the coordinator", async () => {
    const { app, routes, connection } = await createApp();
    insertReviewRun(connection);
    const response = await app.inject({
      method: "POST",
      url: "/api/operator/runs/run-1/return-to-todo",
      headers: {
        origin: "http://localhost:4321",
        "x-csrf-token": routes.csrfToken,
      },
      payload: {
        schema_version: 1,
        expected_revision: 3,
        feedback: "Please address the review findings.",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schema_version: 1,
      run: { run_id: "run-1", state: "returning_to_todo", revision: 4 },
    });
  });

  test("rejects missing runs and exposes no delivery mutation endpoints", async () => {
    const { app } = await createApp();
    const missing = await app.inject({
      method: "GET",
      url: "/api/operator/runs/missing",
    });
    const merge = await app.inject({
      method: "POST",
      url: "/api/operator/runs/run-1/approve",
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      schema_version: 1,
      error: { code: "not_found" },
    });
    expect(merge.statusCode).toBe(404);
  });

  test("requires CSRF and same-origin for SSE connections", async () => {
    const { app, routes } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/operator/events",
      headers: { origin: "http://localhost:4321" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      schema_version: 1,
      error: { code: "csrf_forbidden" },
    });
    expect(routes.csrfToken).toHaveLength(43);
  });
});
