# Block 0 Runnable Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a clean, pinned, runnable Wheelsparrow workspace with a real Fastify/Vite vertical
slice, validated configuration, local verification, and current-SHA CI evidence.

**Architecture:** Build only the boundaries that execute in this block: one server app, one web app,
and one shared wire-schema package. The Fastify process owns health, readiness, configuration, static
web serving, and shutdown; the browser reads server truth. All other MVP behavior remains absent
until its block has executable code.

**Tech Stack:** Node.js 24.18.0 LTS, pnpm 11.15.1, strict TypeScript/ESM, Fastify, TypeBox, Pino,
React, Vite, Vitest, Biome, and Markdownlint CLI2.

---

## Scope and evidence

Work in `/home/jporc/wheelsparrow/.worktrees/block0` on
`feat/block-0-foundation`, based on
`471a668cbd62db919ce914ce1a891d01cc0ea72a`.

Resolve application package versions once with `pnpm add --save-exact`; commit the exact versions
and the resulting root lockfile. The selected packages must support Node.js 24 and each other.

Block 0 completes when a fresh clone passes:

```bash
make setup
make verify-agent
make build
node scripts/production-smoke.mjs
```

The builder does not commit or push. After each task, the root orchestrator reviews the diff and may
create a checkpoint commit. The root orchestrator alone opens the pull request and merges it.

### Block 0 requirement map

| Requirement | Tasks | Evidence |
| --- | --- | --- |
| Final repository shape without empty conceptual packages, `ARCHITECTURE.md:29-101` | 1-5 | repository-policy test and changed-path audit |
| Configuration shape and secret exclusion, `SPEC.md:64-110` | 2-3 | real YAML parse tests and preflight output |
| Loopback Fastify/TypeBox/Pino baseline, `TECH_STACK.md:25-41` | 2-4 | injected HTTP tests and production smoke |
| React/Vite browser build served by Fastify, `TECH_STACK.md:43-59,144-160` | 5-6 | browser test, Vite build, and production smoke |
| Pinned Node/pnpm/strict TypeScript/Make baseline, `TECH_STACK.md:9-23` | 1 | policy test, lockfile, lint, and type check |
| Local and CI use the same gate, `CICD.md:13-24,93-103,163-185` | 1,6-7 | `make verify-agent` locally and the `test` CI job |
| Immutable actions and least privilege, `CICD.md:202-216` | 7 | parsed workflow-policy tests |
| Exact-revision main build artifact, `CICD.md:218-229` | 6-7 | main workflow production smoke and SHA-named artifact |

Prompt checks, SQLite integration, Playwright, CodeQL, Gitleaks, Dependabot, the manual live smoke,
and their final required check names enter only when their corresponding executable behavior exists.
Block 0 does not create green placeholder jobs for them.

## Review-Derived Corrections

The task snippets below are the original execution sequence. These review findings are binding where
they refine a snippet:

- Task 1 uses Node 24-compatible type declarations, current Biome preset syntax, and recursive
  generated-output exclusions.
- Task 2 closes every nested configuration object to unknown properties and builds the contracts
  runtime export during a true fresh install. TypeBox remains at the newest exact release accepted by
  the enforced minimum-release-age policy; no version exemption is allowed.
- Task 3 exposes only sanitized error classifications, checks actual Node and pnpm output against the
  repository pins, accepts only a relative contained non-symlink workspace, bounds diagnostics to
  8,192 UTF-8 bytes, redacts credential fields, and times out and terminates subprocess groups.
- Task 4 intentionally omits `main.ts`; Task 5 composes the process only after the static web boundary
  exists.
- Task 5 runtime-validates health media and schema, parses only URL pathnames for the guarded SPA
  fallback, negotiates HTML correctly, and provides explicit accessible light and dark palettes.
- Task 6 requires exact HTTP 200 and exact bounded JSON responses, refuses redirects, parses only a
  complete raw URL-announcement line, and preserves overlapping probe and process-cleanup failures.
- Task 7 uses the currently verified official Action releases pinned to immutable SHAs. Its main
  archive includes the built contracts plus every workspace manifest and dependency metadata, then
  proves the extracted archive with a frozen production-only install and production smoke before
  upload.
- Whole-block review requires trim-aware semantic configuration strings, pairwise-distinct normative
  lane values, sanitized field-level validation diagnostics, and one repository-owned configuration
  path shared by startup and preflight. Production smoke also proves the assembled Vite HTML and its
  bounded local JavaScript and stylesheet assets. The normal gate fails fast unless Node and pnpm
  exactly match their pins, and pnpm explicitly enforces its strict one-day release-age quarantine.

