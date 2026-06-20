import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env, Tenant, Variables } from './lib/types'
import {
  resolveSession, isDevAuthBypass, tenantCookiePrefix, PLATFORM_COOKIE_PREFIX,
} from './lib/auth'
import { generateReport } from './lib/report'
import { loadTenantBySlug } from './lib/tenant-loader'
import { extractSlug, isAdminHost, hostFirstLabel } from './lib/routing'
import { getEmbedHost, getPlatformName } from './lib/platform'
import chat from './routes/chat'
import admin from './routes/admin'
import platform from './routes/platform'
import agent from './routes/agent'
import authRoutes from './routes/auth'
import type { HealthResponse, HealthStatus, HealthCheckKey } from './types/health'
import { getCachedDomains, cacheDomains } from './lib/cache'
import { parseOrgConfig } from './lib/tenant-loader'
import { overlayTenant, hasDraft } from './lib/draft'
import { logWarn } from './lib/logger'

// Sentinel tenantId for platform-admin sessions (admin.<root>).
const PLATFORM_TENANT_ID = 'platform'

export type { Env }

// ── Rate limiting (sliding window) ──────────────────────────────────────────
//
// Two layers, both per-minute:
//   - per-IP: 15 chat messages / 10 session-creates per IP. Defends against
//     a single client (or scraper) hammering one tenant's chat.
//   - per-TENANT: 60 chat messages per tenant per minute. Defends against
//     a single tenant's user-base (legitimate or attacker-amplified) from
//     burning the whole deployment's compute/cost budget. A small rehab
//     org might see 5-10 chats/min at peak; 60 leaves comfortable headroom
//     while still capping a runaway loop.
//
// Rate limiting uses CF's native binding (per-colo, eventually-consistent).
// This is intentionally not globally exact — it's a cost-DoS guard, not a
// billing meter. See design doc: fix/rate-limiting PR.

const PHOTO_RESERVATION_TTL_MS = 15 * 60_000
const PHOTO_STANDARD_RETENTION_MS = 30 * 86_400_000
const PHOTO_CLINICAL_RETENTION_MS = 90 * 86_400_000

function clientIp(c: Context<{ Bindings: Env; Variables: Variables }>): string {
  return c.req.header('CF-Connecting-IP')
    || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown'
}

async function deletePhotoObjects(env: Env, row: { r2_key: string; thumbnail_key?: string | null }) {
  await Promise.all([
    env.MEDIA_BUCKET.delete(row.r2_key),
    row.thumbnail_key ? env.MEDIA_BUCKET.delete(row.thumbnail_key) : Promise.resolve(),
  ])
}

