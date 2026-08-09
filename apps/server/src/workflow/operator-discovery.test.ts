import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import type { DatabaseConnection } from "../database/connection.js";
import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import type { ProjectSnapshot } from "../github/project.js";
import { discoverReadyQueue } from "./operator-discovery.js";

const migrationsSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const directories: string[] = [];
const connections: DatabaseConnection[] = [];

const configuration = {
  owner: "owner",
  repository: "owner/repository",
  projectNumber: 1,
  statusField: "Status",
  readyStatus: "Ready",
  requiredLabels: ["mvp"],
  priorityField: "Priority",
};

function snapshot(): ProjectSnapshot {
  const base = {
    projectId: "PVT_1",
    projectNumber: 1,
    repository: "owner/repository",
  } as const;
  return {
    ...base,
    items: [
      {
        projectItemId: "PVTI_good",
        ...base,
        issueNodeId: "I_good",
        issueNumber: 4,
        isOpen: true,
        status: "Ready",
        revision: "revision-good",
        labels: ["mvp"],
        createdAt: "2026-08-08T10:00:00.000Z",
        dependencies: [],
      },
      {
        projectItemId: "PVTI_blocked",
        ...base,
        issueNodeId: "I_blocked",
        issueNumber: 3,
        isOpen: true,
        status: "Ready",
        revision: "revision-blocked",
        labels: ["mvp"],
        createdAt: "2026-08-08T09:00:00.000Z",
        dependencies: [
          { issueNodeId: "I_dependency", issueNumber: 9, isOpen: true },
        ],
      },
      {
        projectItemId: "PVTI_todo",
        ...base,
        issueNodeId: "I_todo",
        issueNumber: 2,
        isOpen: true,
        status: "Todo",
        revision: "revision-todo",
        labels: ["mvp"],
        createdAt: "2026-08-08T08:00:00.000Z",
        dependencies: [],
      },
    ],
  };
}

function prioritySnapshot(): ProjectSnapshot {
  const base = {
    projectId: "PVT_1",
    projectNumber: 1,
    repository: "owner/repository",
  } as const;
  return {
    ...base,
    items: [
      {
        projectItemId: "PVTI_priority_late",
        ...base,
        issueNodeId: "I_priority_late",
        issueNumber: 99,
        isOpen: true,
        status: "Ready",
        revision: "revision-priority-late",
        labels: ["mvp"],
        createdAt: "2026-08-08T12:00:00.000Z",
        priorityRank: 1,
        dependencies: [],
      },
      {
        projectItemId: "PVTI_priority_early",
        ...base,
        issueNodeId: "I_priority_early",
        issueNumber: 1,
        isOpen: true,
        status: "Ready",
        revision: "revision-priority-early",
        labels: ["mvp"],
        createdAt: "2026-08-08T08:00:00.000Z",
        priorityRank: 2,
        dependencies: [],
      },
      {
        projectItemId: "PVTI_no_priority",
        ...base,
        issueNodeId: "I_no_priority",
        issueNumber: 2,
        isOpen: true,
        status: "Ready",
        revision: "revision-no-priority",
        labels: ["mvp"],
        createdAt: "2026-08-08T07:00:00.000Z",
        dependencies: [],
      },
    ],
  };
}

async function database(): Promise<DatabaseConnection> {
  const directory = await mkdtemp(
    join(tmpdir(), "wheelsparrow-operator-discovery-"),
  );
  directories.push(directory);
  const migrationsDirectory = join(directory, "migrations");
  await cp(migrationsSource, migrationsDirectory, { recursive: true });
  const connection = openDatabase(join(directory, "wheelsparrow.sqlite3"));
  migrateDatabase(connection, migrationsDirectory);
  connections.push(connection);
  return connection;
}

afterEach(async () => {
  await Promise.all(
    connections.splice(0).map((connection) => connection.close()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("operator Ready discovery", () => {
  test("preserves selector priority ordering instead of sorting Ready items by issue number", async () => {
    const connection = await database();
    const gateway = {
      async readConfiguredProject() {
        return prioritySnapshot();
      },
    };

    const queue = await discoverReadyQueue({
      connection,
      gateway,
      configuration,
      now: () => "2026-08-09T10:00:00.000Z",
    });

    expect(queue.map((item) => item.issue_number)).toEqual([99, 1, 2]);
  });

  test("returns truthful eligible and blocked Ready items from the configured gateway", async () => {
    const connection = await database();
    const gateway = {
      async readConfiguredProject() {
        return snapshot();
      },
    };

    const queue = await discoverReadyQueue({
      connection,
      gateway,
      configuration,
      now: () => "2026-08-09T10:00:00.000Z",
    });

    expect(queue.map((item) => item.issue_number)).toEqual([3, 4]);
    expect(queue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run_id: "ready:PVTI_good",
          issue_number: 4,
          state: "claiming",
          blocked_reason: null,
        }),
        expect.objectContaining({
          run_id: "ready:PVTI_blocked",
          issue_number: 3,
          blocked_reason: "blocked_dependency_open",
        }),
      ]),
    );
    expect(queue.map((item) => item.repository)).toEqual([
      "owner/repository",
      "owner/repository",
    ]);
  });

  test("propagates provider failures instead of presenting an empty Ready queue", async () => {
    const connection = await database();
    const failure = new Error("GitHub credentials unavailable");
    const gateway = {
      async readConfiguredProject(): Promise<ProjectSnapshot> {
        throw failure;
      },
    };

    await expect(
      discoverReadyQueue({ connection, gateway, configuration }),
    ).rejects.toBe(failure);
  });
});