## Task 1: Pin the workspace and establish the local gate

**Files:**

- Create: `.gitignore`
- Create: `.node-version`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `tsconfig.tests.json`
- Create: `biome.json`
- Create: `.markdownlint-cli2.jsonc`
- Create: `vitest.config.ts`
- Create: `Makefile`
- Create: `scripts/repository-policy.test.ts`

- [x] **Step 1: Write the root toolchain declarations**

```text
# .node-version
24.18.0
```

```json
{
  "name": "wheelsparrow",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.15.1",
  "engines": {
    "node": "24.18.x",
    "pnpm": "11.15.x"
  },
  "scripts": {
    "build": "pnpm -r --sort run build",
    "fix": "biome check --write . && markdownlint-cli2 --fix \"**/*.md\"",
    "lint": "biome check . && markdownlint-cli2 \"**/*.md\"",
    "test:unit": "vitest run",
    "typecheck": "pnpm -r --if-present run typecheck && tsc -p tsconfig.tests.json --noEmit",
    "verify:policy": "vitest run scripts/repository-policy.test.ts",
    "verify:agent": "pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test:unit"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - apps/*
  - packages/*
```

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true
  }
}
```

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node", "vitest/globals"]
  },
  "include": [
    "apps/**/*.test.ts",
    "apps/**/*.test.tsx",
    "packages/**/*.test.ts",
    "scripts/**/*.ts",
    "vitest.config.ts"
  ]
}
```

- [x] **Step 2: Install the root development tools with exact versions**

Run:

```bash
corepack pnpm add -DwE @biomejs/biome @types/node markdownlint-cli2 tsx typescript vitest yaml
```

Expected: `package.json` contains exact versions and `pnpm-lock.yaml` records one frozen graph.

- [x] **Step 3: Add deterministic formatter, Markdown, and test configuration**

```json
{
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always"
    }
  },
  "files": {
    "includes": [
      "**",
      "!!**/dist",
      "!!**/node_modules",
      "!!**/coverage",
      "!!**/playwright-report",
      "!!**/test-results"
    ]
  }
}
```

```json
{
  "config": {
    "MD013": false
  }
}
```

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "apps/**/*.test.tsx", "packages/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: { reporter: ["text", "json-summary"] }
  }
});
```

- [x] **Step 4: Write the failing repository-policy test**

```typescript
// scripts/repository-policy.test.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const required = [
  ".node-version",
  "Makefile",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json"
];
const forbidden = [
  "packages/domain",
  "packages/orchestration",
  "packages/persistence",
  "packages/adapters",
  "packages/observability",
  "packages/test-support"
];

describe("repository policy", () => {
  it("contains only the approved workspace shape", () => {
    for (const path of required) expect(existsSync(resolve(root, path)), path).toBe(true);
    for (const path of forbidden) expect(existsSync(resolve(root, path)), path).toBe(false);
  });

  it("pins the supported toolchain", () => {
    expect(readFileSync(resolve(root, ".node-version"), "utf8").trim()).toBe("24.18.0");
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(manifest.packageManager).toBe("pnpm@11.15.1");
  });
});
```

- [x] **Step 5: Run the policy test and confirm the missing workspace failure**

Run: `corepack pnpm vitest run scripts/repository-policy.test.ts`

Expected: FAIL naming `apps/server/package.json`, `apps/web/package.json`, and
`packages/contracts/package.json`.

- [x] **Step 6: Add the root ignore and Make interfaces**

```gitignore
.worktrees/
node_modules/
dist/
coverage/
test-results/
playwright-report/
artifacts/
.tools/
.wheelsparrow/
*.db
*.db-shm
*.db-wal
*.log
.env
.env.*
!.env.example
.DS_Store
```

```make
PNPM := corepack pnpm

.PHONY: setup fix lint typecheck test-unit verify-policy verify-agent build preflight dev start

setup:
 $(PNPM) install --frozen-lockfile

fix:
 $(PNPM) fix

lint:
 $(PNPM) lint

typecheck:
 $(PNPM) typecheck

test-unit:
 $(PNPM) test:unit

verify-policy:
 $(PNPM) verify:policy

verify-agent:
 $(PNPM) verify:agent
 git diff --check

build:
 $(PNPM) build

preflight:
 $(PNPM) tsx scripts/preflight.ts

dev:
 $(PNPM) -r --parallel --stream run dev

start:
 $(PNPM) --filter @wheelsparrow/server start
```

- [x] **Step 7: Run the static part of the gate**

Run: `corepack pnpm lint`

Expected: PASS after applying `corepack pnpm fix` once.

## Task 2: Add shared health and configuration contracts

**Files:**

- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/health.ts`
- Create: `packages/contracts/src/config.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/contracts.test.ts`

