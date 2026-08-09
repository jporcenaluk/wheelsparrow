import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../database/connection.js";
import { migrateDatabase } from "../database/migrate.js";
import {
  createRunMutationRepository,
  listActiveProjectItemIds,
} from "../database/runs.js";
import type { ProjectItem, ProjectSnapshot } from "../github/project.js";
import { selectProjectCandidate } from "./discovery.js";

const migrationsSource = fileURLToPath(
  new URL("../../../../migrations", import.meta.url),
);
const temporaryDirectories: string[] = [];
const connections = new Set<ReturnType<typeof openDatabase>>();

const configuration = {
  projectId: "PVT_1",
  projectNumber: 2,
  repository: "octo/widget",
  readyStatus: "Ready",
  requiredLabels: ["mvp", "ready"],
};

function item(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    projectItemId: "PVTI_1",
    projectId: configuration.projectId,
    projectNumber: configuration.projectNumber,
    repository: configuration.repository,
    issueNodeId: "I_1",
    issueNumber: 1,
    isOpen: true,
    status: configuration.readyStatus,
    revision: "1",
    labels: ["mvp", "ready"],
    createdAt: "2026-08-08T10:00:00.000Z",
    dependencies: [],
    ...overrides,
  };
}

function snapshot(items: readonly ProjectItem[]): ProjectSnapshot {
  return {
    projectId: configuration.projectId,
    projectNumber: configuration.projectNumber,
    repository: configuration.repository,
    items,
  };
}

async function createDatabase(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-discovery-"));
  temporaryDirectories.push(directory);
  const migrationsDirectory = join(directory, "migrations");
  await cp(migrationsSource, migrationsDirectory, { recursive: true });
  const connection = openDatabase(join(directory, "wheelsparrow.sqlite3"));
  migrateDatabase(connection, migrationsDirectory);
  connections.add(connection);
  return connection;
}

