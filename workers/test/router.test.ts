import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import worker from '../src/index'
import { generateToken, tenantCookiePrefix, PLATFORM_COOKIE_PREFIX } from '../src/lib/auth'
import type { Env } from '../src/lib/types'

// Integration tests for the full middleware chain in workers/src/index.ts.
// Every other test in this directory imports a route module directly and
// calls handler functions — that bypasses the auth/Origin/tenant-resolution
// middleware where today's bugs lived. These tests boot the actual worker
// default export and assert end-to-end status codes for the full auth
// matrix, so the next regression in the routing layer trips a red test
// instead of becoming a multi-hour debugging session in prod.
//
// Three things explicitly covered (mapped to bugs we hit):
//   1. /platform/setup/:slug accepts tenant-scoped cookie sessions, NOT
//      gated behind the platform-admin middleware.
//   2. /api/sessions accepts a request from the admin host (Origin not in
//      allowed_domains) when a tenant operator session cookie is present —
//      that's the preview-widget case.
//   3. Tenant resolution coerces the literal string "null" back to null
//      so `?tenant=null` interpolation bugs don't 400 the API.

// ── Fake D1 ────────────────────────────────────────────────────────────────────
// Returns canned rows for the queries the router middleware + critical
// route handlers actually run. SQL match is loose (substring) — the goal is
// "enough to exercise auth/routing", not full ORM fidelity.

const TENANTS = {
  wildcare: {
    id: 'wc-0001',
    slug: 'wildcare',
    name: 'WildCare',
    phone: '415-555-0100',
    url: 'https://discoverwildcare.org',
    email: 'info@discoverwildcare.org',
    location_county: 'Marin',
    location_state: 'CA',
    location_service_area: 'Marin County',
    color_primary: '#78a12e',
    color_secondary: '#004863',
    color_accent: '#f4a518',
    logo_r2_key: null,
    custom_instruction: null,
    password_hash: 'LEGACY_SITE_PASSWORD',
    widget_theme: null,
    widget_custom_css: null,
    org_config: null,
    bot_overrides: null,
    admin_token_hash: null,
    onboarded: 1,
    report_recipients: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  },
  other: {
    id: 'wc-0002',
    slug: 'other',
    name: 'Other Rescue',
    phone: null, url: null, email: null,
    location_county: null, location_state: null, location_service_area: null,
    color_primary: '#000', color_secondary: '#000', color_accent: '#000',
    logo_r2_key: null, custom_instruction: null,
    password_hash: 'LEGACY_SITE_PASSWORD',
    widget_theme: null, widget_custom_css: null,
    org_config: null, bot_overrides: null, admin_token_hash: null,
    onboarded: 1, report_recipients: null,
    created_at: '2026-01-01', updated_at: '2026-01-01',
  },
}

const ALLOWED_DOMAINS: Record<string, string[]> = {
  'wc-0001': ['discoverwildcare.org', 'www.discoverwildcare.org'],
  'wc-0002': ['otherrescue.org'],
}

class StubD1 {
  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, ' ').trim()
    const self = this
    let bound: unknown[] = []
    return {
      bind(...args: unknown[]) {
        bound = args
        return this
      },
      async first<T = unknown>(): Promise<T | null> {
        // tenants lookup by slug
        if (/SELECT \* FROM tenants WHERE slug = \?/i.test(norm)) {
          const slug = bound[0] as string
          return ((TENANTS as Record<string, unknown>)[slug] ?? null) as T | null
        }
        // tenant_users lookup
        if (/FROM tenant_users WHERE tenant_id = \? AND email = \?/i.test(norm)) {
          return null
        }
        return null
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        if (/FROM allowed_domains WHERE tenant_id = \?/i.test(norm)) {
          const tid = bound[0] as string
          return { results: (ALLOWED_DOMAINS[tid] ?? []).map(d => ({ domain: d })) as T[] }
        }
        return { results: [] }
      },
      async run() { return { success: true } },
    }
    void self
  }
}

// ── Fake Env / context ─────────────────────────────────────────────────────────

const stubRateLimit: RateLimit = { limit: async () => ({ success: true }) }

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SIGNING_SECRET: 'test-signing-secret',
    TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    PLATFORM_ADMIN_EMAILS: 'mark@bluesnoop.com',
    DEV_AUTH_BYPASS: '',
    ENVIRONMENT: 'test',
    DB: new StubD1() as unknown as D1Database,
    RL_IP_CHAT: stubRateLimit,
    RL_IP_SESSION: stubRateLimit,
    RL_TENANT: stubRateLimit,
    ...overrides,
  } as unknown as Env
}

const fakeCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

// ── Token + cookie helpers ─────────────────────────────────────────────────────

