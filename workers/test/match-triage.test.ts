import { describe, it, expect } from 'vitest'
import { matchTriage, effectiveTriageRules, type TenantTriageRule } from '../src/lib/match-triage'
import { DEFAULT_TRIAGE_RULES } from '../src/lib/triage-defaults'

/**
 * Tests for the triage rule engine — the regex-based message classifier
 * that the dashboard uses to flag urgent/critical chat sessions.
 *
 * Pre-prod audit P3-31 flagged this module specifically: "regex-based,
 * easy to break on edge cases." The cost of a wrong classification is
 * real: a critical bat-exposure session could go unnoticed if the regex
 * misses a phrasing the operator's tenant rule was supposed to catch.
 *
 * Tests fall into three groups:
 *   1. effectiveTriageRules: the merge between tenant overrides and the
 *      shipped DEFAULT_TRIAGE_RULES. Audit-visible state.
 *   2. matchTriage: the actual classify-a-message logic. Priority,
 *      case-insensitivity, regex safety.
 *   3. Specific defaults that have caused incidents IRL (bat exposure,
 *      snake bite, cat-caught animal) — regression tests so a future
 *      pattern edit doesn't silently downgrade urgency.
 */

describe('effectiveTriageRules — tenant + default merge', () => {
  it('returns defaults verbatim when tenant has no rules', () => {
    const rules = effectiveTriageRules(undefined)
    expect(rules).toHaveLength(DEFAULT_TRIAGE_RULES.length)
    expect(rules.map(r => r.id)).toEqual(DEFAULT_TRIAGE_RULES.map(r => r.id))
  })

  it('treats empty array same as undefined', () => {
    const rules = effectiveTriageRules([])
    expect(rules.map(r => r.id)).toEqual(DEFAULT_TRIAGE_RULES.map(r => r.id))
  })

  it('puts tenant rules BEFORE defaults (higher priority)', () => {
    // Order matters: matchTriage iterates in order and returns the first
    // hit. Tenants need their custom rules to win.
    const tenant: TenantTriageRule[] = [
      { label: 'fox', patterns: ['fox'], urgency: 'moderate', hint: 'tenant fox' },
    ]
    const rules = effectiveTriageRules(tenant)
    expect(rules[0].label).toBe('fox')
    expect(rules[0].urgency).toBe('moderate')
  })

  it('drops a default rule when tenant marks its id as deleted', () => {
    // Tenant doesn't want a particular default. Marking deleted on the
    // tenant's copy of that id removes it from effective output entirely.
    const builtinId = DEFAULT_TRIAGE_RULES[0].id
    const tenant: TenantTriageRule[] = [
      { id: builtinId, label: 'noop', patterns: [], urgency: 'info', hint: '', deleted: true },
    ]
    const rules = effectiveTriageRules(tenant)
    expect(rules.find(r => r.id === builtinId)).toBeUndefined()
  })

  it('overrides a default when tenant rule shares its id', () => {
    // Replacing a default: tenant rule with same id is kept (with their
    // tweaks); the default is dropped to avoid duplicate hits.
    const builtinId = DEFAULT_TRIAGE_RULES[0].id
    const tenant: TenantTriageRule[] = [
      { id: builtinId, label: 'my-version', patterns: ['custom'], urgency: 'info', hint: 'tenant-tuned' },
    ]
    const rules = effectiveTriageRules(tenant)
    const matches = rules.filter(r => r.id === builtinId)
    expect(matches).toHaveLength(1)
    expect(matches[0].label).toBe('my-version')
    expect(matches[0].hint).toBe('tenant-tuned')
  })

  it('skips tenant rules with no patterns (would never match anyway)', () => {
    // A tenant could leave patterns empty mid-edit. Don't surface empty
    // rules in the effective list — they only add noise.
    const tenant: TenantTriageRule[] = [
      { label: 'incomplete', patterns: [], urgency: 'info', hint: '' },
      { label: 'complete', patterns: ['something'], urgency: 'info', hint: '' },
    ]
    const rules = effectiveTriageRules(tenant)
    expect(rules.find(r => r.label === 'incomplete')).toBeUndefined()
    expect(rules.find(r => r.label === 'complete')).toBeDefined()
  })

  it('treats tenant rule without id as ADDITIVE, not OVERRIDING', () => {
    // Without an id, the tenant rule is appended; defaults aren't replaced.
    // Tenant rule still wins by priority (it's first in iteration), but the
    // default remains in the list and is matched if no earlier rule fires.
    const tenant: TenantTriageRule[] = [
      { label: 'no-id-rule', patterns: ['rare-trigger'], urgency: 'info', hint: '' },
    ]
    const rules = effectiveTriageRules(tenant)
    // Tenant rule is in the list
    expect(rules.find(r => r.label === 'no-id-rule')).toBeDefined()
    // All defaults still present
    for (const def of DEFAULT_TRIAGE_RULES) {
      expect(rules.find(r => r.id === def.id), `default ${def.id}`).toBeDefined()
    }
  })
})

