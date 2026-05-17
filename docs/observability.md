# Observability + ops

The platform ships with a small operator stack to give one human a single "is everything OK right now?" answer without manual click-throughs.

## Layers

| Layer | What | Where |
|---|---|---|
| Health probe | `/health` returns 200/503 based on D1 + Vectorize + R2 reachability | `workers/src/index.ts` |
| Watchdog | Independent cron Worker probes /health every 5 min, pages on outage | `infra/watchdog/` |
| Custom dashboard | 7-tile bookmarkable operator view in CF dashboard | `workers/observability/dashboard-spec.md` |
| Notifications | CF email alert when watchdog itself errors (watchdog-watchdog) | CF UI, spec'd in dashboard-spec.md |
| MCP | Conversational ops via Cloudflare Observability MCP | per-developer setup |
| Structured logs | JSON to console with PII scrubbing | `workers/src/lib/logger.ts` |

## Watchdog Worker

Lives at `infra/watchdog/`. Independent failure domain: if the main worker is dead, the watchdog still runs.

```toml
# infra/watchdog/wrangler.toml — rendered from .template.toml
name = "<slug>-watchdog"
[[triggers.crons]]
cron = "*/5 * * * *"
```

Behavior:

- Probes `WATCHDOG_HEALTH_URL_TEST` and `WATCHDOG_HEALTH_URL_PROD`.
- Retries once on probe failure (absorbs transient CF-edge blips).
- On confirmed outage: emails `OPS_EMAIL` via `[[send_email]]`.
- Dedupe: 60-min TTL keyed on `${env}:${url}` in `WATCHDOG_KV` (one page per outage event, not per probe).
- Logs structured JSON for the dashboard.

Setup commands (after `cf-init-org` provisioned the main app):

```bash
cd infra/watchdog
npx wrangler kv:namespace create WATCHDOG_KV
# paste the kv_id into org.env
$EDITOR ../../org.env   # set WATCHDOG_KV_ID, WATCHDOG_HEALTH_URL_TEST/PROD
cd ../..
make cf-deploy-watchdog
make cf-push-secrets-watchdog
```

`OPS_EMAIL` and `OPS_FROM_EMAIL` come from `.env`. **`OPS_EMAIL` is distinct from per-tenant `report_recipients`** — the watchdog never emails tenant addresses, only the platform operator.

## Custom dashboard

`workers/observability/dashboard-spec.md` documents 7 tiles:

1. Request count by env (test vs prod, last 24h)
2. 5xx rate by path (most-erroring routes)
3. p95 latency by path
4. Slowest 50 requests (drill into the long tail)
5. D1 query volume
6. Vectorize request count
7. Watchdog error rate

Cloudflare Custom Dashboards (GA 2026-04-22) don't expose a clean export/import API yet, so the dashboard is rebuilt by hand from the spec when forking. The spec has the per-tile Workers Analytics Engine queries — copy/paste into the UI.

## The watchdog-watchdog

What happens if the watchdog stops running (cron misfire, missing `OPS_EMAIL` after a redeploy, KV namespace gone)?

CF Notifications, configured in the dashboard. Fires on `Workers Script Errored` for the watchdog Worker. Recipient: `OPS_EMAIL`. Spec is in `dashboard-spec.md`.

## Cloudflare Observability MCP

Cloudflare ships an MCP server that lets you ask ops questions conversationally from any MCP-aware client (Claude Code, Cursor, etc.). No in-repo code, no maintenance — operated by Cloudflare. Authenticate once via OAuth and you can ask things like:

> show me the last 10 5xx responses on `<slug>-bot-test` in the last hour

The MCP is opt-in per developer machine. Authentication happens in the MCP client, not in this repo.

## Structured logs

`workers/src/lib/logger.ts` emits JSON to console. Fields:

```
{
  "ts": "2026-05-16T19:42:03.117Z",
  "level": "info|warn|error",
  "route": "admin/dashboard",
  "tenant_id": "...",
  "request_id": "...",
  "msg": "..."
}
```

PII scrubbing is opt-in via `redact: true` on the call — applies the same `lib/pii-redact.ts` pass used on the admin read paths (email/phone/SSN/CC with Luhn).

Log Explorer (CF dashboard) ingests these directly. Use the route + tenant_id fields to filter.

## Daily reports

Tenant-level. Configured per tenant in the admin console (`tenants.report_recipients`, `tenants.daily_reports_enabled`). Triggered by a cron or by `POST /admin/report` (admin-only).

Dry-run mode returns the markdown body without sending:

```bash
curl -X POST http://localhost:8787/admin/report \
  -H "Authorization: Bearer <token>" \
  -d '{"dry_run": true}'
```

## Common scenarios

**Site goes down.** Watchdog emails `OPS_EMAIL` within 5-10 min. Check `/health` directly to see which dependency (D1 / Vectorize / R2) is unhealthy. Cross-reference with CF status page.

**Costs spike.** Custom dashboard tiles 5 + 6 (D1 query volume, Vectorize request count) are the first place to look. The per-tenant rate limit in `index.ts` (`RATE_LIMIT_TENANT_CHAT = 60/min`) is the structural cap; if one tenant is the cause, check their `messages` table for runaway loops.

**Magic-link bounce.** Email Routing dashboard → Activity log. Most likely cause: `REPORT_FROM_EMAIL` not verified on the destination domain. Re-verify and retry.

**Copilot says "I could not complete that response".** The `onError` handler in `agent.ts` surfaces the underlying error in the streamed payload. Check Workers logs for `[agent] streamText error:` lines — usually a rate-limit at the gateway / upstream provider or a tool throwing.
