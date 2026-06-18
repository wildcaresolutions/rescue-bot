import { describe, it, expect } from 'vitest'
import { protocolsTools } from '../src/lib/tools/protocols'
import { configTools } from '../src/lib/tools/config'
import type { ToolContext } from '../src/lib/tools/types'
import type { Tenant } from '../src/lib/types'

// Regression for the 2026-06-18 incident: the admin copilot called
// save_protocols (a WRITE tool) as if to READ state, slammed
// "PLACEHOLDER_TO_READ" over the tenant's prompt, and — because the tool wrote
// the compiled `custom_instruction` as a raw override — wiped the species
// protocols. The fixes under test:
//   1. save_protocols writes `house_rules` (the operator-prose column), never
//      `custom_instruction`, so it can't clobber the compiled species prompt.
//   2. save_protocols rejects empty / placeholder / catastrophic-shrink writes.
//   3. get_config returns the FULL house_rules (and custom_instruction), so the
//      agent never needs to "probe" with a write to see current state.

// Records every draft write so we can assert what was staged (and that guard
// failures stage nothing). first() answers the two reads the tools make:
// stageConfigChange's "SELECT draft_config" and loadTenantById's "SELECT ...".
class RecordingD1 {
  writes: Array<{ json: string }> = []
  prepare(sql: string) {
    let args: unknown[] = []
    const me = this
    return {
      bind(...a: unknown[]) { args = a; return this },
      first: async <T>() => {
        if (/SELECT\s+draft_config/i.test(sql)) return { draft_config: null } as unknown as T
        return null as unknown as T // loadTenantById -> tool falls back to freshTenant
      },
      run: async () => {
        if (/UPDATE\s+tenants\s+SET\s+draft_config/i.test(sql)) {
          me.writes.push({ json: String(args[0]) })
        }
        return {}
      },
      all: async () => ({ results: [] }),
    }
  }
}

function makeTenant(over: Partial<Tenant>): Tenant {
  return {
    id: 'wc-1', slug: 'wildcare', name: 'WildCare',
    phone: '415-555-1212', email: null, url: null,
    location_county: 'Marin', location_state: 'CA', location_service_area: 'Marin County',
    color_primary: '#000', color_secondary: '#111', color_accent: null,
    org_config: null, bot_overrides: null, house_rules: null, custom_instruction: null,
    custom_instruction_locked: 0, draft_config: null,
    ...over,
  } as unknown as Tenant
}

function ctxWith(db: RecordingD1, freshTenant: Tenant): ToolContext {
  return { db, tenantId: freshTenant.id, freshTenant, env: {} } as unknown as ToolContext
}

const run = (tool: any, input: unknown) => tool.execute(input, {} as any)

describe('save_protocols writes house_rules, never custom_instruction', () => {
  it('a normal edit stages house_rules', async () => {
    const db = new RecordingD1()
    const tools = protocolsTools(ctxWith(db, makeTenant({ house_rules: 'old short rules' })))
    const res = await run(tools.save_protocols, { house_rules: 'New full house rules text for the org, edited via copilot.' })
    expect(res.success).toBe(true)
    expect(db.writes).toHaveLength(1)
    const staged = JSON.parse(db.writes[0].json)
    expect(staged).toHaveProperty('house_rules')
    expect(staged).not.toHaveProperty('custom_instruction') // the bug was writing this
    expect(staged.house_rules).toContain('New full house rules')
  })

  it('rejects empty text without writing', async () => {
    const db = new RecordingD1()
    const tools = protocolsTools(ctxWith(db, makeTenant({ house_rules: 'real rules' })))
    const res = await run(tools.save_protocols, { house_rules: '   ' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('empty')
    expect(db.writes).toHaveLength(0)
  })

  it('rejects placeholder/probe text (the exact incident) without writing', async () => {
    const db = new RecordingD1()
    const tools = protocolsTools(ctxWith(db, makeTenant({ house_rules: 'real rules' })))
    const res = await run(tools.save_protocols, { house_rules: 'PLACEHOLDER_TO_READ' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('placeholder')
    expect(db.writes).toHaveLength(0)
  })

  it('blocks a catastrophic shrink unless confirm_replace is set', async () => {
    const big = 'x'.repeat(2000)
    const db = new RecordingD1()
    const tools = protocolsTools(ctxWith(db, makeTenant({ house_rules: big })))
    const blocked = await run(tools.save_protocols, { house_rules: 'tiny' })
    expect(blocked.success).toBe(false)
    expect(blocked.error).toBe('drastic_shrink')
    expect(db.writes).toHaveLength(0)

    const ok = await run(tools.save_protocols, { house_rules: 'tiny', confirm_replace: true })
    expect(ok.success).toBe(true)
    expect(db.writes).toHaveLength(1)
    expect(JSON.parse(db.writes[0].json)).toHaveProperty('house_rules', 'tiny')
  })
})

describe('get_config exposes the full prompt (so the agent reads instead of probing)', () => {
  it('returns full house_rules and custom_instruction, not a truncated preview', async () => {
    const longRules = 'R'.repeat(1200)
    const compiled = 'COMPILED SPECIES PROTOCOLS ' + 'C'.repeat(800)
    const db = new RecordingD1()
    const tools = configTools(ctxWith(db, makeTenant({ house_rules: longRules, custom_instruction: compiled })))
    const res = await run(tools.get_config, {})
    expect(res.house_rules).toBe(longRules)          // FULL, not sliced
    expect(res.custom_instruction).toBe(compiled)    // FULL, not sliced
    expect(res).not.toHaveProperty('custom_instruction_preview') // the old truncated field is gone
  })
})
