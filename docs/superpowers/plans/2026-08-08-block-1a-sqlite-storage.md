# Block 1A: Durable SQLite Storage Implementation Plan

> **Execution:** Use `subagent-driven-development` with one fresh Terra/medium builder per bounded
> code task, followed by a fresh Terra/medium specification and quality review. Root owns this plan,
> the ledger/matrix, integration, commits, publication, merge, and completion claims.

**Goal:** Give Wheelsparrow a safe local data root, exclusive daemon ownership, a real SQLite
database with immutable migrations, the six operational record groups, and startup/shutdown wiring
that fails before the listener when durable state is unsafe.

**Product test:** After this slice, one process can start from a clean checkout, acquire the local
state directory, migrate and open the database, serve the existing application, and close cleanly.
A second live process cannot share that state. The database has the exact operational record groups
needed by later orchestration work and no analytics, queue, provider, workflow, or log-file subsystem.

**Base:** protected `main` at `64951a3edc3de50bdc8007becde965308c5d3040` (PR #26 merge).

**Requirements owned:** `ARCH-06-001` (schema half; revision-conditional repository writes remain
row 3), `ARCH-06-004`, `ARCH-10-001` (configuration/ownership/database/listener prefix; credential,
reconciliation, and polling steps remain row 3), `SPEC-02-009` (local-storage choice; final
conformance remains row 8), `SPEC-07-001`, `SPEC-07-002`, `SPEC-07-005`, `SPEC-11-007`,
`STACK-04-001`, `STACK-04-002`, `STACK-04-003`, `STACK-04-004`, `STACK-04-006`, `STACK-07-005`,
`STACK-09-004` (canonical local data layout), and `STACK-10-002` (native Linux/macOS evidence).
`STACK-11-003` is a row 8 conformance obligation. Raw agent logs (`SPEC-07-003`, `STACK-04-008`)
belong to row 4 when real agent output exists; this slice establishes their private canonical root
but does not build a log store.

**Dependencies:** exact eligible releases `better-sqlite3@13.0.3`, `kysely@0.29.4`,
`fs-native-extensions@1.5.0`, and `@types/better-sqlite3@9.6.0`. Registry timestamps were checked on
2026-08-08 and satisfy the strict 1,440-minute minimum-release-age policy. Only `better-sqlite3`
requires a lifecycle-script allowlist entry; the audited `fs-native-extensions` graph has no install
lifecycle scripts. That package supplies the narrow cross-platform OS advisory-lock primitive that
Node core lacks; it is not a general filesystem layer.

**Run commands:** execute local Node commands as
`mise exec node@24.18.0 -- corepack pnpm ...`; CI reads the same version from `.node-version`.

## Engineering boundaries

- The configured `workspace_root` remains the only path setting. Its parent is the local data root:
  `.wheelsparrow/workspaces` yields `.wheelsparrow/`, `wheelsparrow.sqlite3`,
  `wheelsparrow.lock`, and `logs/`. A one-segment value such as `workspaces` is rejected because it
  would turn the repository root into mutable application data.
- The security boundary is one trusted local OS account. Path defenses prevent configuration errors,
  accidental escape, and pre-existing unsafe links; they do not claim to withstand a malicious same-
  account process swapping paths between syscalls. Reject absolute paths, traversal, escape, and every
  existing symbolic-link component; require existing data paths to be owned by the current uid and
  not group/world writable on POSIX. Create the data/workspace/log roots with `0700`, revalidate them,
  and reject a non-regular or symbolic-link database/lock/WAL/SHM target immediately before use.
- Ownership opens the regular `wheelsparrow.lock` file with private permissions and uses
  `fs-native-extensions.tryLock(fd)` to hold one nonblocking exclusive OS advisory lock for the daemon
  lifetime. A false return becomes `OwnershipConflictError`; hard errors retain their cause. Release
  unlocks and closes exactly once, and process exit releases the OS lock, so there is no stale PID,
  PID-reuse, lease, malformed-metadata, or recovery-gate state machine. Wheelsparrow has one SQLite
  database; the lock file is not a database or durable record store.
- The initial migration creates `runs`, `steps`, `events`, `findings`, `approvals`, `side_effects`,
  plus `schema_migrations`. Each of the six tables contains every field family named in `SPEC.md`.
  Row 3 adds state enums, revision-aware repositories, coordinator invariants, effect lifecycle, and
  scheduler controls through later immutable migrations.
- SQLite opens a real file with a five-second busy timeout and verified foreign keys. It requests WAL,
  allows only SQLite's safe non-WAL modes for this single-process local daemon, emits an operator-
  visible warning before readiness when WAL is unavailable, and exposes the actual mode.
- Migrations match strict ASCII `/^[0-9]{3}_[a-z0-9_]+\.sql$/`, are ordered by numeric ID then bytewise
  name, and are immutable checksummed raw SQL. Validate the complete set before mutation. Missing or
  edited applied migrations, duplicate IDs, malformed/Unicode/case variants, transaction-control or
  attachment statements, and an unapplied ID at or below the greatest applied ID fail startup.
- Startup order in this slice is configuration -> derive/create/revalidate paths -> ownership ->
  open/migrate database -> construct/listen. A lifecycle owner registers signal handling before
  acquisition and closes resources once in reverse order on failure or signal. Later slices insert
  credential validation, reconciliation, and polling before/after the listener as specified.
- No ORM, second durable store, analytics history, generic provider layer, event bus, queue, workflow
  engine, new config key, or empty future hierarchy.

## Task 1: Record the merge-train handoff

**Files:** `MVP_IMPLEMENTATION_LEDGER.md`, `docs/delivery/MVP_REQUIREMENTS_MATRIX.md`,
`docs/superpowers/plans/2026-08-08-block-0-repair-and-control-plane.md`, this plan.

- [x] Mark every Block 0 publication step complete and bind it to PR #26, pre-merge head
  `6c2bea8fc4233292e0498e60e1c998360aa460b3`, merge SHA
  `64951a3edc3de50bdc8007becde965308c5d3040`, exact-SHA CI runs `31253147178` and
  `31253147159`, and artifact `9020617150`.
- [x] Mark row 1 merged and row 2 in progress; make this plan the only resume point.
- [x] Correct raw-log and final-conformance row ownership, update direct evidence without upgrading
  broad requirements on indirect proof, recalculate the matrix SHA-256, lint the documents, and
  commit the durable checkpoint before product code.

## Task 2: Add native dependencies and a real persistence test lane

**Files:** `apps/server/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `Makefile`, test config.

- [x] Add one failing integration probe that imports `better-sqlite3`, opens a temporary real file,
  writes a value, closes, reopens, and reads it. Confirm RED before dependency installation.
- [x] Add the exact dependencies above and allow lifecycle scripts only for `better-sqlite3`; preserve
  strict release quarantine and the existing `esbuild` entry. Keep `fs-native-extensions` out of the
  allowlist because its audited graph has no install lifecycle script.
- [x] Regenerate the lockfile with pinned pnpm, perform a frozen install, and make the real-file suite
  part of the canonical `make verify-agent` path rather than an optional test command.
- [x] Verify focused RED/GREEN, typecheck, repository policy, lint, and diff hygiene.

## Task 3: Derive safe local paths

**Files:** `apps/server/src/config.ts`, `apps/server/src/config.test.ts`.

- [x] Write failing tests for the canonical `.wheelsparrow/workspaces` layout, one-segment rejection,
  absolute/traversal rejection, a symlink at every existing path depth, missing descendants, and a
  canonical contained path.
- [x] Implement `deriveLocalPaths(repositoryRoot, workspaceRoot)` and
  `loadRuntimeConfiguration(repositoryRoot)` using `realpath`/`lstat` containment checks. Return
  absolute `repositoryRoot`, `dataRoot`, `workspaceRoot`, `databasePath`, `lockPath`, and `logsRoot`.
- [x] Prove path derivation never creates files or directories; creation belongs to startup after the
  first validation, followed by revalidation.
- [x] Run focused tests, typecheck, lint, and diff hygiene.

## Task 4: Enforce exclusive process ownership

**Files:** create `apps/server/src/database/ownership.ts`; create focused tests beside it.

- [x] Write failing tests for first acquisition, a second native connection receiving a typed conflict,
  idempotent release/close, acquisition after release, and acquisition after a real child holder is
  force-killed. Add a real two-child contention test proving no overlapping ownership interval.
- [x] Implement `acquireOwnership(lockPath)` by opening one private regular file and calling
  `fs-native-extensions.tryLock(fd)` for a whole-file exclusive lock. Open existing-or-create with
  `O_RDWR` and mode `0600`; never truncate, unlink, or recreate the lock file. A false result is the
  only ownership conflict; preserve hard open/lock errors. `release()` unlocks and closes the same
  descriptor exactly once.
- [x] Keep this as a consumer-local module, not a generic lock/provider or filesystem framework. The
  lock file contains no application record; authority is the OS-held descriptor lock, released
  automatically when the process exits. The operator-facing conflict says this advisory lock protects
  cooperating Wheelsparrow processes; it does not claim a hostile same-account security boundary.
- [x] Run focused tests repeatedly, typecheck, lint, and diff hygiene. Root's unrestricted Node
  24.18.0 run passed all 9 native ownership tests, and a fresh reviewer returned `APPROVED` after the
  two-child proof was added.

## Task 5: Open SQLite and run immutable migrations

**Files:** create `migrations/001_initial.sql`, `apps/server/src/database/schema.ts`,
`apps/server/src/database/connection.ts`, `apps/server/src/database/migrate.ts`, and focused real-file
integration tests.

- [ ] Write failing real-file tests for fresh migration, reopen/no replay, upgrade ordering, transaction
  rollback, foreign-key enforcement, WAL/effective fallback reporting and warning, checksum drift,
  missing applied files, duplicate numeric IDs, malformed ASCII/Unicode/case names, forbidden
  transaction/attachment SQL, and retroactive migration insertion.
- [ ] Define Kysely row types for the six operational tables and migration ledger. Persist JSON as
  bounded text; parsing/domain validation belongs to row 3 repositories.
- [ ] Create `001_initial.sql` with every named `SPEC.md` field family:
  - `runs`: issue/project identity, bounded intake snapshot, state, revision/ownership,
    timestamps, base/head/merge SHAs, worktree, base/ticket branches, PR number/title/URL, required
    action, and failure;
  - `steps`: run, role, logical step, attempt/status, prompt hash, model/reasoning effort, timing, exit
    result, summary, and raw-log reference nullable for row 4;
  - `events`: ordered run sequence/revision, kind, summary/details, log reference, and timestamp;
  - `findings`: run/rework identity, stable key, reviewer/repair step references, severity, evidence,
    disposition, and timestamp;
  - `approvals`: run, operator, exact head/base SHAs, decision, timestamp, and invalidation reason;
  - `side_effects`: stable key, run/rework, kind, target revision, fingerprint, intent, status, receipt,
    process/request/PR/workflow identifiers when available, attempt/ownership, timing, failure, and
    reconciliation evidence.
  The initial physical schema is intentionally exact: use the column names asserted in
  `tests/integration/migrations.test.ts`; add no speculative scheduler, provider, analytics, or
  workflow-enum columns. Later behavior changes use new immutable migrations instead of editing 001.
- [ ] Add primary/foreign/unique/index/check constraints that are independent of row 3's still-pending
  state machine. Index issue/project identity for row 3's state-conditional ownership check, prevent
  cross-run finding-to-step references, and bound persisted JSON to 1 MiB. Do not encode guessed
  workflow enums or unconditional one-run-per-issue uniqueness in the initial migration.
- [ ] Implement one connection owner around the same native handle/Kysely dialect. Set busy timeout,
  enable and verify foreign keys, request WAL, retain actual journal mode, expose Kysely transactions,
  and close exactly once.
- [ ] Validate every migration before opening a transaction. Apply SQL and its SHA-256 ledger row on
  the same native handle inside one synchronous `better-sqlite3` transaction with no `await`; Kysely
  must not create a second migration transaction. Fault-inject after migration execution and ledger
  insertion, reopen, and prove schema/ledger consistency after rollback.
- [ ] Run the focused migration suite twice, typecheck, lint, and diff hygiene.

## Task 6: Compose storage into startup and shutdown

**Files:** `apps/server/src/main.ts`, `apps/server/src/main.test.ts`, production smoke support as needed.

- [ ] Write failing orchestration tests that observe configuration/path validation, private directory
  creation, revalidation, ownership, database open/migrate, listener, reverse-order cleanup, and
  causal errors. Prove the listener is never attempted after ownership or migration failure. When
  migration fails after open, assert transaction rollback, database close once, ownership release,
  and immediate successful reopen.
- [ ] Refactor `start` behind narrow injected lifecycle functions while preserving the production entry
  point, loopback binding, readiness semantics, URL announcement, and bounded signal shutdown.
  Register one idempotent lifecycle owner before acquisition and remove process-global signal handlers
  after failed/test lifecycles.
- [ ] Create data/workspace/log directories with private permissions, revalidate paths, acquire
  ownership, open/migrate, and then construct/listen. Close database and release ownership after the
  app closes; best-effort cleanup must not replace the initiating failure.
- [ ] Extend production smoke to use an isolated temporary repository/data root and prove the SQLite
  file is created, migrated, locked while live, and cleanly reopenable after shutdown. Add child-
  process SIGTERM during startup and after readiness; both must permit immediate restart. Prove the
  packaged build discovers migrations without relying on the source checkout or caller CWD.
- [ ] Run focused tests, full local verification, build, and production smoke.

## Task 7: Prove native CI and the runnable artifact

**Files:** `.github/workflows/ci.yml`, `.github/workflows/main.yml`, workflow policy tests,
artifact/smoke scripts as needed.

- [ ] Add a narrow macOS native-storage job that installs with the pinned Node/pnpm toolchain and runs
  the real SQLite migration suite plus Task 4's real two-child contention, release, and force-kill/
  reacquire ownership tests; retain Linux as the canonical full gate. Pin every action by SHA and use
  least privilege.
- [ ] Define the archive honestly as an installable local source bundle for a supported host, not a
  self-contained platform binary. Package `migrations/` and manifests; replace blanket
  `--ignore-scripts` with the explicit pnpm lifecycle allowlist so the supported host installs or
  builds `better-sqlite3` while arbitrary transitive scripts stay disabled; the lock package loads its
  shipped native addon without lifecycle execution.
- [ ] Add semantic workflow tests proving Linux and macOS native install/load/migration coverage,
  migration packaging, strict frozen production install, and exact-revision smoke. Recreate/extract
  the source bundle locally, install on a supported host, and run the same production proof from the
  extracted directory. Do not claim offline or cross-platform binary portability.
- [ ] Record the resolved native transitive graph, package licenses/integrity, and lifecycle scripts in
  review evidence. Prove the frozen production install permits builds only for `better-sqlite3` and
  that `fs-native-extensions` needs no lifecycle-script exemption.
- [ ] Run action/workflow policy checks, full verification, build, production smoke, and diff hygiene.

## Task 8: Review, publish, merge, and bind exact evidence

- [ ] Run a fresh Terra/medium requirements review against the listed matrix rows and normative text.
- [ ] Run fresh Terra/medium quality/security reviews over the whole branch. Accept findings only after
  reproducing them; repair with RED/GREEN tests and invalidate stale evidence after any code change.
- [ ] At the exact reviewed head run frozen install, `make verify-agent`, build, production smoke,
  extracted-artifact smoke, Markdownlint, repository policy, and diff hygiene.
- [ ] Root commits and pushes the exact reviewed branch, opens a non-draft Conventional Commit PR,
  records its exact head, and waits for all present exact-head checks including Linux and macOS.
- [ ] Re-read live protection, approvals, conversations, mergeability, and checks; squash-merge through
  protected `main` using the expected-head guard.
- [ ] Verify remote `main`, post-merge CI, main artifact, extracted runnable proof, artifact name/digest,
  and every conclusion at the exact merge SHA. Record the evidence in row 3's first checkpoint.

## Completion boundary

Block 1A is complete only when the exact merged revision proves safe paths, exclusive ownership,
real immutable migrations, the six operational record groups, startup-before-listener ordering,
reverse cleanup, Linux/macOS native operation, and an installable artifact containing migrations and
an explicit allowlist for its native binding. The programme goal remains active: revision-aware repositories, workflow state,
effects, recovery, GitHub/agent execution, operator UI, and completion orchestration continue in the
later merge-train rows.
