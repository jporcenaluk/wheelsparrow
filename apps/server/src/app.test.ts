import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";

import { buildApp } from "./app.js";
import { createReadinessGate } from "./readiness.js";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp() {
  const app = await buildApp({ readiness: createReadinessGate() });
  apps.push(app);
  return app;
}

describe("createReadinessGate", () => {
  test("starts not ready and tracks readiness transitions", () => {
    const readiness = createReadinessGate();

    expect(readiness.isReady()).toBe(false);
    readiness.markReady();
    expect(readiness.isReady()).toBe(true);
    readiness.markNotReady();
    expect(readiness.isReady()).toBe(false);
  });
});

describe("buildApp", () => {
  test("serves the liveness response without configuration or secret fields", async () => {
    const app = await createApp();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schema_version: 1, status: "ok" });
    expect(response.body).not.toMatch(/config|secret|token|password/i);
  });

  test("serves readiness transitions", async () => {
    const readiness = createReadinessGate();
    const app = await buildApp({ readiness });
    apps.push(app);

    const starting = await app.inject({ method: "GET", url: "/ready" });
    expect(starting.statusCode).toBe(503);
    expect(starting.json()).toEqual({ schema_version: 1, status: "starting" });

    readiness.markReady();
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ schema_version: 1, status: "ready" });

    readiness.markNotReady();
    const stopped = await app.inject({ method: "GET", url: "/ready" });
    expect(stopped.statusCode).toBe(503);
    expect(stopped.json()).toEqual({ schema_version: 1, status: "starting" });
  });

  test("awaits registerWeb once before returning the app", async () => {
    let registeredApp: FastifyInstance | undefined;
    const registerWeb = vi.fn(async (receivedApp: FastifyInstance) => {
      registeredApp = receivedApp;
    });

    const app = await buildApp({
      readiness: createReadinessGate(),
      registerWeb,
    });
    apps.push(app);

    expect(registerWeb).toHaveBeenCalledTimes(1);
    expect(registeredApp).toBe(app);
  });

  test("rejects registration failures without starting a listener", async () => {
    let registeredApp: Awaited<ReturnType<typeof buildApp>> | undefined;
    const registerWeb = vi.fn(async (app: FastifyInstance) => {
      registeredApp = app;
      throw new Error("web registration failed");
    });

    await expect(
      buildApp({ readiness: createReadinessGate(), registerWeb }),
    ).rejects.toThrow("web registration failed");

    expect(registerWeb).toHaveBeenCalledTimes(1);
    expect(registeredApp?.server.listening).toBe(false);
  });

  test("preserves registration failures when cleanup hooks fail", async () => {
    let registeredApp: Awaited<ReturnType<typeof buildApp>> | undefined;
    const registerWeb = vi.fn(async (app: FastifyInstance) => {
      registeredApp = app;
      app.addHook("onClose", async () => {
        throw new Error("close failed");
      });
      throw new Error("registration failed");
    });

    await expect(
      buildApp({ readiness: createReadinessGate(), registerWeb }),
    ).rejects.toThrow("registration failed");

    expect(registeredApp?.server.listening).toBe(false);
  });
});
