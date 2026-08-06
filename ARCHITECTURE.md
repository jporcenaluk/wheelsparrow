# Wheelsparrow MVP Architecture

Status: Approved MVP baseline

Purpose: Define the smallest implementation shape that can satisfy `SPEC.md` without turning the
MVP into a general orchestration platform. `SPEC.md` defines behavior, `TECH_STACK.md` defines the
technology baseline, and `CICD.md` defines delivery quality. Those documents take precedence over
this one.

## 1. Architectural Shape

Wheelsparrow is one local Node.js service with one SQLite database and one browser application. The
server hosts the built web assets, scheduler, HTTP API, and SSE stream. Separate deployable services
are out of scope.

Five rules carry most of the design:

1. **One coordinator writes workflow state.** Async GitHub, agent, Git, and verification operations
   may run at the edges, but their results return to one serialized coordinator before state changes.
2. **SQLite is operational truth.** Project columns are the human projection; logs and browser state
   are views. Decisions use durable runs, approvals, findings, and side-effect receipts.
3. **External effects are explicit.** A GitHub mutation, process launch, commit, merge, or deployment
   has a durable idempotency key, intent, and observed receipt.
4. **Repository commands define correctness.** Wheelsparrow coordinates the configured verification
   and smoke commands instead of embedding each target repository's build system.
5. **Keep boundaries inside the application.** A few cohesive folders and injected interfaces are
   enough. Premature workspace packages and generic adapter frameworks are forbidden.

## 2. Final MVP Repository Structure

This is the target structure, not a seed for empty placeholder files:

```text
apps/
  server/
    src/
      main.ts                 process startup, shutdown, and composition
      config.ts               wheelsparrow.yaml loading and validation
      database/               connection, migrations, run/event repositories
      github/                 project, issue, PR, checks, merge, deploy operations
      agents/                 prompt rendering and coding-agent subprocess control
      workflow/               selection, state transitions, retries, reconciliation
      workspaces/             worktree creation, Git commands, cleanup, verification
      http/                   Fastify routes, CSRF/revision guards, SSE presentation
  web/
    src/
      routes/
        queue.tsx
        run.tsx
        review.tsx
        configuration.tsx
      components/             shared accessible operator components
      api.ts                  typed HTTP and SSE client
      main.tsx
packages/
  contracts/                  TypeBox wire schemas and shared enums only
prompts/
  builder.md
  reviewer.md
  repair.md
tests/
  integration/                SQLite, subprocess, GitHub fake, recovery
  e2e/                        Playwright operator journeys
migrations/                   ordered immutable SQLite migrations
.github/workflows/            CI, PR metadata, security, and dependency automation
Makefile                      stable local and CI entrypoints
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
.node-version
.pre-commit-config.yaml
wheelsparrow.yaml
SPEC.md
ARCHITECTURE.md
TECH_STACK.md
CICD.md
```

Code MUST be added where behavior exists. The repository MUST NOT create every directory in advance
or preserve empty architectural placeholders.

## 3. Dependency Direction

The allowed dependency shape is intentionally modest:

```text
apps/web ----------------------> packages/contracts
apps/server/http --------------> workflow, database, packages/contracts
apps/server/workflow ----------> database + injected github/agents/workspaces interfaces
apps/server/github ------------> packages/contracts where wire types are shared
apps/server/agents ------------> prompt files + packages/contracts
apps/server/database ----------> packages/contracts where persisted enums are shared
packages/contracts ------------> no application package
```

`workflow/` MUST NOT import Fastify or React. `packages/contracts` MUST contain schemas and small
shared enums, not business services, database repositories, or a shadow domain model. Browser code
MUST NOT import server modules. Circular dependencies are forbidden.

Small interfaces live beside their consumer. There is no `packages/domain`, `orchestration`,
`persistence`, `adapters`, `observability`, or `test-support` package in the MVP.

## 4. Coordination and State Transitions

The coordinator accepts typed commands and observations such as:

```text
PollCompleted
ProjectMoveObserved
AgentExited
VerificationFinished
ReviewFinished
PullRequestObserved
ApprovalSubmitted
MergeObserved
StagingObserved
SmokeFinished
OperatorControlChanged
```

For each event it:

1. loads the current run revision in a transaction;
2. checks that the event applies to the expected state and revision;
3. persists the next state and any external-effect intent atomically;
4. commits; and
5. schedules the effect outside the transaction.

The effect result returns as another event. This prevents a long network or agent operation from
holding a SQLite transaction while preserving a durable record of what should happen.

Only the coordinator changes workflow state. HTTP handlers validate and submit commands; callbacks
submit observations. Neither writes a shortcut transition directly.

## 5. Serial Execution, Parallel Waiting

The scheduler owns one execution slot. It MAY claim a `Ready` ticket only when no run is actively
executing in `Todo`. A run stops consuming the slot as soon as it is durably handed to `Review`.

