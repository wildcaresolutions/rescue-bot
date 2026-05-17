# wildcare prod health — Cloudflare Custom Dashboard spec

This file is the source of truth for the operator's morning-coffee dashboard.
Cloudflare Custom Dashboards (GA 2026-04-22) do not currently expose a clean
export/import API, so the dashboard is rebuilt by hand from this spec when
forking. ~10 minutes of manual work.

**Path in the CF dashboard:** Analytics → Custom Dashboards → New dashboard.

**Name:** `wildcare prod health`

**Time range default:** Last 24 hours.

**Bookmark this URL** after creation. It becomes your operator home page.

---

## Tile 1 — Request count by env (24h)

- **Type:** Time series (line chart, stacked)
- **Source:** Workers Observability metrics
- **Query / filter:**
  - Group by: `worker_name`
  - Filter: `worker_name IN ('wildcare-bot-test', 'wildcare-bot')`
  - Metric: `request_count` (sum)
  - Window: 1h buckets
- **Why:** Spot traffic anomalies. A cliff or a spike that doesn't match
  expected traffic patterns deserves a click-through.

## Tile 2 — 5xx rate by path (24h)

- **Type:** Time series (line chart, top 5)
- **Source:** Workers Observability Query Builder (saved query)
- **Query:**
  ```
  $workers.outcome != 'ok' AND $workers.cf.status >= 500
  | GROUP BY $workers.cf.path
  | COUNT
  | TIME 1h
  ```
- **Filter:** `worker_name = 'wildcare-bot'`
- **Why:** Surfaces which routes are erroring without filling the dashboard
  with noise. p99 path latency without p99 path errors is the wrong picture.

## Tile 3 — p95 wall time by path (24h)

- **Type:** Time series (line chart, top 5)
- **Source:** Workers Observability Query Builder (saved query)
- **Query:**
  ```
  | PERCENTILE($workers.wallTimeMs, 95) BY $workers.cf.path
  | TIME 1h
  ```
- **Filter:** `worker_name = 'wildcare-bot'`
- **Why:** Catches slow-creep regressions on the chat path before they hit
  user-experience floors.

## Tile 4 — Slowest 50 requests in last 24h (table)

- **Type:** Table
- **Source:** Workers Observability Query Builder (saved query)
- **Query:**
  ```
  | SORT $workers.wallTimeMs DESC
  | LIMIT 50
  | SHOW $workers.cf.path, $workers.wallTimeMs, $workers.cf.status, timestamp
  ```
- **Filter:** `worker_name = 'wildcare-bot'`
- **Why:** When latency tile spikes, this table tells you which specific
  requests caused it. Often surfaces single slow LLM calls or D1 lock waits.

## Tile 5 — D1 query count + slow queries (24h)

- **Type:** Time series (line chart, dual axis)
- **Source:** D1 Insights (built-in CF analytics tile)
- **Database:** `wildcare-db`
- **Metrics:** `query_count`, `slow_query_count` (>1s)
- **Why:** D1 is the most likely "everything got slow at once" suspect.
  Slow-query count is the canary — if it ticks above zero for sustained
  periods, the dashboard tile shows it.

## Tile 6 — Vectorize request count (24h)

- **Type:** Time series (line chart)
- **Source:** Vectorize analytics (built-in CF analytics tile)
- **Index:** `wildcare-docs`
- **Metric:** `query_count`
- **Why:** Vectorize warmup is a known cold-start contributor (see CI smoke
  fixes in commit history). If query count is zero when the chat path is
  hot, RAG is broken.

## Tile 7 — Watchdog Worker error rate (24h)

- **Type:** Single-stat with threshold + spark line
- **Source:** Workers Observability metrics
- **Query / filter:**
  - Group by: `worker_name`
  - Filter: `worker_name = 'wildcare-bot-watchdog'`
  - Metric: `error_count` (sum) over the last 1h
  - Threshold: `> 0` → red
- **Why:** This is the "watchdog watching the watchdog." If the watchdog
  itself is throwing — most likely cause: a missing `OPS_EMAIL` secret after
  redeploy — Tile 7 turns red. The CF Notifications alert (configured at the
  account level, see `infra/watchdog/wrangler.template.toml` comments) emails
  on the same condition without requiring a dashboard glance.

---

## CF Notifications alert (configured separately)

Required for the comfort floor — Tile 7 alone depends on the operator looking
at the dashboard, which the design's premise 1 explicitly does not assume.

**Path:** CF dashboard → Notifications → Add → Workers Observability Alert.

**Config:**
- **Name:** `wildcare-bot-watchdog errors`
- **Worker:** `wildcare-bot-watchdog`
- **Condition:** `error_count > 0` over a 5-minute window.
- **Recipient:** `OPS_EMAIL` (same address pushed via
  `make cf-push-secrets-watchdog`).

**Verification:** push a deploy with `OPS_EMAIL` unset on the watchdog,
trigger one cron run (wait 5 min), confirm an alert email lands within 10
minutes. Then restore `OPS_EMAIL` and confirm Tile 7 returns to zero.

---

## Forking-org checklist

When a forking maintainer rebuilds the dashboard:

1. Open Analytics → Custom Dashboards → New dashboard.
2. Add tiles 1-7 in order using the queries above. For Workers Observability
   tiles (2, 3, 4, 7), save the queries first via Workers Observability →
   Investigate, then "pin to dashboard."
3. Time range: 24h default.
4. Bookmark the dashboard URL as your operator home page.
5. Configure the CF Notifications alert above.
6. Run `make cf-push-secrets-watchdog` to push `OPS_EMAIL`.
7. Smoke test per `infra/watchdog/README.md` (force a /health failure, verify
   alert lands).

Total time: ~10-15 minutes.
