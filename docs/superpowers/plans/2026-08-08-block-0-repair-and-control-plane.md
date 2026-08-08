# Block 0 Repair and Delivery Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stale programme controls with a complete requirement trace and exact resume
point, then remove the Block 0 process-cleanup test race while preserving command behavior except for
the approved cleanup-error precedence hardening.

**Architecture:** Root remains the sole owner of the requirements matrix, programme ledger,
integration, commits, publication, and merge. Read-only inventory workers may extract atomic
requirements from one normative document at a time; one bounded code worker may perform the TDD
repair. The production change is limited to an internal process-tree terminator extracted from
`runCommand`; successful cleanup, timeout details, platform routing, and the package-public API remain
unchanged, while cleanup errors are prevented from replacing the original caller result.

**Tech Stack:** Markdown, Git, GitHub pull requests and Actions, Node.js 24.18.0, pnpm 11.15.1,
strict TypeScript/ESM, Node child processes, Vitest, Biome, and Markdownlint CLI2.

---

## Working context and invariants

### Prime directive and engineering judgment

Build a system that reliably orchestrates and tracks agentic work through completion, with clear
operator visibility in a slick, clean UI. The documents and control artifacts serve that outcome;
checking boxes is not the outcome.

Before starting each task or accepting a requirement, root asks:

1. Does this make sense for the actual orchestration/visibility problem?
2. Is this what a knowledgeable software engineer would choose now?
3. If not, what smaller, safer, or clearer alternative advances the prime directive better?

Root briefly evaluates credible alternatives before proceeding. Harmful, conflicting, performative,
or disproportionate requirements receive an explicit matrix disposition and rationale rather than
ceremonial implementation. The ledger and matrix must remain enabling infrastructure; if maintaining
them starts consuming more effort than the decisions or recovery they support, simplify their
presentation without weakening traceability. The operator API/UI in row 6 and end-to-end completion
flow in rows 7-8 remain required product outcomes, not optional polish after a headless engine.

Work in `/home/jporc/wheelsparrow/.worktrees/block0-flake` on
`fix/block-0-process-test-flake`. The branch starts from protected `main` at
`81271c278c47a96e2882888e20c577449c5f69b8` and already contains these approved documentation
commits:

- `24e476f` — deterministic process-cleanup test design;
- `7db4ee1` — durable MVP delivery-control design.

The existing root checkout is stale and contains preserved user work. Do not edit, clean, reset, or
use it as an implementation base. Verify remote state before publication because GitHub evidence can
advance independently of this plan.

The root orchestrator owns control-artifact writes, integration, every commit, push, PR, merge,
ledger entry, matrix disposition, and completion claim. Builders and reviewers receive explicit read
or bounded code-write scopes and report evidence; they do not edit `MVP_IMPLEMENTATION_LEDGER.md` or
`docs/delivery/MVP_REQUIREMENTS_MATRIX.md`. Do not create a second backlog, workpad, queue, or agent
ledger.

Use a fresh Luna-designated subagent at xhigh reasoning for each bounded code sub-block and for its
independent specification and quality reviews. Give each implementer one explicit writable scope,
full task text, acceptance criteria, and verification commands. The root inspects and integrates the
result before any commit. Mechanical document inventory may use lower effort, but root must verify
every returned row; agents may propose matrix or ledger text but must not write either authority.

Before every durable checkpoint, root checks off every completed step in this plan, updates the
ledger resume point and exact evidence, verifies the diff, and includes the plan plus ledger in the
same commit as the checkpointed work. Therefore a clean resumable branch must satisfy:

```bash
test "$(git rev-parse HEAD)" = "$(git log -1 --format=%H -- MVP_IMPLEMENTATION_LEDGER.md)"
```

The exact current HEAD is resolved by that invariant; the ledger also records the exact parent/content
SHA observed before its state edit. No file attempts to embed its own recursively changing commit SHA.

All Node, pnpm, and Make verification runs under the installed pinned runtime. First prove it:

```bash
mise exec node@24.18.0 -- node --version
mise exec node@24.18.0 -- corepack pnpm --version
```

Expected: Node `v24.18.0` and pnpm `11.15.1`. Every later `corepack pnpm ...` or `make ...` command
in this plan is executed with the `mise exec node@24.18.0 --` prefix even where the shorter command
is shown for readability. Exact-toolchain failures are real failures, not warnings to ignore.

This slice owns these outcomes:

1. complete traceability for the normative documents;
2. a truthful eight-row merge train and cold-start resume point;
3. deterministic coverage of Block 0 process-group cleanup;
4. independent specification and quality review;
5. exact-head PR/CI and protected-main evidence; and
6. a clean handoff to a fresh Block 1A worktree.

The requirement IDs owned by the code repair are assigned while completing Task 2. The control-plane
documents trace the programme; they do not silently prove product requirements. This plan and the
truthful ledger bootstrap form the first durable checkpoint; do not create a plan-only commit that
would leave the committed ledger stale.

## Owned requirement IDs

Control-plane traceability and recovery:

- `SPEC-00-001`
- `SPEC-00-002`
- `CICD-00-001`
- `CICD-02-008`
- `CICD-12-001`

Existing Block 0 foundation evidence updated by this slice:

- `SPEC-01-001`
- `SPEC-03-001`
- `SPEC-03-003`
- `SPEC-03-004`
- `SPEC-03-005`
- `SPEC-10-001`
- `STACK-01-001`
- `STACK-01-002`
- `STACK-01-003`
- `STACK-01-004`
- `STACK-01-005`
- `STACK-01-006`
- `STACK-02-004`
- `STACK-08-001`
- `STACK-08-002`
- `STACK-08-003`
- `STACK-08-009`
- `STACK-09-001`
- `STACK-09-003`
- `STACK-09-006`

Subprocess timeout and process-tree cleanup:

- `SPEC-11-006`
- `STACK-05-003`
- `CICD-11-003`

CI, review, publication, and exact-revision evidence for this slice:

- `CICD-01-001`
- `CICD-01-007`
- `CICD-02-003`
- `CICD-03-002`
- `CICD-03-003`
- `CICD-03-004`
- `CICD-03-006`
- `CICD-04-001`
- `CICD-04-002`
- `CICD-04-004`
- `CICD-04-005`
- `CICD-04-006`
- `CICD-05-003`
- `CICD-08-001`
- `CICD-08-002`
- `CICD-08-004`

## Task 1: Bootstrap the truthful programme ledger

**Files:**

- Read: `docs/superpowers/specs/2026-08-08-mvp-delivery-control-design.md`
- Modify: `MVP_IMPLEMENTATION_LEDGER.md`

- [x] **Step 1: Reconcile the starting point**

Read the existing goal and confirm it remains the full MVP objective. Run:

```bash
git status --short --branch
git log --oneline --decorate -8
git rev-parse HEAD
git rev-parse github/main
git merge-base --is-ancestor 81271c278c47a96e2882888e20c577449c5f69b8 HEAD
```

Use the connected GitHub integration to re-read current remote `main`, PR #25's merged state and
merge SHA, its exact post-merge CI/main-artifact runs, and any existing PR for this branch. Repository
and GitHub facts outrank stale ledger text.

If live `main` differs from `81271c278c47a96e2882888e20c577449c5f69b8`, stop before inventory.
Fetch the exact live ref, use the `pull` skill to merge it into this branch, and inspect every change
to `SPEC.md`, `ARCHITECTURE.md`, `TECH_STACK.md`, or `CICD.md`. Re-read changed normative sections,
rerun the plan review where behavior or ownership changed, and record the new exact authoritative
base. Do not build a matrix against a stale blob merely because the old SHA remains an ancestor.

- [x] **Step 2: Install the approved merge train and active resume point**

Set the authoritative base to the live protected-main SHA, initially expected to be
`81271c278c47a96e2882888e20c577449c5f69b8`. Replace the stale B0-B8 operational table with the
approved eight-row merge train and all required columns: order, outcome, dependencies, status,
worktree/branch, plan, PR, and merge SHA. Row 1 is `in_progress`; rows 2-8 are `pending`. PR #25 is
the merged foundation predecessor, not unfinished row-1 work.

Add the prime directive and three-question engineering-judgment gate above to the ledger's binding
programme decisions so every cold-start orchestrator applies it before reading the work queue.

Replace the stale resume point with:

- active slice: row 1;
- worktree: `/home/jporc/wheelsparrow/.worktrees/block0-flake`;
- branch: `fix/block-0-process-test-flake`;
- observed HEAD before this ledger edit;
- expected checkout invariant: current HEAD equals the latest commit touching this ledger, resolved
  with the exact `git log`/`git rev-parse` comparison above;
- active plan: this file;
- current checkbox: Task 2 Step 1;
- last exact verification result;
- next safe command: `git status --short --branch` followed by the Task 2 inventory commands;
- owner: root orchestrator;
- blocker: `none` unless live evidence establishes one.

Link the approved delivery-control and process-cleanup designs. Link the planned matrix path and mark
it `not yet created`; that is a truthful current fact, not a placeholder.

- [x] **Step 3: Preserve evidence and retire duplicate operational state**

Do not alter historical evidence rows. Append live PR #25 merge/post-merge facts, design commit
`7db4ee1`, this plan's observed pre-commit HEAD, and its lint/diff verification. Rename `SDLC Stage
Ledger` to `Historical setup checklist` and state that its existing checkboxes are immutable history,
not current status or order. Remove resolved PR #25 approval risks while preserving genuine sandbox,
legacy-checkout, issue, ruleset, live-smoke, and external-staging risks.

- [x] **Step 4: Verify and commit the bootstrap checkpoint**

Run:

```bash
corepack pnpm markdownlint-cli2 MVP_IMPLEMENTATION_LEDGER.md docs/superpowers/specs/2026-08-08-mvp-delivery-control-design.md docs/superpowers/plans/2026-08-08-block-0-repair-and-control-plane.md
git diff --check
git diff -- MVP_IMPLEMENTATION_LEDGER.md
git status --short
```

Expected: one merge train, one current resume point, append-only history, and no duplicate operational
checklist. Root checks Task 1's completed boxes, stages the ledger and this plan, and commits:

```text
docs(delivery): bootstrap current MVP resume point
```

The committed ledger records the exact observed parent/content SHA, not its mathematically
self-referential own SHA. The next cold start verifies that HEAD is the latest commit touching the
ledger.

## Task 2: Create the complete requirements matrix

**Files:**

- Read: `SPEC.md`
- Read: `ARCHITECTURE.md`
- Read: `TECH_STACK.md`
- Read: `CICD.md`
- Read: `docs/superpowers/specs/2026-08-08-mvp-delivery-control-design.md`
- Create: `docs/delivery/MVP_REQUIREMENTS_MATRIX.md`
- Modify after assigning IDs: this plan

- [x] **Step 1: Verify the normative source and branch before inventory**

Run:

```bash
git status --short --branch
git rev-parse HEAD
git merge-base --is-ancestor 81271c278c47a96e2882888e20c577449c5f69b8 HEAD
for file in SPEC.md ARCHITECTURE.md TECH_STACK.md CICD.md; do
  printf '%s\n' "$file"
  rg -n '^#{1,4} ' "$file"
