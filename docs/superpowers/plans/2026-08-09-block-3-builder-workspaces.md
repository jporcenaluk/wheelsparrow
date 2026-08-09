# Block 3 Builder and Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a contained worktree for a claimed run, execute the configured builder and verification commands there, and return durable receipts through the coordinator.

**Architecture:** `workspaces/` owns narrow Git/worktree operations; `agents/` owns builder prompt rendering and bounded local Codex execution; `workflow/execution.ts` translates these edge results into existing `workspace_prepare`, `agent_build`, and `verify` effects. It never directly writes SQLite, GitHub, PR, or UI state.

**Tech Stack:** TypeScript, Vitest, TypeBox, Node `child_process`, real temporary Git repositories/worktrees, real SQLite migrations, and the existing durable `WorkflowCoordinator`.

---

## Task 1: Contained worktree boundary

**Files:**

- Create: `apps/server/src/workspaces/git.ts`
- Create: `apps/server/src/workspaces/git.test.ts`

- [ ] **Step 1: Write failing containment and provenance tests**

```ts
const prepared = await prepareRunWorktree({
  repositoryRoot, workspaceRoot, runId: "run-7", issueNumber: 42,
  baseBranch: "main", git: realGit,
});
expect(prepared.branch).toBe("wheelsparrow/42-run-7");
expect(prepared.path.startsWith(`${workspaceRoot}${sep}`)).toBe(true);
expect(prepared.baseSha).toMatch(/^[0-9a-f]{40}$/u);
await expect(prepareRunWorktree({ ...input, workspaceRoot: outsideRoot }))
  .rejects.toThrow("workspace root");
```

Use a temporary initialized repository with `origin/main` and real `git
worktree` commands. Prove: the configured root is canonical/private and below
the configured data root; one path and branch are deterministic per run;
creation uses current `origin/main`; branch/worktree records match Git;
symlinks, traversal, duplicate run ownership, stale/missing remote base, and
an existing worktree with an unexpected branch or base fail closed. Prove that
changed paths are reported relative to the assigned worktree and do not escape
it. Prove no cleanup occurs when a run reaches Review.

- [ ] **Step 2: Run the focused test and observe the missing-module failure**

Run: `mise exec node@24.18.0 -- corepack pnpm vitest run apps/server/src/workspaces/git.test.ts`

Expected: failure because `prepareRunWorktree` does not exist.

- [ ] **Step 3: Implement the narrow Git boundary**

```ts
export interface PreparedWorktree {
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseSha: string;
}

export async function prepareRunWorktree(
  input: PrepareRunWorktreeInput,
): Promise<PreparedWorktree>;

export async function inspectRunWorktree(
  input: InspectRunWorktreeInput,
): Promise<RunWorktreeInspection>;
```

Invoke `git` with fixed argument arrays and `shell: false`, bounded output,
and the existing process-tree termination helper. Canonicalize every path
before mutation, reject a non-descendant/symlink destination, fetch the remote
base explicitly, resolve its exact SHA, then create one branch/worktree. On
post-create validation failure, return a typed failure and retain the
worktree; do not remove a possibly useful diagnostic artifact. Keep all Git
parsing in this module and return narrow typed facts to workflow code.

- [ ] **Step 4: Run focused tests and server typecheck**

Run: `mise exec node@24.18.0 -- corepack pnpm vitest run apps/server/src/workspaces/git.test.ts && mise exec node@24.18.0 -- corepack pnpm --filter @wheelsparrow/server typecheck`

Expected: focused tests and the server typecheck pass.

- [ ] **Step 5: Commit the contained worktree boundary**

```bash
git add apps/server/src/workspaces/git.ts apps/server/src/workspaces/git.test.ts
git commit -m "feat(workspaces): prepare contained run worktrees"
```

## Task 2: Builder prompt and bounded process contract

**Files:**

- Create: `prompts/builder.md`
- Create: `apps/server/src/agents/builder.ts`
- Create: `apps/server/src/agents/builder.test.ts`

