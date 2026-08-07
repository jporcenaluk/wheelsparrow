# Wheelsparrow MVP Implementation Ledger

Updated: 2026-08-07

Active goal thread: `019fd8d9-1c69-7810-82ae-6e6b35c2e2e6`

This file is the durable programme record for implementing the approved Wheelsparrow MVP. The root
orchestrator owns this ledger. Builders and reviewers return evidence; the orchestrator decides when
a requirement or block is complete.

## Objective

Build the local-first SDLC orchestrator defined by `SPEC.md`, within the structure in
`ARCHITECTURE.md`, the technology choices in `TECH_STACK.md`, and the delivery contract in
`CICD.md`.

The useful product boundary is one service that selects an eligible GitHub Project ticket, runs a
coding agent in an isolated worktree, verifies and independently reviews the change, creates a pull
request, waits for exact-revision human approval, merges it, observes staging, records smoke evidence,
and marks the ticket done only when the evidence matches.

## Authority and Scope

- Authoritative base: `main` at `471a668cbd62db919ce914ce1a891d01cc0ea72a`.
- Approved product design: `SPEC.md`, `ARCHITECTURE.md`, `TECH_STACK.md`, and `CICD.md` at that SHA.
- PR #3 is a stale, broad reference quarry. It is not an implementation base.
- The untracked files in the root checkout belong to an earlier broad implementation attempt. They
  remain untouched until their provenance and reuse value are audited.
- Production deployment of Wheelsparrow is out of scope. The product must observe a configured target
  repository's staging workflow.
- A live disposable-project smoke requires an explicitly selected external target. The command and
  safe contract belong in the MVP; executing it is deferred when no disposable target is authorized.

## Decision Rules

1. Product behavior in `SPEC.md` wins over implementation convenience.
2. Conflicts among normative documents stop the affected block until the orchestrator resolves and
   records them.
3. No speculative provider framework, workflow engine, package hierarchy, or hosted platform enters
   the MVP.
4. Every behavioral block starts with a failing test or an equivalent recorded regression check.
5. Evidence belongs to an exact commit SHA. A later commit invalidates prior code, review, CI, and
   approval evidence where the change could affect it.
6. The root orchestrator alone creates commits, pushes branches, opens or updates pull requests, and
   merges to `main`.

## Agent Hierarchy and Model Routing

- Root orchestrator: architecture arbitration, requirement traceability, protected actions, review
  triage, integration, and completion audit. Use the strongest available model and high effort when
  ambiguity or safety warrants it.
- Builder: one bounded block with one write scope and one verification surface. Use a strong model for
  state-machine, persistence, subprocess, security, and integration work.
- Reviewer: fresh context, raw diff, acceptance criteria, and exact verification evidence. Use a
  strong model for correctness and security. Use a different model family or configuration when it
  adds an independent failure mode.
- Mechanical lane: inventory, formatting, traceability checks, log classification, and narrow test
  review. Prefer a smaller model or lower reasoning effort when representative results preserve
  accuracy.

Model and effort choices must follow measured task difficulty. Start at medium effort for bounded
work, use low effort for latency-sensitive mechanical checks, and reserve high or above for tasks
where deeper reasoning changes the result.

## Delivery Blocks

The programme uses nine bounded blocks. B5 is the first useful issue-to-reviewed-PR product; B8
closes the strict documented MVP.

| Block | Working outcome | Status | Evidence |
| --- | --- | --- | --- |
| 0 | Runnable foundation, validated config, pinned toolchain, local gate, initial CI | Awaiting human approval | PR #25; implementation checkpoint `87446b6` |
| 1 | SQLite records, serialized coordinator, internal transitions, idempotent effects | Pending | Pending |
| 2 | Deterministic GitHub discovery, eligibility, claim, and stateful fake | Pending | Pending |
| 3 | Isolated Codex builder, worktree containment, verification, and process control | Pending | Pending |
| 4 | Fresh independent review, findings, and bounded repair | Pending | Pending |
| 5 | Commit, push, non-draft PR, exact-SHA CI, and Review handoff | Pending | Pending |
| 6 | Operator API and browser UI with revision-bound controls and SSE | Pending | Pending |
| 7 | Approved merge, staging observation, smoke evidence, and Done gate | Pending | Pending |
| 8 | Full CI/security/main-artifact contract and end-to-end proof | Pending | Pending |

## Current Resume Point

