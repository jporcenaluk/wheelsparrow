# Block 7 Exact-SHA Delivery Design

Block 7 turns an exact-head Review item into `Done` only through coordinator-owned effects. Approval
atomically records operator/head/base evidence, invalidates stale candidates, and commits a merge
intent. The merge edge rereads PR identity, required checks, unresolved threads, and capabilities;
it selects squash, then rebase, then merge. It never repeats an ambiguous merge.

The delivery gateway observes a configured staging workflow/environment only when its deployed SHA
equals the durable merge SHA. A bounded shell-safe smoke command runs after that receipt, then a
conditional Project Done effect completes the run. All failure, ambiguity, deployment mismatch, and
smoke failure paths remain in Review with durable action/evidence. Retry staging never repeats merge.

The stateful GitHub fake models drift, merge count, deployments, and project moves. Live staging has
no configured target in this repository, so it is explicitly deferred; contract and SQLite evidence
remain required.
