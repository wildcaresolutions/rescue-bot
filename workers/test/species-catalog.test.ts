import { describe, it, expect } from 'vitest'
import {
  SPECIES_CATALOG,
  BUILTIN_SPECIES_NAMES,
  speciesByName,
  speciesByToken,
} from '../src/lib/species-catalog'
import { detectSpecies, normalizeSpeciesKey } from '../src/lib/rag'

// Why this file exists: the catalog at shared/species-catalog.json is the
// single source of truth for builtin species across the worker, the build
// scripts, AND the Vite web UI. Latent drift between these three is what
// caused the post-#59 hotfix #60. These tests fail fast if a future edit
// breaks the catalog's invariants OR causes the derived consumers
// (SPECIES_PATTERNS, normalizeSpeciesKey, builtin_species) to disagree
// with the catalog.

describe('species catalog — structural invariants', () => {
  it('every entry has required fields', () => {
    for (const sp of SPECIES_CATALOG) {
      expect(sp.name, `species ${JSON.stringify(sp)} missing name`).toBeTruthy()
      expect(typeof sp.name).toBe('string')
      expect(sp.token, `species ${sp.name} missing token`).toBeTruthy()
      expect(sp.token).toMatch(/^[a-z][a-z0-9_]*$/)
      // filename is nullable (Pigeon has none)
      expect(sp.filename === null || typeof sp.filename === 'string').toBe(true)
      expect(sp.category).toBeTruthy()
      // detect is nullable (Entangled Animal is filename-only)
      expect(sp.detect === null || typeof sp.detect === 'string').toBe(true)
      expect(Array.isArray(sp.normalize_aliases)).toBe(true)
      expect(Array.isArray(sp.onboarding_terms)).toBe(true)
    }
  })

  it('tokens are unique', () => {
    const tokens = SPECIES_CATALOG.map(s => s.token)
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  it('display names are unique', () => {
    const names = SPECIES_CATALOG.map(s => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('Pigeon is the only catalog entry without a dedicated guide file', () => {
    const noFile = SPECIES_CATALOG.filter(s => s.filename === null).map(s => s.name)
    expect(noFile).toEqual(['Pigeon'])
  })

  it('Pigeon comes before Songbird (detection precedence)', () => {
    // SPECIES_PATTERNS is derived from catalog order; the test in
    // rag-species.test.ts asserts behaviorally that "I see a pigeon and a
    // sparrow" → pigeon. Belt-and-suspenders: assert the ordering directly.
    const pigeonIdx = SPECIES_CATALOG.findIndex(s => s.token === 'pigeon')
    const songbirdIdx = SPECIES_CATALOG.findIndex(s => s.token === 'songbird')
    expect(pigeonIdx).toBeGreaterThanOrEqual(0)
    expect(songbirdIdx).toBeGreaterThanOrEqual(0)
    expect(pigeonIdx).toBeLessThan(songbirdIdx)
  })
})

describe('species catalog — derived consumer invariants', () => {
  it('BUILTIN_SPECIES_NAMES matches catalog order exactly', () => {
    expect([...BUILTIN_SPECIES_NAMES]).toEqual(SPECIES_CATALOG.map(s => s.name))
  })

  it('speciesByName covers every entry', () => {
    expect(speciesByName.size).toBe(SPECIES_CATALOG.length)
    for (const sp of SPECIES_CATALOG) {
      expect(speciesByName.get(sp.name)?.token).toBe(sp.token)
    }
  })

  it('speciesByToken covers every entry', () => {
    expect(speciesByToken.size).toBe(SPECIES_CATALOG.length)
    for (const sp of SPECIES_CATALOG) {
      expect(speciesByToken.get(sp.token)?.name).toBe(sp.name)
    }
  })

  it('every species name normalizes to its own token', () => {
    // The wildcare-key-routing failure mode: if normalizeSpeciesKey doesn't
    // map a display name to its detection token, species_config[name] = skip
    // silently breaks at chat time. Catch any future drift.
    for (const sp of SPECIES_CATALOG) {
      expect(normalizeSpeciesKey(sp.name)).toBe(sp.token)
    }
  })

  it('every normalize_alias maps to its species token', () => {
    for (const sp of SPECIES_CATALOG) {
      for (const alias of sp.normalize_aliases) {
        expect(normalizeSpeciesKey(alias)).toBe(sp.token)
      }
    }
  })

  it('every species with a detect pattern detects its own name', () => {
    for (const sp of SPECIES_CATALOG) {
      if (!sp.detect) continue
      // Use a representative term from the detect alternation
      const firstTerm = sp.detect.split('|')[0]
      const sentence = `there is a ${firstTerm} in my yard`
      expect(detectSpecies(sentence), `${sp.name} detection`).toBe(sp.token)
    }
  })
})
