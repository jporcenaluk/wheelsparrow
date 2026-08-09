# Block 5 Publication and CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development. Steps use checkbox syntax for tracking.

**Goal:** Publish an approved run safely and hand off exact-head green CI to Review.

**Architecture:** Keep Git and GitHub edges narrow and injected; make the coordinator the only durable writer; derive all actions from stable run/rework keys.

**Tech Stack:** TypeScript, Vitest, Kysely/SQLite, contained Git subprocesses.

---

## Task 1: Contained commit and push edge

**Files:** `apps/server/src/workspaces/git.ts`, `apps/server/src/workspaces/git.test.ts`

- [x] Add a failing temporary-Git test for revalidated staging, conventional ticket commit, non-force push, exact returned branch/base/head receipt, empty-change rejection, and push failure.
- [x] Add `commitAndPushRunWorktree()` using only bounded `GitRunner` calls after `inspectRunWorktree()`; reject changed identity and never force push.
- [x] Run `pnpm vitest run apps/server/src/workspaces/git.test.ts`; commit the contained edge.

## Task 2: Concrete GitHub publication boundary and fake

**Files:** `apps/server/src/github/publication.ts`, `apps/server/src/github/publication.test.ts`, `tests/fakes/github.ts`

- [x] Add failing fake-backed tests for linked non-draft PR create/reread, duplicate keys, pending/green/failure required checks, and head drift.
- [x] Define typed PR/check receipts and one repository-bound gateway; the fake records mutation IDs and exact heads.
- [x] Run the boundary tests; commit.

## Task 3: Coordinator publication facts

**Files:** `apps/server/src/database/runs.ts`, `apps/server/src/workflow/coordinator.ts`, focused tests

- [x] Add failing atomic-settlement tests for validated PR number/title/URL/base/head facts and stale rollback.
- [x] Add a narrow publication facts patch accepted only from the coordinator transaction.
- [x] Run focused SQLite tests; commit.

## Task 4: Publication and exact-CI workflow

**Files:** `apps/server/src/workflow/publication.ts`, `apps/server/src/workflow/publication.test.ts`

- [x] Add real-SQLite failing tests for intent-before-edge, idempotent replay, exact PR receipt, pending observation, green Review handoff, head drift, repairable/exhausted CI failures, and fail-closed ambiguity.
- [x] Implement coordinator-owned publish/check sequencing with rework-qualified effect/step keys and bounded receipts.
- [x] Run focused workflow tests; commit.

## Task 5: Whole-block evidence

**Files:** `MVP_IMPLEMENTATION_LEDGER.md`, `docs/delivery/MVP_REQUIREMENTS_MATRIX.md`

- [x] Reconcile only proven Block 5 requirements and leave Blocks 6–8 pending.
- [x] Run `make verify-agent`, `make test-prompts`, `make build`, `make smoke-production`, and `git diff --check`.
- [x] Request fresh specification and quality reviews; publish a non-draft PR only after both approve.
