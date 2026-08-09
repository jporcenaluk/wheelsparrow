// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.js";

const queueResponse = {
  schema_version: 1,
  scheduler: {
    revision: 2,
    paused: false,
    stop_after_current: false,
    updated_at: "2026-08-09T11:00:00.000Z",
  },
  active_todo: null,
  ready: [
    {
      run_id: "run-ready",
      issue_number: 42,
      repository: "owner/repo",
      state: "preparing",
      revision: 4,
      rework_epoch: 0,
      repair_round: 0,
      branch: "codex/run-ready",
      pull_request_number: null,
      pull_request_title: null,
      pull_request_url: null,
      required_action: null,
      blocked_reason: null,
      updated_at: "2026-08-09T11:00:00.000Z",
    },
  ],
  review: [],
  review_count: 0,
};

function responseFor(url: string, init?: RequestInit): Response {
  if (url === "/health") {
    return new Response(JSON.stringify({ schema_version: 1, status: "ok" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "csrf-test",
      },
    });
  }
  if (url === "/api/operator/session") {
    return new Response(
      JSON.stringify({ schema_version: 1, csrf_token: "csrf-test" }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }
  if (
    url === "/api/operator/queue" &&
    (!init?.method || init.method === "GET")
  ) {
    return new Response(JSON.stringify(queueResponse), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "csrf-test",
      },
    });
  }
  if (url === "/api/operator/scheduler" && init?.method === "PATCH") {
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-test");
    expect(JSON.parse(String(init.body))).toEqual({
      schema_version: 1,
      expected_revision: 2,
      paused: true,
    });
    return new Response(
      JSON.stringify({
        schema_version: 1,
        scheduler: { ...queueResponse.scheduler, revision: 3, paused: true },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "csrf-test",
        },
      },
    );
  }
  throw new Error(`Unexpected request: ${url}`);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("operator browser routes", () => {
  it("renders the Queue snapshot and an active scheduler control", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        responseFor(String(input), init),
      ),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Queue" })).toBeTruthy();
    expect(screen.getByText("Issue #42")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause queue" })).toBeTruthy();
  });

  it("sends the durable scheduler revision and CSRF token when pausing", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      responseFor(String(input), init),
    );
    vi.stubGlobal("fetch", fetch);

    render(<App />);
    await screen.findByRole("heading", { name: "Queue" });
    fireEvent.click(screen.getByRole("button", { name: "Pause queue" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/operator/scheduler",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    expect(
      await screen.findByRole("button", { name: "Resume queue" }),
    ).toBeTruthy();
  });

  it("navigates to the Review route without inventing client workflow state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/operator/review") {
          return new Response(
            JSON.stringify({ schema_version: 1, items: [] }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-csrf-token": "csrf-test",
              },
            },
          );
        }
        return responseFor(url, init);
      }),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "Queue" });
    fireEvent.click(screen.getByRole("link", { name: "Review" }));

    expect(await screen.findByRole("heading", { name: "Review" })).toBeTruthy();
    expect(screen.getByText("No runs need your attention.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /approve|merge/i })).toBeNull();
  });
});
