import { describe, it, expect } from 'vitest'
import {
  loadDraft, hasDraft, overlayTenant, draftPatchToColumns, stageConfigChange, clearDraft,
} from '../src/lib/draft'
import { buildTenantIdentityBlock } from '../src/lib/chat-prompt'
import type { Tenant } from '../src/lib/types'

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 't1', slug: 'acme', name: 'Acme', phone: '111', url: null, email: null,
    location_county: null, location_state: null, location_service_area: null,
    color_primary: '#111111', color_secondary: '#222222', color_accent: '#333333',
    logo_r2_key: null, custom_instruction: 'LIVE CI', password_hash: 'x',
    widget_theme: '{"font":"a"}', widget_custom_css: null, widget_published_at: null,
    org_config: '{"hours":"9-5"}', bot_overrides: '{}', admin_token_hash: null,
    onboarded: 0, report_recipients: null, daily_reports_enabled: 0, house_rules: 'LIVE HR',
    custom_instruction_locked: 0, custom_instruction_locked_at: null,
    custom_instruction_locked_pending_review: null, feature_flags: null,
    draft_config: null, draft_updated_at: null,
    created_at: '', updated_at: '',
    ...overrides,
  }
}

describe('loadDraft / hasDraft', () => {
  it('returns {} for null/invalid, parses valid JSON', () => {
    expect(loadDraft(null)).toEqual({})
    expect(loadDraft({ draft_config: null })).toEqual({})
    expect(loadDraft({ draft_config: 'not json' })).toEqual({})
    expect(loadDraft({ draft_config: '{"phone":"999"}' })).toEqual({ phone: '999' })
  })
  it('hasDraft reflects non-empty patch', () => {
    expect(hasDraft(tenant())).toBe(false)
    expect(hasDraft(tenant({ draft_config: '{}' }))).toBe(false)
    expect(hasDraft(tenant({ draft_config: '{"phone":"999"}' }))).toBe(true)
  })
})

describe('overlayTenant', () => {
  it('passes through unchanged when no draft', () => {
    const t = tenant()
    expect(overlayTenant(t)).toBe(t)
  })
  it('overrides scalars and re-serializes JSON columns', () => {
    const t = tenant({ draft_config: JSON.stringify({ phone: '999', org_config: { hours: '24/7' } }) })
    const o = overlayTenant(t)
    expect(o.phone).toBe('999')
    expect(o.org_config).toBe('{"hours":"24/7"}')   // object → JSON string
    expect(o.house_rules).toBe('LIVE HR')           // untouched live value
    // live row must be unmutated
    expect(t.phone).toBe('111')
  })
  it('null in patch clears a field', () => {
    const o = overlayTenant(tenant({ draft_config: '{"email":null,"phone":"7"}' }))
    expect(o.email).toBeNull()
    expect(o.phone).toBe('7')
  })
})

// Regression for the "Check your bot tested the published prompt, not the
// draft" bug: the bot prompt is built from the COMPILED custom_instruction,
// and staging defers recompile to publish — so overlayTenant must recompile
// the instruction from the draft's org_config, or admin/test surfaces see a
// stale prompt.
describe('overlayTenant recompiles custom_instruction from the draft', () => {
  const live = tenant({
    custom_instruction: 'STALE PUBLISHED PROMPT — should not survive an org_config draft',
    org_config: JSON.stringify({ species_config: { Pigeon: { mode: 'augment', notes: 'OLD pigeon note' } } }),
    draft_config: JSON.stringify({ org_config: { species_config: { Pigeon: { mode: 'augment', notes: 'NEW pigeon note' } } } }),
  })
  it('overlay custom_instruction reflects the DRAFT org_config', () => {
    const o = overlayTenant(live)
    expect(o.custom_instruction).toContain('NEW pigeon note')
    expect(o.custom_instruction).not.toContain('OLD pigeon note')
    expect(o.custom_instruction).not.toContain('STALE PUBLISHED PROMPT')
  })
  it('the LIVE row (bot read path) keeps its published custom_instruction', () => {
    expect(live.custom_instruction).toBe('STALE PUBLISHED PROMPT — should not survive an org_config draft')
  })
  it('a raw custom_instruction edit in the draft wins (no recompile)', () => {
    const o = overlayTenant(tenant({
      org_config: JSON.stringify({ species_config: { Pigeon: { mode: 'augment', notes: 'x' } } }),
      draft_config: JSON.stringify({ custom_instruction: 'HAND EDITED', org_config: { species_config: {} } }),
    }))
    expect(o.custom_instruction).toBe('HAND EDITED')
  })
  it('a locked prompt is never recompiled', () => {
    const o = overlayTenant(tenant({
      custom_instruction: 'LOCKED PROMPT',
      custom_instruction_locked: 1,
      draft_config: JSON.stringify({ org_config: { species_config: { Pigeon: { mode: 'augment', notes: 'ignored' } } } }),
    }))
    expect(o.custom_instruction).toBe('LOCKED PROMPT')
  })
  it('a draft that does NOT touch the prompt (e.g. colors) leaves custom_instruction untouched', () => {
    const o = overlayTenant(tenant({
      custom_instruction: 'KEEP ME',
      draft_config: JSON.stringify({ color_primary: '#abcdef' }),
    }))
    expect(o.custom_instruction).toBe('KEEP ME')
  })
})