This yields a small but useful concurrency model:

```text
Ticket A: Ready -> Todo -> Review -----------------> merge/staging -> Done
Ticket B:          Ready -> Todo -> Review --------> merge/staging -> Done
Ticket C:                   Ready -> Todo -> Review
```

Human waiting overlaps with later automated work; coding-agent and repair work does not. Merge and
staging actions are short coordinator jobs attached to Review runs and MUST NOT launch a second
coding ticket concurrently.

## 6. Persistence and Idempotency

The database uses the six record groups from `SPEC.md`: runs, steps, events, findings, approvals,
and side effects. Repository functions accept an expected run revision and fail on stale writes.

Each external effect has a stable key derived from the run and logical action, for example:

```text
run:<id>:project:todo
run:<id>:agent:builder:attempt:1
run:<id>:pr:create
run:<id>:merge:<approved-head-sha>
run:<id>:stage:<merge-sha>
run:<id>:project:done:<merge-sha>
```

An effect executor checks the durable receipt and current external state before acting. A process
restart therefore reconciles rather than repeats. GitHub request IDs, PR numbers, workflow-run IDs,
SHAs, and process identifiers are stored when available.

SQLite migrations run before the HTTP listener or scheduler starts. The database is opened by one
Wheelsparrow process; a filesystem lock or equivalent startup guard prevents a second writer daemon.

## 7. GitHub Boundary

`github/` is one concrete GitHub implementation, not a provider-neutral adapter framework. It owns:

- Project v2 item reads and status mutations;
- issue labels and `blockedBy` dependencies;
- branch, PR, required-check, thread, and merge observations;
- PR creation and permitted merge mutation; and
- staging workflow discovery for the configured merge SHA.

The module returns narrow typed results and preserves GitHub node IDs and SHAs needed for safe
mutation. Workflow code MUST NOT assemble GraphQL strings or shell out to `gh` directly.

Tests replace this boundary with one stateful fake that models revision changes, check progression,
approval invalidation, and duplicate-mutation detection. The fake is test code, not a second
production adapter.

## 8. Agent and Workspace Boundary

`workspaces/` creates one branch and worktree per run under the configured root. It verifies that
paths remain below that root, that the base revision is current, and that Git changes belong to the
run. Cleanup is an explicit later action; Review worktrees are retained.

`agents/` starts the configured coding-agent command without granting GitHub mutation authority. It
renders the role prompt with issue and repository facts, streams bounded output, validates one
structured terminal result, and owns timeout plus full process-tree termination.

Builder, reviewer, and repair executions are distinct steps. A reviewer gets a fresh agent context.
Prompts can request an orchestrator action in their terminal result but cannot move project items,
push, create PRs, merge, or deploy.

## 9. HTTP and UI Boundary

Fastify serves snapshot resources, mutation commands, static web assets, and an SSE stream. Routes
are thin: validate TypeBox input, enforce same-origin/CSRF and expected revision, submit a workflow
command, and return the resulting resource.

The web app renders server truth. TanStack Query owns remote snapshots; React owns transient display
state. SSE notifications invalidate or update queries. The UI does not reproduce the workflow state
machine and never assumes an optimistic approval succeeded.

The approval endpoint requires `run_id`, `expected_run_revision`, `approved_head_sha`, and
`approved_base_sha`. The coordinator re-reads GitHub state before merge, so a stale browser cannot
authorize a changed PR.

## 10. Startup and Shutdown

Startup order is:

1. load and validate configuration;
2. acquire single-process ownership;
3. migrate and open SQLite;
4. validate credential connectivity and configured GitHub fields;
5. reconcile all non-terminal runs;
6. start the HTTP listener; and
7. enable polling if not paused.

Shutdown first disables polling, rejects new mutations, lets the current database transition
finish, terminates owned child process trees within a bound, closes SSE clients, and closes SQLite.
An interrupted external effect remains durably reconcilable at next start.

## 11. Prohibited Structures

The MVP MUST NOT introduce:

- one workspace package per conceptual noun;
- a generic event bus, queue service, workflow DSL, or plugin registry;
- a second durable state store or browser-side workflow authority;
- provider-neutral tracker, repository, or agent abstractions beyond the narrow test seams in use;
- generated OpenAPI documents or generated browser clients;
- repository mutations from prompts or UI handlers;
- an in-memory-only claim, approval, retry, or side-effect ledger;
- hidden background retries without operator-visible events; or
- empty files whose only purpose is to resemble a future architecture diagram.

## 12. Change Governance

A change to the state model, approval boundary, source of truth, repository structure, or core
technology requires the four normative documents to be updated together. A short ADR is warranted
only when choosing between durable alternatives; ordinary implementation detail belongs in code and
tests.

The architecture may grow when a real limitation is observed. The first response SHOULD be a small
local seam, not a new framework or package hierarchy.
