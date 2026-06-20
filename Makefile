.PHONY: help deps build build-widget test test-worktree test-watchdog test-integration e2e e2e-ui clean check format \
        cf-setup cf-dev cf-dev-resolve-config cf-doctor cf-build-web cf-index-docs \
        cf-migrate cf-migrate-test \
        cf-deploy cf-deploy-test cf-deploy-embed cf-deploy-watchdog \
        cf-push-secrets cf-push-secrets-test cf-push-secrets-watchdog \
        cf-init-config cf-init-org cf-render-config cf-render-watchdog-config cf-verify-stub \
        op-doctor secrets-doctor \
        eval eval-site eval-photo eval-photo-dry eval-photo-ingest

# ── Secrets loading ───────────────────────────────────────────────────────────
# Three supported paths, auto-detected by file presence:
#   1. .env.op exists → use 1Password CLI (op run --env-file=.env.op --).
#   2. .env exists    → source it in a wrapper script before each command.
#   3. neither        → trust shell env vars set by the caller.
#
# Every Make recipe that needs CLOUDFLARE_API_TOKEN / AI_GATEWAY_TOKEN /
# SIGNING_SECRET / etc. prefixes its command with $(SECRETS). The recipe stays
# agnostic to where the values came from.
#
# Run `make secrets-doctor` to see which path is active right now.
ifneq ($(wildcard .env.op),)
  SECRETS     := op run --env-file=.env.op --
  SECRETS_SRC := 1Password (.env.op)
else ifneq ($(wildcard .env),)
  SECRETS     := bash scripts/with-env.sh
  SECRETS_SRC := .env file
else
  SECRETS     :=
  SECRETS_SRC := shell environment (no .env.op or .env found)
endif

# ── Worktree-aware compute ────────────────────────────────────────────────────
# WORKTREE_HASH derives from `git rev-parse --show-toplevel` so each git
# worktree gets isolated wrangler state. Two `make cf-dev`s in two worktrees
# get different ports + state dirs. PORT is picked at runtime in the cf-dev
# recipe (free port scan starting at 8787) and persisted to workers/.dev.port
# so cf-stop can target the right process.
#
# Wrangler reads `--persist-to` relative to its cwd. Every wrangler invocation
# that touches local state (cf-dev, cf-setup's migrate, cf-stop's port lookup)
# uses STATE_DIR consistently — otherwise migrations land in a different state
# than cf-dev reads from.
WORKTREE_HASH := $(shell git rev-parse --show-toplevel 2>/dev/null | shasum -a 256 | cut -c1-8)
STATE_DIR     := .wrangler/state-$(WORKTREE_HASH)
EVAL_GRADER   ?= file://evals/cf-gateway-grader.js
EVAL_JUDGE_MODEL ?= workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast

# Default target
help:
	@echo "rescue-bot — Cloudflare Workers"
	@echo ""
	@echo "Development (cf-dev self-bootstraps everything on first run in a worktree):"
	@echo "  make cf-dev            Start local dev server. Picks free port. Worktree-aware."
	@echo "                         Auto-installs deps, generates .dev.vars, builds web/dist,"
	@echo "                         and applies D1 migrations if any are missing."
	@echo "  make cf-stop           Kill THIS worktree's wrangler process"
	@echo "  make cf-doctor         Show what cf-dev would auto-bootstrap on next run"
	@echo "  make build             Build production web UI (auto-run by cf-dev when needed)"
	@echo "  make build-widget      Build standalone embeddable widget"
	@echo ""
	@echo "Secrets:"
	@echo "  Active source:           $(SECRETS_SRC)"
	@echo "  make secrets-doctor      Show which secret-loading path is active"
	@echo "  make op-doctor           Verify the 1Password 'wildcare' vault is ready"
	@echo ""
	@echo "Deployment — test (wildcare-bot-test.<account>.workers.dev):"
	@echo "  make cf-deploy-test       Deploy to wildcare-bot-test"
	@echo "  make cf-push-secrets-test Push secrets to test env"
	@echo "  make cf-migrate-test      Apply D1 migrations to wildcare-db-test"
	@echo ""
	@echo "Deployment — production (wildcaresolutions.org):"
	@echo "  make cf-deploy            Deploy to rescue-bot (prod)"
	@echo "  make cf-deploy-embed      Push versioned widget.js to embed.wildcaresolutions.org R2 bucket"
	@echo "  make cf-push-secrets      Push secrets to prod env"
	@echo "  make cf-migrate           Apply D1 migrations to wildcare-db (prod)"
	@echo "  make cf-index-docs        Index RAG docs into Cloudflare Vectorize"
	@echo ""
	@echo "Watchdog Worker (synthetic /health prober + email alerts):"
	@echo "  make cf-deploy-watchdog        Deploy the watchdog Worker"
	@echo "  make cf-push-secrets-watchdog  Push OPS_EMAIL/OPS_FROM_EMAIL secrets"
	@echo "  make test-watchdog             Run watchdog unit tests"
	@echo ""
	@echo "Evaluations (requires make cf-dev running in another terminal):"
	@echo "  make eval              Run generic safety/accuracy tests"
	@echo "  make eval-site         Run org-specific tests (site/promptfooconfig.yaml)"
	@echo "  make eval-photo-ingest PHOTO_SRC=/path/to/downloaded/email/photos"
	@echo "                         Copy emailed photos into the ignored photo corpus"
	@echo "  make eval-photo-dry    Validate photo corpus labels without model calls"
	@echo "  make eval-photo        Run photo recognizer eval through AI Gateway"
	@echo ""
	@echo "Code quality:"
	@echo "  make test              Run unit tests"
	@echo "  make test-integration  Run integration tests against deployed worker (needs BASE_URL, SIGNING_SECRET, TEST_TENANT_*)"
	@echo "  make check             Run linters"
	@echo "  make format            Run formatters"
	@echo "  make clean             Remove build artifacts"

