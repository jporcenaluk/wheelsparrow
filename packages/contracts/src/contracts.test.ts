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
    [
      "github.owner",
      (value: typeof validConfiguration) => (value.github.owner = "   "),
    ],
    [
      "github.repository",
      (value: typeof validConfiguration) => (value.github.repository = "\t"),
    ],
    [
      "github.status_field",
      (value: typeof validConfiguration) => (value.github.status_field = "\n"),
    ],
    [
      "github.lanes.ready",
      (value: typeof validConfiguration) => (value.github.lanes.ready = "   "),
    ],
    [
      "github.lanes.todo",
      (value: typeof validConfiguration) => (value.github.lanes.todo = "   "),
    ],
    [
      "github.lanes.review",
      (value: typeof validConfiguration) => (value.github.lanes.review = "   "),
    ],
    [
      "github.lanes.done",
      (value: typeof validConfiguration) => (value.github.lanes.done = "   "),
    ],
    [
      "github.required_labels[]",
      (value: typeof validConfiguration) =>
        (value.github.required_labels[0] = "   "),
    ],
    [
      "github.priority_field",
      (value: typeof validConfiguration) =>
        (value.github.priority_field = "   "),
    ],
    [
      "workspace_root",
      (value: typeof validConfiguration) => (value.workspace_root = "   "),
    ],
    [
      "agent.command",
      (value: typeof validConfiguration) => (value.agent.command = "   "),
    ],
    [
      "agent.model",
      (value: typeof validConfiguration) => (value.agent.model = "   "),
    ],
    [
      "verification.command",
      (value: typeof validConfiguration) =>
        (value.verification.command = "   "),
    ],
    [
      "staging.workflow",
      (value: typeof validConfiguration) => (value.staging.workflow = "   "),
    ],
    [
      "staging.environment",
      (value: typeof validConfiguration) => (value.staging.environment = "   "),
    ],
    [
      "staging.smoke_command",
      (value: typeof validConfiguration) =>
        (value.staging.smoke_command = "   "),
    ],
  ])("rejects whitespace-only semantic string at %s", (_, makeInvalid) => {
    const configuration = structuredClone(validConfiguration);
    makeInvalid(configuration);

    expect(Value.Check(ConfigurationSchema, configuration)).toBe(false);
  });

  test.each([
    [
      "ready and todo",
      { ready: "Ready", todo: "Ready", review: "Review", done: "Done" },
    ],
    [
      "ready and review",
      { ready: "Ready", todo: "Todo", review: "Ready", done: "Done" },
    ],
    [
      "ready and done",
      { ready: "Ready", todo: "Todo", review: "Review", done: "Ready" },
    ],
    [
      "todo and review",
      { ready: "Ready", todo: "Todo", review: "Todo", done: "Done" },
    ],
    [
      "todo and done",
      { ready: "Ready", todo: "Todo", review: "Review", done: "Todo" },
    ],
    [
      "review and done",
      { ready: "Ready", todo: "Todo", review: "Review", done: "Review" },
    ],
  ])("rejects duplicate lane values for %s", (_, lanes) => {
    expect(
      Value.Check(ConfigurationSchema, {
        ...validConfiguration,
        github: { ...validConfiguration.github, lanes },
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
