PNPM := corepack pnpm

.PHONY: setup fix lint typecheck test-unit test-prompts verify-policy verify-toolchain verify-agent build preflight dev start smoke-production

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

verify-policy:
	$(PNPM) verify:policy

verify-toolchain:
	$(PNPM) verify:toolchain

verify-agent:
	$(PNPM) verify:agent
	git diff --check

build:
	$(PNPM) build

smoke-production:
	$(PNPM) smoke:production

preflight:
	$(PNPM) tsx scripts/preflight.ts

dev:
	$(PNPM) -r --parallel --stream run dev

start:
	$(PNPM) --filter @wheelsparrow/server start
