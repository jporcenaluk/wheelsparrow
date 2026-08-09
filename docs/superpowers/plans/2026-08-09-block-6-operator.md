# Block 6 Operator Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development. Steps use checkbox syntax.

**Goal:** Provide an accessible local operator API and browser controls over durable workflow truth.

**Architecture:** Fastify routes validate TypeBox requests then submit coordinator commands; React
routes render server snapshots through TanStack Query and SSE invalidation.

**Tech Stack:** Fastify, TypeBox, SQLite/Kysely, React, React Router, TanStack Query, EventSource.

---

## Task 1: Operator contracts and safe read projections

**Files:** `packages/contracts/src/operator.ts`, `apps/server/src/http/projections.ts`, focused tests.

- [ ] Define versioned Queue, Run detail, Review, Configuration, scheduler-control, and event schemas.
- [ ] Read only redacted durable fields; test that ownership tokens, raw effects, process IDs, and
  credential values cannot reach projections.

## Task 2: Guarded API and coordinator commands

**Files:** `apps/server/src/http/security.ts`, `apps/server/src/http/routes.ts`, `apps/server/src/app.ts`,
`apps/server/src/workflow/coordinator.ts`, focused Fastify/coordinator tests.

- [ ] Add same-origin and per-process CSRF checks, JSON error contracts, revision conflicts, read
  routes, scheduler mutation, Return-to-Todo command, and notification SSE.
- [ ] Keep approval, merge, staging, smoke, and Done mutations absent.

## Task 3: Browser operator routes

**Files:** `apps/web/src/api.ts`, `apps/web/src/main.tsx`, `apps/web/src/routes/*`,
`apps/web/src/components/*`, UI tests, dependency manifests/lockfile.

- [ ] Add React Router and TanStack Query using their declarative provider patterns.
- [ ] Render Queue, Run, Review, and Configuration from API snapshots; wire accessible scheduler
  controls and EventSource invalidation without client-side workflow transitions.

## Task 4: Integration, evidence, and handoff

**Files:** ledger, matrix, Block 6 plan, API/UI tests.

- [ ] Exercise API security, stale writes, SSE reconnect, navigation, keyboard controls, and redaction.
- [ ] Run aggregate verification, independent review, PR CI, and exact-head merge evidence before
  starting Block 7.