- [ ] **Step 1: Write failing prompt and process-contract tests**

```ts
const result = await runBuilder({
  command: fixtureCommand, model: "gpt-5.6-sol", reasoningEffort: "high",
  timeoutMs: 1_000, worktreePath, prompt: renderedPrompt,
});
expect(result).toMatchObject({ kind: "succeeded", terminal: { outcome: "completed" } });
await expect(runBuilder({ ...input, worktreePath: outsideWorktree }))
  .rejects.toThrow("worktree");
```

Prove the Markdown prompt contains role, goal, success criteria, worktree-only
constraint, allowed local tools, no GitHub/project/push/PR/merge/deploy
authority, sparse updates, validation evidence, and structured stop rules.
Render bounded, delimited untrusted issue context and compute a stable SHA-256
hash. With child fixtures, prove argument-array invocation, exact working
directory, bounded redacted stream capture, one valid JSON terminal event,
model/reasoning arguments, nonzero exit, missing/multiple/malformed terminal
events, spawn error, timeout, and process-tree termination classification.

- [ ] **Step 2: Run the focused test and observe the missing-module failure**

Run: `mise exec node@24.18.0 -- corepack pnpm vitest run apps/server/src/agents/builder.test.ts`

Expected: failure because the builder runner and prompt renderer do not exist.

- [ ] **Step 3: Implement the builder contract**

```ts
export const BuilderTerminalResultSchema = Type.Object({
  outcome: Type.Union([Type.Literal("completed"), Type.Literal("blocked")]),
  summary: Type.String({ minLength: 1, maxLength: 4096 }),
  validation: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 32 }),
  requested_action: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
}, { additionalProperties: false });

export async function runBuilder(input: BuilderInvocation): Promise<BuilderResult>;
```

Read only the repository-owned builder prompt, interpolate trusted facts and
bounded delimited untrusted context, and return its SHA-256 hash. Start the
configured command with explicit arguments in the validated worktree and no
shell. Reuse or extract the existing bounded process-group runner rather than
adding a framework. Parse newline-delimited JSON events, retain bounded
redacted logs, accept exactly one terminal event that passes TypeBox, and make
the exit/terminal combination explicit in a typed result. Do not add tokens,
GitHub commands, a second agent provider, reviewer/repair behavior, or direct
database writes.

- [ ] **Step 4: Run focused tests and type checking**

Run: `mise exec node@24.18.0 -- corepack pnpm vitest run apps/server/src/agents/builder.test.ts && mise exec node@24.18.0 -- corepack pnpm --filter @wheelsparrow/server typecheck`

Expected: focused tests and server typecheck pass.

- [ ] **Step 5: Commit the builder contract**

```bash
git add prompts/builder.md apps/server/src/agents/builder.ts apps/server/src/agents/builder.test.ts
git commit -m "feat(agents): run bounded builder processes"
```

## Task 3: Verification runner and durable execution dispatcher

**Files:**

- Create: `apps/server/src/workflow/execution.ts`
- Create: `apps/server/src/workflow/execution.test.ts`
- Modify: `apps/server/src/database/runs.ts`
- Modify: `apps/server/src/workflow/coordinator.ts` only to expose a typed, transaction-owned run/step update that cannot be expressed through an existing command
- Test: `tests/integration/database-and-coordinator.test.ts`

- [ ] **Step 1: Write failing effect-order and receipt tests**

```ts
const outcome = await executeClaimedRun({ coordinator, connection, workspaces, builder, verify, runId: "run-7" });
expect(outcome).toMatchObject({ kind: "ready_for_review", run: { state: "reviewing" } });
expect(order).toEqual(["workspace", "builder", "verify"]);
expect(await readRun(connection.db, "run-7")).toMatchObject({ baseSha, headSha, worktreePath, branch });
```

