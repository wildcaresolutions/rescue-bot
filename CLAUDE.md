# rescue-bot

Open-source AI-powered wildlife rescue assistant. The engine behind WildCare Solutions (wildcaresolutions.org); deployable by any wildlife rehabilitation organization.

**Naming note:** The OSS project is **rescue-bot**. WildCare Solutions' production deployment of it keeps the legacy `wildcare-bot` / `wildcare-db` / etc. worker and resource names — those will be parameterized for forking orgs in a follow-up task. Don't be confused by the two names coexisting.

## Architecture

```
Browser → Cloudflare Workers
            ├── /           → Static assets (Vite-built UI, served via Workers Assets)
            ├── /api/*      → Chat sessions, messages, feedback
            └── /admin/*    → Admin console (session viewer, stats)
```

Everything runs in a single Cloudflare Worker:
- **Runtime**: TypeScript + Hono framework (`workers/src/index.ts`)
- **Database**: Cloudflare D1 (SQLite) — sessions, messages, feedback
- **Vector search**: Cloudflare Vectorize (768d, cosine) — RAG over rescue guides
- **Embeddings**: Workers AI `@cf/baai/bge-base-en-v1.5`
- **LLM**: `@ai-sdk/openai` pointed at Cloudflare AI Gateway `/compat`, streamed via Vercel AI SDK
- **Static assets**: Web UI built with Vite, served by Workers Assets

## Quick Start

```bash
# 1. Configure site
cp -r site.example/ site/
# Edit site/site.yaml with your org details

# 2. Configure org-specific deploy values (CF account, domain, D1 IDs)
#    Two paths — pick one:
#    a) `make cf-init-org`     interactive: prompts + creates D1/Vectorize/R2 + writes org.env
#    b) `make cf-init-config`  manual: copies org.env.example, you edit the 6 values yourself
make cf-init-org               # if you don't have CF resources yet (recommended for forks)
# OR
make cf-init-config && $EDITOR org.env   # if resources already exist (Critter's local case)

# 3. Configure environment
cp .env.example .env
# Add: AI_GATEWAY_TOKEN, CLOUDFLARE_API_TOKEN

# 4. First-time setup (deps + local DB + instruction bundle + render wrangler.toml)
make cf-setup

# 5. Start dev server
make cf-dev
# Picks a free port, echoes it. Open the URL it prints.
```

## Working with multiple worktrees

`make cf-dev` is worktree-aware. Each git worktree gets its own port (free
port scan starting near 8787) and its own local wrangler state at
`workers/.wrangler/state-<hash>/`, where `<hash>` is derived from
`git rev-parse --show-toplevel`. Run `make cf-dev` in two worktrees
simultaneously — they don't collide.

`make cf-stop` reads `workers/.dev.port` (written by cf-dev) and kills only
THIS worktree's wrangler process. Sibling worktree wranglers are unaffected.

`make cf-dev-resolve-config` echoes the computed `PORT`/`WORKTREE_HASH`/
`STATE_DIR` without booting wrangler — handy for debugging "what would
cf-dev pick right now?".

One-server-per-worktree invariant: don't run two `make cf-dev`s from the
SAME worktree concurrently. They race on `.dev.port`. Use separate worktrees
if you want two servers.

Compromise: only LOCAL miniflare state is isolated. Bindings flagged
`remote = true` in `wrangler.toml` (Vectorize, AI) hit shared remote infra
across worktrees. Acceptable for dev — those operations are read-mostly.

## Site Configuration

`site/` holds DEPLOYMENT-wide (not per-tenant) defaults:

```
site/
├── site.yaml              # Web-UI defaults (name, theme, password) — Vite build time
├── agent-instruction.md   # GENERIC bot guidance (no org-specific facts)
├── resources/             # Generic RAG docs shared across tenants
├── branding/logo.svg      # Deployment-default logo
└── promptfooconfig.yaml   # Deployment-default test scenarios
```

`site.yaml` values are injected into the web UI at Vite build time via `__SITE_CONFIG__`.

The agent instruction is bundled into the Worker at build time via `workers/scripts/gen-instructions.js` → `workers/src/instructions.ts` (gitignored). This gets freshly generated on every `make cf-dev` and `make cf-deploy`.

### Per-tenant content (NOT in `site/`)

This Worker serves multiple tenants. Per-tenant content lives in the `tenants` row, not in any file:

