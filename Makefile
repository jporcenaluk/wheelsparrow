PNPM := corepack pnpm

.PHONY: setup fix lint typecheck test-unit test-prompts test-integration test-e2e verify-policy verify-toolchain verify-agent verify-workflows actionlint security build preflight dev start smoke-production live-smoke

setup:
	$(PNPM) install --frozen-lockfile

fix:
	$(PNPM) fix

lint:
	$(PNPM) lint

typecheck:
	$(PNPM) typecheck

test-unit:
	$(PNPM) test:unit

test-prompts:
	$(PNPM) test:prompts

test-integration:
	$(PNPM) test:integration

test-e2e:
	$(PNPM) build
	$(PNPM) test:e2e

verify-policy:
	$(PNPM) verify:policy

verify-toolchain:
	$(PNPM) verify:toolchain

verify-agent:
	$(PNPM) verify:agent
	git diff --check

verify-workflows:
	$(PNPM) verify:workflows

actionlint:
	$(PNPM) verify:actionlint

security:
	$(PNPM) verify:security

build:
	$(PNPM) build

smoke-production:
	$(PNPM) smoke:production

live-smoke:
	$(PNPM) live-smoke

preflight:
	$(PNPM) tsx scripts/preflight.ts

dev:
	$(PNPM) -r --parallel --stream run dev

start:
	$(PNPM) --filter @wheelsparrow/server start
