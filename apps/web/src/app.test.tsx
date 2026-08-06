// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("announces that it is checking the service", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(<App />);

    expect(screen.getByRole("status").textContent).toContain(
      "Checking service",
    );
  });

  it("announces a live service for a valid health response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ schema_version: 1, status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    render(<App />);

    expect(await screen.findByText("Service live")).toBeTruthy();
  });

  it("announces an unavailable service for an HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    render(<App />);

    expect(await screen.findByText("Service unavailable")).toBeTruthy();
  });

  it("announces an unavailable service for a malformed health payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ schema_version: 1, status: "degraded" }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );

    render(<App />);

    expect(await screen.findByText("Service unavailable")).toBeTruthy();
  });

  it("treats a schema-valid HTML response as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ schema_version: 1, status: "ok" }), {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    render(<App />);

    expect(await screen.findByText("Service unavailable")).toBeTruthy();
  });
});

describe("browser theme", () => {
  it("declares dark and light color schemes and theme colors", () => {
    const html = readFileSync(
      resolve(import.meta.dirname, "../index.html"),
      "utf8",
    );
    const css = readFileSync(
      resolve(import.meta.dirname, "styles.css"),
      "utf8",
    );

    expect(html).toMatch(/name="color-scheme" content="dark light"/);
    expect(html).toMatch(/name="theme-color"[^>]+prefers-color-scheme: dark/);
    expect(html).toMatch(/name="theme-color"[^>]+prefers-color-scheme: light/);
    expect(css).toMatch(/color-scheme:\s*dark light/);
    expect(css).toMatch(/:root\s*{[^}]+--surface:[^;}]+;[^}]+--ink:[^;}]+;/s);
    expect(css).toMatch(
      /@media\s*\(prefers-color-scheme:\s*light\)\s*{\s*:root\s*{[^}]+--surface:[^;}]+;[^}]+--ink:[^;}]+;/s,
    );
  });
});