# ── Dependencies ───────────────────────────────────────────────────────────────

deps:
	@echo "Installing dependencies..."
	@cd web && npm ci
	@cd workers && npm ci
	@echo "✓ Dependencies installed"

# ── Build ──────────────────────────────────────────────────────────────────────

build:
	@cd web && npm run build
	@echo "✓ Built: web/dist/"

build-widget:
	@cd web && npm run build:widget
	@cp web/demo.html web/dist/ 2>/dev/null || true
	@echo "✓ Widget built: web/dist/widget.js"

# ── Tests ──────────────────────────────────────────────────────────────────────

test: test-worktree
	@if [ -f workers/package.json ] && grep -q '"test"' workers/package.json; then \
		cd workers && npm test; \
	else \
		echo "No unit tests configured yet."; \
		echo "See workers/ — add vitest + @cloudflare/vitest-pool-workers to get started."; \
	fi

# Integration tests — fire real HTTP at a live worker. Requires a deployed
# (or local) worker and environment variables:
#   BASE_URL          URL of the target worker (default: http://localhost:8787)
#   TEST_TENANT_SLUG  Slug of an existing tenant row (default: test-org)
#   TEST_TENANT_ID    UUID of that tenant row (default: test-0001-dev-tenant)
#   SIGNING_SECRET    Must match the worker's secret (loaded from .env / .env.op)
# Run `make cf-dev` in a separate terminal to test against a local dev server.
test-integration:
	@echo "Running integration tests against $${BASE_URL:-http://localhost:8787} [secrets: $(SECRETS_SRC)]..."
	@$(SECRETS) sh -c 'cd workers && npm run test:integration'
	@echo "✓ Integration tests complete"

# Worktree-isolation shell test. Asserts `make cf-dev-resolve-config` returns
# distinct ports / hashes / state dirs across two git worktrees, so two
# `make cf-dev` invocations don't collide. Runs in CI alongside vitest.
test-worktree:
	@bash workers/test/worktree-workflow.test.sh

# Watchdog Worker unit tests. Runs in its own infra/watchdog/ vitest setup so
# it doesn't share node_modules or test fixtures with the main worker.
test-watchdog:
	@if [ ! -d infra/watchdog/node_modules ]; then \
		echo "Installing infra/watchdog deps..."; \
		cd infra/watchdog && npm ci --silent; \
	fi
	@cd infra/watchdog && npm test

e2e:
	@npm run e2e

e2e-ui:
	@npm run e2e:ui

# ── Clean ──────────────────────────────────────────────────────────────────────

clean:
	@rm -rf web/dist web/widget-dist web/node_modules
	@rm -rf workers/node_modules workers/src/instructions.ts
	@rm -rf evals/node_modules
	@echo "✓ Clean"

# ── Cloudflare Workers ────────────────────────────────────────────────────────

# ── Wrangler config rendering (PR 3 of dev/test/prod rebuild) ─────────────────
# workers/wrangler.toml is GENERATED from workers/wrangler.template.toml by
# workers/scripts/gen-wrangler.js. The committed wrangler.toml is the STUB
# form (REPLACE_VIA_GEN_WRANGLER placeholders) so IDE TypeScript / wrangler
# types / vitest-pool-workers always have a valid file to read on a fresh
# clone. Every wrangler-touching target in this Makefile depends on
# cf-render-config to overwrite the stub with real values from org.env (or
# CI process.env) before invoking wrangler.