- **Structured config** → `org_config` JSON column. Includes `species_config`, `custom_species`, `triage_config`, `hours`, `after_hours_phone`, `redirect_info`, `emergency_contacts`, `intake_procedures`. Edited via the Playbook tab in admin UI; compiled into `custom_instruction` by `workers/src/lib/compile-instruction.ts:compileInstruction()` on every save.
- **Tenant fields** → tenants table columns: `phone`, `email`, `url`, `location_county`, `location_state`, `location_service_area`, `color_*`. Edited via Settings tab.
- **Operator-pinned prose** → `house_rules` column (10000-char cap, appended verbatim to compiled prompt by `recompileAndMaybeWrite()`). This is where org-specific protocols, redirect rules, species restrictions, and any narrative guidance live.
- **Locked / hand-tuned prompts** → `custom_instruction` directly (when `custom_instruction_locked=1`; Lock-1 migration is unwinding this).

**NEVER put org-specific facts in `site/agent-instruction.md`.** It bundles into every Worker deployment and leaks across tenants. Migration `0031_unbundle_site_to_wildcare.sql` moved the wildcare-specific content out of that file into the wildcare tenant's `house_rules`. The file is now a generic placeholder for any deployment-wide guidance that legitimately applies to all tenants.

If a new tenant's onboarding requires substantial protocol text (e.g., species restrictions, redirect policy), the operator pastes it into the Playbook → House Rules editor in the admin UI. Not into `site/agent-instruction.md`.

`workers/wrangler.toml` is GENERATED from `workers/wrangler.template.toml` by `workers/scripts/gen-wrangler.js`, using values from `org.env` (locally) or typed CI secrets (`process.env`). The committed `wrangler.toml` is the STUB form (`REPLACE_VIA_GEN_WRANGLER` placeholders) so IDE TypeScript / `wrangler types` / vitest-pool-workers always have a valid file to read on a fresh clone. Every wrangler-touching Make target runs `cf-render-config` first to overwrite the stub with real values. CI's `verify-stub` job catches drift if you edit the template without regenerating the stub (run `node workers/scripts/gen-wrangler.js --stub` to regen).

## Directory Structure

```
wildcare-bot/
├── site/                          # Org-specific customizations
├── site.example/                  # Template for new deployments
├── agents/
│   └── rescue-bot-instruction.md   # Agent system prompt (generic)
├── resources/                     # Generic RAG knowledge base (20+ guides)
├── workers/
│   ├── src/
│   │   ├── index.ts               # Main Worker (Hono, all routes)
│   │   ├── instructions.ts        # Auto-generated (gitignored)
│   │   ├── guides.ts              # Auto-generated guide manifest (gitignored)
│   │   └── lib/
│   │       ├── rag.ts             # Shared RAG pipeline (species detection, query expansion, search)
│   │       ├── compile-instruction.ts  # Compile structured org config into LLM instruction
│   │       ├── triage-defaults.ts      # Default triage rules (8 builtin rules)
│   │       ├── safe-sql.ts        # AST-grade validator for run_analytics_query (P0-C)
│   │       ├── safe-url.ts        # SSRF defense + safeFetch for outbound calls (P0-D)
│   │       ├── css-sanitize.ts    # Operator widget-CSS sanitizer (P1-21)
│   │       ├── file-type.ts       # Magic-byte MIME sniffer for photo uploads (P1-22)
│   │       ├── pii-redact.ts      # PII scrubbing for cross-boundary surfaces (P3-30)
│   │       ├── logger.ts          # Structured JSON logging + PII scrub (#34)
│   │       ├── tenant-loader.ts   # loadTenantBySlug/ById + parseOrgConfig (P2-25)
│   │       ├── errors.ts          # dbError / notFound / ... response helpers (P2-25)
│   │       └── platform.ts        # getPlatformName(env) — brand-name resolver (#32)
│   ├── migrations/                # D1 SQL migrations
│   ├── scripts/
│   │   ├── gen-instructions.js    # Bundle site instruction into Worker
│   │   ├── gen-guides.js          # Bundle species guides into Worker
│   │   ├── gen-dev-vars.js        # Generate workers/.dev.vars for local dev
│   │   └── index-docs.js          # Index RAG docs into Vectorize
│   └── wrangler.toml              # Cloudflare Workers config
├── web/src/
│   ├── main.js                    # Chat UI entry point
│   ├── admin.js                   # Admin console UI
│   ├── api.js                     # API client (Workers API)
│   ├── auth.js                    # Password auth (from site.yaml)
│   ├── widget.js                  # Embeddable widget
│   ├── config.js                  # App constants
│   └── services/                  # queue, storage, session, export
├── evals/
│   └── provider.js                # Promptfoo provider (Workers)
├── infra/
│   └── watchdog/                  # Independent cron Worker probing /health (5-min cron, KV-backed dedupe, OPS_EMAIL alerts). See infra/watchdog/README.md.
├── promptfooconfig.yaml           # Generic test scenarios
├── Makefile                       # All commands
└── README.md                      # User-facing docs
```