- [x] **Step 1: Create the contracts package and install TypeBox**

```json
{
  "name": "@wheelsparrow/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Run: `corepack pnpm --filter @wheelsparrow/contracts add -E typebox`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [x] **Step 2: Write failing schema tests**

```typescript
// packages/contracts/src/contracts.test.ts
import { describe, expect, it } from "vitest";
import Value from "typebox/value";
import { ConfigurationSchema, HealthResponseSchema, ReadyResponseSchema } from "./index.js";

describe("wire contracts", () => {
  it("accepts only versioned health payloads", () => {
    expect(Value.Check(HealthResponseSchema, { schema_version: 1, status: "ok" })).toBe(true);
    expect(Value.Check(HealthResponseSchema, { status: "ok" })).toBe(false);
  });

  it("distinguishes startup from readiness", () => {
    expect(Value.Check(ReadyResponseSchema, { schema_version: 1, status: "starting" })).toBe(true);
    expect(Value.Check(ReadyResponseSchema, { schema_version: 1, status: "ready" })).toBe(true);
  });

  it("rejects literal secrets and incomplete project configuration", () => {
    expect(Value.Check(ConfigurationSchema, { github: { token: "secret" } })).toBe(false);
  });
});
```

Run: `corepack pnpm vitest run packages/contracts/src/contracts.test.ts`

Expected: FAIL because the schemas do not exist.

- [x] **Step 3: Implement the health schemas**

```typescript
// packages/contracts/src/health.ts
import { type Static, Type } from "typebox";

export const HealthResponseSchema = Type.Object({
  schema_version: Type.Literal(1),
  status: Type.Literal("ok")
});
export type HealthResponse = Static<typeof HealthResponseSchema>;

export const ReadyResponseSchema = Type.Object({
  schema_version: Type.Literal(1),
  status: Type.Union([Type.Literal("starting"), Type.Literal("ready")])
});
export type ReadyResponse = Static<typeof ReadyResponseSchema>;
```

- [x] **Step 4: Implement the exact configuration schema**

```typescript
// packages/contracts/src/config.ts
import { type Static, Type } from "typebox";

const NonEmpty = Type.String({ minLength: 1 });
const Command = Type.String({ minLength: 1, maxLength: 4096 });

export const ConfigurationSchema = Type.Object({
  github: Type.Object({
    owner: NonEmpty,
    repository: NonEmpty,
    project_number: Type.Integer({ minimum: 1 }),
    status_field: NonEmpty,
    lanes: Type.Object({
      ready: NonEmpty,
      todo: NonEmpty,
      review: NonEmpty,
      done: NonEmpty
    }),
    required_labels: Type.Array(NonEmpty, { minItems: 1, uniqueItems: true }),
    priority_field: NonEmpty
  }),
  poll_interval_seconds: Type.Integer({ minimum: 5, maximum: 3600 }),
  workspace_root: NonEmpty,
  agent: Type.Object({
    command: NonEmpty,
    model: NonEmpty,
    reasoning_effort: Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
      Type.Literal("max")
    ]),
    timeout_minutes: Type.Integer({ minimum: 1, maximum: 240 })
  }),
  verification: Type.Object({ command: Command }),
  staging: Type.Object({
    workflow: NonEmpty,
    environment: NonEmpty,
    smoke_command: Command
  })
}, { additionalProperties: false });

export type Configuration = Static<typeof ConfigurationSchema>;
```

```typescript
// packages/contracts/src/index.ts
export * from "./config.js";
export * from "./health.js";
```

- [x] **Step 5: Run the contract tests and package type check**

Run:

```bash
corepack pnpm vitest run packages/contracts/src/contracts.test.ts
corepack pnpm --filter @wheelsparrow/contracts typecheck
```

Expected: both commands PASS.

## Task 3: Implement validated configuration and preflight

**Files:**

- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/config.test.ts`
- Create: `scripts/preflight.ts`
- Create: `scripts/preflight.test.ts`
- Create: `wheelsparrow.yaml`

- [x] **Step 1: Create the server package and install runtime dependencies**

```json
{
  "name": "@wheelsparrow/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "NODE_ENV=development tsx watch src/main.ts",
    "start": "node dist/main.js",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Run:

```bash
corepack pnpm --filter @wheelsparrow/server add -E @fastify/static @fastify/type-provider-typebox @wheelsparrow/contracts@workspace:* fastify pino typebox yaml
corepack pnpm --filter @wheelsparrow/server add -DE tsx
```

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [x] **Step 2: Write failing configuration tests**

```typescript
// apps/server/src/config.test.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfiguration } from "./config.js";

