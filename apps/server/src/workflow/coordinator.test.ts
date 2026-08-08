import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import { openDatabase } from "../database/connection.js";
import { StaleEffectError } from "../database/effects.js";
import { migrateDatabase } from "../database/migrate.js";
import { listEvents, readRun, StaleRevisionError } from "../database/runs.js";
import {
  CoordinatorClosedError,
  type CoordinatorError,
  WorkflowCoordinator,
} from "./coordinator.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
const databasePaths = new WeakMap<ReturnType<typeof openDatabase>, string>();
const firstAt = "2026-08-08T19:00:00.000Z";

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-coordinator-"));
  directories.push(directory);
  const migrationsDirectory = join(directory, "migrations");
  await cp(migrationSource, migrationsDirectory, { recursive: true });
  const databasePath = join(directory, "wheelsparrow.sqlite3");
  const connection = openDatabase(databasePath);
  migrateDatabase(connection, migrationsDirectory);
  connections.push(connection);
  databasePaths.set(connection, databasePath);
  return connection;
}

function openSibling(
  connection: ReturnType<typeof openDatabase>,
): ReturnType<typeof openDatabase> {
  const databasePath = databasePaths.get(connection);
  if (databasePath === undefined)
    throw new Error("Missing test database path.");
  const sibling = openDatabase(databasePath);
  connections.push(sibling);
  return sibling;
}

