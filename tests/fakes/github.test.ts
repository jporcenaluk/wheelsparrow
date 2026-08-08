import { describe, expect, test } from "vitest";
import type {
  ConditionalProjectStatusMove,
  ProjectItem,
  ProjectSnapshot,
} from "../../apps/server/src/github/project.js";
import { FakeGitHubProjectGateway } from "./github.js";

const projectId = "PVT_1";
const projectNumber = 7;
const repository = "octo/widget";

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

function move(
  overrides: Partial<ConditionalProjectStatusMove> = {},
): ConditionalProjectStatusMove {
  return {
    projectId,
    projectNumber,
    itemId: "PVTI_1",
    issueNodeId: "I_1",
    issueNumber: 1,
    expectedRevision: "snapshot-1",
    fromStatus: "Ready",
    toStatus: "Todo",
    effectKey: "project-todo:PVTI_1",
    ...overrides,
  };
}

describe("FakeGitHubProjectGateway", () => {
  test("reads a configured project and returns defensive item copies", async () => {
    const fake = new FakeGitHubProjectGateway(
      snapshot([
        item({
          labels: ["mvp"],
          dependencies: [{ issueNodeId: "I_2", issueNumber: 2, isOpen: false }],
          priorityRank: 3,
        }),
      ]),
    );

    const observed = await fake.readProject({
      projectId,
      projectNumber,
      repository,
    });
    expect(observed).toEqual(
      snapshot([
        item({
          labels: ["mvp"],
          dependencies: [{ issueNodeId: "I_2", issueNumber: 2, isOpen: false }],
          priorityRank: 3,
        }),
      ]),
    );
    expect(await fake.readProjectItem("PVTI_1")).toEqual(observed.items[0]);

    const observedItem = observed.items[0];
    if (observedItem === undefined) throw new Error("expected a project item");
    (observedItem.labels as string[]).push("changed-outside-fake");
    expect((await fake.readProjectItem("PVTI_1"))?.labels).toEqual(["mvp"]);
  });

  test("moves once, advances the revision, and reports an exact replay as already applied", async () => {
    const fake = new FakeGitHubProjectGateway(snapshot());

    const first = await fake.moveProjectItem(move());
    expect(first.outcome).toBe("moved");
    if (first.outcome !== "moved") throw new Error("expected moved result");
    expect(first.item.status).toBe("Todo");
    expect(first.item.revision).not.toBe("snapshot-1");

    const replay = await fake.moveProjectItem(move());
    expect(replay).toMatchObject({
      outcome: "already_applied",
      item: first.item,
    });
    expect(fake.mutations()).toHaveLength(1);
    expect(fake.mutations()[0]).toMatchObject({
      effectKey: "project-todo:PVTI_1",
      itemId: "PVTI_1",
      fromStatus: "Ready",
      toStatus: "Todo",
    });
    expect(Object.isFrozen(fake.mutations())).toBe(true);
    expect(Object.isFrozen(fake.mutations()[0])).toBe(true);
  });

  test.each([
    ["wrong project", move({ projectId: "PVT_other" }), "wrong_project"],
    ["unknown item", move({ itemId: "PVTI_missing" }), "unknown_item"],
    [
      "stale revision",
      move({ expectedRevision: "snapshot-old" }),
      "revision_mismatch",
    ],
    ["stale source status", move({ fromStatus: "Review" }), "status_mismatch"],
    [
      "changed issue mapping",
      move({ issueNodeId: "I_other" }),
      "issue_mapping_mismatch",
    ],
  ] as const)(
    "rejects %s without a mutation",
    async (_label, request, reason) => {
      const fake = new FakeGitHubProjectGateway(snapshot());

      const result = await fake.moveProjectItem(request);

      expect(result).toMatchObject({
        outcome: "rejected",
        reason: { kind: reason },
      });
      expect(fake.mutations()).toHaveLength(0);
      expect(await fake.readProjectItem("PVTI_1")).toEqual(item());
    },
  );

  test("rejects a divergent request reusing an effect key", async () => {
    const fake = new FakeGitHubProjectGateway(snapshot());

    await expect(fake.moveProjectItem(move())).resolves.toMatchObject({
      outcome: "moved",
    });
    await expect(
      fake.moveProjectItem(move({ toStatus: "Review" })),
    ).resolves.toMatchObject({
      outcome: "rejected",
      reason: { kind: "effect_key_conflict" },
    });
    expect(fake.mutations()).toHaveLength(1);
  });

  test("rejects an exact replay after status or revision drift", async () => {
    const fake = new FakeGitHubProjectGateway(snapshot());

    const first = await fake.moveProjectItem(move());
    expect(first).toMatchObject({ outcome: "moved" });
    const mutationCount = fake.mutations().length;

    fake.setStatus("PVTI_1", "Review");
    const afterStatusDrift = await fake.moveProjectItem(move());
    expect(afterStatusDrift).toMatchObject({
      outcome: "rejected",
      reason: { kind: "already_applied_drift" },
    });
    expect(fake.mutations()).toHaveLength(mutationCount);

    fake.setStatus("PVTI_1", "Todo");
    fake.simulateRevisionDrift("PVTI_1");
    const afterRevisionDrift = await fake.moveProjectItem(move());
    expect(afterRevisionDrift).toMatchObject({
      outcome: "rejected",
      reason: { kind: "already_applied_drift" },
    });
    expect(fake.mutations()).toHaveLength(mutationCount);
  });

  test.each([
    ["effectKey", move({ effectKey: "" })],
    ["effectKey", move({ effectKey: " \t" })],
    ["fromStatus", move({ fromStatus: "" })],
    ["fromStatus", move({ fromStatus: " \t" })],
    ["toStatus", move({ toStatus: "" })],
    ["toStatus", move({ toStatus: " \t" })],
    ["expectedRevision", move({ expectedRevision: "" })],
    ["expectedRevision", move({ expectedRevision: " \t" })],
    ["projectNumber", move({ projectNumber: 0 })],
    ["projectNumber", move({ projectNumber: -1 })],
    ["projectNumber", move({ projectNumber: 1.5 })],
    ["projectNumber", move({ projectNumber: Number.NaN })],
    ["issueNumber", move({ issueNumber: 0 })],
    ["issueNumber", move({ issueNumber: -1 })],
    ["issueNumber", move({ issueNumber: 1.5 })],
    ["issueNumber", move({ issueNumber: Number.NaN })],
  ] as const)(
    "rejects malformed %s without changing state",
    async (field, request) => {
      const fake = new FakeGitHubProjectGateway(snapshot());
      const before = await fake.readProjectItem("PVTI_1");

      const result = await fake.moveProjectItem(request);

      expect(result).toMatchObject({
        outcome: "rejected",
        reason: { kind: "invalid_request", field },
      });
      expect(await fake.readProjectItem("PVTI_1")).toEqual(before);
      expect(fake.mutations()).toHaveLength(0);
    },
  );

  test("exposes safe status and issue-mapping drift that advances revision", async () => {
    const fake = new FakeGitHubProjectGateway(snapshot());

    fake.setStatus("PVTI_1", "Review");
    const afterStatusDrift = await fake.readProjectItem("PVTI_1");
    expect(afterStatusDrift?.status).toBe("Review");
    expect(afterStatusDrift?.revision).not.toBe("snapshot-1");

    fake.remapIssue("PVTI_1", { issueNodeId: "I_99", issueNumber: 99 });
    const afterIssueDrift = await fake.readProjectItem("PVTI_1");
    expect(afterIssueDrift).toMatchObject({
      issueNodeId: "I_99",
      issueNumber: 99,
    });
    expect(afterIssueDrift?.revision).not.toBe(afterStatusDrift?.revision);
  });

  test("preserves the configured project number and rejects a different number", async () => {
    expect(
      () =>
        new FakeGitHubProjectGateway(
          snapshot([item({ projectNumber: projectNumber + 1 })]),
        ),
    ).toThrow("belongs to another project");

    const numberedSnapshot = snapshot();
    const fake = new FakeGitHubProjectGateway(numberedSnapshot);

    const observed = await fake.readProject({
      projectId,
      repository,
      projectNumber,
    });
    expect(observed).toMatchObject({ projectNumber });
    expect(await fake.readProjectItem("PVTI_1")).toMatchObject({
      projectNumber,
    });

    const result = await fake.moveProjectItem({
      ...move(),
      projectNumber: 8,
    });
    expect(result).toMatchObject({
      outcome: "rejected",
      reason: { kind: "wrong_project" },
    });
    expect(fake.mutations()).toHaveLength(0);
  });

  test.each([
    ["blank issue node ID", item({ issueNodeId: "" })],
    ["whitespace issue node ID", item({ issueNodeId: " \t" })],
    ["zero issue number", item({ issueNumber: 0 })],
    ["negative issue number", item({ issueNumber: -1 })],
    ["fractional issue number", item({ issueNumber: 1.5 })],
    ["non-finite issue number", item({ issueNumber: Number.NaN })],
    ["unsafe issue number", item({ issueNumber: Number.MAX_SAFE_INTEGER + 1 })],
  ] as const)("rejects %s while constructing a fake", (_label, invalidItem) => {
    expect(
      () => new FakeGitHubProjectGateway(snapshot([invalidItem])),
    ).toThrow();
  });
});
