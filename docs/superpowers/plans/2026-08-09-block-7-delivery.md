# Block 7 Exact-SHA Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development. Steps use checkbox syntax.

**Goal:** Require exact-SHA approval, merge, staging, smoke, and Done evidence.

**Architecture:** A repository-bound delivery gateway performs fresh external reads; coordinator
transactions own approvals, facts, transitions, and durable effects.

**Tech Stack:** TypeScript, TypeBox, Kysely/SQLite, Fastify, React, Vitest stateful fakes.

---

## Task 1: GitHub delivery boundary and fake

- [x] Add exact merge-candidate reread, deterministic capability selection, merge receipt, staging
  deployment observation, and conditional Project-Done boundary contracts with stateful fake tests.

## Task 2: Coordinator delivery sequencing

- [x] Add atomic approval/facts/effect settlement and real-SQLite delivery traces for merge, staging,
  smoke, retry staging, failures, ambiguity, and Done gating.

## Task 3: Operator delivery controls

- [x] Add guarded exact-SHA approval/retry controls, redacted delivery projections, and non-optimistic
  Review UI actions; no browser bypass of coordinator authority.

## Task 4: Evidence and release

- [ ] Run full verification, fresh reviews, exact-head PR CI, protected merge, and post-merge evidence.

Local evidence at `27d32af`: independent re-review passed; delivery, persistence, HTTP, and
composition tests cover exact approval through Done. Live staging remains intentionally deferred
until a configured disposable target and operator authorization exist.
