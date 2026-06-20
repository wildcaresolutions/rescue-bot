import type { Env } from './types'
import { SPECIES_CATALOG } from './species-catalog'
import { logWarn } from './logger'

// ── Constants ─────────────────────────────────────────────────────────────────

const RAG_THRESHOLD = 0.45
const RAG_TOP_K = 8
const RAG_MIN_RESULTS = 2

// ── Species detection ─────────────────────────────────────────────────────────

// Detection patterns derived from the catalog. Catalog order is display order
// (Heron, Bat, Bobcat, ...) — and that ordering already satisfies the one
// behavioral constraint: Pigeon (index 10) must come before Songbird (index
// 17), so "I see a pigeon and a sparrow" resolves to pigeon, not songbird.
// Entries with detect: null (e.g. Entangled Animal) are filename-only and
// excluded from free-text detection.
const SPECIES_PATTERNS: Array<[RegExp, string]> = SPECIES_CATALOG
  .filter((s): s is typeof s & { detect: string } => s.detect !== null)
  .map(s => [new RegExp(`\\b(${s.detect})\\b`, 'i'), s.token] as [RegExp, string])

export function detectSpecies(message: string): string | null {
  for (const [pattern, species] of SPECIES_PATTERNS) {
    if (pattern.test(message)) return species
  }
  return null
}

// Alias map derived from the catalog: every normalize_aliases entry plus the
// species's own display name (whitespace-normalized) routes to its token. This
// lets operator-typed variants ("Pigeon/Dove", "Pigeon-Dove", "Wild Turkey")
// all resolve to the same token detection emits.
const NORMALIZE_MAP: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const sp of SPECIES_CATALOG) {
    const normalizedName = sp.name.toLowerCase().replace(/[\s/_&-]+/g, ' ').trim()
    m[normalizedName] = sp.token
    for (const alias of sp.normalize_aliases) {
      m[alias.toLowerCase().replace(/[\s/_&-]+/g, ' ').trim()] = sp.token
    }
  }
  return m
})()

/**
 * Normalize a user-facing species name (e.g. "Pigeon", "Heron & Egret") to
 * the canonical lowercase token used by detection + chunk metadata. The
 * copilot's update_species_config writes Title-case names; RAG indexes use
 * lowercase. Without this, "species_config['Pigeon']: skip" never matches
 * detected `pigeon`.
 */
export function normalizeSpeciesKey(displayName: string): string {
  // Normalize to a single comparable shape: lowercase, separators all become
  // spaces. Catches "Pigeon & Dove", "Pigeon/Dove", "pigeon-dove",
  // "Pigeon  Dove" all the same.
  const s = displayName.trim().toLowerCase().replace(/[\s/_&-]+/g, ' ').trim()
  if (NORMALIZE_MAP[s]) return NORMALIZE_MAP[s]
  // Anything else — collapse whitespace to underscores so multi-word custom
  // species ("Snowy Plover") become a deterministic token ("snowy_plover").
  return s.replace(/\s+/g, '_')
}

/**
 * Build the lowercase species → mode lookup the chat path uses to decide
 * whether to drop RAG context (skip / override) for a detected species.
 * Accepts the raw species_config object pulled from tenant.org_config.
 */
export function buildSpeciesModeMap(
  speciesConfig: Record<string, { mode?: string }> | null | undefined,
): Record<string, 'builtin' | 'augment' | 'override' | 'skip'> {
  const out: Record<string, 'builtin' | 'augment' | 'override' | 'skip'> = {}
  if (!speciesConfig) return out
  for (const [key, val] of Object.entries(speciesConfig)) {
    const mode = val?.mode
    if (mode === 'builtin' || mode === 'augment' || mode === 'override' || mode === 'skip') {
      out[normalizeSpeciesKey(key)] = mode
    }
  }
  return out
}

// ── Query expansion ───────────────────────────────────────────────────────────