describe('matchTriage — classification', () => {
  it('returns matched=false on no match', () => {
    const r = matchTriage('hello world', [])
    expect(r.matched).toBe(false)
    expect(r.urgency).toBe('none')
    expect(r.ruleId).toBeNull()
  })

  it('returns matched=false on empty / whitespace message', () => {
    expect(matchTriage('', []).matched).toBe(false)
    expect(matchTriage('   ', []).matched).toBe(false)
  })

  it('is case-insensitive on the message', () => {
    const r1 = matchTriage('there is a BAT in my BEDROOM', undefined)
    const r2 = matchTriage('there is a bat in my bedroom', undefined)
    expect(r1.matched).toBe(true)
    expect(r2.matched).toBe(true)
    expect(r1.ruleId).toBe(r2.ruleId)
  })

  it('returns the FIRST matched pattern within a rule', () => {
    // Some defaults have multiple patterns. Once one matches we stop —
    // matchedPattern is the one we hit, not the most-specific one.
    const tenant: TenantTriageRule[] = [
      {
        label: 'multi',
        patterns: ['alpha', 'beta', 'gamma'],
        urgency: 'urgent', hint: 'multi',
      },
    ]
    const r = matchTriage('alpha and beta both present', tenant)
    expect(r.matched).toBe(true)
    expect(r.matchedPattern).toBe('alpha')
  })

  it('tenant rule wins over a default that would also match', () => {
    // Both the tenant rule and a default would match — tenant goes first
    // in the iteration order so its result is returned.
    const tenant: TenantTriageRule[] = [
      { label: 'tenant-bat', patterns: ['bat'], urgency: 'moderate', hint: 'tenant says moderate' },
    ]
    const r = matchTriage('there is a bat in my house', tenant)
    expect(r.ruleLabel).toBe('tenant-bat')
    expect(r.urgency).toBe('moderate')
  })

  it('silently skips invalid regex patterns', () => {
    // A tenant could paste a malformed pattern (unbalanced paren etc.).
    // The function should not throw — it should move on to the next pattern.
    const tenant: TenantTriageRule[] = [
      {
        label: 'broken',
        patterns: ['(unbalanced', 'fallback-works'],
        urgency: 'urgent', hint: '',
      },
    ]
    expect(() => matchTriage('fallback-works', tenant)).not.toThrow()
    const r = matchTriage('fallback-works in the body', tenant)
    expect(r.matched).toBe(true)
    expect(r.matchedPattern).toBe('fallback-works')
  })

  it('returns hint=null when the matched rule has no hint', () => {
    const tenant: TenantTriageRule[] = [
      { label: 'no-hint', patterns: ['no-hint'], urgency: 'info', hint: '' },
    ]
    const r = matchTriage('no-hint here', tenant)
    expect(r.matched).toBe(true)
    expect(r.hint).toBeNull()
  })
})

