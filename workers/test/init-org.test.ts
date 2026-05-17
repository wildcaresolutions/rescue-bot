import { describe, it, expect } from 'vitest'
// @ts-expect-error — JS module, no .d.ts
import { parseD1List, parseD1CreateOutput, renderOrgEnv, ensureVectorizeIndex, ensureR2Bucket, createOrLookupD1, isValidOrgSlug, resourceNames } from '../scripts/init-org.js'

describe('parseD1List', () => {
  // Wrangler renders `d1 list` as a Unicode table. The exact box-drawing
  // characters and column widths shift across versions; we only rely on the
  // pipe-as-delimiter contract.
  const sample = `
┌──────────────────────────────────────┬───────────────────┬──────────┐
│ database_id                          │ name              │ size     │
├──────────────────────────────────────┼───────────────────┼──────────┤
│ 44c1d934-5623-4f24-bab0-65f8b0887fb6 │ wildcare-db       │ 5.2 MB   │
│ b14bff55-569e-4b49-9dfa-19f90b119789 │ wildcare-db-test  │ 1.1 MB   │
└──────────────────────────────────────┴───────────────────┴──────────┘
`

  it('returns the UUID for a name that exists', () => {
    expect(parseD1List(sample, 'wildcare-db')).toBe('44c1d934-5623-4f24-bab0-65f8b0887fb6')
    expect(parseD1List(sample, 'wildcare-db-test')).toBe('b14bff55-569e-4b49-9dfa-19f90b119789')
  })

  it('returns null when the name is not present', () => {
    expect(parseD1List(sample, 'nonexistent-db')).toBeNull()
  })

  it('does not match a partial name (e.g. wildcare-db should not match wildcare-db-test)', () => {
    // Matches on full column equality, not substring.
    const justTestDb = `│ b14bff55-569e-4b49-9dfa-19f90b119789 │ wildcare-db-test  │ 1.1 MB   │`
    expect(parseD1List(justTestDb, 'wildcare-db')).toBeNull()
    expect(parseD1List(justTestDb, 'wildcare-db-test')).toBe('b14bff55-569e-4b49-9dfa-19f90b119789')
  })

  it('returns null for empty output', () => {
    expect(parseD1List('', 'anything')).toBeNull()
  })
})

describe('parseD1CreateOutput', () => {
  // Wrangler `d1 create` prints a TOML snippet for the user to paste; we
  // capture the database_id from that block. Format has been stable across
  // wrangler 3.x and 4.x.
  const tomlBlock = `
✅ Successfully created DB 'wildcare-db' in region WNAM
Created your new D1 database.

[[d1_databases]]
binding = "DB"
database_name = "wildcare-db"
database_id = "44c1d934-5623-4f24-bab0-65f8b0887fb6"
`

  it('captures the UUID from the [[d1_databases]] TOML snippet', () => {
    expect(parseD1CreateOutput(tomlBlock)).toBe('44c1d934-5623-4f24-bab0-65f8b0887fb6')
  })

  it('falls back to the first standalone UUID if the TOML format changes', () => {
    const minimal = 'Created database with id 44c1d934-5623-4f24-bab0-65f8b0887fb6\n'
    expect(parseD1CreateOutput(minimal)).toBe('44c1d934-5623-4f24-bab0-65f8b0887fb6')
  })

  it('returns null if no UUID is anywhere in the output', () => {
    expect(parseD1CreateOutput('something went wrong')).toBeNull()
  })
})

