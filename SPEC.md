# Wheelsparrow MVP Service Specification

Status: Approved MVP baseline

Purpose: Define a small, high-quality local service that works through unblocked GitHub Project
tickets, creates verified pull requests, pauses for human merge approval, and records staging
evidence before declaring work done.

The key words MUST, MUST NOT, SHOULD, and MAY are used as described by RFC 2119. `SPEC.md` defines
product behavior. `ARCHITECTURE.md`, `TECH_STACK.md`, and `CICD.md` define the corresponding
implementation, technology, and delivery constraints. A conflict is a documentation defect and MUST
be resolved before implementation.

## 1. Product Boundary

The MVP is a single-operator, local-first daemon with a browser UI. One running instance manages:

- one configured GitHub Project v2;
- one configured GitHub repository;
- one configured issue selector, normally a label such as `mvp-signups`; and
- at most one actively executing ticket at a time.

The project workflow is deliberately small:

```text
Ready -> Todo -> Review -> Done
```

`Backlog` MAY exist for planning but is outside automation. `Review` is a human queue, not an
execution lock: several tickets MAY wait there while Wheelsparrow serially processes later eligible
`Ready` tickets.

The MVP MUST provide:

1. deterministic discovery of unblocked work;
2. an isolated coding-agent run;
3. repository-defined verification;
4. one fresh independent review and bounded repair;
5. pull-request creation and CI observation;
6. a human approval gate bound to the exact PR revision;
7. merge, staging observation, and post-deploy evidence; and
8. a useful UI for the queue, run details, and review decisions.

## 2. Explicit Non-Goals

The MVP MUST NOT attempt to provide:

- concurrent ticket execution;
- multiple projects or repositories per instance;
- multiple tracker, repository-host, or coding-agent providers;
- automatic merge without an explicit human action;
- production deployment;
- remote multi-user hosting, OIDC, RBAC, teams, or organizations;
- cost budgets, adaptive model routing, or usage optimization;
- learned rules, prompt self-modification, or quality scoring;
- dynamic risk classification or specialist reviewer panels;
- a generic workflow engine, plugin system, or public SDK;
- OpenAPI generation, generated clients, GraphQL as an application API, or WebSockets; or
- historical analytics beyond the operational records needed to understand a run.

These features require a later decision backed by a demonstrated need. They MUST NOT be introduced
as speculative extension points.

## 3. Configuration

Configuration lives in one repository-owned `wheelsparrow.yaml`. Secrets remain in the existing
GitHub and coding-agent credential stores and MUST NOT be copied into the file or database.

The initial configuration shape is:

