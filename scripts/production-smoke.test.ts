import { describe, expect, it } from "vitest";

import {
  assertAssetResponse,
  assertCanonicalSchemaLedger,
  assertSafeFixturePath,
  extractBuiltAssets,
  resolveBuiltMain,
  resolveFixturePrefix,
} from "./production-smoke.mjs";

const origin = new URL("http://127.0.0.1:43123/");
const MAX_ASSET_BODY_BYTES = 5 * 1024 * 1024;

function response(contentType: string, body: string): Response {
  return new Response(body, {
    headers: { "content-type": contentType },
    status: 200,
  });
}

describe("production smoke built UI verification", () => {
  it("locates the built server relative to the smoke script, not the caller CWD", () => {
    expect(resolveBuiltMain()).toMatch(/apps\/server\/dist\/main\.js$/);
  });

  it("places fixtures directly under the OS temp root with a fixed prefix", () => {
    expect(resolveFixturePrefix("/var/tmp")).toBe(
      "/var/tmp/wheelsparrow-production-smoke-",
    );
    expect(() =>
      assertSafeFixturePath(
        "/var/tmp",
        "/var/tmp/wheelsparrow-production-smoke-a1b2c3",
      ),
    ).not.toThrow();
    for (const unsafe of [
      "",
      "/var/tmp",
      "/var/tmp/other-a1b2c3",
      "/var/tmp/wheelsparrow-production-smoke-a1b2c3/nested",
      "/var/wheelsparrow-production-smoke-a1b2c3",
    ]) {
      expect(() => assertSafeFixturePath("/var/tmp", unsafe)).toThrow(
        "unsafe production smoke fixture",
      );
    }
  });

  it("requires canonical initial migration while allowing later migrations", () => {
    expect(() =>
      assertCanonicalSchemaLedger(
        [
          { id: 1, name: "001_initial.sql", checksum: "a".repeat(64) },
          { id: 2, name: "002_later.sql", checksum: "b".repeat(64) },
        ],
        ["approvals", "events", "findings", "runs", "side_effects", "steps"],
        "a".repeat(64),
      ),
    ).not.toThrow();

    expect(() =>
      assertCanonicalSchemaLedger(
        [{ id: 2, name: "002_later.sql", checksum: "b".repeat(64) }],
        ["runs"],
        "a".repeat(64),
      ),
    ).toThrow("canonical migration ledger");

    expect(() =>
      assertCanonicalSchemaLedger(
        [{ id: 1, name: "001_initial.sql", checksum: "wrong" }],
        ["runs"],
        "a".repeat(64),
      ),
    ).toThrow("canonical migration ledger");
  });

  it("requires local JavaScript and stylesheet assets from the built HTML", () => {
    expect(() =>
      extractBuiltAssets(
        '<!doctype html><script type="module" src="/assets/app.js"></script>',
        origin,
      ),
    ).toThrow("missing a stylesheet asset");

    expect(() =>
      extractBuiltAssets(
        '<!doctype html><link rel="stylesheet" href="/assets/app.css">',
        origin,
      ),
    ).toThrow("missing a JavaScript asset");
  });

  it("rejects external and unsafe built-asset references", () => {
    expect(() =>
      extractBuiltAssets(
        '<link rel="stylesheet" href="https://example.test/app.css"><script src="/assets/app.js"></script>',
        origin,
      ),
    ).toThrow("must be a local /assets/ path");

    expect(() =>
      extractBuiltAssets(
        '<link rel="stylesheet" href="/assets/app.css?cache=1"><script src="/assets/app.js"></script>',
        origin,
      ),
    ).toThrow("must not include a query or fragment");
  });

  it("rejects missing, HTML, empty, or broken built assets", async () => {
    const asset = {
      kind: "JavaScript" as const,
      path: "/assets/app.js",
      url: new URL("/assets/app.js", origin),
    };

    await expect(
      assertAssetResponse(asset, response("text/html", "<html></html>")),
    ).rejects.toThrow("did not return JavaScript media");
    await expect(
      assertAssetResponse(asset, response("application/javascript", "")),
    ).rejects.toThrow("had an empty body");
    await expect(
      assertAssetResponse(asset, new Response("missing", { status: 404 })),
    ).rejects.toThrow("did not return HTTP 200");
  });

  it("accepts a nonempty built asset within the size ceiling", async () => {
    const asset = {
      kind: "stylesheet" as const,
      path: "/assets/app.css",
      url: new URL("/assets/app.css", origin),
    };

    await expect(
      assertAssetResponse(asset, response("text/css", "x".repeat(16_384))),
    ).resolves.toBeUndefined();
  });

  it("rejects an asset whose declared body exceeds the asset limit", async () => {
    const asset = {
      kind: "stylesheet" as const,
      path: "/assets/app.css",
      url: new URL("/assets/app.css", origin),
    };
    const oversized = new Response("small body", {
      headers: {
        "content-length": String(MAX_ASSET_BODY_BYTES + 1),
        "content-type": "text/css",
      },
      status: 200,
    });

    await expect(assertAssetResponse(asset, oversized)).rejects.toThrow(
      "exceeded 5242880 bytes",
    );
  });

  it("rejects an asset whose streamed body exceeds the asset limit", async () => {
    const asset = {
      kind: "JavaScript" as const,
      path: "/assets/app.js",
      url: new URL("/assets/app.js", origin),
    };
    const chunk = new Uint8Array(MAX_ASSET_BODY_BYTES / 2 + 1);
    const oversized = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      }),
      { headers: { "content-type": "application/javascript" }, status: 200 },
    );

    await expect(assertAssetResponse(asset, oversized)).rejects.toThrow(
      "exceeded 5242880 bytes",
    );
  });
});
