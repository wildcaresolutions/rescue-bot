# API reference

Routes are defined in `workers/src/index.ts` (top-level + middleware) and `workers/src/routes/{chat,admin,platform,auth,agent}.ts`.

## Public surface

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | D1 + Vectorize + R2 probe. 200 healthy, 503 unhealthy. |
| `GET` | `/api/config` | Tenant config (branding, widget_theme, platform_name). Public fields always; authed fields when bearer/cookie matches. |
| `POST` | `/api/errors` | Client error reporting (rate-limited, public). |
| `POST` | `/api/auth/request` | Send magic-link email. Turnstile-gated. |
| `GET` | `/api/auth/verify` | Verify magic-link token, set HttpOnly session cookies (v2 token bakes email). |

## Citizen-facing (per-tenant, Origin-allowlisted)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/sessions` | Create session. Returns `{id, session_token}` — token is bearer for subsequent photo calls. |
| `GET` | `/api/sessions/:id` | Session + chat history (tenant-scoped). |
| `POST` | `/api/sessions/:id` | Send message; streams reply. Optional `photo_id` ties the turn to an uploaded photo. |
| `POST` | `/api/sessions/:id/photo` | Multipart upload (image or short video). Worker-proxied to R2, recognized by the vision model. session_token Bearer required. |
| `DELETE` | `/api/sessions/:id/photo/:photoId` | Soft-delete an uploaded photo. session_token Bearer required. |
| `POST` | `/api/messages` | Save message metadata (used by widget for ack flow). |
| `POST` | `/api/feedback` | Save thumbs-up/down + optional comment. |

## Admin-facing (magic-link or token Bearer)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/auth/me` | Current user profile (display_name, avatar_url, role). |
| `PUT` | `/api/auth/me` | Update profile. Identity comes from verifiedToken.email, not cookie. |
| `GET` | `/api/auth/users` | List tenant_users. |
| `POST` | `/api/auth/users` | Invite a teammate (sends magic link). |
| `DELETE` | `/api/auth/users/:userId` | Remove a teammate. |
| `GET` | `/admin/dashboard` | Action items + triage urgency snapshot. |
| `GET` | `/admin/sessions` | List sessions (paginated, infinite scroll). |
| `GET` | `/admin/sessions/:id` | Session detail + analysis. |
| `POST` | `/admin/sessions/:id/resolve` | Resolve an action item. |
| `GET` | `/admin/stats` | Aggregate stats. |
| `GET` | `/admin/stats/timeseries` | Stats over time (for reports tab). |
| `GET` | `/admin/stats/overview` | Reports-tab overview. |
| `POST` | `/admin/report` | Send/preview daily report (`{dry_run: true}` returns markdown without sending). |
| `GET` | `/admin/setup-state` | Onboarding step machine: next_action + flags. |
| `GET` | `/admin/bot-status` | Bot readiness traffic light. |
| `GET` | `/admin/knowledge-base` | List all builtin guides + custom protocols. |
| `POST` | `/admin/rag-search` | Search RAG pipeline (admin debug). |
| `POST` | `/admin/triage/test` | Test a sample message against triage rules. |
| `POST` | `/admin/embed` | Generate embed code (uses PLATFORM_EMBED_HOST). |
| `GET` | `/admin/domains` | List allowed Origin domains. |
| `POST` | `/admin/domains` | Add an allowed domain. |
| `DELETE` | `/admin/domains/:id` | Remove an allowed domain. |
| `GET` | `/admin/evals` | List test scenarios. |
| `POST` | `/admin/evals` | Create test scenario. |
| `DELETE` | `/admin/evals/:id` | Delete test scenario. |
| `POST` | `/admin/evals/auto-generate` | Auto-generate scenarios from RAG. |
| `POST` | `/admin/evals/:id/run` | Run a scenario. |
| `GET` | `/admin/evals/:id/results` | Per-scenario result history. |
| `GET` | `/admin/feature-flags` | Read tenant feature flags. |
| `PUT` | `/admin/feature-flags` | Update tenant feature flags (platform admin only). |
| `POST` | `/admin/onboarding/brand-extract` | Extract brand palette + fonts from a URL. |
| `POST` | `/admin/onboarding/website-harvest` | Harvest contact info / hours from a URL. |
| `POST` | `/admin/agent` | Copilot streaming endpoint (line-delimited protocol). |
| `GET` | `/admin/agent/history` | Recent copilot conversation. |
| `DELETE` | `/admin/agent/history` | Clear copilot history. |

## Platform-admin (PLATFORM_ADMIN_EMAILS allowlist)

| Method | Path | Description |
|---|---|---|
| `POST` | `/platform/apply` | Public signup application (Turnstile-gated). |
| `POST` | `/platform/signup` | Create tenant directly (platform admin). |
| `POST` | `/platform/approve/:appId` | Approve an application → create tenant. |
| `POST` | `/platform/reject/:appId` | Reject an application. |
| `POST` | `/platform/setup/:slug` | Update tenant config + widget_theme + custom_instruction. |
| `GET` | `/platform/dashboard` | Platform overview. |
| `GET` | `/platform/applications` | Pending/approved/rejected applications. |