## Makefile Commands

```bash
make help              # Show all commands

# Setup
make cf-init-org            # Interactive fork setup: prompts + creates CF resources + writes org.env
make cf-init-config         # Manual fork setup: copy org.env.example -> org.env (you fill in)
make cf-setup               # First-time setup (deps + local DB + render wrangler.toml)
make deps                   # Install npm dependencies only

# Development
make cf-dev                  # Start wrangler dev (worktree-aware, free port)
make cf-dev-resolve-config   # Echo computed PORT/HASH/STATE_DIR (no wrangler boot)
make cf-stop                 # Kill THIS worktree's wrangler only
make build                   # Build production web UI
make build-widget            # Build embeddable widget

# Wrangler config (PR 3 of dev/test/prod rebuild)
make cf-render-config       # Render workers/wrangler.toml from template + org.env
make cf-verify-stub         # CI guardrail: assert committed stub matches template

# Deployment — test (wildcare-bot-test.<account>.workers.dev)
make cf-deploy-test         # Deploy to test env (auto-renders config)
make cf-push-secrets-test   # Push secrets to test env
make cf-migrate-test        # Apply D1 migrations to test env

# Deployment — production
make cf-deploy              # Deploy to production
make cf-push-secrets        # Push secrets from .env to Cloudflare
make cf-migrate             # Apply D1 migrations to production
make cf-index-docs          # Index RAG docs into Vectorize

# Evaluations (make cf-dev must be running)
make eval              # Run generic test scenarios
make eval-site         # Run org-specific test scenarios
```

## Environment Variables

Required in `.env`:
```bash
AI_GATEWAY_TOKEN=...             # For Cloudflare AI Gateway
CLOUDFLARE_API_TOKEN=...         # For deployment
```

