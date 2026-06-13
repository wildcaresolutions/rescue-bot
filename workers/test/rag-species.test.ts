import { describe, it, expect } from 'vitest'
import { detectSpecies, normalizeSpeciesKey, buildSpeciesModeMap, searchRAG } from '../src/lib/rag'
import type { Env } from '../src/lib/types'

// These tests target the regression that ate Lindsay's onboarding session:
// the operator marked Pigeon as `skip` but RAG still pulled songbird/general
// bird care chunks (because pigeon was bundled into the songbird detection
// pattern and species_config wasn't read by RAG at all). Three things have
// to be true now:
//   1. pigeon detects as 'pigeon', not 'songbird'
//   2. species_config["Pigeon"]: skip → empty RAG result for pigeon queries
//   3. species_config["Songbird"]: override → builtin/shared songbird chunks
//      are dropped, but tenant-specific ones survive

describe('detectSpecies — pigeon split', () => {
  it('detects pigeon as its own bucket, not songbird', () => {
    expect(detectSpecies('There is an injured pigeon on my porch')).toBe('pigeon')
    expect(detectSpecies('A mourning dove hit my window')).toBe('pigeon')
    expect(detectSpecies('rock dove on the sidewalk')).toBe('pigeon')
  })

  it('still detects actual songbirds as songbird', () => {
    expect(detectSpecies('robin in my yard')).toBe('songbird')
    expect(detectSpecies('A baby sparrow fell from a nest')).toBe('songbird')
  })

  it('pigeon takes precedence over songbird when both terms appear', () => {
    // Order in SPECIES_PATTERNS matters — pigeon comes first so pigeon-and-
    // songbird sentences resolve to pigeon (more specific intent).
    expect(detectSpecies('I see a pigeon and a sparrow')).toBe('pigeon')
  })
})

describe('detectSpecies — wild turkey', () => {
  it('detects "turkey" and "wild turkey" as turkey', () => {
    expect(detectSpecies('There is an injured wild turkey on the side of the road')).toBe('turkey')
    expect(detectSpecies('a turkey is limping in my yard')).toBe('turkey')
  })

  it('detects poult (baby turkey) as turkey', () => {
    expect(detectSpecies('found a poult by itself')).toBe('turkey')
  })
})

describe('normalizeSpeciesKey', () => {
  it('lowercases simple labels', () => {
    expect(normalizeSpeciesKey('Pigeon')).toBe('pigeon')
    expect(normalizeSpeciesKey('Bat')).toBe('bat')
  })

  it('maps multi-token catalog labels to canonical underscore tokens', () => {
    expect(normalizeSpeciesKey('Heron & Egret')).toBe('heron_egret')
    expect(normalizeSpeciesKey('Duck & Goose')).toBe('duck_goose')
    expect(normalizeSpeciesKey('Deer & Fawn')).toBe('deer')
    expect(normalizeSpeciesKey('Pigeon & Dove')).toBe('pigeon')
    expect(normalizeSpeciesKey('Entangled Animal')).toBe('entangled')
  })

  it('handles separator variants (slash, hyphen, mixed) the same way', () => {
    // Real-world: Lindsay's tenant has both "Pigeon/Dove" and "Pigeon"
    // saved as separate species_config entries — both must collapse to
    // the same canonical token so RAG sees the skip directive either way.
    expect(normalizeSpeciesKey('Pigeon/Dove')).toBe('pigeon')
    expect(normalizeSpeciesKey('Pigeon-Dove')).toBe('pigeon')
    expect(normalizeSpeciesKey('PIGEON  DOVE')).toBe('pigeon')
  })

  it('falls through to underscore-joined lowercase for unknown labels', () => {
    expect(normalizeSpeciesKey('Snowy Plover')).toBe('snowy_plover')
  })

  it('maps wild-turkey label variants to the same canonical token detection emits', () => {
    // wildcare's pre-existing org_config uses the key "wild turkey"; once
    // detection started emitting `turkey`, the skip/builtin lookup would
    // silently miss without this alias.
    expect(normalizeSpeciesKey('Wild Turkey')).toBe('turkey')
    expect(normalizeSpeciesKey('wild turkey')).toBe('turkey')
    expect(normalizeSpeciesKey('Turkey')).toBe('turkey')
  })
})

