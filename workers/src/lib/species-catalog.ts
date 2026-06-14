/**
 * Typed wrapper around the shared species catalog.
 *
 * The catalog itself lives at shared/species-catalog.json so the same source of
 * truth feeds both the worker (this module) and the Vite-built web UI
 * (web/src/admin imports the JSON directly). The Node build scripts in
 * workers/scripts/ read the same JSON via fs.readFileSync — they can't import
 * TypeScript without a transpile step.
 *
 * Per-tenant custom species are NOT in this file — they live in
 * org_config.custom_species and bypass the catalog entirely.
 */
import catalogJson from '../../../shared/species-catalog.json'

export interface SpeciesEntry {
  /** Title-Case display name shown in admin UI and used as the org_config key. */
  name: string
  /** Lowercase canonical token used in Vectorize chunk metadata and RAG filters. */
  token: string
  /** Resource filename in resources/, or null if no dedicated guide exists. */
  filename: string | null
  /**
   * Override for the bundled guide's display name in the admin Knowledge Base.
   * Optional — gen-guides.js falls back to `${name} Rescue and Care`. Used for
   * the two oddballs whose canonical title isn't "{Species} Rescue and Care"
   * ("Snake Identification and Rescue", "Entangled Animal Rescue").
   */
  guide_display_name?: string
  /** Coarse taxonomy for UI grouping (mammal / waterbird / songbird / raptor / reptile / gamebird / general). */
  category: string
  /**
   * Regex source (pipe-separated alternation) matched against user input by
   * rag.ts detectSpecies. Null for species the bot doesn't try to identify
   * from free text (e.g. "Entangled Animal" is filename-only).
   */
  detect: string | null
  /**
   * Display-form aliases that should all normalize to this entry's `token`.
   * Catches operator-typed variants like "Pigeon/Dove" → pigeon. The species
   * `name` itself is implicitly an alias and doesn't need to be repeated here.
   */
  normalize_aliases: string[]
  /**
   * Free-text terms used by the onboarding flow to map operator answers
   * ("we handle hawks and owls") to a canonical entry. Looser than `detect`
   * — purely lexical, no regex.
   */
  onboarding_terms: string[]
}

interface CatalogShape {
  species: SpeciesEntry[]
}

const catalog = catalogJson as CatalogShape

export const SPECIES_CATALOG: readonly SpeciesEntry[] = Object.freeze(catalog.species)

/** Display names in catalog order — feeds builtin_species in the admin copilot. */
export const BUILTIN_SPECIES_NAMES: readonly string[] = Object.freeze(
  SPECIES_CATALOG.map(s => s.name),
)

/** name → entry (case-sensitive on the display name, which is the org_config key). */
export const speciesByName: ReadonlyMap<string, SpeciesEntry> = new Map(
  SPECIES_CATALOG.map(s => [s.name, s]),
)

/** token → entry. */
export const speciesByToken: ReadonlyMap<string, SpeciesEntry> = new Map(
  SPECIES_CATALOG.map(s => [s.token, s]),
)
