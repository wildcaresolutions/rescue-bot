import type { Env } from './types'

// ── Constants ─────────────────────────────────────────────────────────────────

const RAG_THRESHOLD = 0.45
const RAG_TOP_K = 8
const RAG_MIN_RESULTS = 2

// ── Species detection ─────────────────────────────────────────────────────────

const SPECIES_PATTERNS: Array<[RegExp, string]> = [
  [/\b(raccoon|coon)\b/i, 'raccoon'],
  [/\b(bat|bats)\b/i, 'bat'],
  [/\b(hummingbird|humming bird|hummer)\b/i, 'hummingbird'],
  [/\b(snake|rattlesnake|garter|gopher snake|king snake)\b/i, 'snake'],
  [/\b(heron|egret|wading bird)\b/i, 'heron_egret'],
  [/\b(hawk|owl|falcon|eagle|vulture|raptor|kestrel|osprey)\b/i, 'raptor'],
  [/\b(squirrel)\b/i, 'squirrel'],
  [/\b(opossum|possum)\b/i, 'opossum'],
  [/\b(deer|fawn)\b/i, 'deer'],
  [/\b(duck|goose|geese|duckling|gosling|mallard)\b/i, 'duck_goose'],
  [/\b(fox)\b/i, 'fox'],
  [/\b(skunk)\b/i, 'skunk'],
  [/\b(coyote)\b/i, 'coyote'],
  [/\b(bobcat)\b/i, 'bobcat'],
  [/\b(gull|seagull)\b/i, 'gull'],
  [/\b(raven)\b/i, 'raven'],
  [/\b(mouse|mice|rat|rodent|gopher|chipmunk)\b/i, 'rodent'],
  // Pigeon and dove are split out from songbird because most rehabs
  // explicitly DO NOT handle them (they're feral / non-native), but they
  // share enough vocabulary with songbirds that the previous lumped pattern
  // made it impossible to skip pigeons without skipping all songbirds. Order
  // matters: this must run before the songbird pattern so "rock pigeon"
  // matches here, not as a songbird.
  [/\b(pigeon|rock dove|mourning dove|dove|columbid)\b/i, 'pigeon'],
  [/\b(songbird|robin|sparrow|finch|jay|crow|starling|swallow|wren|warbler|blackbird|chickadee|junco|mockingbird|woodpecker|flicker|nuthatch|phoebe|thrush|towhee|goldfinch|waxwing|bushtit|creeper|kinglet|lark|titmouse|swift|poorwill)\b/i, 'songbird'],
]

export function detectSpecies(message: string): string | null {
  for (const [pattern, species] of SPECIES_PATTERNS) {
    if (pattern.test(message)) return species
  }
  return null
}

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
  // Catalog → canonical token. Mirrors the detection patterns above plus the
  // operator-facing label set used by the admin Playbook UI.
  const map: Record<string, string> = {
    'heron egret': 'heron_egret', 'heron': 'heron_egret', 'egret': 'heron_egret',
    'duck goose': 'duck_goose', 'duck': 'duck_goose', 'goose': 'duck_goose',
    'deer fawn': 'deer', 'deer': 'deer', 'fawn': 'deer',
    'pigeon dove': 'pigeon', 'pigeon': 'pigeon', 'dove': 'pigeon',
    'entangled animal': 'entangled', 'entangled': 'entangled',
  }
  if (map[s]) return map[s]
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

  // Legacy fallback: pre-multi-tenant generic vectors have no tenant_id
  // metadata, so the scoped query returns zero. Retry unfiltered, but only
  // accept rows that are explicitly shared/tenant-owned or legacy generic
  // docs. Legacy site/* rows are org-specific and must not cross tenants.
  if (totalMatches === 0) {
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
