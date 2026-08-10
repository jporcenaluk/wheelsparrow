import { describe, expect, test } from "vitest";

import {
  parseLiveSmokeConfiguration,
  verifyDisposableTarget,
} from "./live-smoke.mjs";

const environment = {
  WHEELSPARROW_LIVE_SMOKE_DISPOSABLE: "true",
  WHEELSPARROW_LIVE_SMOKE_REPOSITORY: "example/disposable",
  WHEELSPARROW_LIVE_SMOKE_PROJECT_NUMBER: "7",
  GITHUB_TOKEN: "github_pat_example",
  GITHUB_REPOSITORY: "owner/wheelsparrow",
};

describe("live-smoke contract", () => {
  test("requires an explicit disposable external target and credential", () => {
    expect(parseLiveSmokeConfiguration(environment)).toMatchObject({
      repository: "example/disposable",
      projectNumber: 7,
    });
    expect(() =>
      parseLiveSmokeConfiguration({
        ...environment,
        WHEELSPARROW_LIVE_SMOKE_DISPOSABLE: "false",
      }),
    ).toThrow(/disposable/i);
    expect(() =>
      parseLiveSmokeConfiguration({
        ...environment,
        WHEELSPARROW_LIVE_SMOKE_REPOSITORY: "owner/wheelsparrow",
      }),
    ).toThrow(/current repository/i);
    expect(() => {
      const { GITHUB_TOKEN: _token, ...withoutToken } = environment;
      return parseLiveSmokeConfiguration(withoutToken);
    }).toThrow(/credential/i);
  });

  test("proves the selected repository and project without mutating either", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const configuration = parseLiveSmokeConfiguration(environment);
    const fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      if (init?.method === "POST")
        return Response.json({
          data: {
            organization: {
              projectV2: { id: "PVT_1", number: 7, closed: false },
            },
            user: null,
          },
        });
      return Response.json({
        full_name: "example/disposable",
        archived: false,
      });
    };

    await expect(
      verifyDisposableTarget({ configuration, fetch }),
    ).resolves.toEqual({
      repository: "example/disposable",
      projectNumber: 7,
      projectId: "PVT_1",
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(calls[0]?.url).toContain("/repos/example/disposable");
  });

  test("fails closed when GitHub returns another repository or no open project", async () => {
    const configuration = parseLiveSmokeConfiguration(environment);
    await expect(
      verifyDisposableTarget({
        configuration,
        fetch: async () => Response.json({ full_name: "other/repository" }),
      }),
    ).rejects.toThrow(/identity/i);
    let call = 0;
    await expect(
      verifyDisposableTarget({
        configuration,
        fetch: async () => {
          call += 1;
          return call === 1
            ? Response.json({
                full_name: "example/disposable",
                archived: false,
              })
            : Response.json({
                data: {
                  organization: {
                    projectV2: { id: "PVT_1", number: 7, closed: true },
                  },
                  user: null,
                },
              });
        },
      }),
    ).rejects.toThrow(/project/i);
  });
});