# Interactive: provision CF resources (D1 x3, Vectorize x3, R2 x2) and write
# org.env from prompts. The full fork-and-deploy entry point — replaces a
# half-day of `wrangler d1 create` / paste-IDs-into-org.env yak-shaving.
# Idempotent: re-running after partial setup picks up where it left off.
cf-init-org:
	@if [ -f org.env ]; then \
		echo "org.env already exists. Remove or rename it first."; \
		exit 1; \
	fi
	@node workers/scripts/init-org.js

# Copy org.env.example to org.env if it doesn't exist. Idempotent. Run once
# per fresh clone before anything else CF-related. For an interactive
# resource-creating setup, use cf-init-org instead.
cf-init-config:
	@if [ -f org.env ]; then \
		echo "✓ org.env already exists — skipping."; \
	else \
		cp org.env.example org.env; \
		echo "✓ Created org.env from org.env.example."; \
		echo "  Now edit org.env with your CF account ID, ORG_DOMAIN, and D1 IDs."; \
	fi

# Render workers/wrangler.toml from template + org.env (or process.env in CI).
# Required before any wrangler invocation. Errors loudly if any variable is missing.
cf-render-config:
	@node workers/scripts/gen-wrangler.js
	@git update-index --skip-worktree workers/wrangler.toml 2>/dev/null || true

# Migration-filename lint: refuses duplicate numeric prefixes
# (audit P0-B / #33). Runs in CI and as part of `make check`. Repo state
# was historically dirty (0027_age_class + 0027_tenant_daily_reports both
# numbered 0027); fixed by the renumber commit. This lint stops the
# regression.
check-migrations:
	@bash scripts/check-migrations.sh

# Instruction-genericness lint: refuses jurisdiction-specific content
# (CDFW phone, "1-888-XXXX" patterns) in the bundled agent instruction
# (ralph-1 C3). Per-tenant facts belong in house_rules; the bundled
# instruction is shared across every tenant on every deployment.
check-instructions-generic:
	@bash scripts/check-instructions-generic.sh

# CI guardrail: assert the committed wrangler.toml stubs are byte-identical
# to `gen-wrangler.js --stub` output. Catches drift when someone edits a
# template but forgets to regen the stub. Run in CI; safe to run locally too.
# Checks both the main worker and the watchdog stubs.
cf-verify-stub:
	@node workers/scripts/gen-wrangler.js --stub --stdout > /tmp/wrangler-expected-stub.toml
	@if ! diff -q /tmp/wrangler-expected-stub.toml workers/wrangler.toml > /dev/null; then \
		echo "✘ workers/wrangler.toml is out of sync with the template's stub form."; \
		echo "  Run: node workers/scripts/gen-wrangler.js --stub && git add workers/wrangler.toml"; \
		diff /tmp/wrangler-expected-stub.toml workers/wrangler.toml | head -30; \
		exit 1; \
	fi
	@node workers/scripts/gen-wrangler.js --target watchdog --stub --stdout > /tmp/watchdog-expected-stub.toml
	@if ! diff -q /tmp/watchdog-expected-stub.toml infra/watchdog/wrangler.toml > /dev/null; then \
		echo "✘ infra/watchdog/wrangler.toml is out of sync with the template's stub form."; \
		echo "  Run: node workers/scripts/gen-wrangler.js --target watchdog --stub && git add infra/watchdog/wrangler.toml"; \
		diff /tmp/watchdog-expected-stub.toml infra/watchdog/wrangler.toml | head -30; \
		exit 1; \
	fi
	@echo "✓ Both wrangler.toml stubs match templates."
	@rm -f /tmp/wrangler-expected-stub.toml /tmp/watchdog-expected-stub.toml

# First-time setup: install deps, generate dev config, apply local DB migrations
cf-setup: cf-render-config
	@echo "Installing Workers dependencies..."
	@cd workers && npm ci
	@echo "Installing web dependencies..."
	@cd web && npm ci
	@echo "Generating workers/.dev.vars [secrets: $(SECRETS_SRC)]..."
	@$(SECRETS) node workers/scripts/gen-dev-vars.js
	@echo "Bundling agent instruction into Worker..."
	@node workers/scripts/gen-instructions.js
	@echo "Bundling species guides into Worker..."
	@node workers/scripts/gen-guides.js
	@echo "Applying D1 migrations to local database (state: workers/$(STATE_DIR))..."
	@cd workers && npx wrangler d1 migrations apply wildcare-db-dev --local --persist-to $(STATE_DIR)
	@echo ""
	@echo "✓ Setup complete. Start dev server with: make cf-dev"