describe("loadConfiguration", () => {
  it("parses the approved file shape without persisting credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-config-"));
    const path = join(directory, "wheelsparrow.yaml");
    await writeFile(path, [
      "github:",
      "  owner: example",
      "  repository: target",
      "  project_number: 2",
      "  status_field: Status",
      "  lanes: { ready: Ready, todo: Todo, review: Review, done: Done }",
      "  required_labels: [mvp]",
      "  priority_field: Priority",
      "poll_interval_seconds: 30",
      "workspace_root: .wheelsparrow/workspaces",
      "agent: { command: codex, model: gpt-5.6-sol, reasoning_effort: high, timeout_minutes: 45 }",
      "verification: { command: make verify-agent }",
      "staging: { workflow: deploy-staging.yml, environment: staging, smoke_command: make smoke-staging }"
    ].join("\n"));
    await expect(loadConfiguration(path)).resolves.toMatchObject({ github: { owner: "example" } });
  });

  it("fails closed on unknown keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wheelsparrow-config-"));
    const path = join(directory, "wheelsparrow.yaml");
    await writeFile(path, "github: { token: exposed }\n");
    await expect(loadConfiguration(path)).rejects.toThrow("Invalid configuration");
  });
});
```

Run: `corepack pnpm vitest run apps/server/src/config.test.ts`

Expected: FAIL because `loadConfiguration` does not exist.

- [x] **Step 3: Implement YAML parsing with TypeBox validation**

```typescript
// apps/server/src/config.ts
import { readFile } from "node:fs/promises";
import { ConfigurationSchema, type Configuration } from "@wheelsparrow/contracts";
import Value from "typebox/value";
import { parse } from "yaml";