```yaml
github:
  owner: jporcenaluk
  repository: example
  project_number: 2
  status_field: Status
  lanes:
    ready: Ready
    todo: Todo
    review: Review
    done: Done
  required_labels:
    - mvp-signups
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

The service MUST validate configuration before opening the scheduler or mutation endpoints. Invalid
repository, project, field, lane, command, model, or duration values MUST fail startup with a useful
error. Configuration changes require an explicit restart in the MVP; hot reload is out of scope.

`verification.command`, `staging.workflow`, and `staging.smoke_command` are repository contracts.
Wheelsparrow coordinates them but does not invent repository-specific correctness or deployment
behavior.

## 4. Ticket Eligibility and Ordering

On each poll, Wheelsparrow reads project items and selects an issue only when all of these are true:

- it belongs to the configured repository;
- it is open;
- its project status is `Ready`;
- it has every configured required label;
- every GitHub `blockedBy` dependency is closed; and
- no durable run already owns it.

If dependency data cannot be read safely, the issue is treated as blocked and the reason is shown in
the UI. Wheelsparrow MUST NOT guess that a ticket is unblocked.

Eligible issues are ordered by:

1. project Priority, using the project's native order when present; then
2. issue creation time, oldest first; then
3. issue number, lowest first.

Missing priority sorts after an explicit priority. Selection MUST be deterministic for the same
project snapshot.

Wheelsparrow MUST NOT claim another ticket while one ticket is executing in `Todo`. Tickets waiting
for human action in `Review` do not count as executing and MUST NOT stop later eligible work.

## 5. Ticket State Machine

GitHub Project status is the human-visible workflow state. SQLite is the execution source of truth.
Every external transition MUST have a durable intent and receipt so restart reconciliation can
determine whether it already happened.

### 5.1 `Ready` to `Todo`

Before starting work, Wheelsparrow MUST:

1. persist a run and ownership claim;
2. record an intent to move the exact project item from `Ready` to `Todo`;
3. apply and confirm the project mutation; and
4. create an isolated Git worktree from current `origin/main`.

If any step fails, no agent starts. The issue remains or returns to `Ready`, with the failure shown
to the operator.

### 5.2 `Todo` execution

The normal execution path is:

```text
intake -> build -> verify -> independent review -> repair if needed -> PR -> CI
```

Intake MUST capture the issue title, body, acceptance criteria, dependency state, relevant project
fields, repository, base SHA, and configured commands. The builder works only in the issue's
worktree and MUST validate its result before claiming completion.

After builder verification passes, Wheelsparrow launches one fresh reviewer. The reviewer receives
the issue contract, exact base and head SHAs, raw diff, relevant repository context, and verification
evidence. It MUST NOT receive the builder's claims as evidence of correctness.

A reviewer returns one of:

- `approved`;
- `needs_repair`, with concrete findings and evidence;
- `needs_human`, with a precise question or judgment call; or
- `blocked`, with an external blocker.

Repair uses a separate repair prompt and the same worktree. Verification and fresh review repeat
after repair.

### 5.3 Pull request and CI

When local verification and independent review pass, Wheelsparrow MUST:

1. create an intentional commit;
2. push a ticket-specific branch;
3. create a non-draft pull request linked to the issue;
4. record the PR number, URL, base SHA, and head SHA; and
5. observe the repository's required CI checks for that exact head SHA.

A CI failure MAY enter the bounded repair loop. A CI result for another SHA is not evidence for the
current run.

### 5.4 `Todo` to `Review`

Wheelsparrow moves a ticket to `Review` when:

- the PR exists and required checks pass; or
- automation needs human input, credentials, or judgment; or
- the retry or repair limit is exhausted; or
- staging later fails after approval.

The transition MUST preserve the worktree, branch, PR link when one exists, findings, commands,
logs, and the specific action required from the operator. A Review item MUST never be presented as
merge-ready unless its recorded PR head SHA still matches GitHub and all required checks are green.

### 5.5 Human review controls

The Review UI MUST show:

- issue title and link;
- PR title, link, base branch, and exact head SHA;
- local verification and CI results;
- independent-review findings;
- a concise change summary and changed files;
- staging state, if merge was already approved; and
- the reason human attention is required.

It MUST provide these actions:

- **Approve merge and staging** — available only for a merge-ready PR;
- **Return to Todo** — records operator feedback, invalidates prior approval, and queues rework; and
- **Retry staging** — available only for an already merged run whose staging evidence failed; and
- **Stop run** — cancels further automation without deleting evidence.

Approval MUST be bound to the exact PR head SHA shown to the operator. Any later commit, base change
that changes the merge candidate, failed check, or unresolved review thread invalidates approval.
Wheelsparrow MUST re-read the PR, checks, and approval immediately before merge.

If another ticket is already executing, Return to Todo leaves the item visibly queued in `Review`
until the execution slot is free; the coordinator then moves it to `Todo` before launching repair.
The button MUST NOT create two active `Todo` items. Retry staging is another explicit, merge-SHA-bound
operator action; it never repeats the merge.

### 5.6 Merge, staging, and `Done`

After valid approval, Wheelsparrow MUST:

1. merge through the repository's permitted merge method;
2. record the merge SHA;
3. observe the configured staging workflow for that merge SHA;
4. require successful deployment to the configured environment;
5. run the configured smoke command and retain its result; and
6. move the project item to `Done` only after all evidence is successful.

If merge is prevented, deployment fails, the deployed SHA differs, or smoke verification fails, the
ticket remains in `Review` with the exact failure. Wheelsparrow MUST NOT retry merge or deployment
indefinitely and MUST NOT claim `Done` from a merged PR alone.

## 6. Retry, Stop, and Recovery Rules

The MVP uses small fixed limits:

- an agent crash, timeout, malformed result, or process-control failure is retried once;
- verification, review, and CI share a maximum of two repair rounds;
- GitHub reads use bounded transient retries with backoff;
- ambiguous mutations, missing credentials, and permission failures stop in `Review`; and
- staging failure stops in `Review` without an automatic second deployment.

The Queue UI provides **Pause**, **Resume**, and **Stop after current**:

- Pause prevents new claims but does not interrupt the active step.
- Resume restarts polling and dispatch.
- Stop after current lets the current ticket reach its next safe handoff and then prevents claims.

On process start, Wheelsparrow MUST reconcile every non-terminal run before polling for new work. It
MUST compare durable intents with observed GitHub, Git, process, PR, check, merge, deployment, and
project state. It MUST never blindly repeat an external mutation. An agent process that cannot be
proved live and owned is terminated or treated as failed; it is not silently adopted.

## 7. Durable Records

SQLite MUST retain only the records needed for correct operation and diagnosis:

- `runs`: issue identity, state, ownership, timestamps, base/head/merge SHAs, PR, and failure;
- `steps`: role, attempt, status, prompt hash, model, timing, exit result, and summary;
- `events`: ordered operator-visible state changes and log references;
- `findings`: independent-review and repair findings with disposition;
- `approvals`: operator, exact head and observed base SHAs, decision, timestamp, and invalidation
  reason; and
- `side_effects`: idempotency key, intent, target revision, status, and receipt.

Large raw agent logs SHOULD be stored as bounded files referenced by the database. Secrets MUST be
redacted before persistence or browser delivery. Schema changes use ordered migrations and MUST be
tested against a real temporary SQLite database.

## 8. Agent Prompt Contract

The repository owns three prompts:

```text
prompts/builder.md
prompts/reviewer.md
prompts/repair.md
```

They follow the current OpenAI latest-model guidance:

- lead with the outcome and current task layer;
- use short sections for role, goal, success criteria, constraints, tools, output, and stop rules;
- state each instruction once and remove repeated scaffolding;
- grant autonomy only inside the worktree and state approval boundaries explicitly;
- expose only task-relevant tools;
- require factual evidence and validation before completion;
- request sparse phase updates rather than narration; and
- define a structured terminal result with clear stopping conditions.

The builder, reviewer, and repair roles MUST have distinct prompts. The scheduler is deterministic
code, not an agent prompt. A reviewer MUST be a fresh context and independent of the builder.

Every step records the explicit model, reasoning effort, and prompt-content hash. Prompt changes
MUST pass deterministic contract checks. Model-backed prompt evaluations SHOULD run manually against
representative successful, repair, blocked, and ambiguous traces before a prompt change is trusted.

Guidance sources:

- [Latest model guide](https://developers.openai.com/api/docs/guides/latest-model)
- [GPT-5.6 prompting guide](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6.md)

## 9. Operator UI

The local browser application has four surfaces.

### 9.1 Queue

Shows service state, the active `Todo` ticket, ordered eligible `Ready` tickets, blocked tickets with
reasons, and the count of tickets waiting in `Review`. It contains Pause, Resume, and Stop after
current controls.

### 9.2 Run detail

Shows the issue, current step, worktree and branch, attempts, live and historical logs, commands,
verification, findings, PR/CI state, staging evidence, and a chronological event history.

### 9.3 Review inbox

Shows every item requiring human attention. Merge-ready items expose the SHA-bound approval button;
other items expose their question or failure and the Return to Todo control.

### 9.4 Configuration

Shows validated effective configuration and credential connectivity read-only. Editing configuration
in the browser is out of scope.

Live updates use Server-Sent Events. A reconnecting browser may refresh the latest snapshot; durable
replay cursors are not required for the MVP.

## 10. Security Boundary

The service MUST bind to loopback by default and is designed for one trusted local operator. It uses
the existing authenticated GitHub CLI or token source and existing coding-agent login. It MUST NOT
display or persist credential values.

Mutation endpoints MUST require same-origin requests, a CSRF token, and an expected run revision.
Approval requests additionally require the exact PR head and observed base SHAs. All subprocess
arguments MUST be passed without shell interpolation unless the configured repository command
explicitly requires a shell. Logs, issue text, PR text, and agent output are untrusted data and MUST
be escaped in the UI.

Agent work is restricted to its isolated worktree. Repository-host, project, merge, and deployment
mutations belong to the orchestrator; prompts may request them but MUST NOT perform them directly.

## 11. Required MVP Validation

The implementation is not a workable MVP until automated tests prove:

1. deterministic priority and oldest-first selection;
2. open `blockedBy` dependencies prevent pickup;
3. only one ticket executes while Review items do not block later tickets;
4. every allowed and forbidden state transition;
5. agent crash retry, repair limits, and process-tree termination;
6. real SQLite migration, restart, and side-effect reconciliation;
7. GitHub reads and mutations against a stateful fake;
8. approval is rejected after a PR head-SHA change;
9. `Done` requires matching merge, staging, and smoke evidence;
10. Queue, Run, and Review browser paths through Playwright; and
11. an opt-in live smoke against a disposable GitHub test project and repository.

The end-to-end acceptance scenario is:

> Given two eligible Ready tickets and one existing Review ticket, Wheelsparrow selects the first
> eligible ticket deterministically, moves it to Todo, produces a verified PR, moves it to Review,
> selects the second ticket without waiting for the first approval, accepts approval only for the
> exact green PR SHA, merges and verifies staging, and moves only the proven ticket to Done.
