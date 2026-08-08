# Block 2 GitHub Discovery Design

## Goal

Deliver a deterministic, locally verifiable path from a GitHub Project snapshot
to one durable `Ready`-to-`Todo` claim. This slice stops before worktree,
builder, review, pull-request, or deployment behavior.

## Scope and boundary

The implementation adds one concrete `apps/server/src/github/` boundary. Its
narrow API reads a configured project snapshot and conditionally changes one
project item's status. Workflow code supplies typed inputs and never builds
GraphQL or invokes `gh`.

The production transport is deferred until a later slice needs live GitHub
access. A stateful fake is deliberately test-only. It models the observations
and conditional mutation required here, including item revisions and a
duplicate-mutation log, rather than becoming a provider-neutral abstraction.

## Candidate selection

The discovery service accepts the configured repository, lanes, required
labels, and priority field plus a snapshot from the GitHub boundary. It
considers only issues that belong to the configured repository, are open, are
in `Ready`, include every required label, have safely readable dependency data,
have all `blockedBy` issues closed, and are not already durably owned.

The result preserves excluded candidates with a non-secret reason for later UI
and API work. Eligible candidates are selected deterministically by native
priority order when present, then creation timestamp oldest first, then issue
number lowest first. An absent priority follows every explicit priority.

## Claim flow

The claim service checks the durable scheduler slot and existing ownership,
then creates the run and `project_todo` intent through `WorkflowCoordinator`.
The intent includes the project item identifier, expected item revision, and
the exact `Ready` and `Todo` status values. Its dispatcher invokes the GitHub
boundary's conditional mutation and confirms the receipt only if the returned
item still corresponds to the expected issue and `Todo` status.

A stale snapshot or rejected mutation produces `claim_rejected`; it never
starts a builder. Coordinator persistence keeps run creation and effect intent
atomic, and the fake's mutation ledger lets tests prove a confirmed effect is
not sent twice.

## Failure handling

Unreadable dependency information is fail-closed and recorded as a blocked
reason. Revision drift, a changed status, or a changed project-item issue
mapping rejects the claim without fabricating success. A duplicate matching
conditional mutation is represented as an idempotent already-applied receipt;
a divergent duplicate is rejected. The discovery service has no authority to
mutate GitHub.

## Tests

Tests first prove candidate filtering, deterministic ordering, unavailable
dependency handling, durable ownership exclusion, and the `Todo` execution
slot. Claim integration tests use a real temporary SQLite database plus the
stateful fake to prove the intent precedes the mutation, one matching mutation
creates one durable run, revision drift rejects safely, and replay does not
duplicate the external mutation.

## Out of scope

Live GitHub credentials and transport, worktree creation, agent execution,
operator controls, PR/CI, approval, merge, staging, smoke, and browser UI
remain owned by later Blocks 3 through 8.