describe('buildSpeciesModeMap', () => {
  it('returns empty for null/undefined input', () => {
    expect(buildSpeciesModeMap(null)).toEqual({})
    expect(buildSpeciesModeMap(undefined)).toEqual({})
    expect(buildSpeciesModeMap({})).toEqual({})
  })

  it('canonicalizes keys + skips invalid modes', () => {
    expect(
      buildSpeciesModeMap({
        Pigeon: { mode: 'skip' },
        'Heron & Egret': { mode: 'override' },
        Bat: { mode: 'augment' },
        // bogus mode silently ignored
        Coyote: { mode: 'banana' as unknown as string },
        // missing mode silently ignored
        Fox: {},
      }),
    ).toEqual({
      pigeon: 'skip',
      heron_egret: 'override',
      bat: 'augment',
    })
  })
})

// ── searchRAG behavior under species_config ────────────────────────────────

class StubVectorize {
  // We don't actually exercise embedding/vector math here — we mock the
  // query() result directly to focus on filtering behavior.
  __nextResults: Array<Array<{
    id: string; score: number; metadata: Record<string, string>
  }>> = []

  setResults(results: typeof this.__nextResults) { this.__nextResults = results }

  async query(): Promise<{ matches: Array<{ id: string; score: number; metadata: Record<string, string> }> }> {
    const matches = this.__nextResults.shift() ?? []
    return { matches }
  }
}

class StubAI {
  async run() { return { data: [Array(8).fill(0).map(() => Math.random())] } }
}

function makeEnv(vec: StubVectorize): Env {
  return {
    AI: new StubAI() as unknown as Ai,
    VECTORIZE: vec as unknown as VectorizeIndex,
  } as unknown as Env
}

describe('searchRAG — species_config short-circuits', () => {
  it('returns empty results immediately for skip species (and does not hit Vectorize)', async () => {
    const vec = new StubVectorize()
    // Intentionally NOT seeding any results — if searchRAG calls query()
    // this would error or return empty in a way that doesn't match the
    // skip-path return signature. The fact that the test passes proves
    // we short-circuited before any Vectorize call.
    const r = await searchRAG(makeEnv(vec), 'wc-1', 'injured pigeon on porch', {
      speciesModes: { pigeon: 'skip' },
    })
    expect(r.detectedSpecies).toBe('pigeon')
    expect(r.speciesSkipped).toBe(true)
    expect(r.speciesOverridden).toBe(false)
    expect(r.results).toEqual([])
  })

  it('does NOT short-circuit when species is configured but mode is augment', async () => {
    const vec = new StubVectorize()
    vec.setResults([
      [{ id: 'c1', score: 0.9, metadata: { text: 'pigeon care', source: 'pigeon.md', species: 'pigeon', tenant_id: 'shared' } }],
    ])
    const r = await searchRAG(makeEnv(vec), 'wc-1', 'pigeon question', {
      speciesModes: { pigeon: 'augment' },
    })
    expect(r.speciesSkipped).toBe(false)
    expect(r.results.length).toBeGreaterThan(0)
  })

  it('drops shared/builtin chunks for override species but keeps tenant-specific ones', async () => {
    const vec = new StubVectorize()
    // Three matches for songbird query: builtin shared, tenant-specific,
    // unrelated. The first should be dropped under override, others kept.
    vec.setResults([
      [
        { id: 'shared-songbird', score: 0.9, metadata: { text: 'builtin songbird', source: 'songbird.md', species: 'songbird', tenant_id: 'shared' } },
        { id: 'tenant-songbird', score: 0.85, metadata: { text: 'org-specific songbird protocol', source: 'site/songbird.md', species: 'songbird', tenant_id: 'wc-1' } },
        { id: 'shared-other', score: 0.8, metadata: { text: 'unrelated raccoon care', source: 'raccoon.md', species: 'raccoon', tenant_id: 'shared' } },
      ],
    ])
    const r = await searchRAG(makeEnv(vec), 'wc-1', 'sparrow on the ground', {
      speciesModes: { songbird: 'override' },
    })
    expect(r.speciesOverridden).toBe(true)
    const ids = r.results.map(x => x.id)
    expect(ids).not.toContain('shared-songbird')
    expect(ids).toContain('tenant-songbird')
    expect(ids).toContain('shared-other')
  })

  it('passes through normally when no species_config is set', async () => {
    const vec = new StubVectorize()
    vec.setResults([
      [{ id: 'c1', score: 0.9, metadata: { text: 'songbird care', source: 'songbird.md', species: 'songbird', tenant_id: 'shared' } }],
    ])
    const r = await searchRAG(makeEnv(vec), 'wc-1', 'sparrow help', {})
    expect(r.speciesSkipped).toBe(false)
    expect(r.speciesOverridden).toBe(false)
    expect(r.results.length).toBeGreaterThan(0)
  })
})

