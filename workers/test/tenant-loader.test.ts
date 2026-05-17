import { describe, it, expect } from 'vitest'
import { parseOrgConfig, extractOrgConfig } from '../src/lib/tenant-loader'
import type { Tenant } from '../src/lib/types'

/**
 * parseOrgConfig / extractOrgConfig are the "guarded JSON parse" the
 * audit flagged as duplicated across routes. The defensive behavior — fall
 * back to {} on any malformed-or-non-object input — is what callers rely
 * on; without it, a corrupted org_config column would cascade into a 500
 * across every read path.
 *
 * loadTenantBySlug / loadTenantById / loadOrgConfig take an Env (with D1
 * binding) so their tests would need a D1 stub. The fakeEnv pattern is
 * used elsewhere in the suite; the read-shape is simple enough that the
 * integration tests cover them implicitly. The pure parsers are the
 * load-bearing logic — that's what's tested here.
 */

describe('parseOrgConfig', () => {
  it('returns {} for null', () => {
    expect(parseOrgConfig(null)).toEqual({})
  })

  it('returns {} for undefined', () => {
    expect(parseOrgConfig(undefined)).toEqual({})
  })

  it('returns {} for empty string', () => {
    expect(parseOrgConfig('')).toEqual({})
  })

  it('parses a normal object', () => {
    expect(parseOrgConfig('{"hours":"9am-5pm","phone":"555"}')).toEqual({
      hours: '9am-5pm',
      phone: '555',
    })
  })

  it('returns {} for malformed JSON (no throw)', () => {
    // The audit's "guarded parse" requirement: a corrupted column should
    // never cause a route to 500. Callers can treat {} as "no config" and
    // proceed.
    expect(parseOrgConfig('{not json')).toEqual({})
    expect(parseOrgConfig('garbage')).toEqual({})
  })

  it('returns {} for JSON null', () => {
    // JSON.parse('null') succeeds and returns null. Without the
    // "non-object root" guard, the value would coerce into a Record-shaped
    // null and a downstream `orgConfig.hours` would throw "Cannot read
    // properties of null".
    expect(parseOrgConfig('null')).toEqual({})
  })

  it('returns {} for JSON array (non-object root)', () => {
    // Arrays are objects in JS but not the Record<string, unknown> shape
    // the caller expects. Defending against this means orgConfig.hours
    // returns undefined (correct) instead of `orgConfig[0]` (wrong shape).
    expect(parseOrgConfig('[1,2,3]')).toEqual({})
  })

  it('returns {} for JSON primitive (string / number / boolean)', () => {
    expect(parseOrgConfig('"hello"')).toEqual({})
    expect(parseOrgConfig('42')).toEqual({})
    expect(parseOrgConfig('true')).toEqual({})
  })

  it('preserves nested object structure', () => {
    const input = '{"species_config":{"Pigeon":{"mode":"skip"}},"hours":"9-5"}'
    const r = parseOrgConfig(input)
    expect(r).toEqual({
      species_config: { Pigeon: { mode: 'skip' } },
      hours: '9-5',
    })
  })
})

describe('extractOrgConfig', () => {
  it('parses the org_config column off a tenant row', () => {
    const tenant = {
      id: 'wc-1', slug: 'wildcare', name: 'WildCare',
      org_config: '{"hours":"9-5"}',
    } as Tenant
    expect(extractOrgConfig(tenant)).toEqual({ hours: '9-5' })
  })

  it('returns {} when org_config is null on the tenant row', () => {
    const tenant = { id: 'wc-1', slug: 'wildcare', name: 'WildCare', org_config: null } as Tenant
    expect(extractOrgConfig(tenant)).toEqual({})
  })
})
