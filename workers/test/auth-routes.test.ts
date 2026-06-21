/**
 * Unit tests for workers/src/routes/auth.ts (handler-level, not full-worker).
 *
 * Strategy: wrap the `auth` Hono app in a parent app whose middleware injects
 * c.set('tenant', tenant) so handler guards fire correctly.  A fake
 * ExecutionContext (noop waitUntil) is passed as the 4th arg to app.request()
 * because /api/auth/request and /api/auth/users POST call c.executionCtx.waitUntil.
 *
 * Turnstile fetch is mocked globally for /api/auth/request tests (same
 * pattern as platform.test.ts).  All auth.ts routes have no EMAIL binding in
 * the test env, so sendEmail returns {sent:false, reason:'no_binding'} which
 * causes the request handler to echo dev_login_url in the response — a
 * deterministic, assertable signal.
 *
 * Key discrepancies between task description and actual code (addressed here):
 *   - /api/login + /api/admin-login NO LONGER EXIST — skipped.
 *   - POST /api/auth/verify failure paths return 200 HTML ("expired"),
 *     NOT 401.  Assertions check body text + absence of Set-Cookie.
 *   - PUT /api/auth/me ignores `role` entirely — "elevation" = silently
 *     dropped.
 *   - DELETE /api/auth/users/:id is idempotent — always returns success even
 *     for a non-existent id (no 404).
 *   - User-management role-gating (403) lives in index.ts middleware, not in
 *     the route handler.  These tests cover handler logic only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import auth, { issueMagicLink } from '../src/routes/auth'
import { generateToken } from '../src/lib/auth'
import type { Env, Variables, Tenant } from '../src/lib/types'

// ── Fake ExecutionContext ─────────────────────────────────────────────────────

const fakeCtx: ExecutionContext = {
  waitUntil(_p: Promise<unknown>) {},
  passThroughOnException() {},
}

// ── Stub Tenant ───────────────────────────────────────────────────────────────

const TENANT: Tenant = {
  id: 'tenant-id-1',
  slug: 'test-org',
  name: 'Test Org',
  phone: null,
  url: null,
  email: null,
  location_county: null,
  location_state: null,
  location_service_area: null,
  color_primary: '',
  color_secondary: '',
  color_accent: '',
  logo_r2_key: null,
  custom_instruction: null,
  password_hash: '',
  widget_theme: null,
  widget_custom_css: null,
  widget_published_at: null,
  org_config: null,
  bot_overrides: null,
  admin_token_hash: null,
  onboarded: 1,
  report_recipients: null,
  house_rules: null,
  custom_instruction_locked: 0,
  custom_instruction_locked_at: null,
  custom_instruction_locked_pending_review: null,
  feature_flags: null,
  draft_config: null,
  draft_updated_at: null,
  created_at: '',
  updated_at: '',
}

// ── Configurable FakeD1 ───────────────────────────────────────────────────────
// Routes .first() / .all() based on SQL substring matching. Records all
// prepared SQL strings + bind arguments for assertion.

class FakeD1 {
  // Injectable first() responses
  tokenRow: { token: string } | null = null             // issueMagicLink idempotent check
  tenantUserRow: { id: string } | null = null           // tenant membership check
  tenantRow: { slug: string } | null = null             // tenants slug lookup
  userProfileRow: { email: string; display_name: string | null; avatar_url: string | null; role: string } | null = null
  platformUserRow: { email: string; display_name: string | null; avatar_url: string | null } | null = null

  // Injectable all() responses
  magicCandidates: Array<{ id: string; token: string; email: string; tenant_id: string | null }> = []
  usersList: Array<{ id: string; email: string; role: string; created_at: string }> = []

  // Throw on .run() when SQL contains this pattern
  runThrowError: { pattern: string; message: string } | null = null

  // Recording
  sqls: string[] = []
  allBinds: unknown[][] = []

  prepare(sql: string) {
    this.sqls.push(sql)
    const self = this
    let boundArgs: unknown[] = []

    const stmt = {
      bind(...args: unknown[]) {
        boundArgs = args
        self.allBinds.push(args)
        return stmt
      },
      async run() {
        if (self.runThrowError && sql.includes(self.runThrowError.pattern)) {
          throw new Error(self.runThrowError.message)
        }
        return { success: true, meta: { changes: 1 } }
      },
      async first<T = unknown>(): Promise<T | null> {
        // issueMagicLink: existing-token idempotency check (has LIMIT 1)
        if (sql.includes('FROM magic_tokens') && sql.includes('LIMIT 1')) {
          return self.tokenRow as T | null
        }
        // tenant membership check for /api/auth/request
        if (sql.includes('SELECT id FROM tenant_users')) {
          return self.tenantUserRow as T | null
        }
        // tenants slug lookup for POST /api/auth/verify
        if (sql.includes('FROM tenants WHERE id = ?')) {
          return self.tenantRow as T | null
        }
        // platform_users lookup for GET /api/auth/me (platform admin)
        if (sql.includes('FROM platform_users')) {
          return self.platformUserRow as T | null
        }
        // tenant_users profile lookup for GET /api/auth/me (has display_name)
        if (sql.includes('FROM tenant_users') && sql.includes('display_name')) {
          return self.userProfileRow as T | null
        }
        return null
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        // magic_tokens candidates for GET + POST /api/auth/verify
        if (sql.includes('FROM magic_tokens')) {
          return { results: self.magicCandidates as T[] }
        }
        // tenant_users list for GET /api/auth/users
        if (sql.includes('FROM tenant_users') && sql.includes('created_at')) {
          return { results: self.usersList as T[] }
        }
        return { results: [] }
      },
    }
    return stmt
  }
}

// ── Env builder ───────────────────────────────────────────────────────────────

function makeEnv(db: FakeD1, overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    SIGNING_SECRET: 'test-signing-secret',
    TURNSTILE_SECRET_KEY: 'test-turnstile-key',
    DEV_AUTH_BYPASS: '',
    DB: db as unknown as D1Database,
    ...overrides,
  } as unknown as Env
}

// ── App harness ───────────────────────────────────────────────────────────────

function makeApp(tenant?: Tenant | null) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>()
  app.use('*', async (c, next) => {
    if (tenant != null) c.set('tenant', tenant)
    await next()
  })
  app.route('/', auth)
  return app
}

// Helper: fire a request through the app with fakeCtx injected.
async function appReq(
  app: ReturnType<typeof makeApp>,
  path: string,
  init: RequestInit,
  env: Env,
): Promise<Response> {
  return app.request(path, init, env, fakeCtx)
}

// Helper: generate a v2 Bearer token for a tenant user.
async function bearerFor(tenantId: string, email: string, env: Env): Promise<string> {
  return generateToken(tenantId, 'admin', env, email)
}

// ── Turnstile fetch mocking ───────────────────────────────────────────────────

const realFetch = globalThis.fetch

function turnstilePass() {
  // @ts-expect-error overriding global
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ success: true }), { status: 200 }),
  )
}

function turnstileFail() {
  // @ts-expect-error overriding global
  globalThis.fetch = vi.fn(async () =>
    new Response(
      JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }),
      { status: 200 },
    ),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// issueMagicLink (exported, tested directly)
// ─────────────────────────────────────────────────────────────────────────────

describe('issueMagicLink', () => {
  it('mints a new token and INSERTs when no existing token', async () => {
    const db = new FakeD1()
    db.tokenRow = null   // no existing token
    const env = makeEnv(db)

    const url = await issueMagicLink(env, {
      email: 'user@example.org',
      tenantId: TENANT.id,
      tenantSlug: TENANT.slug,
      host: 'localhost:8787',
    })

    expect(url).toContain('/api/auth/verify?token=')
    expect(url).toContain('&email=user%40example.org')
    expect(url).toContain('tenant=test-org')
    // Should have run both the SELECT and the INSERT
    expect(db.sqls.some(s => s.includes('INSERT INTO magic_tokens'))).toBe(true)
  })

  it('reuses an existing unexpired unused token (idempotent — no INSERT)', async () => {
    const db = new FakeD1()
    db.tokenRow = { token: 'existing-reuse-token' }
    const env = makeEnv(db)

    const url = await issueMagicLink(env, {
      email: 'user@example.org',
      tenantId: TENANT.id,
      tenantSlug: TENANT.slug,
      host: 'localhost:8787',
    })

    expect(url).toContain('existing-reuse-token')
    expect(db.sqls.some(s => s.includes('INSERT INTO magic_tokens'))).toBe(false)
  })

  it('builds an https:// URL for non-localhost hosts', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)

    const url = await issueMagicLink(env, {
      email: 'user@example.org',
      tenantId: TENANT.id,
      tenantSlug: TENANT.slug,
      host: 'test-org.wildcaresolutions.org',
    })

    expect(url).toMatch(/^https:\/\//)
  })

  it('builds an http:// URL for localhost hosts', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)

    const url = await issueMagicLink(env, {
      email: 'user@example.org',
      tenantId: TENANT.id,
      tenantSlug: TENANT.slug,
      host: 'localhost:8787',
    })

    expect(url).toMatch(/^http:\/\/localhost/)
  })

  it('omits the tenant query param when slug is empty (platform admin)', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)

    const url = await issueMagicLink(env, {
      email: 'ops@example.org',
      tenantId: null,
      tenantSlug: '',
      host: 'localhost:8787',
    })

    expect(url).not.toContain('tenant=')
    expect(url).toContain('token=')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/request
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/request', () => {
  beforeEach(() => { turnstilePass() })
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('valid email + tenant member → 200 with dev_login_url, INSERTs magic_tokens', async () => {
    const db = new FakeD1()
    db.tenantUserRow = { id: 'user-1' }    // user exists in tenant
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Host': 'localhost:8787' },
      body: JSON.stringify({ email: 'user@example.org', turnstile_token: 'tok' }),
    }, env)

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.success).toBe(true)
    // No EMAIL binding → returns dev_login_url
    expect(typeof body.dev_login_url).toBe('string')
    expect(db.sqls.some(s => s.includes('INSERT INTO magic_tokens'))).toBe(true)
  })

  it('missing email → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstile_token: 'tok' }),
    }, env)

    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toMatch(/email/i)
  })

  it('invalid email format → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', turnstile_token: 'tok' }),
    }, env)

    expect(res.status).toBe(400)
    expect((await res.json() as Record<string, unknown>).error).toMatch(/email/i)
  })

  it('invalid JSON body → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not{json',
    }, env)

    expect(res.status).toBe(400)
  })

  it('email not in tenant_users → generic 200 (no magic link issued)', async () => {
    const db = new FakeD1()
    db.tenantUserRow = null    // not a member
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Host': 'localhost:8787' },
      body: JSON.stringify({ email: 'stranger@example.org', turnstile_token: 'tok' }),
    }, env)

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.message).toMatch(/If this email has access/i)
    // No magic link should have been issued
    expect(db.sqls.some(s => s.includes('INSERT INTO magic_tokens'))).toBe(false)
  })

  it('turnstile rejected → 400 with reason', async () => {
    turnstileFail()
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify({ email: 'user@example.org', turnstile_token: 'bad' }),
    }, env)

    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toMatch(/captcha/i)
  })

  it('missing TURNSTILE_SECRET_KEY → 503 service unavailable', async () => {
    const db = new FakeD1()
    const env = makeEnv(db, { TURNSTILE_SECRET_KEY: '' })
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.org', turnstile_token: 'tok' }),
    }, env)

    expect(res.status).toBe(503)
  })

  it('platform-admin email at no-tenant host → 200 with dev_login_url', async () => {
    const db = new FakeD1()
    // No tenant context; email is configured as platform admin
    const env = makeEnv(db, { PLATFORM_ADMIN_EMAILS: 'ops@example.org' })
    const app = makeApp(null)   // no tenant injected

    const res = await appReq(app, '/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Host': 'localhost:8787' },
      body: JSON.stringify({ email: 'ops@example.org', turnstile_token: 'tok' }),
    }, env)

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.success).toBe(true)
    expect(typeof body.dev_login_url).toBe('string')
    expect(db.sqls.some(s => s.includes('INSERT INTO magic_tokens'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/verify  (landing page — does NOT consume the token)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/auth/verify', () => {
  it('matched token → 200 HTML with sign-in form', async () => {
    const db = new FakeD1()
    db.magicCandidates = [{ id: 'tok-1', token: 'valid-tok', email: 'user@example.org', tenant_id: TENANT.id }]
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/verify?token=valid-tok&email=user@example.org', {
      method: 'GET',
    }, env)

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<form')
    expect(html).toContain('method="POST"')
  })

  it('no matching token → 200 HTML with "expired" message', async () => {
    const db = new FakeD1()
    db.magicCandidates = []    // no valid candidates
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/verify?token=no-such-token&email=user@example.org', {
      method: 'GET',
    }, env)

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.toLowerCase()).toContain('expired')
  })

  it('missing token → 400 Invalid link', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/verify?email=user@example.org', {
      method: 'GET',
    }, env)

    expect(res.status).toBe(400)
  })

  it('missing email → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/verify?token=tok', {
      method: 'GET',
    }, env)

    expect(res.status).toBe(400)
  })

  it('invalid email format → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/verify?token=tok&email=notanemail', {
      method: 'GET',
    }, env)

    expect(res.status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify  (actually consumes the token + sets cookies)
//
// NOTE: failure paths return 200 HTML (c.html), NOT 401.
//       Success returns 200 HTML with Set-Cookie headers.
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/verify', () => {
  const MAGIC_TOKEN = 'magic-test-token-abc123'

  function dbWithToken(): FakeD1 {
    const db = new FakeD1()
    db.magicCandidates = [{
      id: 'tok-row-1',
      token: MAGIC_TOKEN,
      email: 'user@example.org',
      tenant_id: TENANT.id,
    }]
    db.tenantRow = { slug: TENANT.slug }
    return db
  }

  it('valid token via JSON → 200, sets _token / _auth / _tester_email cookies', async () => {
    const db = dbWithToken()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Host': 'localhost:8787' },
      body: JSON.stringify({ token: MAGIC_TOKEN, tenant: TENANT.slug, email: 'user@example.org' }),
    }, env)

    expect(res.status).toBe(200)
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie') ?? '']
    const combined = setCookies.join(' ')
    expect(combined).toContain('_token=')
    expect(combined).toContain('_auth=')
    expect(combined).toContain('_tester_email=')
  })

  it('valid token marks magic_tokens row as used', async () => {
    const db = dbWithToken()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    await appReq(app, '/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Host': 'localhost:8787' },
      body: JSON.stringify({ token: MAGIC_TOKEN, tenant: TENANT.slug, email: 'user@example.org' }),
    }, env)

    expect(db.sqls.some(s => s.includes('UPDATE magic_tokens SET used = 1'))).toBe(true)
  })

  it('valid token via form-urlencoded → 200, cookies set', async () => {
    const db = dbWithToken()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const body = new URLSearchParams({
      token: MAGIC_TOKEN,
      tenant: TENANT.slug,
      email: 'user@example.org',
    })
    const res = await appReq(app, '/api/auth/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Host': 'localhost:8787',
      },
      body: body.toString(),
    }, env)

    expect(res.status).toBe(200)
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie') ?? '']
    expect(setCookies.join(' ')).toContain('_token=')
  })

  it('unknown / expired token → 200 HTML with "expired" text, no Set-Cookie', async () => {
    const db = new FakeD1()
    db.magicCandidates = []   // nothing matches
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token', tenant: '', email: 'user@example.org' }),
    }, env)

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.toLowerCase()).toContain('expired')
    // No session cookie should be issued
    const cookieHeader = res.headers.get('Set-Cookie') ?? ''
    expect(cookieHeader).not.toContain('_token=')
  })

  it('token already used (filtered by used=0 → empty candidates) → 200 expired HTML', async () => {
    const db = new FakeD1()
    // Simulate a used token: the DB WHERE used=0 filtered it out → empty
    db.magicCandidates = []
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'used-token', email: 'user@example.org' }),
    }, env)

    expect(res.status).toBe(200)
    expect((await res.text()).toLowerCase()).toContain('expired')
  })

  it('missing token → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.org' }),
    }, env)

    expect(res.status).toBe(400)
  })

  it('missing email → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'some-token' }),
    }, env)

    expect(res.status).toBe(400)
  })

  it('invalid JSON body → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    }, env)

    expect(res.status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/auth/me', () => {
  it('valid Bearer token + tenant user → 200 with email/role/tenant_name', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    db.userProfileRow = {
      email: 'user@example.org',
      display_name: 'Alice',
      avatar_url: null,
      role: 'admin',
    }
    const app = makeApp(TENANT)
    const tok = await bearerFor(TENANT.id, 'user@example.org', env)

    const res = await appReq(app, '/api/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${tok}` },
    }, env)

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.email).toBe('user@example.org')
    expect(body.role).toBe('admin')
    expect(body.tenant_name).toBe(TENANT.name)
    expect(body.display_name).toBe('Alice')
  })

  it('no auth header → 401 Not signed in', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/me', {
      method: 'GET',
    }, env)

    expect(res.status).toBe(401)
  })

  it('no tenant context → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(null)   // no tenant

    const res = await appReq(app, '/api/auth/me', {
      method: 'GET',
    }, env)

    expect(res.status).toBe(400)
  })

  it('user not found in tenant_users → 404', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    db.userProfileRow = null   // user not in DB
    const app = makeApp(TENANT)
    const tok = await bearerFor(TENANT.id, 'ghost@example.org', env)

    const res = await appReq(app, '/api/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${tok}` },
    }, env)

    expect(res.status).toBe(404)
  })

  it('platform admin email → 200 with role platform_admin', async () => {
    const db = new FakeD1()
    db.platformUserRow = {
      email: 'admin@example.org',
      display_name: 'Platform Admin',
      avatar_url: null,
    }
    const env = makeEnv(db, { PLATFORM_ADMIN_EMAILS: 'admin@example.org' })
    const app = makeApp(TENANT)
    const tok = await bearerFor(TENANT.id, 'admin@example.org', env)

    const res = await appReq(app, '/api/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${tok}` },
    }, env)

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.role).toBe('platform_admin')
    expect(body.display_name).toBe('Platform Admin')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /api/auth/me', () => {
  it('updates display_name and avatar_url → 200', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)
    const tok = await bearerFor(TENANT.id, 'user@example.org', env)

    const res = await appReq(app, '/api/auth/me', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ display_name: 'New Name', avatar_url: 'https://example.org/pic.jpg' }),
    }, env)

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.success).toBe(true)
    expect(body.display_name).toBe('New Name')
    expect(body.avatar_url).toBe('https://example.org/pic.jpg')
  })

  it('role field in request body is silently ignored (no privilege escalation)', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)
    const tok = await bearerFor(TENANT.id, 'user@example.org', env)

    const res = await appReq(app, '/api/auth/me', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ display_name: 'Hacker', role: 'admin' }),
    }, env)

    // Handler succeeds (no role-change error)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.success).toBe(true)
    // Response must NOT include a role field (handler never touches role)
    expect('role' in body).toBe(false)
    // The UPDATE SQL must not bind a role value
    const updateSql = db.sqls.find(s => s.includes('UPDATE tenant_users'))
    if (updateSql) {
      expect(updateSql).not.toContain('role')
    }
  })

  it('non-http avatar_url → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)
    const tok = await bearerFor(TENANT.id, 'user@example.org', env)

    const res = await appReq(app, '/api/auth/me', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ avatar_url: 'javascript:alert(1)' }),
    }, env)

    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(String(body.error)).toMatch(/http/i)
  })

  it('invalid JSON body → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)
    const tok = await bearerFor(TENANT.id, 'user@example.org', env)

    const res = await appReq(app, '/api/auth/me', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
      },
      body: '{bad json}',
    }, env)

    expect(res.status).toBe(400)
  })

  it('no auth → 401', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'X' }),
    }, env)

    expect(res.status).toBe(401)
  })

  it('platform admin → upserts into platform_users', async () => {
    const db = new FakeD1()
    const env = makeEnv(db, { PLATFORM_ADMIN_EMAILS: 'admin@example.org' })
    const app = makeApp(TENANT)
    const tok = await bearerFor(TENANT.id, 'admin@example.org', env)

    const res = await appReq(app, '/api/auth/me', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ display_name: 'Platform Admin' }),
    }, env)

    expect(res.status).toBe(200)
    // Should have used the platform_users upsert path
    expect(db.sqls.some(s => s.includes('platform_users'))).toBe(true)
    // NOT the tenant_users update path
    expect(db.sqls.some(s => s.includes('UPDATE tenant_users'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/users  (invite a new user)
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/users', () => {
  beforeEach(() => { turnstilePass() })
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('no tenant context → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(null)

    const res = await appReq(app, '/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.org' }),
    }, env)

    expect(res.status).toBe(400)
  })

  it('invalid JSON body → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bad{json',
    }, env)

    expect(res.status).toBe(400)
  })

  it('missing email → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    }, env)

    expect(res.status).toBe(400)
  })

  it('invalid email format → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    }, env)

    expect(res.status).toBe(400)
  })

  it('platform admin email → 400 This email is reserved', async () => {
    const db = new FakeD1()
    const env = makeEnv(db, { PLATFORM_ADMIN_EMAILS: 'ops@example.org' })
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Host': 'localhost:8787' },
      body: JSON.stringify({ email: 'ops@example.org' }),
    }, env)

    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(String(body.error)).toMatch(/reserved/i)
  })

  it('happy path → INSERT tenant_users + issue magic link + return success', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Host': 'localhost:8787' },
      body: JSON.stringify({ email: 'newuser@example.org', role: 'admin' }),
    }, env)

    expect(res.status).toBe(200)
    expect((await res.json() as Record<string, unknown>).success).toBe(true)
    expect(db.sqls.some(s => s.includes('INSERT INTO tenant_users'))).toBe(true)
    expect(db.sqls.some(s => s.includes('INSERT INTO magic_tokens'))).toBe(true)
  })

  it('UNIQUE constraint on tenant_users → 409 User already exists', async () => {
    const db = new FakeD1()
    db.runThrowError = {
      pattern: 'INSERT INTO tenant_users',
      message: 'UNIQUE constraint failed: tenant_users.email',
    }
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Host': 'localhost:8787' },
      body: JSON.stringify({ email: 'existing@example.org' }),
    }, env)

    expect(res.status).toBe(409)
    expect((await res.json() as Record<string, unknown>).error).toMatch(/already exists/i)
  })

  it('other DB error on INSERT → 500 Database error', async () => {
    const db = new FakeD1()
    db.runThrowError = {
      pattern: 'INSERT INTO tenant_users',
      message: 'D1_ERROR: disk full',
    }
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Host': 'localhost:8787' },
      body: JSON.stringify({ email: 'user2@example.org' }),
    }, env)

    expect(res.status).toBe(500)
    expect((await res.json() as Record<string, unknown>).error).toMatch(/database error/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/users  (list tenant users)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/auth/users', () => {
  it('returns the users list for the tenant', async () => {
    const db = new FakeD1()
    db.usersList = [
      { id: 'u1', email: 'a@example.org', role: 'admin', created_at: '2024-01-01' },
      { id: 'u2', email: 'b@example.org', role: 'viewer', created_at: '2024-01-02' },
    ]
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/users', {
      method: 'GET',
    }, env)

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body.users)).toBe(true)
    expect((body.users as unknown[]).length).toBe(2)
  })

  it('no tenant context → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(null)

    const res = await appReq(app, '/api/auth/users', {
      method: 'GET',
    }, env)

    expect(res.status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/auth/users/:userId
//
// NOTE: The handler is idempotent — it always returns {success:true} even for
//       a non-existent userId (no row-count check, no 404).
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /api/auth/users/:userId', () => {
  it('deletes and returns success, passing (id, tenantId) to the query', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/users/user-123', {
      method: 'DELETE',
    }, env)

    expect(res.status).toBe(200)
    expect((await res.json() as Record<string, unknown>).success).toBe(true)
    // Verify the DELETE was issued with the correct id + tenantId binds
    const deleteIdx = db.sqls.findIndex(s => s.includes('DELETE FROM tenant_users'))
    expect(deleteIdx).toBeGreaterThan(-1)
    expect(db.allBinds[deleteIdx]).toEqual(['user-123', TENANT.id])
  })

  it('non-existent userId → still returns success (idempotent)', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(TENANT)

    const res = await appReq(app, '/api/auth/users/no-such-user', {
      method: 'DELETE',
    }, env)

    // No 404 — DELETE WHERE id=? AND tenant_id=? silently matches nothing
    expect(res.status).toBe(200)
    expect((await res.json() as Record<string, unknown>).success).toBe(true)
  })

  it('no tenant context → 400', async () => {
    const db = new FakeD1()
    const env = makeEnv(db)
    const app = makeApp(null)

    const res = await appReq(app, '/api/auth/users/user-123', {
      method: 'DELETE',
    }, env)

    expect(res.status).toBe(400)
  })
})
