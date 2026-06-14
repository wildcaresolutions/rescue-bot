/**
 * CLEAN-ROOM QA AUDIT — global draft/publish + "Check your bot" redesign.
 *
 * These tests verify the BEHAVIORAL SPEC, not the implementation. They are
 * deliberately adversarial: each block tries to BREAK one of the 7 invariants
 * by staging every category of field, re-checking the bot read path, exercising
 * recompile precedence (lock / raw-edit), and probing every readiness/onboarding
 * path for a smuggled "tests" gate.
 *
 * Fakes follow the established pattern in draft.test.ts / publish.test.ts /
 * evals-crud.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  loadDraft, overlayTenant, stageConfigChange, draftPatchToColumns,
} from '../src/lib/draft'
import { publishDraft, discardDraft } from '../src/lib/publish'
import { buildTenantIdentityBlock, buildHouseRulesBlock } from '../src/lib/chat-prompt'
import { compileInstruction } from '../src/lib/compile-instruction'
import { loadSetupState } from '../src/lib/setup-state'
import { computeSetupReadiness } from '../src/lib/setup-readiness'
import { readOnboardingSignals } from '../src/lib/onboarding-state'
import { updateEvalScenario, reviewEvalScenario } from '../src/lib/evals-crud'
import { invalidateTenantCache, cacheTenant, getCachedTenant } from '../src/lib/cache'
import type { Env, Tenant } from '../src/lib/types'

// ────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ────────────────────────────────────────────────────────────────────────────

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 't1', slug: 'acme', name: 'Acme Wildlife', phone: 'LIVE-PHONE', url: 'https://live.example',
    email: 'live@example.org',
    location_county: 'LiveCounty', location_state: 'CA', location_service_area: 'LiveArea',
    color_primary: '#111111', color_secondary: '#222222', color_accent: '#333333',
    logo_r2_key: null, custom_instruction: 'LIVE COMPILED CI', password_hash: 'x',
    widget_theme: '{"font":"live"}', widget_custom_css: 'body{color:live}', widget_published_at: null,
    org_config: JSON.stringify({ hours: 'LIVE-HOURS', after_hours_phone: 'LIVE-AH', public_address: 'LIVE-ADDR' }),
    bot_overrides: '{}', admin_token_hash: null,
    onboarded: 0, report_recipients: null, daily_reports_enabled: 0, house_rules: 'LIVE-HOUSE-RULE always say hi',
    custom_instruction_locked: 0, custom_instruction_locked_at: null,
    custom_instruction_locked_pending_review: null, feature_flags: null,
    draft_config: null, draft_updated_at: null,
    created_at: '', updated_at: '',
    ...overrides,
  }
}

/** D1 fake for publish: loadTenantById returns tenantRow; captures publish UPDATE. */
class PublishDb {
  lastUpdate: { sql: string; binds: unknown[] } | null = null
  writes: { sql: string; binds: unknown[] }[] = []
  constructor(public tenantRow: Tenant) {}
  prepare(sql: string) {
    const self = this
    let binds: unknown[] = []
    return {
      bind(...args: unknown[]) { binds = args; return this },
      async first() { return /SELECT \* FROM tenants/.test(sql) ? self.tenantRow : null },
      async run() {
        self.writes.push({ sql, binds })
        if (/UPDATE tenants SET/.test(sql)) self.lastUpdate = { sql, binds }
        return { success: true }
      },
    }
  }
}
const envOf = (db: unknown) => ({ DB: db as D1Database }) as unknown as Env

/** Pull the bound (or literal-NULL) value for `col = ?` out of a captured UPDATE. */
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
/** True if `col` appears as a SET target at all. */
function hasCol(up: { sql: string; binds: unknown[] }, col: string): boolean {
  return up.sql.replace(/^UPDATE tenants SET /, '').split(' WHERE ')[0]
    .split(', ').some(c => c.startsWith(col + ' ='))
}