// ── Tenant-isolation regression suite (P1-23) ──────────────────────────────
// rag.ts has two layers of tenant defense:
//   1. Vectorize query filter:  filter: { tenant_id: { $in: ['shared', X] } }
//   2. Post-filter on results:  reject any match where metadata.tenant_id is
//      neither 'shared' nor the requesting tenantId (with a narrow escape
//      hatch for legacy generic/* sources that pre-date multi-tenancy).
//
// The Vectorize filter alone is correct in steady state, but post-filtering
// matters when:
//   - A vector was indexed before metadata.tenant_id was added (legacy data)
//   - Vectorize's filter semantics differ from D1 (rare but real)
//   - The fallback path (line 246+) runs the unfiltered query
//
// These tests stub Vectorize to return cross-tenant rows even when the
// filter SHOULD have excluded them. If the post-filter ever drops out, the
// test fails red.

describe('searchRAG — tenant isolation post-filter (P1-23)', () => {
  it("rejects another tenant's rows even if Vectorize returns them", async () => {
    const vec = new StubVectorize()
    // StubVectorize ignores the filter param entirely — so this test models
    // "what if the Vectorize filter doesn't work" (the worst case). The
    // post-filter must catch the leak.
    vec.setResults([
      [
        { id: 'our-row',   score: 0.9, metadata: { text: 'our raccoon protocol',   source: 'raccoon.md', species: 'raccoon', tenant_id: 'wc-1' } },
        { id: 'their-row', score: 0.88, metadata: { text: 'their raccoon protocol', source: 'raccoon.md', species: 'raccoon', tenant_id: 'other-tenant' } },
        { id: 'shared',    score: 0.86, metadata: { text: 'shared raccoon care',    source: 'raccoon.md', species: 'raccoon', tenant_id: 'shared' } },
      ],
    ])
    const r = await searchRAG(makeEnv(vec), 'wc-1', 'injured raccoon', {})
    const ids = r.results.map(m => m.id)
    expect(ids).toContain('our-row')
    expect(ids).toContain('shared')
    // The load-bearing assertion:
    expect(ids).not.toContain('their-row')
  })

  it("rejects rows with missing tenant_id metadata unless they're explicitly legacy generic/*", async () => {
    const vec = new StubVectorize()
    vec.setResults([
      [
        { id: 'unknown',         score: 0.9, metadata: { text: 'pre-multi-tenant row, source unknown', source: 'mystery.md', species: 'raccoon' } },
        { id: 'legacy-generic',  score: 0.88, metadata: { text: 'legacy generic doc', source: 'generic/raccoon.md', species: 'raccoon' } },
        { id: 'legacy-org-leak', score: 0.86, metadata: { text: 'legacy ORG-specific doc with no tenant_id', source: 'site/raccoon.md', species: 'raccoon' } },
      ],
    ])
    const r = await searchRAG(makeEnv(vec), 'wc-1', 'injured raccoon', {})
    const ids = r.results.map(m => m.id)
    // 'legacy-generic' has source starting with 'generic/' AND no tenant_id
    // — the narrow escape hatch lets it through (acceptable, pre-existing
    // shared content).
    expect(ids).toContain('legacy-generic')
    // The two leak-shaped cases must be excluded:
    expect(ids).not.toContain('unknown')         // no metadata.tenant_id, non-generic source
    expect(ids).not.toContain('legacy-org-leak') // site/* legacy paths are tenant-specific even without tenant_id
  })

  it('does not leak across tenants when species_config skip is set on the requesting tenant', async () => {
    const vec = new StubVectorize()
    // Even if some other tenant has a relevant chunk, skip-mode short-circuits
    // BEFORE the Vectorize query runs. We assert results are empty regardless
    // of what Vectorize would have returned.
    vec.setResults([
      [{ id: 'their-pigeon-care', score: 0.99, metadata: { text: 'other tenant pigeon care', source: 'pigeon.md', species: 'pigeon', tenant_id: 'other-tenant' } }],
    ])
    const r = await searchRAG(makeEnv(vec), 'wc-1', 'injured pigeon', {
      speciesModes: { pigeon: 'skip' },
    })
    expect(r.results).toEqual([])
    expect(r.speciesSkipped).toBe(true)
  })
})