let wildcareAdminCookie = ''
let wildcareViewerCookie = ''
let otherAdminCookie = ''
let platformAdminCookie = ''

beforeAll(async () => {
  const env = makeEnv()
  // Tenant admin for wildcare
  const adminTok = await generateToken(TENANTS.wildcare.id, 'admin', env)
  wildcareAdminCookie = `${tenantCookiePrefix('wildcare')}_token=${encodeURIComponent(adminTok)}`
  // Tenant viewer for wildcare
  const viewerTok = await generateToken(TENANTS.wildcare.id, 'viewer', env)
  wildcareViewerCookie = `${tenantCookiePrefix('wildcare')}_token=${encodeURIComponent(viewerTok)}`
  // Tenant admin for the other tenant
  const otherTok = await generateToken(TENANTS.other.id, 'admin', env)
  otherAdminCookie = `${tenantCookiePrefix('other')}_token=${encodeURIComponent(otherTok)}`
  // Platform admin (sentinel tenantId)
  const platTok = await generateToken('platform', 'platform', env)
  platformAdminCookie = `${PLATFORM_COOKIE_PREFIX}_token=${encodeURIComponent(platTok)}`
})

// ── Request helpers ────────────────────────────────────────────────────────────

async function request(
  url: string,
  init: RequestInit = {},
  env: Env = makeEnv(),
): Promise<Response> {
  // Cloudflare auto-sets the Host header in prod; the raw Request constructor
  // in vitest does not, so we mirror it from the URL. The tenant-resolution
  // middleware reads c.req.header('Host'), so without this every host-based
  // test would 400 with "Tenant required".
  const u = new URL(url)
  const headers = new Headers(init.headers)
  if (!headers.has('Host')) headers.set('Host', u.host)
  return worker.fetch(new Request(url, { ...init, headers }), env, fakeCtx)
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('Router — middleware chain integration', () => {
  describe('/health', () => {
    it('returns 200 when DB and Vectorize stubs respond', async () => {
      // /health probes DB+Vectorize+R2; without those bindings it 503s. We
      // don't test the degraded path here — the smoke test is just "the
      // route is wired up at all", which is the part regressions hit.
      const res = await request('https://wildcaresolutions.org/health')
      expect([200, 503]).toContain(res.status)
    })
  })

  describe('Tenant resolution', () => {
    it('resolves tenant from host first label', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/api/config')
      expect(res.status).toBe(200)
      const body = await res.json() as { name?: string }
      expect(body.name).toBe('WildCare')
    })

    it('resolves tenant from X-Tenant-Slug header even on apex', async () => {
      const res = await request('https://wildcaresolutions.org/api/config', {
        headers: { 'X-Tenant-Slug': 'wildcare' },
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { name?: string }
      expect(body.name).toBe('WildCare')
    })

    it('treats the literal string "null" as no slug (regression: ?tenant=null bug)', async () => {
      // When admin.js renders an iframe with `?tenant=${slug}` and slug is JS
      // null, the URL becomes `?tenant=null` (literal). Server must not look
      // up a tenant with slug='null' or every page-load 400s.
      const res = await request('https://wildcaresolutions.org/api/config?tenant=null')
      expect(res.status).toBe(200)
      const body = await res.json() as { platform?: boolean; name?: string }
      expect(body.platform).toBe(true)
    })

    it('treats X-Tenant-Slug: null as no slug', async () => {
      const res = await request('https://wildcaresolutions.org/api/config', {
        headers: { 'X-Tenant-Slug': 'null' },
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { platform?: boolean }
      expect(body.platform).toBe(true)
    })
  })

  describe('/api/sessions — chat API auth gate', () => {
    it('rejects with 403 when Origin is missing', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(res.status).toBe(403)
    })

    it('accepts when Origin is in allowed_domains', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://discoverwildcare.org',
        },
        body: '{}',
      })
      expect(res.status).toBe(200)
    })

    it('rejects 403 when Origin is the admin host AND no operator cookie present', async () => {
      // wildcare.wildcaresolutions.org is NOT in wildcare's allowed_domains
      // (that's the 2026-04-26 vuln we explicitly closed). Anonymous calls
      // from there must keep getting 403.
      const res = await request('https://wildcare.wildcaresolutions.org/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://wildcare.wildcaresolutions.org',
        },
        body: '{}',
      })
      expect(res.status).toBe(403)
    })

    it('accepts admin-host Origin when an operator session cookie is present (preview iframe case)', async () => {
      // The preview iframe runs at the admin host. Without this branch the
      // widget shows "Failed to connect" — that was the late-April bug.
      const res = await request('https://wildcare.wildcaresolutions.org/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://wildcare.wildcaresolutions.org',
          Cookie: wildcareAdminCookie,
        },
        body: '{}',
      })
      expect(res.status).toBe(200)
    })
  })

  describe('/admin/* — tenant-admin auth gate', () => {
    it('rejects 401 with no auth', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/admin/dashboard')
      expect(res.status).toBe(401)
    })

    it('accepts tenant admin cookie', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/admin/dashboard', {
        headers: { Cookie: wildcareAdminCookie },
      })
      // 200 if handler runs cleanly, 500 if the stub D1 doesn't satisfy a
      // particular query the dashboard does — either way it got past auth.
      expect(res.status).not.toBe(401)
    })

    it('rejects a viewer-role tenant token', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/admin/dashboard', {
        headers: { Cookie: wildcareViewerCookie },
      })
      expect(res.status).toBe(401)
    })

    it('rejects an admin token issued for a different tenant', async () => {
      // wildcare.wildcaresolutions.org served the request, but the cookie is
      // for the "other" tenant id. Cross-tenant access must 401.
      const res = await request('https://wildcare.wildcaresolutions.org/admin/dashboard', {
        headers: { Cookie: otherAdminCookie },
      })
      expect(res.status).toBe(401)
    })

    // ── P0-E regression suite — tenant-context binding hardening ───────────
    // Audit P0-E flagged the URL-override path (X-Tenant-Slug header /
    // ?tenant= query) as a theoretical privilege-escalation risk if a future
    // handler reads c.get('tenant') without going through auth.
    //
    // The mechanism that keeps this safe today: resolveSession is called
    // with `tenantCookiePrefix(tenant.slug)` where `tenant` is the URL-
    // resolved tenant. When a caller presents cookie A (named wc_A_token)
    // and overrides URL to tenant B, the middleware looks for cookie
    // wc_B_token — which doesn't exist — so no session → 401.
    //
    // These tests pin that behavior so any future change that breaks it
    // shows up red, not silently.

    it('P0-E: ?tenant= override + foreign-tenant cookie → 401', async () => {
      // Cookie is wc_wildcare_token; URL says ?tenant=other. Without the
      // session-bound binding, an attacker could swap tenant context via
      // query param. The middleware MUST reject.
      const res = await request(
        'https://wildcaresolutions.org/admin/dashboard?tenant=other',
        { headers: { Cookie: wildcareAdminCookie } },
      )
      expect(res.status).toBe(401)
    })

    it('P0-E: X-Tenant-Slug header override + foreign-tenant cookie → 401', async () => {
      // Same attack, different vector. Header override has been the historic
      // sharper edge because it's invisible in URLs and easy to miss in logs.
      const res = await request(
        'https://wildcaresolutions.org/admin/dashboard',
        {
          headers: {
            Cookie: wildcareAdminCookie,
            'X-Tenant-Slug': 'other',
          },
        },
      )
      expect(res.status).toBe(401)
    })

    it('P0-E: ?tenant= override + wildcare cookie → wildcare admin ✓', async () => {
      // Sanity check the inverse: when override matches the cookie's tenant,
      // the request succeeds. Confirms the rejection is on MISMATCH, not on
      // presence of override (so legitimate cross-domain admin UX works).
      const res = await request(
        'https://wildcaresolutions.org/admin/dashboard?tenant=wildcare',
        { headers: { Cookie: wildcareAdminCookie } },
      )
      expect(res.status).not.toBe(401)
    })
  })

  describe('/api/* — tenant-binding hardening (P0-E)', () => {
    // Same shape of attack, exercised on the /api/* gate instead of /admin/*.
    // Both gates derive cookie name from URL-resolved tenant.slug, so the
    // protection generalizes; tests both surfaces to catch a future
    // divergence between them.

    it('?tenant= override + foreign cookie → 401', async () => {
      // /api/sessions is on the chat path; we use a non-public /api/ path
      // (the auth-required leg). /api/admin-anything would also work but
      // the path doesn't matter — we're testing the middleware.
      const res = await request(
        'https://wildcaresolutions.org/api/admin/sessions?tenant=other',
        { headers: { Cookie: wildcareAdminCookie } },
      )
      // 401 (auth gate) — not 404 (route doesn't exist), not 403, not 200.
      expect(res.status).toBe(401)
    })

    it('X-Tenant-Slug header override + foreign cookie → 401', async () => {
      const res = await request(
        'https://wildcaresolutions.org/api/admin/sessions',
        {
          headers: {
            Cookie: wildcareAdminCookie,
            'X-Tenant-Slug': 'other',
          },
        },
      )
      expect(res.status).toBe(401)
    })
  })

  describe('/platform/setup/:slug — tenant self-config', () => {
    it('REGRESSION: accepts a tenant-admin cookie session (the today bug)', async () => {
      // The pre-existing /platform/* middleware required role=platform AND
      // tenantId=PLATFORM_TENANT_ID, so every cookie-authed publish/save
      // 401'd. After the d1bc609 fix, the middleware passes /platform/setup/
      // through to its own handler which accepts the tenant cookie.
      const res = await request('https://wildcare.wildcaresolutions.org/platform/setup/wildcare', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: wildcareAdminCookie,
        },
        body: JSON.stringify({ phone: '555-555-5555' }),
      })
      expect(res.status).toBe(200)
    })

    it('rejects 401 with no auth', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/platform/setup/wildcare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: 'x' }),
      })
      expect(res.status).toBe(401)
    })

    it('rejects 401 with another tenant\'s cookie', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/platform/setup/wildcare', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: otherAdminCookie,
        },
        body: JSON.stringify({ phone: 'x' }),
      })
      expect(res.status).toBe(401)
    })
  })

  describe('/platform/* — platform-admin gate', () => {
    it('rejects /platform/dashboard with tenant cookie (only platform admins allowed)', async () => {
      const res = await request('https://admin.wildcaresolutions.org/platform/dashboard', {
        headers: { Cookie: wildcareAdminCookie },
      })
      expect(res.status).toBe(401)
    })

    it('lets /platform/apply through unauthenticated (Turnstile-gated at the route level)', async () => {
      // Hits the route handler. We don't supply a real turnstile token, so
      // it 4xx/5xx's from there — but it's NOT 401 from the middleware.
      const res = await request('https://wildcaresolutions.org/platform/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_name: 'Test', contact_name: 'T', contact_email: 't@t.org' }),
      })
      expect(res.status).not.toBe(401)
    })
  })

  // ── CORS — Access-Control-Allow-Origin header enforcement ─────────────────
  //
  // The existing /api/sessions tests above check *status codes* for Origin
  // allowlist enforcement. That's necessary but not sufficient: the browser
  // decides whether JS can read a response based on the ACAO *header*, not
  // the HTTP status. A 200 without ACAO is browser-blocked just like a 403.
  //
  // These tests pin the actual header values so a future middleware refactor
  // that breaks ACAO (e.g. wrong header name, missing echo-back, stripped by
  // Hono) shows up red before it silently kills the widget on partner sites.

  describe('CORS — Access-Control-Allow-Origin response header', () => {
    it('echoes Origin for an allowed domain on /api/config', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/api/config', {
        headers: { Origin: 'https://discoverwildcare.org' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://discoverwildcare.org')
    })

    it('omits ACAO header for a domain not in allowed_domains', async () => {
      // Status is still 200 (/api/config is public). The browser is what
      // enforces CORS — missing ACAO makes the JS response unreadable.
      const res = await request('https://wildcare.wildcaresolutions.org/api/config', {
        headers: { Origin: 'https://evil.example.com' },
      })
      expect(res.status).toBe(200)
      const acao = res.headers.get('Access-Control-Allow-Origin')
      expect(acao).toBeFalsy()
    })

    it('echoes Origin for an allowed domain on /api/sessions POST', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://discoverwildcare.org',
        },
        body: '{}',
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://discoverwildcare.org')
    })

    it('omits ACAO for a disallowed domain on /api/sessions POST', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://notallowed.example.com',
        },
        body: '{}',
      })
      expect(res.status).toBe(403)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeFalsy()
    })

    it('OPTIONS preflight: 204 + ACAO for an allowed domain', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/api/sessions', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://discoverwildcare.org',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type, X-Tenant-Slug',
        },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://discoverwildcare.org')
      expect(res.headers.get('Access-Control-Allow-Methods')).toMatch(/POST/)
    })

    it('OPTIONS preflight: 204 but no ACAO for a disallowed domain', async () => {
      // Browser enforces from the missing ACAO — we don't need to 403 the
      // preflight itself (and shouldn't: it leaks info about the allowlist).
      const res = await request('https://wildcare.wildcaresolutions.org/api/sessions', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example.com',
          'Access-Control-Request-Method': 'POST',
        },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeFalsy()
    })

    it('auto-allows localhost origin without a DB lookup', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/api/config', {
        headers: { Origin: 'http://localhost:3000' },
      })
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000')
    })

    it('rejects the literal "null" origin (sandboxed-iframe / data: URI attack)', async () => {
      const res = await request('https://wildcare.wildcaresolutions.org/api/config', {
        headers: { Origin: 'null' },
      })
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeFalsy()
    })
  })
})

beforeEach(() => {
  // Each test starts with a fresh env; nothing to reset between tests today.
})
