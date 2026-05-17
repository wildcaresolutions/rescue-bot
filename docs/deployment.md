# Deployment

Three environments: **local dev** (miniflare), **test** (your own `*.workers.dev` subdomain), **production** (your custom domain).

## Prerequisites

- Cloudflare account with Workers Paid (`$5/mo`) — needed for AI Gateway, D1, R2, Vectorize quotas.
- A registered domain on Cloudflare (or one you can move there for Email Routing).
- A Cloudflare API token with: Workers Scripts (edit), D1 (edit), R2 (edit), AI Gateway (read), Email (edit).

## Fork-and-deploy walkthrough

```bash
git clone https://github.com/wildcaresolutions/rescue-bot
cd rescue-bot
npx wrangler login
```

### 1. Provision resources

```bash
make cf-init-org
```

Interactive — prompts for:

- `ORG_SLUG` — worker name prefix (e.g. `myrehab`).
- `ORG_DOMAIN` — production hostname (e.g. `bot.myrehab.org`).
- `ACCOUNT_ID` — Cloudflare account ID (from the dashboard sidebar).
- Turnstile site/secret keys (sign up at dash.cloudflare.com → Turnstile, free tier).

Then creates: 3× D1 databases (`dev`/`test`/`prod`), 3× Vectorize indexes, 2× R2 buckets, and writes `org.env` with the IDs. Idempotent — re-running picks up existing resources by name.

Prefer manual provisioning? Use `make cf-init-config` instead — it just copies `org.env.example` to `org.env` and you fill the values yourself.

### 2. Email Routing

Magic-link login + daily reports send email via Cloudflare's native Email Routing.

1. Dashboard → Email → Email Routing → Enable on your domain.
2. Add a verified sender (e.g. `noreply@yourdomain.org`). This becomes `REPORT_FROM_EMAIL`.
3. The `[[send_email]]` binding is already in `wrangler.template.toml` — no edit needed.

### 3. Secrets

```bash
cp .env.example .env
$EDITOR .env
```

Required:

```
AI_GATEWAY_TOKEN=...               # Cloudflare AI Gateway auth (Unified Billing)
SIGNING_SECRET=...                 # HMAC for session tokens (32+ chars random)
CLOUDFLARE_API_TOKEN=...           # for `wrangler deploy`
```

Optional:

```
MAIN_CHAT_MODEL=workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
PHOTO_RECOGNIZER_MODEL=openai/gpt-4.1-mini   # vision; routed through gateway
PLATFORM_NAME=My Rehab Platform               # appears in emails + admin UI
PLATFORM_SUPPORT_EMAIL=support@myrehab.org    # bot's "email this when stuck"
PLATFORM_EMBED_HOST=embed.myrehab.org         # widget snippet host
OPS_EMAIL=ops@myrehab.org                      # watchdog alert recipient
REPORT_FROM_EMAIL=noreply@myrehab.org          # sender for tenant reports
```

Push to Cloudflare:

```bash
make cf-push-secrets-test
make cf-push-secrets
```

### 4. Migrations + RAG

```bash
make cf-migrate-test
make cf-migrate
make cf-index-docs     # one-time: embed the 20+ guides in resources/ into Vectorize
```

### 5. Deploy

```bash
make cf-deploy-test    # ships to <slug>-bot-test.<account>.workers.dev
make cf-deploy         # ships to your custom domain
```

DNS: point your apex (and the `admin.` subdomain) at Cloudflare and add a custom domain to the Worker in the dashboard.

## CI/CD

Each value in `org.env` doubles as a typed GitHub Actions repository secret — `ACCOUNT_ID`, `ORG_DOMAIN`, `DEV_D1_DATABASE_ID`, `TEST_D1_DATABASE_ID`, `PROD_D1_DATABASE_ID`, `PROD_TURNSTILE_SITE_KEY`. The `deploy-test` and `deploy-prod` workflows pass them as env vars; `gen-wrangler.js` renders `wrangler.toml` from `process.env` directly. No `org.env` file needed in CI.

Open PRs serialize on the test env via job-level `concurrency: deploy-test`. Two PRs in flight no longer stomp each other.

## The wrangler.toml stub dance

`workers/wrangler.toml` is committed as a STUB (`REPLACE_VIA_GEN_WRANGLER` placeholders). A fresh clone gets IDE TypeScript / `wrangler types` / vitest-pool-workers working without `org.env` being filled in.

Every wrangler-touching `make` target runs `cf-render-config` first to overwrite the stub with real values from `org.env`. CI's `verify-stub` job catches drift if you edit `wrangler.template.toml` without regenerating the stub:

```bash
node workers/scripts/gen-wrangler.js --stub    # regen the committed file
```

## Watchdog

The watchdog is an independent cron Worker (`infra/watchdog/`) that probes `/health` every 5 minutes and emails `OPS_EMAIL` on outage. Setup:

```bash
cd infra/watchdog
npx wrangler kv:namespace create WATCHDOG_KV     # for dedupe state (60-min TTL)
```

Paste the KV id into `org.env`, set `WATCHDOG_HEALTH_URL_TEST` / `WATCHDOG_HEALTH_URL_PROD`, then:

```bash
make cf-deploy-watchdog
make cf-push-secrets-watchdog
```

`OPS_EMAIL` is distinct from per-tenant `report_recipients` — the watchdog never emails tenant addresses.

See [`docs/observability.md`](observability.md) for the dashboard spec + the CF Notifications watchdog-watchdog.

## Rotating credentials

```bash
# AI Gateway token — generate a new one in dash.cloudflare.com → AI Gateway → API tokens
$EDITOR .env                          # update AI_GATEWAY_TOKEN
make cf-push-secrets-test cf-push-secrets

# Signing secret — invalidates ALL in-flight session tokens (users re-login)
openssl rand -base64 48               # paste into .env SIGNING_SECRET
make cf-push-secrets-test cf-push-secrets

# Cloudflare API token — rotate in dash.cloudflare.com → My Profile → API Tokens
```

## Health check

`GET /health` probes D1 + Vectorize + R2 and returns 200 with `{status: 'healthy', ...}` or 503 with `{status: 'unhealthy', failed: [...]}`. Probed by the watchdog every 5 min; safe to probe from CI smoke tests.
