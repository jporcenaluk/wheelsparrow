import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";
import { FakeGitHubProjectGateway } from "../../../../tests/fakes/github.js";
import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import { readRun } from "../database/runs.js";
import type {
  GitHubProjectGateway,
  ProjectItem,
  ProjectMoveRejection,
  ProjectSnapshot,
  ProjectStatusMoveResult,
} from "../github/project.js";
import {
  type ClaimNextEligibleInput,
  claimNextEligible,
  createProjectTodoCapability,
} from "./claim.js";
import type { BeginEffectCommand } from "./coordinator.js";
import { WorkflowCoordinator } from "./coordinator.js";
import { reconcileEffects } from "./reconciliation.js";

const migrationSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const projectId = "PVT_1";
const projectNumber = 7;
const repository = "octo/widget";
const now = "2026-08-08T19:00:00.000Z";
const configuration = {
  projectId,
  projectNumber,
  repository,
  readyStatus: "Ready",
  todoStatus: "Todo",
  requiredLabels: ["mvp", "ready"],
};
const directories: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];

function item(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    projectItemId: "PVTI_1",
    projectId,
    projectNumber,
    repository,
    issueNodeId: "I_1",
    issueNumber: 1,
    isOpen: true,
    status: "Ready",
    revision: "snapshot-1",
    labels: ["mvp", "ready"],
    createdAt: "2026-08-08T12:00:00.000Z",
    dependencies: [],
    ...overrides,
  };
}

function snapshot(items: readonly ProjectItem[] = [item()]): ProjectSnapshot {
  return { projectId, projectNumber, repository, items };
}

function rejected(reason: ProjectMoveRejection): ProjectStatusMoveResult {
  return { outcome: "rejected", reason };
}

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-claim-"));
  directories.push(directory);
  const migrationsDirectory = join(directory, "migrations");
  await cp(migrationSource, migrationsDirectory, { recursive: true });
  const connection = openDatabase(join(directory, "wheelsparrow.sqlite3"));
  migrateDatabase(connection, migrationsDirectory);
  connections.push(connection);
  return connection;
}

function input(
  connection: ReturnType<typeof openDatabase>,
  gateway: GitHubProjectGateway,
  coordinator: ClaimNextEligibleInput["coordinator"],
  runId = "run-1",
): ClaimNextEligibleInput {
  return {
    connection,
    gateway,
    coordinator,
    configuration,
    ownerToken: "owner-1",
    now: () => now,
    runId: () => runId,
  };
}