const QUERY_SYNONYMS: Record<string, string[]> = {
  'baby':       ['neonate', 'juvenile', 'nestling', 'hatchling', 'fledgling'],
  'little':     ['baby', 'neonate', 'juvenile', 'small', 'tiny'],
  'hurt':       ['injured', 'rescue', 'wound', 'bleeding'],
  'sick':       ['ill', 'lethargic', 'weak', 'mange', 'disease'],
  'stuck':      ['trapped', 'entangled', 'tangled', 'caught'],
  'big':        ['adult', 'subadult', 'large'],
  'dead':       ['deceased', 'road-killed', 'not moving'],
  'no feathers': ['hatchling', 'nestling', 'naked', 'pink'],
  'fuzzy':      ['downy', 'nestling', 'pin-feathers'],
  'bitten':     ['bite', 'exposure', 'rabies', 'scratched'],
  'hit window': ['window strike', 'collision', 'stunned'],
  'losing fur': ['mange', 'hair loss', 'bald'],
  'long legs':  ['heron', 'egret', 'wading bird'],
  'long beak':  ['heron', 'egret', 'wading bird'],
}

export function expandQuery(message: string): string {
  const lower = message.toLowerCase()
  const extras: string[] = []
  for (const [term, synonyms] of Object.entries(QUERY_SYNONYMS)) {
    if (lower.includes(term)) {
      for (const s of synonyms) {
        if (!lower.includes(s.toLowerCase())) extras.push(s)
      }
    }
  }
  return extras.length ? message + ' ' + extras.join(' ') : message
}

// ── Deduplication ─────────────────────────────────────────────────────────────

export interface RagResult { id: string; score: number; text: string; source: string }

export function deduplicateSimilar(items: RagResult[]): RagResult[] {
  const result: RagResult[] = []
  for (const item of items) {
    const isDup = result.some(existing => {
      if (existing.source !== item.source) return false
      const wordsA = new Set(existing.text.toLowerCase().split(/\s+/))
      const wordsB = new Set(item.text.toLowerCase().split(/\s+/))
      const intersection = [...wordsA].filter(w => wordsB.has(w)).length
      const union = new Set([...wordsA, ...wordsB]).size
      return union > 0 && intersection / union > 0.7
    })
    if (!isDup) result.push(item)
  }
  return result
}

// ── Full RAG pipeline ─────────────────────────────────────────────────────────

export interface SearchRAGOptions {
  topK?: number
  threshold?: number
  /**
   * Lowercase species → mode lookup from tenant.org_config.species_config
   * (build with buildSpeciesModeMap). When the detected species has mode
   * 'skip' or 'override', we DROP the shared/builtin RAG chunks for that
   * species so the operator's redirect / override text isn't drowned out
   * by built-in care content that contradicts it.
   */
  speciesModes?: Record<string, 'builtin' | 'augment' | 'override' | 'skip'>
}

export interface SearchRAGResult {
  query: string
  expandedQuery: string
  detectedSpecies: string | null
  /** True when the detected species is configured `skip` for this tenant. */
  speciesSkipped: boolean
  /** True when the detected species is configured `override` for this tenant. */
  speciesOverridden: boolean
  results: RagResult[]
}

