# Wheelsparrow MVP Implementation Ledger

Updated: 2026-08-08

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

- Authoritative implementation base: Block 1A merge commit
  `e6899f48ab2c6d5499eae4de16a96c8dd5ec6eca`, present as local `origin/main`; live protected-main
  status was not re-queried in this worktree.
- Approved product design: `SPEC.md`, `ARCHITECTURE.md`, `TECH_STACK.md`, and `CICD.md`; their
  content is unchanged from source revision `81271c278c47a96e2882888e20c577449c5f69b8` through the
  current protected-main SHA.
- Approved delivery control:
  `docs/superpowers/specs/2026-08-08-mvp-delivery-control-design.md`.
- Complete traceability matrix: `docs/delivery/MVP_REQUIREMENTS_MATRIX.md`, covering the normative
  sources at `81271c278c47a96e2882888e20c577449c5f69b8`; current content SHA-256
  `f769506003be84bc40d0b4f3fb9f924eb8a0baa37878c292e631210665dc3cda`; 341 rows
  (`ARCH` 40, `SPEC` 132, `STACK` 92, `CICD` 77).
- PR #3 is a stale, broad reference quarry. It is not an implementation base.
- The untracked files in the root checkout belong to an earlier broad implementation attempt. They
  remain untouched until their provenance and reuse value are audited.
- Production deployment of Wheelsparrow is out of scope. The product must observe a configured target
  repository's staging workflow.
- A live disposable-project smoke requires an explicitly selected external target. The command and
  safe contract belong in the MVP; executing it is deferred when no disposable target is authorized.

## Decision Rules

1. Prime directive: build a system that reliably orchestrates and tracks agentic work through
   completion, with clear operator visibility in a slick, clean UI.
2. Before each task or requirement, ask whether it makes sense, whether a knowledgeable engineer
   would choose it now, and whether a smaller, safer, or clearer alternative advances the prime
   directive better. Explicitly reject, defer, or resolve performative requirements rather than
   implementing them ceremonially.
3. Product behavior in `SPEC.md` wins over implementation convenience.
4. Conflicts among normative documents stop the affected block until the orchestrator resolves and
   records them.
5. No speculative provider framework, workflow engine, package hierarchy, or hosted platform enters
   the MVP.
6. Every behavioral block starts with a failing test or an equivalent recorded regression check.
7. Evidence belongs to an exact commit SHA. A later commit invalidates prior code, review, CI, and
   approval evidence where the change could affect it.
8. The root orchestrator alone creates commits, pushes branches, opens or updates pull requests, and
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
- Spawned implementation, inventory, and review lanes use the global default `gpt-5.6-terra` with
  `medium` reasoning. Root retains authoritative documents, integration, commits, publication,
  merge, and completion claims. An explicit spawn override requires a later user instruction.

## Merge Train

This is the only operational delivery order. The useful headless milestone is row 5; rows 6-8 remain
required product outcomes.