# Full reset + rebuild + start dev server. Worktree-aware: only kills wrangler
# processes for THIS worktree (via cf-stop reading workers/.dev.port).
dev: cf-render-config
	@$(MAKE) cf-stop 2>/dev/null || true
	@echo "Installing dependencies..."
	@cd workers && npm ci --silent
	@cd web && npm ci --silent
	@echo "Generating dev config [secrets: $(SECRETS_SRC)]..."
	@$(SECRETS) node workers/scripts/gen-dev-vars.js
	@node workers/scripts/gen-instructions.js
	@node workers/scripts/gen-guides.js
	@echo "Applying D1 migrations (state: workers/$(STATE_DIR))..."
	@cd workers && npx wrangler d1 migrations apply wildcare-db-dev --local --persist-to $(STATE_DIR)
	@echo "Building web frontend..."
	@cd web && npm run build
	@PORT=$$(node -e 'const s=require("net").createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p))})'); \
	echo "$$PORT" > workers/.dev.port; \
	echo ""; \
	echo "  Worktree:  $(WORKTREE_HASH)"; \
	echo "  State:     workers/$(STATE_DIR)"; \
	echo "  Secrets:   $(SECRETS_SRC)"; \
	echo "  Platform:        http://localhost:$$PORT/"; \
	echo "  Platform Admin:  http://localhost:$$PORT/platform-admin"; \
	echo "  WildCare Admin:  http://localhost:$$PORT/?tenant=wildcare"; \
	echo "  Test Tenant:     http://localhost:$$PORT/?tenant=test-org"; \
	echo ""; \
	echo "  Test tenant login: test@test.com (no password in dev)"; \
	echo ""
	@PORT=$$(cat workers/.dev.port); cd workers && $(SECRETS) npx wrangler dev --port $$PORT --persist-to $(STATE_DIR)

# Start local dev server. Worktree-aware: picks a free port, isolates wrangler
# state per worktree so two `make cf-dev`s in two worktrees don't collide.
cf-dev: cf-render-config
	@# Self-bootstrap: every prerequisite that can be generated automatically
	@# is generated here. Fresh worktree → `make cf-dev` should Just Work.
	@# `make cf-doctor` prints what's missing without side effects.
	@if [ ! -f "org.env" ]; then \
		echo "ERROR: org.env not found at repo root. Run: make cf-init-config (then edit org.env)"; \
		exit 1; \
	fi
	@if [ ! -d "workers/node_modules" ]; then \
		echo "Installing Workers dependencies (workers/node_modules is empty)..."; \
		cd workers && npm ci --silent; \
	fi
	@if [ ! -d "web/node_modules" ]; then \
		echo "Installing web dependencies (web/node_modules is empty)..."; \
		cd web && npm ci --silent; \
	fi
	@if [ ! -f "workers/.dev.vars" ]; then \
		if [ -z "$(SECRETS)" ] && [ ! -f ".env" ] && [ ! -f ".env.op" ]; then \
			echo "ERROR: workers/.dev.vars missing and no secret source configured."; \
			echo "  Either: copy .env.example to .env and fill in values"; \
			echo "      or: copy .env.op.example to .env.op (1Password reference template)"; \
			exit 1; \
		fi; \
		echo "Generating workers/.dev.vars [secrets: $(SECRETS_SRC)]..."; \
		$(SECRETS) node workers/scripts/gen-dev-vars.js; \
	fi
	@if [ ! -d "web/dist" ] || [ ! -f "web/dist/index.html" ]; then \
		echo "Building web assets (web/dist/ is empty)..."; \
		$(MAKE) build; \
	fi
	@# Always run migrations apply — it's idempotent (wrangler tracks applied
	@# migrations in d1_migrations). The dir-existence check was wrong because
	@# `wrangler dev` creates the state dir lazily on first DB hit, so an
	@# aborted-mid-startup leaves an empty state dir that the dir-check then
	@# falsely reports as "migrated."
	@echo "Applying D1 migrations (idempotent; state: workers/$(STATE_DIR))..."
	@cd workers && npx wrangler d1 migrations apply wildcare-db-dev --local --persist-to $(STATE_DIR)
	@echo "Bundling agent instruction..."
	@node workers/scripts/gen-instructions.js
	@echo "Bundling species guides..."
	@node workers/scripts/gen-guides.js
	@PORT=$$(node -e 'const s=require("net").createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p))})'); \
	echo "$$PORT" > workers/.dev.port; \
	echo ""; \
	echo "  Worktree:  $(WORKTREE_HASH)"; \
	echo "  State:     workers/$(STATE_DIR)"; \
	echo "  Secrets:   $(SECRETS_SRC)"; \
	echo "  URL:       http://localhost:$$PORT"; \
	echo "  Stop:      make cf-stop"; \
	echo ""
	@PORT=$$(cat workers/.dev.port); cd workers && $(SECRETS) npx wrangler dev --port $$PORT --persist-to $(STATE_DIR)

