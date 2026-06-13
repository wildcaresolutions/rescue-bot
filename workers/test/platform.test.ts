import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import platform from '../src/routes/platform'
import type { Env } from '../src/lib/types'

// ── Fake D1 binding ────────────────────────────────────────────────────────────
// Records the last INSERT bind values + lets tests inject failures.

class FakeD1 {
  __lastInsertSql: string | null = null
  __lastBindValues: unknown[] | null = null
  __failNextRun = false

  prepare(sql: string) {
    this.__lastInsertSql = sql
    const self = this
    return {
      bind(...args: unknown[]) {
        self.__lastBindValues = args
        return this
      },
      async run() {
        if (self.__failNextRun) {
          self.__failNextRun = false
          throw new Error('mock DB failure')
        }
        return { success: true }
      },
      async first() { return null },
      async all() { return { results: [] } },
    }
  }
}

// ── Env builder ────────────────────────────────────────────────────────────────

function fakeEnv(overrides: Partial<Env> & { __db?: FakeD1 } = {}): Env {
  const db = overrides.__db ?? new FakeD1()
  return {
    SIGNING_SECRET: 'test-signing-secret',
    TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    DEV_AUTH_BYPASS: '',
    DB: db as unknown as D1Database,
    ...overrides,
  } as unknown as Env
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch

function mockTurnstileFetch(impl: (req: Request) => Response | Promise<Response>) {
  // @ts-expect-error overriding global for test
  globalThis.fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return impl(req)
  })
}

function turnstilePass() {
  mockTurnstileFetch(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
}
function turnstileFail() {
  mockTurnstileFetch(async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 }))
}
function turnstileNetworkError() {
  mockTurnstileFetch(async () => new Response('Server error', { status: 500 }))
}

