# Wheelsparrow MVP Technology Stack

Status: Approved MVP baseline

Purpose: Define the concrete technology choices for the Wheelsparrow MVP. A dependency belongs here
only when it solves a requirement in `SPEC.md`. Versions are pinned in the root lockfile and
automated update configuration rather than duplicated in prose.

## 1. Baseline

The repository MUST use:

- Node.js on the current Active LTS line supported by all selected dependencies;
- TypeScript in strict mode for application code and tests;
- pnpm workspaces with one root lockfile;
- ECMAScript modules;
- a committed `.node-version` and pinned pnpm `packageManager` value;
- a root Makefile as the stable human and CI interface; and
- Linux as the CI runtime, with local support for Linux, macOS, and Linux under WSL.

Application code uses TypeScript. SQL migrations, YAML, Markdown, CSS, and narrow shell commands are
normal exceptions. A second application language requires evidence that TypeScript cannot meet a
current requirement.

## 2. Server

The server stack is:

- **Fastify** for HTTP, static assets, health, and Server-Sent Events;
- **TypeBox** for runtime request/response validation and shared wire schemas;
- **Pino** for structured JSON logging and redaction;
- Node.js `child_process` primitives for Git, verification, smoke, and coding-agent processes; and
- the native `fetch` implementation for GitHub HTTP and GraphQL calls.

The MVP MUST NOT add NestJS, Express, GraphQL server frameworks, tRPC, WebSockets, a message broker,
or a background-job framework. Fastify plugins MAY be used for focused needs such as static file
serving, but the plugin list SHOULD remain short.

The HTTP API is internal to the bundled browser app. TypeBox schemas in `packages/contracts` are the
shared source for validation and TypeScript inference. OpenAPI generation and generated clients are
deferred.

## 3. Browser Application

The browser stack is:

- **React** and **Vite**;
- **React Router** for the four operator routes;
- **TanStack Query** for server snapshots, invalidation, and mutation state;
- **Tailwind CSS** plus source-owned accessible components; and
- the browser `EventSource` API for live notifications.

The UI MUST be keyboard accessible, responsive at ordinary laptop widths, legible in light and dark
color schemes, and clear about destructive or privileged actions. It SHOULD favor dense operational
information over decorative dashboard chrome.

No global client state library is required. React state is for transient presentation only;
durable state remains on the server. Server-side rendering, Next.js, TanStack Start, XState, and a
component-distribution dependency are deferred.

## 4. Persistence

Persistence uses:

- **SQLite** as a local file database;
- **better-sqlite3** as the Node.js driver;
- **Kysely** for typed queries and transactions; and
- ordered immutable SQL or TypeScript migrations in `migrations/`.

SQLite uses foreign keys and write-ahead logging when supported by the configured filesystem. Every
workflow mutation uses a transaction and an expected run revision. Migrations MUST be exercised
against real temporary files in CI.

An ORM, Redis, PostgreSQL, cloud database, event-sourcing framework, and separate analytics store are
out of scope. Large bounded logs MAY live as files referenced by SQLite.

## 5. GitHub, Git, and Agent Integration

The production implementation supports GitHub only. It uses GitHub's REST and GraphQL APIs with the
operator's existing authenticated credential source. `gh` MAY be used for interactive diagnostics,
but application correctness MUST NOT depend on parsing human-oriented CLI output.

Git and repository commands run as explicit subprocesses with bounded output, timeouts, and process
tree cleanup. Commands MUST use argument arrays unless a configured repository contract explicitly
requires a shell.

The coding-agent integration invokes the configured local Codex command as a subprocess, consumes a
machine-readable event stream, and validates a structured terminal result against a TypeBox schema.
The exact model and reasoning effort are explicit configuration and are recorded per step. The MVP
has no runtime model router and no second agent provider.

## 6. Prompt Assets

Prompts are plain Markdown files under `prompts/`. Rendering uses a small repository-owned function;
a prompt-template framework is not required. Dynamic context is delimited clearly from trusted
instructions, length-bounded, and escaped where the command protocol requires it.

`make test-prompts` runs deterministic checks for required sections, role-specific authority,
terminal-result schema references, stop rules, duplicated scaffolding, and content hashes.

`make eval-prompts` is opt-in and model-backed. It runs representative trace fixtures for success,
repair, ambiguity, dependency blocking, and unsafe mutation requests. It is evidence for prompt
changes but is not a required PR check because it uses credentials and non-deterministic external
compute.

Prompt design follows:

- [OpenAI latest-model guide](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI GPT-5.6 prompting guide](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6.md)

## 7. Testing

The test stack is:

- **Vitest** for unit, contract, component, and integration tests;
- **React Testing Library** for focused UI behavior;
- **Playwright** with Chromium for end-to-end browser tests; and
- repository-owned fakes for GitHub, time, identifiers, and subprocess outcomes.

Integration tests use real temporary SQLite databases, real migrations, temporary Git repositories,
and real child processes where lifecycle behavior matters. The GitHub fake MUST be stateful enough
to detect duplicate mutations and revision drift. A small opt-in live GitHub smoke is separate from
required CI.

Tests MUST NOT mock the coordinator so heavily that transitions, restart reconciliation, or
approval invalidation are untested.

## 8. Static Quality and Security Tooling

The repository uses:

- **Biome** for formatting and linting;
- **TypeScript** `tsc --noEmit` for type checking;
- **Markdownlint CLI2** for Markdown;
- **actionlint** and **zizmor** for GitHub Actions;
- **Gitleaks** for secret scanning;
- **CodeQL** for TypeScript security analysis; and
- **Dependabot** for npm and GitHub Actions updates.

Tools run through pinned package versions, pinned action SHAs, or a documented pinned binary
installation. Contributors and CI invoke repository-owned Make targets rather than duplicating the
tool composition.

## 9. Local Operation and Distribution

The supported MVP path is a local checkout:

```text
make setup
make preflight
make start
```

Development runs Vite and Fastify with a proxy; the production build emits static browser assets
served by Fastify on one loopback port. SQLite, worktrees, and logs live below the configured local
data root.

A Docker image, package registry publication, hosted service, system package, auto-update mechanism,
and production deployment are deferred. CI MUST still prove `make build` produces a runnable local
artifact.

## 10. Dependency Policy

Runtime dependencies MUST satisfy a present requirement, have maintained primary documentation,
support the chosen Node line, and be replaceable behind a small local boundary. Native dependencies
such as `better-sqlite3` require Linux and macOS CI evidence.

The lockfile is authoritative. Dependency and action updates are automated but MUST pass the same
checks as application changes. Major upgrades are ordinary reviewed pull requests, not unattended
merges.

## 11. Deferred Choices and Revisit Triggers

| Deferred choice | Revisit only when |
| --- | --- |
| Concurrent ticket execution | Serial throughput is measured as the limiting constraint |
| Multiple repositories/projects | A second real installation cannot be served by another instance |
| PostgreSQL or hosted storage | A remote multi-user deployment is approved |
| OIDC, RBAC, or proxy auth | The service binds beyond loopback or has multiple operators |
| Container/release pipeline | A concrete distribution or hosted target is selected |
| OpenAPI/generated client | A second API consumer or language needs a stable public contract |
| Provider adapter framework | A second provider is selected and implemented |
| WebSockets | HTTP plus SSE cannot serve a demonstrated interaction |
| Workflow engine or queue | SQLite coordination cannot satisfy a measured reliability need |
| Model routing and budgets | Usage volume makes fixed configuration materially inadequate |

“It might be useful later” is not a revisit trigger.