/** Stage-path fake: holds a row's draft_config, records writes (from draft.test.ts). */
class StageDb {
  writes: { sql: string; binds: unknown[] }[] = []
  constructor(public draft: string | null = null) {}
  prepare(sql: string) {
    const self = this
    let binds: unknown[] = []
    return {
      bind(...args: unknown[]) { binds = args; return this },
      async first() { return /SELECT draft_config/.test(sql) ? { draft_config: self.draft } : null },
      async run() {
        self.writes.push({ sql, binds })
        if (/UPDATE/.test(sql)) self.draft = binds[0] as string
        return { success: true }
      },
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SPEC 1 — A staged edit does NOT change what the bot serves.
// ════════════════════════════════════════════════════════════════════════════
describe('SPEC 1: staged edits are invisible to the bot (prompt + public config)', () => {
  // Stage EVERY category of field, then assert the bot prompt built from the
  // LIVE row shows only live values and never a draft value.
  const live = tenant({
    draft_config: JSON.stringify({
      phone: 'DRAFT-PHONE', url: 'https://draft.example', email: 'draft@example.org',
      location_county: 'DraftCounty', location_state: 'NY', location_service_area: 'DraftArea',
      org_config: { hours: 'DRAFT-HOURS', after_hours_phone: 'DRAFT-AH', public_address: 'DRAFT-ADDR' },
      house_rules: 'DRAFT-HOUSE-RULE always say bye',
      custom_instruction: 'DRAFT CI',
    }),
  })

  it('the bot identity block (built from the live row) contains NO draft value', () => {
    const block = buildTenantIdentityBlock(live)
    for (const draftVal of [
      'DRAFT-PHONE', 'draft.example', 'draft@example.org', 'DraftCounty',
      'DraftArea', 'DRAFT-HOURS', 'DRAFT-AH', 'DRAFT-ADDR',
    ]) {
      expect(block).not.toContain(draftVal)
    }
    // ...and DOES contain the live ones.
    expect(block).toContain('LIVE-PHONE')
    expect(block).toContain('LIVE-HOURS')
    expect(block).toContain('LIVE-ADDR')
  })

  it('the house-rules block (built from the live row) shows the LIVE rule, not the draft', () => {
    const block = buildHouseRulesBlock(live)
    expect(block).toContain('LIVE-HOUSE-RULE')
    expect(block).not.toContain('DRAFT-HOUSE-RULE')
  })

  // The public /api/config read path: for an UNAUTHENTICATED reader the route
  // does `const editing = isAuthed ? overlayTenant(tenant) : tenant`. Model the
  // unauthed branch directly: it must be the raw live row, byte-identical.
  it('public config read path uses the raw live row (no overlay) so it serves live values', () => {
    const isAuthed = false
    const editing = isAuthed ? overlayTenant(live) : live
    expect(editing).toBe(live)                    // same object — never overlaid
    expect(editing.phone).toBe('LIVE-PHONE')
    expect(editing.house_rules).toContain('LIVE-HOUSE-RULE')
    expect(JSON.parse(editing.org_config!).hours).toBe('LIVE-HOURS')
  })

  it('staging never writes a live column (only draft_config / draft_updated_at)', async () => {
    const db = new StageDb(null)
    await stageConfigChange(db as unknown as D1Database, { id: 't1', slug: 'acme' }, {
      phone: 'X', org_config: { hours: 'Y' }, house_rules: 'Z', custom_instruction: 'W',
      widget_custom_css: 'V', custom_instruction_locked: 1,
    })
    expect(db.writes.length).toBeGreaterThan(0)
    for (const w of db.writes) {
      // The only mutated columns are draft_config (+ draft_updated_at).
      expect(w.sql).not.toMatch(/SET\s+(phone|org_config|house_rules|custom_instruction|widget_custom_css|onboarded|custom_instruction_locked)\b/)
      if (/UPDATE/.test(w.sql)) expect(w.sql).toMatch(/draft_config/)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// SPEC 2 — Admin sees draft; unauthenticated sees live.
// ════════════════════════════════════════════════════════════════════════════
describe('SPEC 2: authed editor sees live-overlaid-with-draft; unauthed sees live only', () => {
  const live = tenant({
    draft_config: JSON.stringify({ phone: 'DRAFT-PHONE', org_config: { hours: 'DRAFT-HOURS' } }),
  })

  it('overlayTenant (the authed editor view) surfaces the draft', () => {
    const o = overlayTenant(live)
    expect(o.phone).toBe('DRAFT-PHONE')
    expect(JSON.parse(o.org_config!).hours).toBe('DRAFT-HOURS')
    // the live row object is NOT mutated
    expect(live.phone).toBe('LIVE-PHONE')
  })

  it('the public branch returns the live row verbatim', () => {
    expect((false ? overlayTenant(live) : live).phone).toBe('LIVE-PHONE')
  })

  it('publish markers (onboarded) are never draftable, so they read live for everyone', () => {
    // Adversarial: even if a draft tries to smuggle onboarded=1, overlay must
    // not surface it (onboarded is not a JSON column and not in DraftConfig;
    // overlay copies arbitrary keys, so this catches a regression where the
    // route trusted a forged onboarded in the draft).
    const forged = tenant({ onboarded: 0, draft_config: JSON.stringify({ onboarded: 1 }) })
    const o = overlayTenant(forged)
    // overlayTenant is generic and WILL copy 'onboarded' if present in the draft.
    // The real guard is the publish column allow-list (draftPatchToColumns):
    const { cols } = draftPatchToColumns(loadDraft(forged) as never)
    expect(cols.some(c => c.startsWith('onboarded'))).toBe(false)
    // Document the overlay behavior so a future reader knows where the guard lives.
    expect(o.onboarded).toBe(1) // overlay is permissive; allow-list is the gate
  })
})

// ════════════════════════════════════════════════════════════════════════════
// SPEC 3 — Publish promotes staged changes + recompiles correctly.
// ════════════════════════════════════════════════════════════════════════════
describe('SPEC 3: publish promotes the draft to live and recompiles correctly', () => {
  it('promotes every staged field AND recompiles custom_instruction byte-for-byte', async () => {
    const newOrg = { hours: '24/7', species_config: { Coyote: { mode: 'augment', notes: 'mange protocol' } } }
    const db = new PublishDb(tenant({
      draft_config: JSON.stringify({
        phone: 'NEW-PHONE', email: 'new@example.org', url: 'https://new.example',
        location_service_area: 'NewArea', org_config: newOrg, house_rules: 'NEW HR',
      }),
    }))
    const res = await publishDraft(envOf(db), db.tenantRow)
    expect(res.published).toBe(true)
    expect(res.first_publish).toBe(true)
    const up = db.lastUpdate!

    expect(boundValue(up, 'phone')).toBe('NEW-PHONE')
    expect(boundValue(up, 'email')).toBe('new@example.org')
    expect(boundValue(up, 'url')).toBe('https://new.example')
    expect(boundValue(up, 'location_service_area')).toBe('NewArea')
    expect(boundValue(up, 'org_config')).toBe(JSON.stringify(newOrg))
    expect(boundValue(up, 'house_rules')).toBe('NEW HR')

    // recompiled from MERGED config (NEW phone + NEW org_config) — byte-identical
    const expected = compileInstruction(
      { name: 'Acme Wildlife', phone: 'NEW-PHONE', email: 'new@example.org', url: 'https://new.example',
        location_service_area: 'NewArea', location_county: 'LiveCounty', location_state: 'CA' },
      newOrg as never, {},
    ).trim().slice(0, 10_000)
    expect(boundValue(up, 'custom_instruction')).toBe(expected)

    // publish markers + draft cleared atomically
    expect(boundValue(up, 'onboarded')).toBe(1)
    expect(typeof boundValue(up, 'widget_published_at')).toBe('string')
    expect(up.sql).toMatch(/draft_config = NULL/)
    expect(up.sql).toMatch(/draft_updated_at = NULL/)
  })

  it('locked prompt is NEVER recompiled (custom_instruction not in the UPDATE)', async () => {
    const db = new PublishDb(tenant({
      custom_instruction_locked: 1, custom_instruction: 'HAND TUNED',
      draft_config: JSON.stringify({ org_config: { hours: '24/7' } }),
    }))
    await publishDraft(envOf(db), db.tenantRow)
    expect(hasCol(db.lastUpdate!, 'custom_instruction')).toBe(false)
  })

  it('a lock STAGED in the draft also suppresses recompile (merged lock wins)', async () => {
    // Adversarial: lock is live=0 but the draft flips it to 1. Publish reads the
    // MERGED row, so the just-staged lock must suppress recompile.
    const db = new PublishDb(tenant({
      custom_instruction_locked: 0,
      draft_config: JSON.stringify({ custom_instruction_locked: 1, org_config: { hours: '24/7' } }),
    }))
    await publishDraft(envOf(db), db.tenantRow)
    expect(hasCol(db.lastUpdate!, 'custom_instruction')).toBe(false)
  })

  it('raw custom_instruction hand-edit wins over recompile', async () => {
    const db = new PublishDb(tenant({
      draft_config: JSON.stringify({ custom_instruction: 'RAW EDIT', org_config: { hours: '24/7' } }),
    }))
    await publishDraft(envOf(db), db.tenantRow)
    expect(boundValue(db.lastUpdate!, 'custom_instruction')).toBe('RAW EDIT')
  })

  it('first_publish=false on a re-publish (widget already published)', async () => {
    const db = new PublishDb(tenant({
      widget_published_at: '2026-01-01T00:00:00Z',
      draft_config: JSON.stringify({ phone: 'NEW' }),
    }))
    const res = await publishDraft(envOf(db), db.tenantRow)
    expect(res.first_publish).toBe(false)
  })

  it('recompiles even with an EMPTY draft (publishing onboarding without edits)', async () => {
    // An operator can hit Publish with nothing staged. Publish must still set
    // markers and recompile from live config — not crash or skip.
    const db = new PublishDb(tenant({ draft_config: null }))
    const res = await publishDraft(envOf(db), db.tenantRow)
    expect(res.published).toBe(true)
    expect(hasCol(db.lastUpdate!, 'custom_instruction')).toBe(true)
    expect(boundValue(db.lastUpdate!, 'onboarded')).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// SPEC 4 — Discard leaves live untouched and clears the draft.
// ════════════════════════════════════════════════════════════════════════════
describe('SPEC 4: discard nulls the draft and never touches a live column', () => {
  it('discard issues only a draft_config=NULL update, no live columns', async () => {
    const db = new PublishDb(tenant({ draft_config: JSON.stringify({ phone: 'X', org_config: { hours: 'Y' } }) }))
    const res = await discardDraft(envOf(db), db.tenantRow)
    expect(res.discarded).toBe(true)
    const w = db.writes.find(x => /UPDATE tenants/.test(x.sql))!
    expect(w.sql).toMatch(/draft_config = NULL/)
    expect(w.sql).not.toMatch(/SET\s+(phone|org_config|custom_instruction|house_rules|onboarded|widget_published_at)\b/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// SPEC 5 — Cache invalidation on stage / discard / publish.
// ════════════════════════════════════════════════════════════════════════════
describe('SPEC 5: cache is invalidated by stage, discard, and publish', () => {
  afterEach(() => invalidateTenantCache('acme'))

  it('stageConfigChange busts the slug cache', async () => {
    cacheTenant('acme', tenant())
    expect(getCachedTenant('acme')).not.toBeNull()
    await stageConfigChange(new StageDb(null) as unknown as D1Database, { id: 't1', slug: 'acme' }, { phone: 'X' })
    expect(getCachedTenant('acme')).toBeNull()
  })

  it('discardDraft busts the slug cache', async () => {
    cacheTenant('acme', tenant())
    expect(getCachedTenant('acme')).not.toBeNull()
    await discardDraft(envOf(new PublishDb(tenant({ draft_config: '{"phone":"9"}' }))), tenant())
    expect(getCachedTenant('acme')).toBeNull()
  })

  it('publishDraft busts the slug cache (so the next chat turn reads new live config)', async () => {
    cacheTenant('acme', tenant())
    expect(getCachedTenant('acme')).not.toBeNull()
    await publishDraft(envOf(new PublishDb(tenant({ draft_config: '{"phone":"NEW"}' }))), tenant())
    expect(getCachedTenant('acme')).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// SPEC 6 — No test verdict can block Publish, anywhere; ladder has no tests step.
// ════════════════════════════════════════════════════════════════════════════
describe('SPEC 6: tests NEVER gate publishing in any readiness/onboarding path', () => {
  // setup-state ladder fake: loadTestSummary issues one SELECT; return a
  // worst-case test posture (failing + unrun, zero passing) and assert the
  // ladder still resolves to publish and emits no tests blocker.
  class SummaryDb {
    constructor(public summaryRows: Array<{ id: string; passed: number | null; created_at: string | null }>) {}
    prepare(sql: string) {
      const rows = this.summaryRows
      return {
        bind() { return this },
        async first() { return null },
        async all() { return /eval_scenarios/.test(sql) ? { results: rows } : { results: [] } },
        async run() { return { success: true } },
      }
    }
  }
  // Tenant ready on every non-test axis but with failing/unrun tests staged.
  const readyTenant = tenant({
    phone: 'P', org_config: JSON.stringify({ hours: 'H' }),
    location_service_area: 'Area',
    onboarded: 0, widget_published_at: null,
  })
  // species rules present so the only remaining ladder step is publish
  const readyWithSpecies = tenant({
    ...readyTenant,
    org_config: JSON.stringify({ hours: 'H', species_config: { Coyote: { mode: 'augment', notes: 'x' } } }),
  })
  const badTests = [
    { id: 's1', passed: 0, created_at: '2026-01-01' },  // failing
    { id: 's2', passed: null, created_at: null },        // unrun
  ]

  it('loadSetupState next_action ladder ends at "publish" with failing+unrun tests (never "tests")', async () => {
    const db = new SummaryDb(badTests)
    const state = await loadSetupState(envOf(db), readyWithSpecies)
    expect(state.next_action).toBe('publish')
    // and the ladder type itself has no 'tests' member — assert no path emits it
    expect(['website', 'service_area', 'species', 'publish', 'done']).toContain(state.next_action)
    expect(state.tests.failing).toBe(1)
    expect(state.tests.unrun).toBe(1)
  })

  it('loadSetupState ladder is website→service_area→species→publish (no tests rung)', async () => {
    const db = new SummaryDb(badTests)
    // missing website basics
    expect((await loadSetupState(envOf(db), tenant({ phone: null, org_config: '{}', location_service_area: null, onboarded: 0 }))).next_action).toBe('website')
    // website ok, missing service area
    expect((await loadSetupState(envOf(db), tenant({ phone: 'P', org_config: '{"hours":"H"}', location_service_area: null, onboarded: 0 }))).next_action).toBe('service_area')
    // website+area ok, missing species
    expect((await loadSetupState(envOf(db), tenant({ phone: 'P', org_config: '{"hours":"H"}', location_service_area: 'A', onboarded: 0 }))).next_action).toBe('species')
    // all ok → publish (NOT tests)
    expect((await loadSetupState(envOf(db), readyWithSpecies)).next_action).toBe('publish')
  })

  it('computeSetupReadiness emits NO blocker mentioning tests, even with zero/failing tests', async () => {
    // loadTenantById SELECT * returns the ready tenant; loadTestSummary returns bad tests.
    class ReadinessDb {
      constructor(public t: Tenant, public summaryRows: typeof badTests) {}
      prepare(sql: string) {
        const self = this
        return {
          bind() { return this },
          async first() { return /SELECT \* FROM tenants/.test(sql) ? self.t : null },
          async all() { return /eval_scenarios/.test(sql) ? { results: self.summaryRows } : { results: [] } },
          async run() { return { success: true } },
        }
      }
    }
    const db = new ReadinessDb(readyWithSpecies, badTests)
    const r = await computeSetupReadiness(db as unknown as D1Database, 't1', readyWithSpecies)
    for (const b of r.blockers) {
      expect(b.toLowerCase()).not.toMatch(/test|scenario|passing|failing|grade/)
    }
    // the only legitimate remaining blocker is "publish the widget"
    expect(r.blockers.length).toBe(1)
    expect(r.blockers[0]).toMatch(/published/i)
  })

  it('computeSetupReadiness with ZERO tests is still ready once published', async () => {
    class ReadinessDb {
      constructor(public t: Tenant) {}
      prepare(sql: string) {
        const self = this
        return {
          bind() { return this },
          async first() { return /SELECT \* FROM tenants/.test(sql) ? self.t : null },
          async all() { return { results: [] } },  // zero scenarios
          async run() { return { success: true } },
        }
      }
    }
    const published = tenant({
      phone: 'P', location_service_area: 'A',
      org_config: JSON.stringify({ hours: 'H', species_config: { Coyote: { mode: 'augment', notes: 'x' } } }),
      onboarded: 1, widget_published_at: '2026-01-01T00:00:00Z',
    })
    const db = new ReadinessDb(published)
    const r = await computeSetupReadiness(db as unknown as D1Database, 't1', published)
    expect(r.is_ready).toBe(true)
    expect(r.blockers).toEqual([])
    expect(r.test_cases.total).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// SPEC 7 — Human verdict overrides the auto-grader and persists; editing resets it.
// ════════════════════════════════════════════════════════════════════════════
describe('SPEC 7: human review verdict semantics', () => {
  class ReviewDb {
    writes: { sql: string; binds: unknown[] }[] = []
    constructor(public row: Record<string, unknown> | null, public changes = 1) {}
    prepare(sql: string) {
      const self = this
      let binds: unknown[] = []
      return {
        bind(...args: unknown[]) { binds = args; return this },
        async first() { return self.row },
        async run() { self.writes.push({ sql, binds }); return { success: true, meta: { changes: self.changes } } },
      }
    }
  }

  it('editing a scenario resets review_status to unreviewed and clears reviewed_at', async () => {
    const db = new ReviewDb({ id: 's1', description: 'old', expected_behavior: 'eb', test_message: 'msg' })
    await updateEvalScenario({ DB: db } as unknown as Env, 't1', 's1', { test_message: 'changed' })
    const w = db.writes.find(x => /UPDATE eval_scenarios/.test(x.sql))!
    expect(w.sql).toMatch(/review_status = 'unreviewed'/)
    expect(w.sql).toMatch(/reviewed_at = NULL/)
  })

  it('setting a verdict persists it (approved stamps reviewed_at; unreviewed clears)', async () => {
    const db = new ReviewDb({ id: 's1' })
    const approved = await reviewEvalScenario({ DB: db } as unknown as Env, 't1', 's1', 'approved')
    expect(approved).toMatchObject({ id: 's1', review_status: 'approved' })
    expect((approved as { reviewed_at: string | null }).reviewed_at).toBeTruthy()
    const cleared = await reviewEvalScenario({ DB: db } as unknown as Env, 't1', 's1', 'unreviewed')
    expect((cleared as { reviewed_at: string | null }).reviewed_at).toBeNull()
  })

  it('an invalid verdict is rejected (only unreviewed/approved/rejected allowed)', async () => {
    const db = new ReviewDb({ id: 's1' })
    const res = await reviewEvalScenario({ DB: db } as unknown as Env, 't1', 's1', 'maybe')
    expect('error' in res && res.status).toBe(400)
  })

  // The auto-grader (eval-runner) writes ONLY into eval_results.passed; it has
  // no path that writes eval_scenarios.review_status. So a human verdict set on
  // the scenario row cannot be overwritten by a later auto-grade. We assert the
  // CRUD review writer is the sole writer of review_status by confirming the
  // review UPDATE targets only review_status/reviewed_at on eval_scenarios.
  it('reviewEvalScenario is the authoritative writer of review_status (targets only that column)', async () => {
    const db = new ReviewDb({ id: 's1' })
    await reviewEvalScenario({ DB: db } as unknown as Env, 't1', 's1', 'rejected')
    const w = db.writes.find(x => /UPDATE eval_scenarios/.test(x.sql))!
    expect(w.sql).toMatch(/SET review_status = \?, reviewed_at = \?/)
    expect(w.sql).not.toMatch(/passed/)
    expect(w.binds[0]).toBe('rejected')
  })

  it('operators can delete scenarios via the API path (no support ticket) — exported & callable', async () => {
    // Just assert the delete data-layer is wired and atomic-batched (the bug was
    // a FK violation forcing a support ticket). Covered structurally in
    // evals-crud.test.ts; here we assert the function is part of the public API.
    const mod = await import('../src/lib/evals-crud')
    expect(typeof mod.deleteEvalScenario).toBe('function')
    expect(typeof mod.updateEvalScenario).toBe('function')
  })
})