- Active block: B0, runnable foundation.
- Active task: babysit PR #25 through exact-SHA approval and protected squash merge.
- Isolated checkout: `/home/jporc/wheelsparrow/.worktrees/block0`.
- Branch: `feat/block-0-foundation`, based on approved base `471a668cbd62db919ce914ce1a891d01cc0ea72a`;
  current implementation checkpoint is `87446b6`.
- Executable plan: `docs/superpowers/plans/2026-08-06-block-0-runnable-foundation.md` in the
  isolated checkout.
- Current owner: bounded implementation agent; the root orchestrator retains commits and protected
  actions.
- Completed gate: Task 8 implementation checkpoint `87446b6` includes all six reviewed repairs and
  passed the combined exact-toolchain local gate.
- Last implementation checkpoint: `87446b6`.
- Next gate: push this publication-state ledger checkpoint, require its exact-SHA checks, then obtain
  the repository-required qualified human approval before squash merge. Repository auto-merge is
  disabled, so the root orchestrator must perform the merge after approval.

The dependency spine is B0 -> B1 -> B2 -> B3 -> B4 -> B5; B6 may begin after B1 but integrates with
B5; B7 depends on B5 and B6; B8 closes the programme. Each block must leave `main` runnable and must
include focused tests, independent review, required CI, merge evidence, and a ledger update.

## Resolved Requirement Questions

- Preserve the complete strict MVP, but deliver it through B0-B8. Do not label B5 as the complete
  MVP even though it is the first useful vertical slice.
- Treat `make live-smoke` as a manual, opt-in acceptance check. Required CI tests its command contract
  with fakes; CI does not run it against an external project.
- Keep startup fail-fast as written. `make preflight` provides credential and configuration
  diagnostics before startup; the browser configuration page shows connectivity for a valid running
  service. Degraded unauthenticated startup adds a second operating mode without an MVP need.
- B1 will define one canonical internal run-state transition table. Exhausted repair and staging
  failures project to `Review`; Stop run preserves evidence in `Review`; Return to Todo starts a new
  operator-authorized rework epoch with fresh bounded repair counters.
- Require macOS CI evidence for native dependencies while keeping Linux as the primary CI runtime.
- Prove staging by matching the configured workflow run and successful environment deployment to the
  recorded merge SHA, then bind smoke evidence to that SHA. Select merge method deterministically
  from target-repository capabilities, preferring squash, then rebase, then merge.
- Interpret the issue selector as a conjunction of configured labels. Do not invent a selector DSL.
- Pin the newest dependency release that satisfies the enforced minimum-release-age policy. Do not
  commit a per-version exemption merely to claim the absolute latest release; exact reproducibility
  and the supply-chain quarantine win.
- Treat `workspace_root` as a relative descendant of the repository root. Reject absolute paths,
  traversal, and symlink components before mutation; this keeps preflight from creating or changing
  permissions outside the repository-owned local data root.
- Product behavior wins over technology and delivery mechanics. Technology and delivery constraints
  remain binding unless they make the product behavior impossible; any such conflict requires a
  normative documentation change before code.

## SDLC Stage Ledger

- [x] Read the active goal.
- [x] Verify current local and remote `main` SHA.
- [x] Read the four normative documents at the current base.
- [x] Confirm PR #24 merged the focused MVP design.
- [x] Confirm PR #3 remains a draft reference quarry.
- [x] Reconcile old issues #5-#23 with the focused MVP.
- [x] Complete the requirements-skepticism audit.
- [x] Complete the local-quarry audit.
- [x] Fix the final delivery blocks and requirement-to-block map.
- [x] Create an isolated implementation clone and branch for Block 0.
- [x] Write and self-review the executable Block 0 plan.
- [ ] Implement, verify, review, publish, and merge each block.
- [ ] Run the requirement-by-requirement completion audit.

## Evidence Log