done
```

Expected: the worktree is on `fix/block-0-process-test-flake`, only this plan or later planned files
are uncommitted, the authoritative base is an ancestor, and every stable heading is visible.

Immediately re-read live protected `main` through the connected GitHub integration and require its
SHA to equal the local authoritative ref merged during Task 1. If it differs, return to Task 1's drift
procedure: fetch and merge the exact ref, inspect and re-read changed normative blobs, re-review the
plan where needed, and only then restart the inventory. Do not change only the displayed source SHA.

- [x] **Step 2: Dispatch bounded read-only inventory workers**

Use lower-effort workers for mechanical extraction. Run at most three concurrently; after one
finishes, dispatch the fourth. Assign exactly one source to each worker:

1. `SPEC.md`;
2. `ARCHITECTURE.md`;
3. `TECH_STACK.md`;
4. `CICD.md`.

Provide this complete contract to each worker:

```text
Read only the assigned normative document. Do not edit files. Return proposed atomic matrix rows in
source order with: source heading, normalized obligation, proposed disposition, rationale when not
implement, merge-train owner 1-8, required proof, and current exact evidence or missing. Extract all
normative behavior, boundaries, non-goals, prohibited structures, validation duties, delivery duties,
and evidence duties—not only uppercase RFC 2119 sentences. Split independently falsifiable clauses.
Do not claim proved from indirect evidence. Flag conflicts and harmful requirements; do not resolve
them. Do not assign final IDs. End with a coverage checklist of every heading read.
```

Workers return text only. Root checks every proposed row against the source, decides all
dispositions, assigns IDs, resolves duplicate obligations without losing source references, and
writes the matrix.

- [x] **Step 3: Write the matrix header, schema, and interpretation rules**

Create `docs/delivery/MVP_REQUIREMENTS_MATRIX.md` with this opening structure:

```markdown
# Wheelsparrow MVP Requirements Matrix

Updated: 2026-08-08

Authoritative source revision: `81271c278c47a96e2882888e20c577449c5f69b8`

This matrix is the complete trace from the four normative MVP documents to implementation and
evidence. It is not a work queue; delivery order and the active resume point live only in
`MVP_IMPLEMENTATION_LEDGER.md`.

## Interpretation

- IDs are repository-owned and remain stable after assignment.
- Sources use document and heading names, never line numbers.
- One row contains one independently falsifiable obligation.
- `implement` requires no rationale; `rejected`, `external_deferred`, and `conflict` require one.
- Allowed statuses are `pending`, `partial`, `proved`, and `unavailable`.
- `proved` requires direct evidence bound to an exact revision. Indirect or incomplete evidence is
  `partial`; locally achievable work not yet evidenced is `pending` with `missing` evidence.
- `unavailable` requires a named external target, credential, authority, or human action, plus exact
  evidence that every locally achievable part of the contract has been proved.
- A requirement can need several proof types. Every required proof must exist before `proved`.
- Repository and GitHub evidence outrank this matrix when they disagree.

## Requirements

| ID | Source | Requirement | Disposition | Rationale | Delivery slice | Required proof | Current evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
```

Replace the shown source revision with the exact protected-main SHA verified and merged during Task 1
if it changed. The matrix revision must identify the commit whose four normative blobs were actually
read.

- [x] **Step 4: Integrate atomic rows in source order**

Use these prefixes and section-number rules:

- `SPEC-00-001`, `ARCH-00-001`, `STACK-00-001`, and `CICD-00-001` for obligations before section 1;
- `SPEC-01-001`, `SPEC-01-002`, and so on;
- `ARCH-01-001`, `ARCH-01-002`, and so on;
- `STACK-01-001`, `STACK-01-002`, and so on;
- `CICD-01-001`, `CICD-01-002`, and so on.

Use the major numbered section in the ID. Continue its ordinal through subsections, while the Source
column names the exact stable subsection heading. Do not renumber an assigned ID later merely because
a new row is inserted; allocate the next unused ordinal and keep source order through placement.

Root must check the following cases explicitly:

- introductory authority and conflict rules;
- every “must”, “must not”, “should”, “may”, imperative list item, state-transition condition, and
  proof condition;
- explicit non-goals and prohibited structures;
- configuration, credential, security, process, and filesystem boundaries;
- state, durable intent, receipt, reconciliation, retry, and exact-revision invariants;
- every required UI view and operator action;
- testing, prompt-contract, integration, E2E, CI, artifact, retention, and adoption requirements;
- deferred external staging/live-smoke evidence with the missing target or authority named;
- any requirement whose implementation would harm the local-first SDLC-orchestrator outcome.

The Delivery slice column contains only the owning merge-train row number from
`MVP_IMPLEMENTATION_LEDGER.md`; do not restate the ordered outcomes in this matrix.

For existing Block 0 behavior, use exact evidence already recorded in the ledger only when the row's
full required proof is present. Mark evidence `partial` when local code/tests exist but exact current
review, CI, main, artifact, runtime, or conformance evidence is missing. PR #25's merged evidence
belongs to its exact merge SHA; it does not prove later code on this branch.

- [x] **Step 5: Link this plan to its exact row-1 requirement IDs**

After assigning all matrix IDs, add a `## Owned requirement IDs` section immediately before
`## Task 1`. List every exact ID owned by merge-train row 1 and group them as:

- control-plane traceability and recovery;
- existing Block 0 foundation evidence updated by this slice;
- subprocess timeout and process-tree cleanup;
- CI, review, publication, and exact-revision evidence for this slice.

Do not copy requirement prose into the plan. The list is an exact link to matrix rows, not a second
matrix. Confirm every listed ID exists and every matrix row with Delivery slice `1` appears once.

- [x] **Step 6: Perform root coverage and consistency review**

Run:

```bash
rg -n '^#{1,4} ' SPEC.md ARCHITECTURE.md TECH_STACK.md CICD.md
rg -n '\b(MUST|MUST NOT|SHOULD|SHOULD NOT|MAY)\b' SPEC.md ARCHITECTURE.md TECH_STACK.md CICD.md
rg -n '^\| (SPEC|ARCH|STACK|CICD)-' docs/delivery/MVP_REQUIREMENTS_MATRIX.md
rg -n '\| (rejected|external_deferred|conflict) \| *\|' docs/delivery/MVP_REQUIREMENTS_MATRIX.md
rg -n '\| proved \|' docs/delivery/MVP_REQUIREMENTS_MATRIX.md
corepack pnpm markdownlint-cli2 docs/delivery/MVP_REQUIREMENTS_MATRIX.md
git diff --check
```

Expected:

- every source heading has one or more reviewed rows or an explicit note explaining why it contains
  no obligation;
- IDs are unique and source ordered;
- the empty-rationale search returns no matches;
- every `proved` row carries exact direct evidence satisfying every proof type;
- Markdownlint and diff hygiene pass.

Manually compare the complete matrix to all four source files; the keyword scan is only a backstop.
Record the final row counts by prefix for the ledger checkpoint.

- [x] **Step 7: Root prepares the matrix for the combined ledger checkpoint**

Run:

```bash
git diff --no-index -- /dev/null docs/delivery/MVP_REQUIREMENTS_MATRIX.md
git diff -- docs/superpowers/plans/2026-08-08-block-0-repair-and-control-plane.md
git status --short
```

Expected: the no-index command displays the entire new matrix and exits `1` because content differs
from `/dev/null`; the normal diff displays this plan's exact ID linkage. Only those two files plus the
planned ledger update may be changed. Do not commit yet: Task 3 records the matrix counts and resume
point, then root commits matrix, plan, and ledger together so the cold-start invariant remains true.

## Task 3: Finalize the ledger with matrix evidence

**Files:**

- Read: `docs/delivery/MVP_REQUIREMENTS_MATRIX.md`
- Read: `docs/superpowers/specs/2026-08-08-mvp-delivery-control-design.md`
- Read: `docs/superpowers/specs/2026-08-07-block-0-process-test-flake-design.md`
- Modify: `MVP_IMPLEMENTATION_LEDGER.md`

- [x] **Step 1: Reconcile repository and GitHub facts before writing**

Run locally:

```bash
git status --short --branch
git log --oneline --decorate -8
git rev-parse HEAD
git rev-parse github/main
git merge-base --is-ancestor "$(git rev-parse github/main)" HEAD
```

Use the connected GitHub integration to verify:

- default branch and current remote `main` SHA;
- PR #25 merged state, merge SHA, and URL;
- exact post-merge CI and main-artifact workflow conclusions for that SHA;
- any open PR already using `fix/block-0-process-test-flake`.

If live GitHub evidence differs from the values below, use the live facts and explain the correction
in a new evidence-log row. Do not rewrite historical rows. If protected `main` advanced since Task 2,
do not finalize or merely relabel the matrix: return to Task 1's drift procedure, merge the exact ref,
re-read changed normative blobs, regenerate/revalidate affected rows and exact evidence, and repeat
the complete matrix coverage review before this combined checkpoint.

- [x] **Step 2: Confirm the authority and merge train, then link the matrix**

Set the authoritative base to current protected `main`, initially expected to be
`81271c278c47a96e2882888e20c577449c5f69b8`. Link the approved delivery-control design and the new
requirements matrix.

Confirm the bootstrap checkpoint contains exactly this merge train:

| Order | Outcome | Depends on | Status at this checkpoint |
| --- | --- | --- | --- |
| 1 | Deterministic Block 0 process-cleanup repair and control-plane setup | PR #25 foundation | `in_progress` |
| 2 | SQLite storage, migrations, and single-process ownership | 1 | `pending` |
| 3 | Canonical state, serialized coordinator, durable effects, and restart recovery | 2 | `pending` |
| 4 | GitHub discovery and claim through a verified local candidate | 3 | `pending` |
| 5 | Independent review, bounded repair, publication, exact-head CI, and Review handoff | 4 | `pending` |
| 6 | Operator API and browser controls | 3 and stable read contract | `pending` |
| 7 | Exact-SHA approval, merge, staging, smoke, and Done transition | 5 and 6 | `pending` |
| 8 | Integration, security, artifact, and requirement-conformance closure | 7 | `pending` |

Give every row all fields required by the approved design: order, outcome, dependencies, status,
worktree/branch, current plan, PR, and merge SHA. Use `—` only when the item does not yet exist.
Record PR #25 as the merged foundation predecessor, not as unfinished row 1 work. Replace the
matrix's `not yet created` fact with its exact path, source revision, SHA-256 content hash, and row
counts. Compute the hash before the combined commit with
`sha256sum docs/delivery/MVP_REQUIREMENTS_MATRIX.md`; do not invent a self-referential checkpoint SHA.

- [x] **Step 3: Replace the stale resume point**

The resume point must state:

- authoritative remote `main`: the live verified SHA;
- active slice: row 1;
- active worktree: `/home/jporc/wheelsparrow/.worktrees/block0-flake`;
- branch: `fix/block-0-process-test-flake`;
- observed HEAD before the ledger edit: the exact checkpoint just committed;
- expected current HEAD: `the commit containing this resume point`, resolved and checked with
  `git rev-parse HEAD` during the cold-start protocol;
- current plan: this file;
- current checkbox: the first unchecked step after the ledger checkpoint;
- last verification: exact command, result, and SHA;
- next safe command: the precise focused RED-test command from Task 4;
- current owner: root orchestrator, with the next bounded code worker named only while active;
- blocker: `none` unless a real external blocker exists.

State that the next safe action is to modify only `scripts/preflight.test.ts`, then run:

```bash
corepack pnpm vitest run scripts/preflight.test.ts -t "terminates a ready detached process group" --pool=threads --maxWorkers=1
```

- [x] **Step 4: Preserve history and append current facts**

Keep every old evidence row intact. Append rows for:

- PR #25 merge URL and exact merge SHA;
- exact post-merge CI and main-artifact evidence;
- the delivery-control design commit `7db4ee1`;
- the matrix source revision, SHA-256 content hash, and row counts;
- this ledger correction and its verification.

Rename the existing `SDLC Stage Ledger` to `Historical setup checklist` and state explicitly that it
is immutable historical evidence, not current programme status or delivery order. Preserve every
existing checkbox value. The merge train and resume point are the only operational ordering and
current-state authorities.

Update open risks to remove resolved PR #25 approval claims. Preserve still-current risks about the
managed sandbox, legacy root checkout, superseded issues, GitHub rules, disposable live-smoke target,
and external staging target. Add no speculative blocker.

- [x] **Step 5: Verify the cold-start contract**

Run:

```bash
corepack pnpm markdownlint-cli2 MVP_IMPLEMENTATION_LEDGER.md docs/delivery/MVP_REQUIREMENTS_MATRIX.md docs/superpowers/specs/2026-08-08-mvp-delivery-control-design.md docs/superpowers/plans/2026-08-08-block-0-repair-and-control-plane.md
git diff --check
git diff -- MVP_IMPLEMENTATION_LEDGER.md
git status --short
```

Expected: lint and diff hygiene pass; the ledger has one merge train and one unambiguous resume
point; a cold-start worker can name the current branch, HEAD, task, last proof, and next command
without conversation history.

- [x] **Step 6: Root creates the truthful-ledger checkpoint**

Root checks every completed Task 2 and Task 3 box, stages
`MVP_IMPLEMENTATION_LEDGER.md`, `docs/delivery/MVP_REQUIREMENTS_MATRIX.md`, and this plan, then
commits:

```text
docs(delivery): trace requirements and current resume point
```

Do not attempt to embed this ledger commit's own SHA in its contents: changing the file would create
a different SHA forever. The committed resume point instead records the exact observed parent/content
SHA and requires current HEAD to equal the latest commit touching the ledger. The next cold start
verifies that invariant, ancestry, and the working tree before acting.

## Task 4: Reproduce the process-cleanup race with a deterministic test

**Files:**

- Modify: `scripts/preflight.test.ts`
- Do not modify: `scripts/preflight.ts`

- [ ] **Step 1: Give one bounded code worker the test-only RED scope**

Use a capable worker because subprocess containment is timing- and platform-sensitive. Provide the
approved process-cleanup design, the exact test steps below, and write permission only for
`scripts/preflight.test.ts`. The worker must not edit the matrix, ledger, plan, production code, or
commit. It must report the diff and exact RED output.

- [ ] **Step 2: Add a compilable wished-for helper probe**

Import the child-process type and Vitest spy support, then load the preflight module as a namespace:

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";

import * as preflightModule from "./preflight.js";