Optional:
```bash
SIGNING_SECRET=...               # HMAC secret for token signing
REPORT_FROM_EMAIL=...            # Report sender
EVAL_JUDGE_MODEL=workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

Daily report recipients are configured per tenant in the admin dashboard.

Bindings (configured in `wrangler.toml`, not `.env`):
```bash
EMAIL                            # CF send_email binding for magic link auth (requires Email Routing on domain)
```

## Key Behaviors

- Site config is injected into web UI at Vite build time via `__SITE_CONFIG__`
- Agent instruction is bundled into the Worker at build time (not a CF secret — too large)
- Auth: magic link via Cloudflare Email Routing (no more password auth for new tenants)
  - `/api/auth/request` sends a magic link email
  - `/api/auth/verify` validates the token and creates a session
- Admin routes require admin-level token (from `/api/admin-login` or magic link with admin user)
- CSS uses `--site-primary`, `--site-secondary`, `--site-accent` custom properties
- Cookie/localStorage keys use configurable prefix (`wc_<slug>`)
- Structured KB: `org_config` JSON stores `species_config`, `custom_species`, `triage_config`
- `compile-instruction.ts` compiles structured org config + bot overrides into LLM system prompt text
- `triage_config` is used by `quickAnalyzeSession` for dashboard triage, NOT compiled into the LLM instruction

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Probes D1 + Vectorize + R2; 200 healthy, 503 if any check fails. Probed by `infra/watchdog/`. |
| `POST` | `/api/auth/request` | None | Request magic link email |
| `GET` | `/api/auth/verify` | None | Verify magic link token, create session |
| `GET` | `/api/auth/me` | Bearer | Get current user profile |
| `PUT` | `/api/auth/me` | Bearer | Update current user profile |
| `GET` | `/api/auth/users` | Admin | List tenant users |
| `POST` | `/api/auth/users` | Admin | Invite user (send magic link) |
| `DELETE` | `/api/auth/users/:userId` | Admin | Remove user |
| `POST` | `/api/login` | None | Legacy password login |
| `POST` | `/api/admin-login` | None | Legacy admin password login |
| `GET` | `/api/config` | None/Bearer | Runtime config (public fields + authed fields) |
| `POST` | `/api/sessions` | Public | Create session |
| `GET` | `/api/sessions/:id` | Public | Get session + history |
| `POST` | `/api/sessions/:id` | Public | Send message (streaming) |
| `POST` | `/api/messages` | Public | Save message metadata |
| `POST` | `/api/feedback` | Public | Save feedback rating |
| `POST` | `/api/errors` | None | Client error reporting |
| `GET` | `/admin/dashboard` | Admin | Dashboard with action items + triage |
| `GET` | `/admin/bot-status` | Admin | Bot readiness status |
| `GET` | `/admin/knowledge-base` | Admin | List all builtin guides + custom protocols |
| `POST` | `/admin/rag-search` | Admin | Search knowledge base via RAG pipeline |
| `POST` | `/admin/triage/test` | Admin | Test a sample message against triage rules |
| `GET` | `/admin/sessions` | Admin | List all sessions |
| `GET` | `/admin/sessions/:id` | Admin | Get session detail |
| `POST` | `/admin/sessions/:sessionId/resolve` | Admin | Resolve action item |
| `GET` | `/admin/stats` | Admin | Aggregate stats |
| `GET` | `/admin/stats/timeseries` | Admin | Stats over time |
| `GET` | `/admin/stats/overview` | Admin | Overview stats for reports tab |
| `POST` | `/admin/report` | Admin | Trigger daily report |
| `POST` | `/admin/embed` | Admin | Generate embed code |
| `GET` | `/admin/domains` | Admin | List allowed domains |
| `POST` | `/admin/domains` | Admin | Add allowed domain |
| `DELETE` | `/admin/domains/:id` | Admin | Remove allowed domain |
| `GET` | `/admin/evals` | Admin | List test scenarios |
| `POST` | `/admin/evals` | Admin | Create test scenario |
| `DELETE` | `/admin/evals/:id` | Admin | Delete test scenario |
| `POST` | `/admin/evals/auto-generate` | Admin | Auto-generate test scenarios |
| `POST` | `/admin/evals/:id/run` | Admin | Run a test scenario |
| `GET` | `/admin/evals/:id/results` | Admin | Get test results |
| `POST` | `/admin/agent` | Admin | Copilot agent (streaming) |
| `GET` | `/admin/agent/history` | Admin | Get copilot conversation history |
| `DELETE` | `/admin/agent/history` | Admin | Clear copilot conversation history |

## Admin Console

URL: `/admin` (e.g., `http://localhost:8787/admin`)

Nav order: Home (Dashboard) -> Preview -> Playbook -> Test -> Reports (Help is icon button)

Features:
- Dashboard with action items, triage urgency, session analysis
- Preview: live widget preview with theme/CSS editing
- Playbook: structured org config (species_config, custom_species, triage rules, bot overrides) — internal tab id is still `kb`
- Test: eval scenarios with auto-generation and per-scenario results
- Reports: daily report with stats overview and timeseries
- Copilot: AI admin assistant (Claude Sonnet) with tool use, accessible from any tab
- All sessions with message counts, timestamps, feedback ratings
- Infinite scroll

### Copilot Streaming Protocol

The `/admin/agent` endpoint uses a line-delimited streaming protocol (not SSE):
- `0:"text"` — text delta
- `9:{toolCallId, toolName}` — tool call begin
- `a:{toolCallId, argsTextDelta}` — tool argument delta
- `b:{toolCallId, toolName, result}` — tool result
- `e:{...}` — finish

### Agent Tools

The copilot has these tools:
- `update_config` — Update org info (phone, email, hours, etc.)
- `update_colors` — Update brand colors
- `save_protocols` — Write raw protocol text
- `get_config` — Read current tenant config
- `create_test_scenario` — Create a test scenario
- `list_test_scenarios` — List all test scenarios
- `get_recent_sessions` — Get recent chat sessions
- `get_stats` — Get aggregate stats
- `search_knowledge_base` — Search RAG pipeline
- `list_documents` — List all guides
- `get_species_config` — Get per-species configuration
- `update_widget_theme` — Update widget appearance (colors, radii, font, button text)
- `update_custom_css` — Set custom CSS for widget
- `publish_widget` — Publish widget settings live
- `navigate_to_tab` — Switch admin portal tab
- `run_test_scenario` — Run a test scenario by ID
- `resolve_action_item` — Resolve a dashboard action item
- `add_custom_species` — Add species not in built-in guides with full protocol
- `update_species_config` — Change how a built-in species is handled (builtin/augment/override/skip)
- `fetch_url` — Fetch any URL (for color extraction, contact info scraping)
- `run_analytics_query` — Plain-English question + read-only SELECT against this tenant's data. The validator in `workers/src/lib/safe-sql.ts` rejects mutations, multi-statement, comments, hard-coded tenant ids, and unscoped queries; `:tenant_id` is bound server-side; results are capped at 100 rows.