export async function loadConfiguration(path: string): Promise<Configuration> {
  const source = await readFile(path, "utf8");
  try {
    return Value.Parse(ConfigurationSchema, parse(source));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid configuration in ${path}: ${message}`, { cause: error });
  }
}
```

- [x] **Step 4: Add a repository-owned, secret-free configuration**

```yaml
github:
  owner: jporcenaluk
  repository: wheelsparrow
  project_number: 2
  status_field: Status
  lanes:
    ready: Ready
    todo: Todo
    review: Review
    done: Done
  required_labels:
    - mvp
  priority_field: Priority

poll_interval_seconds: 30
workspace_root: .wheelsparrow/workspaces

agent:
  command: codex
  model: gpt-5.6-sol
  reasoning_effort: high
  timeout_minutes: 45

verification:
  command: make verify-agent

staging:
  workflow: deploy-staging.yml
  environment: staging
  smoke_command: make smoke-staging
```

- [x] **Step 5: Write and run a failing preflight test**

```typescript
// scripts/preflight.test.ts
import { describe, expect, it } from "vitest";
import { evaluatePreflight } from "./preflight.js";

describe("preflight", () => {
  it("reports every missing prerequisite in one result", async () => {
    const result = await evaluatePreflight({
      root: "/missing",
      run: async () => ({ ok: false, detail: "not found" })
    });
    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => check.name)).toEqual([
      "node",
      "pnpm",
      "git",
      "github-auth",
      "codex-auth",
      "configuration",
      "workspace-root"
    ]);
  });
});
```

Run: `corepack pnpm vitest run scripts/preflight.test.ts`

Expected: FAIL because `evaluatePreflight` does not exist.

- [x] **Step 6: Implement preflight as structured checks**

```typescript
// scripts/preflight.ts
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfiguration } from "../apps/server/src/config.js";

type CommandResult = { ok: boolean; detail: string };
type Check = CommandResult & { name: string };
type Options = {
  root: string;
  run: (command: string, args: string[]) => Promise<CommandResult>;
};

export async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolveResult) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", (error) => resolveResult({ ok: false, detail: error.message }));
    child.once("close", (code) => resolveResult({ ok: code === 0, detail: output.trim() }));
  });
}

export async function evaluatePreflight(options: Options) {
  const checks: Check[] = [];
  for (const [name, command, args] of [
    ["node", "node", ["--version"]],
    ["pnpm", "corepack", ["pnpm", "--version"]],
    ["git", "git", ["--version"]],
    ["github-auth", "gh", ["auth", "status"]],
    ["codex-auth", "codex", ["login", "status"]]
  ] as const) {
    checks.push({ name, ...await options.run(command, [...args]) });
  }
  let configuration;
  try {
    configuration = await loadConfiguration(resolve(options.root, "wheelsparrow.yaml"));
    checks.push({ name: "configuration", ok: true, detail: "valid" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ name: "configuration", ok: false, detail });
  }
  if (configuration) {
    try {
      const workspace = resolve(options.root, configuration.workspace_root);
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      await access(workspace);
      checks.push({ name: "workspace-root", ok: true, detail: workspace });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      checks.push({ name: "workspace-root", ok: false, detail });
    }
  } else {
    checks.push({ name: "workspace-root", ok: false, detail: "configuration unavailable" });
  }
  return { ok: checks.every((check) => check.ok), checks };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await evaluatePreflight({ root: process.cwd(), run: runCommand });
  for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  process.exitCode = result.ok ? 0 : 1;
}
```

- [x] **Step 7: Run the focused tests**

Run:

```bash
corepack pnpm vitest run apps/server/src/config.test.ts scripts/preflight.test.ts
```

Expected: both test files PASS. `make preflight` may fail only for a genuinely missing local
credential or command and must name that prerequisite.

## Task 4: Build the Fastify liveness and readiness process

**Files:**

- Create: `apps/server/src/readiness.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/app.test.ts`

- [x] **Step 1: Write the failing route tests**

```typescript
// apps/server/src/app.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createReadinessGate } from "./readiness.js";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("service health", () => {
  it("reports liveness without leaking configuration", async () => {
    const app = await buildApp({ readiness: createReadinessGate() });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schema_version: 1, status: "ok" });
  });

  it("returns 503 until startup marks the process ready", async () => {
    const readiness = createReadinessGate();
    const app = await buildApp({ readiness });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
    readiness.markReady();
    expect((await app.inject({ method: "GET", url: "/ready" })).json()).toEqual({
      schema_version: 1,
      status: "ready"
    });
  });
});
```

Run: `corepack pnpm vitest run apps/server/src/app.test.ts`

Expected: FAIL because `buildApp` and `createReadinessGate` do not exist.

- [x] **Step 2: Implement the readiness gate**

```typescript
// apps/server/src/readiness.ts
export type ReadinessGate = {
  isReady(): boolean;
  markReady(): void;
  markNotReady(): void;
};

export function createReadinessGate(): ReadinessGate {
  let ready = false;
  return {
    isReady: () => ready,
    markReady: () => { ready = true; },
    markNotReady: () => { ready = false; }
  };
}
```

- [x] **Step 3: Implement typed Fastify routes and redacted logging**

```typescript
// apps/server/src/app.ts
import {
  HealthResponseSchema,
  ReadyResponseSchema
} from "@wheelsparrow/contracts";
import {
  type TypeBoxTypeProvider
} from "@fastify/type-provider-typebox";
import Fastify, { type FastifyInstance } from "fastify";
import type { ReadinessGate } from "./readiness.js";

export type BuildAppOptions = {
  readiness: ReadinessGate;
  registerWeb?: (app: FastifyInstance) => Promise<void>;
};

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: {
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "password", "token", "secret"],
        censor: "[REDACTED]"
      }
    },
    requestTimeout: 120_000
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.get("/health", {
    schema: { response: { 200: HealthResponseSchema } }
  }, async () => ({ schema_version: 1 as const, status: "ok" as const }));

  app.get("/ready", {
    schema: { response: { 200: ReadyResponseSchema, 503: ReadyResponseSchema } }
  }, async (_request, reply) => {
    const ready = options.readiness.isReady();
    return reply.code(ready ? 200 : 503).send({
      schema_version: 1 as const,
      status: ready ? "ready" as const : "starting" as const
    });
  });

  if (options.registerWeb) await options.registerWeb(app);
  return app;
}
```

- [x] **Step 4: Run focused server verification**

Run:

```bash
corepack pnpm vitest run apps/server/src/app.test.ts
corepack pnpm --filter @wheelsparrow/server typecheck
```

Expected: both commands PASS.

## Task 5: Add the minimal browser and production static boundary

**Files:**

- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/api.ts`
- Create: `apps/web/src/app.tsx`
- Create: `apps/web/src/app.test.tsx`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/styles.css`
- Create: `apps/server/src/web.ts`
- Create: `apps/server/src/web.test.ts`
- Create: `apps/server/src/main.ts`

- [x] **Step 1: Create the web package and pin only dependencies used now**

```json
{
  "name": "@wheelsparrow/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "dev": "vite",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Run:

```bash
corepack pnpm --filter @wheelsparrow/web add -E @wheelsparrow/contracts@workspace:* react react-dom
corepack pnpm --filter @wheelsparrow/web add -DE @testing-library/react @types/react @types/react-dom @vitejs/plugin-react jsdom vite
```

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]
}
```

```typescript
// apps/web/vite.config.ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: { "/health": "http://127.0.0.1:4321", "/ready": "http://127.0.0.1:4321" }
  }
});
```

- [x] **Step 2: Write the failing browser behavior test**

```tsx
// @vitest-environment jsdom
// apps/web/src/app.test.tsx
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";

afterEach(() => vi.unstubAllGlobals());

describe("App", () => {
  it("shows server liveness from the API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ schema_version: 1, status: "ok" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )));
    render(<App />);
    expect(await screen.findByText("Service live")).toBeTruthy();
  });
});
```

Run: `corepack pnpm vitest run apps/web/src/app.test.tsx`

Expected: FAIL because `App` does not exist.

- [x] **Step 3: Implement the typed health client and status screen**

```typescript
// apps/web/src/api.ts
import type { HealthResponse } from "@wheelsparrow/contracts";

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/health", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Health request failed with HTTP ${response.status}`);
  return await response.json() as HealthResponse;
}
```

```tsx
// apps/web/src/app.tsx
import { useEffect, useState } from "react";
import { fetchHealth } from "./api.js";

