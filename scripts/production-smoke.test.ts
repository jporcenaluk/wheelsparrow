import { describe, expect, it } from "vitest";

import {
  assertAssetResponse,
  extractBuiltAssets,
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