describe('draftPatchToColumns', () => {
  it('maps scalars + serializes JSON columns, skips unknown keys', () => {
    const { cols, vals } = draftPatchToColumns({
      phone: '999', org_config: { hours: '24/7' }, widget_theme: { font: 'b' },
      // @ts-expect-error unknown key must be ignored (defense)
      bogus_col: 'x',
    })
    expect(cols).toContain('phone = ?')
    expect(cols).toContain('org_config = ?')
    expect(cols).not.toContain('bogus_col = ?')
    const i = cols.indexOf('org_config = ?')
    expect(vals[i]).toBe('{"hours":"24/7"}')
  })
})

// Minimal D1 mock that holds one row's draft_config and records writes.
class FakeDb {
  constructor(public draft: string | null = null) {}
  writes: { sql: string; binds: unknown[] }[] = []
  prepare(sql: string) {
    const self = this
    let binds: unknown[] = []
    return {
      bind(...args: unknown[]) { binds = args; return this },
      async first() { return /SELECT draft_config/.test(sql) ? { draft_config: self.draft } : null },
      async run() { self.writes.push({ sql, binds }); if (/UPDATE/.test(sql)) self.draft = binds[0] as string; return { success: true } },
    }
  }
}

describe('stageConfigChange', () => {
  it('shallow-merges over existing draft; JSON wholesale, undefined skipped, null kept', async () => {
    const db = new FakeDb(JSON.stringify({ phone: '111', org_config: { hours: '9-5' } }))
    const merged = await stageConfigChange(db as unknown as D1Database, { id: 't1', slug: 'acme' }, {
      phone: '222', email: null, org_config: { hours: '24/7' }, url: undefined,
    })
    expect(merged.phone).toBe('222')      // overwritten
    expect(merged.email).toBeNull()       // explicit null kept
    expect(merged.org_config).toEqual({ hours: '24/7' })  // JSON replaced wholesale
    expect('url' in merged).toBe(false)   // undefined skipped
    // persisted as JSON to draft_config
    const write = db.writes.find(w => /UPDATE tenants SET draft_config/.test(w.sql))!
    expect(JSON.parse(write.binds[0] as string)).toEqual(merged)
  })
  it('does NOT write any live column (only draft_config)', async () => {
    const db = new FakeDb(null)
    await stageConfigChange(db as unknown as D1Database, { id: 't1', slug: 'acme' }, { phone: '222', org_config: { hours: '24/7' } })
    for (const w of db.writes) {
      expect(w.sql).not.toMatch(/SET (phone|org_config|custom_instruction|house_rules|onboarded)/)
      expect(w.sql).toMatch(/draft_config/)
    }
  })
})

describe('clearDraft', () => {
  it('nulls the draft column', async () => {
    const db = new FakeDb('{"phone":"9"}')
    await clearDraft(db as unknown as D1Database, 't1')
    const w = db.writes.find(x => /UPDATE tenants SET draft_config = NULL/.test(x.sql))
    expect(w).toBeTruthy()
  })
})

// THE load-bearing invariant: a staged edit must be invisible to the bot. The
// bot's prompt builder reads the RAW (live) tenant row; only the admin overlay
// applies the draft. So the same builder shows LIVE facts for the live row and
// DRAFT facts for the overlaid row.
describe('INVARIANT: draft is invisible to the bot prompt, visible to the editor', () => {
  const live = tenant({
    phone: 'LIVE-PHONE',
    org_config: JSON.stringify({ hours: 'LIVE-HOURS' }),
    draft_config: JSON.stringify({ phone: 'DRAFT-PHONE', org_config: { hours: 'DRAFT-HOURS' } }),
  })
  it('bot read (raw live row) shows LIVE facts, never the draft', () => {
    const block = buildTenantIdentityBlock(live)   // chat path passes the live row
    expect(block).toContain('LIVE-PHONE')
    expect(block).not.toContain('DRAFT-PHONE')
    expect(block).toContain('LIVE-HOURS')
    expect(block).not.toContain('DRAFT-HOURS')
  })
  it('editor read (overlaid row) shows the DRAFT facts', () => {
    const block = buildTenantIdentityBlock(overlayTenant(live))
    expect(block).toContain('DRAFT-PHONE')
    expect(block).toContain('DRAFT-HOURS')
  })
})