describe('matchTriage — default-rule regression suite', () => {
  // These specific phrases have been the basis of past incidents. Pinning
  // them ensures a future pattern edit (e.g., refactoring "bat.*house" to
  // a stricter regex) doesn't silently downgrade urgency.

  it('bat in living space → critical (rabies exposure)', () => {
    const r = matchTriage('there is a bat in my house, what should I do?', undefined)
    expect(r.matched).toBe(true)
    expect(r.urgency).toBe('critical')
    expect(r.ruleId).toBe('bat-exposure')
  })

  it('bat in the bedroom → critical', () => {
    const r = matchTriage('I just woke up and found a bat flying around my bedroom', undefined)
    expect(r.matched).toBe(true)
    expect(r.urgency).toBe('critical')
  })

  it('rabies exposure direct mention → critical', () => {
    const r = matchTriage("I'm worried about rabies, please advise", undefined)
    expect(r.matched).toBe(true)
    expect(r.urgency).toBe('critical')
  })

  it('rattlesnake bite → critical', () => {
    const r = matchTriage('rattlesnake bit my dog', undefined)
    expect(r.matched).toBe(true)
    expect(r.urgency).toBe('critical')
    expect(r.ruleId).toBe('snake-bite')
  })

  it('cat-caught animal → urgent (saliva is toxic)', () => {
    const r = matchTriage('my cat caught a sparrow this morning', undefined)
    expect(r.matched).toBe(true)
    expect(r.urgency).toBe('urgent')
    expect(r.ruleId).toBe('cat-attack')
  })

  it('"my cat" alone → urgent (covers "my cat brought home a baby bird")', () => {
    // The DEFAULT pattern set includes "my cat" as a catch-all, since "my
    // cat" + any animal mention is almost always cat-attack triage. Tests
    // the loose pattern explicitly so we don't accidentally tighten it.
    const r = matchTriage('my cat got a hummingbird', undefined)
    expect(r.matched).toBe(true)
    expect(r.ruleId).toBe('cat-attack')
  })
})

describe('matchTriage — operator-supplied ReDoS pattern rejection', () => {
  // Audit ralph-1 H2 + ralph-2 C3: the ReDoS heuristic in isPatternSafe
  // refuses patterns with shapes known to backtrack catastrophically. The
  // tenant-rule path silently skips a rejected pattern (no match), which
  // is the safe outcome — the regex never reaches the engine.

  const makeTenantRule = (pattern: string) => [{
    label: 'redos-test',
    patterns: [pattern],
    urgency: 'urgent' as const,
    hint: 'noop',
  }]

  it('rejects nested-quantifier pattern (a+)+', () => {
    const r = matchTriage('a'.repeat(50), makeTenantRule('(a+)+'))
    expect(r.matched).toBe(false)
  })

  it('rejects 2-alternate under quantifier (a|b)+', () => {
    const r = matchTriage('abab', makeTenantRule('(a|b)+'))
    expect(r.matched).toBe(false)
  })

  it('rejects 3-alternate under quantifier (a|b|c)+ — ralph-2 C3', () => {
    // The original 2-alternate-only shape missed this. C3 widened
    // REDOS_SHAPES to catch any alternation count.
    const r = matchTriage('abc'.repeat(20), makeTenantRule('(a|b|c)+'))
    expect(r.matched).toBe(false)
  })

  it('rejects non-capturing alternation (?:a|b|c)+', () => {
    const r = matchTriage('abc'.repeat(20), makeTenantRule('(?:a|b|c)+'))
    expect(r.matched).toBe(false)
  })

  it('rejects patterns over the 256-char length cap', () => {
    const r = matchTriage('hello', makeTenantRule('a'.repeat(300)))
    expect(r.matched).toBe(false)
  })

  it('still matches safe alternation WITHOUT trailing quantifier', () => {
    // (cat|dog|bird) — no `+` or `*` after the group — is fine and stays
    // accepted. Pin the boundary so future REDOS_SHAPES tightening doesn't
    // accidentally invalidate legitimate operator rules.
    const r = matchTriage('there is a bird outside', makeTenantRule('(cat|dog|bird)'))
    expect(r.matched).toBe(true)
    expect(r.urgency).toBe('urgent')
  })

  it('still matches simple word quantifier without alternation', () => {
    const r = matchTriage('helllllllo', makeTenantRule('hel+o'))
    expect(r.matched).toBe(true)
  })
})