async function markPhotoDeleted(
  env: Env,
  tenantId: string,
  row: { id: string; r2_key: string; thumbnail_key?: string | null },
  reason: string,
  now: number,
) {
  await deletePhotoObjects(env, row)
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE photos SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ? AND tenant_id = ?`,
    ).bind(now, row.id, tenantId),
    env.DB.prepare(
      `INSERT INTO photo_deletions (id, photo_id, tenant_id, deleted_by, reason, ts)
       VALUES (?, ?, ?, 'retention_sweep', ?, ?)`,
    ).bind(crypto.randomUUID(), row.id, tenantId, reason, now),
  ])
}

async function runPhotoRetention(env: Env, tenantId: string) {
  const now = Date.now()

  const { results: staleReservations } = await env.DB.prepare(
    `SELECT id, r2_key, thumbnail_key
     FROM photos
     WHERE tenant_id = ? AND uploaded_at IS NULL AND deleted_at IS NULL AND reserved_at < ?
     LIMIT 100`,
  ).bind(tenantId, now - PHOTO_RESERVATION_TTL_MS).all<{ id: string; r2_key: string; thumbnail_key: string | null }>()

  for (const row of staleReservations) {
    await markPhotoDeleted(env, tenantId, row, 'expired-reservation', now)
  }

  const { results: expiredPhotos } = await env.DB.prepare(
    `SELECT id, r2_key, thumbnail_key
     FROM photos
     WHERE tenant_id = ? AND uploaded_at IS NOT NULL AND deleted_at IS NULL
       AND (
         (retention_class = 'clinical' AND uploaded_at < ?)
         OR (retention_class != 'clinical' AND uploaded_at < ?)
       )
     LIMIT 100`,
  ).bind(
    tenantId,
    now - PHOTO_CLINICAL_RETENTION_MS,
    now - PHOTO_STANDARD_RETENTION_MS,
  ).all<{ id: string; r2_key: string; thumbnail_key: string | null }>()

  for (const row of expiredPhotos) {
    await markPhotoDeleted(env, tenantId, row, 'expired', now)
  }
}

// ── Hono app ─────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── Tenant resolution middleware ─────────────────────────────────────────────

app.use('*', async (c, next) => {
  const host = c.req.header('Host') ?? ''
  // The literal string "null" sneaks in when a frontend interpolates a
  // missing slug into a URL — coerce it back to a real null so we don't
  // try to look up a tenant with slug='null'.
  const rawOverride = c.req.header('X-Tenant-Slug')
  const slugOverride = rawOverride && rawOverride !== 'null' ? rawOverride : null
  const rawUrlTenant = new URL(c.req.url).searchParams.get('tenant')
  const urlTenant = rawUrlTenant && rawUrlTenant !== 'null' ? rawUrlTenant : null
  const slug = slugOverride || urlTenant || extractSlug(host)

  if (slug) {
    try {
      // loadTenantBySlug is cache-aware: hit returns immediately, miss
      // populates the cache before returning.
      const tenant = await loadTenantBySlug(c.env, slug)
      c.set('tenant', tenant ?? null)
    } catch (e) {
      // DB error (e.g., missing tenants table on a fresh local D1) shouldn't
      // 500 the request. Log + treat as unknown tenant — downstream code
      // either serves marketing or 401s on auth-gated paths.
      console.error('[tenant-resolver] DB lookup failed:', e)
      c.set('tenant', null)
    }
  } else {
    c.set('tenant', null)
  }
  c.set('authToken', null)
  return next()
})

// ── CORS enforcement for widget embedding ────────────────────────────────────

/**
 * Check if an Origin is allowed to call a tenant's public chat API.
 *
 * Strict: every cross-origin request (the only kind that matters here — the
 * embed widget on the customer's site) must have an Origin matching a row in
 * `allowed_domains` for the tenant. localhost is allowed for dev. Same-origin
 * is no longer a free pass; that loophole was the bug behind 2026-04-26's
 * data exposure on `wildcare.wildcaresolutions.org`.
 */
async function isOriginAllowed(origin: string, tenant: Tenant | null, db: D1Database): Promise<boolean> {
  if (!origin) return false
  // Audit ralph-1 H9: some user agents (sandboxed iframes, certain Service
  // Worker modes) emit the literal string "null" as Origin. URL("null")
  // throws, which already fails closed — but handle explicitly so a future
  // refactor that catches the URL parse can't accidentally widen the policy.
  if (origin === 'null') return false
  let originHost: string
  try { originHost = new URL(origin).hostname }
  catch { return false }

  if (originHost === 'localhost' || originHost === '127.0.0.1') return true

  if (!tenant) return false

  try {
    // L-7: use cross-request domains cache to avoid a D1 round-trip on every
    // CORS-eligible request. Cache is invalidated when domains are added or
    // removed via the admin API (admin-misc.ts: addDomain/removeDomain).
    let domains = getCachedDomains(tenant.id)
    if (domains === null) {
      const { results } = await db.prepare(
        'SELECT domain FROM allowed_domains WHERE tenant_id = ?',
      ).bind(tenant.id).all()
      domains = results.map(r => r.domain as string)
      cacheDomains(tenant.id, domains)
    }
    for (const d of domains) {
      if (originHost === d || originHost.endsWith('.' + d)) return true
    }
  } catch { /* fail closed */ }

  return false
}

/**
 * M-6: within-request memoization for isOriginAllowed.
 *
 * For a normal cross-origin POST to /api/sessions the auth middleware runs
 * during next() (computing + caching the boolean), then the CORS post-next
 * header block reads the cached value — eliminating the second D1 query.
 * Origin and tenant are constant per request, so the boolean is safe to memo.
 */
async function isOriginAllowedCached(
  c: { get: (k: 'originAllowed') => boolean | undefined; set: (k: 'originAllowed', v: boolean) => void; env: { DB: D1Database } },
  origin: string,
  tenant: Tenant | null,
): Promise<boolean> {
  const cached = c.get('originAllowed')
  if (cached !== undefined) return cached
  const result = await isOriginAllowed(origin, tenant, c.env.DB)
  c.set('originAllowed', result)
  return result
}

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin')

  if (c.req.method === 'OPTIONS') {
    const tenant = c.get('tenant')
    const allowed = origin ? await isOriginAllowedCached(c, origin, tenant) : false

    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allowed && origin ? origin : '',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Slug',
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  await next()

  if (origin) {
    const tenant = c.get('tenant')
    const allowed = await isOriginAllowedCached(c, origin, tenant)

    if (allowed) {
      c.res.headers.set('Access-Control-Allow-Origin', origin)
      c.res.headers.set('Access-Control-Allow-Credentials', 'true')
    }
  }
})

// ── API auth middleware ──────────────────────────────────────────────────────
//
// Auth posture per route prefix:
//
//   /api/auth/request, /api/auth/verify, /api/config, /api/errors
//      → fully public (login flow + boot info)
//
//   /api/sessions, /api/messages, /api/feedback  → public chat API for the
//      embedded widget. Requires a tenant context AND the request's Origin
//      header to be in that tenant's allowed_domains (or localhost).
//      Same-origin loophole is closed.
//
//   everything else under /api/*  → tenant-scoped session required (Bearer
//      token OR cookie). DEV_AUTH_BYPASS short-circuits in local dev.

// TENANT-BINDING INVARIANT (P0-E):
//   On every authenticated route (/admin/* and authed legs of /api/*), the
//   session lookup uses `tenantCookiePrefix(tenant.slug)` where `tenant` is
//   the URL-derived tenant (host label, X-Tenant-Slug header, or ?tenant=
//   query — in that order). This means: an attacker presenting cookie A
//   under URL B causes the middleware to look for cookie wc_B_token, which
//   doesn't exist, so no session resolves → 401.
//
//   The audit P0-E worry was that a future handler could read c.get('tenant')
//   without going through this gate and act on URL-supplied tenant B's data.
//   That risk is real but mitigated structurally: every route module mounts
//   under either /admin/*, /api/*, or /platform/*, each of which has its
//   own auth gate above. New routes that bypass these gates are a code-
//   review failure, not a runtime concern.
//
//   The regression suite in test/router.test.ts ("P0-E: ..." tests) pins
//   the safe behavior so a future change that introduces a slug-override
//   bypass shows up red instead of silently widening the surface.

app.use('/api/*', async (c, next) => {
  const path = c.req.path

  // Public-by-design endpoints. /api/auth/* is the magic-link flow; /api/config
  // is bootstrap info; /api/errors is unauth client error reporting.
  if (path === '/api/config' || path === '/api/errors' ||
      path === '/api/auth/request' || path === '/api/auth/verify') {
    return next()
  }

  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)

  // Public chat API — used by the embed widget on customer sites. Origin
  // allowlist enforced at the route level (not just CORS response headers).
  if (path.startsWith('/api/sessions') || path === '/api/messages' || path === '/api/feedback') {
    if (isDevAuthBypass(c.env)) return next()
    const origin = c.req.header('Origin')
    if (!origin) return c.json({ error: 'Origin header required' }, 403)
    const allowed = await isOriginAllowedCached(c, origin, tenant)
    if (allowed) return next()
    // Allow the admin's own preview iframe: its Origin is the tenant admin
    // host (e.g. wildcare.wildcaresolutions.org), which we deliberately don't
    // put in allowed_domains (that was the 2026-04-26 vuln). Instead, we let
    // it through only when the request carries a valid operator session
    // cookie — anonymous same-origin requests still 403, so the vuln stays
    // closed. Cross-origin embeds don't send cookies by default, so this
    // branch can't widen access for them.
    const verified = await resolveSession(c.req.raw, tenantCookiePrefix(tenant.slug), c.env)
    if (verified && verified.tenantId === tenant.id) return next()
    return c.json({ error: 'Origin not allowed for this tenant' }, 403)
  }

  // Everything else under /api/* requires a tenant-scoped session.
  if (isDevAuthBypass(c.env)) return next()

  const verified = await resolveSession(c.req.raw, tenantCookiePrefix(tenant.slug), c.env)
  if (!verified || verified.tenantId !== tenant.id) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  return next()
})

// ── Admin auth middleware ────────────────────────────────────────────────────

app.use('/admin/*', async (c, next) => {
  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)

  if (isDevAuthBypass(c.env)) return next()

  const verified = await resolveSession(c.req.raw, tenantCookiePrefix(tenant.slug), c.env)
  if (verified && verified.isAdmin && verified.tenantId === tenant.id) return next()

  return c.json({ error: 'Unauthorized' }, 401)
})

// ── Platform admin auth middleware (admin.<root>) ────────────────────────────

app.use('/platform/*', async (c, next) => {
  const path = c.req.path

  // /platform/apply is the public-internet signup form. Turnstile-gated at
  // the route level (added in routes/platform.ts).
  if (path === '/platform/apply') return next()

  // /platform/setup/:slug is the tenant-self-config endpoint (poorly named —
  // it's NOT platform-global). Tenant operators signed in at their own
  // subdomain need to hit it, but their session uses the tenant cookie
  // prefix, not the platform one. Defer auth to the route handler, which
  // accepts both Bearer + tenant-cookie sessions.
  if (path.startsWith('/platform/setup/')) return next()

  if (isDevAuthBypass(c.env)) return next()

  const verified = await resolveSession(c.req.raw, PLATFORM_COOKIE_PREFIX, c.env)
  if (verified && verified.role === 'platform' && verified.tenantId === PLATFORM_TENANT_ID) {
    return next()
  }

  return c.json({ error: 'Unauthorized' }, 401)
})

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', async (c) => {
  // Response shape contract: workers/src/types/health.ts. Mirrored byte-for-byte
  // by infra/watchdog/src/health.ts — update both together. The watchdog probes
  // this endpoint every 5 minutes and treats non-200 as outage.
  //
  // Defaults are 'unhealthy' so a missing assignment (typo, future refactor that
  // forgets to set a check) reports unhealthy by default. Each probe explicitly
  // marks 'healthy' only after the dependency call succeeds.
  const checks: Record<HealthCheckKey, HealthStatus> = {
    database: 'unhealthy',
    vectorize: 'unhealthy',
    storage: 'unhealthy',
    media_storage: 'unhealthy',
    ai: 'unhealthy',
  }

  // D1
  try {
    await c.env.DB.prepare('SELECT 1').run()
    checks.database = 'healthy'
  } catch (e) {
    console.error('[health] DB check failed:', e)
  }

  // Vectorize (768d cosine index)
  try {
    await c.env.VECTORIZE.query(new Array(768).fill(0), { topK: 1 })
    checks.vectorize = 'healthy'
  } catch (e) {
    console.error('[health] Vectorize check failed:', e)
  }

  // R2: head() returns null for missing keys without throwing. Any thrown error
  // means R2 is degraded (auth, network, regional outage). Historic versions of
  // this code masked R2 errors by setting 'healthy' in both branches; that hid
  // real R2 outages from the watchdog. Now we report unhealthy on throw.
  try {
    await c.env.R2.head('_health_check_nonexistent')
    checks.storage = 'healthy'
  } catch (e) {
    console.error('[health] R2 check failed:', e)
  }

  try {
    await c.env.MEDIA_BUCKET.head('_health_check_nonexistent')
    checks.media_storage = 'healthy'
  } catch (e) {
    console.error('[health] MEDIA_BUCKET check failed:', e)
  }

  // Workers AI — minimal embeddings call to verify the AI binding is live.
  // M-12: if the binding is unconfigured or the model fails, mark degraded
  // so health returns 503 instead of 200 while every chat request fails.
  // 3-second timeout via Promise.race so a slow binding doesn't stall /health.
  try {
    const probe = (c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: 'health' }) as Promise<{ data?: number[][] }>)
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('ai probe timeout')), 3000),
    )
    const r = await Promise.race([probe, timeout])
    if (r?.data?.length) checks.ai = 'healthy'
  } catch (e) {
    console.error('[health] AI check failed:', e)
  }

  const allOk = Object.values(checks).every(s => s === 'healthy')
  const body: HealthResponse = {
    status: allOk ? 'healthy' : 'degraded',
    ...checks,
  }
  return c.json(body, allOk ? 200 : 503)
})

// ── Runtime config ───────────────────────────────────────────────────────────

app.get('/api/config', async (c) => {
  const tenant = c.get('tenant')

  // Common bits (public, returned regardless of tenant context)
  const turnstileSiteKey = c.env.TURNSTILE_SITE_KEY ?? ''
  const devAuthBypass = isDevAuthBypass(c.env)

  if (!tenant) {
    return c.json({
      platform: true,
      platform_name: getPlatformName(c.env),
      name: `${getPlatformName(c.env)} Platform`,
      tagline: 'AI Wildlife Rescue for Every Organization',
      turnstile_site_key: turnstileSiteKey,
      dev_auth_bypass: devAuthBypass,
    })
  }

  // Authed payload includes editable config; check via Bearer or cookie.
  const verified = await resolveSession(c.req.raw, tenantCookiePrefix(tenant.slug), c.env)
  const isAuthed = !!verified && verified.tenantId === tenant.id

  // The operator's admin (authed, same-origin cookie) sees their DRAFT; the
  // public embedded widget (cross-origin, unauthed) sees LIVE/published. The
  // split is automatic: unauthed → editing === the live row. Publish markers
  // (onboarded) are never draftable, so they always read from the live row.
  const editing = isAuthed ? overlayTenant(tenant) : tenant
  const logoUrl = editing.logo_r2_key ? `/assets/${editing.logo_r2_key}` : null

  return c.json({
    platform: false,
    platform_name: getPlatformName(c.env),
    name: editing.name,
    phone: editing.phone,
    url: editing.url,
    email: editing.email,
    location: {
      county: editing.location_county,
      state: editing.location_state,
      service_area: editing.location_service_area,
    },
    branding: {
      primary_color: editing.color_primary,
      secondary_color: editing.color_secondary,
      accent_color: editing.color_accent,
    },
    logo_url: logoUrl,
    cookie_prefix: tenantCookiePrefix(tenant.slug),
    has_password: !!tenant.password_hash && tenant.password_hash !== 'LEGACY_SITE_PASSWORD',
    requires_login: true,
    onboarded: !!tenant.onboarded,
    turnstile_site_key: turnstileSiteKey,
    dev_auth_bypass: devAuthBypass,
    custom_instruction: isAuthed ? (editing.custom_instruction ?? '') : undefined,
    org_config: isAuthed ? parseOrgConfig(editing.org_config) : undefined,
    bot_overrides: isAuthed ? parseOrgConfig<Record<string, unknown>>(editing.bot_overrides) : undefined,
    house_rules: isAuthed ? (editing.house_rules ?? '') : undefined,
    report_recipients: isAuthed ? (editing.report_recipients ?? '') : undefined,
    daily_reports_enabled: isAuthed ? Boolean(editing.daily_reports_enabled) : undefined,
    // Unpublished-changes signal for the global Discard/Publish bar.
    has_unpublished_changes: isAuthed ? hasDraft(tenant) : undefined,
    draft_updated_at: isAuthed ? tenant.draft_updated_at : undefined,
    widget_custom_css: editing.widget_custom_css ?? null,
    widget_theme: editing.widget_theme ? parseOrgConfig<Record<string, unknown>>(editing.widget_theme) : null,
    // CDN-cached embed host the operator points partners at, when configured
    // (PLATFORM_EMBED_HOST in org.env). Null = fork hasn't wired one; the
    // admin Publish UI falls back to the worker-origin `/widget.js`.
    embed_host: getEmbedHost(c.env),
  })
})

// ── R2 asset serving ─────────────────────────────────────────────────────────

// Public R2 asset route — used for tenant logos only. The R2 bucket also
// stores private content (RAG source docs uploaded via platform/signup,
// exports, anything else routed through env.R2 in future). Those MUST NOT
// be reachable through this unauthenticated route.
//
// Audit ralph-1 M12: previously this served any key whose path matched
// /assets/<key>, relying entirely on "today's keys are unguessable" as the
// safety story. Make it structural — the only public-by-design key shape
// today is `tenants/<uuid>/logo.<ext>`. Anything else needs an authed route.
// Audit ralph-2 H5: pin the extension set explicitly. The upload route
// enforces ALLOWED_IMAGE_EXTS (jpg/jpeg/png/webp — SVG dropped per C1) but
// that's upstream trust; mirror the set here so the asset route fails
// closed when the input is anything else.
const PUBLIC_LOGO_KEY = /^tenants\/[0-9a-f-]{8,}\/logo\.(?:jpg|jpeg|png|webp)$/i

app.get('/assets/*', async (c) => {
  const key = c.req.path.slice('/assets/'.length)
  if (!key) return c.json({ error: 'Not found' }, 404)
  // Defense-in-depth: even though R2 keys aren't filesystem paths, refuse
  // anything that doesn't match the public namespace shape. Tenant-private
  // blobs and platform internals share the bucket; they must not be reachable
  // through this route.
  if (!PUBLIC_LOGO_KEY.test(key)) return c.json({ error: 'Not found' }, 404)

  const object = await c.env.R2.get(key)
  if (!object) return c.json({ error: 'Not found' }, 404)

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Cache-Control', 'public, max-age=3600')
  // Audit ralph-2 C1: defense-in-depth on the asset path.
  //   - nosniff prevents browsers from MIME-guessing an unintended type
  //     out of a stored byte sequence.
  //   - frame-deny stops a malicious logo from embedding the same origin
  //     into an attacker-controlled iframe.
  //   - CSP `default-src 'none'` neutralizes any inline <script> a future
  //     SVG-allowlist re-introduction would otherwise re-enable. Even with
  //     SVG dropped from ALLOWED_IMAGE_EXTS, the header costs nothing and
  //     pins the contract.
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")

  return new Response(object.body, { headers })
})

// Fail-open helper: if the binding throws (misconfigured namespace, transient
// platform fault), allow the request and log — this is a cost-DoS guard, not
// an auth gate. A misconfigured binding should not take the service down.
async function rlCheck(binding: RateLimit, key: string): Promise<boolean> {
  try {
    return (await binding.limit({ key })).success
  } catch (err) {
    logWarn('rate-limit-binding-error', { key, error: String(err) })
    return true  // fail open
  }
}

// ── Rate limiting middleware for public chat endpoints ────────────────────────

// POST /api/sessions/* — chat messages (per-IP + per-tenant)
app.use('/api/sessions/*', async (c, next) => {
  if (c.req.method !== 'POST') return next()
  const ip = clientIp(c)
  if (!(await rlCheck(c.env.RL_IP_CHAT, ip))) {
    return c.json({ error: 'Rate limit exceeded. Please wait before sending more messages.' }, 429,
      { 'Retry-After': '60' })
  }
  const tenant = c.get('tenant')
  if (tenant) {
    if (!(await rlCheck(c.env.RL_TENANT, `chat:${tenant.id}`))) {
      return c.json({ error: 'Tenant rate limit exceeded. Try again in a minute.', scope: 'tenant' }, 429,
        { 'Retry-After': '60' })
    }
  }
  return next()
})

// POST /api/sessions — session creation (per-IP + per-tenant)
app.use('/api/sessions', async (c, next) => {
  if (c.req.method !== 'POST') return next()
  const ip = clientIp(c)
  if (!(await rlCheck(c.env.RL_IP_SESSION, ip))) {
    return c.json({ error: 'Rate limit exceeded. Please wait before creating new sessions.' }, 429,
      { 'Retry-After': '60' })
  }
  const tenant = c.get('tenant')
  if (tenant) {
    if (!(await rlCheck(c.env.RL_TENANT, `sess:${tenant.id}`))) {
      return c.json({ error: 'Tenant rate limit exceeded. Try again in a minute.', scope: 'tenant' }, 429,
        { 'Retry-After': '60' })
    }
  }
  return next()
})

// ── Mount route modules ──────────────────────────────────────────────────────

app.route('/', chat)
app.route('/', admin)
app.route('/', platform)
app.route('/', agent)
app.route('/', authRoutes)

// ── Export ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // Let Hono handle all API, admin, platform API, health, and asset routes
    if (path.startsWith('/api/') || path.startsWith('/admin/') ||
        path.startsWith('/platform/') || path.startsWith('/assets/') ||
        path === '/health') {
      return app.fetch(request, env, ctx)
    }

    // Static asset directories served by Workers Assets directly (no auth gate,
    // no host-based rewrite). Add to this list if a new static directory ships.
    // The path.includes('.') 404 below would otherwise reject requests like
    // `/styles/field-notes.css` because the apex routing layer assumes no
    // extension means "marketing page" and rewrites accordingly.
    if (path.startsWith('/styles/') || path.startsWith('/data/') || path.startsWith('/img/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request)
      return fetch(request)
    }

    // Detect tenant context
    const host = request.headers.get('Host') ?? ''
    const slugHeader = request.headers.get('X-Tenant-Slug')
    const slugQuery = url.searchParams.get('tenant')
    const slugFromHost = extractSlug(host)
    const slug = slugHeader || slugQuery || slugFromHost

    // Static file requests pass through to the rejected-path handler.
    if (path.includes('.')) {
      return new Response('Not found', { status: 404 })
    }

    // ── Server-side auth gate ──────────────────────────────────────────────
    //
    // The Worker decides which HTML to serve based on the host AND the
    // session cookie BEFORE handing off to the assets binding. This is the
    // critical fix from the 2026-04-26 incident: previously the unauth'd
    // tenant URL served the admin dashboard shell, leaking structure +
    // letting the JS render data via under-protected /api/* routes.
    //
    // Surfaces:
    //   apex / www                      → marketing (public, no gate)
    //   admin.<root>  + valid session   → platform admin dashboard
    //   admin.<root>  + no session      → platform admin login form
    //   tenant.<root> + valid session   → operator dashboard (admin.html)
    //   tenant.<root> + no session      → tenant login form (login.html)

    const rewrittenUrl = new URL(url)
    const devBypass = isDevAuthBypass(env)

    if (hostFirstLabel(host) === 'smoke') {
      // Smoke test page — highest priority, before tenant/slug routing so a
      // ?tenant= query param doesn't accidentally route to login.html.
      // Serves the embed widget at a stable non-localhost origin so CI can
      // test CORS with a real allowed_domains DB lookup.
      // smoke.wildcaresolutions.org must be seeded in allowed_domains for the
      // tenant under test (idempotent INSERT OR IGNORE in the `smoke` CI job).
      const embedHost = getEmbedHost(env)
      const scriptSrc = embedHost ? `https://${embedHost}/v1.js` : '/widget.js'
      const tenantSlug = url.searchParams.get('tenant') ?? 'wildcare'
      return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<title>smoke</title></head><body>` +
        `<script src="${scriptSrc}" data-tenant="${tenantSlug}"></script>` +
        `</body></html>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      )

    } else if (isAdminHost(host)) {
      // Platform admin host. Cookie is wc_platform_*.
      const session = devBypass ? null
        : await resolveSession(request, PLATFORM_COOKIE_PREFIX, env)
      const authed = devBypass || (session?.role === 'platform' && session?.tenantId === PLATFORM_TENANT_ID)
      rewrittenUrl.pathname = authed ? '/platform-admin.html' : '/login.html'

    } else if (slug) {
      // Tenant subdomain (or query/header override). Look up tenant to
      // determine cookie prefix and confirm the slug actually exists.
      let tenant: Tenant | null = null
      try {
        tenant = await loadTenantBySlug(env, slug)
      } catch (e) {
        // DB lookup failed (missing table on fresh local D1, transient
        // outage, etc.). Don't 500 — fall through to the unknown-tenant
        // path below and serve marketing.
        console.error('[asset-router] tenant lookup failed:', e)
      }

      if (!tenant) {
        // Unknown slug — don't leak any info, just serve marketing.
        rewrittenUrl.pathname = '/platform.html'
      } else {
        const session = devBypass ? null
          : await resolveSession(request, tenantCookiePrefix(tenant.slug), env)
        const authed = devBypass || (session && session.tenantId === tenant.id)
        rewrittenUrl.pathname = authed ? '/admin.html' : '/login.html'
      }

    } else if (path === '/platform-admin' || path === '/platform-admin/') {
      // Legacy path: /platform-admin on apex. Mirror the admin host gate.
      const session = devBypass ? null
        : await resolveSession(request, PLATFORM_COOKIE_PREFIX, env)
      const authed = devBypass || (session?.role === 'platform' && session?.tenantId === PLATFORM_TENANT_ID)
      rewrittenUrl.pathname = authed ? '/platform-admin.html' : '/login.html'

    } else if (path === '/find' || path === '/find/') {
      // Public wildlife rehab directory (founding partners + future joiners).
      rewrittenUrl.pathname = '/find.html'

    } else {
      // Apex / www: marketing. Always. Logged-in operators visit the tenant
      // subdomain (or, on test, the ?tenant=<slug> URL) for their dashboard.
      rewrittenUrl.pathname = '/platform.html'
    }

    // Use ASSETS binding if available (production), otherwise fetch (local dev)
    const assetReq = new Request(rewrittenUrl.toString(), request)
    if (env.ASSETS) return env.ASSETS.fetch(assetReq)
    return fetch(assetReq)
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Two cron triggers fire daily:
    //   0 3 * * *   → photo retention + reservation reaper + data retention.
    //   0 14 * * *  → data retention + daily reports for opted-in tenants.
    const cron = event.cron

    const isReportCron = cron === '0 14 * * *'
    try {
      // Cleanup expired auth tokens — fire-and-forget, not blocking.
      ctx.waitUntil(
        env.DB.prepare('DELETE FROM citizen_session_tokens WHERE expires_at < ?')
          .bind(Date.now())
          .run()
          .catch(e => console.error('[scheduled] Session-token cleanup failed:', e)),
      )
      // M-14: purge expired magic link tokens (accumulate indefinitely otherwise;
      // previously cleaned only when the same email requested a new token).
      ctx.waitUntil(
        env.DB.prepare("DELETE FROM magic_tokens WHERE expires_at < datetime('now')")
          .run()
          .catch(e => console.error('[scheduled] magic_tokens cleanup failed:', e)),
      )
      const { results: tenants } = await env.DB.prepare(
        'SELECT id, message_retention_days, analysis_retention_days, daily_reports_enabled FROM tenants',
      ).all()

      // L-15: process tenant retention in sequential batches of 10 to avoid
      // spawning hundreds of concurrent D1 writes on large deployments.
      // Reports remain fire-and-forget (ctx.waitUntil) inside each tenant task.
      const retentionTasks = tenants.map(t => async () => {
        if (isReportCron && (t.daily_reports_enabled as number) === 1) {
          ctx.waitUntil(
            generateReport(env, t.id as string, false).catch(e =>
              console.error(`[scheduled] Report failed for tenant ${t.id}:`, e),
            ),
          )
        }
        const msgDays = (t.message_retention_days as number) || 90
        const analysisDays = (t.analysis_retention_days as number) || 30
        await Promise.all([
          env.DB.prepare(
            `DELETE FROM messages WHERE tenant_id = ? AND timestamp < ?`,
          ).bind(t.id, Date.now() - msgDays * 86_400_000).run(),
          env.DB.prepare(
            `UPDATE session_analysis SET contact_info = NULL WHERE tenant_id = ? AND contact_info IS NOT NULL AND analyzed_at < datetime('now', '-' || ? || ' days')`,
          ).bind(t.id, analysisDays).run(),
          runPhotoRetention(env, t.id as string),
        ]).catch(e => console.error(`[scheduled] Retention cleanup failed for tenant ${t.id}:`, e))
      })

      ctx.waitUntil((async () => {
        for (let i = 0; i < retentionTasks.length; i += 10) {
          await Promise.all(retentionTasks.slice(i, i + 10).map(fn => fn()))
        }
      })())
    } catch (e) {
      console.error('[scheduled] Failed to query tenants for reports:', e)
    }
  },
}