export function App() {
  const [state, setState] = useState<"checking" | "live" | "unavailable">("checking");
  useEffect(() => {
    void fetchHealth().then(
      () => setState("live"),
      () => setState("unavailable")
    );
  }, []);
  return (
    <main>
      <p className="eyebrow">Local SDLC orchestrator</p>
      <h1>Wheelsparrow</h1>
      <p className={`status status--${state}`}>
        {state === "checking" ? "Checking service" : state === "live" ? "Service live" : "Service unavailable"}
      </p>
    </main>
  );
}
```

```tsx
// apps/web/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<StrictMode><App /></StrictMode>);
```

```html
<!-- apps/web/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Wheelsparrow</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```css
/* apps/web/src/styles.css */
:root {
  color-scheme: light dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #111713;
  color: #f1f7f2;
}
body { margin: 0; min-width: 320px; min-height: 100vh; }
main { max-width: 48rem; margin: 0 auto; padding: 12vh 2rem; }
.eyebrow { color: #92b99d; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
h1 { font-size: clamp(3rem, 10vw, 7rem); line-height: 0.9; margin: 1rem 0 2rem; }
.status { border-left: 0.3rem solid currentColor; padding: 0.8rem 1rem; }
.status--checking { color: #e0b56a; }
.status--live { color: #77d38b; }
.status--unavailable { color: #ee857b; }
```

- [x] **Step 4: Write the failing static-serving test**

```typescript
// apps/server/src/web.test.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerWeb } from "./web.js";

describe("registerWeb", () => {
  it("serves the production browser entrypoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "wheelsparrow-web-"));
    await writeFile(join(root, "index.html"), "<h1>Wheelsparrow</h1>");
    const app = Fastify();
    await registerWeb(app, root);
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Wheelsparrow");
    await app.close();
  });
});
```

Run: `corepack pnpm vitest run apps/server/src/web.test.ts`

Expected: FAIL because `registerWeb` does not exist.

- [x] **Step 5: Implement the Fastify static plugin boundary**

```typescript
// apps/server/src/web.ts
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export async function registerWeb(app: FastifyInstance, root: string) {
  await app.register(fastifyStatic, {
    root,
    wildcard: true,
    index: ["index.html"]
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === "GET" && request.headers.accept?.includes("text/html")) {
      return reply.sendFile("index.html", { maxAge: 0 });
    }
    return reply.code(404).send({ error: "not_found" });
  });
}
```

- [x] **Step 6: Compose startup after the static boundary exists**

```typescript
// apps/server/src/main.ts
import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { loadConfiguration } from "./config.js";
import { createReadinessGate } from "./readiness.js";
import { registerWeb } from "./web.js";

const configurationPath = process.env.WHEELSPARROW_CONFIG ?? resolve("wheelsparrow.yaml");
await loadConfiguration(configurationPath);

const readiness = createReadinessGate();
const app = process.env.NODE_ENV === "development"
  ? await buildApp({ readiness })
  : await buildApp({
      readiness,
      registerWeb: async (server) => {
        await registerWeb(server, resolve(import.meta.dirname, "../../web/dist"));
      }
    });

const host = "127.0.0.1";
const port = Number.parseInt(process.env.WHEELSPARROW_PORT ?? "4321", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("WHEELSPARROW_PORT must be an integer between 0 and 65535");
}

const address = await app.listen({ host, port });
readiness.markReady();
process.stdout.write(`WHEELSPARROW_URL=${address}\n`);

let closing = false;
async function shutdown(signal: NodeJS.Signals) {
  if (closing) return;
  closing = true;
  readiness.markNotReady();
  app.log.info({ signal }, "shutdown requested");
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await app.close();
  clearTimeout(force);
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
```