const { evaluatePreflight, formatCheck, runCommand } = preflightModule;
const terminateProcessTree = Reflect.get(
  preflightModule,
  "terminateProcessTree",
) as unknown;
```

This keeps the test module loadable before the export exists. Do not create the production export yet.

- [ ] **Step 3: Separate timeout behavior from group cleanup behavior**

Replace both existing process-timeout tests with three focused contracts. First, retain a
platform-independent API timeout test without a readiness file:

```typescript
test("reports a hanging command timeout promptly", async () => {
  const startedAt = Date.now();

  const result = await runCommand(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)"],
    { timeoutMs: 150 },
  );

  expect(result).toEqual({ ok: false, detail: "timed out after 150ms" });
  expect(Date.now() - startedAt).toBeLessThan(700);
});
```

Second, a POSIX-only API integration test starts `runCommand` with a generously bounded 2,000 ms
timeout, condition-waits for descendant readiness for at most 1,000 ms, then proves timeout detail and
descendant cleanup:

```typescript
test.skipIf(process.platform === "win32")(
  "times out a ready process group through runCommand",
  async () => {
  const root = await temporaryRoot();
  const pidFile = join(root, "descendant.pid");
  const startedAt = Date.now();
  const script = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'],",
    "  { stdio: ['ignore', process.stdout, process.stderr] });",
    "writeFileSync(process.argv[1], String(child.pid));",
    "setTimeout(() => {}, 10000);",
  ].join("\n");
  const resultPromise = runCommand(process.execPath, ["-e", script, pidFile], {
    timeoutMs: 2000,
  });
  let descendantPid: number | undefined;

  try {
    descendantPid = await waitForPidFile(pidFile);
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, detail: "timed out after 2000ms" });
    expect(Date.now() - startedAt).toBeLessThan(2700);
    expect(await waitForProcessExit(descendantPid)).toBe(true);
  } finally {
    if (descendantPid !== undefined && processExists(descendantPid)) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Best-effort test cleanup.
      }
    }
  }
  },
);
```

This is wiring coverage: it fails if `runCommand` kills only the leader instead of invoking group
cleanup. The direct test below is the deterministic correctness proof. The 2,000 ms integration
window is not used as evidence that group cleanup itself works and does not preserve the old 80 ms
startup race.

The POSIX-only test starts the real detached fixture directly, waits for readiness, calls the real
terminator, and proves leader plus descendant exit:

```typescript
test.skipIf(process.platform === "win32")(
  "terminates a ready detached process group",
  async () => {
    expect(terminateProcessTree).toBeTypeOf("function");
    if (typeof terminateProcessTree !== "function") return;

    const root = await temporaryRoot();
    const pidFile = join(root, "descendant.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'],",
      "  { stdio: 'ignore' });",
      "writeFileSync(process.argv[1], String(child.pid));",
      "setTimeout(() => {}, 10000);",
    ].join("\n");
    const leader = spawn(process.execPath, ["-e", script, pidFile], {
      detached: true,
      stdio: "ignore",
    });

    try {
      const leaderPid = leader.pid;
      if (leaderPid === undefined) {
        throw new Error("detached process fixture did not start");
      }
      const descendantPid = await waitForPidFile(pidFile);

      terminateProcessTree(leader);

      expect(await waitForProcessExit(leaderPid)).toBe(true);
      expect(await waitForProcessExit(descendantPid)).toBe(true);
      expect(() => terminateProcessTree(leader)).not.toThrow();
    } finally {
      terminateProcessTree(leader);
    }
  },
);
```

Import `spawn` from `node:child_process`. Add this condition-based readiness helper near the existing
process helpers:

```typescript
async function waitForPidFile(file: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number(await readFile(file, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("timed out waiting for detached process fixture readiness");
}
```

Add `vi.restoreAllMocks()` to the existing `afterEach` cleanup. Before production code exists, add
the Windows-routing and cleanup-error tests below. Each starts with the same RED assertion/probe:

```typescript
test("uses direct child termination on Windows", () => {
  expect(terminateProcessTree).toBeTypeOf("function");
  if (typeof terminateProcessTree !== "function") return;
  const kill = vi.fn(() => true);
  const child = { pid: 1234, kill } as unknown as ChildProcess;

  terminateProcessTree(child, "win32");

  expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
});

test.skipIf(process.platform === "win32")(
  "does not let cleanup errors replace the caller result",
  () => {
    expect(terminateProcessTree).toBeTypeOf("function");
    if (typeof terminateProcessTree !== "function") return;
    const groupKill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("group cleanup failed");
    });
    const fallbackKill = vi.fn(() => {
      throw new Error("fallback cleanup failed");
    });
    const child = {
      pid: 1234,
      kill: fallbackKill,
    } as unknown as ChildProcess;

    expect(() => terminateProcessTree(child)).not.toThrow();
    expect(groupKill).toHaveBeenCalledWith(-1234, "SIGKILL");
    expect(fallbackKill).toHaveBeenCalledWith("SIGKILL");
  },
);
```

Keep exactly one API-level timeout/group-wiring test and one direct group-cleanup test. Cleanup
remains in `finally` so a failed assertion does not leak processes.

- [ ] **Step 4: Run RED and inspect the failure**

Run:

```bash
corepack pnpm tsc -p tsconfig.tests.json --noEmit
corepack pnpm vitest run scripts/preflight.test.ts -t "times out a ready process group through runCommand" --pool=threads --maxWorkers=1
corepack pnpm vitest run scripts/preflight.test.ts -t "terminates a ready detached process group|uses direct child termination on Windows|does not let cleanup errors replace the caller result" --pool=threads --maxWorkers=1
```

Expected: TypeScript passes; the API-wiring characterization passes against the pre-refactor nested
termination logic; then on POSIX all three missing-helper tests fail their `toBeTypeOf("function")`
assertions. On Windows the platform-applicable missing-helper test fails and the POSIX-only tests
skip. Failures must be assertions—not transform, import, syntax, type, readiness, or cleanup errors.
Save the exact baseline pass and RED output in the worker report and ledger before production changes.

- [ ] **Step 5: Root reviews the RED diff and evidence**

Run:

```bash
git diff -- scripts/preflight.test.ts
git status --short
```

Expected: only test code changed; the new direct test has bounded readiness, POSIX gating, a real
detached group, both exit assertions, repeated-call tolerance, and best-effort cleanup. Root does not
commit the deliberately red state.

## Task 5: Extract the internal terminator and reach GREEN

**Files:**

- Modify: `scripts/preflight.ts`
- Verify: `scripts/preflight.test.ts`

- [ ] **Step 1: Give the same bounded worker the minimal GREEN scope**

Provide write permission for `scripts/preflight.ts` and the import/probe cleanup plus focused contract
tests in `scripts/preflight.test.ts`. Require the exact helper contract below, no successful-path or
timeout-detail change, no package-public API change, no unrelated refactor, and no commit.

- [ ] **Step 2: Add the child-process type and internal helper**

Change the import to:

```typescript
import { spawn, type ChildProcess } from "node:child_process";
```

Add this helper immediately before `runCommand`:

```typescript
export function terminateProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
): void {
  if (child.pid === undefined) return;
  try {
    if (platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best-effort cleanup must not replace the original command failure.
    }
  }
}
```

The optional platform argument is part of this internal test seam, not the package-public product
API. The nested fallback catch intentionally enforces the approved causal contract: best-effort
cleanup failure must not replace or prevent the original timeout/command result. This hardens an
edge case in the current local implementation without changing the successful cleanup path or
timeout detail.

Replace the temporary namespace/reflection probe in `scripts/preflight.test.ts` with a normal named
import of `terminateProcessTree` after the export exists.

Replace the nested `terminate` function in `runCommand` with a call to
`terminateProcessTree(child)` in the existing timeout callback. Preserve:

- `DEFAULT_DIAGNOSTIC_TIMEOUT_MS` and caller-supplied timeout semantics;
- detached POSIX spawning and the Windows non-detached path;
- argument-array execution with `shell: false`;
- output bounds, redaction, and error/close handling;
- the existing `CommandResult` and `runCommand` public contract.

- [ ] **Step 3: Clean the RED probes after adding the export**

Replace the temporary namespace/reflection access with the normal named import. Do not add new tests
after production code: the direct-group, Windows-routing, and cleanup-error contracts were present
and observed RED in Task 4. The `runCommand` wiring characterization was also present and passed before
the refactor, providing the behavioral baseline it must continue to satisfy.

- [ ] **Step 4: Run GREEN for the direct test**

Run:

```bash
corepack pnpm vitest run scripts/preflight.test.ts -t "terminates a ready detached process group" --pool=threads --maxWorkers=1
```

Expected: one test passes on POSIX; on Windows it is reported skipped. Both spawned processes are
gone after the test.

- [ ] **Step 5: Run the complete focused file**

Run:

```bash
corepack pnpm vitest run scripts/preflight.test.ts --pool=threads --maxWorkers=1
```

Expected: every preflight test passes with no unhandled rejection, leaked handle, missing PID file,
or changed timeout detail.

- [ ] **Step 6: Root inspects and checkpoints the minimal repair**

Run:

```bash
git diff -- scripts/preflight.ts scripts/preflight.test.ts
git diff --check
corepack pnpm biome check scripts/preflight.ts scripts/preflight.test.ts
corepack pnpm tsc -p tsconfig.tests.json --noEmit
```

Expected: the code diff contains only the internal helper extraction and deterministic tests; all
checks pass. Root updates the ledger resume point, checks completed plan boxes, stages both code files,
the ledger, and this plan, then commits:

```text
test(preflight): make process cleanup deterministic
```

Do not mutate the ledger immediately after this commit merely to insert the commit's own SHA. Task 6
first observes the exact code-checkpoint SHA with `git rev-parse HEAD`, runs repetition/full gates at
that SHA, and records the SHA plus results in its next explicit ledger/plan evidence checkpoint.

## Task 6: Prove repeatability and the complete local gate

**Files:**

- Modify: `MVP_IMPLEMENTATION_LEDGER.md`
- Update checkboxes: this plan

- [ ] **Step 1: Repeat the direct regression test 25 times**

Run on a POSIX host outside a managed sandbox that suppresses detached-child I/O:

```bash
mise exec node@24.18.0 -- make verify-toolchain
for run in $(seq 1 25); do
  mise exec node@24.18.0 -- corepack pnpm vitest run scripts/preflight.test.ts -t "terminates a ready detached process group" --pool=threads --maxWorkers=1 || exit 1
