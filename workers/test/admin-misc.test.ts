import { describe, it, expect } from 'vitest'
import {
  normalizeDomain,
  listDomains,
  addDomain,
  removeDomain,
  readFeatureFlags,
  updateFeatureFlags,
  buildKnowledgeBaseSummary,
  runRagSearch,
} from '../src/lib/admin-misc'
import type { Env, Tenant } from '../src/lib/types'

describe('normalizeDomain', () => {
  // ── Valid inputs ──────────────────────────────────────────────────────────

  it('accepts a plain two-label domain', () => {
    const r = normalizeDomain('example.com')
    expect(r).toEqual({ domain: 'example.com' })
  })

  it('accepts a subdomain', () => {
    const r = normalizeDomain('sub.example.com')
    expect(r).toEqual({ domain: 'sub.example.com' })
  })

  it('strips a leading https:// scheme', () => {
    const r = normalizeDomain('https://example.com')
    expect(r).toEqual({ domain: 'example.com' })
  })

  it('strips a leading http:// scheme', () => {
    const r = normalizeDomain('http://example.com')
    expect(r).toEqual({ domain: 'example.com' })
  })

  it('strips a trailing path', () => {
    const r = normalizeDomain('example.com/some/path')
    expect(r).toEqual({ domain: 'example.com' })
  })

  it('normalizes upper-case input to lowercase', () => {
    const r = normalizeDomain('  Example.COM  ')
    expect(r).toEqual({ domain: 'example.com' })
  })

  // ── Bare TLD rejections ───────────────────────────────────────────────────

  it('rejects bare TLD "com"', () => {
    const r = normalizeDomain('com')
    expect(r).toMatchObject({ error: expect.stringContaining('bare TLD') })
  })

  it('rejects bare TLD "net"', () => {
    const r = normalizeDomain('net')
    expect(r).toMatchObject({ error: expect.stringContaining('bare TLD') })
  })

  it('rejects bare TLD "org"', () => {
    const r = normalizeDomain('org')
    expect(r).toMatchObject({ error: expect.stringContaining('bare TLD') })
  })

  // ── Empty / blank ─────────────────────────────────────────────────────────

  it('rejects empty string', () => {
    const r = normalizeDomain('')
    expect(r).toMatchObject({ error: 'Domain required' })
  })

  it('rejects whitespace-only string', () => {
    const r = normalizeDomain('   ')
    expect(r).toMatchObject({ error: 'Domain required' })
  })

  // ── Wildcard rejection ────────────────────────────────────────────────────

  it('rejects wildcard patterns', () => {
    const r = normalizeDomain('*.example.com')
    expect(r).toMatchObject({ error: 'Wildcard domains are not supported' })
  })

  // ── Invalid hostname ──────────────────────────────────────────────────────

  it('rejects a trailing-dot hostname', () => {
    // new URL('https://example.com.').hostname preserves the trailing dot,
    // so stripped === hostname and the round-trip guard passes. The trailing
    // dot is then caught by the empty-label check: 'example.com.'.split('.')
    // yields ['example', 'com', ''] and the empty last label triggers
    // { error: 'Invalid domain' }.
    const r = normalizeDomain('example.com.')
    expect(r).toMatchObject({ error: 'Invalid domain' })
  })

  it('rejects a hostname with a port', () => {
    // new URL('https://example.com:8080').hostname === 'example.com' which
    // !== 'example.com:8080' → invalid
    const r = normalizeDomain('example.com:8080')
    expect(r).toMatchObject({ error: 'Invalid domain' })
  })

  it('rejects a double-dot hostname', () => {
    // 'example..com'.split('.') yields ['example', '', 'com'] — the empty
    // middle label triggers the empty-label guard.
    const r = normalizeDomain('example..com')
    expect(r).toMatchObject({ error: 'Invalid domain' })
  })
})

// ── Shared FakeD1 for admin-misc async functions ─────────────────────────────

class AdminFakeD1 {
  sqls: string[] = []
  allBinds: unknown[][] = []
  domainsRows: unknown[] = []
  runThrow: Error | null = null

  prepare(sql: string) {
    this.sqls.push(sql)
    const self = this
    const stmt = {
      bind(...args: unknown[]) {
        self.allBinds.push(args)
        return stmt
      },
      async run() {
        if (self.runThrow) throw self.runThrow
        return { success: true, meta: { changes: 1 } }
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        if (sql.includes('FROM allowed_domains')) {
          return { results: self.domainsRows as T[] }
        }
        return { results: [] }
      },
    }
    return stmt
  }
}

