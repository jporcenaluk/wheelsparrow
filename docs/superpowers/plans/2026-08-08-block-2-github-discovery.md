# Block 2 GitHub Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select one eligible configured GitHub Project issue deterministically and durably claim it through a conditional `Ready`-to-`Todo` mutation.

**Architecture:** `github/project.ts` defines the narrow project snapshot and conditional-status mutation seam; `tests/fakes/github.ts` implements the stateful test-only fake. `workflow/discovery.ts` owns pure eligibility/order decisions and `workflow/claim.ts` composes discovery, the coordinator, and the project seam without a direct SQLite mutation or GitHub query.

**Tech Stack:** TypeScript, Vitest, real temporary SQLite migrations, Kysely repositories, and the existing `WorkflowCoordinator` durable-effect dispatcher.

---

### Task 1: Typed GitHub Project seam and stateful fake

**Files:**
- Create: `apps/server/src/github/project.ts`
- Create: `tests/fakes/github.ts`
- Test: `apps/server/src/github/project.test.ts`
- Test: `tests/fakes/github.test.ts`

- [ ] **Step 1: Write failing boundary tests for snapshot identity and conditional status moves**

```ts
expect(await fake.readProject(snapshotRequest)).toEqual(expectedSnapshot);
await expect(fake.moveProjectItem({ itemId: "PVTI_1", expectedRevision: "1", fromStatus: "Ready", toStatus: "Todo" })).resolves.toMatchObject({ outcome: "moved", revision: "2" });
await expect(fake.moveProjectItem({ itemId: "PVTI_1", expectedRevision: "1", fromStatus: "Ready", toStatus: "Todo" })).resolves.toMatchObject({ outcome: "already_applied" });
```

- [ ] **Step 2: Run the focused tests and observe missing-module failures**

Run: `mise exec node@24.18.0 -- corepack pnpm vitest run apps/server/src/github/project.test.ts tests/fakes/github.test.ts`

Expected: failure because the boundary and fake modules do not exist.

- [ ] **Step 3: Define the narrow seam and minimal stateful fake**

```ts
export interface GitHubProjectGateway {
  readProject(request: ProjectSnapshotRequest): Promise<ProjectSnapshot>;
  moveProjectItem(request: ConditionalProjectStatusMove): Promise<ProjectStatusMoveResult>;
}

export type ProjectStatusMoveResult =
  | { outcome: "moved"; item: ProjectItem }
  | { outcome: "already_applied"; item: ProjectItem }
  | { outcome: "rejected"; reason: ProjectMoveRejection };
```

Make every item carry a project ID, repository, issue node ID/number, status, revision, labels, creation timestamp, optional priority rank, and either known dependency states or `unavailable`. Reject a wrong project, item revision, source status, or changed issue mapping. Keep an immutable mutation log and expose it to tests. Do not add an HTTP client, GraphQL strings, `gh`, a provider abstraction, or production imports of the fake.

- [ ] **Step 4: Run focused tests and type checking**

Run: `mise exec node@24.18.0 -- corepack pnpm vitest run apps/server/src/github/project.test.ts tests/fakes/github.test.ts && mise exec node@24.18.0 -- corepack pnpm typecheck`

Expected: all focused tests and type checks pass.

### Task 2: Pure deterministic candidate discovery

**Files:**
- Create: `apps/server/src/workflow/discovery.ts`
- Test: `apps/server/src/workflow/discovery.test.ts`
- Modify: `apps/server/src/database/runs.ts`
- Test: `apps/server/src/workflow/discovery.test.ts`

- [ ] **Step 1: Write failing discovery tests for every eligibility rule and ordering tie-breaker**

```ts
const result = selectProjectCandidate(snapshot, {
  repository: "octo/widget", readyStatus: "Ready", requiredLabels: ["mvp", "ready"],
  ownedProjectItemIds: new Set(["PVTI_owned"]),
});
expect(result.selected?.issueNumber).toBe(7);
expect(result.excluded).toContainEqual(expect.objectContaining({ issueNumber: 8, reason: "blocked_dependencies_unavailable" }));
```

Cover wrong project/repository, closed issue, non-Ready status, missing any required label, open dependency, unavailable dependency, durable ownership, explicit-versus-missing priority, creation-time ordering, and number ordering. Add a real-SQLite test for a read-only `listOwnedProjectItemIds` query that returns only active ownership records.

