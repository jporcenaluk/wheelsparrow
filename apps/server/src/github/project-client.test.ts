import { describe, expect, test } from "vitest";

import {
  GitHubCredentialsUnavailableError,
  GitHubProjectClient,
  GitHubProjectResponseError,
} from "./project-client.js";

const configuration = {
  owner: "octo",
  repository: "octo/widget",
  projectNumber: 7,
  statusField: "Status",
  readyStatus: "Ready",
  requiredLabels: ["mvp"],
  priorityField: "Priority",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function projectPage() {
  return {
    data: {
      node: {
        id: "PVT_7",
        number: 7,
        items: {
          nodes: [
            {
              id: "PVTI_good",
              content: {
                __typename: "Issue",
                id: "I_good",
                number: 11,
                state: "OPEN",
                createdAt: "2026-08-08T10:00:00Z",
                repository: { nameWithOwner: "octo/widget" },
                labels: { nodes: [{ name: "mvp" }] },
                blockedBy: {
                  nodes: [],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null as string | null,
                  },
                },
              },
              fieldValues: {
                nodes: [
                  {
                    __typename: "ProjectV2ItemFieldSingleSelectValue",
                    name: "Ready",
                    optionId: "status-ready",
                    field: {
                      id: "field-status",
                      name: "Status",
                      options: [
                        { id: "status-ready", name: "Ready" },
                        { id: "status-todo", name: "Todo" },
                      ],
                    },
                  },
                  {
                    __typename: "ProjectV2ItemFieldSingleSelectValue",
                    name: "P1",
                    optionId: "priority-one",
                    field: {
                      id: "field-priority",
                      name: "Priority",
                      options: [
                        { id: "priority-one", name: "P1" },
                        { id: "priority-two", name: "P2" },
                      ],
                    },
                  },
                ],
              },
            },
            {
              id: "PVTI_blocked",
              content: {
                __typename: "Issue",
                id: "I_blocked",
                number: 12,
                state: "OPEN",
                createdAt: "2026-08-08T11:00:00Z",
                repository: { nameWithOwner: "octo/widget" },
                labels: { nodes: [{ name: "mvp" }] },
                blockedBy: {
                  nodes: [{ id: "I_dep", number: 13, state: "OPEN" }],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null as string | null,
                  },
                },
              },
              fieldValues: {
                nodes: [
                  {
                    __typename: "ProjectV2ItemFieldSingleSelectValue",
                    name: "Ready",
                    optionId: "status-ready",
                    field: {
                      id: "field-status",
                      name: "Status",
                      options: [{ id: "status-ready", name: "Ready" }],
                    },
                  },
                ],
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}

describe("configured GitHub Project client", () => {
  test("fails closed before making a request when no credential is available", async () => {
    let calls = 0;
    const client = new GitHubProjectClient({
      ...configuration,
      fetch: async () => {
        calls += 1;
        return response({});
      },
    });

    await expect(client.readConfiguredProject()).rejects.toBeInstanceOf(
      GitHubCredentialsUnavailableError,
    );
    expect(calls).toBe(0);
  });

  test("reads the configured project and turns Project fields into the typed snapshot", async () => {
    const requests: Array<{ body: string; authorization: string | null }> = [];
    const client = new GitHubProjectClient({
      ...configuration,
      token: "test-token",
      fetch: async (_input, init) => {
        requests.push({
          body: String(init?.body),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return requests.length === 1
          ? response({
              data: {
                user: { projectV2: { id: "PVT_7" } },
                organization: null,
              },
            })
          : response(projectPage());
      },
    });

    await expect(client.readConfiguredProject()).resolves.toEqual({
      projectId: "PVT_7",
      projectNumber: 7,
      repository: "octo/widget",
      items: [
        {
          projectItemId: "PVTI_good",
          projectId: "PVT_7",
          projectNumber: 7,
          repository: "octo/widget",
          issueNodeId: "I_good",
          issueNumber: 11,
          isOpen: true,
          status: "Ready",
          revision: expect.stringMatching(/^[0-9a-f]{64}$/u),
          labels: ["mvp"],
          createdAt: "2026-08-08T10:00:00.000Z",
          priorityRank: 0,
          dependencies: [],
        },
        {
          projectItemId: "PVTI_blocked",
          projectId: "PVT_7",
          projectNumber: 7,
          repository: "octo/widget",
          issueNodeId: "I_blocked",
          issueNumber: 12,
          isOpen: true,
          status: "Ready",
          revision: expect.stringMatching(/^[0-9a-f]{64}$/u),
          labels: ["mvp"],
          createdAt: "2026-08-08T11:00:00.000Z",
          dependencies: [
            { issueNodeId: "I_dep", issueNumber: 13, isOpen: true },
          ],
        },
      ],
    });
    expect(requests[0]?.authorization).toBe("Bearer test-token");
    expect(requests[0]?.body).not.toContain("test-token");
    expect(requests[1]?.body).toContain('"projectId":"PVT_7"');
  });

  test("does not turn an HTTP or GraphQL error into an empty snapshot", async () => {
    const client = new GitHubProjectClient({
      ...configuration,
      token: "test-token",
      fetch: async () => response({ errors: [{ message: "forbidden" }] }),
    });

    await expect(client.readConfiguredProject()).rejects.toBeInstanceOf(
      GitHubProjectResponseError,
    );
  });

  test("marks dependencies unavailable when the blockedBy page is truncated", async () => {
    const page = projectPage();
    const blocked = page.data.node.items.nodes[1];
    if (blocked === undefined) throw new Error("blocked fixture is missing");
    blocked.content.blockedBy = {
      nodes: Array.from({ length: 100 }, (_, index) => ({
        id: `I_closed_${index}`,
        number: index + 100,
        state: "CLOSED",
      })),
      pageInfo: { hasNextPage: true, endCursor: "cursor:100" },
    };
    const client = new GitHubProjectClient({
      ...configuration,
      token: "test-token",
      fetch: async (_input, init) =>
        String(init?.body).includes("projectId")
          ? response(page)
          : response({
              data: {
                user: { projectV2: { id: "PVT_7" } },
                organization: null,
              },
            }),
    });

    const snapshot = await client.readConfiguredProject();
    expect(snapshot.items[1]?.dependencies).toBe("unavailable");
  });
});