describe('renderOrgEnv', () => {
  const values = {
    ACCOUNT_ID: 'a714fdcef53c17af46996e025fa06761',
    ORG_DOMAIN: 'wildcaresolutions.org',
    DEV_D1_DATABASE_ID: '44c1d934-5623-4f24-bab0-65f8b0887fb6',
  }

  it('emits one line per key in declaration order', () => {
    const out = renderOrgEnv(values)
    const dataLines = out.trim().split('\n').filter((l: string) => !l.startsWith('#'))
    expect(dataLines).toEqual([
      'ACCOUNT_ID=a714fdcef53c17af46996e025fa06761',
      'ORG_DOMAIN=wildcaresolutions.org',
      'DEV_D1_DATABASE_ID=44c1d934-5623-4f24-bab0-65f8b0887fb6',
    ])
  })

  it('starts with a comment header', () => {
    const out = renderOrgEnv(values)
    expect(out.startsWith('#')).toBe(true)
  })

  it('uses a custom header when provided', () => {
    const out = renderOrgEnv(values, '# acme-wildlife.org — custom header')
    expect(out.startsWith('# acme-wildlife.org — custom header')).toBe(true)
  })

  it('ends with a single trailing newline (no double-newline at EOF)', () => {
    const out = renderOrgEnv(values)
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })
})

describe('ensureVectorizeIndex', () => {
  it('returns "exists" when the index name is present in `vectorize list` output', () => {
    const fakeRunner = (cmd: string) => {
      if (cmd === 'vectorize list') return 'wildcare-docs\nwildcare-docs-test\n'
      throw new Error(`unexpected runner call: ${cmd}`)
    }
    expect(ensureVectorizeIndex('wildcare-docs', fakeRunner)).toBe('exists')
  })

  it('returns "created" and calls create when the index is absent', () => {
    const calls: string[] = []
    const fakeRunner = (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'vectorize list') return 'some-other-index\n'
      return ''
    }
    expect(ensureVectorizeIndex('wildcare-docs-dev', fakeRunner)).toBe('created')
    expect(calls).toContain('vectorize create wildcare-docs-dev --dimensions 768 --metric cosine')
  })

  it('still creates if `vectorize list` throws (fresh account with no indexes)', () => {
    const calls: string[] = []
    const fakeRunner = (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'vectorize list') throw new Error('no indexes yet')
      return ''
    }
    expect(ensureVectorizeIndex('wildcare-docs', fakeRunner)).toBe('created')
    expect(calls).toContain('vectorize create wildcare-docs --dimensions 768 --metric cosine')
  })
})

describe('ensureR2Bucket', () => {
  it('returns "exists" when the bucket is in `r2 bucket list` output', () => {
    const fakeRunner = (cmd: string) => {
      if (cmd === 'r2 bucket list') return 'wildcare-assets\nwildcare-assets-test\n'
      throw new Error(`unexpected runner call: ${cmd}`)
    }
    expect(ensureR2Bucket('wildcare-assets', fakeRunner)).toBe('exists')
  })

  it('returns "created" when the bucket is absent', () => {
    const fakeRunner = (cmd: string) => (cmd === 'r2 bucket list' ? 'other-bucket\n' : '')
    expect(ensureR2Bucket('wildcare-assets', fakeRunner)).toBe('created')
  })
})

describe('createOrLookupD1', () => {
  // Verifies the idempotency contract: don't try to create a DB that already
  // exists. The script can be re-run safely on partially-provisioned forks.
  it('returns the existing UUID without calling create when the DB is already present', () => {
    const calls: string[] = []
    const existingId = '44c1d934-5623-4f24-bab0-65f8b0887fb6'
    const fakeRunner = (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'd1 list') {
        return `│ ${existingId} │ wildcare-db       │ 5.2 MB │`
      }
      throw new Error(`unexpected runner call: ${cmd}`)
    }
    expect(createOrLookupD1('wildcare-db', fakeRunner)).toBe(existingId)
    expect(calls).toEqual(['d1 list'])
  })

  it('creates the DB and returns the new UUID when absent', () => {
    const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const calls: string[] = []
    const fakeRunner = (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'd1 list') return ''
      if (cmd === 'd1 create wildcare-db') return `database_id = "${newId}"`
      throw new Error(`unexpected: ${cmd}`)
    }
    expect(createOrLookupD1('wildcare-db', fakeRunner)).toBe(newId)
    expect(calls).toEqual(['d1 list', 'd1 create wildcare-db'])
  })

  it('throws when create succeeds but no UUID can be parsed (defensive)', () => {
    const fakeRunner = (cmd: string) => (cmd === 'd1 list' ? '' : 'no UUID anywhere')
    expect(() => createOrLookupD1('wildcare-db', fakeRunner)).toThrow(/failed to capture D1 ID/)
  })
})

