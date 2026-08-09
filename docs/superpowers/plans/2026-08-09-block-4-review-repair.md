# Block 4 Review and Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fresh independent review, durable findings, and a bounded same-worktree repair loop after Block 3 verification.

**Architecture:** Distinct reviewer and repair process modules follow the existing bounded builder pattern. `workspaces/git.ts` supplies a bounded raw diff. A focused review workflow service creates durable effects and only settles results through an extended coordinator transaction that appends review/repair steps and findings atomically.

**Tech Stack:** TypeScript, TypeBox, Vitest, Kysely/SQLite, Node child processes, temporary Git worktrees.

---

## Task 1: Reviewer and repair prompt/process contracts

**Files:**

- Create: `prompts/reviewer.md`, `prompts/repair.md`
- Create: `apps/server/src/agents/reviewer.ts`, `apps/server/src/agents/reviewer.test.ts`
- Create: `apps/server/src/agents/repair.ts`, `apps/server/src/agents/repair.test.ts`
- Modify: `Makefile`, `package.json`

- [ ] Write failing schema/prompt tests for the four reviewer outcomes, concrete repair findings, prompt authority boundaries, byte limits, and stable hashes.
- [ ] Implement repository-owned prompts and bounded argument-array process wrappers with fresh reviewer invocation, credential stripping, redaction, timeout/tree cleanup, and exactly one TypeBox terminal result.
- [ ] Add `make test-prompts` and deterministic contract fixtures; run focused tests, TypeScript, Biome, Markdownlint, and diff hygiene.
- [ ] Commit with `feat(agents): add independent review and repair contracts`.

## Task 2: Bounded reviewer diff readback and atomic findings settlement

**Files:**

- Modify: `apps/server/src/workspaces/git.ts`, `apps/server/src/workspaces/git.test.ts`
- Modify: `apps/server/src/database/runs.ts`, `apps/server/src/workflow/coordinator.ts`
- Create: `apps/server/src/workflow/review-persistence.test.ts`

- [ ] Write failing temporary-Git and migrated-SQLite tests for contained bounded diffs and all-or-nothing review step/finding settlement.
- [ ] Implement canonical raw-diff inspection and a narrow coordinator settlement `findings` array with revision/rework/FK validation and append-only writes.
- [ ] Verify stale callbacks roll back steps/findings/effect transition together; run focused tests, TypeScript, Biome, and diff hygiene.
- [ ] Commit with `feat(workflow): persist independent review findings`.

## Task 3: Durable review/repair sequencing

**Files:**

- Create: `apps/server/src/workflow/review.ts`, `apps/server/src/workflow/review.test.ts`
- Modify: `apps/server/src/workflow/execution.ts` only for the handoff seam if required

- [ ] Write failing real-SQLite tests for verify-to-review order, intent-before-edge, approved handoff, findings, repair-to-verify loop, fresh reviewer input, two-round exhaustion, human/blocked handoff, and stale/restart safety.
- [ ] Implement stable `agent_review`/`agent_repair` effect keys and typed receipt validation. Preserve coordinator-only durable writes; repairs remain in the assigned worktree and use the existing shared repair-round transitions.
- [ ] Run focused review/execution/persistence tests, TypeScript, Biome, and diff hygiene.
- [ ] Commit with `feat(workflow): run bounded review and repair effects`.

## Task 4: Block evidence and publication preparation

**Files:**

- Modify: `MVP_IMPLEMENTATION_LEDGER.md`, `docs/delivery/MVP_REQUIREMENTS_MATRIX.md`, this plan

- [ ] Reconcile the stale Block 3/main references and map the existing slice-5 independent-review rows to merge-train row 6 without changing normative text.
- [ ] Run fresh requirements review, then quality/security review; repair every accepted finding with a regression and repeat the applicable review.
- [ ] At the exact reviewed head run `mise exec node@24.18.0 -- make verify-agent`, `make build`, `make smoke-production`, `make test-prompts`, and `git diff --check` unrestricted.
- [ ] Record only resulting evidence and commit with `docs(ledger): record Block 4 evidence`.