## Copilot streaming protocol

The `/admin/agent` endpoint uses a line-delimited streaming protocol (not SSE):

```
0:"text"                             text delta
9:{toolCallId, toolName}             tool call begin
a:{toolCallId, argsTextDelta}        tool argument delta
b:{toolCallId, toolName, result}     tool result
e:{...}                              finish
```

See `web/src/admin.js:consumeAgentStream` for the parser.

## Agent tools

The copilot tools are registered in `workers/src/routes/agent.ts`, defined in `workers/src/lib/tools/*.ts`:

- **config**: `update_config`, `update_org_info`, `update_colors`, `get_config`, `update_widget_theme`, `update_custom_css`
- **protocols**: `save_protocols`, `create_test_scenario`, `list_test_scenarios`, `run_test_scenario`
- **species**: `get_species_config`, `update_species_config`, `add_custom_species`, `bulk_skip_other_species`
- **queries**: `get_recent_sessions`, `get_stats`, `run_analytics_query`, `search_knowledge_base`, `list_documents`
- **readiness**: `get_setup_readiness`, `publish_widget`
- **actions**: `navigate_to_tab`, `resolve_action_item`, `get_embed_code`
- **fetch**: `extract_brand_colors`, `fetch_url`, `harvest_website_info`
- **web-search**: `web_search`, `web_fetch` for operator-requested public research — registered only when `COPILOT_WEB_SEARCH` opts in (see below)

`run_analytics_query` accepts plain-English questions + a single SELECT. The validator at `lib/safe-sql.ts` rejects mutations, multi-statement, comments, hard-coded tenant ids, JOINs, comma-joins, UNION/WITH/CTEs, and unscoped queries. `:tenant_id` is server-bound; results capped at 100 rows.

Direct website requests from `fetch_url`, `harvest_website_info`, and `extract_brand_colors` route through `lib/safe-url.ts:safeFetch`: HTTPS only, private IPs blocked, redirects revalidated.

### Public web research (opt-in, off by default)

The admin copilot can research public sources — find rehabilitation directories, read a source page before preparing a referral — through two extra tools, `web_search` and `web_fetch`. **Neither is registered unless the deployment opts in**, because both send operator search terms and URLs to a third-party service, and rescue-bot is forked and self-hosted by organizations that should decide that for themselves. With the flag off there are no research tools and no outbound research requests at all.

Turn it on by setting the Worker variable `COPILOT_WEB_SEARCH` in the applicable environment's `[vars]` table in `workers/wrangler.template.toml`, then regenerating the deployment configuration (`make cf-render-config`):

| `COPILOT_WEB_SEARCH` | Behavior |
|---|---|
| unset, `""`, `"disabled"`, `"off"`, `"false"` | **Default.** Tools not registered, no network calls. |
| `"parallel"` | [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) — keyless anonymous search and page excerpts. Anonymous search uses Fast mode and is subject to service limits. |
| anything else | Configuration error: `/admin/agent` returns 500 instead of silently guessing. |

Providers implement the `WebResearchProvider` interface in `workers/src/lib/tools/web-search.ts` and are selected by the id they register under, so another provider can be added without touching the route.

`web_search` accepts an `objective` and one to three `search_queries`. `web_fetch` accepts up to five public HTTPS `urls` and an optional `objective` (200 characters). Page URLs are validated with the existing outbound URL guard before being sent to the provider's fixed endpoint. Research results include source URLs and are capped at 25,000 characters. Each call has a 15-second deadline and follows request cancellation. Failures are returned to the copilot without switching providers.

Citizen chat is unaffected: it continues to use the approved knowledge base only. Existing `fetch_url` (including raw HTML), website harvesting, saved tenant settings, admin authorization, and knowledge-base search retain their behavior.

#### Research turns cannot write

Search results are attacker-controllable text, and the copilot holds tools that mutate tenant state (`save_protocols`, `manage_referrals`, `update_species_config`, …). Prompt wording is not the control here. `workers/src/lib/tools/research-guard.ts` enforces it structurally:

> Once a turn calls `web_search` or `web_fetch`, every state-changing tool is withheld for the rest of that turn.

Two layers, both driven by the same per-request flag:

1. `prepareStep` narrows `activeTools` to the read-only allowlist, so after the research step the write tools are not offered to the model at all.
2. Every tool's `execute` is wrapped and refuses with an explanation, which also covers a model that asks for research and a write in the *same* step (where the step's tool set is already fixed).

The copilot therefore has to report what it found, cite URLs, and ask the operator. The operator's reply starts a fresh turn carrying no fetched page text — agent history persists user/assistant prose only, never tool results (`lib/agent-history.ts`) — so the edit runs on an explicit operator instruction rather than on instructions smuggled in through a web page.

`RESEARCH_SAFE_TOOLS` is an allowlist of read-only tools. A tool added later is treated as a write tool until someone deliberately classifies it, so forgetting to update that list fails strict, never silently writable.

Search terms and requested URLs are sent to the configured provider. Only use public research terms and public URLs; never include citizen details, private protocols, or private links. Public search results do not replace approved rescue guidance.
