import { describe, expect, test } from "vitest";
import type {
  ConditionalProjectStatusMove,
  GitHubProjectGateway,
  ProjectItem,
  ProjectSnapshot,
  ProjectSnapshotRequest,
  ProjectStatusMoveResult,
} from "./project.js";

describe("GitHub project gateway seam", () => {
  test("describes a typed project snapshot and conditional move contract", () => {
    const request: ProjectSnapshotRequest = {
      projectId: "PVT_1",
      projectNumber: 7,
      repository: "octo/widget",
    };
    const item: ProjectItem = {
      projectItemId: "PVTI_1",
      projectId: "PVT_1",
      projectNumber: 7,
      repository: "octo/widget",
      issueNodeId: "I_1",
      issueNumber: 1,
      isOpen: true,
      status: "Ready",
      revision: "snapshot-1",
      labels: ["mvp"],
      createdAt: "2026-08-08T12:00:00.000Z",
      dependencies: [],
    };
    const snapshot: ProjectSnapshot = {
      projectId: request.projectId,
      projectNumber: request.projectNumber,
      repository: request.repository,
      items: [item],
    };
    const move: ConditionalProjectStatusMove = {
      projectId: request.projectId,
      projectNumber: request.projectNumber,
      itemId: item.projectItemId,
      issueNodeId: item.issueNodeId,
      issueNumber: item.issueNumber,
      expectedRevision: item.revision,
      fromStatus: "Ready",
      toStatus: "Todo",
      effectKey: "project-todo:PVTI_1",
    };

    const gateway: GitHubProjectGateway = {
      readProject: async (input) => {
        expect(input).toEqual(request);
        return snapshot;
      },
      readProjectItem: async (projectItemId) =>
        projectItemId === item.projectItemId ? item : undefined,
      moveProjectItem: async (input) => {
        expect(input).toEqual(move);
        return { outcome: "moved", item } satisfies ProjectStatusMoveResult;
      },
    };

    expect(gateway).toBeDefined();
  });
});