Use real migrated SQLite and deterministic workspace/builder/verification
seams. Prove each intent commits before its edge invocation, exact successful
receipts cause `preparing -> intaking -> building -> verifying -> reviewing`,
and the step row records prompt hash/model/reasoning/attempt/exit summary.
Prove workspace failure starts no builder; builder failure moves to `Review`
only after its one allowed attempt policy is exhausted; verification failure
uses the existing repairable/exhausted transitions without launching review or
repair; stale callbacks cannot advance state; ambiguous processes remain for
reconciliation; and an observed rerun does not duplicate workspace, builder,
or verification execution.

- [ ] **Step 2: Run the focused test and observe the missing-module failure**

Run: `mise exec node@24.18.0 -- corepack pnpm vitest run apps/server/src/workflow/execution.test.ts`

Expected: failure because `executeClaimedRun` does not exist.

- [ ] **Step 3: Implement the consumer-local execution service**

```ts
export async function executeClaimedRun(
  input: ExecuteClaimedRunInput,
): Promise<ExecutionOutcome>;

export function createExecutionCapability(
  input: ExecutionCapabilityInput,
): { dispatcher: EffectDispatcherLike; observer: EffectObserverLike };
```

Validate each effect intent structurally before dispatch. Submit all durable
state changes and step records through coordinator commands or one new
transaction-owned coordinator command; edge code does not import Kysely.
Create stable effect keys `run:<id>:workspace:prepare`,
`run:<id>:agent:builder:attempt:<n>`, and `run:<id>:verify:attempt:<n>`.
Persist the verified worktree/base/branch/head facts before the next effect.
Run the configured verification command with the same bounded process runner,
in the worktree, with `shell: false`; parse it only as a success/failure
receipt and retain bounded evidence. Observers inspect Git/process state and
fail closed when ownership or completion is not provable.

- [ ] **Step 4: Run focused integration tests**

Run: `mise exec node@24.18.0 -- corepack pnpm vitest run apps/server/src/workflow/execution.test.ts tests/integration/database-and-coordinator.test.ts`

Expected: focused workflow and storage tests pass.

- [ ] **Step 5: Commit the execution dispatcher**

```bash
git add apps/server/src/workflow/execution.ts apps/server/src/workflow/execution.test.ts apps/server/src/database/runs.ts apps/server/src/workflow/coordinator.ts tests/integration/database-and-coordinator.test.ts
git commit -m "feat(workflow): execute builder and verification effects"
```

## Task 4: Block-level verification and independent review

**Files:**

- Modify: `MVP_IMPLEMENTATION_LEDGER.md`
- Test: all changed focused suites

- [ ] **Step 1: Run the focused boundary, process, and workflow tests**

Run: `mise exec node@24.18.0 -- corepack pnpm vitest run apps/server/src/workspaces/git.test.ts apps/server/src/agents/builder.test.ts apps/server/src/workflow/execution.test.ts`

Expected: all focused tests pass with no skipped process/containment cases.

- [ ] **Step 2: Run the exact-head full gate and build**

Run: `mise exec node@24.18.0 -- make verify-agent && mise exec node@24.18.0 -- make build && git diff --check`

Expected: frozen install, formatting, Markdownlint, TypeScript, all tests,
diff hygiene, and server/web builds pass. Run unrestricted when the managed
sandbox suppresses detached-child output.

- [ ] **Step 3: Obtain independent requirements and quality/security reviews**

Provide fresh reviewers the design, complete plan, changed-file diff, exact
test evidence, and the Block 3 acceptance criteria. Repair every in-scope
finding with a failing regression test, then repeat the corresponding review.

- [ ] **Step 4: Record only verified evidence in the implementation ledger**

Update Block 2's merged PR/SHA and Block 3's branch, plan, exact-head test
counts, review state, and unresolved external constraints. Do not claim
publication, CI, merge, reviewer/repair, PR, UI, or staging behavior before
their blocks run.

- [ ] **Step 5: Commit verified evidence**

```bash
git add MVP_IMPLEMENTATION_LEDGER.md docs/superpowers/plans/2026-08-09-block-3-builder-workspaces.md
git commit -m "docs(ledger): record Block 3 evidence"
```