# Show what cf-dev would auto-bootstrap on next run. Read-only — no side
# effects. Use this when cf-dev fails or you want to know what the worktree
# is missing before starting.
cf-doctor:
	@echo "Worktree audit — what cf-dev would do on next run:"
	@echo ""
	@echo "  Secret source: $(SECRETS_SRC)"
	@if [ -f ".env.op" ]; then echo "  ✓ .env.op exists (1Password references — values resolved via op run)"; \
	elif [ -f ".env" ]; then echo "  ✓ .env exists (plain dotenv values)"; \
	else echo "  ✘ Neither .env.op nor .env found — cf-dev needs one or env vars exported"; fi
	@if [ -f "org.env" ]; then echo "  ✓ org.env exists"; else echo "  ✘ org.env MISSING (cf-dev will refuse; run: make cf-init-config)"; fi
	@if [ -d "workers/node_modules" ]; then echo "  ✓ workers/node_modules ready"; else echo "  ⚙ workers/node_modules missing (cf-dev will run npm ci)"; fi
	@if [ -d "web/node_modules" ]; then echo "  ✓ web/node_modules ready"; else echo "  ⚙ web/node_modules missing (cf-dev will run npm ci)"; fi
	@if [ -f "workers/.dev.vars" ]; then echo "  ✓ workers/.dev.vars exists"; else echo "  ⚙ workers/.dev.vars missing (cf-dev will run gen-dev-vars.js)"; fi
	@if [ -d "web/dist" ] && [ -f "web/dist/index.html" ]; then echo "  ✓ web/dist built"; else echo "  ⚙ web/dist missing (cf-dev will run make build)"; fi
	@echo "  ⚙ Local D1 migrations always re-apply on cf-dev (idempotent — wrangler tracks state)"
	@echo ""
	@echo "  Worktree:  $(WORKTREE_HASH)"
	@echo "  State:     workers/$(STATE_DIR)"
	@echo ""
	@echo "  For 1Password vault verification: make op-doctor"
	@echo "  For active secrets source detail: make secrets-doctor"

# Echo the resolved worktree config WITHOUT starting wrangler. Used by the
# worktree-workflow shell test to assert that two worktrees get different
# ports/hashes/state-dirs. Also useful as a debug aid: "what would cf-dev do?"
cf-dev-resolve-config:
	@PORT=$$(node -e 'const s=require("net").createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p))})'); \
	echo "WORKTREE_ROOT=$$(git rev-parse --show-toplevel)"; \
	echo "WORKTREE_HASH=$(WORKTREE_HASH)"; \
	echo "STATE_DIR=workers/$(STATE_DIR)"; \
	echo "PORT=$$PORT"

# Kill the wrangler process for THIS worktree only. Reads the port from
# workers/.dev.port (written by cf-dev). Doesn't touch wrangler processes
# in sibling worktrees.
cf-stop:
	@PORT=$$(cat workers/.dev.port 2>/dev/null); \
	if [ -z "$$PORT" ]; then \
		echo "No workers/.dev.port — cf-dev not running for this worktree, or already stopped."; \
		exit 0; \
	fi; \
	PIDS=$$(lsof -ti:$$PORT 2>/dev/null); \
	if [ -n "$$PIDS" ]; then \
		echo "$$PIDS" | xargs kill 2>/dev/null && echo "✓ Stopped wrangler on port $$PORT (worktree $(WORKTREE_HASH))" || true; \
	else \
		echo "No process listening on port $$PORT (stale .dev.port — cleaning up)"; \
	fi; \
	rm -f workers/.dev.port

# Build web frontend only
cf-build-web:
	@cd web && npm run build
	@echo "✓ Built: web/dist/"

# Index RAG docs into Cloudflare Vectorize (run once, or after adding new docs)
cf-index-docs:
	@echo "Indexing docs into Cloudflare Vectorize..."
	@node workers/scripts/index-docs.js
	@echo "✓ Done"

