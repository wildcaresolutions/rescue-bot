# Watchdog Worker

Synthetic prober that hits the main wildcare-bot `/health` endpoint every 5
minutes and emails the operator on outage. Independent failure domain — runs
as a separate Worker with its own deploy, KV namespace, and email binding.

See the design at `~/.gstack/projects/mcavage-wildcare-bot/mcavage-dev-test-prod-pr1-workers-dev-design-20260429-172808.md`
for context. This README is the deploy + operate guide.

## Architecture

```
┌─────────────────────────┐
│  Cron */5 * * * *       │
│  (Cloudflare-internal)  │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  wildcare-bot-watchdog (this dir)   │
│                                     │
│  ┌──────────────────────────────┐   │
│  │ scheduled() handler          │   │
│  │  ├─ Assert OPS_EMAIL set     │   │
│  │  ├─ probeHealth(test url)    │   │  fetch ───► main worker /health
│  │  └─ probeHealth(prod url)    │   │             (test + prod)
│  └──────────────┬───────────────┘   │
│                 │                   │
│   ┌─────────────┴────────────┐      │
│   │  outage detected?        │      │
│   └─────────┬────────────────┘      │
│             │                       │
│      yes ───┴───── no               │
│             │       │               │
│             │       └─► KV.delete   │  (recovery, no email)
│             │                       │
│             ▼                       │
│   ┌─────────────────────┐           │
│   │ KV.get(outage:{env})│           │
│   └────────┬────────────┘           │
│            │                        │
│   present──┴──absent                │
│      │         │                    │
│  suppress      ▼                    │
│             KV.put + email          │
│             (TTL 60min)             │
└─────────────────────────────────────┘
```

## First-time setup

### 1. Create a KV namespace

```bash
cd infra/watchdog
npx wrangler kv:namespace create WATCHDOG_KV
```

Paste the printed namespace ID into `org.env`:

```
WATCHDOG_KV_ID=<paste-here>
```

### 2. Set the probe URLs in `org.env`

```
WATCHDOG_HEALTH_URL_TEST=https://wildcare-bot-test.<your-subdomain>.workers.dev/health
WATCHDOG_HEALTH_URL_PROD=https://<your-org-domain>/health
```

### 3. Set operator email in `.env`

```
OPS_EMAIL=you@example.com
OPS_FROM_EMAIL=noreply@<your-verified-sender-domain>
```

`OPS_FROM_EMAIL` must be a verified sender on your CF Email Routing config.
For wildcare-bot the sender is `noreply@wildcaresolutions.org` (same as the
daily report sender).

### 4. Deploy + push secrets

```bash
make cf-deploy-watchdog
make cf-push-secrets-watchdog
```

The deploy runs `wrangler deploy` against `infra/watchdog/wrangler.toml`. The
secrets push runs `wrangler secret put OPS_EMAIL` and `wrangler secret put
OPS_FROM_EMAIL` against the watchdog Worker.

### 5. Configure the CF Notifications alert

This is the watchdog-watchdog. See
`workers/observability/dashboard-spec.md` for the full alert configuration.
TL;DR: CF dashboard → Notifications → Add → Workers Observability Alert,
worker = `wildcare-bot-watchdog`, condition = `error_count > 0` over 5 min,
recipient = `OPS_EMAIL`.

### 6. Build the operator dashboard

Follow `workers/observability/dashboard-spec.md` to create the
`wildcare prod health` Custom Dashboard. ~10 minutes of clicking. Bookmark
the result.

### 7. Smoke test

Verify end-to-end paging works before you trust it:

```bash
# Temporarily break the test-env D1 binding in workers/wrangler.toml
# (or change TEST_D1_DATABASE_ID in org.env to a nonexistent UUID,
# then `make cf-render-config && make cf-deploy-test`).
# Wait 5 minutes. Confirm: one email lands at OPS_EMAIL describing the failure.
# Wait another 5 minutes. Confirm: NO additional email (dedupe working).
# Restore the binding and redeploy. Wait 5 minutes. Confirm: KV key
# `outage:test` is gone (`npx wrangler kv:key list --binding=WATCHDOG_KV --cwd infra/watchdog`).
```

## Operate

### Manually clear a stuck outage state

If you want to force a re-alert (e.g., to verify paging still works):

```bash
cd infra/watchdog
npx wrangler kv:key delete --binding=WATCHDOG_KV outage:test
# or outage:prod
```

The next probe within 5 minutes will treat the outage as new and email.

### Tail the watchdog logs

```bash
cd infra/watchdog
npx wrangler tail
```

### Read recent watchdog activity from the dashboard

The CF Custom Dashboard's Tile 7 ("Watchdog Worker error rate") shows error
count over the last 24h. If non-zero, click through to Workers Observability
Investigate → filter by `worker_name = 'wildcare-bot-watchdog'`.

## Tests

```bash
make test-watchdog
```

23 unit tests covering: parseHealthFailures (4), probeHealth (8),
checkAndAlert (7), scheduled() entry (4). See `test/index.test.ts`.

## Failure modes that are handled

- Network error / fetch timeout → outage detected, KV write, email sent.
- HTTP non-200 from /health → outage detected.
- /health returns invalid JSON or wrong shape → outage detected.
- /health returns 200 but body claims a check failed → outage detected
  (defends against shape drift between the watchdog and the main worker).
- KV.get throws → fail-loud, send email anyway. Worst case: duplicate emails
  during a CF KV outage.
- KV.put throws after read returned absent → still send email.
- KV.delete throws on recovery → silent (TTL self-heals).
- EMAIL.send throws → KV already written, error logged. Tile 7 + CF
  Notifications alert surface the failure.
- Both envs fail simultaneously → 2 distinct dedupe keys (`outage:test`,
  `outage:prod`), 2 separate emails.
- Watchdog cron stops firing entirely → CF Notifications alert on the
  watchdog's Workers Observability error count fires.
- Missing `OPS_EMAIL` → cron handler throws, surfaces in Workers Observability
  + Tile 7 + CF Notifications alert.

## Failure modes that are NOT handled

- DNS / TLS / edge-routing failures from outside CF — the watchdog probes
  through CF egress, so it can't see issues an external prober would catch.
  Mitigation: the operator visits the site daily anyway. If this becomes
  a real issue, evaluate adding BetterStack Free tier as a complement.
- A simultaneous CF-wide outage that takes down both the main worker AND the
  watchdog — at this scale, you trust CF.
