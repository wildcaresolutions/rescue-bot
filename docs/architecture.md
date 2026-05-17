# Architecture

## One Worker, three URL spaces

Everything serves out of a single Cloudflare Worker. Hono routes split traffic by path; tenant resolution happens in middleware (`workers/src/index.ts`) based on subdomain, query param, or `X-Tenant-Slug` header.

| Path | Audience | Auth |
|---|---|---|
| `/api/*` | Citizens (embedded widget, /find page) | Origin-allowlist + per-tenant rate limit |
| `/admin/*` | Tenant operators | Magic-link session token (v2) |
| `/platform/*` | Platform admins | PLATFORM_ADMIN_EMAILS allowlist |
| `/assets/*` | Public | Strict prefix: `tenants/<uuid>/logo.(jpg\|jpeg\|png\|webp)` |
| `/health` | Watchdog cron | None |

## Storage

- **D1 (SQLite)** — tenants, users, sessions, messages, feedback, eval scenarios, magic-link tokens, photo metadata. ~30-column `tenants` table is the source of truth for tenant identity + theme + config. JSON columns (`org_config`, `widget_theme`, `bot_overrides`) get parsed through `lib/tenant-loader.ts:parseOrgConfig` so malformed JSON can't crash a route.
- **R2** — citizen photos at `citizen/<tenant.id>/<session>/<photo>.{jpg,mp4}`; tenant logos at `tenants/<tenant.id>/logo.<ext>`. Both keyed on `tenant.id`, never `slug` (immutable identity vs display alias).
- **Vectorize (768d, cosine)** — RAG index over species guides. Embedded with Workers AI `@cf/baai/bge-base-en-v1.5`. Tenant-scoped filter on every query (`lib/rag.ts`).

## LLM routing

All model calls route through Cloudflare AI Gateway. Three flows:

1. **Citizen chat** — main chat model (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`). Streams via the Vercel AI SDK.
2. **Photo recognizer** — vision model (default `openai/gpt-4.1-mini` via the gateway's OpenAI BYOK). `generateObject` returns a strict schema; the citizen never sees the vision model's prose. Output sanitized through `vision.ts:sanitizeVisionField` before interpolation into the chat prompt.
3. **Admin copilot** — Anthropic (Claude Sonnet 4.6) through gateway BYOK, with a tool registry of ~27 tools (config edit, tests, RAG, analytics SQL, embed code). Tools live in `lib/tools/*.ts` by category.

## Multi-tenancy

Tenants are isolated by `tenant_id` columns on every row. The validator in `lib/safe-sql.ts` rejects any analytics query that isn't bound to `:tenant_id`, banned keywords (UNION, WITH, JOIN), or multi-table FROM. Migrations 0019, 0033 added NOT NULL invariants + trigger-based cascade on `magic_tokens`.

## Security defenses

| Threat | Defense |
|---|---|
| SSRF in copilot fetch/harvest | `lib/safe-url.ts:safeFetch` — https-only, blocks private IPs, re-validates redirects |
| SQL injection / cross-tenant exfil | `lib/safe-sql.ts` — single SELECT, no WITH/UNION/JOIN, every `tenant_id` bound |
| XSS via operator CSS | `lib/css-sanitize.ts` — strips `@import`, `expression()`, `javascript:` |
| XSS via SVG logo | SVG dropped from upload allowlist; asset route emits `nosniff` + CSP `default-src 'none'` |
| Photo MIME confusion | `lib/file-type.ts` magic-byte sniff, rejects mismatched extensions |
| ReDoS via operator triage regex | `lib/match-triage.ts` rejects nested-quantifier / alternation-under-quantifier shapes |
| Vision prompt-injection via image caption | `lib/vision.ts:sanitizeVisionField` strips newlines/markdown chars before prompt interpolation |
| Session token spoofing (XSS-cookie) | v2 token bakes email into HMAC-signed payload — identity is not client-mutable |
| Magic-link replay | `magic_tokens` row burned + `used_at` indexed; verify path is HttpOnly cookie + token |
| PII in admin reads | `lib/pii-redact.ts` — email/phone/SSN/CC redaction on read paths |
| Rate-limit / cost | Per-IP + per-tenant sliding window in `index.ts` |

Two full audit cycles produced [`audits/2026-05-16-pre-prod-audit.md`](../audits/2026-05-16-pre-prod-audit.md), [`audits/2026-05-16-ralph-1.md`](../audits/2026-05-16-ralph-1.md), and [`audits/2026-05-16-ralph-2.md`](../audits/2026-05-16-ralph-2.md). Every Critical / High / nearly every Medium is fixed.

## Multiple worktrees

`make cf-dev` is worktree-aware. Each `git worktree` gets its own port (free-port scan starting near 8787) and its own local wrangler state at `workers/.wrangler/state-<hash>/`, where `<hash>` is derived from the toplevel path. Run `cf-dev` in two worktrees side-by-side — they don't collide.

`make cf-stop` reads `workers/.dev.port` (written by `cf-dev`) and kills only THIS worktree's wrangler. Sibling worktrees stay up.

Only LOCAL miniflare state is isolated. Bindings flagged `remote = true` (Vectorize, AI) hit shared remote infra across worktrees — acceptable since those operations are read-mostly.

## Repository layout

```
agents/rescue-bot-instruction.md   bundled into Worker at build (gen-instructions.js)
audits/                            2026-05-16 pre-prod + 2x ralph-loop audit reports
docs/                              this directory
evals/                             promptfoo + photo recognizer harness
infra/watchdog/                    independent cron Worker
resources/                         generic RAG knowledge base
site/                              gitignored per-deployment content
web/src/                           Vite UI + embed widget
workers/
  migrations/                      D1 SQL — currently up to 0033
  scripts/                         gen-instructions, gen-guides, gen-wrangler, gen-dev-vars
  src/
    index.ts                       top-level Hono app, middleware, /assets/*
    routes/                        chat.ts, admin.ts, platform.ts, auth.ts, agent.ts
    lib/                           tenant-loader, rag, auth, vision, photo-auth,
                                   onboarding-state, match-triage, safe-{sql,url},
                                   errors, ai, css-sanitize, file-type, ...
    lib/tools/                     copilot tool factories (config, species, queries, ...)
    prompts/onboarding-copilot.ts  copilot system prompt (200 lines of operator tuning)
  test/                            535 vitest tests
```

## Generated files (do not edit)

- `workers/src/instructions.ts` — bundled `COMBINED_INSTRUCTION` (regenerated by `gen-instructions.js`).
- `workers/src/guides.ts` — bundled species-guide manifest.
- `workers/.dev.vars` — local secrets (rendered by `gen-dev-vars.js` from `.env`).
- `workers/wrangler.toml` — STUB form in git (placeholders); real values rendered before any wrangler command.

## Key design choices

- **No global "tenant" singleton** — every route reads `c.get('tenant')` from middleware. There's no module-level state that survives across requests. Worker isolates start cold and trust nothing.
- **JSON columns over schema migrations for evolving config** — `org_config`, `widget_theme`, `bot_overrides` are JSON. Schema churn is reserved for things that need indexed lookup. `parseOrgConfig` makes this safe.
- **Magic links over passwords** — except for the legacy `password_hash` column, which only exists for one grandfathered tenant.
- **No per-user session isolation** — chat sessions are tenant-scoped, not user-scoped. Citizens are anonymous; the rehab sees the conversation but not "Alice's session vs Bob's session".
- **Token v2 = email-in-token** — session tokens carry email in their HMAC-signed payload (audit ralph-1 C4). The `_tester_email` cookie still exists as a UX presence flag but is never read for writes.
