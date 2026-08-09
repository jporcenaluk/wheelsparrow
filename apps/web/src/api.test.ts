// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchQueue,
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
