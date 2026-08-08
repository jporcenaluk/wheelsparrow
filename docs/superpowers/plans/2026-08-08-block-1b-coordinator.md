# Block 1B: Durable Workflow Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `subagent-driven-development` for independent review lanes and strict TDD for
> every production behavior. Root owns commits, publication, merge, and the
> delivery ledger.

**Goal:** Make SQLite the canonical, revision-safe workflow state machine with
one serialized coordinator, idempotent side-effect intents and receipts, and
startup recovery that never blindly repeats an external mutation.

**Architecture:** A small workflow domain defines states and legal transitions.
Repositories perform every mutation in a SQLite transaction using an expected
run revision, append an event, and create an optional effect intent atomically.
The coordinator serializes commands, dispatches only after commit, and routes
external results back through revision-checked observations. Recovery converts
unfinished owned effects to an observation-only state before the HTTP listener
is allowed to start.

**Tech Stack:** TypeScript, Vitest, real temporary SQLite files through
better-sqlite3 and Kysely, immutable SQL migrations, Fastify lifecycle seams.

---

## Scope and invariants

- `runs.state` is one of the complete twenty-state vocabulary in
  `workflow/state.ts`; no repository accepts arbitrary strings. The vocabulary
  is `claiming`, `preparing`, `rolling_back_claim`, `claim_failed`, `intaking`,
  `building`, `verifying`, `reviewing`, `repairing`, `publishing`,
  `waiting_for_ci`, `review`, `queued_rework`, `returning_to_todo`, `merging`,
  `waiting_for_staging`, `smoking`, `completing`, `done`, and `stopped`.
- A state change requires the caller's exact `revision`; one successful change
  increments the revision once and appends exactly one event in the same SQLite
  transaction.
- Only one owned run may exist for one project item and only one coding-state
  run may consume the singleton execution slot. A `review` run releases that
  slot.
- An external mutation has a stable effect key and a SHA-256 fingerprint. Its
  intent is committed with the state change, its executor runs outside the
  transaction, and its receipt is persisted only through a coordinator
  observation.
- Replaying an identical intent is idempotent; a reused key with a different
  fingerprint is rejected before an executor can run.
- On restart, `pending` effects can be dispatched, but `in_flight` effects are
  made `ambiguous` and must be observed. An ambiguous effect is never executed
  again without an observation proving the outside state.
- Startup order becomes configuration, safe paths, ownership, database,
  migration, recovery, application/listener, readiness. Recovery failure
  prevents listener startup; shutdown marks this process's in-flight effects
  ambiguous before releasing the database lock.

### Task 1: Add the immutable persistence guardrails

**Files:**

- Create: `migrations/002_workflow_coordinator.sql`
- Modify: `apps/server/src/database/schema.ts`
- Modify: `tests/integration/migrations.test.ts`

- [ ] **Step 1: Write failing migration tests.**

  Create a temporary migration directory containing `001_initial.sql` and the
  new file, then assert that migration succeeds, the one-row
  `scheduler_control` record exists, invalid state/effect-status direct writes
  fail, the active-project and coding-slot partial indexes reject a duplicate,
  and historic `events`, `steps`, `findings`, and `approvals` reject `UPDATE`
  and `DELETE`.

  ```ts
  expect(() => connection.native.prepare("UPDATE runs SET state = 'made_up'").run())
    .toThrow(/CHECK constraint failed/);
  expect(() => connection.native.prepare("DELETE FROM events WHERE run_id = ?").run("run-1"))
    .toThrow(/append-only/);
  ```

- [ ] **Step 2: Run the focused migration test and verify it fails** because
  `002_workflow_coordinator.sql` and its schema type do not exist.

  Run: `mise exec node@24.18.0 -- pnpm vitest run tests/integration/migrations.test.ts`

- [ ] **Step 3: Add the minimal immutable migration.**

  The migration creates `scheduler_control(id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL CHECK(revision >= 0), paused INTEGER NOT NULL,
  stop_after_current INTEGER NOT NULL, updated_at TEXT NOT NULL)` and inserts
  row `1`. It adds
  SQLite `CHECK` constraints through validation triggers for canonical run and
  effect states, partial unique indexes for active `project_item_id` ownership
  and coding states, and `BEFORE UPDATE OR DELETE` triggers that abort changes
  to append-only tables with `append-only history`.

- [ ] **Step 4: Extend `DatabaseSchema`** with `SchedulerControlTable` and
  rerun the focused migration test to green.

- [ ] **Step 5: Commit** the migration and its tests after TypeScript,
  formatter, and diff hygiene pass.

### Task 2: Define state and revision-aware repositories

**Files:**

- Create: `apps/server/src/workflow/state.ts`
- Create: `apps/server/src/workflow/state.test.ts`
- Create: `apps/server/src/database/workflow-repository.ts`
- Create: `apps/server/src/database/workflow-repository.test.ts`

- [ ] **Step 1: Write failing state-domain tests** for every legal transition,
  terminal-state rejection, coding-slot membership, and review handoff.

  ```ts
  expect(canTransition("claiming", "todo_observed")).toBe("preparing");
  expect(canTransition("review", "building")).toBe(false);
  expect(consumesCodingSlot("review")).toBe(false);
  ```

- [ ] **Step 2: Run the state test and verify it fails** at the missing module.

- [ ] **Step 3: Implement the smallest declarative domain.** Define the
  complete twenty-value `WorkflowState` union, one exhaustive transition map,
  `EffectStatus`, effect-observation trigger rules, and coding/terminal state
  helpers. The table covers claim rollback, queued rework, merge/staging/smoke
  continuation, and safe stop as specified; Return-to-Todo is the only rework
  epoch increment.