# Apply D1 migrations to production.
# $(SECRETS) must resolve in the repo-root cwd where .env.op / .env live, so
# the cd-into-workers happens INSIDE a child shell after the wrapper has
# already set the env. (Old pattern `cd workers && $(SECRETS) ...` broke
# because op run reads its env-file relative to the new cwd.)
cf-migrate: cf-render-config
	@echo "Applying D1 migrations to wildcare-db (production) [secrets: $(SECRETS_SRC)]..."
	@$(SECRETS) sh -c 'cd workers && npx wrangler d1 migrations apply wildcare-db --env production --remote'
	@echo "✓ Migrations applied"

# Apply D1 migrations to test
cf-migrate-test: cf-render-config
	@echo "Applying D1 migrations to wildcare-db-test [secrets: $(SECRETS_SRC)]..."
	@$(SECRETS) sh -c 'cd workers && npx wrangler d1 migrations apply wildcare-db-test --env test --remote'
	@echo "✓ Migrations applied (test)"

# Deploy Worker + static assets to Cloudflare (production).
# Migrations run BEFORE the deploy — schema must be compatible with the
# new code before traffic hits it. (D1 migrations are forward-only and
# adding columns/tables doesn't break the old code, so this ordering
# stays safe in the small window between migrate and deploy.)
cf-deploy: cf-migrate
	@echo "Bundling agent instruction..."
	@node workers/scripts/gen-instructions.js
	@echo "Bundling species guides..."
	@node workers/scripts/gen-guides.js
	@echo "Building web frontend..."
	@cd web && npm run build
	@echo "Deploying to Cloudflare (production) [secrets: $(SECRETS_SRC)]..."
	@$(SECRETS) sh -c 'cd workers && npx wrangler deploy --env production'
	@echo "Deploying widget to R2 embed CDN..."
	@$(SECRETS) node workers/scripts/deploy-embed.js
	@echo "✓ Deployed (production)"

# Deploy Worker + static assets to test (migrations applied first).
cf-deploy-test: cf-migrate-test
	@echo "Bundling agent instruction..."
	@node workers/scripts/gen-instructions.js
	@echo "Bundling species guides..."
	@node workers/scripts/gen-guides.js
	@echo "Building web frontend..."
	@cd web && npm run build
	@echo "Deploying to Cloudflare (test) [secrets: $(SECRETS_SRC)]..."
	@$(SECRETS) sh -c 'cd workers && npx wrangler deploy --env test'
	@echo "✓ Deployed (test)"

# Build widget and publish to R2 with versioned URLs
cf-deploy-embed:
	@$(SECRETS) node workers/scripts/deploy-embed.js

# Push secrets to production. Reads values from the active SECRETS source
# (1Password or .env), then pipes each one to `wrangler secret put`. Secret
# names are baked into scripts/push-secrets.sh so the list lives in one place.
cf-push-secrets:
	@echo "Pushing secrets [source: $(SECRETS_SRC)]..."
	@$(SECRETS) bash scripts/push-secrets.sh production main

# Push secrets to test
cf-push-secrets-test:
	@echo "Pushing secrets [source: $(SECRETS_SRC)]..."
	@$(SECRETS) bash scripts/push-secrets.sh test main

# ── Watchdog Worker (infra/watchdog/) ─────────────────────────────────────────
# Independent failure domain. Deploys separately from the main worker. Probes
# /health every 5 minutes and emails OPS_EMAIL on outage. See infra/watchdog/
# and workers/observability/dashboard-spec.md.

# Render the watchdog wrangler.toml from its template + org.env. Required
# before deploy when org.env values change. Same pattern as cf-render-config
# but limited to the watchdog target so a fork without WATCHDOG_* values
# can still render the main worker.
cf-render-watchdog-config:
	@node workers/scripts/gen-wrangler.js --target watchdog

# Deploy the watchdog Worker.
cf-deploy-watchdog: cf-render-watchdog-config
	@echo "Deploying watchdog Worker [secrets: $(SECRETS_SRC)]..."
	@$(SECRETS) sh -c 'cd infra/watchdog && npx wrangler deploy'
	@echo "✓ Deployed (watchdog)"

# Push watchdog secrets (OPS_EMAIL, OPS_FROM_EMAIL) to the watchdog Worker.
# Distinct from cf-push-secrets — different worker, different secret set.
# OPS_EMAIL is the operator's address, distinct from tenant daily-report
# recipients configured in the dashboard.
cf-push-secrets-watchdog:
	@echo "Pushing watchdog secrets [source: $(SECRETS_SRC)]..."
	@$(SECRETS) bash scripts/push-secrets.sh production watchdog

