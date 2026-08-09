# Block 4: Independent Review and Bounded Repair Design

## Goal

Advance a successfully verified run from `verifying` through one fresh, independent
review and, when necessary, no more than two repair rounds. This block stops before
commit, push, pull-request, CI, operator HTTP/UI, approval, merge, and staging work.

## Boundaries

`agents/reviewer.ts` and `agents/repair.ts` own distinct repository prompts,
argument-array subprocess execution, bounded/redacted output, and TypeBox terminal
result validation. Neither role receives GitHub credentials or authority to mutate a
project item, push, create a PR, merge, or deploy. Reviewer prompt construction takes
the intake, exact base/head SHA, bounded raw diff, relevant repository facts, and
verification receipt; it deliberately excludes the builder terminal claim.

`workspaces/git.ts` owns a bounded, canonical raw-diff readback for the assigned
worktree. It validates the stored worktree identity and limits output before a prompt
is rendered. It does not alter worktree contents.

`workflow/review.ts` owns review/repair sequencing only. It creates stable review and
repair effects, calls edges only after their intents are in flight, and sends every
receipt to coordinator-owned commands. It never imports Kysely or directly mutates
SQLite, GitHub, a PR, or UI state.

## Durable outcomes

The reviewer accepts exactly `approved`, `needs_repair`, `needs_human`, and `blocked`.
`needs_repair` requires one or more concrete, bounded findings with a stable key,
severity, and evidence. Findings are append-only and written with their review step in
the same coordinator transaction. `approved` moves the run to the later publication
handoff state; human/blocked results move it to Review with a precise required action.

Repairs run only in the assigned worktree, preserve findings, and consume the existing
shared `repair_round` budget. A repair is followed by the normal verification step and
a fresh reviewer invocation. The second repairable result, malformed receipt, process
failure, stale callback, unprovable restart, or exhausted round fails closed to Review;
it never silently starts a third repair or reuses a prior reviewer result.

## Coordinator extension

`WorkflowCoordinator.settleExecution` grows a narrow optional `findings` array. In one
transaction it validates run/effect/revision/rework epoch, appends the step, appends
all findings, optionally patches execution facts, observes the effect, and makes the
legal state transition. A stale callback rolls back every insert. No generic finding
patch or arbitrary run update is introduced.

## Deterministic checks

Prompt tests validate all three role prompts, required authority boundaries, distinct
terminal schemas, byte limits, delimiter handling, and stable hashes without calling a
model. Workflow tests use migrated SQLite, deterministic edge seams, and temporary Git
repositories to prove order, fresh review context, finding durability, repair limits,
and restart safety. The full block uses the canonical local gate, build, and smoke.

## Control-plane reconciliation

The ledger labels this as merge-train row 6 after the merged Block 3 row. The matrix's
older delivery-slice number 5 means the same independent-review/publication tranche;
Block 4 evidence updates those rows rather than changing their normative requirement
text. Ledger references to `origin/main` are updated to the actual merged Block 3 SHA.