export async function searchRAG(
  env: Env,
  tenantId: string,
  query: string,
  options?: SearchRAGOptions,
): Promise<SearchRAGResult> {
  const topK = options?.topK ?? RAG_TOP_K
  const threshold = options?.threshold ?? RAG_THRESHOLD
  const modes = options?.speciesModes ?? {}

  const species = detectSpecies(query)
  const speciesMode = species ? modes[species] : undefined
  const speciesSkipped = speciesMode === 'skip'
  const speciesOverridden = speciesMode === 'override'

  // Skip mode: don't query RAG at all. Returning context for a species the
  // tenant doesn't handle just gives the LLM enough rope to provide care
  // instructions despite the redirect rule. The chat handler also injects
  // a hard-redirect block into the system prompt when this flag is set.
  if (speciesSkipped) {
    return {
      query,
      expandedQuery: query,
      detectedSpecies: species,
      speciesSkipped: true,
      speciesOverridden: false,
      results: [],
    }
  }

  const expandedQuery = expandQuery(query)

  const embedPromises: Array<Promise<{ data: number[][] }>> = [
    env.AI.run('@cf/baai/bge-base-en-v1.5', { text: query }) as Promise<{ data: number[][] }>,
  ]
  const hasExpansion = expandedQuery !== query
  if (hasExpansion) {
    embedPromises.push(
      env.AI.run('@cf/baai/bge-base-en-v1.5', { text: expandedQuery }) as Promise<{ data: number[][] }>,
    )
  }
  const embedResults = await Promise.all(embedPromises)
  const origVec = embedResults[0].data[0]
  const expandVec = hasExpansion ? embedResults[1].data[0] : null

  // Tenant-scoped: shared docs + this tenant's docs only. The post-filter
  // below is intentionally duplicated so any legacy vectors missing
  // tenant_id metadata cannot leak tenant-specific site docs through an
  // unfiltered fallback query.
  const tenantFilter = { tenant_id: { $in: ['shared', tenantId] } }

  const vecQueries: Array<Promise<VectorizeMatches>> = [
    env.VECTORIZE.query(origVec, { topK, returnMetadata: 'all', filter: tenantFilter }),
  ]
  if (species) {
    vecQueries.push(
      env.VECTORIZE.query(origVec, {
        topK,
        returnMetadata: 'all',
        filter: { ...tenantFilter, species: { $eq: species } },
      }),
    )
  }
  if (expandVec) {
    vecQueries.push(
      env.VECTORIZE.query(expandVec, { topK, returnMetadata: 'all', filter: tenantFilter }),
    )
  }

  let vecResults = await Promise.all(vecQueries)
  let totalMatches = vecResults.reduce((sum, r) => sum + r.matches.length, 0)
  let usedFallback = false

  // ⚠️ SECURITY — Fail-open legacy fallback. Risk: if the post-filter
  // predicate below is ever broken by a refactor, cross-tenant RAG chunks
  // could be returned to the wrong tenant. The correct long-term fix is to
  // RE-INDEX all legacy vectors with `tenant_id` metadata so the scoped
  // query finds them without this unfiltered fallback path.
  //
  // Until re-indexing is done, we keep the fallback but instrument it:
  // any chunk that would be DROPPED because its metaTenant is neither
  // 'shared' nor the current tenantId (i.e. a real cross-tenant leak)
  // emits a logWarn so the failure is loud rather than silent.
  //
  // DO NOT REMOVE this block without first confirming all production
  // Vectorize vectors carry tenant_id metadata (run:
  //   node workers/scripts/audit-vector-metadata.js
  // — or check that the scoped query above returns > 0 for all active
  // tenants after a full re-index).
  if (totalMatches === 0) {
    usedFallback = true
    const fallbackQueries: Array<Promise<VectorizeMatches>> = [
      env.VECTORIZE.query(origVec, { topK, returnMetadata: 'all' }),
    ]
    if (species) {
      fallbackQueries.push(
        env.VECTORIZE.query(origVec, {
          topK, returnMetadata: 'all',
          filter: { species: { $eq: species } },
        }),
      )
    }
    if (expandVec) {
      fallbackQueries.push(
        env.VECTORIZE.query(expandVec, { topK, returnMetadata: 'all' }),
      )
    }
    vecResults = await Promise.all(fallbackQueries)
  }

  const seen = new Set<string>()
  const merged: RagResult[] = []
  for (const { matches } of vecResults) {
    for (const m of matches) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      const meta = m.metadata as Record<string, string> | undefined
      if (!meta?.text) continue
      const metaTenant = meta.tenant_id
      const isLegacySharedGeneric = !metaTenant && meta.source?.startsWith('generic/')
      if (metaTenant !== 'shared' && metaTenant !== tenantId && !isLegacySharedGeneric) {
        // If we're in the unfiltered fallback path and dropping a chunk whose
        // tenant doesn't match, emit a warning so a broken filter predicate
        // is detected immediately rather than silently discarding data.
        if (usedFallback) {
          logWarn('rag/fallback-cross-tenant-drop', {
            tenant_id: tenantId,
            dropped_tenant: metaTenant ?? null,
            source: meta.source ?? null,
          })
        }
        continue
      }
      // Override mode: keep the operator's tenant-scoped chunks for this
      // species but drop the shared/builtin ones, so the operator's protocol
      // wins instead of competing with the built-in care steps in-context.
      if (speciesOverridden && meta.species === species && meta.tenant_id === 'shared') {
        continue
      }
      merged.push({ id: m.id, score: m.score ?? 0, text: meta.text, source: meta.source ?? '' })
    }
  }

  merged.sort((a, b) => b.score - a.score)
  const filtered = merged.filter((m, i) => m.score >= threshold || i < RAG_MIN_RESULTS)
  const deduped = deduplicateSimilar(filtered)

  return {
    query,
    expandedQuery,
    detectedSpecies: species,
    speciesSkipped: false,
    speciesOverridden,
    results: deduped,
  }
}