# ── Evaluations ───────────────────────────────────────────────────────────────
# Requires `make cf-dev` running in another terminal.

_check-dev-running:
	@if ! curl -s http://localhost:8787/health > /dev/null 2>&1; then \
		echo "ERROR: Dev server not running."; \
		echo "Start it in another terminal with: make cf-dev"; \
		exit 1; \
	fi

_check-eval-gateway:
	@$(SECRETS) sh -c 'if [ -z "$$AI_GATEWAY_TOKEN" ]; then \
		echo "ERROR: AI_GATEWAY_TOKEN not set in $(SECRETS_SRC)."; \
		echo "  Add AI_GATEWAY_TOKEN to .env or .env.op (and the wildcare vault)."; \
		exit 1; \
	fi'
	@if [ -z "$$CLOUDFLARE_ACCOUNT_ID" ] && [ -z "$$ACCOUNT_ID" ] && ! grep -q "^ACCOUNT_ID=" org.env 2>/dev/null; then \
		echo "ERROR: ACCOUNT_ID not set (required for Cloudflare AI Gateway judge)."; \
		echo "Add ACCOUNT_ID to org.env or export CLOUDFLARE_ACCOUNT_ID"; \
		exit 1; \
	fi

_check-eval-deps:
	@if [ ! -x "evals/node_modules/.bin/promptfoo" ]; then \
		echo "Installing eval deps..."; \
		cd evals && npm ci --silent; \
	fi

# Run generic safety/accuracy evals. ACCOUNT_ID + AI_GATEWAY_ID + the
# *_BYOK_ALIAS values come from org.env (non-secret config); AI_GATEWAY_TOKEN
# comes from the active SECRETS source.
eval: _check-dev-running _check-eval-gateway _check-eval-deps
	@echo "Running generic evals against http://localhost:8787 [secrets: $(SECRETS_SRC)]..."
	@CLOUDFLARE_ACCOUNT_ID=$${CLOUDFLARE_ACCOUNT_ID:-$${ACCOUNT_ID:-$$(grep "^ACCOUNT_ID=" org.env 2>/dev/null | cut -d= -f2-)}}; \
	CLOUDFLARE_GATEWAY_ID=$${CLOUDFLARE_GATEWAY_ID:-$${AI_GATEWAY_ID:-$$(grep "^AI_GATEWAY_ID=" org.env 2>/dev/null | cut -d= -f2-)}}; \
	AI_GATEWAY_ANTHROPIC_BYOK_ALIAS=$${AI_GATEWAY_ANTHROPIC_BYOK_ALIAS:-$$(grep "^AI_GATEWAY_ANTHROPIC_BYOK_ALIAS=" org.env 2>/dev/null | cut -d= -f2-)}; \
	CLOUDFLARE_ACCOUNT_ID="$$CLOUDFLARE_ACCOUNT_ID" \
	CLOUDFLARE_GATEWAY_ID="$${CLOUDFLARE_GATEWAY_ID:-default}" \
	AI_GATEWAY_ANTHROPIC_BYOK_ALIAS="$$AI_GATEWAY_ANTHROPIC_BYOK_ALIAS" \
	EVAL_JUDGE_MODEL="$(EVAL_JUDGE_MODEL)" \
		$(SECRETS) ./evals/node_modules/.bin/promptfoo eval --grader $(EVAL_GRADER)
	@echo "View results: ./evals/node_modules/.bin/promptfoo view"

