# Wheelsparrow MVP Continuous Integration and Delivery

Status: Approved MVP baseline

Purpose: Define a mature but compact delivery contract for Wheelsparrow itself. This document borrows
the proven operating shape used in `automations`: stable Make targets, isolated worktrees, a local
gate that mirrors CI, layered tests, workflow-contract tests, separate PR metadata checks, and exact
commit evidence.

This document does not define how Wheelsparrow's target repositories deploy to staging; that is the
configured repository contract in `SPEC.md`.

## 1. Delivery Principles

1. **One command composition.** Contributors, agents, and GitHub Actions use the same Make targets.
2. **Evidence belongs to a revision.** Local results, reviews, CI, approvals, artifacts, and security
   findings identify the exact commit they evaluated.
3. **Required checks never disappear.** A required workflow reports pass or fail for every relevant
   pull request; path filters MUST NOT silently omit it.
4. **Untrusted code has no authority.** Ordinary PR jobs receive no secrets and read-only contents.
5. **Fast checks happen early.** Pre-commit catches cheap problems; CI repeats all merge gates.
6. **Failures stay visible.** Logs, reports, traces, and screenshots are retained for diagnosis.
7. **No fictional deployment.** Until Wheelsparrow has a selected hosted target, `main` produces a
   verified local build artifact and does not claim a deployment.

## 2. Branch and Pull-Request Contract

`main` MUST require pull requests and stable required checks. Direct pushes and force pushes are
disabled except for an audited break-glass path. Squash merge is preferred, and the PR title becomes
the commit subject.

PR titles MUST use Conventional Commit form:

```text
<type>(optional-scope): imperative summary
```

Allowed initial types are `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, and `chore`.

Branch protection SHOULD require:

- `validate-pr-title`;
- `ready-for-review-gate`;
- `test`;
- `prompt-contract`;
- `integration`;
- `e2e`;
- `actionlint`; and
- `security`.

It also requires resolved conversations and current-base or merge-queue validation. A sole-maintainer
repository MAY omit mandatory self-approval; the explicit Wheelsparrow product approval gate is
unrelated to GitHub review policy for this repository.

The current names and repository ruleset settings MUST be recorded in this document whenever they
change. Workflow renaming without the matching ruleset update is a release-blocking defect.

## 3. Workflow Shape

The initial workflows are:

```text
.github/workflows/
  pr-title.yml       PR title and ready-for-review metadata checks
  ci.yml             test, prompt-contract, integration, e2e, actionlint
  security.yml       CodeQL and repository secret scan
  main.yml           verified build artifact after merge
  live-smoke.yml     manual disposable-project integration smoke
