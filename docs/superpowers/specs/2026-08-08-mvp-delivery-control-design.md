# MVP Delivery Control Design

Status: Approved by the user on 2026-08-08

## Outcome

Wheelsparrow keeps one programme goal while delivering the product through small, mergeable outcomes.
The repository, rather than conversation history, records what the programme requires, what has been
proved, and exactly where work resumes.

This control structure must make a cold restart routine. A new root orchestrator should be able to
read three repository artifacts, verify current Git and GitHub state, and continue without reconstructing
the programme from chat transcripts.

## Goal and authority

The existing MVP goal remains the complete objective. It must be resumed rather than replaced by a
narrower goal. Delivery slices limit work in progress; they do not narrow the exit criteria.

The normative product sources remain:

1. `SPEC.md` for required behavior;
2. `ARCHITECTURE.md` for component boundaries and source-of-truth rules;
3. `TECH_STACK.md` for approved implementation choices; and
4. `CICD.md` for delivery and verification evidence.

The control artifacts interpret and track these documents. They cannot silently override them. When
a requirement is harmful, conflicting, or externally impossible, the requirements matrix records an
explicit disposition and rationale.

## Control artifacts

### Programme ledger

`MVP_IMPLEMENTATION_LEDGER.md` is the sole operational journal. It records both completed evidence
and the ordered work ahead. No parallel status document may restate its programme state.

The ledger contains:

- the objective, authority, and binding programme decisions;
- the ordered merge train and dependencies;
- one current resume point;
- exact local, review, PR, CI, merge, and post-merge evidence;
- unresolved risks and external gates; and
- the final completion rule.

Each merge-train row contains:

| Field | Meaning |
| --- | --- |
| Order | Stable delivery order |
| Outcome | Independently runnable result |
| Depends on | Required predecessor rows |
| Status | `pending`, `in_progress`, `review`, `merged`, or `blocked` |
| Worktree and branch | Exact active local lane, when one exists |
| Plan | Current per-slice implementation plan |
| Pull request | Exact GitHub PR, when published |
| Merge SHA | Exact protected-main result, when merged |

The resume point contains the authoritative remote `main` SHA, active worktree, branch and HEAD,
current task or checkbox, last verification result, next safe command, current owner, and a real
blocker when one exists. Root updates it before ending an incomplete work period.

Evidence entries state observed facts only. A green test on one SHA does not prove a later SHA. A PR
merge does not prove its post-merge workflow or runtime artifact.

### Requirements matrix

`docs/delivery/MVP_REQUIREMENTS_MATRIX.md` provides complete traceability across the four normative
documents. It is not a second work queue.

Each row contains:

| Field | Meaning |
| --- | --- |
| ID | Stable repository-owned requirement identifier |
| Source | Document and stable section heading |
| Requirement | Concise normalized obligation |
| Disposition | `implement`, `rejected`, `external_deferred`, or `conflict` |
| Rationale | Required for every disposition except `implement` |
| Delivery slice | Merge-train row that owns implementation |
| Required proof | Code, test, review, CI, runtime, or external evidence needed |
| Current evidence | Exact SHA, command, URL, artifact, or `missing` |
| Status | `pending`, `partial`, `proved`, or `unavailable` |

References use stable document headings rather than line numbers that drift. One requirement may
need several proof types. Indirect evidence remains `partial` or `missing`.

The matrix records poor requirements instead of implementing them performatively. A `rejected` row
must explain why it harms the overarching SDLC-orchestrator outcome. An `external_deferred` row names
the missing target, credential, or human action and proves the local contract as far as possible.

### Per-slice plans

Detailed TDD plans live under `docs/superpowers/plans/`. One plan covers one independently mergeable
pull request. The normal limit is one active plan; a second may run only when its files and interfaces
are independent.

Plans contain exact files, failing tests, implementation steps, verification commands, review gates,
and commit checkpoints. Plans do not repeat the whole requirements matrix. They link the requirement
IDs owned by their slice.

Approved design documents under `docs/superpowers/specs/` preserve durable design decisions. New
design documents are created only for material ambiguity or behavior change, not for routine execution.

No separate backlog, workpad, or agent ledger is permitted. Those copies would drift.

## Initial merge train

The ledger replaces the old B0-B8 waterfall with these bounded outcomes:

1. deterministic Block 0 process-cleanup test repair plus control-plane setup;
2. Block 1A real SQLite storage, migrations, and single-process ownership;
3. Block 1B canonical state, serialized coordinator, durable effects, and restart recovery;
4. deterministic GitHub discovery and claim through a verified local candidate;
5. independent review, bounded repair, publication, exact-head CI, and Review handoff;
6. operator API and browser controls after the kernel read contract stabilizes;
7. exact-SHA approval, merge, staging, smoke, and Done transition; and
8. full integration, security, artifact, and requirement-conformance closure.

The useful headless milestone is row 5. Rows 6-8 remain part of the approved MVP and cannot be
silently renamed as optional follow-up.

The existing broad Block 1 design remains valid source material. Its oversized implementation plan
is split into Block 1A and Block 1B plans. No approved reasoning or audit finding is discarded.

## Orchestrator recovery protocol

At the start of every work period, root performs this sequence:

1. read the active goal and confirm it still carries the complete objective;
2. read the ledger's current resume point;
3. verify remote `main`, local worktree status, branch, and HEAD;
4. read only the active per-slice plan and its requirements-matrix rows;
5. reconcile existing agents before spawning new work; and
6. correct stale ledger claims before implementation continues.

At every durable checkpoint, root:

1. inspects the actual diff;
2. runs verification proportionate to the change;
3. records the exact result and SHA;
4. updates the plan checkbox and ledger resume point;
5. commits the checkpoint; and
6. preserves a clean or explicitly described worktree.

After publication, root binds review and CI evidence to the exact PR head. After merge, root verifies
the exact protected-main SHA, post-merge workflows, and required runtime artifact before marking the
slice merged.

## Agent hierarchy

The root orchestrator owns architecture arbitration, the requirements matrix, ledger, integration,
commits, GitHub publication, protected merges, and completion claims.

Builders receive one bounded task, one worktree, explicit writable paths, acceptance criteria, and
verification commands. They report files changed, commands and exact results, open risks, and any
scope conflict. Builders do not edit the programme ledger or requirements matrix.

Test and contract workers may build independent fixtures, transition matrices, policy checks, or
platform evidence. Reviewers use fresh, read-only context and inspect requirement compliance before
implementation quality. Root triages every finding and adds a regression test before accepted repairs.

Smaller or lower-effort models handle mechanical inventory, traceability, formatting, CI
classification, and narrow test audits. Stronger and higher-effort models handle persistence,
locking, state transitions, effect reconciliation, subprocess containment, security, and adversarial
review. At most one writer owns a shared core interface at a time.

## Drift and failure handling

Repository and GitHub evidence outrank the ledger when they disagree. Root corrects the ledger before
acting on stale state.

An interrupted or failed agent does not imply task failure. Root inspects its worktree and evidence,
then either resumes the bounded task or restores it from the last committed checkpoint without
discarding unrelated user work.

When a slice grows beyond one independently reviewable PR, root splits it at a runnable boundary and
updates the ledger and matrix before continuing. The full requirement ownership remains visible.

Only a repeated terminal external blocker may pause the programme. Hard work, plan size, incomplete
implementation, or a useful parallel lane is not a blocker.

## Setup sequence

After written-spec approval, root will:

1. correct the stale ledger and replace the old delivery table with the merge train;
2. create the complete requirements matrix;
3. implement the approved Block 0 deterministic test repair in the existing isolated worktree;
4. independently review, publish, and merge that combined repair and control-plane PR;
5. create a fresh Block 1A worktree from the resulting `main`;
6. preserve the approved Block 1 design and audit findings while splitting its plan; and
7. execute each remaining row through review, CI, merge, and post-merge evidence.

## Rejected alternatives

- A new goal: fragments the programme and risks narrowing the original exit criteria.
- One giant ledger: mixes traceability, detailed implementation, and evidence until recovery becomes
  slower rather than safer.
- A separate ordered to-do file: duplicates the ledger's merge train and creates two status authorities.
- A machine-readable workflow queue now: spends implementation effort on the control plane before the
  product kernel can consume it.
- Multiple writers on the coordinator or persistence core: increases merge conflict and invariant risk.
- Planning several PRs in one document: hides runnable boundaries and makes review evidence ambiguous.

## Acceptance

This delivery-control design is in effect when:

- the existing goal remains the full objective;
- the ledger contains a truthful merge train and exact resume point;
- every normative requirement has one matrix row and disposition;
- the current slice has one independently executable plan;
- agent roles and model routing are explicit;
- a cold-start orchestrator can identify the next safe command from repository state; and
- merged status requires exact review, CI, main, and artifact evidence appropriate to the slice.
