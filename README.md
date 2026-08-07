# Wheelsparrow

Wheelsparrow is a local-first SDLC orchestrator. It works an eligible GitHub Project ticket through
an isolated coding-agent run, verification, review, pull request, human approval, staging evidence,
and Done.

## Block 0

The current build provides the pinned workspace, validated configuration, liveness/readiness
endpoints, a minimal browser status page, production build, and CI foundation. Workflow execution is
added in later blocks tracked by `MVP_IMPLEMENTATION_LEDGER.md`.

## Local use

```bash
make setup
make preflight
make build
make start
```

`make preflight` checks GitHub and Codex login without printing credential values. The server binds
to `127.0.0.1:4321` unless `WHEELSPARROW_PORT` selects another local port.

## Verification

```bash
make verify-toolchain
make verify-agent
make build
node scripts/production-smoke.mjs
```

`make verify-toolchain` is a fast, credential-free check that requires the running Node and pnpm
patch versions to match `.node-version` and `packageManager` exactly. `make verify-agent` repeats
that check before dependency installation and the remaining local gates.

The four normative root documents define the MVP contract. The implementation ledger records current
block status and exact evidence.