done
```

Expected: the exact toolchain check passes, followed by 25 consecutive test passes with both leader
and descendant terminated on every run. Record the host context, command, count, exact HEAD, and
result.

- [ ] **Step 2: Repeat the whole focused file 25 times**

Run:

```bash
for run in $(seq 1 25); do
  corepack pnpm vitest run scripts/preflight.test.ts --pool=threads --maxWorkers=1 || exit 1
done
```

Expected: 25 consecutive file-level passes and no fixture readiness failure.

- [ ] **Step 3: Run the full repository gates**

Run:

```bash
corepack pnpm vitest run --pool=threads --maxWorkers=1
make verify-agent
make build
make smoke-production
git diff --check
```

Expected: the explicit single-worker full suite, exact toolchain verification, frozen install, lint,
type check, the normal full test suite, build, production lifecycle smoke, and diff hygiene all pass
at the same HEAD.

- [ ] **Step 4: Update direct matrix evidence and the ledger**

Update the process-cleanup requirement row or rows with the exact repair SHA and commands. Keep
status `partial` if independent review, PR CI, protected-main, or artifact proof is still required.

Append ledger evidence for:

- the observed RED failure;
- 25/25 direct-test repetition;
- 25/25 focused-file repetition;
- the explicit single-worker full-suite result;
- `make verify-agent`;
- `make build`;
- `make smoke-production`.

Set the resume point to Task 7 specification review, including exact HEAD and last verification.
Run Markdownlint and `git diff --check`. Root checks completed Task 6 boxes, stages the ledger,
matrix, and this plan, then commits the evidence-only changes:

```text
docs(delivery): record Block 0 repair evidence
```

## Task 7: Complete two-stage independent review and repairs

**Files:**

- Read: the complete branch diff from `81271c278c47a96e2882888e20c577449c5f69b8`
- Modify when findings are accepted: `scripts/preflight.test.ts` first, then the narrow affected file
- Modify: `MVP_IMPLEMENTATION_LEDGER.md`
- Modify only for exact evidence/status: `docs/delivery/MVP_REQUIREMENTS_MATRIX.md`

- [ ] **Step 1: Run fresh specification-compliance review**

Dispatch a fresh high-capability, read-only reviewer with:

- both approved design documents;
- this plan's requirements;
- the exact base and current head SHAs;
- the raw diff and verification evidence.

The reviewer must verify line by line that:

- the matrix covers the four normative sources and does not overclaim proof;
- the ledger has one truthful merge train and resume point;
- the repair eliminates readiness coupling rather than increasing a timeout;
- `runCommand` successful behavior, timeout details, and platform routing remain unchanged except for
  the approved rule that cleanup errors cannot replace the original result;
- no product or public API scope was added;
- no required item or evidence gate is missing.

Expected report: `SPEC COMPLIANT`, or exact findings with file and line references. Do not begin
quality review while a specification finding remains open.

- [ ] **Step 2: Repair accepted specification findings with TDD**

Root triages every finding. For an accepted behavior defect, first add a focused regression test and
observe the expected RED failure, then make the smallest production change, run GREEN, and rerun the
focused/full gates. Documentation-only inaccuracies receive direct evidence-backed corrections.
Return the same reviewer to each repair until it reports `SPEC COMPLIANT`.

- [ ] **Step 3: Run fresh code and document quality review**

Only after specification approval, dispatch:

1. a strong read-only reviewer for subprocess correctness, cleanup, portability, error masking,
   test determinism, and scope;
2. a lower-effort read-only traceability reviewer for duplicate/missing IDs, dispositions,
   rationale, exact evidence, merge-train consistency, and cold-start clarity.

Root validates every finding against the files. Accepted code findings follow RED-GREEN-REFACTOR;
accepted document findings are corrected with their validating command. Re-review until no Critical
or Important findings remain and every Minor finding is fixed or explicitly rejected with rationale.

- [ ] **Step 4: Run final local proof at the reviewed head**

Run:

```bash
make verify-agent
make build
make smoke-production
corepack pnpm markdownlint-cli2 MVP_IMPLEMENTATION_LEDGER.md docs/delivery/MVP_REQUIREMENTS_MATRIX.md docs/superpowers/specs/2026-08-07-block-0-process-test-flake-design.md docs/superpowers/specs/2026-08-08-mvp-delivery-control-design.md docs/superpowers/plans/2026-08-08-block-0-repair-and-control-plane.md
git diff --check
git status --short --branch
```

Expected: all gates pass and review findings are closed. Root updates ledger/matrix evidence, checks
completed Task 7 boxes, and stages the plan and ledger with any accepted code or matrix changes before
committing the final reviewed checkpoint. The worktree is clean afterward.

Use a Conventional Commit message describing the actual repair if code changed, otherwise:

```text
docs(delivery): record Block 0 review evidence
```

## Task 8: Publish, merge, and bind evidence to exact revisions

**Files:**

- Modify: `MVP_IMPLEMENTATION_LEDGER.md`
- Modify: `docs/delivery/MVP_REQUIREMENTS_MATRIX.md`

- [ ] **Step 1: Reconcile publication state and push the exact reviewed branch**

Run:

```bash
git status --short --branch
git log --oneline github/main..HEAD
git diff --stat github/main...HEAD
git rev-parse HEAD
```

Expected: a clean worktree and a bounded diff containing only the approved designs, plan, matrix,
ledger, and process-cleanup repair. Verify no existing PR owns the branch, then root pushes it.

- [ ] **Step 2: Open a non-draft pull request**

Use a Conventional Commit PR title, for example:

```text
test(preflight): make process cleanup deterministic
```

The body must summarize the control-plane setup and code repair, link the approved designs, list
matrix row counts, state the RED/GREEN and repetition evidence, list full local gates, and say that
there is no product timeout or public API change. Create the PR non-draft so the ready-for-review
gate exercises the real contract.

- [ ] **Step 3: Verify exact-head PR checks and review state**

Record the PR URL and exact head SHA. Wait for every required check for that exact SHA. At minimum,
re-read the live ruleset and verify repository-reported check names, conclusions, URLs, and head SHA;
do not infer success from a different commit or workflow run. Whether or not the ruleset currently
marks them required, the workflows present in this slice must report exact-head success for `test`,
`validate-pr-title`, and `ready-for-review-gate`.

If a check fails, classify it before changing code. Accepted defects follow TDD and the full review
loop; infrastructure or external failures remain explicit evidence. Any new commit invalidates old
head-bound checks and reviews.

- [ ] **Step 4: Merge through the protected branch**

Re-read the PR head, mergeability, required reviews, conversations, and exact-head checks immediately
before merge. Obtain a qualified human approval of the latest head whenever the live ruleset requires
one; stale-head approval is not evidence. The user has authorized protected merge operations for this
goal, but repository rules remain binding. Use the allowed merge method, expected to be squash.
Record the PR number, merge method, exact pre-merge head, and exact protected-main merge SHA.

- [ ] **Step 5: Verify post-merge main and artifact evidence**

Wait for the merge-triggered main workflow at the exact merge SHA. Verify:

- remote default `main` equals the merge result;
- push-to-main `CI` workflow job `test` succeeds for that exact SHA;
- `Main artifact` workflow job `build-artifact` succeeds for that exact SHA;
- both workflow URLs and conclusions are recorded;
- artifact name and revision are bound to the same SHA;
- the workflow's runnable-artifact proof passed;
- no later SHA is mistaken for this slice's evidence.

The current workflow contract names the archive file
`wheelsparrow-<exact-merge-sha>.tar.gz` and the uploaded artifact
`wheelsparrow-<exact-merge-sha>`. It extracts the archive into a fresh directory, performs a frozen
production-only install, and passes `node scripts/production-smoke.mjs`. Verify those exact steps or
record a live workflow change before accepting replacement evidence.

This slice does not require an external target staging deployment. Record external staging/live-smoke
as deferred only where the matrix explicitly names the absent target or authority.

## Post-merge handoff to the next one-PR plan

This plan ends at the repair/control PR's exact post-merge evidence boundary. It must not create or
drive a second PR. Root carries the observed PR, review, merge, `CI/test`, `Main
artifact/build-artifact`, and `wheelsparrow-<exact-merge-sha>` facts into a new, independently reviewed
`docs/superpowers/plans/2026-08-08-row-1-evidence-closeout.md` plan on a fresh branch from that merge.
The handoff distinguishes archive file `wheelsparrow-<exact-merge-sha>.tar.gz` from uploaded artifact
`wheelsparrow-<exact-merge-sha>`.

That next plan owns one documentation closeout PR. It records row-1 evidence in the ledger/matrix,
preserves the approved Block 1 design/audit quarry, and adds the separate Block 1A implementation plan
without implementing Block 1A. Only after the closeout PR is checked, reviewed, merged, and verified
does execution move to Block 1A. This handoff is a boundary declaration, not a second PR plan.

## Current PR acceptance

This repair/control PR is complete only when all of these are true:

- every normative obligation has a reviewed matrix row and disposition;
- the ledger has one truthful merge train and exact cold-start resume point;
- the direct POSIX fixture waits for readiness and proves leader plus descendant termination;
- `runCommand` uses the extracted helper without timeout or public-contract change;
- focused repetition and full local gates pass at the reviewed head;
- fresh specification and quality reviewers close all findings;
- the exact PR head passes the repository's required checks and review rules;
- protected `main`, the post-merge workflow, and artifact evidence share the exact merge SHA;
- exact post-merge facts are captured for the separate closeout plan; and
- the current plan stops without trying to execute that second PR or Block 1A.

Merge-train row 1 remains `in_progress` until the separate closeout PR commits its exact evidence to
protected `main`. The programme goal remains active throughout.
