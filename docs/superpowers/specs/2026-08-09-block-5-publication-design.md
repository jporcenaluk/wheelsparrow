# Block 5 Publication and CI Design

## Goal

Turn an independently approved run in `publishing` into a durable non-draft pull request, observe only required checks for its exact head SHA, and hand a green run to human `Review` or route one failed CI result into the existing shared repair budget.

## Boundaries

- `workspaces/git.ts` owns contained, revalidated commit and non-force push of the assigned ticket branch.
- `github/publication.ts` is the single concrete GitHub PR/check boundary. Its test fake models PR creation, rereads, required-check progression, and head drift.
- `workflow/publication.ts` owns durable intent, edge invocation, exact receipt validation, and coordinator settlement. It never writes SQLite directly.
- `WorkflowCoordinator` receives one narrow PR-facts patch so PR number, title, URL, base SHA, and head SHA settle atomically with the `publish` effect.

## Flow

1. In `publishing`, persist/begin a stable `publish` effect. Revalidate the worktree, make one intentional ticket commit, push without force, create or reread a linked non-draft PR, and reject any branch/base/head mismatch.
2. Atomically record the PR receipt and `pr_observed`, reaching `waiting_for_ci`.
3. Persist/begin an `observe_ci` effect and reread the PR/checks. Pending checks remain observable without a state transition. Only a complete required-check set for the recorded exact head may settle `ci_passed` to `review`.
4. Failed checks settle `ci_failed_repairable` only while `repairRound < 2`; otherwise `ci_failed_exhausted` hands off to `Review`. Head drift, missing required evidence, credentials, or mutation ambiguity hand off fail-closed.

## Non-goals

This block does not merge a PR, grant agents GitHub authority, create UI controls, configure check names locally, or infer staging/Done. Those belong to Blocks 6–8.

## Evidence

Real SQLite integration and stateful GitHub-fake tests prove intent-before-edge ordering, stale/replay behavior, receipt atomicity, non-force push, exact-SHA check acceptance, drift rejection, repair routing, and Review handoff.