afterEach(async () => {
  for (const connection of connections) {
    await connection.close();
  }
  connections.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("selectProjectCandidate", () => {
  test.each([
    ["wrong project", item({ projectId: "PVT_other" }), "wrong_project"],
    ["wrong project number", item({ projectNumber: 99 }), "wrong_project"],
    [
      "wrong repository",
      item({ repository: "octo/other" }),
      "wrong_repository",
    ],
    ["closed issue", item({ isOpen: false }), "issue_closed"],
    ["wrong status", item({ status: "Todo" }), "status_not_ready"],
    [
      "missing one required label",
      item({ labels: ["mvp"] }),
      "missing_required_label",
    ],
    [
      "open dependency",
      item({
        dependencies: [{ issueNodeId: "I_2", issueNumber: 2, isOpen: true }],
      }),
      "blocked_dependency_open",
    ],
    [
      "unavailable dependencies",
      item({ dependencies: "unavailable" }),
      "blocked_dependencies_unavailable",
    ],
    [
      "durably owned item",
      item({ projectItemId: "PVTI_owned" }),
      "owned_durable",
    ],
    [
      "invalid creation timestamp",
      item({ createdAt: "not-an-iso-timestamp" }),
      "invalid_created_at",
    ],
    [
      "impossible UTC calendar date",
      item({ createdAt: "2026-02-31T00:00:00.000Z" }),
      "invalid_created_at",
    ],
    ["sparse labels", item({ labels: new Array(1) }), "invalid_item_identity"],
    [
      "sparse dependencies",
      item({ dependencies: new Array(1) }),
      "invalid_dependencies",
    ],
  ] as const)("excludes $0", (name, candidate, reason) => {
    const result = selectProjectCandidate(snapshot([candidate]), {
      ...configuration,
      ownedProjectItemIds:
        name === "durably owned item"
          ? new Set([candidate.projectItemId])
          : new Set(),
    });

    expect(result.selected).toBeUndefined();
    expect(result.eligible).toEqual([]);
    expect(result.excluded).toContainEqual(
      expect.objectContaining({
        projectItemId: candidate.projectItemId,
        issueNumber: candidate.issueNumber,
        reason,
      }),
    );
  });

  test("requires all configured labels and includes only safely unblocked items", () => {
    const result = selectProjectCandidate(
      snapshot([
        item({ projectItemId: "PVTI_good", issueNumber: 7 }),
        item({
          projectItemId: "PVTI_missing",
          issueNumber: 8,
          labels: ["mvp"],
        }),
        item({
          projectItemId: "PVTI_closed-dependency",
          issueNumber: 9,
          dependencies: [{ issueNodeId: "I_2", issueNumber: 2, isOpen: false }],
        }),
      ]),
      { ...configuration, ownedProjectItemIds: new Set() },
    );

    expect(result.selected?.issueNumber).toBe(7);
    expect(result.eligible.map((candidate) => candidate.issueNumber)).toEqual([
      7, 9,
    ]);
    expect(result.excluded).toContainEqual(
      expect.objectContaining({
        issueNumber: 8,
        reason: "missing_required_label",
      }),
    );
  });

  test("orders explicit priority, creation time, issue number, and item ID deterministically", () => {
    const items = [
      item({
        projectItemId: "PVTI_z",
        issueNumber: 30,
        priorityRank: 2,
        createdAt: "2026-08-08T12:00:00.000Z",
      }),
      item({
        projectItemId: "PVTI_a",
        issueNumber: 10,
        priorityRank: 1,
        createdAt: "2026-08-08T12:00:00.000Z",
      }),
      item({
        projectItemId: "PVTI_b",
        issueNumber: 20,
        priorityRank: 1,
        createdAt: "2026-08-08T12:00:00.000Z",
      }),
      item({
        projectItemId: "PVTI_old",
        issueNumber: 99,
        priorityRank: 1,
        createdAt: "2026-08-08T11:00:00.000Z",
      }),
      item({
        projectItemId: "PVTI_missing-priority",
        issueNumber: 1,
        createdAt: "2026-08-08T09:00:00.000Z",
      }),
      item({
        projectItemId: "PVTI_same-id-b",
        issueNumber: 40,
        priorityRank: 3,
        createdAt: "2026-08-08T12:00:00.000Z",
      }),
      item({
        projectItemId: "PVTI_same-id-a",
        issueNumber: 40,
        priorityRank: 3,
        createdAt: "2026-08-08T12:00:00.000Z",
      }),
    ];
    const input = { ...configuration, ownedProjectItemIds: new Set<string>() };

    const first = selectProjectCandidate(snapshot(items), input);
    const second = selectProjectCandidate(
      snapshot([...items].reverse()),
      input,
    );

    expect(first.eligible.map((candidate) => candidate.projectItemId)).toEqual([
      "PVTI_old",
      "PVTI_a",
      "PVTI_b",
      "PVTI_z",
      "PVTI_same-id-a",
      "PVTI_same-id-b",
      "PVTI_missing-priority",
    ]);
    expect(second.eligible).toEqual(first.eligible);
  });

  test("fails closed for malformed identity and dependency records", () => {
    const malformedIdentity = item({
      projectItemId: "",
      issueNodeId: "",
      issueNumber: 0,
    });
    const malformedDependency = item({
      projectItemId: "PVTI_bad-dependency",
      dependencies: [
        { issueNodeId: "", issueNumber: 0, isOpen: "unknown" as never },
      ],
    });

    const result = selectProjectCandidate(
      snapshot([malformedIdentity, malformedDependency]),
      { ...configuration, ownedProjectItemIds: new Set() },
    );

    expect(result.selected).toBeUndefined();
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectItemId: "",
          reason: "invalid_item_identity",
        }),
        expect.objectContaining({
          projectItemId: "PVTI_bad-dependency",
          reason: "invalid_dependencies",
        }),
      ]),
    );
  });

  test.each([
    null,
    {},
    { has: "not-a-function" },
    { has: Set.prototype.has },
    {
      has: () => {
        throw new Error("custom ownership method must not run");
      },
    },
    { has: () => "owned" },
  ])(
    "returns a finite invalid-input result for malformed ownership %j",
    (owned) => {
      const result = selectProjectCandidate(snapshot([item()]), {
        ...configuration,
        ownedProjectItemIds: owned as never,
      });

      expect(result).toMatchObject({
        selected: undefined,
        eligible: [],
        reason: "invalid_input",
      });
      expect(result.excluded).toContainEqual(
        expect.objectContaining({ reason: "invalid_input" }),
      );
    },
  );

  test("fails closed when the snapshot item array is sparse", () => {
    const items = new Array<ProjectItem>(2);
    items[0] = item({ projectItemId: "PVTI_present" });

    const result = selectProjectCandidate(snapshot(items), {
      ...configuration,
      ownedProjectItemIds: new Set(),
    });

    expect(result).toMatchObject({ selected: undefined, eligible: [] });
    expect(result.excluded).toContainEqual(
      expect.objectContaining({ reason: "invalid_snapshot_items" }),
    );
  });

  test("excludes every duplicate project item ID", () => {
    const result = selectProjectCandidate(
      snapshot([
        item({ projectItemId: "PVTI_duplicate", issueNumber: 1 }),
        item({ projectItemId: "PVTI_duplicate", issueNumber: 2 }),
      ]),
      { ...configuration, ownedProjectItemIds: new Set() },
    );

    expect(result).toMatchObject({ selected: undefined, eligible: [] });
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "duplicate_project_item_id" }),
        expect.objectContaining({ reason: "duplicate_project_item_id" }),
      ]),
    );
  });

  test("excludes a valid item when a malformed duplicate shares its ID", () => {
    const result = selectProjectCandidate(
      snapshot([
        item({ projectItemId: "PVTI_duplicate", issueNumber: 1 }),
        item({
          projectItemId: "PVTI_duplicate",
          issueNodeId: "",
          issueNumber: 0,
        }),
      ]),
      { ...configuration, ownedProjectItemIds: new Set() },
    );

    expect(result.selected).toBeUndefined();
    expect(result.eligible).toEqual([]);
    expect(result.excluded).toHaveLength(2);
    expect(result.excluded.map(({ reason }) => reason)).toEqual([
      "duplicate_project_item_id",
      "duplicate_project_item_id",
    ]);
  });
});

