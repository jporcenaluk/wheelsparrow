import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import { openDatabase } from "../database/connection.js";
import {
  type EffectRecord,
  listUnresolvedForReconciliation,
} from "../database/effects.js";
import { migrateDatabase } from "../database/migrate.js";
import { readRun } from "../database/runs.js";
import { WorkflowCoordinator } from "./coordinator.js";
import {
  listReconciliationItems,
  ReconciliationAdapterUnavailableError,
  ReconciliationIncompleteError,
  reconcileEffects,
} from "./reconciliation.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
const databasePaths = new WeakMap<ReturnType<typeof openDatabase>, string>();

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(
    join(tmpdir(), "wheelsparrow-reconciliation-"),
  );
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

function claimInput(id = "run-1") {
  return {
    id,
    repository: "owner/repository",
    projectItemId: `project-${id}`,
    issueNodeId: `issue-${id}`,
    issueNumber: id === "run-1" ? 1 : 2,
    ownerToken: `owner-${id}`,
    at: "2026-08-08T19:00:00.000Z",
    summary: { text: `Claim ${id}.` },
  };
}

function effectFor(
  effect: EffectRecord,
  outcome: "confirmed" | "failed" = "confirmed",
) {
  const trigger =
    effect.kind === "project_todo"
      ? "todo_observed"
      : effect.kind === "project_review"
        ? null
        : "rollback_ready_observed";
  return {
    outcome,
    trigger,
    receipt: { externalKey: effect.key },
    evidence: `Observed ${effect.key}.`,
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

describe("durable effect reconciliation", () => {
  test("awaits a delayed coordinator dispatcher settlement before returning", async () => {
    const connection = await createDatabase();
    const coordinatorDispatch = vi.fn(
      (effect: EffectRecord, complete: (result: unknown) => void) => {
        setTimeout(() => complete(effectFor(effect)), 50);
      },
    );
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: coordinatorDispatch,
    });
    await coordinator.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:delayed-dispatch",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });

    await reconcileEffects({
      connection,
      coordinator,
      dispatcher: vi.fn(),
      settlementTimeoutMs: 200,
    });

    expect(coordinatorDispatch).toHaveBeenCalledTimes(1);
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "preparing",
      revision: 2,
    });
    await coordinator.close();
  });

  test("awaits a delayed coordinator observer settlement before returning", async () => {
    const connection = await createDatabase();
    const crashed = new WorkflowCoordinator({ connection });
    await crashed.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:delayed-observe",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });
    await crashed.beginEffect({
      effectKey: "run:run-1:delayed-observe",
      at: "2026-08-08T19:01:00.000Z",
    });
    await crashed.close();

    const coordinatorObserver = vi.fn(
      (effect: EffectRecord, complete: (result: unknown) => void) => {
        setTimeout(() => complete(effectFor(effect)), 50);
      },
    );
    const coordinator = new WorkflowCoordinator({
      connection,
      observer: coordinatorObserver,
    });

    await reconcileEffects({
      connection,
      coordinator,
      observer: vi.fn(),
      settlementTimeoutMs: 200,
    });

    expect(coordinatorObserver).toHaveBeenCalledTimes(1);
    expect(
      (
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get("run:run-1:delayed-observe") as { status: string }
      ).status,
    ).toBe("confirmed");
    await coordinator.close();
    await crashed.close();
  });

  test("hands an ambiguous dispatcher result to the observer exactly once", async () => {
    const connection = await createDatabase();
    const coordinatorDispatch = vi.fn(
      (_effect: EffectRecord, complete: (result: unknown) => void) => {
        complete({
          outcome: "ambiguous",
          evidence: "The dispatcher returned before external state was known.",
        });
      },
    );
    const coordinatorObserver = vi.fn(
      (effect: EffectRecord, complete: (result: unknown) => void) => {
        setTimeout(() => complete(effectFor(effect)), 50);
      },
    );
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: coordinatorDispatch,
      observer: coordinatorObserver,
    });
    await coordinator.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:ambiguous-dispatch",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });

    await reconcileEffects({
      connection,
      coordinator,
      dispatcher: vi.fn(),
      observer: vi.fn(),
      settlementTimeoutMs: 200,
    });

    expect(coordinatorDispatch).toHaveBeenCalledTimes(1);
    expect(coordinatorObserver).toHaveBeenCalledTimes(1);
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "preparing",
      revision: 2,
    });
    await coordinator.close();
  });

  test("times out a delayed settlement without re-executing unknown work", async () => {
    const connection = await createDatabase();
    const coordinatorDispatch = vi.fn(
      (effect: EffectRecord, complete: (result: unknown) => void) => {
        setTimeout(() => complete(effectFor(effect)), 50);
      },
    );
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: coordinatorDispatch,
    });
    await coordinator.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:dispatch-timeout",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });

    await expect(
      reconcileEffects({
        connection,
        coordinator,
        dispatcher: vi.fn(),
        settlementTimeoutMs: 10,
      }),
    ).rejects.toBeInstanceOf(ReconciliationIncompleteError);
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1);
    expect(
      (
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get("run:run-1:dispatch-timeout") as { status: string }
      ).status,
    ).toBe("in_flight");
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  test("rejects a reconciliation dispatcher when the coordinator has none", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:unused-dispatcher",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });
    const dispatcher = vi.fn();

    await expect(
      reconcileEffects({ connection, coordinator, dispatcher }),
    ).rejects.toMatchObject({
      name: "ReconciliationAdapterUnavailableError",
      adapter: "dispatcher",
    });
    expect(dispatcher).not.toHaveBeenCalled();
    await coordinator.close();
  });

  test("rejects a reconciliation observer when the coordinator has none", async () => {
    const connection = await createDatabase();
    const crashed = new WorkflowCoordinator({ connection });
    await crashed.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:unused-observer",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });
    await crashed.beginEffect({
      effectKey: "run:run-1:unused-observer",
      at: "2026-08-08T19:01:00.000Z",
    });
    await crashed.close();
    const observer = vi.fn();
    const coordinator = new WorkflowCoordinator({ connection });

    await expect(
      reconcileEffects({ connection, coordinator, observer }),
    ).rejects.toMatchObject({
      name: "ReconciliationAdapterUnavailableError",
      adapter: "observer",
    });
    expect(observer).not.toHaveBeenCalled();
    await coordinator.close();
    await crashed.close();
  });

  test("dispatches a current pending intent only after a dispatcher is supplied", async () => {
    const connection = await createDatabase();
    const coordinatorDispatch = vi.fn(async (effect: EffectRecord) =>
      effectFor(effect),
    );
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: coordinatorDispatch,
    });
    await coordinator.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:project:todo",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });
    const reconciliationDispatch = vi.fn(async (effect: EffectRecord) =>
      effectFor(effect),
    );

    await reconcileEffects({
      connection,
      coordinator,
      dispatcher: reconciliationDispatch,
    });

    expect(coordinatorDispatch).toHaveBeenCalledTimes(1);
    expect(reconciliationDispatch).not.toHaveBeenCalled();
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "preparing",
      revision: 2,
    });
    expect(
      (await listUnresolvedForReconciliation(connection.db)).map(
        ({ effect }) => effect.key,
      ),
    ).toEqual([]);
    await coordinator.close();
  });

  test("cancels stale pending intents with durable evidence without a dispatcher", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:stale",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });
    await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-08T19:01:00.000Z",
      summary: { text: "The run advanced before restart reconciliation." },
    });

    await reconcileEffects({ connection, coordinator });

    expect(
      (
        connection.native
          .prepare("SELECT status, failure FROM side_effects WHERE key = ?")
          .get("run:run-1:stale") as { status: string; failure: string }
      ).status,
    ).toBe("cancelled");
    expect(
      (
        connection.native
          .prepare("SELECT status, failure FROM side_effects WHERE key = ?")
          .get("run:run-1:stale") as { status: string; failure: string }
      ).failure,
    ).toMatch(/stale|revision/i);
    await coordinator.close();
  });

  test("cancels stale pending intents without requiring an unusable dispatcher declaration", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:stale-option-only",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });
    await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "todo_observed",
      at: "2026-08-08T19:01:00.000Z",
      summary: { text: "Advance before stale reconciliation." },
    });

    await reconcileEffects({
      connection,
      coordinator,
      dispatcher: vi.fn(),
    });

    expect(
      (
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get("run:run-1:stale-option-only") as { status: string }
      ).status,
    ).toBe("cancelled");
    await coordinator.close();
  });

  test("uses the coordinator failure default when an adapter omits its trigger", async () => {
    const connection = await createDatabase();
    const coordinatorDispatch = vi.fn(async () => ({
      outcome: "failed" as const,
      evidence: "The external project mutation failed.",
    }));
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: coordinatorDispatch,
    });
    await coordinator.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:failed-default-trigger",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });
    const reconciliationDispatch = vi.fn();

    await reconcileEffects({
      connection,
      coordinator,
      dispatcher: reconciliationDispatch,
    });

    expect(coordinatorDispatch).toHaveBeenCalledTimes(1);
    expect(reconciliationDispatch).not.toHaveBeenCalled();
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "claim_failed",
      revision: 2,
    });
    expect(
      connection.native
        .prepare("SELECT status, failure FROM side_effects WHERE key = ?")
        .get("run:run-1:failed-default-trigger"),
    ).toMatchObject({
      status: "failed",
      failure: "The external project mutation failed.",
    });
    await coordinator.close();
  });

  test("fails closed before changing a current pending intent when its dispatcher is unavailable", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:dispatcher-required",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });

    await expect(
      reconcileEffects({ connection, coordinator }),
    ).rejects.toMatchObject({
      name: "ReconciliationAdapterUnavailableError",
      adapter: "dispatcher",
      effectKey: "run:run-1:dispatcher-required",
      status: "pending",
    });
    expect(
      (
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get("run:run-1:dispatcher-required") as { status: string }
      ).status,
    ).toBe("pending");
    await coordinator.close();
  });

  test("converts an in-flight crash window to observation-only recovery", async () => {
    const connection = await createDatabase();
    const crashed = new WorkflowCoordinator({
      connection,
      ownerToken: "crashed-process",
    });
    await crashed.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:external-success-before-receipt",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });
    await crashed.beginEffect({
      effectKey: "run:run-1:external-success-before-receipt",
      at: "2026-08-08T19:01:00.000Z",
    });

    const observer = vi.fn(async (effect: EffectRecord) => effectFor(effect));
    const restarted = new WorkflowCoordinator({ connection, observer });
    await reconcileEffects({
      connection,
      coordinator: restarted,
      observer,
    });

    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer.mock.calls[0]?.[0]).toMatchObject({ status: "ambiguous" });
    expect(
      (
        connection.native
          .prepare(
            "SELECT status, receipt_json FROM side_effects WHERE key = ?",
          )
          .get("run:run-1:external-success-before-receipt") as {
          status: string;
          receipt_json: string;
        }
      ).status,
    ).toBe("confirmed");
    await restarted.close();
    await crashed.close();
  });

  test("requires an observer for in-flight or ambiguous effects and never dispatches them", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:observer-required",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });
    await coordinator.beginEffect({
      effectKey: "run:run-1:observer-required",
      at: "2026-08-08T19:01:00.000Z",
    });
    const dispatch = vi.fn();

    await expect(
      reconcileEffects({ connection, coordinator, dispatcher: dispatch }),
    ).rejects.toBeInstanceOf(ReconciliationAdapterUnavailableError);
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      (
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get("run:run-1:observer-required") as { status: string }
      ).status,
    ).toBe("in_flight");
    await coordinator.close();
  });

  test("never repeats an already ambiguous effect through the dispatcher", async () => {
    const connection = await createDatabase();
    const crashed = new WorkflowCoordinator({
      connection,
      ownerToken: "ambiguous-process",
    });
    await crashed.createClaim(claimInput(), {
      effect: {
        dispatch: false,
        key: "run:run-1:ambiguous-no-repeat",
        kind: "project_todo",
        intent: { projectItemId: "project-run-1", from: "Ready", to: "Todo" },
      },
    });
    await crashed.beginEffect({
      effectKey: "run:run-1:ambiguous-no-repeat",
      at: "2026-08-08T19:01:00.000Z",
    });
    await crashed.close();

    const observer = vi.fn(async (effect: EffectRecord) => effectFor(effect));
    const restarted = new WorkflowCoordinator({ connection, observer });
    await reconcileEffects({
      connection,
      coordinator: restarted,
      observer,
    });

    expect(observer).toHaveBeenCalledTimes(1);
    await restarted.close();
  });

  test("processes unresolved effects in deterministic run and key order", async () => {
    const connection = await createDatabase();
    const coordinator = new WorkflowCoordinator({ connection });
    await coordinator.createClaim(claimInput("run-1"));
    await coordinator.transition({
      runId: "run-1",
      expectedRevision: 1,
      trigger: "handoff_required",
      at: "2026-08-08T19:01:00.000Z",
      summary: { text: "Release run one for a second claim." },
    });
    await coordinator.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key: "run:run-1:z",
      kind: "project_review",
      intent: { projectItemId: "project-run-1", to: "Review" },
    });
    await coordinator.createClaim(claimInput("run-2"), {
      effect: {
        dispatch: false,
        key: "run:run-2:a",
        kind: "project_todo",
        intent: { projectItemId: "project-run-2", from: "Ready", to: "Todo" },
      },
    });
    const items = await listReconciliationItems(connection);
    expect(items.map(({ effect }) => effect.key)).toEqual([
      "run:run-1:z",
      "run:run-2:a",
    ]);
    const order: string[] = [];
    const coordinatorDispatch = vi.fn(async (effect: EffectRecord) => {
      order.push(effect.key);
      return effectFor(effect);
    });
    const dispatch = vi.fn();
    const dispatchingCoordinator = new WorkflowCoordinator({
      connection,
      dispatcher: coordinatorDispatch,
    });

    await reconcileEffects({
      connection,
      coordinator: dispatchingCoordinator,
      dispatcher: dispatch,
    });

    expect(order).toEqual(["run:run-1:z", "run:run-2:a"]);
    expect(dispatch).not.toHaveBeenCalled();
    await dispatchingCoordinator.close();
  });

  test("refreshes each effect before acting after a same-run confirmation advances its revision", async () => {
    const connection = await createDatabase();
    const coordinatorDispatch = vi.fn(async (effect: EffectRecord) =>
      effectFor(effect),
    );
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: coordinatorDispatch,
    });
    await coordinator.createClaim(claimInput());
    await coordinator.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key: "run:run-1:first",
      kind: "project_todo",
      intent: {
        projectItemId: "project-run-1",
        from: "Ready",
        to: "Todo",
        key: "first",
      },
    });
    await coordinator.createEffectIntent({
      runId: "run-1",
      dispatch: false,
      key: "run:run-1:second",
      kind: "project_todo",
      intent: {
        projectItemId: "project-run-1",
        from: "Ready",
        to: "Todo",
        key: "second",
      },
    });

    const reconciliationDispatch = vi.fn();
    await reconcileEffects({
      connection,
      coordinator,
      dispatcher: reconciliationDispatch,
    });

    expect(coordinatorDispatch).toHaveBeenCalledTimes(1);
    expect(reconciliationDispatch).not.toHaveBeenCalled();
    expect(
      connection.native
        .prepare(
          "SELECT key, status FROM side_effects WHERE run_id = ? ORDER BY key",
        )
        .all("run-1"),
    ).toEqual([
      { key: "run:run-1:first", status: "confirmed" },
      { key: "run:run-1:second", status: "cancelled" },
    ]);
    await coordinator.close();
  });
});
