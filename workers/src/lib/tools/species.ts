/**
 * Species tools — get / update species_config + custom species.
 *
 * - get_species_config: returns species_config, custom_species,
 *   builtin_species list, triage_config.
 * - update_species_config: change how a built-in species is handled
 *   (builtin / augment / override / skip + redirect).
 * - add_custom_species: append a new entry to custom_species[].
 * - bulk_skip_other_species: atomic "we only handle X" — set every
 *   non-kept built-in species to skip with one redirect. Exists because
 *   agents iterating update_species_config 17 times would lose count
 *   and claim "all set" after configuring 2.
 *
 * All four mutate org_config + invalidate the cache; the three mutating
 * ones also recompile custom_instruction via recompileAndMaybeWrite so
 * the chat-time prompt reflects the new state next turn.
 *
 * Extracted from workers/src/routes/agent.ts.
 */
import { tool } from 'ai'
import { z } from 'zod'
import { BUILTIN_GUIDES } from '../../guides'
import type { ToolContext } from './types'
import { parseOrgConfig } from '../tenant-loader'
import { recompileAndMaybeWrite } from '../compile-instruction'
import { BUILTIN_SPECIES_NAMES } from '../species-catalog'

export function speciesTools(ctx: ToolContext) {
  const { db, tenantId, freshTenant, invalidateCache } = ctx

  const get_species_config = tool({
    description: 'Get the current species configuration: which species are handled, skipped, augmented, or overridden, plus any custom species.',
    inputSchema: z.object({}),
    execute: async () => {
      const oc = parseOrgConfig(freshTenant.org_config)
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
    description: 'Add a custom species (not in the 19 built-in guides) with a full rescue protocol. The species will appear in the Playbook.',
    inputSchema: z.object({
      name: z.string().describe('Species name (e.g., Pelican, Turkey, Turtle)'),
      protocol: z.string().describe('Full rescue and care protocol for this species'),
    }),
    execute: async ({ name, protocol }) => {
      const existing = parseOrgConfig(freshTenant.org_config)
      const customs = existing.custom_species || []
      // Check for duplicate
      if (customs.some((c: { name: string }) => c.name.toLowerCase() === name.toLowerCase())) {
        return { success: false, error: `Species "${name}" already exists` }
      }
      customs.push({ name, protocol })
      existing.custom_species = customs
      await db.prepare("UPDATE tenants SET org_config = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(JSON.stringify(existing), tenantId).run()
      invalidateCache()
      // Recompile custom_instruction (no-op write if locked)
      const bo = parseOrgConfig<Record<string, unknown>>(freshTenant.bot_overrides)
      await recompileAndMaybeWrite(db, freshTenant, existing, bo)
      return { success: true, species: name, message: `Added "${name}" with protocol. It will now appear in the Playbook.` }
    },
  })

  const update_species_config = tool({
    description: 'Change how a built-in species guide is used: "builtin" (use as-is), "augment" (add notes), "override" (replace), or "skip" (do not handle, redirect).',
    inputSchema: z.object({
      species: z.string().describe('Species name (must match a built-in guide, e.g., "Bat", "Raccoon", "Raptor")'),
      mode: z.enum(['builtin', 'augment', 'override', 'skip']),
      notes: z.string().optional().describe('Additional notes (for augment) or full replacement protocol (for override)'),
      redirect: z.string().optional().describe('Where to redirect callers (for skip mode)'),
    }),
    execute: async ({ species, mode, notes, redirect }) => {
      const existing = parseOrgConfig(freshTenant.org_config)
      const sc = existing.species_config || {}
      if (mode === 'builtin') {
        delete sc[species]  // Remove override, use default
      } else {
        sc[species] = { mode, notes: notes || '', redirect: redirect || '' }
      }
      existing.species_config = sc
      await db.prepare("UPDATE tenants SET org_config = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(JSON.stringify(existing), tenantId).run()
      invalidateCache()
      // Recompile (no-op write if operator has locked custom_instruction)
      const bo = parseOrgConfig<Record<string, unknown>>(freshTenant.bot_overrides)
      await recompileAndMaybeWrite(db, freshTenant, existing, bo)
      return { success: true, species, mode, message: `${species}: set to "${mode}"${notes ? ' with notes' : ''}` }
    },
  })

  // Bulk: "we only handle X" → set every other built-in species to skip
  // with the same redirect, in ONE call. The single-species tool led to
  // agents claiming "all set" after configuring 2 of 19 (because
  // enumerating 17 individual tool calls is error-prone) — then test
  // failures, then patching custom_instruction prose to compensate, then
  // more confusion. Keep this atomic.
  const bulk_skip_other_species = tool({
    description: 'Mark every built-in species OTHER than the listed ones as "skip" with a single redirect. Use when the user says "we only handle X" / "we just do raptors". Atomic — sets all 17+ non-kept species in one call. Always prefer this over enumerating update_species_config calls when the user expressed a kept-list.',
    inputSchema: z.object({
      keep_species: z.array(z.string()).describe('Species names to leave alone (e.g. ["Raptor"]). Anything not in this list becomes skip.'),
      redirect: z.string().describe('Where to redirect callers for the skipped species (e.g. "Ventura County Animal Services: 805-388-4341")'),
      notes: z.string().optional().describe('Optional notes saved on each skipped species'),
    }),
    execute: async ({ keep_species, redirect, notes }) => {
      const keep = new Set(keep_species.map(s => s.toLowerCase().trim()))
      const existing = parseOrgConfig(freshTenant.org_config)
      const sc = existing.species_config || {}
      const skipped: string[] = []
      const kept: string[] = []
      for (const guide of BUILTIN_GUIDES as Array<{ name: string }>) {
        if (keep.has(guide.name.toLowerCase())) {
          delete sc[guide.name]  // Use builtin as-is
          kept.push(guide.name)
        } else {
          sc[guide.name] = { mode: 'skip', notes: notes || '', redirect }
          skipped.push(guide.name)
        }
      }
      existing.species_config = sc
      await db.prepare("UPDATE tenants SET org_config = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(JSON.stringify(existing), tenantId).run()
      invalidateCache()
      const bo = parseOrgConfig<Record<string, unknown>>(freshTenant.bot_overrides)
      await recompileAndMaybeWrite(db, freshTenant, existing, bo)
      return {
        success: true,
        kept,
        skipped,
        skipped_count: skipped.length,
        redirect,
        message: `Kept builtin: ${kept.join(', ') || '(none)'}. Skip with redirect: ${skipped.join(', ')}.`,
      }
    },
  })

  return {
    get_species_config,
    add_custom_species,
    update_species_config,
    bulk_skip_other_species,
  }
}
