import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";

import {
  ConfigurationSchema,
  HealthResponseSchema,
  ReadyResponseSchema,
} from "./index.js";

const validConfiguration = {
  github: {
    owner: "wheelsparrow",
    repository: "wheelsparrow",
    project_number: 1,
    status_field: "Status",
    lanes: {
      ready: "Ready",
      todo: "Todo",
      review: "Review",
      done: "Done",
    },
    required_labels: ["agent-ready"],
    priority_field: "Priority",
  },
  poll_interval_seconds: 60,
  workspace_root: "/workspace",
  agent: {
    command: "codex",
    model: "gpt-5.6",
    reasoning_effort: "high",
    timeout_minutes: 30,
  },
  verification: {
    command: "pnpm test",
  },
  staging: {
    workflow: "deploy-staging.yml",
    environment: "staging",
    smoke_command: "pnpm smoke",
  },
};

describe("health contracts", () => {
  test("accepts a versioned healthy response", () => {
    expect(
      Value.Check(HealthResponseSchema, { schema_version: 1, status: "ok" }),
    ).toBe(true);
  });

  test("rejects a health response without a schema version", () => {
    expect(Value.Check(HealthResponseSchema, { status: "ok" })).toBe(false);
  });

  test("accepts starting and ready readiness responses", () => {
    expect(
      Value.Check(ReadyResponseSchema, {
        schema_version: 1,
        status: "starting",
      }),
    ).toBe(true);
    expect(
      Value.Check(ReadyResponseSchema, { schema_version: 1, status: "ready" }),
    ).toBe(true);
  });
});

describe("configuration contract", () => {
  test("accepts complete non-secret configuration", () => {
    expect(Value.Check(ConfigurationSchema, validConfiguration)).toBe(true);
  });

  test("rejects literal secrets and incomplete configuration", () => {
    expect(
      Value.Check(ConfigurationSchema, { github: { token: "secret" } }),
    ).toBe(false);
  });

  test("rejects additional properties, invalid effort, and empty labels", () => {
    expect(
      Value.Check(ConfigurationSchema, {
        ...validConfiguration,
        token: "secret",
      }),
    ).toBe(false);
    expect(
      Value.Check(ConfigurationSchema, {
        ...validConfiguration,
        agent: { ...validConfiguration.agent, reasoning_effort: "none" },
      }),
    ).toBe(false);
    expect(
      Value.Check(ConfigurationSchema, {
        ...validConfiguration,
        github: { ...validConfiguration.github, required_labels: [] },
      }),
    ).toBe(false);
  });

  test.each([
    {
      path: "github",
      configuration: {
        ...validConfiguration,
        github: { ...validConfiguration.github, token: "secret" },
      },
    },
    {
      path: "github.lanes",
      configuration: {
        ...validConfiguration,
        github: {
          ...validConfiguration.github,
          lanes: { ...validConfiguration.github.lanes, secret: "secret" },
        },
      },
    },
    {
      path: "agent",
      configuration: {
        ...validConfiguration,
        agent: { ...validConfiguration.agent, token: "secret" },
      },
    },
    {
      path: "verification",
      configuration: {
        ...validConfiguration,
        verification: { ...validConfiguration.verification, secret: "secret" },
      },
    },
    {
      path: "staging",
      configuration: {
        ...validConfiguration,
        staging: { ...validConfiguration.staging, token: "secret" },
      },
    },
  ])("rejects unknown nested properties at $path", ({ configuration }) => {
    expect(Value.Check(ConfigurationSchema, configuration)).toBe(false);
  });
});

describe("package consumption", () => {
  test("exposes schemas through the bare package import", async () => {
    const contracts = await import("@wheelsparrow/contracts");

    expect(contracts.ConfigurationSchema).toBeDefined();
    expect(contracts.HealthResponseSchema).toBeDefined();
    expect(contracts.ReadyResponseSchema).toBeDefined();
  });
});