describe('isValidOrgSlug', () => {
  // The slug becomes the prefix for every CF resource AND the leftmost label
  // of workers.dev subdomains, so it must conform to DNS-label grammar.
  it('accepts simple lowercase identifiers', () => {
    expect(isValidOrgSlug('wildcare')).toBeNull()
    expect(isValidOrgSlug('acme')).toBeNull()
    expect(isValidOrgSlug('ab')).toBeNull() // 2 chars (minimum)
  })

  it('accepts hyphenated identifiers', () => {
    expect(isValidOrgSlug('bay-rescue')).toBeNull()
    expect(isValidOrgSlug('acme-wildlife-rehab')).toBeNull()
  })

  it('accepts digits', () => {
    expect(isValidOrgSlug('rescue42')).toBeNull()
    expect(isValidOrgSlug('a1')).toBeNull()
  })

  it('rejects empty / single-char / over-30-char', () => {
    expect(isValidOrgSlug('')).toMatch(/required/)
    expect(isValidOrgSlug('a')).toMatch(/2-30/)
    expect(isValidOrgSlug('a'.repeat(31))).toMatch(/2-30/)
  })

  it('rejects uppercase, spaces, special chars (not DNS-label-shape)', () => {
    expect(isValidOrgSlug('WildCare')).toMatch(/DNS-label/)
    expect(isValidOrgSlug('wild care')).toMatch(/DNS-label/)
    expect(isValidOrgSlug('wild_care')).toMatch(/DNS-label/)
    expect(isValidOrgSlug('wild.care')).toMatch(/DNS-label/)
  })

  it('rejects leading/trailing hyphen (DNS-label rule)', () => {
    expect(isValidOrgSlug('-wildcare')).toMatch(/DNS-label/)
    expect(isValidOrgSlug('wildcare-')).toMatch(/DNS-label/)
  })

  it('rejects reserved subdomain labels', () => {
    // These would conflict with platform-level routes like admin.<domain>,
    // api.<domain>, embed.<domain>. Catching at provision time prevents the
    // "I called my org `admin` and now my tenant doesn't route" mistake.
    for (const reserved of ['admin', 'api', 'platform', 'www', 'embed', 'dev', 'test', 'staging']) {
      expect(isValidOrgSlug(reserved)).toMatch(/reserved/)
    }
  })
})

describe('resourceNames', () => {
  // The whole reason ORG_SLUG exists: two forks of rescue-bot in two CF
  // accounts shouldn't collide on resource names. This test pins the naming
  // contract so a future "let me rename worker prefix" change has to update
  // the test deliberately.
  it('derives all resource names from a single slug', () => {
    const names = resourceNames('wildcare')
    expect(names.d1).toEqual({
      DEV_D1_DATABASE_ID: 'wildcare-db',
      TEST_D1_DATABASE_ID: 'wildcare-db-test',
      PROD_D1_DATABASE_ID: 'wildcare-db',
    })
    expect(names.vectorize).toEqual(['wildcare-docs-dev', 'wildcare-docs-test', 'wildcare-docs'])
    expect(names.r2).toEqual(['wildcare-assets', 'wildcare-assets-test', 'wildcare-media', 'wildcare-media-test'])
  })

  it('works for a hyphenated fork slug without breaking the contract', () => {
    const names = resourceNames('bay-rescue')
    expect(names.d1.DEV_D1_DATABASE_ID).toBe('bay-rescue-db')
    expect(names.d1.TEST_D1_DATABASE_ID).toBe('bay-rescue-db-test')
    expect(names.vectorize[0]).toBe('bay-rescue-docs-dev')
    expect(names.r2[2]).toBe('bay-rescue-media')
  })
})