function fakeEnv(db: AdminFakeD1, overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    SIGNING_SECRET: 'test-signing-secret',
    ...overrides,
  } as unknown as Env
}

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 'tenant-id-1',
    slug: 'test-org',
    name: 'Test Org',
    phone: null, url: null, email: null,
    location_county: null, location_state: null, location_service_area: null,
    color_primary: '', color_secondary: '', color_accent: '',
    logo_r2_key: null,
    custom_instruction: null,
    password_hash: '',
    widget_theme: null, widget_custom_css: null, widget_published_at: null,
    org_config: null, bot_overrides: null, admin_token_hash: null,
    onboarded: 1, report_recipients: null,
    house_rules: null,
    custom_instruction_locked: 0, custom_instruction_locked_at: null,
    custom_instruction_locked_pending_review: null,
    feature_flags: null,
    draft_config: null, draft_updated_at: null,
    created_at: '', updated_at: '',
    ...overrides,
  } as Tenant
}

// ── Domain CRUD ───────────────────────────────────────────────────────────────

describe('listDomains', () => {
  it('returns the rows from allowed_domains for the tenant', async () => {
    const db = new AdminFakeD1()
    db.domainsRows = [
      { id: 'd1', domain: 'example.com', created_at: '2024-01-01' },
      { id: 'd2', domain: 'sub.example.com', created_at: '2024-01-02' },
    ]
    const env = fakeEnv(db)

    const result = await listDomains(env, 'tenant-id-1')

    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(2)
    expect((result[0] as Record<string, unknown>).domain).toBe('example.com')
  })

  it('returns an empty array when no domains are configured', async () => {
    const db = new AdminFakeD1()
    db.domainsRows = []
    const env = fakeEnv(db)

    const result = await listDomains(env, 'tenant-id-1')

    expect(result).toEqual([])
  })
})

describe('addDomain', () => {
  it('valid domain → runs INSERT OR IGNORE and returns {ok:true}', async () => {
    const db = new AdminFakeD1()
    const env = fakeEnv(db)

    const result = await addDomain(env, 'tenant-id-1', 'example.com')

    expect(result).toEqual({ ok: true })
    expect(db.sqls.some(s => s.includes('INSERT OR IGNORE INTO allowed_domains'))).toBe(true)
    // Binds: (tenantId, normalizedDomain)
    const insertBinds = db.allBinds.find(b => Array.isArray(b) && b.includes('example.com'))
    expect(insertBinds).toBeDefined()
    expect(insertBinds![0]).toBe('tenant-id-1')
    expect(insertBinds![1]).toBe('example.com')
  })

  it('invalid domain (bare TLD) → {error, status:400}, no INSERT issued', async () => {
    const db = new AdminFakeD1()
    const env = fakeEnv(db)

    const result = await addDomain(env, 'tenant-id-1', 'com')

    expect(result).toMatchObject({ error: expect.any(String), status: 400 })
    expect(db.sqls.some(s => s.includes('INSERT'))).toBe(false)
  })

  it('wildcard domain → {error, status:400}', async () => {
    const db = new AdminFakeD1()
    const env = fakeEnv(db)

    const result = await addDomain(env, 'tenant-id-1', '*.example.com')

    expect(result).toMatchObject({ error: expect.any(String), status: 400 })
  })

  it('duplicate domain (INSERT OR IGNORE silently ignores) → still {ok:true}', async () => {
    // addDomain uses INSERT OR IGNORE which never throws for unique violations.
    const db = new AdminFakeD1()
    const env = fakeEnv(db)

    // First insert
    await addDomain(env, 'tenant-id-1', 'example.com')
    // Second insert (simulated duplicate — INSERT OR IGNORE does nothing, no throw)
    const result = await addDomain(env, 'tenant-id-1', 'example.com')

    expect(result).toEqual({ ok: true })
  })

  it('normalizes the domain (strips scheme, lowercases) before inserting', async () => {
    const db = new AdminFakeD1()
    const env = fakeEnv(db)

    await addDomain(env, 'tenant-id-1', 'https://EXAMPLE.COM/path')

    const insertBindIdx = db.sqls.findIndex(s => s.includes('INSERT OR IGNORE'))
    expect(db.allBinds[insertBindIdx]![1]).toBe('example.com')
  })
})

describe('removeDomain', () => {
  it('issues DELETE with (id, tenantId) binds', async () => {
    const db = new AdminFakeD1()
    const env = fakeEnv(db)

    await removeDomain(env, 'tenant-id-1', 'domain-row-99')

    const deleteIdx = db.sqls.findIndex(s => s.includes('DELETE FROM allowed_domains'))
    expect(deleteIdx).toBeGreaterThan(-1)
    expect(db.allBinds[deleteIdx]).toEqual(['domain-row-99', 'tenant-id-1'])
  })
})

// ── Feature flags ─────────────────────────────────────────────────────────────