# Run org-specific evals
eval-site: _check-dev-running _check-eval-gateway _check-eval-deps
	@if [ ! -f "site/promptfooconfig.yaml" ]; then \
		echo "ERROR: site/promptfooconfig.yaml not found"; \
		exit 1; \
	fi
	@echo "Running site-specific evals against http://localhost:8787 [secrets: $(SECRETS_SRC)]..."
	@CLOUDFLARE_ACCOUNT_ID=$${CLOUDFLARE_ACCOUNT_ID:-$${ACCOUNT_ID:-$$(grep "^ACCOUNT_ID=" org.env 2>/dev/null | cut -d= -f2-)}}; \
	CLOUDFLARE_GATEWAY_ID=$${CLOUDFLARE_GATEWAY_ID:-$${AI_GATEWAY_ID:-$$(grep "^AI_GATEWAY_ID=" org.env 2>/dev/null | cut -d= -f2-)}}; \
	AI_GATEWAY_ANTHROPIC_BYOK_ALIAS=$${AI_GATEWAY_ANTHROPIC_BYOK_ALIAS:-$$(grep "^AI_GATEWAY_ANTHROPIC_BYOK_ALIAS=" org.env 2>/dev/null | cut -d= -f2-)}; \
	CLOUDFLARE_ACCOUNT_ID="$$CLOUDFLARE_ACCOUNT_ID" \
	CLOUDFLARE_GATEWAY_ID="$${CLOUDFLARE_GATEWAY_ID:-default}" \
	AI_GATEWAY_ANTHROPIC_BYOK_ALIAS="$$AI_GATEWAY_ANTHROPIC_BYOK_ALIAS" \
	EVAL_JUDGE_MODEL="$(EVAL_JUDGE_MODEL)" \
		$(SECRETS) ./evals/node_modules/.bin/promptfoo eval -c site/promptfooconfig.yaml --grader $(EVAL_GRADER)
	@echo "View results: ./evals/node_modules/.bin/promptfoo view"

# Validate the local photo corpus without making model calls. The working
# labels file is intentionally gitignored; fall back to the committed example
# so fresh clones can verify the harness.
eval-photo-ingest:
	@SRC="$${PHOTO_SRC:-evals/photo/inbox}"; \
	SOURCE="$${PHOTO_SOURCE:-email-import}"; \
	CAPTION="$${PHOTO_CAPTION:-}"; \
	node evals/photo/ingest-photos.mjs --src "$$SRC" --source "$$SOURCE" --caption "$$CAPTION" $${PHOTO_INGEST_ARGS:-}

eval-photo-dry:
	@LABELS="evals/photo/labels.jsonl"; \
	ALLOW_MISSING=""; \
	if [ ! -f "$$LABELS" ]; then \
		LABELS="evals/photo/labels.example.jsonl"; \
		ALLOW_MISSING="--allow-missing-fixtures"; \
	fi; \
	node evals/photo/run-photo-eval.mjs --dry-run $$ALLOW_MISSING --labels "$$LABELS"

# Run the photo recognizer eval against Cloudflare AI Gateway. This spends
# model tokens. Set PHOTO_EVAL_MODELS to compare multiple providers.
eval-photo:
	@if [ ! -f "evals/photo/labels.jsonl" ]; then \
		echo "ERROR: evals/photo/labels.jsonl not found."; \
		echo "Copy evals/photo/labels.example.jsonl to labels.jsonl and add real fixtures."; \
		exit 1; \
	fi
	@$(SECRETS) sh -c 'if [ -z "$$AI_GATEWAY_TOKEN" ]; then \
		echo "ERROR: AI_GATEWAY_TOKEN not set in $(SECRETS_SRC)."; \
		exit 1; \
	fi; node evals/photo/run-photo-eval.mjs --labels evals/photo/labels.jsonl'

# ── Code quality ──────────────────────────────────────────────────────────────

check:
	@echo "Running linters..."
	@cd web && npm run lint 2>/dev/null || echo "  (no web linter configured)"
	@cd workers && npm run lint 2>/dev/null || echo "  (no workers linter configured)"
	@$(MAKE) check-migrations
	@$(MAKE) check-instructions-generic

format:
	@echo "Formatting code..."
	@cd web && npm run format 2>/dev/null || echo "  (no web formatter configured)"
	@cd workers && npm run format 2>/dev/null || echo "  (no workers formatter configured)"

# ── Secrets diagnostics ───────────────────────────────────────────────────────

# Show which secret-loading path is active for this worktree. Read-only.
secrets-doctor:
	@echo "Secret loading config:"
	@echo "  Active source:  $(SECRETS_SRC)"
	@echo "  Wrapper:        $(if $(SECRETS),$(SECRETS),(none — env must be exported manually))"
	@echo ""
	@if [ -f ".env.op" ]; then echo "  ✓ .env.op present (1Password references)"; fi
	@if [ -f ".env" ]; then echo "  ✓ .env present (plain dotenv values)"; fi
	@if [ ! -f ".env.op" ] && [ ! -f ".env" ]; then \
		echo "  ✘ No secret source file. Pick ONE:"; \
		echo "      cp .env.op.example .env.op    # 1Password (recommended for WildCare ops)"; \
		echo "      cp .env.example .env          # plain dotenv (forker default)"; \
	fi

# Verify the 1Password vault is set up correctly — items exist, required
# fields are non-empty. Read-only. Safe to run anytime.
op-doctor:
	@bash scripts/op-doctor.sh
