import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { parsePort } from "./main.js";
import { registerWeb } from "./web.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createWebRoot() {
  const root = await mkdtemp(join(tmpdir(), "wheelsparrow-web-"));
  temporaryRoots.push(root);
  await writeFile(`${root}/index.html`, "<h1>Wheelsparrow</h1>");
  return root;
}

describe("registerWeb", () => {
  it("serves the production browser entrypoint", async () => {
    const app = Fastify();
    try {
      await registerWeb(app, await createWebRoot());
      const response = await app.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Wheelsparrow");
    } finally {
      await app.close();
    }
  });

  it("uses the browser entrypoint for an HTML navigation", async () => {
    const app = Fastify();
    try {
      await registerWeb(app, await createWebRoot());
      const response = await app.inject({
        method: "GET",
        url: "/runs/example",
        headers: { accept: "text/html" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Wheelsparrow");
    } finally {
      await app.close();
    }
  });

  it("uses the parsed pathname when classifying SPA routes", async () => {
    const app = Fastify();
    try {
      await registerWeb(app, await createWebRoot());

      const reserved = await app.inject({
        method: "GET",
        url: "/api?view=html",
        headers: { accept: "text/html" },
      });
      const navigation = await app.inject({
        method: "GET",
        url: "/runs/example?return=.json",
        headers: { accept: "text/html" },
      });

      expect(reserved.statusCode).toBe(404);
      expect(reserved.json()).toEqual({ error: "not_found" });
      expect(navigation.statusCode).toBe(200);
      expect(navigation.body).toContain("Wheelsparrow");
    } finally {
      await app.close();
    }
  });

  it.each(["application/json,text/html;q=0", "text/htmlfoo"])(
    "rejects HTML navigation for Accept: %s",
    async (accept) => {
      const app = Fastify();
      try {
        await registerWeb(app, await createWebRoot());
        const response = await app.inject({
          method: "GET",
          url: "/runs/example",
          headers: { accept },
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "not_found" });
      } finally {
        await app.close();
      }
    },
  );

  it("accepts an HTML media type case-insensitively", async () => {
    const app = Fastify();
    try {
      await registerWeb(app, await createWebRoot());
      const response = await app.inject({
        method: "GET",
        url: "/runs/example",
        headers: { accept: "TEXT/HTML" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Wheelsparrow");
    } finally {
      await app.close();
    }
  });

  it.each(["/health", "/ready", "/api/runs", "/missing.js"])(
    "does not swallow the %s 404 with the SPA fallback",
    async (url) => {
      const app = Fastify();
      try {
        await registerWeb(app, await createWebRoot());
        const response = await app.inject({
          method: "GET",
          url,
          headers: { accept: "text/html" },
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "not_found" });
      } finally {
        await app.close();
      }
    },
  );

  it("keeps a non-HTML unknown route as a 404", async () => {
    const app = Fastify();
    try {
      await registerWeb(app, await createWebRoot());
      const response = await app.inject({
        method: "GET",
        url: "/unknown",
        headers: { accept: "application/json" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
    } finally {
      await app.close();
    }
  });
});

describe("parsePort", () => {
  it("accepts the default, zero, and the highest TCP port", () => {
    expect(parsePort(undefined)).toBe(4321);
    expect(parsePort("0")).toBe(0);
    expect(parsePort("65535")).toBe(65535);
  });

  it.each(["4321junk", "1.5", "-1", "65536", " 4321", ""])(
    "rejects invalid port %j",
    (value) => {
      expect(() => parsePort(value)).toThrow(
        "WHEELSPARROW_PORT must be an integer between 0 and 65535",
      );
    },
  );
});