function coordinatorFor(
  connection: ReturnType<typeof openDatabase>,
  gateway: GitHubProjectGateway,
): WorkflowCoordinator {
  const capability = createProjectTodoCapability(gateway, configuration);
  return new WorkflowCoordinator({
    connection,
    dispatcher: capability.dispatcher,
    observer: capability.observer,
  });
}

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("claimNextEligible", () => {
  test("claims the selected item through one durable intent and one mutation", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const statusAtMutation: string[] = [];
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: async (request) => {
        const row = connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get(request.effectKey) as { status: string } | undefined;
        statusAtMutation.push(row?.status ?? "missing");
        return fake.moveProjectItem(request);
      },
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claimed",
      run: { id: "run-1", state: "preparing", revision: 2 },
      item: { projectItemId: "PVTI_1", status: "Todo" },
    });
    expect(statusAtMutation).toEqual(["in_flight"]);
    expect(fake.mutations()).toHaveLength(1);
    expect(fake.mutations()[0]?.request).toMatchObject({
      projectId,
      projectNumber,
      itemId: "PVTI_1",
      issueNodeId: "I_1",
      issueNumber: 1,
      expectedRevision: "snapshot-1",
      fromStatus: "Ready",
      toStatus: "Todo",
      effectKey: "run:run-1:project:todo",
    });
    await coordinator.close();
  });

  test("accepts a canonical timestamp without an explicit millisecond fraction", async () => {
    const connection = await createDatabase();
    const candidate = item({ createdAt: "2026-08-08T12:00:00Z" });
    const fake = new FakeGitHubProjectGateway(snapshot([candidate]));
    const coordinator = coordinatorFor(connection, fake);

    const outcome = await claimNextEligible(
      input(connection, fake, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claimed",
      item: { projectItemId: candidate.projectItemId },
    });
    await coordinator.close();
  });

  test("returns discovery details when no eligible candidate exists", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(
      snapshot([item({ status: "Review" })]),
    );
    const coordinator = coordinatorFor(connection, fake);

    const outcome = await claimNextEligible(
      input(connection, fake, coordinator),
    );

    expect(outcome).toMatchObject({ kind: "no_candidate" });
    expect(
      outcome.kind === "no_candidate" && outcome.discovery.excluded,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "status_not_ready" }),
      ]),
    );
    expect(fake.mutations()).toHaveLength(0);
    await coordinator.close();
  });

  test("requires dispatcher and observer startup capabilities before creating a claim", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const capability = createProjectTodoCapability(fake, configuration);
    let snapshotReads = 0;
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: capability.dispatcher,
    });
    const gateway: GitHubProjectGateway = {
      readProject: async (request) => {
        snapshotReads += 1;
        return fake.readProject(request);
      },
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: (request) => fake.moveProjectItem(request),
    };

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({ kind: "claim_rejected" });
    expect(outcome).not.toHaveProperty("run");
    expect(snapshotReads).toBe(0);
    expect(fake.mutations()).toHaveLength(0);
    expect(
      connection.native.prepare("SELECT COUNT(*) AS count FROM runs").get(),
    ).toEqual({ count: 0 });
    await coordinator.close();
  });

  test.each([
    ["blank ready status", { readyStatus: "   " }],
    ["blank Todo status", { todoStatus: "\t" }],
    ["equal status lanes", { readyStatus: "Todo", todoStatus: "Todo" }],
  ] as const)(
    "rejects %s before reading or creating durable state",
    async (_label, statusOverrides) => {
      const connection = await createDatabase();
      const fake = new FakeGitHubProjectGateway(snapshot());
      let snapshotReads = 0;
      let runIdCalls = 0;
      const gateway: GitHubProjectGateway = {
        readProject: async () => {
          snapshotReads += 1;
          throw new Error("snapshot must not be read");
        },
        readProjectItem: async () => {
          throw new Error("item must not be read");
        },
        moveProjectItem: async () => {
          throw new Error("mutation must not be called");
        },
      };
      const coordinator = coordinatorFor(connection, fake);

      const outcome = await claimNextEligible({
        ...input(connection, gateway, coordinator),
        configuration: { ...configuration, ...statusOverrides },
        runId: () => {
          runIdCalls += 1;
          return "run-1";
        },
      });

      expect(outcome).toMatchObject({ kind: "claim_rejected" });
      expect(snapshotReads).toBe(0);
      expect(runIdCalls).toBe(0);
      expect(
        connection.native.prepare("SELECT COUNT(*) AS count FROM runs").get(),
      ).toEqual({ count: 0 });
      await coordinator.close();
    },
  );

  test("returns a typed bounded rejection when the project snapshot read throws", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const coordinator = coordinatorFor(connection, fake);
    const gateway: GitHubProjectGateway = {
      readProject: async () => {
        throw new Error("project API unavailable");
      },
      readProjectItem: async () => {
        throw new Error("item read must not happen");
      },
      moveProjectItem: async () => {
        throw new Error("mutation must not happen");
      },
    };

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      reason: expect.stringContaining("project API unavailable"),
    });
    if (outcome.kind !== "claim_rejected")
      throw new Error("expected typed rejection");
    expect(outcome.reason.length).toBeLessThanOrEqual(4096);
    expect(
      connection.native.prepare("SELECT COUNT(*) AS count FROM runs").get(),
    ).toEqual({ count: 0 });
    await coordinator.close();
  });

  test("returns a typed rejection when the selected item reread throws", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const coordinator = coordinatorFor(connection, fake);
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: async () => {
        throw new Error("item API unavailable");
      },
      moveProjectItem: async () => {
        throw new Error("mutation must not happen");
      },
    };

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      item: { projectItemId: "PVTI_1" },
      reason: expect.stringContaining("item API unavailable"),
    });
    expect(
      connection.native.prepare("SELECT COUNT(*) AS count FROM runs").get(),
    ).toEqual({ count: 0 });
    await coordinator.close();
  });

  test("rejects immediate re-read drift without creating a run or mutating GitHub", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    let reads = 0;
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: async (projectItemId) => {
        reads += 1;
        return fake.readProjectItem(projectItemId).then((observed) => {
          if (reads !== 1 || observed === undefined) return observed;
          return { ...observed, revision: "snapshot-2", status: "Todo" };
        });
      },
      moveProjectItem: (request) => fake.moveProjectItem(request),
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome.kind).toBe("claim_rejected");
    expect(outcome).not.toHaveProperty("run");
    expect(fake.mutations()).toHaveLength(0);
    expect(
      connection.native.prepare("SELECT COUNT(*) AS count FROM runs").get(),
    ).toEqual({ count: 0 });
    await coordinator.close();
  });

  test("accepts reordered labels and dependencies during the selected-item reread", async () => {
    const connection = await createDatabase();
    const candidate = item({
      dependencies: [
        { issueNodeId: "I_2", issueNumber: 2, isOpen: false },
        { issueNodeId: "I_3", issueNumber: 3, isOpen: false },
      ],
    });
    const fake = new FakeGitHubProjectGateway(snapshot([candidate]));
    let reads = 0;
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: async (projectItemId) => {
        const observed = await fake.readProjectItem(projectItemId);
        reads += 1;
        if (observed === undefined || reads !== 1) return observed;
        if (observed.dependencies === "unavailable") return observed;
        return {
          ...observed,
          labels: [...observed.labels].reverse(),
          dependencies: [...observed.dependencies].reverse(),
        };
      },
      moveProjectItem: (request) => fake.moveProjectItem(request),
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claimed",
      item: { projectItemId: candidate.projectItemId },
    });
    expect(fake.mutations()).toHaveLength(1);
    await coordinator.close();
  });

  test("normalizes timestamp forms across the selected-item reread", async () => {
    const connection = await createDatabase();
    const candidate = item({ createdAt: "2026-08-08T12:00:00Z" });
    const fake = new FakeGitHubProjectGateway(snapshot([candidate]));
    let reads = 0;
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: async (projectItemId) => {
        const observed = await fake.readProjectItem(projectItemId);
        reads += 1;
        if (observed === undefined || reads !== 1) return observed;
        return { ...observed, createdAt: "2026-08-08T12:00:00.000Z" };
      },
      moveProjectItem: (request) => fake.moveProjectItem(request),
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claimed",
      intent: { createdAt: "2026-08-08T12:00:00.000Z" },
    });
    expect(fake.mutations()).toHaveLength(1);
    await coordinator.close();
  });

  test("keeps a different timestamp instant as selected-item drift", async () => {
    const connection = await createDatabase();
    const candidate = item({ createdAt: "2026-08-08T12:00:00Z" });
    const fake = new FakeGitHubProjectGateway(snapshot([candidate]));
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: async (projectItemId) => {
        const observed = await fake.readProjectItem(projectItemId);
        if (observed === undefined) return observed;
        return { ...observed, createdAt: "2026-08-08T12:00:00.001Z" };
      },
      moveProjectItem: (request) => fake.moveProjectItem(request),
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      reason: "selected project item drifted before claim",
    });
    expect(fake.mutations()).toHaveLength(0);
    await coordinator.close();
  });

  test("turns a rejected conditional mutation into claim_failed without preparing", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: async (request) => {
        fake.simulateRevisionDrift(request.itemId);
        return fake.moveProjectItem(request);
      },
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      run: { state: "claim_failed" },
    });
    expect(fake.mutations()).toHaveLength(0);
    await coordinator.close();
  });

  test.each([
    [
      "revision_mismatch",
      {
        kind: "revision_mismatch",
        expectedRevision: "snapshot-1",
        actualRevision: "snapshot-2",
      },
    ],
    [
      "status_mismatch",
      {
        kind: "status_mismatch",
        expectedStatus: "Ready",
        actualStatus: "Review",
      },
    ],
    [
      "issue_mapping_mismatch",
      {
        kind: "issue_mapping_mismatch",
        expectedIssueNodeId: "I_1",
        expectedIssueNumber: 1,
        actualIssueNodeId: "I_9",
        actualIssueNumber: 9,
      },
    ],
  ] as const)(
    "preserves typed gateway rejection kind: %s",
    async (kind, rejection) => {
      const connection = await createDatabase();
      const fake = new FakeGitHubProjectGateway(snapshot());
      const gateway: GitHubProjectGateway = {
        readProject: (request) => fake.readProject(request),
        readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
        moveProjectItem: async () => rejected(rejection),
      };
      const coordinator = coordinatorFor(connection, gateway);

      const outcome = await claimNextEligible(
        input(connection, gateway, coordinator),
      );

      expect(outcome).toMatchObject({
        kind: "claim_rejected",
        rejectionKind: kind,
        run: { state: "claim_failed" },
      });
      expect(
        connection.native
          .prepare("SELECT failure FROM side_effects WHERE key = ?")
          .get("run:run-1:project:todo"),
      ).toMatchObject({ failure: expect.stringContaining(kind) });
      await coordinator.close();
    },
  );

  test("quarantines a timed-out mutation so a late receipt cannot prepare the run", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    let release: ((result: ProjectStatusMoveResult) => void) | undefined;
    const pending = new Promise<ProjectStatusMoveResult>((resolve) => {
      release = resolve;
    });
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: () => pending,
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible({
      ...input(connection, gateway, coordinator),
      settlementTimeoutMs: 10,
    });

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      run: { state: "claiming" },
    });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "ambiguous" });

    const source = await fake.readProjectItem("PVTI_1");
    if (source === undefined) throw new Error("expected fake item");
    release?.({
      outcome: "moved",
      item: { ...source, status: "Todo", revision: "snapshot-2" },
    });
    await coordinator.waitForIdle();
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "claiming",
    });
    await coordinator.close();
  });

  test("quarantines any settlement rejection so a late receipt cannot prepare the run", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    let release: ((result: ProjectStatusMoveResult) => void) | undefined;
    const pending = new Promise<ProjectStatusMoveResult>((resolve) => {
      release = resolve;
    });
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: () => pending,
    };
    const realCoordinator = coordinatorFor(connection, gateway);
    const coordinator = {
      createClaim: realCoordinator.createClaim.bind(realCoordinator),
      beginEffect: realCoordinator.beginEffect.bind(realCoordinator),
      waitForEffectSettlement: async () => {
        throw new Error("settlement read failed");
      },
      cancelEffect: realCoordinator.cancelEffect.bind(realCoordinator),
      abandonEffect: realCoordinator.abandonEffect.bind(realCoordinator),
      rejectClaim: realCoordinator.rejectClaim.bind(realCoordinator),
      quarantineEffect: realCoordinator.quarantineEffect.bind(realCoordinator),
      transition: realCoordinator.transition.bind(realCoordinator),
      hasEffectDispatcher: true as const,
      hasEffectObserver: true as const,
    } as const;

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      cleanupStatus: "quarantined",
    });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "ambiguous" });

    const source = await fake.readProjectItem("PVTI_1");
    if (source === undefined) throw new Error("expected fake item");
    release?.({
      outcome: "moved",
      item: { ...source, status: "Todo", revision: "snapshot-2" },
    });
    await realCoordinator.waitForIdle();
    expect(await readRun(connection.db, "run-1")).not.toMatchObject({
      state: "preparing",
    });
    await realCoordinator.close();
  });

  test("quarantines an invalid settlement timeout so a late receipt cannot prepare the run", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    let release: ((result: ProjectStatusMoveResult) => void) | undefined;
    const pending = new Promise<ProjectStatusMoveResult>((resolve) => {
      release = resolve;
    });
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: () => pending,
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible({
      ...input(connection, gateway, coordinator),
      settlementTimeoutMs: Number.NaN,
    });

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      cleanupStatus: "quarantined",
    });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "ambiguous" });

    const source = await fake.readProjectItem("PVTI_1");
    if (source === undefined) throw new Error("expected fake item");
    release?.({
      outcome: "moved",
      item: { ...source, status: "Todo", revision: "snapshot-2" },
    });
    await coordinator.waitForIdle();
    expect(await readRun(connection.db, "run-1")).not.toMatchObject({
      state: "preparing",
    });
    await coordinator.close();
  });

  test("cancels a pending intent when beginEffect fails without waiting for settlement timeout", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const realCoordinator = new WorkflowCoordinator({ connection });
    let rejectCalls = 0;
    const coordinator = {
      createClaim: realCoordinator.createClaim.bind(realCoordinator),
      beginEffect: async () => {
        throw new Error("begin failed");
      },
      waitForEffectSettlement:
        realCoordinator.waitForEffectSettlement.bind(realCoordinator),
      cancelEffect: realCoordinator.cancelEffect.bind(realCoordinator),
      abandonEffect: realCoordinator.abandonEffect.bind(realCoordinator),
      rejectClaim: async (
        command: Parameters<WorkflowCoordinator["rejectClaim"]>[0],
      ) => {
        rejectCalls += 1;
        return realCoordinator.rejectClaim(command);
      },
      hasEffectDispatcher: true as const,
      hasEffectObserver: true as const,
    } as const;

    const outcome = await claimNextEligible({
      ...input(connection, fake, coordinator),
      settlementTimeoutMs: 10_000,
    });

    expect(outcome).toMatchObject({ kind: "claim_rejected" });
    expect(rejectCalls).toBe(1);
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "cancelled" });
    await realCoordinator.close();
  });

  test("releases a canceled begin-failure claim so a later claim can own the item", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const realCoordinator = new WorkflowCoordinator({ connection });
    const coordinator = {
      createClaim: realCoordinator.createClaim.bind(realCoordinator),
      beginEffect: async () => {
        throw new Error("begin failed");
      },
      waitForEffectSettlement:
        realCoordinator.waitForEffectSettlement.bind(realCoordinator),
      cancelEffect: realCoordinator.cancelEffect.bind(realCoordinator),
      abandonEffect: realCoordinator.abandonEffect.bind(realCoordinator),
      transition: realCoordinator.transition.bind(realCoordinator),
      rejectClaim: realCoordinator.rejectClaim.bind(realCoordinator),
      hasEffectDispatcher: true as const,
      hasEffectObserver: true as const,
    } as const;

    const first = await claimNextEligible({
      ...input(connection, fake, coordinator, "run-1"),
      settlementTimeoutMs: 10,
    });

    expect(first).toMatchObject({
      kind: "claim_rejected",
      cleanupStatus: "cancelled",
      run: { state: "claim_failed", ownerToken: null },
    });
    expect(
      connection.native
        .prepare("SELECT ownership_released_at FROM runs WHERE id = 'run-1'")
        .get(),
    ).toMatchObject({ ownership_released_at: now });

    const secondCoordinator = coordinatorFor(connection, fake);
    const second = await claimNextEligible(
      input(connection, fake, secondCoordinator, "run-2"),
    );

    expect(second).toMatchObject({
      kind: "claimed",
      run: { id: "run-2", state: "preparing" },
    });
    await realCoordinator.close();
    await secondCoordinator.close();
  });

  test("returns a bounded claim rejection when begin cleanup commands are unavailable", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const realCoordinator = new WorkflowCoordinator({ connection });
    const coordinator = {
      createClaim: realCoordinator.createClaim.bind(realCoordinator),
      beginEffect: async () => {
        throw new Error("begin failed");
      },
      waitForEffectSettlement:
        realCoordinator.waitForEffectSettlement.bind(realCoordinator),
      cancelEffect: async () => {
        throw new Error("coordinator closed");
      },
      abandonEffect: async () => {
        throw new Error("coordinator closed");
      },
      rejectClaim: async () => {
        throw new Error("coordinator closed");
      },
      hasEffectDispatcher: true as const,
      hasEffectObserver: true as const,
    } as const;

    const outcome = await claimNextEligible({
      ...input(connection, fake, coordinator),
      settlementTimeoutMs: 10,
    });

    if (outcome.kind !== "claim_rejected")
      throw new Error("expected rejection");
    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      reason: expect.stringContaining("begin failed"),
    });
    expect(outcome.reason.length).toBeLessThanOrEqual(4096);
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "pending" });
    await realCoordinator.close();
  });

  test("rejects an in-flight begin failure atomically", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const realCoordinator = new WorkflowCoordinator({ connection });
    const coordinator = {
      createClaim: realCoordinator.createClaim.bind(realCoordinator),
      beginEffect: async (command: BeginEffectCommand | string) => {
        await realCoordinator.beginEffect(command);
        throw new Error("begin failed");
      },
      waitForEffectSettlement:
        realCoordinator.waitForEffectSettlement.bind(realCoordinator),
      cancelEffect: async () => {
        throw new Error("already in flight");
      },
      abandonEffect: realCoordinator.abandonEffect.bind(realCoordinator),
      rejectClaim: realCoordinator.rejectClaim.bind(realCoordinator),
      hasEffectDispatcher: true as const,
      hasEffectObserver: true as const,
    } as const;

    const outcome = await claimNextEligible({
      ...input(connection, fake, coordinator),
      settlementTimeoutMs: 10,
    });

    if (outcome.kind !== "claim_rejected")
      throw new Error("expected rejection");
    expect(outcome).toMatchObject({
      cleanupStatus: "cancelled",
      run: { state: "claim_failed", revision: 2, ownerToken: null },
    });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "cancelled" });
    await realCoordinator.close();
  });

  test("quarantines an in-flight timeout when abandonEffect throws", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    let release: ((result: ProjectStatusMoveResult) => void) | undefined;
    const pending = new Promise<ProjectStatusMoveResult>((resolve) => {
      release = resolve;
    });
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: () => pending,
    };
    const realCoordinator = coordinatorFor(connection, gateway);
    const coordinator = {
      createClaim: realCoordinator.createClaim.bind(realCoordinator),
      beginEffect: realCoordinator.beginEffect.bind(realCoordinator),
      waitForEffectSettlement:
        realCoordinator.waitForEffectSettlement.bind(realCoordinator),
      cancelEffect: realCoordinator.cancelEffect.bind(realCoordinator),
      abandonEffect: async () => {
        throw new Error("quarantine command unavailable");
      },
      quarantineEffect: realCoordinator.quarantineEffect.bind(realCoordinator),
      transition: realCoordinator.transition.bind(realCoordinator),
      rejectClaim: realCoordinator.rejectClaim.bind(realCoordinator),
      hasEffectDispatcher: true as const,
      hasEffectObserver: true as const,
    } as const;

    const outcome = await claimNextEligible({
      ...input(connection, gateway, coordinator),
      settlementTimeoutMs: 10,
    });

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      cleanupStatus: "reconciliation_required",
      run: { state: "claiming", revision: 2 },
    });
    if (outcome.kind !== "claim_rejected")
      throw new Error("expected typed rejection");
    expect(outcome.reason.length).toBeLessThanOrEqual(4096);
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "ambiguous" });

    const source = await fake.readProjectItem("PVTI_1");
    if (source === undefined) throw new Error("expected fake item");
    release?.({
      outcome: "moved",
      item: { ...source, status: "Todo", revision: "snapshot-2" },
    });
    await realCoordinator.waitForIdle();
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "claiming",
      revision: 2,
    });
    await realCoordinator.close();
  });

  test.each([
    ["project id", { projectId: "PVT_2" }, undefined],
    ["project number", { projectNumber: 8 }, undefined],
    ["repository", { repository: "octo/other" }, undefined],
    ["project item id", { projectItemId: "" }, undefined],
    ["issue number", { issueNumber: 0 }, undefined],
    ["labels structure", { labels: ["mvp", 1] }, undefined],
    ["created timestamp", { createdAt: "not-a-timestamp" }, undefined],
    [
      "dependency structure",
      {
        dependencies: [
          { issueNodeId: "I_2", issueNumber: 2, isOpen: false, extra: true },
        ],
      },
      undefined,
    ],
    ["ready lane", { fromStatus: "Backlog" }, undefined],
    ["Todo lane", { toStatus: "Done" }, undefined],
    ["effect key", {}, "run:other:project:todo"],
  ] as const)(
    "rejects a persisted project Todo intent with a mismatched %s before mutation",
    async (_label, intentOverrides, effectKeyOverride) => {
      const connection = await createDatabase();
      const fake = new FakeGitHubProjectGateway(snapshot());
      const capability = createProjectTodoCapability(fake, configuration);
      const coordinator = new WorkflowCoordinator({
        connection,
        dispatcher: capability.dispatcher,
      });
      const candidate = item();
      const effectKey = effectKeyOverride ?? "run:run-1:project:todo";
      const intent = {
        projectId,
        projectNumber,
        repository,
        projectItemId: candidate.projectItemId,
        issueNodeId: candidate.issueNodeId,
        issueNumber: candidate.issueNumber,
        isOpen: candidate.isOpen,
        labels: candidate.labels,
        createdAt: candidate.createdAt,
        dependencies: candidate.dependencies,
        expectedRevision: candidate.revision,
        fromStatus: configuration.readyStatus,
        toStatus: configuration.todoStatus,
        ...intentOverrides,
      };
      await coordinator.createClaim(
        {
          id: "run-1",
          repository,
          projectItemId: candidate.projectItemId,
          issueNodeId: candidate.issueNodeId,
          issueNumber: candidate.issueNumber,
          ownerToken: "owner-1",
          at: now,
          summary: { text: "Claim issue #1." },
        },
        {
          effect: {
            dispatch: false,
            key: effectKey,
            kind: "project_todo",
            intent,
          },
        },
      );

      await coordinator.beginEffect(effectKey);
      const settled = await coordinator.waitForEffectSettlement(effectKey, 100);

      expect(settled).toMatchObject({ status: "failed" });
      expect(fake.mutations()).toHaveLength(0);
      await coordinator.close();
    },
  );

  test.each([
    ["closed issue", { isOpen: false }],
    ["missing required label", { labels: ["mvp"] }],
    ["unavailable dependencies", { dependencies: "unavailable" }],
    [
      "open dependency",
      { dependencies: [{ issueNodeId: "I_2", issueNumber: 2, isOpen: true }] },
    ],
  ] as const)(
    "rejects persisted discovery-ineligible intent before mutation: %s",
    async (_label, intentOverrides) => {
      const connection = await createDatabase();
      const fake = new FakeGitHubProjectGateway(snapshot());
      const capability = createProjectTodoCapability(fake, configuration);
      const coordinator = new WorkflowCoordinator({
        connection,
        dispatcher: capability.dispatcher,
      });
      const candidate = item();
      const effectKey = "run:run-1:project:todo";
      const intent = {
        projectId,
        projectNumber,
        repository,
        projectItemId: candidate.projectItemId,
        issueNodeId: candidate.issueNodeId,
        issueNumber: candidate.issueNumber,
        isOpen: candidate.isOpen,
        labels: candidate.labels,
        createdAt: candidate.createdAt,
        dependencies: candidate.dependencies,
        expectedRevision: candidate.revision,
        fromStatus: configuration.readyStatus,
        toStatus: configuration.todoStatus,
        ...intentOverrides,
      };
      await coordinator.createClaim(
        {
          id: "run-1",
          repository,
          projectItemId: candidate.projectItemId,
          issueNodeId: candidate.issueNodeId,
          issueNumber: candidate.issueNumber,
          ownerToken: "owner-1",
          at: now,
          summary: { text: "Claim issue #1." },
        },
        {
          effect: {
            dispatch: false,
            key: effectKey,
            kind: "project_todo",
            intent,
          },
        },
      );

      const settled = await coordinator
        .beginEffect(effectKey)
        .then(() => coordinator.waitForEffectSettlement(effectKey, 100));

      expect(settled).toMatchObject({ status: "failed" });
      expect(fake.mutations()).toHaveLength(0);
      await coordinator.close();
    },
  );

  test("rejects a persisted intent with unknown fields before mutation", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const capability = createProjectTodoCapability(fake, configuration);
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: capability.dispatcher,
    });
    const candidate = item();
    const effectKey = "run:run-1:project:todo";
    const intent = {
      projectId,
      projectNumber,
      repository,
      projectItemId: candidate.projectItemId,
      issueNodeId: candidate.issueNodeId,
      issueNumber: candidate.issueNumber,
      isOpen: candidate.isOpen,
      labels: candidate.labels,
      createdAt: candidate.createdAt,
      dependencies: candidate.dependencies,
      expectedRevision: candidate.revision,
      fromStatus: configuration.readyStatus,
      toStatus: configuration.todoStatus,
      unexpectedField: "must not be accepted",
    };
    await coordinator.createClaim(
      {
        id: "run-1",
        repository,
        projectItemId: candidate.projectItemId,
        issueNodeId: candidate.issueNodeId,
        issueNumber: candidate.issueNumber,
        ownerToken: "owner-1",
        at: now,
        summary: { text: "Claim issue #1." },
      },
      {
        effect: {
          dispatch: false,
          key: effectKey,
          kind: "project_todo",
          intent,
        },
      },
    );

    const settled = await coordinator
      .beginEffect(effectKey)
      .then(() => coordinator.waitForEffectSettlement(effectKey, 100));

    expect(settled).toMatchObject({ status: "failed" });
    expect(fake.mutations()).toHaveLength(0);
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "claim_failed",
    });
    await coordinator.close();
  });

  test("abandons queued confirmation before it can prepare the run", async () => {
    const connection = await createDatabase();
    const key = "run:run-1:project:todo";
    const coordinator = new WorkflowCoordinator({
      connection,
      dispatcher: (_effect, complete) => {
        complete({
          outcome: "confirmed",
          trigger: "todo_observed",
          evidence: "queued confirmation",
        });
      },
    });
    await coordinator.createClaim(
      {
        id: "run-1",
        repository,
        projectItemId: "PVTI_1",
        issueNodeId: "I_1",
        issueNumber: 1,
        ownerToken: "owner-1",
        at: now,
        summary: { text: "Claim issue #1." },
      },
      {
        effect: {
          dispatch: false,
          key,
          kind: "project_todo",
          intent: { projectItemId: "PVTI_1", from: "Ready", to: "Todo" },
        },
      },
    );
    await coordinator.beginEffect(key);

    const abandoned = await coordinator.abandonEffect({
      runId: "run-1",
      expectedRevision: 1,
      effectKey: key,
      outcome: "ambiguous",
      trigger: null,
      evidence: "Quarantined before queued confirmation.",
    });

    expect(abandoned.status).toBe("ambiguous");
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "claiming",
      revision: 1,
    });
    await coordinator.close();
  });

  test("reconciles an ambiguous project Todo effect after coordinator restart without redispatching", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const capability = createProjectTodoCapability(fake, configuration);
    const crashed = new WorkflowCoordinator({ connection });
    const candidate = item();
    const effectKey = "run:run-1:project:todo";
    const intent = {
      projectId,
      projectNumber,
      repository,
      projectItemId: candidate.projectItemId,
      issueNodeId: candidate.issueNodeId,
      issueNumber: candidate.issueNumber,
      expectedRevision: candidate.revision,
      fromStatus: "Ready",
      toStatus: "Todo",
      isOpen: candidate.isOpen,
      labels: candidate.labels,
      createdAt: candidate.createdAt,
      dependencies: candidate.dependencies,
    };
    await crashed.createClaim(
      {
        id: "run-1",
        repository,
        projectItemId: candidate.projectItemId,
        issueNodeId: candidate.issueNodeId,
        issueNumber: candidate.issueNumber,
        ownerToken: "owner-1",
        at: now,
        summary: { text: "Claim issue #1." },
      },
      {
        effect: {
          dispatch: false,
          key: effectKey,
          kind: "project_todo",
          intent,
        },
      },
    );
    await crashed.beginEffect(effectKey);
    await crashed.close();

    const move = await fake.moveProjectItem({
      projectId,
      projectNumber,
      itemId: candidate.projectItemId,
      issueNodeId: candidate.issueNodeId,
      issueNumber: candidate.issueNumber,
      expectedRevision: candidate.revision,
      fromStatus: "Ready",
      toStatus: "Todo",
      effectKey,
    });
    expect(move.outcome).toBe("moved");

    const restarted = new WorkflowCoordinator({
      connection,
      observer: capability.observer,
    });
    await reconcileEffects({
      connection,
      coordinator: restarted,
      observer: capability.observer,
      settlementTimeoutMs: 100,
    });

    expect(fake.mutations()).toHaveLength(1);
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "preparing",
    });
    await restarted.close();
  });

  test("replays an exact confirmed effect without a second mutation", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const coordinator = coordinatorFor(connection, fake);
    const first = await claimNextEligible(input(connection, fake, coordinator));
    if (first.kind !== "claimed") throw new Error("expected a claim");

    const replay = await coordinator.createEffectIntent({
      runId: "run-1",
      expectedRevision: 2,
      key: "run:run-1:project:todo",
      kind: "project_todo",
      intent: first.intent,
    });

    expect(replay.inserted).toBe(false);
    expect(fake.mutations()).toHaveLength(1);
    await coordinator.close();
  });

  test("does not mutate GitHub when concurrent claims race for the coding slot", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const firstCoordinator = coordinatorFor(connection, fake);
    const secondCoordinator = coordinatorFor(connection, fake);

    const outcomes = await Promise.all([
      claimNextEligible(input(connection, fake, firstCoordinator, "run-1")),
      claimNextEligible(input(connection, fake, secondCoordinator, "run-2")),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.kind === "claimed"),
    ).toHaveLength(1);
    expect(fake.mutations()).toHaveLength(1);
    await firstCoordinator.close();
    await secondCoordinator.close();
  });

  test.each([
    ["status", { status: "Review" }],
    ["issue mapping", { issueNodeId: "I_9", issueNumber: 9 }],
    [
      "dependency identity",
      {
        dependencies: [{ issueNodeId: "I_9", issueNumber: 9, isOpen: false }],
      },
    ],
  ] as const)(
    "does not confirm a changed %s receipt",
    async (_label, drift) => {
      const connection = await createDatabase();
      const fake = new FakeGitHubProjectGateway(snapshot());
      const gateway: GitHubProjectGateway = {
        readProject: (request) => fake.readProject(request),
        readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
        moveProjectItem: async (request): Promise<ProjectStatusMoveResult> => {
          const result = await fake.moveProjectItem(request);
          if (result.outcome !== "moved") return result;
          return { outcome: "moved", item: { ...result.item, ...drift } };
        },
      };
      const coordinator = coordinatorFor(connection, gateway);

      const outcome = await claimNextEligible(
        input(connection, gateway, coordinator),
      );

      expect(outcome).toMatchObject({
        kind: "claim_rejected",
        run: { state: "claiming", ownerToken: "owner-1" },
      });
      expect(fake.mutations()).toHaveLength(1);

      expect(
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get("run:run-1:project:todo"),
      ).toEqual({ status: "ambiguous" });

      await coordinator.close();

      const restarted = coordinatorFor(connection, gateway);
      const reconciliation = await reconcileEffects({
        connection,
        coordinator: restarted,
        observer: createProjectTodoCapability(gateway, configuration).observer,
        settlementTimeoutMs: 100,
      });

      expect(reconciliation.observed).toEqual(["run:run-1:project:todo"]);
      expect(fake.mutations()).toHaveLength(1);
      expect(await readRun(connection.db, "run-1")).toMatchObject({
        state: "preparing",
      });
      await restarted.close();
    },
  );

  test("confirms a mutation receipt with reordered labels and dependencies", async () => {
    const connection = await createDatabase();
    const candidate = item({
      dependencies: [
        { issueNodeId: "I_2", issueNumber: 2, isOpen: false },
        { issueNodeId: "I_3", issueNumber: 3, isOpen: false },
      ],
    });
    const fake = new FakeGitHubProjectGateway(snapshot([candidate]));
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: async (request) => {
        const result = await fake.moveProjectItem(request);
        if (result.outcome !== "moved") return result;
        if (result.item.dependencies === "unavailable") return result;
        return {
          outcome: "moved",
          item: {
            ...result.item,
            labels: [...result.item.labels].reverse(),
            dependencies: [...result.item.dependencies].reverse(),
          },
        };
      },
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claimed",
      item: { projectItemId: candidate.projectItemId },
    });
    expect(fake.mutations()).toHaveLength(1);
    await coordinator.close();
  });

  test("normalizes timestamp forms in a mutation receipt", async () => {
    const connection = await createDatabase();
    const candidate = item({ createdAt: "2026-08-08T12:00:00.000Z" });
    const fake = new FakeGitHubProjectGateway(snapshot([candidate]));
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: async (request) => {
        const result = await fake.moveProjectItem(request);
        if (result.outcome !== "moved") return result;
        return {
          outcome: "moved",
          item: { ...result.item, createdAt: "2026-08-08T12:00:00Z" },
        };
      },
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({ kind: "claimed" });
    expect(fake.mutations()).toHaveLength(1);
    await coordinator.close();
  });

  test("does not confirm a receipt with changed duplicate multiplicity", async () => {
    const connection = await createDatabase();
    const candidate = item({
      labels: ["mvp", "ready", "triage", "triage"],
      dependencies: [
        { issueNodeId: "I_2", issueNumber: 2, isOpen: false },
        { issueNodeId: "I_2", issueNumber: 2, isOpen: false },
        { issueNodeId: "I_3", issueNumber: 3, isOpen: false },
        { issueNodeId: "I_3", issueNumber: 3, isOpen: false },
      ],
    });
    const fake = new FakeGitHubProjectGateway(snapshot([candidate]));
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: async (request) => {
        const result = await fake.moveProjectItem(request);
        if (result.outcome !== "moved") return result;
        return {
          outcome: "moved",
          item: {
            ...result.item,
            labels: ["mvp", "mvp", "triage", "ready"],
            dependencies: [
              { issueNodeId: "I_2", issueNumber: 2, isOpen: false },
              { issueNodeId: "I_2", issueNumber: 2, isOpen: false },
              { issueNodeId: "I_2", issueNumber: 2, isOpen: false },
              { issueNodeId: "I_3", issueNumber: 3, isOpen: false },
            ],
          },
        };
      },
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      run: { state: "claiming", ownerToken: "owner-1" },
    });
    expect(fake.mutations()).toHaveLength(1);
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "ambiguous" });
    await coordinator.close();
  });

  test("rejects an unknown gateway outcome even when its receipt looks matching", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: async (request) => {
        const source = await fake.readProjectItem(request.itemId);
        if (source === undefined) throw new Error("expected fake item");
        const observed = {
          ...source,
          status: "Todo",
          revision: "snapshot-2",
        };
        return {
          outcome: "bogus",
          item: observed,
        } as never;
      },
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      run: { state: "claiming", ownerToken: "owner-1" },
    });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "ambiguous" });
    expect(fake.mutations()).toHaveLength(0);
    await coordinator.close();
  });

  test("keeps a mutation-then-throw ambiguous for observer reconciliation", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: async (request) => {
        const result = await fake.moveProjectItem(request);
        if (result.outcome !== "moved") return result;
        throw new Error("response lost after GitHub mutation");
      },
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      run: { state: "claiming", ownerToken: "owner-1" },
    });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "ambiguous" });
    expect(fake.mutations()).toHaveLength(1);

    await coordinator.close();

    const restarted = coordinatorFor(connection, gateway);
    const reconciliation = await reconcileEffects({
      connection,
      coordinator: restarted,
      observer: createProjectTodoCapability(gateway, configuration).observer,
      settlementTimeoutMs: 100,
    });

    expect(reconciliation.observed).toEqual(["run:run-1:project:todo"]);
    expect(fake.mutations()).toHaveLength(1);
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "confirmed" });
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "preparing",
    });
    await restarted.close();
  });

  test("keeps a throwing observer ambiguous until a later valid observation", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    let observerThrows = false;
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: async (projectItemId) => {
        if (observerThrows) throw new Error("GitHub read timed out");
        return fake.readProjectItem(projectItemId);
      },
      moveProjectItem: async (request) => {
        const result = await fake.moveProjectItem(request);
        if (result.outcome !== "moved") return result;
        throw new Error("response lost after GitHub mutation");
      },
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      run: { state: "claiming", ownerToken: "owner-1" },
    });
    expect(fake.mutations()).toHaveLength(1);
    await coordinator.close();

    observerThrows = true;
    const restarted = coordinatorFor(connection, gateway);
    await expect(
      reconcileEffects({
        connection,
        coordinator: restarted,
        observer: createProjectTodoCapability(gateway, configuration).observer,
        settlementTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      name: expect.stringMatching(
        /^Reconciliation(?:Incomplete|Timeout)Error$/u,
      ),
    });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "ambiguous" });
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "claiming",
      ownerToken: "owner-1",
    });

    observerThrows = false;
    const reconciliation = await reconcileEffects({
      connection,
      coordinator: restarted,
      observer: createProjectTodoCapability(gateway, configuration).observer,
      settlementTimeoutMs: 100,
    });

    expect(reconciliation.observed).toEqual(["run:run-1:project:todo"]);
    expect(fake.mutations()).toHaveLength(1);
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "confirmed" });
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "preparing",
      ownerToken: "owner-1",
    });
    await restarted.close();
  });

  test.each([
    ["malformed", { labels: ["mvp", 1] }],
    ["mismatched", { issueNodeId: "I_9", issueNumber: 9 }],
  ] as const)(
    "keeps a %s observer result ambiguous until a later valid observation",
    async (_label, drift) => {
      const connection = await createDatabase();
      const fake = new FakeGitHubProjectGateway(snapshot());
      let observerDrift = false;
      const gateway: GitHubProjectGateway = {
        readProject: (request) => fake.readProject(request),
        readProjectItem: async (projectItemId) => {
          const observed = await fake.readProjectItem(projectItemId);
          if (!observerDrift || observed === undefined) return observed;
          return { ...observed, ...drift } as never;
        },
        moveProjectItem: async (request) => {
          const result = await fake.moveProjectItem(request);
          if (result.outcome !== "moved") return result;
          throw new Error("response lost after GitHub mutation");
        },
      };
      const coordinator = coordinatorFor(connection, gateway);

      const outcome = await claimNextEligible(
        input(connection, gateway, coordinator),
      );

      expect(outcome).toMatchObject({
        kind: "claim_rejected",
        run: { state: "claiming", ownerToken: "owner-1" },
      });
      expect(fake.mutations()).toHaveLength(1);
      await coordinator.close();

      observerDrift = true;
      const restarted = coordinatorFor(connection, gateway);
      await expect(
        reconcileEffects({
          connection,
          coordinator: restarted,
          observer: createProjectTodoCapability(gateway, configuration)
            .observer,
          settlementTimeoutMs: 100,
        }),
      ).rejects.toMatchObject({
        name: expect.stringMatching(
          /^Reconciliation(?:Incomplete|Timeout)Error$/u,
        ),
      });
      expect(
        connection.native
          .prepare("SELECT status FROM side_effects WHERE key = ?")
          .get("run:run-1:project:todo"),
      ).toEqual({ status: "ambiguous" });
      expect(await readRun(connection.db, "run-1")).toMatchObject({
        state: "claiming",
        ownerToken: "owner-1",
      });

      observerDrift = false;
      const reconciliation = await reconcileEffects({
        connection,
        coordinator: restarted,
        observer: createProjectTodoCapability(gateway, configuration).observer,
        settlementTimeoutMs: 100,
      });

      expect(reconciliation.observed).toEqual(["run:run-1:project:todo"]);
      expect(fake.mutations()).toHaveLength(1);
      expect(await readRun(connection.db, "run-1")).toMatchObject({
        state: "preparing",
        ownerToken: "owner-1",
      });
      await restarted.close();
    },
  );

  test("fails only when a valid observer proves the item is not Todo", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    let observerDrift = false;
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: async (projectItemId) => {
        const observed = await fake.readProjectItem(projectItemId);
        if (!observerDrift || observed === undefined) return observed;
        return { ...observed, status: "Review" };
      },
      moveProjectItem: async (request) => {
        const result = await fake.moveProjectItem(request);
        if (result.outcome !== "moved") return result;
        throw new Error("response lost after GitHub mutation");
      },
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      run: { state: "claiming", ownerToken: "owner-1" },
    });
    expect(fake.mutations()).toHaveLength(1);
    await coordinator.close();

    observerDrift = true;
    const restarted = coordinatorFor(connection, gateway);
    const reconciliation = await reconcileEffects({
      connection,
      coordinator: restarted,
      observer: createProjectTodoCapability(gateway, configuration).observer,
      settlementTimeoutMs: 100,
    });

    expect(reconciliation.observed).toEqual(["run:run-1:project:todo"]);
    expect(fake.mutations()).toHaveLength(1);
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "failed" });
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "claim_failed",
      ownerToken: null,
    });
    await restarted.close();
  });

  test("keeps a structurally malformed receipt ambiguous for observation", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: async (request) => {
        const source = await fake.readProjectItem(request.itemId);
        if (source === undefined) throw new Error("expected fake item");
        const observed = {
          ...source,
          status: "Todo",
          revision: "snapshot-2",
          labels: [1],
        };
        return { outcome: "moved", item: observed } as never;
      },
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      run: { state: "claiming", ownerToken: "owner-1" },
    });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "ambiguous" });
    expect(fake.mutations()).toHaveLength(0);
    await coordinator.close();
  });

  test("reconciles a malformed receipt after a successful mutation without redispatching", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: async (request) => {
        const result = await fake.moveProjectItem(request);
        if (result.outcome !== "moved") return result;
        return {
          outcome: "moved",
          item: { ...result.item, labels: ["mvp", 1] },
        } as never;
      },
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      run: { state: "claiming", ownerToken: "owner-1" },
    });
    expect(fake.mutations()).toHaveLength(1);
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "ambiguous" });

    await coordinator.close();

    const restarted = coordinatorFor(connection, gateway);
    await reconcileEffects({
      connection,
      coordinator: restarted,
      observer: createProjectTodoCapability(gateway, configuration).observer,
      settlementTimeoutMs: 100,
    });

    expect(fake.mutations()).toHaveLength(1);
    expect(await readRun(connection.db, "run-1")).toMatchObject({
      state: "preparing",
    });
    await restarted.close();
  });

  test("keeps an immutable-field receipt mismatch ambiguous for observation", async () => {
    const connection = await createDatabase();
    const fake = new FakeGitHubProjectGateway(snapshot());
    const gateway: GitHubProjectGateway = {
      readProject: (request) => fake.readProject(request),
      readProjectItem: (projectItemId) => fake.readProjectItem(projectItemId),
      moveProjectItem: async (request): Promise<ProjectStatusMoveResult> => {
        const result = await fake.moveProjectItem(request);
        if (result.outcome !== "moved") return result;
        return {
          outcome: "moved",
          item: { ...result.item, labels: ["mvp"] },
        };
      },
    };
    const coordinator = coordinatorFor(connection, gateway);

    const outcome = await claimNextEligible(
      input(connection, gateway, coordinator),
    );

    expect(outcome).toMatchObject({
      kind: "claim_rejected",
      run: { state: "claiming", ownerToken: "owner-1" },
    });
    expect(
      connection.native
        .prepare("SELECT status FROM side_effects WHERE key = ?")
        .get("run:run-1:project:todo"),
    ).toEqual({ status: "ambiguous" });
    expect(fake.mutations()).toHaveLength(1);
    await coordinator.close();
  });
});