## Database Migrations

Migrations are in `workers/migrations/`. Apply locally:
```bash
cd workers && npx wrangler d1 migrations apply wildcare-db --local
```

Apply to production:
```bash
make cf-migrate
```

Migrations are currently up to `0021_user_profile.sql`.

To add a migration: create `workers/migrations/NNN_description.sql`, then apply.

## Syncing data from legacy Render prod (wildcare tenant)

The actual public-facing wildcare prod still runs on Render at
`wildcare.bluesnoop.com` (single-tenant, far behind the CF codebase). The CF
deploy is "almost prod" — wildcare hasn't cut over yet. Until they do, we
periodically sync raw chat data from Render Postgres into CF D1 so the CF
admin dashboard reflects what's happening on the live site.

### Run a sync

Requires `PG_URL` (in `.env`) + `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

```bash
# 1. Generate INSERTs for new rows only (incremental — auto-detects watermarks
#    by reading max(created_at) per table from CF D1).
node workers/scripts/migrate-from-render.js
# → writes workers/scripts/migrate-data.sql

# 2. Apply to prod D1.
cd workers && npx wrangler d1 execute wildcare-db --env production --remote \
  --file=scripts/migrate-data.sql
```

The script syncs `messages`, `feedback`, `reports`. It is idempotent — re-runs
report 0 new rows. `messages` uses `INSERT OR IGNORE` (UNIQUE on
`message_id`); `feedback`/`reports` rely on a strict `>` watermark with
millisecond-precision UTC text comparison (`to_char(... 'YYYY-MM-DD
HH24:MI:SS.MS')`) so boundary rows aren't re-pulled.

### After sync: backfill session_analysis (REQUIRED for dashboard)

Render does NOT have `session_analysis`, `applications`, or `photos`. The CF
admin dashboard (triage, action items) and the reports overview (species,
urgency, outcomes, contact requests, devices tiles) all read from
`session_analysis`. Synced messages alone won't appear on those pages until
the analyzer runs over them.

There's no automated trigger for synced rows (the live chat path runs
`quickAnalyzeSession` after each message append; that path doesn't fire for
imported rows). Trigger it manually from the **wildcare admin browser tab**
(where you're logged in) — paste in dev console:

```js
fetch('/admin/analyze-backfill', {method:'POST'}).then(r=>r.json()).then(console.log)
```

Expect `{candidates: N, analyzed: N, failed: 0}`. The analyzer is regex-based
(no LLM, no token cost), idempotent, and fast even for hundreds of sessions.

After this, the dashboard catches up.

## Testing

Uses Promptfoo with llm-rubric assertions through Cloudflare AI Gateway.

```bash
# Requires make cf-dev running in another terminal
make eval              # Generic safety/accuracy tests
make eval-site         # Org-specific tests
npx promptfoo view     # View results
```

## Daily Reports

Reports are sent via Cloudflare Email Routing (EMAIL binding).

```bash
# Dry run (no email sent)
curl -X POST http://localhost:8787/admin/report \
  -H "Authorization: Bearer <token>" \
  -d '{"dry_run": true}'
```

## Known Limitations

- No HTTPS in dev (TLS terminated by Cloudflare in production)
- No per-user session isolation (chat sessions are tenant-scoped, not user-scoped)
- Magic link auth requires Cloudflare Email Routing configured on the domain

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- "Build and ship", "implement and ship", "code and ship", "do PR N and ship" → invoke build-and-ship
- "Implement this", "build PR N", "do PR N" (no ship) → just code, don't auto-ship
- Ship, deploy, push, create PR (code already done) → invoke ship
- Merge + deploy + verify prod (PR already exists) → invoke land-and-deploy
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

## GBrain Configuration (configured by /setup-gbrain)
- Engine: pglite
- Config file: ~/.gbrain/config.json (mode 0600)
- Setup date: 2026-04-25
- MCP registered: yes (user scope, restart Claude Code sessions to pick up `mcp__gbrain__*` tools)
- Memory sync: off
- Current repo policy: read-write (git@github.com:mcavage/wildcare-bot.git)
