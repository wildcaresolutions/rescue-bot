import { describe, it, expect } from 'vitest'
import { publishDraft, discardDraft } from '../src/lib/publish'
import { compileInstruction } from '../src/lib/compile-instruction'
import type { Env, Tenant } from '../src/lib/types'

function row(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 't1', slug: 'acme', name: 'Acme Wildlife', phone: '(415) 555-0100', url: null,
    email: null, location_county: 'Marin', location_state: 'CA', location_service_area: 'Marin',
    color_primary: '#111111', color_secondary: '#222222', color_accent: '#333333',
    logo_r2_key: null, custom_instruction: 'OLD COMPILED', password_hash: 'x',
    widget_theme: null, widget_custom_css: null, widget_published_at: null,
    org_config: '{"hours":"9-5"}', bot_overrides: '{}', admin_token_hash: null,
    onboarded: 0, report_recipients: null, daily_reports_enabled: 0, house_rules: null,
    custom_instruction_locked: 0, custom_instruction_locked_at: null,
    custom_instruction_locked_pending_review: null, feature_flags: null,
    draft_config: null, draft_updated_at: null, created_at: '', updated_at: '',
    ...overrides,
  }
}

// D1 mock: loadTenantById returns `tenantRow`; captures the publish UPDATE.
class FakeDb {
  lastUpdate: { sql: string; binds: unknown[] } | null = null
  constructor(public tenantRow: Tenant) {}
  prepare(sql: string) {
    const self = this
    let binds: unknown[] = []
    return {
      bind(...args: unknown[]) { binds = args; return this },
      async first() { return /SELECT \* FROM tenants/.test(sql) ? self.tenantRow : null },
      async run() { if (/UPDATE tenants SET/.test(sql)) self.lastUpdate = { sql, binds }; return { success: true } },
    }
  }
}
const env = (db: FakeDb) => ({ DB: db as unknown as D1Database }) as unknown as Env

/** Pull the bound value for `col = ?` out of the captured UPDATE. */
function boundValue(up: { sql: string; binds: unknown[] }, col: string): unknown {
  const setClause = up.sql.replace(/^UPDATE tenants SET /, '').split(' WHERE ')[0]
  const cols = setClause.split(', ')
  let qIdx = 0
  for (const c of cols) {
    const isBound = c.includes('?')
    if (c.startsWith(col + ' =')) return isBound ? up.binds[qIdx] : null
    if (isBound) qIdx++
  }
  return undefined
}

describe('publishDraft', () => {
  it('applies the staged org_config AND recompiles custom_instruction byte-for-byte', async () => {
    const newOrg = { hours: '24/7', species_config: { Coyote: { mode: 'augment', notes: 'mange protocol' } } }
    const db = new FakeDb(row({ draft_config: JSON.stringify({ org_config: newOrg, phone: '(415) 999-0000' }) }))
    const res = await publishDraft(env(db), db.tenantRow)
    expect(res.published).toBe(true)
    expect(res.first_publish).toBe(true)
    const up = db.lastUpdate!
    // staged scalar + JSON applied to live columns
    expect(boundValue(up, 'phone')).toBe('(415) 999-0000')
    expect(boundValue(up, 'org_config')).toBe(JSON.stringify(newOrg))
    // custom_instruction recompiled from the MERGED config — byte-identical to compileInstruction
    const expected = compileInstruction(
      { name: 'Acme Wildlife', phone: '(415) 999-0000', email: null, url: null,
        location_service_area: 'Marin', location_county: 'Marin', location_state: 'CA' },
      newOrg as never, {},
    ).trim().slice(0, 10_000)
    expect(boundValue(up, 'custom_instruction')).toBe(expected)
    // publish markers + draft cleared in the same statement
    expect(boundValue(up, 'onboarded')).toBe(1)
    expect(typeof boundValue(up, 'widget_published_at')).toBe('string')
    expect(up.sql).toMatch(/draft_config = NULL/)
  })

  it('does NOT recompile when the prompt is locked', async () => {
    const db = new FakeDb(row({ custom_instruction_locked: 1, custom_instruction: 'HAND TUNED', draft_config: '{"org_config":{"hours":"24/7"}}' }))
    await publishDraft(env(db), db.tenantRow)
    expect(boundValue(db.lastUpdate!, 'custom_instruction')).toBeUndefined() // not in the UPDATE at all
  })

  it('raw custom_instruction hand-edit wins over recompile', async () => {
    const db = new FakeDb(row({ draft_config: JSON.stringify({ custom_instruction: 'RAW EDIT', org_config: { hours: '24/7' } }) }))
    await publishDraft(env(db), db.tenantRow)
    expect(boundValue(db.lastUpdate!, 'custom_instruction')).toBe('RAW EDIT')
  })
})

describe('discardDraft', () => {
  it('clears the draft (live untouched)', async () => {
    const db = new FakeDb(row({ draft_config: '{"phone":"9"}' }))
    const res = await discardDraft(env(db), db.tenantRow)
    expect(res.discarded).toBe(true)
  })
})
