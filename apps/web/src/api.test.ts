// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  approveRun,
  fetchQueue,
  retryStaging,
  safeGithubPullRequestUrl,
  subscribeToSnapshots,
} from "./api.js";

const queue = {
  schema_version: 1,
  scheduler: {
    revision: 0,
    paused: false,
    stop_after_current: false,
    updated_at: "now",
  },
  active_todo: null,
  ready: [],
  review: [],
  review_count: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe("operator API client", () => {
  it("posts the exact-SHA approval with the durable revision and CSRF token", async () => {
    document.head.innerHTML = '<meta name="csrf-token" content="csrf-test">';
    const headSha = "b".repeat(40);
    const baseSha = "a".repeat(40);
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("/api/runs/run-merge/approve");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("x-csrf-token")).toBe(
          "csrf-test",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          schema_version: 1,
          expected_run_revision: 3,
          approved_head_sha: headSha,
          approved_base_sha: baseSha,
        });
        return new Response(
          JSON.stringify({
            schema_version: 1,
            run: {
              run_id: "run-merge",
              issue_number: 7,
              repository: "owner/repository",
              state: "merging",
              revision: 4,
              rework_epoch: 0,
              repair_round: 0,
              branch: "codex/run-merge",
              pull_request_number: 7,
              pull_request_title: "Merge",
              pull_request_url: "https://github.com/owner/repository/pull/7",
              required_action: null,
              blocked_reason: null,
              updated_at: "2026-08-09T11:00:00.000Z",
              base_branch: "main",
              base_sha: baseSha,
              head_sha: headSha,
              observed_base_sha: baseSha,
              merge_sha: null,
              worktree_path: null,
              stop_requested_at: null,
              started_at: null,
              handed_off_at: null,
              terminal_at: null,
            },
            approval: {
              id: "approval-1",
              operator: "local-operator",
              approved_head_sha: headSha,
              observed_base_sha: baseSha,
              decision: "approved",
              invalidation_reason: null,
              created_at: "2026-08-09T11:00:00.000Z",
            },
            effect: {
              key: "run:run-merge:merge",
              kind: "merge",
              target_revision: 4,
              status: "in_flight",
            },
            merge_intent: {
              repository: "owner/repository",
              pull_request_number: 7,
              pull_request_url: "https://github.com/owner/repository/pull/7",
              branch: "codex/run-merge",
              base_sha: baseSha,
              head_sha: headSha,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetch);

    const response = await approveRun("run-merge", {
      schema_version: 1,
      expected_run_revision: 3,
      approved_head_sha: headSha,
      approved_base_sha: baseSha,
    });

    expect(response.effect.status).toBe("in_flight");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("surfaces the structured capability-unavailable result for staging retry", async () => {
    document.head.innerHTML = '<meta name="csrf-token" content="csrf-test">';
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("/api/runs/run-retry/retry-staging");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("x-csrf-token")).toBe(
          "csrf-test",
        );
        return new Response(
          JSON.stringify({
            schema_version: 1,
            error: {
              code: "capability_unavailable",
              message: "The staging delivery retry capability is unavailable.",
            },
          }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetch);

    await expect(retryStaging("run-retry")).rejects.toMatchObject({
      name: "OperatorApiError",
      status: 503,
      code: "capability_unavailable",
      message: "The staging delivery retry capability is unavailable.",
    });
  });

  it("rejects a schema-valid payload served with an HTML media type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(queue), {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    await expect(fetchQueue()).rejects.toThrow("JSON media type");
  });

  it("rejects application media types that are neither JSON nor +json", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(queue), {
            status: 200,
            headers: { "content-type": "application/problem" },
          }),
      ),
    );

    await expect(fetchQueue()).rejects.toThrow("JSON media type");
  });

  it("accepts only raw canonical GitHub pull request URLs", () => {
    expect(
      safeGithubPullRequestUrl("https://github.com/octo/widget/pull/7"),
    ).toBe("https://github.com/octo/widget/pull/7");
    for (const value of [
      "https://example.com/octo/widget/pull/7",
      "https://github.com/octo/widget/pull/0",
      "https://github.com/octo/widget/pull/7?tab=files",
      "https://github.com:443/octo/widget/pull/7",
      "https://github.com/octo%2Fwidget/pull/7",
      "javascript:alert(1)",
    ]) {
      expect(safeGithubPullRequestUrl(value)).toBeNull();
    }
  });

  it("invalidates only for a valid snapshot notification and closes on cleanup", () => {
    document.head.innerHTML = '<meta name="csrf-token" content="csrf-test">';
    let listener: ((event: MessageEvent<string>) => void) | undefined;
    const close = vi.fn();
    const source = {
      addEventListener: vi.fn(
        (_type: string, callback: (event: MessageEvent<string>) => void) => {
          listener = callback;
        },
      ),
      removeEventListener: vi.fn(),
      close,
    };
    class FakeEventSource {
      addEventListener = source.addEventListener;
      removeEventListener = source.removeEventListener;
      close = source.close;
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const onSnapshot = vi.fn();
    const cleanup = subscribeToSnapshots(onSnapshot);

    listener?.({
      data: JSON.stringify({ schema_version: 1, kind: "not-a-notification" }),
    } as MessageEvent<string>);
    expect(onSnapshot).not.toHaveBeenCalled();
    listener?.({
      data: JSON.stringify({ schema_version: 1, kind: "snapshot_changed" }),
    } as MessageEvent<string>);
    expect(onSnapshot).toHaveBeenCalledOnce();

    cleanup();
    expect(source.removeEventListener).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