describe("listActiveProjectItemIds", () => {
  test("returns only active ownership from a real migrated SQLite database", async () => {
    const connection = await createDatabase();
    const createClaim = async (id: string, projectItemId: string) => {
      await connection.db.transaction().execute((tx) =>
        createRunMutationRepository(tx).createClaim({
          id,
          repository: configuration.repository,
          projectItemId,
          issueNodeId: `I_${id}`,
          issueNumber: Number(id.replace("run-", "")),
          ownerToken: `owner-${id}`,
          at: "2026-08-08T10:00:00.000Z",
          summary: { text: "test ownership" },
        }),
      );
      await connection.db
        .updateTable("runs")
        .set({ state: "review" })
        .where("id", "=", id)
        .execute();
    };

    await createClaim("run-1", "PVTI_active");
    await createClaim("run-2", "PVTI_released");
    await createClaim("run-3", "PVTI_no-owner");
    await connection.db
      .updateTable("runs")
      .set({ ownership_released_at: "2026-08-08T11:00:00.000Z" })
      .where("id", "=", "run-2")
      .execute();
    await connection.db
      .updateTable("runs")
      .set({ owner_token: null })
      .where("id", "=", "run-3")
      .execute();

    const before = await connection.db
      .selectFrom("runs")
      .select(["project_item_id", "owner_token", "ownership_released_at"])
      .orderBy("id")
      .execute();
    const active = await listActiveProjectItemIds(connection.db);
    const after = await connection.db
      .selectFrom("runs")
      .select(["project_item_id", "owner_token", "ownership_released_at"])
      .orderBy("id")
      .execute();

    expect([...active]).toEqual(["PVTI_active"]);
    expect(after).toEqual(before);

    const selection = selectProjectCandidate(
      snapshot([item({ projectItemId: "PVTI_active" })]),
      { ...configuration, ownedProjectItemIds: active },
    );
    expect(selection.selected).toBeUndefined();
    expect(selection.excluded).toContainEqual(
      expect.objectContaining({
        projectItemId: "PVTI_active",
        reason: "owned_durable",
      }),
    );
  });
});
