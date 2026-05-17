import { describe, it, expect } from 'vitest'
import { DEFAULT_TRIAGE_RULES, TriageRule } from '../src/lib/triage-defaults'

describe('DEFAULT_TRIAGE_RULES', () => {
  it('has exactly 8 rules', () => {
    expect(DEFAULT_TRIAGE_RULES).toHaveLength(8)
  })

  it('each rule has all required fields', () => {
    for (const rule of DEFAULT_TRIAGE_RULES) {
      expect(rule).toHaveProperty('id')
      expect(rule).toHaveProperty('label')
      expect(rule).toHaveProperty('patterns')
      expect(rule).toHaveProperty('urgency')
      expect(rule).toHaveProperty('hint')
      expect(rule).toHaveProperty('builtin')

      expect(typeof rule.id).toBe('string')
      expect(rule.id.length).toBeGreaterThan(0)
      expect(typeof rule.label).toBe('string')
      expect(rule.label.length).toBeGreaterThan(0)
      expect(Array.isArray(rule.patterns)).toBe(true)
      expect(rule.patterns.length).toBeGreaterThan(0)
      expect(typeof rule.hint).toBe('string')
      expect(rule.hint.length).toBeGreaterThan(0)
      expect(rule.builtin).toBe(true)
    }
  })

  it('urgency levels include info', () => {
    const urgencies = new Set(DEFAULT_TRIAGE_RULES.map(r => r.urgency))
    expect(urgencies.has('info')).toBe(true)
  })

  it('urgency levels are all valid', () => {
    const validUrgencies = new Set(['critical', 'urgent', 'moderate', 'info'])
    for (const rule of DEFAULT_TRIAGE_RULES) {
      expect(validUrgencies.has(rule.urgency)).toBe(true)
    }
  })

  it('all pattern strings are valid regex', () => {
    for (const rule of DEFAULT_TRIAGE_RULES) {
      for (const pattern of rule.patterns) {
        expect(() => new RegExp(pattern)).not.toThrow()
      }
    }
  })

  it('rule ids are unique', () => {
    const ids = DEFAULT_TRIAGE_RULES.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('includes all four urgency levels', () => {
    const urgencies = new Set(DEFAULT_TRIAGE_RULES.map(r => r.urgency))
    expect(urgencies).toEqual(new Set(['critical', 'urgent', 'moderate', 'info']))
  })
})
