import { describe, expect, it } from "vitest";

import config from "../vite.config.js";

describe("Vite development proxy", () => {
  it("forwards the operator API and SSE path to Fastify", () => {
    expect(config.server?.proxy).toMatchObject({
      "/api": "http://127.0.0.1:4321",
    });
  });
});