| Date | Evidence | Result |
| --- | --- | --- |
| 2026-08-06 | Local `git rev-parse HEAD` | `471a668cbd62db919ce914ce1a891d01cc0ea72a` |
| 2026-08-06 | GitHub commit search | Remote default branch reports the same latest SHA |
| 2026-08-06 | GitHub PR #24 | Merged focused MVP docs into `main` |
| 2026-08-06 | GitHub PR #3 | Open draft, 137 commits, 453 changed files, based before the focused rewrite |
| 2026-08-06 | Local status | Tracked files clean; large untracked legacy artifacts require preservation |
| 2026-08-06 | Targeted local-quarry audit | Only three non-generated source files remain; all depend on the superseded package layout and are unsafe to reuse as-is |
| 2026-08-06 | GitHub issues #5-#23 | Open, unassigned, and chained; bodies describe the superseded broad product |
| 2026-08-06 | GitHub ruleset `protect` (20527174) | Requires PRs, one approval, last-push approval, and squash; no required checks or resolved-conversation rule |
| 2026-08-06 | Current `main` checks and deployments | No current-SHA workflow, status, deployment, or environment evidence |
| 2026-08-06 | Block 0 isolation | Clean no-hardlink clone at `.worktrees/block0`, branch `feat/block-0-foundation`, based on current `main` |
| 2026-08-06 | Block 0 plan | Eight TDD tasks with exact files, commands, current APIs, workflow pins, and completion evidence |
| 2026-08-06 | B0 Task 1 implementation | Exact Node/pnpm pins and development dependencies; frozen install, type check, lint, and diff check pass; policy test is red only for the three planned manifests |
| 2026-08-06 | B0 Task 1 specification review | Fresh reviewer reported `SPEC COMPLIANT`; no scope creep or normative-document change |
| 2026-08-06 | B0 Task 1 quality review | Accepted two medium reproducibility findings: incompatible Node 26 typings and root-only generated-directory exclusions |
| 2026-08-06 | B0 Task 1 re-review | Fresh specification reviewer reported `SPEC COMPLIANT`; fresh quality reviewer reported `QUALITY APPROVED` after repairs |
| 2026-08-06 | B0 Task 1 checkpoint | Root verification passed frozen install, lint, type check, diff check, and normative-doc check; commit `00853007516724b4b7bfd74701daebf4402c3bbc` created |
| 2026-08-06 | B0 Task 2 dependency review | Registry latest TypeBox `1.3.11` is inside the enforced release-age window; reject the auto-added exemption and retain newest eligible exact release `1.3.10` |
| 2026-08-06 | B0 Task 2 quality review | Accepted a high-severity nested secret/unknown-key bypass and a medium fresh-install runtime export failure |
| 2026-08-06 | B0 Task 2 checkpoint | Root fresh install rebuilt runtime exports; 12 contract tests, type check, build, lint, diff check, and normative-doc check passed; commit `b691122` created |
| 2026-08-06 | B0 Task 3 quality review | Accepted secret-leak, false version-pass, workspace escape/chmod, and unbounded subprocess findings |
| 2026-08-07 | B0 Task 3 checkpoint | 30 focused tests, exact version diagnostics, secret-safe errors/redaction, workspace containment, process timeout/tree cleanup, type checks, build, and lint passed; real preflight correctly failed only the host Node 24.14.1 vs 24.18.0 pin; commit `8808750` created |
| 2026-08-07 | B0 Task 4 checkpoint | Six app tests and 36 focused foundation tests passed; liveness/readiness contracts, redaction, registration ordering, and best-effort cleanup preserve the causal startup error; fresh reviewers reported `SPEC COMPLIANT` and `QUALITY APPROVED`; type checks, builds, lint, and diff check passed; repository policy remains red only for planned `apps/web/package.json`; commit `6327383` created |
| 2026-08-07 | B0 Task 5 checkpoint | Frozen install passed supply-chain policy verification; 76 unit tests and 30 focused server/browser tests passed; runtime schema and media validation, guarded SPA routing, loopback startup, readiness, bounded shutdown, and accessible light/dark palettes passed fresh specification and quality rereview; type checks, builds, lint, policy, production lifecycle smoke, and diff check passed; commit `780649b` created |
| 2026-08-07 | B0 Task 6 checkpoint | Real `make smoke-production` launched the built service on ephemeral loopback, required exact HTTP 200 and exact health/readiness bodies, and observed clean shutdown; bounded deadlines, diagnostics, response bodies, redirects, partial URL announcements, signal escalation, and overlapping failures passed fresh specification and quality rereview; 76 unit tests, build, type check, lint, policy, syntax, and diff checks passed; commit `2e8497d` created |
| 2026-08-07 | B0 Task 7 checkpoint | Least-privilege PR, CI, and main-revision workflows use reviewed exact action SHAs, disable persisted checkout credentials, gate and smoke the exact revision, and verify the extracted runnable archive before upload; semantic workflow policy tests passed 5/5, the full suite passed 81/81, and lint, type check, repository policy, build, diff hygiene, fresh specification review, and fresh adversarial quality review all passed; commit `3b0332b` created |
| 2026-08-07 | B0 Task 8 local gate | Frozen-lockfile install passed; the unrestricted host `make verify-agent` passed lint, type check, 8 test files and 81 tests, plus diff hygiene; the production build passed and the lifecycle smoke passed at `http://127.0.0.1:40941`; the placeholder scan was empty and the tracked Block 0 tree contains no superseded domain, orchestration, persistence, adapter, observability, or test-support package hierarchy |
| 2026-08-07 | Managed-sandbox subprocess diagnostic | The focused `runCommand` suite passed 10/10 on the unrestricted host but the identical managed-sandbox run passed 4/10 because detached grandchildren returned empty stdout/stderr; independent reproduction identified sandbox pipe suppression rather than a product regression, so CI and local-host evidence remain authoritative |
| 2026-08-07 | B0 whole-block adversarial review | Changes requested for whitespace-only and colliding configuration values, unproven built-UI asset serving, divergent runtime/preflight configuration roots, unhelpful sanitized validation diagnostics, documented-but-unconfigured pnpm release-age quarantine, and a verification gate that warned rather than failed on the wrong Node patch; repairs split into three non-overlapping TDD lanes |
| 2026-08-07 | B0 whole-block repair gate | Exact Node 24.18.0 and pnpm 11.15.1 verification passed; the explicit strict one-day release-age quarantine accepted the frozen lockfile; lint, type check, 11 test files and 126 tests, diff hygiene, and the production build passed; the lifecycle smoke proved health, readiness, assembled HTML, bounded local JavaScript and stylesheet assets, and clean shutdown at `http://127.0.0.1:46647` |
| 2026-08-07 | B0 repaired artifact proof | Recreated the main-workflow archive from the exact declared path list, extracted it into a fresh temporary directory, completed a frozen production-only install with scripts disabled and supply-chain policy verification, then passed the extracted lifecycle and built-asset smoke at `http://127.0.0.1:40331`; the temporary proof directory was removed |
| 2026-08-07 | B0 final whole-block rereview | A fresh non-author reviewer reported `SPEC COMPLIANT` and `APPROVED`; it explicitly confirmed all six findings closed, effective pnpm configuration `minimumReleaseAge=1440` and `minimumReleaseAgeStrict=true`, focused 104/104 tests, diff hygiene, and no new security, CI, artifact, source/build drift, false-green, scope, or ledger defect |
| 2026-08-07 | B0 Task 8 implementation checkpoint | Commit `87446b6` records the reviewed configuration, built-asset smoke, strict supply-chain and exact-toolchain repairs, their tests, and the operator README; the subsequent ledger-only checkpoint does not alter executable behavior |
| 2026-08-07 | B0 PR #25 initial publication | Non-draft [PR #25](https://github.com/jporcenaluk/wheelsparrow/pull/25) targets unchanged base `471a668cbd62db919ce914ce1a891d01cc0ea72a`; initial head `0967bd0ac2a38b97588857e0d233ba450420cb3b` passed `test`, `validate-pr-title`, and `ready-for-review-gate`; GitHub reported mergeable but `REVIEW_REQUIRED`, and enabling auto-merge failed because the repository has auto-merge disabled |