- [ ] **Step 2: Run the focused discovery test and observe its failure**

Run: `mise exec node@24.18.0 -- corepack pnpm vitest run apps/server/src/workflow/discovery.test.ts`

Expected: failure because `selectProjectCandidate` and owned-project lookup do not exist.

- [ ] **Step 3: Implement side-effect-free selection and the narrow durable read**

```ts
export function selectProjectCandidate(snapshot: ProjectSnapshot, input: DiscoveryInput): DiscoveryResult {
  const considered = snapshot.items.map((item) => evaluateCandidate(item, input));
  const eligible = considered.filter(isEligible).toSorted(compareCandidates);
  return { selected: eligible[0]?.item, eligible: eligible.map(({ item }) => item), excluded: considered.filter(isExcluded) };
}
```

Treat dependency `unavailable` as blocked; label matching is a conjunction; missing priority sorts after an integer rank; timestamps compare lexicographically only after validating canonical ISO values. Query active ownership from `runs` by non-null `owner_token` and null `ownership_released_at`. Do not mutate SQLite or GitHub in this task.

- [ ] **Step 4: Run focused tests and the server type check**

Run: `mise exec node@24.18.0 -- corepack pnpm vitest run apps/server/src/workflow/discovery.test.ts && mise exec node@24.18.0 -- corepack pnpm --filter @wheelsparrow/server typecheck`

Expected: all focused tests and server type check pass.

### Task 3: Durable claim orchestration through the fake

**Files:**
- Create: `apps/server/src/workflow/claim.ts`
- Test: `apps/server/src/workflow/claim.test.ts`
- Modify: `apps/server/src/workflow/coordinator.ts` only if a typed dispatcher bridge cannot be expressed as a consumer-local adapter

- [ ] **Step 1: Write failing integration tests against real SQLite migrations and the stateful fake**

```ts
const outcome = await claimNextEligible({ coordinator, gateway: fake, configuration, now, runId: () => "run-1" });
expect(outcome).toMatchObject({ kind: "claimed", run: { id: "run-1", state: "preparing" } });
expect(fake.mutations()).toHaveLength(1);
await expect(claimNextEligible(/* same durable candidate */)).resolves.toMatchObject({ kind: "no_candidate" });
```

Also prove: durable intent is visible before the fake mutation; an exact expected revision is sent; revision drift produces a `claim_failed` run and no builder result; the coordinator's confirmed-effect replay does not duplicate a mutation; an occupied coding slot leaves the candidate unclaimed; and a false/changed mutation receipt cannot transition to `preparing`.

- [ ] **Step 2: Run the claim test and observe a missing-module failure**

Run: `mise exec node@24.18.0 -- corepack pnpm vitest run apps/server/src/workflow/claim.test.ts`

Expected: failure because `claimNextEligible` does not exist.

- [ ] **Step 3: Implement the consumer-local claim service**

```ts
export async function claimNextEligible(input: ClaimNextEligibleInput): Promise<ClaimOutcome> {
  const snapshot = await input.gateway.readProject(input.project);
  const candidate = selectProjectCandidate(snapshot, { ...input.discovery, ownedProjectItemIds: await listOwnedProjectItemIds(input.connection.db) });
  if (candidate.selected === undefined) return { kind: "no_candidate", discovery: candidate };
  return createClaimAndDispatchTodo(input, candidate.selected);
}
```

Use `WorkflowCoordinator.createClaim` with a stable `project_todo` key and the item's expected revision in the effect intent. The dispatcher must parse that bounded intent, call `moveProjectItem`, and return `confirmed/todo_observed` only for a matching item, issue, status, and revision receipt. Return a typed rejection for stale status/revision/mapping and never invoke agent, worktree, PR, or UI behavior.

- [ ] **Step 4: Run focused integration tests, full verification, and build**

Run: `mise exec node@24.18.0 -- corepack pnpm vitest run apps/server/src/github/project.test.ts tests/fakes/github.test.ts apps/server/src/workflow/discovery.test.ts apps/server/src/workflow/claim.test.ts && mise exec node@24.18.0 -- make verify-agent && mise exec node@24.18.0 -- make build`

Expected: focused tests, the repository gate, and build pass. Run the final two commands unrestricted if the managed sandbox suppresses child-process output.