describe('readFeatureFlags', () => {
  it('parses a valid feature_flags JSON string', () => {
    const tenant = makeTenant({ feature_flags: '{"photo_uploads_enabled":true,"other":42}' })
    const result = readFeatureFlags(tenant)
    expect(result.feature_flags).toEqual({ photo_uploads_enabled: true, other: 42 })
  })

  it('returns empty object when feature_flags is null', () => {
    const tenant = makeTenant({ feature_flags: null })
    const result = readFeatureFlags(tenant)
    expect(result.feature_flags).toEqual({})
  })

  it('returns empty object for malformed JSON (does not throw)', () => {
    const tenant = makeTenant({ feature_flags: '{not valid json' })
    const result = readFeatureFlags(tenant)
    expect(result.feature_flags).toEqual({})
  })
})

describe('updateFeatureFlags', () => {
  it('sets photo_uploads_enabled=true and returns updated flags', async () => {
    const db = new AdminFakeD1()
    const env = fakeEnv(db)
    const tenant = makeTenant({ feature_flags: null })

    const result = await updateFeatureFlags(env, tenant, { photo_uploads_enabled: true })

    expect(result).toMatchObject({ feature_flags: { photo_uploads_enabled: true } })
    expect(db.sqls.some(s => s.includes('UPDATE tenants SET feature_flags'))).toBe(true)
  })

  it('sets photo_uploads_enabled=false and returns updated flags', async () => {
    const db = new AdminFakeD1()
    const env = fakeEnv(db)
    const tenant = makeTenant({ feature_flags: '{"photo_uploads_enabled":true}' })

    const result = await updateFeatureFlags(env, tenant, { photo_uploads_enabled: false })

    expect(result).toMatchObject({ feature_flags: { photo_uploads_enabled: false } })
  })

  it('preserves existing unrelated keys while updating photo_uploads_enabled', async () => {
    const db = new AdminFakeD1()
    const env = fakeEnv(db)
    const tenant = makeTenant({ feature_flags: '{"other_flag":"hello","photo_uploads_enabled":false}' })

    const result = await updateFeatureFlags(env, tenant, { photo_uploads_enabled: true })

    expect((result as { feature_flags: Record<string, unknown> }).feature_flags.other_flag).toBe('hello')
    expect((result as { feature_flags: Record<string, unknown> }).feature_flags.photo_uploads_enabled).toBe(true)
  })

  it('DB error → returns {error: "Database error", status: 500}', async () => {
    const db = new AdminFakeD1()
    db.runThrow = new Error('D1_ERROR: read-only database')
    const env = fakeEnv(db)
    const tenant = makeTenant()

    const result = await updateFeatureFlags(env, tenant, { photo_uploads_enabled: true })

    expect(result).toMatchObject({ error: 'Database error', status: 500 })
  })
})

// ── buildKnowledgeBaseSummary ─────────────────────────────────────────────────

describe('buildKnowledgeBaseSummary', () => {
  it('returns builtin_guides, custom_protocols, and stats', () => {
    const tenant = makeTenant({ custom_instruction: 'My custom instructions here.' })

    const summary = buildKnowledgeBaseSummary(tenant) as Record<string, unknown>

    expect(Array.isArray(summary.builtin_guides)).toBe(true)
    const protocols = summary.custom_protocols as Record<string, unknown>
    expect(protocols.has_custom_instruction).toBe(true)
    expect(typeof protocols.instruction_preview).toBe('string')
    const stats = summary.stats as Record<string, unknown>
    expect(typeof stats.total_documents).toBe('number')
    expect(typeof stats.total_characters).toBe('number')
  })

  it('custom_protocols.has_custom_instruction is false when null', () => {
    const tenant = makeTenant({ custom_instruction: null })

    const summary = buildKnowledgeBaseSummary(tenant) as Record<string, unknown>
    const protocols = summary.custom_protocols as Record<string, unknown>

    expect(protocols.has_custom_instruction).toBe(false)
    expect(protocols.instruction_preview).toBeNull()
  })
})

// ── runRagSearch ──────────────────────────────────────────────────────────────

describe('runRagSearch', () => {
  it('empty query string → {error: "query required", status: 400}', async () => {
    const db = new AdminFakeD1()
    const env = fakeEnv(db)

    const result = await runRagSearch(env, 'tenant-id-1', { query: '' })

    expect(result).toMatchObject({ error: 'query required', status: 400 })
  })

  it('missing query field → {error: "query required", status: 400}', async () => {
    const db = new AdminFakeD1()
    const env = fakeEnv(db)

    const result = await runRagSearch(env, 'tenant-id-1', {})

    expect(result).toMatchObject({ error: 'query required', status: 400 })
  })
})
