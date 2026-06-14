/**
 * Species tools — get / update species_config + custom species.
 *
 * Under draft/publish these STAGE org_config changes into the tenant draft
 * (lib/draft.ts) and read from the live+draft overlay — they no longer write
 * live columns or recompile (publish does both).
 *
 * - get_species_config: returns species_config (incl. staged), custom_species, etc.
 * - update_species_config / add_custom_species / bulk_skip_other_species: stage.
 */
import { tool } from 'ai'
import { z } from 'zod'
import { BUILTIN_GUIDES } from '../../guides'
import type { ToolContext } from './types'
import { parseOrgConfig, loadTenantById } from '../tenant-loader'
import { stageConfigChange, overlayTenant } from '../draft'
import { BUILTIN_SPECIES_NAMES } from '../species-catalog'

export function speciesTools(ctx: ToolContext) {
  const { db, tenantId, freshTenant } = ctx
  const target = { id: tenantId, slug: freshTenant.slug }
  const overlayOrg = async () => parseOrgConfig(overlayTenant((await loadTenantById(db, tenantId)) ?? freshTenant).org_config)

  const get_species_config = tool({
    description: 'Get the current species configuration (including unpublished/staged edits): which species are handled, skipped, augmented, or overridden, plus any custom species.',
    inputSchema: z.object({}),
    execute: async () => {
      const oc = await overlayOrg()
      return {
        species_config: oc.species_config || {},
        custom_species: (oc.custom_species || []).map((s: { name: string }) => s.name),
        // Catalog includes "Pigeon" even though there's no dedicated builtin
        // guide — most rehabs explicitly DON'T handle pigeons/doves and need
        // to be able to set species_config["Pigeon"] = skip with a redirect
        // destination. Catalog entry has filename: null for that case.
        builtin_species: [...BUILTIN_SPECIES_NAMES],
        triage_config: oc.triage_config || [],
      }
    },
  })

  const add_custom_species = tool({
    description: 'Add a custom species (not in the 19 built-in guides) with a full rescue protocol. Staged as a draft until the operator publishes.',
    inputSchema: z.object({
      name: z.string().describe('Species name (e.g., Pelican, Turkey, Turtle)'),
      protocol: z.string().describe('Full rescue and care protocol for this species'),
    }),
    execute: async ({ name, protocol }) => {
      const existing = await overlayOrg()
      const customs = existing.custom_species || []
      if (customs.some((c: { name: string }) => c.name.toLowerCase() === name.toLowerCase())) {
        return { success: false, error: `Species "${name}" already exists` }
      }
      customs.push({ name, protocol })
      existing.custom_species = customs
      await stageConfigChange(db, target, { org_config: existing })
      return { success: true, species: name, message: `Added "${name}" with protocol (staged). It will appear in the Playbook.` }
    },
  })

  const update_species_config = tool({
    description: 'Change how a built-in species guide is used: "builtin", "augment", "override", or "skip" (redirect). Staged as a draft until the operator publishes.',
    inputSchema: z.object({
      species: z.string().describe('Species name (must match a built-in guide, e.g., "Bat", "Raccoon", "Raptor")'),
      mode: z.enum(['builtin', 'augment', 'override', 'skip']),
      notes: z.string().optional().describe('Additional notes (for augment) or full replacement protocol (for override)'),
      redirect: z.string().optional().describe('Where to redirect callers (for skip mode)'),
    }),
    execute: async ({ species, mode, notes, redirect }) => {
      const existing = await overlayOrg()
      const sc = existing.species_config || {}
      if (mode === 'builtin') delete sc[species]
      else sc[species] = { mode, notes: notes || '', redirect: redirect || '' }
      existing.species_config = sc
      await stageConfigChange(db, target, { org_config: existing })
      return { success: true, species, mode, message: `${species}: set to "${mode}"${notes ? ' with notes' : ''} (staged)` }
    },
  })

  const bulk_skip_other_species = tool({
    description: 'Mark every built-in species OTHER than the listed ones as "skip" with a single redirect. Use when the user says "we only handle X". Atomic. Staged as a draft until the operator publishes.',
    inputSchema: z.object({
      keep_species: z.array(z.string()).describe('Species names to leave alone (e.g. ["Raptor"]). Anything not in this list becomes skip.'),
      redirect: z.string().describe('Where to redirect callers for the skipped species'),
      notes: z.string().optional().describe('Optional notes saved on each skipped species'),
    }),
    execute: async ({ keep_species, redirect, notes }) => {
      const keep = new Set(keep_species.map(s => s.toLowerCase().trim()))
      const existing = await overlayOrg()
      const sc = existing.species_config || {}
      const skipped: string[] = []
      const kept: string[] = []
      for (const guide of BUILTIN_GUIDES as Array<{ name: string }>) {
        if (keep.has(guide.name.toLowerCase())) { delete sc[guide.name]; kept.push(guide.name) }
        else { sc[guide.name] = { mode: 'skip', notes: notes || '', redirect }; skipped.push(guide.name) }
      }
      existing.species_config = sc
      await stageConfigChange(db, target, { org_config: existing })
      return {
        success: true, kept, skipped, skipped_count: skipped.length, redirect,
        message: `Kept builtin: ${kept.join(', ') || '(none)'}. Skip with redirect: ${skipped.join(', ')} (staged).`,
      }
    },
  })

  return { get_species_config, add_custom_species, update_species_config, bulk_skip_other_species }
}