```

PR metadata checks are separate from commit-bound CI. Editing a title or changing draft state MUST
rerun metadata checks without canceling expensive tests for an unchanged SHA.

`ci.yml` triggers for `pull_request`, `merge_group`, and pushes to `main`. `merge_group` is required
when merge queue is enabled. PR concurrency MAY cancel an older run for the same PR and workflow;
`main` and merge-group runs MUST NOT be canceled merely because another commit appears.

The manual live smoke requires an explicitly configured disposable GitHub repository and project.
It MUST NOT target a real delivery board by default.

## 4. Required Checks

### 4.1 `validate-pr-title`

Runs without checking out PR code. It validates the current title and reports a useful correction.
It reruns on title edits.

### 4.2 `ready-for-review-gate`

Runs without checking out PR code. It fails while the PR is a draft and reruns when the PR changes
draft state. Drafts may receive test feedback but cannot merge accidentally.

### 4.3 `test`

Runs the local agent gate:

```text
make verify-agent
```

That target performs frozen dependency validation, Biome check, TypeScript type checking, unit and
component tests, Markdown checks, and `git diff --check`. CI checks; it never rewrites files.

### 4.4 `prompt-contract`

Runs `make test-prompts`. It validates all three role prompts, their authority boundaries, required
terminal contracts and stop rules, model configuration shape, stable fixture rendering, and prompt
hash generation. It MUST NOT call a model or require credentials.

### 4.5 `integration`

Runs `make test-integration` against:

- a real temporary SQLite file and production migrations;
- temporary Git repositories and worktrees;
- child processes that prove timeout and process-tree termination;
- the stateful GitHub fake; and
- stop/restart reconciliation with duplicate-effect detection.

Tests MUST cover every state transition, dependency filtering, serial dispatch, bounded retry and
repair, PR revision drift, approval invalidation, and Done evidence.

### 4.6 `e2e`

Runs `make test-e2e` with a production server build and Playwright Chromium. It covers:

- queue ordering and blocked reasons;
- one active Todo with multiple Review items;
- run detail logs and findings;
- Return to Todo;
- merge approval for the exact displayed SHA;
- rejection after a simulated head-SHA change; and
- Done only after matching staging and smoke evidence.

On failure it uploads the Playwright report, trace, browser console, and screenshots.

### 4.7 `actionlint`

Runs actionlint, zizmor, and repository workflow-contract tests. The tests parse workflow YAML and
assert:

- required triggers and stable check names exist;
- required jobs cannot skip themselves green;
- `pull_request_target` never executes untrusted PR content;
- actions use immutable full-SHA pins;
- permissions are least privilege;
- untrusted metadata is not interpolated into shell source; and
- main/merge-group runs do not use unsafe cancellation.

These semantic tests are required because syntactically valid workflow YAML can still weaken branch
protection.

### 4.8 `security`

Runs CodeQL for TypeScript and Gitleaks for repository content. It blocks new findings at the
configured severity and always identifies the analyzed SHA. A suppression requires a narrow checked-
in reason; a blanket ignore is forbidden.

Dependency review SHOULD block newly introduced dependencies with disallowed licenses or known
high-severity vulnerabilities. It is additional supply-chain evidence, not a substitute for CodeQL,
Gitleaks, or action pin review.

## 5. Local Commands

The Makefile is the stable interface. A conforming MVP MUST provide:

```text
make setup               install the pinned toolchain and frozen dependencies
make preflight           check Node, pnpm, Git, GitHub, Codex, config, and local paths
make agent-worktree      create or validate an isolated contributor worktree
make fix                 apply Biome and Markdown safe fixes
make verify-agent        run the normal local mirror of the CI test gate
make test-prompts        run deterministic prompt contract tests
make eval-prompts        run opt-in model-backed prompt scenarios
make test-unit           run Vitest unit and component suites
make test-integration    run SQLite, Git, process, and GitHub-fake integration tests
make test-e2e            run Playwright against the production build
make build               build server and browser artifacts
make start               run the production build locally
make live-smoke          exercise a configured disposable GitHub project
```

Targets MUST compose repository scripts rather than hide substantial logic in Make recipes. Local
and CI invocations use the frozen lockfile. `make verify-agent` is the expected check before a PR;
the heavier integration and E2E targets are also required before claiming the complete MVP works.

## 6. Pre-Commit Quality

Pre-commit hooks SHOULD run in this order:

1. file hygiene: trailing whitespace, EOF newline, conflict markers, oversized accidental files;
2. Biome safe fixes and formatting for staged TypeScript, JSON, and CSS;
3. Markdownlint for staged Markdown;
4. Gitleaks on staged content;
5. deterministic prompt-contract checks when prompt or model configuration files change;
6. fast affected unit tests where selection is reliable; and
7. a commit-msg hook for Conventional Commit syntax.

Hooks MUST finish quickly enough to remain enabled. Slow integration, E2E, CodeQL, and live tests
belong in explicit Make targets or CI. Bypassing a hook never bypasses the server-side check.

## 7. Workflow Security

Every workflow declares `permissions: contents: read` or `{}` at top level and grants additional
permissions only to the job that needs them. Test jobs receive no repository, package, cloud, GitHub
Project, or deployment credentials.

Every executed action is pinned to a full commit SHA with a nearby release-tag comment. Dependabot
updates those pins. Floating action tags are forbidden.

`pull_request_target` SHOULD be avoided. If used for metadata checks, the job MUST NOT check out PR
code, execute repository scripts, interpolate PR fields into shell source, or expose secrets.

Issue titles, branch names, PR bodies, commit messages, agent output, and workflow inputs are
untrusted. Workflows pass them through structured inputs or environment variables, never directly
inside generated shell programs.

## 8. Build and Main-Branch Evidence

After the same commit passes required checks on `main`, `main.yml` runs `make build`, performs a
production-start smoke on loopback, and publishes a versioned archive identified by commit SHA. It
also retains dependency metadata sufficient to reproduce the build.

The artifact is a CI diagnostic and local distribution candidate, not a production release. Signing,
SBOM attestation, container publication, semantic version tags, and environment promotion are
deferred until a distribution target is selected.

Main validation MUST NOT rebuild from an unverified different revision or report success before the
server-start smoke completes.

## 9. Dependency Maintenance

Dependabot runs separately for:

- the root pnpm workspace; and
- GitHub Actions.

Updates are grouped conservatively. Patch/minor development-tool updates MAY be grouped; runtime
major versions, SQLite driver changes, GitHub clients, process-control changes, and Playwright browser
updates SHOULD remain separately reviewable.

Automated update PRs run the full gate and are never auto-merged in the MVP. The lockfile MUST be
generated by the pinned pnpm version and CI MUST reject unexpected lockfile drift.

## 10. Evidence and Retention

Failed required jobs upload the smallest useful diagnostic artifact:

- Vitest reports and coverage summaries;
- integration logs with secrets redacted;
- Playwright report, trace, and screenshots;
- workflow-security reports; and
- build/start logs.

Artifacts SHOULD default to 14-day retention for failures and 7 days for routine success. Security
results use GitHub code-scanning retention. Logs MUST NOT include credential values, authorization
headers, raw environment dumps, or unredacted agent secrets.

## 11. Failure and Flake Policy

A required check fails closed. Tests are not automatically retried into green without preserving the
first failure. A confirmed flaky test gets an owner, issue, and bounded quarantine; the replacement
gate must still protect the behavior.

CI infrastructure failure is distinguished from product failure in the UI and logs, but neither is
reported as passing evidence. Re-running a job evaluates the same SHA; changing the SHA invalidates
prior evidence and product approval.

## 12. Adoption Order

The delivery system SHOULD be implemented in this order:

1. Makefile, pnpm lockfile, Biome, TypeScript, Vitest, and `make verify-agent`;
2. PR title/draft checks and protected-branch required names;
3. prompt contracts and pre-commit hooks;
4. real SQLite/Git/process integration tests;
5. Playwright E2E and diagnostic artifacts;
6. workflow-contract tests, CodeQL, Gitleaks, and Dependabot;
7. verified `main` build artifact; and
8. opt-in disposable-project live smoke.

Each step leaves a useful, enforced gate. No step requires a hosted production environment.