- [x] **Step 7: Run browser, static, and build checks**

Run:

```bash
corepack pnpm vitest run apps/web/src/app.test.tsx apps/server/src/web.test.ts
corepack pnpm --filter @wheelsparrow/web build
```

Expected: tests PASS and `apps/web/dist/index.html` exists.

## Task 6: Prove the production process lifecycle

**Files:**

- Create: `scripts/production-smoke.mjs`
- Modify: `package.json`
- Modify: `Makefile`

- [x] **Step 1: Write the production smoke runner**

```javascript
// scripts/production-smoke.mjs
import { spawn } from "node:child_process";
import { once } from "node:events";

const child = spawn(process.execPath, ["apps/server/dist/main.js"], {
  cwd: process.cwd(),
  env: { ...process.env, WHEELSPARROW_PORT: "0" },
  stdio: ["ignore", "pipe", "pipe"]
});

let buffer = "";
const address = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("server URL timeout")), 15_000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const match = buffer.match(/WHEELSPARROW_URL=(http:\/\/[^\s]+)/);
    if (match?.[1]) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
  child.once("exit", (code) => reject(new Error(`server exited before ready: ${code}`)));
});

for (const path of ["/health", "/ready"]) {
  const response = await fetch(new URL(path, address));
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
}

child.kill("SIGTERM");
const [code, signal] = await once(child, "exit");
if (code !== 0 || signal !== null) {
  throw new Error(`server shutdown was not clean: code=${code} signal=${signal}`);
}
console.log(`production smoke passed at ${address}`);
```

- [x] **Step 2: Add the smoke script to the root command surface**

Add `"smoke:production": "node scripts/production-smoke.mjs"` to root `package.json`.

Add this Make target and include it in `.PHONY`:

```make
smoke-production:
 $(PNPM) smoke:production
```

- [x] **Step 3: Build every workspace and run the real child-process smoke**

Run:

```bash
make build
node scripts/production-smoke.mjs
```

Expected: all workspaces build, both endpoints return 200, SIGTERM exits with code 0, and the script
prints `production smoke passed at http://127.0.0.1:<ephemeral-port>`.

## Task 7: Add current-SHA CI and workflow contract tests

**Files:**

- Create: `.github/workflows/pr-title.yml`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/main.yml`
- Create: `scripts/workflow-policy.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write the failing workflow-policy test**

```typescript
// scripts/workflow-policy.test.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const workflows = ["pr-title.yml", "ci.yml", "main.yml"];

describe("workflow policy", () => {
  it("uses immutable actions and least privilege", () => {
    for (const filename of workflows) {
      const source = readFileSync(resolve(root, ".github/workflows", filename), "utf8");
      const workflow = parse(source);
      expect(workflow.permissions).toEqual({ contents: "read" });
      expect(source).not.toContain("pull_request_target");
      for (const use of source.matchAll(/uses:\s*([^\s#]+)/g)) {
        expect(use[1]).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it("runs commit checks for pull requests, merge groups, and main", () => {
    const workflow = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"));
    expect(workflow.on).toMatchObject({ pull_request: {}, merge_group: {}, push: { branches: ["main"] } });
    expect(workflow.jobs.test.name).toBe("test");
  });
});
```

Run: `corepack pnpm vitest run scripts/workflow-policy.test.ts`

Expected: FAIL because the workflow files do not exist.

- [x] **Step 2: Add PR title and draft-state metadata checks**

```yaml
# .github/workflows/pr-title.yml
name: PR metadata

on:
  pull_request:
    types: [opened, edited, synchronize, ready_for_review, converted_to_draft]

permissions:
  contents: read

jobs:
  validate-pr-title:
    name: validate-pr-title
    runs-on: ubuntu-latest
    env:
      PR_TITLE: ${{ github.event.pull_request.title }}
    steps:
      - name: Validate Conventional Commit title
        run: |
          node --input-type=module -e '
            const title = process.env.PR_TITLE ?? "";
            const pattern = /^(feat|fix|docs|refactor|test|build|ci|chore)(\([a-z0-9-]+\))?: [a-z0-9].+/;
            if (!pattern.test(title)) {
              console.error("Use: <type>(optional-scope): imperative summary");
              process.exit(1);
            }
          '

  ready-for-review-gate:
    name: ready-for-review-gate
    runs-on: ubuntu-latest
    env:
      PR_DRAFT: ${{ github.event.pull_request.draft }}
    steps:
      - name: Reject draft pull requests
        run: |
          test "$PR_DRAFT" = "false"
```