async function postApply(env: Env, body: Record<string, unknown>): Promise<Response> {
  return platform.request('/platform/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify(body),
  }, env)
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('POST /platform/apply', () => {
  beforeEach(() => { turnstilePass() })
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  describe('input validation', () => {
    it('rejects non-JSON body with 400', async () => {
      const res = await platform.request('/platform/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json{',
      }, fakeEnv())
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid JSON' })
    })

    it('rejects missing org_name with 400', async () => {
      const res = await postApply(fakeEnv(), {
        contact_name: 'Jane Smith',
        contact_email: 'jane@example.org',
        turnstile_token: 't',
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Organization name is required' })
    })

    it('rejects missing contact_name with 400', async () => {
      const res = await postApply(fakeEnv(), {
        org_name: 'Test Wildlife',
        contact_email: 'jane@example.org',
        turnstile_token: 't',
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Contact name is required' })
    })

    it('rejects empty-string org_name with 400 (whitespace-only counts as empty)', async () => {
      const res = await postApply(fakeEnv(), {
        org_name: '   ',
        contact_name: 'Jane Smith',
        contact_email: 'jane@example.org',
        turnstile_token: 't',
      })
      expect(res.status).toBe(400)
    })

    it('rejects invalid email format with 400', async () => {
      const res = await postApply(fakeEnv(), {
        org_name: 'Test Wildlife',
        contact_name: 'Jane Smith',
        contact_email: 'not-an-email',
        turnstile_token: 't',
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Valid contact email is required' })
    })
  })

  describe('Turnstile gating', () => {
    it('returns 400 when Turnstile rejects the token', async () => {
      turnstileFail()
      const res = await postApply(fakeEnv(), {
        org_name: 'Test Wildlife',
        contact_name: 'Jane Smith',
        contact_email: 'jane@example.org',
        turnstile_token: 'bad-token',
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: 'Captcha verification failed',
        reason: 'rejected',
        details: 'invalid-input-response',
      })
    })

    it('returns 503 when TURNSTILE_SECRET_KEY is unset (missing_secret)', async () => {
      const res = await postApply(
        fakeEnv({ TURNSTILE_SECRET_KEY: '' as unknown as Env['TURNSTILE_SECRET_KEY'] }),
        {
          org_name: 'Test Wildlife',
          contact_name: 'Jane Smith',
          contact_email: 'jane@example.org',
          turnstile_token: 't',
        },
      )
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'Captcha service unavailable' })
    })

    it('returns 503 when Turnstile siteverify is unreachable (network)', async () => {
      turnstileNetworkError()
      const res = await postApply(fakeEnv(), {
        org_name: 'Test Wildlife',
        contact_name: 'Jane Smith',
        contact_email: 'jane@example.org',
        turnstile_token: 't',
      })
      expect(res.status).toBe(503)
    })

    it('skips Turnstile entirely when DEV_AUTH_BYPASS is "true"', async () => {
      const db = new FakeD1()
      // Even if Turnstile fetch would fail, DEV_AUTH_BYPASS short-circuits past it.
      turnstileFail()
      const res = await postApply(
        fakeEnv({ DEV_AUTH_BYPASS: 'true', __db: db }),
        {
          org_name: 'Test Wildlife',
          contact_name: 'Jane Smith',
          contact_email: 'jane@example.org',
          // Notice: no turnstile_token
        },
      )
      expect(res.status).toBe(201)
    })
  })

  describe('happy path + source/ref persistence', () => {
    it('returns 201 with id on valid input', async () => {
      const res = await postApply(fakeEnv(), {
        org_name: 'Test Wildlife',
        contact_name: 'Jane Smith',
        contact_email: 'jane@example.org',
        turnstile_token: 't',
      })
      expect(res.status).toBe(201)
      const body = await res.json() as { success: boolean; id: string }
      expect(body.success).toBe(true)
      expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })

    it('persists source and ref columns when provided', async () => {
      const db = new FakeD1()
      const res = await postApply(
        fakeEnv({ __db: db }),
        {
          org_name: 'Test Wildlife',
          contact_name: 'Jane Smith',
          contact_email: 'jane@example.org',
          turnstile_token: 't',
          source: 'marketing-coalition-v1',
          ref: 'wildcare-outreach',
        },
      )
      expect(res.status).toBe(201)
      // Last 2 bind values should be source + ref.
      const binds = db.__lastBindValues as unknown[]
      expect(binds).toBeTruthy()
      expect(binds[binds.length - 2]).toBe('marketing-coalition-v1')
      expect(binds[binds.length - 1]).toBe('wildcare-outreach')
      expect(db.__lastInsertSql).toContain('source')
      expect(db.__lastInsertSql).toContain('ref')
    })

    it('persists null/undefined for source and ref when not provided', async () => {
      const db = new FakeD1()
      const res = await postApply(
        fakeEnv({ __db: db }),
        {
          org_name: 'Test Wildlife',
          contact_name: 'Jane Smith',
          contact_email: 'jane@example.org',
          turnstile_token: 't',
          // no source, no ref
        },
      )
      expect(res.status).toBe(201)
      const binds = db.__lastBindValues as unknown[]
      expect(binds[binds.length - 2]).toBeNull()
      expect(binds[binds.length - 1]).toBeNull()
    })

    it('clamps overlong source/ref values to 128 chars', async () => {
      const db = new FakeD1()
      const longRef = 'a'.repeat(500)
      await postApply(
        fakeEnv({ __db: db }),
        {
          org_name: 'Test Wildlife',
          contact_name: 'Jane Smith',
          contact_email: 'jane@example.org',
          turnstile_token: 't',
          source: 'b'.repeat(500),
          ref: longRef,
        },
      )
      const binds = db.__lastBindValues as unknown[]
      const persistedSource = binds[binds.length - 2] as string
      const persistedRef = binds[binds.length - 1] as string
      expect(persistedSource.length).toBe(128)
      expect(persistedRef.length).toBe(128)
    })

    it('REGRESSION: existing form callers without simplified fields still INSERT cleanly (NULLs OK)', async () => {
      // Exercise the legacy form payload — old fields present, no source/ref.
      const db = new FakeD1()
      const res = await postApply(
        fakeEnv({ __db: db }),
        {
          org_name: 'Legacy Wildlife',
          contact_name: 'Old Caller',
          contact_email: 'old@example.org',
          contact_phone: '(415) 555-0100',
          website: 'oldwildlife.org',
          use_case: 'hotline triage',
          animal_types: 'songbirds',
          service_area: 'East Bay',
          location_county: 'Alameda',
          location_state: 'CA',
          hosting_domain: 'oldwildlife.org',
          turnstile_token: 't',
        },
      )
      expect(res.status).toBe(201)
      // SQL should now include source/ref columns even though caller didn't send them.
      expect(db.__lastInsertSql).toContain('source')
      expect(db.__lastInsertSql).toContain('ref')
    })
  })

  describe('database failure', () => {
    it('returns 500 when D1 INSERT throws', async () => {
      const db = new FakeD1()
      db.__failNextRun = true
      const res = await postApply(
        fakeEnv({ __db: db }),
        {
          org_name: 'Test Wildlife',
          contact_name: 'Jane Smith',
          contact_email: 'jane@example.org',
          turnstile_token: 't',
        },
      )
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Database error' })
    })
  })
})

// ── Stateful D1 that can return a pending application ───────────────────────────
// The shared FakeD1 always returns null from first(), so it can't exercise the
// approval path (which reads the application first). This records every
// prepared SQL string so we can assert the tenant_users provisioning + magic
// link issuance the welcome-email fix added.

class ApproveD1 {
  sqls: string[] = []
  constructor(private application: Record<string, unknown> | null) {}
  prepare(sql: string) {
    this.sqls.push(sql)
    const application = this.application
    return {
      bind() { return this },
      async run() { return { success: true, meta: { changes: 1 } } },
      async first() {
        // applications lookup returns the row; the magic_tokens "existing
        // token?" probe and everything else returns null.
        return sql.includes('FROM applications') ? application : null
      },
      async all() { return { results: [] } },
    }
  }
  async batch(stmts: unknown[]) { return stmts.map(() => ({ success: true })) }
}

describe('POST /platform/applications/:id/approve', () => {
  const realFetchLocal = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetchLocal })

  function pendingApp(): Record<string, unknown> {
    return {
      id: 'app-1', status: 'pending', org_name: 'Marin Wildlife',
      contact_name: 'Jane', contact_email: 'jane@example.org',
      contact_phone: '415-555-0100', website: 'https://example.org',
      location_county: 'Marin', location_state: 'CA', service_area: 'Marin County',
      hosting_domain: '',
    }
  }

  async function approve(env: Env): Promise<Response> {
    return platform.request('/platform/applications/app-1/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env)
  }

  it('provisions a tenant_users row and surfaces a dev login link (no EMAIL binding)', async () => {
    const db = new ApproveD1(pendingApp())
    const res = await approve(fakeEnv({ __db: db as unknown as FakeD1 }))
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.success).toBe(true)
    // The approved contact becomes the tenant's first admin user — without
    // this they could never request a magic link (the locked-out bug).
    expect(db.sqls.some(s => s.includes('INSERT OR IGNORE INTO tenant_users'))).toBe(true)
    // A magic link was minted so the welcome email is one-click.
    expect(db.sqls.some(s => s.includes('INSERT INTO magic_tokens'))).toBe(true)
    // With no EMAIL binding, onboarding can still be demoed via the link.
    expect(json.email_sent).toBe(false)
    expect(typeof json.dev_login_url).toBe('string')
  })

  it('does not re-process an already-approved application', async () => {
    const app = pendingApp(); app.status = 'approved'
    const db = new ApproveD1(app)
    const res = await approve(fakeEnv({ __db: db as unknown as FakeD1 }))
    expect(res.status).toBe(400)
    expect(db.sqls.some(s => s.includes('INSERT INTO tenants'))).toBe(false)
  })
})

describe('POST /platform/signup', () => {
  async function signup(env: Env, body: Record<string, unknown>): Promise<Response> {
    return platform.request('/platform/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, env)
  }

  it('requires a valid contact email (no password-based onboarding)', async () => {
    const res = await signup(fakeEnv(), { name: 'Marin Wildlife', slug: 'marin-wildlife' })
    expect(res.status).toBe(400)
    expect((await res.json() as Record<string, unknown>).error).toMatch(/email/i)
  })

  it('provisions tenant + tenant_users + magic link, returns a dev link (no password)', async () => {
    const db = new ApproveD1(null)
    const res = await signup(fakeEnv({ __db: db as unknown as FakeD1 }), {
      name: 'Marin Wildlife', slug: 'marin-wildlife', email: 'jane@example.org',
    })
    expect(res.status).toBe(201)
    const json = await res.json() as Record<string, unknown>
    expect(json.success).toBe(true)
    expect(db.sqls.some(s => s.includes('INSERT INTO tenants'))).toBe(true)
    expect(db.sqls.some(s => s.includes('INSERT OR IGNORE INTO tenant_users'))).toBe(true)
    expect(db.sqls.some(s => s.includes('INSERT INTO magic_tokens'))).toBe(true)
    // Magic-link onboarding: no raw password handed back to the operator.
    expect(json.password).toBeUndefined()
    expect(json.email_sent).toBe(false)
    expect(typeof json.dev_login_url).toBe('string')
    expect(typeof json.portal_url).toBe('string')
  })
})