| Order | Outcome | Depends on | Status | Worktree and branch | Plan | Pull request | Merge SHA |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Deterministic Block 0 process-cleanup repair and control-plane setup | PR #25 foundation | `merged` | `.worktrees/block0-flake`; `fix/block-0-process-test-flake` | `docs/superpowers/plans/2026-08-08-block-0-repair-and-control-plane.md` | [#26](https://github.com/jporcenaluk/wheelsparrow/pull/26) | `64951a3edc3de50bdc8007becde965308c5d3040` |
| 2 | SQLite storage, migrations, and single-process ownership | 1 | `merged` | — | `docs/superpowers/plans/2026-08-08-block-1a-sqlite-storage.md` | — | `e6899f48ab2c6d5499eae4de16a96c8dd5ec6eca` |
| 3 | Canonical state, serialized coordinator, durable effects, and restart recovery | 2 | `merged` | — | `docs/superpowers/plans/2026-08-08-block-1b-coordinator.md` | [#28](https://github.com/jporcenaluk/wheelsparrow/pull/28) | `d79b3810ee7a53bf9d37bd191b6b7471bda55538` |
| 4 | GitHub discovery and claim through a verified local candidate | 3 | `review` | `.worktrees/block2-github`; `feat/block-2-github` | `docs/superpowers/plans/2026-08-08-block-2-github-discovery.md` | — | — |
| 5 | Independent review, bounded repair, publication, exact-head CI, and Review handoff | 4 | `pending` | — | — | — | — |
| 6 | Operator API and browser controls | 3 and stable read contract | `pending` | — | — | — | — |
| 7 | Exact-SHA approval, merge, staging, smoke, and Done transition | 5 and 6 | `pending` | — | — | — | — |
| 8 | Integration, security, artifact, and requirement-conformance closure | 7 | `pending` | — | — | — | — |

## Current Resume Point

- Branch base: merged Block 1B SHA
  `d79b3810ee7a53bf9d37bd191b6b7471bda55538`.
- Active slice: merge-train row 4, Block 2 GitHub discovery and durable claim.
- Active worktree: `/home/jporc/wheelsparrow/.worktrees/block2-github`.
- Branch: `feat/block-2-github`.
- Observed executable head before this ledger edit: `43ad16194d073f08d4f8ead039f0bc3e7103ae64`.
- Active plan: `docs/superpowers/plans/2026-08-08-block-2-github-discovery.md`; all Task 1-3
  checkboxes are complete.
- Last verification: at `43ad16194d073f08d4f8ead039f0bc3e7103ae64`, unrestricted Node 24.18.0
  `make verify-agent` passed formatting, Markdownlint, frozen install, all TypeScript projects, and
  23 test files / 538 tests; `make build` and diff hygiene passed. The managed sandbox suppresses
  detached-child output, so unrestricted evidence is authoritative for ownership/process tests.
- Publication state: Block 2 is pre-PR; local independent requirements, quality, and whole-block
  conformance reviews are approved.
- Next safe command: re-run the full gate at the ledger head, publish a non-draft Block 2 PR, observe
  exact-head CI, and merge under the authorized workflow.
- Current owner: root orchestrator; no bounded code worker is active at this checkpoint.
- Blocker: none.

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
- The supported local filesystem threat model is one trusted operator UID and a canonical repository
  path whose ancestors are controlled by that operator or the host system and cannot be replaced by
  another UID. Within that boundary, the repository root must be current-UID-owned and not
  group/world-writable, storage directories must be `0700`, SQLite files must be private, and the
  content-free lock must be current-UID-owned and not group/world-writable. The application rejects
  traversal, symlinks, unsafe permissions, and cross-UID disclosure inside this stable boundary.
  Hostile same-UID processes and attacker-controlled ancestor directories are excluded because Node's
  path-based filesystem APIs cannot make those environments safe without descriptor-relative I/O.
- Product behavior wins over technology and delivery mechanics. Technology and delivery constraints
  remain binding unless they make the product behavior impossible; any such conflict requires a
  normative documentation change before code.

## Historical Setup Checklist

This checklist is immutable historical evidence from the original Block 0 setup. It is not current
programme status or delivery order; only the merge train and current resume point carry those facts.

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
| 2026-08-08 | Live protected `main` | Connected GitHub commit read reports `81271c278c47a96e2882888e20c577449c5f69b8`; local `github/main` and this branch's merge base agree |
| 2026-08-08 | PR #25 merge | [PR #25](https://github.com/jporcenaluk/wheelsparrow/pull/25) is merged; head `7df29e602f71fe327a69a5d7fe82f077d68beab6`, protected-main merge SHA `81271c278c47a96e2882888e20c577449c5f69b8` |
| 2026-08-08 | PR #25 post-merge CI | [CI run 31158318354](https://github.com/jporcenaluk/wheelsparrow/actions/runs/31158318354) job `test` completed successfully at merge SHA `81271c278c47a96e2882888e20c577449c5f69b8` |
| 2026-08-08 | PR #25 main artifact | [Main artifact run 31158319951](https://github.com/jporcenaluk/wheelsparrow/actions/runs/31158319951) job `build-artifact` completed successfully; artifact `wheelsparrow-81271c278c47a96e2882888e20c577449c5f69b8` ID `8986025122`, digest `sha256:aaaee69333851be4fb1794438ed86a8e82f1db62edf07bb2b2744495dfd328e9`, is unexpired and bound to that SHA |
| 2026-08-08 | Delivery-control design | Approved design commit `7db4ee1` defines the ledger/matrix/one-plan control plane, merge train, recovery protocol, and agent hierarchy |
| 2026-08-08 | Row 1 execution-plan review | Xhigh Luna, control-plane, and subprocess reviewers inspected the plan; accepted findings corrected source drift, trace IDs, TDD coverage, process wiring, checkpoint invariants, exact checks, and the one-PR boundary before bootstrap |
| 2026-08-08 | Requirements matrix | At checkpoint `62b686c`, root integrated four bounded source inventories into 341 reviewed rows (`ARCH` 40, `SPEC` 132, `STACK` 92, `CICD` 77) at source revision `81271c278c47a96e2882888e20c577449c5f69b8`; that checkpoint's matrix SHA-256 was `812f47388a15b630f1bd1483bf08cfbaebb1ef656823cf2dd5be2f3229292080`; final Terra/medium review found no open defect |
| 2026-08-08 | Row 1 control-plane checkpoint | Connected GitHub reconfirmed merged PR #25, protected `main` `81271c278c47a96e2882888e20c577449c5f69b8`, successful jobs in runs `31158318354` and `31158319951`, unexpired exact-SHA artifact `8986025122`, and no open PR for `fix/block-0-process-test-flake`; Markdownlint and diff hygiene passed |
| 2026-08-08 | Row 1 process-cleanup RED checkpoint | One bounded Terra/medium worker changed only `scripts/preflight.test.ts`; TypeScript and the pre-refactor API group-wiring characterization passed, while all three new helper contracts failed only at the expected missing-export assertion; root inspected the diff, reproduced the exact three failures, and confirmed diff hygiene |
| 2026-08-08 | Row 1 process-cleanup GREEN checkpoint | The minimal helper extraction preserves timeout semantics while making POSIX process-group cleanup, Windows routing, and double-failure suppression directly testable; focused contracts, Biome, TypeScript, and diff hygiene passed; the unrestricted preflight file passed 25/25; fresh Terra/medium review found no defect and repeated the direct fixture 5/5 |
| 2026-08-08 | Row 1 repeatability and full local gate | At exact code checkpoint `5cd12d57027435506b5fb97fd8a47757cf55b875`, the unrestricted host passed the real direct process-group test 25/25 and the complete preflight file 25/25; the explicit single-worker repository suite and canonical `make verify-agent` each passed 11 files and 129 tests; build and production lifecycle smoke passed at `http://127.0.0.1:39993`; diff hygiene passed |
| 2026-08-08 | Row 1 final independent review | Fresh Terra/medium specification review reached `SPEC COMPLIANT`; fresh subprocess review reached `QUALITY APPROVED`; fresh traceability review reached `TRACEABILITY APPROVED` after correcting superseded model routing, current versus historical matrix hashes, one unbound evidence path, and the productless/circular closeout-PR boundary |
| 2026-08-08 | Row 1 reviewed local proof | Unrestricted `make verify-agent` passed 11 files and 129 tests; build and production lifecycle smoke passed at `http://127.0.0.1:36895`; the five-file Markdownlint gate and diff hygiene passed at the reviewed working content |
| 2026-08-08 | Row 1 PR #26 exact-head proof | Non-draft [PR #26](https://github.com/jporcenaluk/wheelsparrow/pull/26) at head `6c2bea8fc4233292e0498e60e1c998360aa460b3` passed PR metadata run `31253089872` and CI run `31253089886`; no open review thread or comment remained and GitHub reported it mergeable |
| 2026-08-08 | Row 1 protected merge | PR #26 squash-merged with the expected-head guard; connected GitHub and local `github/main` agree on merge SHA `64951a3edc3de50bdc8007becde965308c5d3040` |
| 2026-08-08 | Row 1 post-merge proof | [CI run 31253147178](https://github.com/jporcenaluk/wheelsparrow/actions/runs/31253147178) and [Main artifact run 31253147159](https://github.com/jporcenaluk/wheelsparrow/actions/runs/31253147159) succeeded at the exact merge SHA; artifact `wheelsparrow-64951a3edc3de50bdc8007becde965308c5d3040` ID `9020617150`, digest `sha256:0f82a1e8def6532a62f5e34fb9066825a63e4f7dfca0afec988b5f5cd0719f50`, is unexpired and passed extracted lifecycle verification |
| 2026-08-08 | Row 2 planning checkpoint | Clean worktree `.worktrees/block1a-storage` and branch `feat/block-1a-storage` start at exact protected-main SHA `64951a3edc3de50bdc8007becde965308c5d3040`; bounded plan `docs/superpowers/plans/2026-08-08-block-1a-sqlite-storage.md` keeps state/coordinator semantics in row 3 and real agent-log storage in row 4 |
| 2026-08-08 | Row 2 plan review | Fresh Terra/medium plan, traceability, and security reviewers reached `PLAN APPROVED`, `TRACEABILITY APPROVED`, and `SECURITY APPROVED` after replacing PID metadata and a conflicting second SQLite lock database with a maintained OS advisory file lock, defining the artifact as an installable source bundle, binding native lock behavior to Linux/macOS CI, and tightening migration, path, lifecycle, and supply-chain proofs |
| 2026-08-08 | Row 2 lock dependency pre-adoption proof | `fs-native-extensions@1.5.0` (integrity `sha512-nuZLFm9mGCxvyi7Llww/J4OyifKCS21nEUTAmnlTZp3FObPOvA32aCedCmt4Z+8yk+caqfClNaSCfn/P7T7FLQ==`) was published 2026-04-13 and resolves to `require-addon@1.2.0`, `which-runtime@1.4.0`, `bare-addon-resolve@1.10.1`, `bare-module-resolve@1.12.4`, and `bare-semver@1.1.0`; all six packages are Apache-2.0 with no install lifecycle script, so no pnpm build exemption is needed. An unrestricted Node 24.18.0 Linux probe proved holder `true`, simultaneous contender `false`, and successor `true` after forced holder exit |
| 2026-08-08 | Row 2 dependency GREEN | RED commit `acd1661` failed only on the missing `better-sqlite3` import; `db4a0f2` pins `better-sqlite3@13.0.3`, `kysely@0.29.4`, `fs-native-extensions@1.5.0`, and `@types/better-sqlite3@9.6.0`. Frozen install ran only the allowlisted `better-sqlite3` rebuild; real-file persistence passed 1/1, repository policy 6/6, server typecheck, targeted Biome, and diff hygiene passed |
| 2026-08-08 | Row 2 safe-path GREEN | RED commit `bc9d88c` produced six async failures only at the missing `deriveLocalPaths` API; `67125c6` canonicalizes the repository root, rejects shallow/escaping/symlink/non-directory/unsafe-permission storage paths, permits missing descendants without mutation, and derives the one private local layout. The complete config file passed 20/20 with server typecheck, targeted Biome, and diff hygiene |
| 2026-08-08 | Row 2 ownership GREEN | RED commit `e7b4a47`, implementation commit `db4e59c`, hardening commit `e2bb55a`, and path-boundary commit `17809d6` establish one OS advisory whole-file lock with typed contention, hard-error causality, current-UID regular-file validation with no group/world write access, idempotent release, and crash-safe reacquisition. Root's unrestricted Node 24.18.0 suite passed 9/9, including separate live holder and contender children; targeted Biome, server typecheck, diff hygiene, and fresh ownership rereview passed with `APPROVED` |
| 2026-08-08 | Row 2 immutable SQLite GREEN | RED/hardening commits `6c251e0`, `901cbdb`, `70ac7a3`, and `fc9b21d` plus production commit `c51536f` establish one real SQLite/Kysely handle, canonical immutable migrations, six exact operational tables, restart-safe schema/ledger atomicity, bounded JSON, evidence-preserving constraints, canonical hashes, safe target files, fatal UTF-8 preflight, and await-idempotent close. Root passed 62/62 twice plus both TypeScript configurations, targeted Biome, and diff hygiene; fresh reviewers returned `SCHEMA APPROVED`, `TESTS APPROVED`, `SPEC COMPLIANT`, and `QUALITY APPROVED` |
| 2026-08-08 | Row 2 lifecycle composition GREEN | Lifecycle RED commits `044978b`, `b606bf9`, and `915242d` plus production commit `577131a` establish complete directory preflight before mutation, private path creation/revalidation, strict existing-lock validation, configuration -> ownership -> SQLite migration -> listener ordering, a shared idempotent close, and startup-phase serialization that defers reverse cleanup until any in-flight acquire/open/migrate/build/listen operation settles. Root passed 59/59 lifecycle/path tests, the unrestricted native ownership suite 10/10, both TypeScript configurations, targeted Biome, and diff hygiene; fresh reviewers returned `SPEC COMPLIANT`, `QUALITY APPROVED`, and `SECURITY APPROVED` after signal-race, force-deadline, handler-removal, and permissive-lock repairs. |
| 2026-08-08 | Row 2 production lifecycle smoke checkpoint | Commit `07fc32f` runs the built server from an immutable bundle root against a guarded OS-temporary repository fixture, interrupts startup after ownership and database open, verifies private SQLite state and the canonical migration ledger, rejects a live ownership contender before URL announcement, checks health/readiness/UI/assets, shuts down cleanly, and restarts against the same durable state. Focused smoke contracts passed 9/9; pinned Node 24.18.0 `make verify-agent` passed 14 files and 249 tests; production build and post-build smoke passed; fresh reviewers returned `QUALITY APPROVED` and `SAFETY APPROVED`. |
| 2026-08-08 | Row 2 native dependency audit | `better-sqlite3@13.0.3` is MIT, integrity `sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==`, and resolves to MIT `node-addon-api@8.9.1` integrity `sha512-4eUQWVPCUUUiBjLnHS3cXWeC6ryoPUc0U3rP7IuzapoGbzMqd/r6KKO0clr0b+snQhsrueFEhCZDdK+LK7hxKg==`; its `binding.gyp` makes pnpm enforce the explicit build allowance even though its manifest has no install script. `fs-native-extensions@1.5.0` is Apache-2.0, integrity `sha512-nuZLFm9mGCxvyi7Llww/J4OyifKCS21nEUTAmnlTZp3FObPOvA32aCedCmt4Z+8yk+caqfClNaSCfn/P7T7FLQ==`, and resolves through Apache-2.0 `require-addon@1.2.0` (`sha512-VNPDZlYgIYQwWp9jMTzljx+k0ZtatKlcvOhktZ/anNPI3dQ9NXk7cq2U4iJ1wd9IrytRnYhyEocFWbkdPb+MYA==`), `bare-addon-resolve@1.10.1` (`sha512-F/SD2du8keuYSb4xipnGz5j2E6yhNdHA8ZVxtHae6h2uOrpBIjjbhXvjzKZbr5XUOzqBzh/i8GVFycj2DlFQIA==`), `bare-module-resolve@1.12.4` (`sha512-xcfgg2u7HqgJiBmah71O9vvdFAgHCvkqC/WSC2O7Bbgosoc1eC/BWe/6IDJ4OsfKlkxuvC/TDWXC+oH5yeW8mA==`), `bare-semver@1.1.0` (`sha512-1Hw5qJ7hXdVt3uPUqjeFTuxyvBUJauvz5A1I2jk8gzjZMHp04n//6nV9MDbG9CMw78JHY2lGV0w6s//LrASm2w==`), and `which-runtime@1.4.0` (`sha512-0ugbP4CJW4e2D20jvEcC4973dCgIaHI4Rw1PT+26U9zEve7FyYdWAIwUnoeOYvoCfn+wXHoHTKb1KhkYlb60Pw==`); none has an install lifecycle script, so no allowance is present. `esbuild` retains its existing development/build-only allowance and is absent from the server production closure. Removing the SQLite allowance reproduced `ERR_PNPM_IGNORED_BUILDS`; restoring the exact `better-sqlite3` plus `esbuild` policy made frozen install pass. |
| 2026-08-08 | Row 2 native CI and artifact GREEN | Workflow RED commits `fd67f58`, `3c8b982`, `a6c91e5`, and `ce6b4df` plus GREEN commits `f7c724a`, `45c200b`, and `4ca048d` add a narrow pinned macOS job for real SQLite persistence, immutable migrations, live contender/release/SIGKILL ownership recovery, and an exact-SHA supported-host archive containing source, built output, manifests, migrations, and its revision. The archive performs a frozen production-only install without blanket script suppression and runs the same production proof from outside its directory; an idempotent fail-closed contracts prepare helper skips packaged output and builds only source checkouts. Root passed the corrected native suite 73/73, full gate 258/258, build, source smoke, exact extracted install/smoke, and diff hygiene. Fresh reviewers returned `TEST CONTRACT APPROVED`, `QUALITY APPROVED`, `SECURITY APPROVED`, `SPEC COMPLIANT`, and `ARTIFACT APPROVED` after lifecycle, exact-revision, caller-CWD, and missing-migration repairs. |
| 2026-08-08 | Row 2 final storage-boundary repair | Final review accepted and repaired world-traversable `0711` storage, readable SQLite sidecars, an unsafe writable repository-root boundary, and silent safe journal fallback. Commit `fb964a2` requires a current-UID, non-group/world-writable canonical repository root, `0700` storage directories, descriptor-anchored `0600` database creation, and private live database/WAL/SHM validation; commit `5f71ba4` emits one bounded nonsecret JSON warning when production uses an allowlisted non-WAL fallback. The caller must provide a stable operator/system-controlled repository ancestor path. Root passed config 34/34 and real migrations 65/65 unrestricted plus both TypeScript checks, Biome, and diff hygiene; focused rereviews returned `QUALITY APPROVED` and `SECURITY APPROVED`. |
| 2026-08-08 | Row 2 final whole-branch review | Fresh Terra/medium requirements, quality, and security reviewers inspected the complete branch and current evidence. Accepted findings repaired stale matrix rows/hash, unsafe repository/storage permissions and cross-UID disclosure inside the supported stable path boundary, silent journal fallback, and overclaimed lock privacy. The final working content received `REQUIREMENTS APPROVED`, `QUALITY APPROVED`, and `SECURITY APPROVED`; CI-dependent native rows remain explicitly partial until exact-head GitHub Linux/macOS evidence exists. |
| 2026-08-08 | M0 tracker reconciliation | [Issue #5](https://github.com/jporcenaluk/wheelsparrow/issues/5) was closed as completed with a comment binding its M0 acceptance criteria to merged PR #25 (`81271c278c47a96e2882888e20c577449c5f69b8`) and the subsequent deterministic repair/control-plane PR #26 (`64951a3edc3de50bdc8007becde965308c5d3040`). |
| 2026-08-08 | Row 2 exact-head local and artifact gate | At `3c1463e8c68dd2e2043cb2a1a862ef6394ea76b5`, unrestricted Node 24.18.0 `make verify-agent` passed 15 files / 264 tests, `make build` and `make smoke-production` passed, and diff hygiene passed. A reconstructed exact-head source bundle then passed frozen production-only installation and extracted production smoke. |
| 2026-08-08 | Row 3 implementation branch | Clean `.worktrees/block1b-state` / `feat/block-1b-coordinator` starts at the exact Block 1A merge base `e6899f48ab2c6d5499eae4de16a96c8dd5ec6eca`; the bounded plan is `docs/superpowers/plans/2026-08-08-block-1b-coordinator.md`. |
| 2026-08-08 | B1 immutable workflow guardrails | Commit `8b9107f` adds the coordinator migration, scheduler controls, canonical-state/effect validation, singleton ownership indexes, append-only history triggers, and migration regression coverage. |
| 2026-08-08 | B1 canonical state machine | Commit `813a30c` defines the complete twenty-state durable workflow vocabulary, exhaustive transition and effect-observation matrices, and malformed-boundary rejection tests. |
| 2026-08-08 | B1 revision-safe workflow persistence | Commit `421a29b` adds transaction-scoped run, history, and scheduler repositories with exact-revision transitions, ownership/coding-slot constraints, rework epochs, repair budgets, rollback, and concurrent stale-write tests. |
| 2026-08-08 | B1 durable effect ledger | Commit `dbe81dc` adds idempotent effect intents, lifecycle receipts, fingerprint checks, revision-safe observations, and recovery-state persistence. |
| 2026-08-08 | B1 serialized coordinator | Commit `3b3fa59` adds FIFO command serialization, commit-before-dispatch effect execution, revision-checked callback observations, and shutdown ambiguity handling. |
| 2026-08-08 | B1 restart reconciliation | Commit `9fa0ce0` classifies unresolved effects safely on restart, observes dispatched work without replaying it, awaits settlement, and fails closed when recovery adapters are unavailable. |
| 2026-08-08 | B1 service lifecycle integration | Commit `e604a39` runs durable reconciliation after migration and before listener startup, and closes the coordinator before database resources during shutdown and failure cleanup. |
| 2026-08-08 | Row 3 exact-head pre-PR whole gate | At `e604a39f9de8b81026798cc82796a509d117b12d`, unrestricted Node 24.18.0 `make verify-agent` passed formatting, Markdownlint, frozen install, all TypeScript projects, 19 test files / 410 tests, and diff hygiene; `make build` and `make smoke-production` passed. No PR, CI, approval, or merge evidence exists yet. |
| 2026-08-09 | Row 4 GitHub discovery and durable claim | Commits `6561df7`, `7738af7`, `8cf0f31`, `a3707e7`, `4b5f19a`, and `43ad161` add a narrow typed GitHub project boundary, test-only stateful fake, fail-closed deterministic eligibility, active durable-ownership lookup, durable exact-item claim, atomic claim rejection, late-callback quarantine, and restart-safe reconciliation. The fake detects revision, identity, duplicate-mutation, dependency, receipt, ordering, and timestamp drift. Fresh requirements, quality/security, and whole-block reviewers approved after repairing malformed duplicate IDs, post-mutation ambiguity, observer uncertainty, and representation-order drift. At `43ad161`, unrestricted Node 24.18.0 `make verify-agent` passed 23 files / 538 tests; `make build`, Markdownlint, and diff hygiene passed. Publication remains pending. |

## Open Decisions and Risks

- Managed execution sandboxes may suppress stdout and stderr from detached grandchildren. Run
  subprocess-capture verification on an unrestricted local host or CI runner; the same focused suite
  passes there, while sandbox-only empty-output failures are not evidence that redaction itself ran.
- Old roadmap issues #5-#23 describe the superseded broad architecture and may misroute new work.
  They remain unchanged because the user authorized PR and merge operations, not destructive tracker
  cleanup.
- The root checkout's untracked legacy artifacts overlap likely future paths; implementation needs an
  isolated worktree or connector-backed branch that cannot overwrite them.
- The last recorded ruleset lacked required status checks and resolved-conversation enforcement.
  Re-read live protection before every merge and require all present exact-head workflows to pass
  even when the ruleset does not name them.
- No authorized disposable live-smoke target, staging environment, or deployment exists.
- The staging contract belongs to target repositories. Tests must prove the orchestration contract
  with a stateful fake even when no real disposable target is authorized.

## Completion Rule

The MVP is complete only when every non-conflicting, locally achievable normative requirement maps to
current code, direct tests, independent review, exact-SHA CI, and merged `main` evidence. External
live-smoke or target-staging evidence may remain explicitly deferred only when it requires a target or
credential outside the repository and the local contract is fully implemented and tested.