- [ ] **Step 4: Write failing real-SQLite repository tests** that create a
  `claiming` run with revision/event one, reject stale revision and illegal
  predecessor without any partial row, append one event/revision on success,
  release the coding slot on `review`, reject a second active project owner or
  coding run, reset the repair counter/increment the epoch on rework, and
  version durable Pause/Resume/Stop-after-current updates.

- [ ] **Step 5: Implement `WorkflowRepository`.** Its `createClaim`,
  `transitionRun`, append-only `appendStep`/`appendFinding`/`appendApproval`,
  `updateSchedulerControl`, and read methods validate bounded records, use one
  `connection.db.transaction`, and map zero-row conditional updates to typed
  stale/occupied errors. `transitionRun` creates the event and optional effect
  intent in the same transaction and returns the committed record.

- [ ] **Step 6: Run domain and repository tests to green**, then typecheck,
  format, and diff-check before committing.

### Task 3: Add durable effect lifecycle and serialized coordination

**Files:**

- Create: `apps/server/src/workflow/effect-repository.ts`
- Create: `apps/server/src/workflow/effect-repository.test.ts`
- Create: `apps/server/src/workflow/coordinator.ts`
- Create: `apps/server/src/workflow/coordinator.test.ts`

- [ ] **Step 1: Write failing effect tests** for same-key/same-fingerprint
  replay, same-key/different-fingerprint rejection, conditional
  `pending -> in_flight -> confirmed|failed|ambiguous` transitions, and durable
  receipt/evidence retention.

- [ ] **Step 2: Run the effect tests and verify missing-module failure.**

- [ ] **Step 3: Implement the effect repository** using conditional SQL by
  effect key, status, and executor owner token. It exposes an unresolved-effect
  query and a `markOwnedInFlightAmbiguous` shutdown operation.

- [ ] **Step 4: Write failing coordinator tests.** Submit two controls or
  transitions concurrently, prove FIFO revisions, assert executor invocation
  occurs only after the intent is visible from a second SQLite connection, and
  assert an executor result returns as a revision-checked observation rather
  than a direct state mutation. Cover stopped runs, queued-rework promotion,
  and an occupied coding slot.

- [ ] **Step 5: Implement `WorkflowCoordinator`.** Queue every command behind
  one promise tail (including after a failed predecessor); validate and persist
  intent inside the repository transaction; mark dispatch after commit; invoke
  the injected executor outside the transaction; and enqueue every
  receipt/failure as an observation. `close()` stops new commands, awaits the
  current queue, and marks the coordinator's unresolved owned effects
  ambiguous while appending durable run evidence.

- [ ] **Step 6: Run effect and coordinator tests to green**, then the full
  SQLite migration suite, typecheck, formatter, and diff hygiene before
  committing.

### Task 4: Recover safely and compose lifecycle ordering

**Files:**

- Create: `apps/server/src/workflow/reconciliation.ts`
- Create: `apps/server/src/workflow/reconciliation.test.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/main.test.ts`

- [ ] **Step 1: Write failing recovery tests** for restart before dispatch
  (`pending` is dispatched), crash after dispatch (`in_flight` becomes
  `ambiguous` and invokes observer only), successful observation (persists the
  receipt), and unavailable observer (fails closed without listener startup).

- [ ] **Step 2: Run recovery tests and verify the missing-module failure.**

- [ ] **Step 3: Implement `reconcileEffects`.** Accept explicit dispatcher and
  observer ports. It never calls the dispatcher for `in_flight` or `ambiguous`
  records; it persists the observer result through the effect repository.

- [ ] **Step 4: Add failing lifecycle-order tests** that assert reconciliation
  follows migration and precedes `buildApp`/`listen`, and that coordinator close
  precedes database close during normal shutdown and failure cleanup.

- [ ] **Step 5: Wire coordinator/recovery into `startService`.** Add narrow
  optional dependencies for test injection. The production adapter has no
  effect executor yet and only starts when reconciliation finds no unfinished
  external work; it produces a clear failure if a later block leaves work that
  needs an unavailable integration.

- [ ] **Step 6: Run recovery and lifecycle tests to green**, then full
  `make verify-agent`, `make build`, `make smoke-production`, and
  `git diff --check`; commit the integrated Block 1B behavior.

### Task 5: Record traceability, independently review, and publish

**Files:**

- Modify: `MVP_IMPLEMENTATION_LEDGER.md`
- Modify: `docs/delivery/MVP_REQUIREMENTS_MATRIX.md`

- [ ] **Step 1: Update the ledger** to mark Block 1A merged at
  `e6899f48ab2c6d5499eae4de16a96c8dd5ec6eca`, identify this branch and plan as
  Block 1B, and bind only current evidence to the exact head.

- [ ] **Step 2: Run an independent requirements review and an adversarial
  recovery/concurrency review.** Reproduce every accepted finding with a new
  RED test before repair and repeat the relevant review.

- [ ] **Step 3: At the final head run:**

  ```sh
  mise exec node@24.18.0 -- make verify-agent
  mise exec node@24.18.0 -- make build
  mise exec node@24.18.0 -- make smoke-production
  git diff --check
  ```

- [ ] **Step 4: Publish a non-draft PR, wait for all exact-head checks and
  review feedback, squash-merge with an expected-head guard, and verify
  post-merge CI/artifact evidence before beginning Block 2.**

## Completion boundary

Block 1B is complete only when the merge commit proves canonical state and
valid transitions, revision-safe serialized mutations, one coding slot,
durable idempotent effects, observation-only ambiguous recovery, startup
reconciliation, shutdown ambiguity marking, real SQLite migration behavior,
independent review, exact-head CI, and merged-main evidence. GitHub discovery,
agent processes, review, PRs, UI, approval, and staging remain later blocks.
