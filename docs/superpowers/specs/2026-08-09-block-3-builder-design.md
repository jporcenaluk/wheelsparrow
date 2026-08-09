# Block 3 Builder and Workspace Design

## Goal

Deliver the smallest durable path from a confirmed `Todo` claim to a builder
result that has run in a contained Git worktree and passed the configured
repository verification command. This block stops before independent review,
repair, publication, CI, operator HTTP, and browser work.

## Boundaries

`workspaces/` owns Git commands and filesystem checks. Given a canonical
repository root, configured workspace root, run ID, and repository identity,
it creates one deterministic ticket branch and worktree below the configured
root from the current `origin/main` revision. It rejects unsafe roots,
symlinks, paths outside the root, missing or non-current base refs, unexpected
worktree metadata, and worktree paths or Git changes that do not belong to the
run. It never removes a worktree; later explicit cleanup owns that action.

`agents/` owns the local Codex subprocess and prompt rendering. The builder
receives a rendered repository-owned prompt plus bounded issue and worktree
facts. Its process has no GitHub token or mutation capability supplied by
Wheelsparrow, executes with an argument array in the assigned worktree, emits
bounded redacted output, and returns exactly one TypeBox-validated terminal
result. A timeout, spawn error, malformed stream, duplicate terminal result,
or incomplete exit is a failed attempt; the existing process-group termination
rule applies.

`verification` is a narrow process runner for the configured command. It runs
only after a successful builder terminal result, uses the same assigned
worktree and bounded process controls, and records the command, exit result,
and exact Git head SHA. The configured command is a repository contract: this
block does not infer or rewrite it.

## Workflow and durability

The coordinator remains the only durable writer. `workspace_prepare`,
`agent_build`, and `verify` effects use their existing state transitions:
`preparing -> intaking -> building -> verifying -> reviewing`. Their intents
contain only validated run, branch, base, worktree, prompt, model, command,
and attempt facts. Dispatchers run outside SQLite transactions and send typed
receipts back through the coordinator. An unobserved child process is retained
as ambiguous for restart reconciliation; it is never blindly relaunched or
adopted.

The existing append-only `steps` table records the model, reasoning effort,
prompt hash, timing, bounded exit result, summary, and log reference. This
block adds only the records and mutations needed to support builder and
verification receipts; it does not add a generic process framework, provider
framework, or direct SQLite writes from edge modules.

## Tests and security

Tests use temporary Git repositories and real worktrees to prove containment,
base provenance, branch naming, changed-file ownership, Review retention, and
failure without agent start. Agent and verification tests use deterministic
child fixtures to prove argument-array invocation, working-directory
containment, bounded output, one valid terminal result, timeout/tree cleanup,
and failure classification. Coordinator integration tests prove durable intent
precedes each action, exact receipts advance state, and restart reconciliation
does not duplicate a process.

The builder prompt states that it may modify only its worktree and cannot move
project items, push, create pull requests, merge, deploy, or acquire
credentials. Dynamic issue context is clearly delimited and byte-bounded. The
future reviewer and repair prompts, fresh-context rules, repair limit, commit
and PR behavior, CI observation, HTTP, UI, and cleanup operation remain in
Blocks 4 through 8.