- [x] **Step 3: Add commit-bound CI with immutable action pins**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request: {}
  merge_group: {}
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.event.pull_request.number || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  test:
    name: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version-file: .node-version
      - name: Enable pinned pnpm
        run: corepack enable
      - name: Verify
        run: make verify-agent
      - name: Build
        run: make build
      - name: Production smoke
        run: node scripts/production-smoke.mjs
```

- [x] **Step 4: Add main-branch build evidence**

```yaml
# .github/workflows/main.yml
name: Main artifact

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  build-artifact:
    name: build-artifact
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version-file: .node-version
      - run: corepack enable
      - run: make setup
      - run: make build
      - run: node scripts/production-smoke.mjs
      - name: Package exact revision
        run: tar -czf wheelsparrow-${{ github.sha }}.tar.gz apps/server/dist apps/web/dist package.json pnpm-lock.yaml wheelsparrow.yaml
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: wheelsparrow-${{ github.sha }}
          path: wheelsparrow-${{ github.sha }}.tar.gz
          retention-days: 7
```

- [x] **Step 5: Add workflow policy to the normal gate and run it**

Add `"verify:workflows": "vitest run scripts/workflow-policy.test.ts"` to root `package.json`.
Keep `verify:agent` as one non-duplicated full-suite invocation:

```json
"verify:agent": "pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test:unit"
```

Run: `corepack pnpm vitest run scripts/workflow-policy.test.ts`

Expected: PASS with every action reference matched by a 40-character commit SHA.

## Task 8: Document operation, import the ledger, and run the block gate

**Files:**

- Create: `README.md`
- Create: `MVP_IMPLEMENTATION_LEDGER.md`
- Modify: `MVP_IMPLEMENTATION_LEDGER.md` after verification
- Verify: `docs/superpowers/plans/2026-08-06-block-0-runnable-foundation.md`

- [x] **Step 1: Write the exact local operating path**

````markdown
# Wheelsparrow

Wheelsparrow is a local-first SDLC orchestrator. It works an eligible GitHub Project ticket through
an isolated coding-agent run, verification, review, pull request, human approval, staging evidence,
and Done.

## Block 0

The current build provides the pinned workspace, validated configuration, liveness/readiness
endpoints, a minimal browser status page, production build, and CI foundation. Workflow execution is
added in later blocks tracked by `MVP_IMPLEMENTATION_LEDGER.md`.

## Local use

```bash
make setup
make preflight
make build
make start
```

`make preflight` checks GitHub and Codex login without printing credential values. The server binds
to `127.0.0.1:4321` unless `WHEELSPARROW_PORT` selects another local port.

## Verification

```bash
make verify-agent
make build
node scripts/production-smoke.mjs
```

The four normative root documents define the MVP contract. The implementation ledger records current
block status and exact evidence.
````

- [x] **Step 2: Import the reviewed root ledger**

Use `apply_patch` to add the exact current contents of
`/home/jporc/wheelsparrow/MVP_IMPLEMENTATION_LEDGER.md` to this clean branch. Do not import any
other untracked root file.

- [x] **Step 3: Run the complete local gate from a clean dependency install**

Run:

```bash
corepack pnpm install --frozen-lockfile
make verify-agent
make build
node scripts/production-smoke.mjs
git diff --check
```

Expected: all commands exit 0. Record test counts and the production-smoke URL in the ledger.

- [x] **Step 4: Self-review the plan and implementation scope**

Run:

```bash
rg -n "T[B]D|T[O]DO|implement[[:space:]]+later|fill[[:space:]]+in|similar[[:space:]]+to" docs/superpowers/plans/2026-08-06-block-0-runnable-foundation.md
git status --short
git diff --stat
```

Expected: the placeholder scan has no matches; status contains only Block 0 source, tests, docs,
configuration, lockfile, and workflows; no legacy `packages/domain`, `orchestration`,
`persistence`, `adapters`, `observability`, or `test-support` tree appears.

- [x] **Step 5: Hand the uncommitted diff to the root orchestrator**

Return:

- changed-file list;
- exact command results and test counts;
- dependency versions selected by the lockfile;
- any portability or CI risk;
- confirmation that no root-checkout legacy artifact was touched.

The root orchestrator then performs independent correctness and CI/security review, resolves verified
findings, commits, pushes, opens the non-draft pull request, waits for current-SHA checks, and merges
only after the merge gate passes.