function claimInput(id = "run-1") {
  return {
    id,
    repository: "owner/repository",
    projectItemId: `project-${id}`,
    issueNodeId: `issue-${id}`,
    issueNumber: id === "run-1" ? 1 : 2,
    ownerToken: `owner-${id}`,
    at: firstAt,
    summary: { text: `Claim ${id}.` },
  };
}

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("workflow coordinator", () => {
  test("serializes FIFO transitions and survives a rejected command", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({
      connection,
      ownerToken: "coord-1",
    });
    await coordinator.createClaim(claimInput());

    const rejected = coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "workspace_prepared",
      at: "2026-08-08T19:01:00.000Z",
      summary: { text: "This is intentionally stale and illegal." },
    });
    const accepted = coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-08T19:02:00.000Z",
      summary: { text: "Move into preparation." },
    });

    await expect(rejected).rejects.toThrow();
    await expect(accepted).resolves.toMatchObject({
      state: "preparing",
      revision: 2,
    });
    expect(await listEvents(connection.db, "run-1")).toHaveLength(2);
    await coordinator.close();
  });

  test("rejects submissions after close while draining accepted work", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({
      connection,
      ownerToken: "coord-2",
    });
    await coordinator.createClaim(claimInput());
    const queued = coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-08T19:01:00.000Z",
      summary: { text: "Accepted before close." },
    });
    const closing = coordinator.close();
    await expect(
      coordinator.transition({
        runId: "run-1",
        expectedRevision: 2,
        trigger: "workspace_prepared",
        at: "2026-08-08T19:02:00.000Z",
        summary: { text: "Rejected after close." },
      }),
    ).rejects.toBeInstanceOf(CoordinatorClosedError);
    await expect(queued).resolves.toMatchObject({ state: "preparing" });
    await closing;
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "preparing",
      revision: 2,
    });
  });

  test("commits an effect intent before invoking the executor and records its callback through FIFO", async () => {
    const connection = await createDatabase();
    const statusAtDispatch: string[] = [];
    const dispatch = vi.fn((effect, complete) => {
      statusAtDispatch.push(
        (
          connection.native
            .prepare("SELECT status FROM side_effects WHERE key = ?")
            .get(effect.key) as { status: string }
        ).status,
      );
      complete({
        outcome: "confirmed",
        trigger: "todo_observed",
        receipt: { projectItemId: "project-run-1" },
        evidence: "Project item moved to Todo.",
      });
    });
    const coordinator = new WorkflowCoordinator({
      connection,
      ownerToken: "coord-effects",
      dispatcher: dispatch,
    });
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      key: "run:run-1:project:todo",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await coordinator.waitForIdle();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(statusAtDispatch).toEqual(["in_flight"]);
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "preparing",
      revision: 2,
    });
    expect(
      (
        connection.native
          .prepare(
            "SELECT status, receipt_json FROM side_effects WHERE key = ?",
          )
          .get("run:run-1:project:todo") as {
          status: string;
          receipt_json: string;
        }
      ).status,
    ).toBe("confirmed");
    await coordinator.close();
  });

  test("makes a claim and its effect intent visible to a second SQLite connection before dispatch", async () => {
    const connection = await createDatabase();
    const sibling = openSibling(connection);
    const statusAtDispatch: string[] = [];
    const dispatch = vi.fn((effect, complete) => {
      statusAtDispatch.push(
        (
          sibling.native
            .prepare("SELECT status FROM side_effects WHERE key = ?")
            .get(effect.key) as { status: string }
        ).status,
      );
      complete({
        outcome: "confirmed",
        trigger: "todo_observed",
        evidence: "Sibling connection saw the committed intent.",
      });
    });
    const coordinator = new WorkflowCoordinator({
      connection,
      ownerToken: "coord-sibling",
      dispatcher: dispatch,
    });
    await coordinator.createClaim(claimInput(), {
      effect: {
        key: "run:run-1:claim-todo",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });
    await coordinator.waitForIdle();
    expect(statusAtDispatch).toEqual(["in_flight"]);
    await coordinator.close();
  });

  test("rolls back a claim when its same-transaction effect intent is invalid", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await expect(
      coordinator.createClaim(claimInput(), {
        effect: {
          key: "run:run-1:invalid",
          kind: "project_todo",
          intent: undefined,
        },
      }),
    ).rejects.toThrow(/intent/i);
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM runs WHERE id = ?")
        .get("run-1"),
    ).toEqual({ count: 0 });
    expect(
      connection.native
        .prepare("SELECT COUNT(*) AS count FROM side_effects WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ count: 0 });
    await coordinator.close();
  });

  test("replays an existing confirmed intent idempotently without redispatch", async () => {
    const connection = await createDatabase();
    const dispatch = vi.fn((_, complete) => {
      complete({
        outcome: "confirmed",
        trigger: "todo_observed",
        evidence: "Already moved to Todo.",
      });
    });
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: dispatch,
    });
    await coordinator.createClaim(claimInput());
    const intent = {
      runId: "run-1",
      key: "run:run-1:replay",
      kind: "project_todo" as const,
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    };
    await coordinator.createEffectIntent(intent);
    await coordinator.waitForIdle();
    const replay = await coordinator.createEffectIntent(intent);
    expect(replay.inserted).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  test("rejects an explicit stale revision before replaying an existing intent", async () => {
    const connection = await createDatabase();
    const dispatch = vi.fn((_, complete) => {
      complete({
        outcome: "confirmed",
        trigger: "todo_observed",
        evidence: "Initial dispatch confirmed.",
      });
    });
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: dispatch,
    });
    await coordinator.createClaim(claimInput());
    const intent = {
      runId: "run-1",
      key: "run:run-1:stale-replay",
      kind: "project_todo" as const,
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    };
    await coordinator.createEffectIntent(intent);
    await coordinator.waitForIdle();
    await expect(
      coordinator.createEffectIntent({ ...intent, expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(StaleRevisionError);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "preparing",
      revision: 2,
    });
    await coordinator.close();
  });

  test("starts an exact replay only when the existing intent is still pending", async () => {
    const connection = await createDatabase();
    const dispatch = vi.fn((_, complete) => {
      complete({
        outcome: "confirmed",
        trigger: "todo_observed",
        evidence: "Replay dispatch confirmed.",
      });
    });
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: dispatch,
    });
    await coordinator.createClaim(claimInput());
    const intent = {
      runId: "run-1",
      key: "run:run-1:pending-replay",
      kind: "project_todo" as const,
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    };
    await coordinator.createEffectIntent({ ...intent, dispatch: false });
    const replay = await coordinator.createEffectIntent(intent);
    expect(replay.inserted).toBe(false);
    await coordinator.waitForIdle();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(
      (
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get(intent.key) as { status: string }
      ).status,
    ).toBe("confirmed");
    await coordinator.close();
  });

  test("does not dispatch an exact replay while the original effect is in flight", async () => {
    const connection = await createDatabase();
    let complete:
      | ((result: {
          outcome: "confirmed";
          trigger: "todo_observed";
          evidence: string;
        }) => void)
      | undefined;
    const dispatch = vi.fn((_, callback) => {
      complete = callback;
    });
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: dispatch,
    });
    await coordinator.createClaim(claimInput());
    const intent = {
      runId: "run-1",
      key: "run:run-1:in-flight-replay",
      kind: "project_todo" as const,
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    };
    await coordinator.createEffectIntent(intent);
    const replay = await coordinator.createEffectIntent(intent);
    expect(replay.inserted).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    complete?.({
      outcome: "confirmed",
      trigger: "todo_observed",
      evidence: "Original in-flight dispatch confirmed.",
    });
    await coordinator.waitForIdle();
    await coordinator.close();
  });

  test("quarantines a queued confirmation before it can prepare the run", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const key = "run:run-1:queued-confirmation";
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key,
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await coordinator.beginEffect({ effectKey: key });

    const confirmation = coordinator.observeEffect({
      runId: "run-1",
      expectedRevision: 1,
      effectKey: key,
      outcome: "confirmed",
      trigger: "todo_observed",
      evidence: "Queued confirmation must be quarantined.",
    });
    const abandonment = coordinator.abandonEffect({
      runId: "run-1",
      expectedRevision: 1,
      effectKey: key,
      outcome: "ambiguous",
      trigger: null,
      evidence: "Quarantined before queued confirmation.",
    });

    await coordinator.waitForIdle();
    await expect(abandonment).resolves.toMatchObject({ status: "ambiguous" });
    await expect(confirmation).rejects.toThrow();
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(key),
    ).toEqual({ status: "ambiguous" });
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "claiming",
      revision: 1,
    });
    await coordinator.close();
  });

  test("does not drop a callback when a stale quarantine request fails", async () => {
    const connection = await createDatabase();
    let complete: ((result: unknown) => void) | undefined;
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: (_, callback) => {
        complete = callback;
      },
    });
    const key = "run:run-1:stale-quarantine";
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key,
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await coordinator.beginEffect({ effectKey: key });

    const abandonment = coordinator.abandonEffect({
      runId: "run-1",
      expectedRevision: 0,
      effectKey: key,
      outcome: "ambiguous",
      trigger: null,
      evidence: "Stale quarantine request.",
    });
    complete?.({
      outcome: "confirmed",
      trigger: "todo_observed",
      evidence: "Valid callback after stale quarantine request.",
    });

    await expect(abandonment).rejects.toThrow();
    await coordinator.waitForIdle();
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get(key),
    ).toEqual({ status: "confirmed" });
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "preparing",
      revision: 2,
    });
    await coordinator.close();
  });

  test("allows ordinary ambiguous evidence with the quarantine prefix to confirm", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const key = "run:run-1:ordinary-ambiguous";
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key,
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await coordinator.beginEffect({ effectKey: key });

    await coordinator.observeEffect({
      runId: "run-1",
      expectedRevision: 1,
      effectKey: key,
      outcome: "ambiguous",
      trigger: null,
      evidence: "Quarantined effect: ordinary ambiguity, not a quarantine.",
    });
    await expect(
      coordinator.observeEffect({
        runId: "run-1",
        expectedRevision: 1,
        effectKey: key,
        outcome: "confirmed",
        trigger: "todo_observed",
        evidence: "Ordinary ambiguity was later confirmed.",
      }),
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "preparing",
      revision: 2,
    });
    await coordinator.close();
  });

  test("rejects a stale pending effect without dispatching it", async () => {
    const connection = await createDatabase();
    const dispatch = vi.fn();
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: dispatch,
    });
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      expectedRevision: 1,
      dispatch: false,
      key: "run:run-1:stale",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-08T19:01:00.000Z",
      summary: { text: "Advance the run before dispatch." },
    });
    await expect(
      coordinator.beginEffect({
        effectKey: "run:run-1:stale",
        at: "2026-08-08T19:02:00.000Z",
      }),
    ).rejects.toBeInstanceOf(StaleEffectError);
    expect(dispatch).not.toHaveBeenCalled();
    await coordinator.close();
  });

  test("keeps the coding slot invariant in the database", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput("run-1"));
    await expect(coordinator.createClaim(claimInput("run-2"))).rejects.toThrow(
      /coding execution slot/i,
    );
    await coordinator.close();
  });

  test("versions scheduler controls and retains FIFO after stale control rejection", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    const stale = coordinator.updateSchedulerControl({
      expectedRevision: 0,
      patch: { stopAfterCurrent: true },
      at: "2026-08-08T19:01:00.000Z",
    });
    const first = coordinator.updateSchedulerControl({
      expectedRevision: 0,
      patch: { paused: true },
      at: "2026-08-08T19:02:00.000Z",
    });
    await expect(stale).resolves.toMatchObject({
      revision: 1,
      stopAfterCurrent: true,
    });
    await expect(first).rejects.toBeInstanceOf(StaleRevisionError);
    await expect(
      coordinator.updateSchedulerControl({
        expectedRevision: 1,
        patch: { paused: true },
        at: "2026-08-08T19:03:00.000Z",
      }),
    ).resolves.toMatchObject({
      revision: 2,
      paused: true,
      stopAfterCurrent: true,
    });
    await coordinator.close();
  });

  test("marks this coordinator's in-flight effects ambiguous on close with run evidence", async () => {
    const connection = await createDatabase();
    const complete = vi.fn();
    const coordinator = new WorkflowCoordinator({
      connection,
      ownerToken: "coord-close",
    });
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key: "run:run-1:close",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await coordinator.beginEffect({
      effectKey: "run:run-1:close",
      at: "2026-08-08T19:01:00.000Z",
    });
    await coordinator.close();

    expect(
      (
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get("run:run-1:close") as { status: string }
      ).status,
    ).toBe("ambiguous");
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      revision: 2,
      state: "claiming",
    });
    expect((await listEvents(connection.db, "run-1")).at(-1)).toMatchObject({
      kind: "effect_ambiguous",
      runRevision: 2,
    });
    await expect(
      coordinator.beginEffect({ effectKey: "run:run-1:close" }),
    ).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });

  test("records cancellation for a pending effect without dispatch", async () => {
    const connection = await createDatabase();
    const dispatch = vi.fn();
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: dispatch,
    });
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key: "run:run-1:cancel",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await coordinator.cancelEffect({
      effectKey: "run:run-1:cancel",
      expectedRevision: 1,
      reason: "Operator cancelled before dispatch.",
      at: "2026-08-08T19:01:00.000Z",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      (
        connection.native
          .prepare("SELECT status, failure FROM side_effects WHERE key = ?")
          .get("run:run-1:cancel") as { status: string; failure: string }
      ).status,
    ).toBe("cancelled");
    await coordinator.close();
  });

  test("notifies an effect settlement waiter when cancellation commits", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key: "run:run-1:cancel-waiter",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });

    const settled = coordinator.waitForEffectSettlement(
      "run:run-1:cancel-waiter",
      100,
    );
    await coordinator.cancelEffect({
      effectKey: "run:run-1:cancel-waiter",
      expectedRevision: 1,
      reason: "Canceled before dispatch.",
      at: "2026-08-08T19:01:00.000Z",
    });

    await expect(settled).resolves.toMatchObject({
      key: "run:run-1:cancel-waiter",
      status: "cancelled",
    });
    await coordinator.close();
  });

  test("runs an ambiguous-effect observer outside the transaction and re-enters FIFO", async () => {
    const connection = await createDatabase();
    const first = new WorkflowCoordinator({
      connection,
      ownerToken: "coord-observe-1",
    });
    await first.createClaim(claimInput());
    await first.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key: "run:run-1:observe",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await first.beginEffect({
      effectKey: "run:run-1:observe",
      at: "2026-08-08T19:01:00.000Z",
    });
    await first.close();

    const observedStatuses: string[] = [];
    const second = new WorkflowCoordinator({
      connection,
      ownerToken: "coord-observe-2",
      observer: (effect, complete) => {
        observedStatuses.push(effect.status);
        complete({
          outcome: "confirmed",
          trigger: "todo_observed",
          evidence: "Outside state confirmed.",
        });
      },
    });
    await second.observeAmbiguousEffect({ effectKey: "run:run-1:observe" });
    await second.waitForIdle();
    expect(observedStatuses).toEqual(["ambiguous"]);
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "preparing",
      revision: 3,
    });
    expect(
      (
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get("run:run-1:observe") as { status: string }
      ).status,
    ).toBe("confirmed");
    await second.close();
  });

  test("notifies a concurrent waiter when close marks owned work ambiguous", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({
      connection,
      ownerToken: "coord-close-waiter",
    });
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key: "run:run-1:close-waiter",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await coordinator.beginEffect({
      effectKey: "run:run-1:close-waiter",
      at: "2026-08-08T19:01:00.000Z",
    });

    const settled = coordinator.waitForEffectSettlement(
      "run:run-1:close-waiter",
      100,
    );
    await coordinator.close();

    await expect(settled).resolves.toMatchObject({
      key: "run:run-1:close-waiter",
      status: "ambiguous",
    });
  });

  test("does not invoke the observer for pending or in-flight effects", async () => {
    const connection = await createDatabase();
    const observer = vi.fn();
    const coordinator = new WorkflowCoordinator({ connection, observer });
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key: "run:run-1:pending-observe",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    expect(
      await coordinator.observeAmbiguousEffect({
        effectKey: "run:run-1:pending-observe",
      }),
    ).toBeUndefined();
    expect(observer).not.toHaveBeenCalled();
    await coordinator.close();
  });

  test("rejects a stale explicit ambiguous-observation revision before invoking the observer", async () => {
    const connection = await createDatabase();
    const first = new WorkflowCoordinator({
      connection,
      ownerToken: "coord-stale-observe-1",
    });
    await first.createClaim(claimInput());
    await first.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key: "run:run-1:stale-observe",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await first.beginEffect({
      effectKey: "run:run-1:stale-observe",
      at: "2026-08-08T19:01:00.000Z",
    });
    await first.close();

    const observer = vi.fn();
    const second = new WorkflowCoordinator({
      connection,
      observer,
      ownerToken: "coord-stale-observe-2",
    });
    await expect(
      second.observeAmbiguousEffect({
        effectKey: "run:run-1:stale-observe",
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(StaleRevisionError);
    expect(observer).not.toHaveBeenCalled();
    await second.close();
  });

  test("turns a dispatcher throw into a durable failed observation and legal run transition", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: vi.fn(() => {
        throw new Error("dispatcher unavailable");
      }),
    });
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      key: "run:run-1:dispatch-throw",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await coordinator.waitForIdle();

    expect(
      (
        connection.native
          .prepare("SELECT status, failure FROM side_effects WHERE key = ?")
          .get("run:run-1:dispatch-throw") as {
          status: string;
          failure: string;
        }
      ).status,
    ).toBe("failed");
    expect(
      (
        connection.native
          .prepare("SELECT status, failure FROM side_effects WHERE key = ?")
          .get("run:run-1:dispatch-throw") as {
          status: string;
          failure: string;
        }
      ).failure,
    ).toMatch(/dispatcher unavailable/);
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "claim_failed",
      revision: 2,
    });
    expect((await listEvents(connection.db, "run-1")).at(-1)).toMatchObject({
      kind: "claim_rejected",
      runRevision: 2,
    });
    await coordinator.close();
  });

  test("turns an observer rejection into a durable failed observation and legal run transition", async () => {
    const connection = await createDatabase();
    const first = new WorkflowCoordinator({
      connection,
      ownerToken: "coord-observer-reject-1",
    });
    await first.createClaim(claimInput());
    await first.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key: "run:run-1:observer-reject",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await first.beginEffect({
      effectKey: "run:run-1:observer-reject",
      at: "2026-08-08T19:01:00.000Z",
    });
    await first.close();

    const observer = vi.fn(async () => {
      throw new Error("observer unavailable");
    });
    const second = new WorkflowCoordinator({
      connection,
      ownerToken: "coord-observer-reject-2",
      observer,
    });
    await second.observeAmbiguousEffect({
      effectKey: "run:run-1:observer-reject",
    });
    await second.waitForIdle();

    expect(observer).toHaveBeenCalledTimes(1);
    expect(
      (
        connection.native
          .prepare("SELECT status, failure FROM side_effects WHERE key = ?")
          .get("run:run-1:observer-reject") as {
          status: string;
          failure: string;
        }
      ).status,
    ).toBe("failed");
    expect(
      (
        connection.native
          .prepare("SELECT status, failure FROM side_effects WHERE key = ?")
          .get("run:run-1:observer-reject") as {
          status: string;
          failure: string;
        }
      ).failure,
    ).toMatch(/observer unavailable/);
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "claim_failed",
      revision: 3,
    });
    expect((await listEvents(connection.db, "run-1")).at(-1)).toMatchObject({
      kind: "claim_rejected",
      runRevision: 3,
    });
    await second.close();
  });

  test("reports a stale late callback and makes its in-flight effect ambiguous", async () => {
    const connection = await createDatabase();
    let complete: ((result: unknown) => void) | undefined;
    const errors: CoordinatorError[] = [];
    const coordinator = new WorkflowCoordinator({
      connection,
      ownerToken: "coord-stale-callback",
      onError: (error) => errors.push(error),
      dispatcher: (_, callback) => {
        complete = callback;
      },
    });
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      key: "run:run-1:stale-callback",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-08T19:01:00.000Z",
      summary: { text: "The run advanced before the late callback." },
    });
    complete?.({
      outcome: "confirmed",
      trigger: "todo_observed",
      evidence: "Late external callback.",
    });
    await coordinator.waitForIdle();
    await coordinator.waitForIdle();

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "stale",
          effectKey: "run:run-1:stale-callback",
        }),
      ]),
    );
    expect(
      (
        connection.native
          .prepare(
            "SELECT status, reconciliation_evidence FROM side_effects WHERE key = ?",
          )
          .get("run:run-1:stale-callback") as {
          status: string;
          reconciliation_evidence: string;
        }
      ).status,
    ).toBe("ambiguous");
    expect(
      (
        connection.native
          .prepare(
            "SELECT status, reconciliation_evidence FROM side_effects WHERE key = ?",
          )
          .get("run:run-1:stale-callback") as {
          status: string;
          reconciliation_evidence: string;
        }
      ).reconciliation_evidence,
    ).toMatch(/stale/i);
    await coordinator.close();
  });

  test("normalizes malformed adapter callback payloads into a legal failed observation", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: (_, complete) => {
        complete({
          outcome: "confirmed",
          trigger: { invalid: true },
          evidence: { invalid: true },
          receipt: () => "not JSON",
        } as never);
      },
    });
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      key: "run:run-1:malformed-callback",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await coordinator.waitForIdle();

    expect(
      (
        connection.native
          .prepare("SELECT status, failure FROM side_effects WHERE key = ?")
          .get("run:run-1:malformed-callback") as {
          status: string;
          failure: string;
        }
      ).status,
    ).toBe("failed");
    expect(
      (
        connection.native
          .prepare("SELECT status, failure FROM side_effects WHERE key = ?")
          .get("run:run-1:malformed-callback") as {
          status: string;
          failure: string;
        }
      ).failure,
    ).toMatch(/malformed/i);
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "claim_failed",
      revision: 2,
    });
    await coordinator.close();
  });

  test("scopes stale callback ambiguity to the affected effect key", async () => {
    const connection = await createDatabase();
    const completions = new Map<string, (result: unknown) => void>();
    const coordinator = new WorkflowCoordinator({
      connection,
      ownerToken: "coord-scoped-ambiguity",
      dispatcher: (effect, complete) => {
        completions.set(effect.key, complete);
      },
    });
    await coordinator.createClaim(claimInput());
    for (const key of ["run:run-1:effect-a", "run:run-1:effect-b"]) {
      await coordinator.createEffectIntent({
        runId: "run-1",
        dispatch: false,
        key,
        kind: "project_todo",
        intent: {
          projectItemId: "project-run-1",
          from: "Ready",
          to: "Todo",
          key,
        },
      });
      await coordinator.beginEffect({
        effectKey: key,
        at: "2026-08-08T19:01:00.000Z",
      });
    }
    await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-08T19:02:00.000Z",
      summary: { text: "Advance before effect A reports." },
    });
    completions.get("run:run-1:effect-a")?.({
      outcome: "confirmed",
      trigger: "todo_observed",
      evidence: "Stale callback for effect A.",
    });
    await coordinator.waitForIdle();
    await coordinator.waitForIdle();

    expect(
      (
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get("run:run-1:effect-a") as { status: string }
      ).status,
    ).toBe("ambiguous");
    expect(
      (
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get("run:run-1:effect-b") as { status: string }
      ).status,
    ).toBe("in_flight");
    await coordinator.close();
  });

  test("turns an oversized valid receipt into a durable malformed failure", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: (_, complete) => {
        complete({
          outcome: "confirmed",
          trigger: "todo_observed",
          evidence: "Receipt exceeds durable JSON limit.",
          receipt: "x".repeat(1024 * 1024),
        });
      },
    });
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      key: "run:run-1:oversized-receipt",
      kind: "project_todo",
      intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
    });
    await coordinator.waitForIdle();

    expect(
      (
        connection.native
          .prepare("SELECT status, failure FROM side_effects WHERE key = ?")
          .get("run:run-1:oversized-receipt") as {
          status: string;
          failure: string;
        }
      ).status,
    ).toBe("failed");
    expect(
      (
        connection.native
          .prepare("SELECT status, failure FROM side_effects WHERE key = ?")
          .get("run:run-1:oversized-receipt") as {
          status: string;
          failure: string;
        }
      ).failure,
    ).toMatch(/malformed/i);
    await coordinator.close();
  });

  test("keeps stopped runs terminal and releases the coding slot", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput("run-1"));
    await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "stop_safe",
      at: "2026-08-08T19:01:00.000Z",
      summary: { text: "Operator stopped the run safely." },
    });
    await expect(
      coordinator.transition({
        runId: "run-1",
        expectedRevision: 2,
        trigger: "todo_observed",
        at: "2026-08-08T19:02:00.000Z",
        summary: { text: "Terminal runs cannot resume." },
      }),
    ).rejects.toThrow(/invalid workflow transition/i);
    await expect(
      coordinator.createClaim(claimInput("run-2")),
    ).resolves.toMatchObject({
      id: "run-2",
      state: "claiming",
    });
    await coordinator.close();
  });

  test("promotes queued rework only after the coding slot becomes available", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput("run-1"));
    await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "handoff_required",
      at: "2026-08-08T19:01:00.000Z",
      summary: { text: "Run one needs operator attention." },
    });
    await coordinator.transition({
      runId: "run-1",
      expectedRevision: 2,
      trigger: "return_todo_queued",
      at: "2026-08-08T19:02:00.000Z",
      summary: { text: "Queue run one for rework." },
    });
    await coordinator.createClaim(claimInput("run-2"));
    await coordinator.transition({
      runId: "run-2",
      expectedRevision: 1,
      trigger: "handoff_required",
      at: "2026-08-08T19:03:00.000Z",
      summary: { text: "Release the execution slot." },
    });
    await expect(
      coordinator.transition({
        runId: "run-1",
        expectedRevision: 3,
        trigger: "coding_slot_available",
        at: "2026-08-08T19:04:00.000Z",
        summary: { text: "Promote queued rework." },
      }),
    ).resolves.toMatchObject({
      state: "returning_to_todo",
      revision: 4,
      reworkEpoch: 1,
    });
    await coordinator.close();
  });
});