## Open Decisions and Risks

- Managed execution sandboxes may suppress stdout and stderr from detached grandchildren. Run
  subprocess-capture verification on an unrestricted local host or CI runner; the same focused suite
  passes there, while sandbox-only empty-output failures are not evidence that redaction itself ran.
- Old roadmap issues #5-#23 describe the superseded broad architecture and may misroute new work.
  They remain unchanged because the user authorized PR and merge operations, not destructive tracker
  cleanup.
- The root checkout's untracked legacy artifacts overlap likely future paths; implementation needs an
  isolated worktree or connector-backed branch that cannot overwrite them.
- The current ruleset lacks required status checks and resolved-conversation enforcement. B0 must add
  real workflows before the ruleset can safely require their stable names.
- PR #25 cannot merge until a qualified human approves its latest head. Auto-merge is disabled for
  the repository, so the orchestrator must recheck exact-SHA CI and merge state after approval and
  then invoke the authorized squash merge manually.
- No authorized disposable live-smoke target, staging environment, or deployment exists.
- The staging contract belongs to target repositories. Tests must prove the orchestration contract
  with a stateful fake even when no real disposable target is authorized.

## Completion Rule

The MVP is complete only when every non-conflicting, locally achievable normative requirement maps to
current code, direct tests, independent review, exact-SHA CI, and merged `main` evidence. External
live-smoke or target-staging evidence may remain explicitly deferred only when it requires a target or
credential outside the repository and the local contract is fully implemented and tested.
