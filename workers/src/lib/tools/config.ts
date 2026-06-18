/**
 * Config tools — tenant settings, brand colors, widget theme/CSS.
 *
 * Under the global draft/publish model these tools STAGE their changes into
 * the tenant's draft (lib/draft.ts) — they no longer write live columns or
 * recompile (publish does both). They read from the OVERLAID tenant (live +
 * draft) so the agent builds on its own pending edits within a turn.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { ToolContext } from './types'
import type { OrgConfig, Referral } from '../compile-instruction'
import { sanitizeCustomCss } from '../css-sanitize'
import { parseOrgConfig, loadTenantById } from '../tenant-loader'
import { stageConfigChange, overlayTenant, type DraftConfig } from '../draft'

export function configTools(ctx: ToolContext) {
  const { db, tenantId, freshTenant } = ctx
  const target = { id: tenantId, slug: freshTenant.slug }
  // Re-read live+draft each execute so a tool sees prior staged edits in this turn.
  const overlay = async () => overlayTenant((await loadTenantById(db, tenantId)) ?? freshTenant)

  const update_config = tool({
    description: 'Updates tenant configuration fields like phone, email, url, location. Staged as a draft until the operator publishes.',
    inputSchema: z.object({
      phone: z.string().optional().describe('Phone number'),
      email: z.string().optional().describe('Email address'),
      url: z.string().optional().describe('Website URL'),
      location_county: z.string().optional().describe('County'),
      location_state: z.string().optional().describe('State'),
      location_service_area: z.string().optional().describe('Service area description'),
    }),
    execute: async (params) => {
      const patch: DraftConfig = {}
      const applied: Record<string, string> = {}
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === 'string') { (patch as Record<string, unknown>)[k] = v; applied[k] = v }
      }
      if (!Object.keys(patch).length) return { success: true, message: 'No changes' }
      await stageConfigChange(db, target, patch)
      return { success: true, message: 'Configuration updated (staged)', updated: Object.keys(applied), ...applied }
    },
  })

  const update_org_info = tool({
    description: 'Update operational org info (hours, after-hours phone, emergency contacts, redirect-info default). All optional. Staged as a draft until the operator publishes.',
    inputSchema: z.object({
      hours: z.string().optional().describe('Operating hours, e.g. "Mon-Fri 9am-5pm; Sat-Sun 10am-4pm"'),
      after_hours_phone: z.string().optional().describe('Number callers should reach for emergencies outside hours'),
      emergency_contacts: z.string().optional().describe('Free-form contact list for non-rehab emergencies (e.g. local animal control, after-hours vet)'),
      redirect_info: z.string().optional().describe('Default redirect destination used when a skipped species has no per-species redirect set'),
    }),
    execute: async (params) => {
      const oc = parseOrgConfig<Record<string, unknown>>((await overlay()).org_config)
      const updated: string[] = []
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === 'string') { oc[k] = v; updated.push(k) }
      }
      if (!updated.length) return { success: true, message: 'No changes' }
      await stageConfigChange(db, target, { org_config: oc as unknown as OrgConfig })
      return { success: true, updated, message: `Saved (staged): ${updated.join(', ')}` }
    },
  })

  // Referrals live in org_config.referrals[] — the structured list of
  // organizations the bot routes callers to, tagged by species (`covers`)
  // and/or area (`area`). compile-instruction.ts renders them into the
  // LLM prompt under "## Referrals & Emergency Contacts". Without a tool
  // here, the copilot used to claim "I have no referrals concept" and
  // bury routing rules in house_rules narrative — losing the by-area
  // routing the structured field is designed for.
  const manage_referrals = tool({
    description: 'Add, update, or remove a referral organization in the structured referrals list. Referrals are how the bot routes callers it can\'t help — by SPECIES (the "covers" tag, e.g. "raptors") or by AREA (the "area" tag, e.g. "Contra Costa County" for out-of-service-area callers). Adding a referral with an area tag automatically routes callers from that area to that org. Name is used as the key for update/remove (case-insensitive). Recompiles the system prompt after each change.',
    inputSchema: z.object({
      action: z.enum(['add', 'update', 'remove']).describe('"add" creates a new referral. "update" modifies the named referral (only fields you pass are changed). "remove" deletes it.'),
      name: z.string().describe('Referral organization name, e.g. "Lindsay Wildlife Experience". Used as the key for update/remove.'),
      contact: z.string().optional().describe('Phone and/or URL, e.g. "(925) 935-1978 · lindsaywildlife.org"'),
      covers: z.string().optional().describe('What they handle, e.g. "general wildlife", "raptors and bats", "wild turkeys, mange coyotes"'),
      area: z.string().optional().describe('Geographic coverage, e.g. "Contra Costa County" — used to route out-of-area callers to them automatically'),
    }),
    execute: async ({ action, name, contact, covers, area }) => {
      // Read live+draft so we build on any referrals staged earlier this turn.
      const t = await overlay()
      const oc = parseOrgConfig<OrgConfig & Record<string, unknown>>(t.org_config)
      const referrals: Referral[] = Array.isArray(oc.referrals) ? [...oc.referrals] : []
      const trimmedName = name.trim()
      const nameKey = trimmedName.toLowerCase()
      const idx = referrals.findIndex(r => r?.name?.trim().toLowerCase() === nameKey)

      if (action === 'add') {
        if (idx >= 0) {
          return { success: false, error: 'duplicate', message: `Referral "${trimmedName}" already exists. Use action="update" to change it, or action="remove" first.` }
        }
        const entry: Referral = { name: trimmedName }
        if (contact !== undefined) entry.contact = contact
        if (covers !== undefined) entry.covers = covers
        if (area !== undefined) entry.area = area
        referrals.push(entry)
      } else if (action === 'update') {
        if (idx < 0) {
          return { success: false, error: 'not_found', message: `Referral "${trimmedName}" not found. Use action="add" to create it.` }
        }
        const current = referrals[idx]
        const updated: Referral = { ...current, name: trimmedName }
        if (contact !== undefined) updated.contact = contact
        if (covers !== undefined) updated.covers = covers
        if (area !== undefined) updated.area = area
        referrals[idx] = updated
      } else {
        if (idx < 0) {
          return { success: false, error: 'not_found', message: `Referral "${trimmedName}" not found.` }
        }
        referrals.splice(idx, 1)
      }

      oc.referrals = referrals
      // Stage into the draft (recompile/cache handled at publish + by stageConfigChange).
      await stageConfigChange(db, target, { org_config: oc })
      return {
        success: true,
        action,
        name: trimmedName,
        referrals_count: referrals.length,
        message: `${action === 'add' ? 'Added' : action === 'update' ? 'Updated' : 'Removed'} referral: ${trimmedName}`,
      }
    },
  })

  const update_colors = tool({
    description: 'Updates brand colors for the rescue bot. Staged as a draft until the operator publishes.',
    inputSchema: z.object({
      color_primary: z.string().optional().describe('Primary brand color (hex, e.g. #2d7a3c)'),
      color_secondary: z.string().optional().describe('Secondary brand color (hex)'),
      color_accent: z.string().optional().describe('Accent color (hex)'),
    }),
    execute: async (params) => {
      // Refuse to leave two roles with the same hex — compute the effective
      // palette by merging args over the current (overlaid) values.
      const cur = await overlay()
      const norm = (h: string | null | undefined) => h?.toLowerCase().trim() || null
      const eff = {
        color_primary: norm(params.color_primary ?? cur.color_primary),
        color_secondary: norm(params.color_secondary ?? cur.color_secondary),
        color_accent: norm(params.color_accent ?? cur.color_accent),
      }
      const present = [eff.color_primary, eff.color_secondary, eff.color_accent].filter(Boolean)
      if (new Set(present).size !== present.length) {
        return {
          success: false, error: 'role_collision',
          message: `Refusing to apply: ${eff.color_primary} / ${eff.color_secondary} / ${eff.color_accent} would leave two roles with the same color. Confirm which role each hex belongs to before re-calling.`,
          effective: eff,
        }
      }
      const patch: DraftConfig = {}
      for (const [k, v] of Object.entries(params)) if (typeof v === 'string') (patch as Record<string, unknown>)[k] = v
      if (!Object.keys(patch).length) return { success: true, message: 'No changes' }
      await stageConfigChange(db, target, patch)
      return { success: true, message: 'Colors updated (staged)', applied: eff }
    },
  })

  const get_config = tool({
    description: 'Gets the current tenant configuration (including unpublished/staged edits). This is your READ tool — call it before editing anything. It returns the FULL house_rules text, so you never need to "probe" with a write tool to see the current prompt.',
    inputSchema: z.object({}),
    execute: async () => {
      const t = await overlay()
      const oc = parseOrgConfig(t.org_config)
      return {
        name: t.name, phone: t.phone, email: t.email, url: t.url,
        location_county: t.location_county, location_state: t.location_state, location_service_area: t.location_service_area,
        color_primary: t.color_primary, color_secondary: t.color_secondary, color_accent: t.color_accent,
        hours: oc.hours || null, after_hours_phone: oc.after_hours_phone || null, emergency_contacts: oc.emergency_contacts || null,
        species_config: oc.species_config || {},
        // The operator-editable prose ("House rules"). Returned IN FULL so the
        // agent can read-modify-write it via save_protocols. (Returning a
        // truncated preview here is what drove the agent to misuse a write tool
        // as a read and clobber the prompt — 2026-06-18 incident.)
        house_rules: t.house_rules || '',
        // custom_instruction is DERIVED (compiled from species/referrals config
        // at publish). Shown read-only for context — do NOT write it directly.
        custom_instruction: t.custom_instruction || null,
      }
    },
  })

  const update_widget_theme = tool({
    description: 'Update widget appearance: colors, radii, button text, header title, welcome message, header style, and position. Typography is fixed by the design system. Staged as a draft until the operator publishes.',
    inputSchema: z.object({
      primaryColor: z.string().optional(),
      secondaryColor: z.string().optional(),
      accentColor: z.string().optional(),
      headerStyle: z.enum(['gradient', 'solid-primary', 'solid-secondary']).optional(),
      radiusButton: z.string().optional(),
      radiusPane: z.string().optional(),
      radiusBubble: z.string().optional(),
      buttonText: z.string().optional(),
      welcomeMessage: z.string().optional(),
      headerText: z.string().optional(),
      autoOpen: z.boolean().optional(),
      buttonPosition: z.object({ bottom: z.string().optional(), top: z.string().optional(), left: z.string().optional(), right: z.string().optional() }).nullable().optional(),
      panePosition: z.object({ bottom: z.string().optional(), top: z.string().optional(), left: z.string().optional(), right: z.string().optional() }).nullable().optional(),
    }),
    execute: async (params) => {
      const existing = parseOrgConfig<Record<string, unknown>>((await overlay()).widget_theme)
      const merged = { ...existing }
      for (const [k, v] of Object.entries(params)) if (v !== undefined) merged[k] = v
      await stageConfigChange(db, target, { widget_theme: merged })
      return { success: true, theme: merged }
    },
  })

  const update_custom_css = tool({
    description: 'Set custom CSS for the chat widget. Overwrites previous CSS. Staged as a draft until the operator publishes. Use .rbot-widget-* classes and --rbot-* custom properties.',
    inputSchema: z.object({ css: z.string().describe('The complete custom CSS to apply') }),
    execute: async ({ css }) => {
      // Sanitize before staging (audit P1-21): operator CSS is served inline to
      // every widget visitor; strip @import, expression(), url() exfil, etc.
      const sanitized = sanitizeCustomCss(css).css
      await stageConfigChange(db, target, { widget_custom_css: sanitized })
      return { success: true, css: sanitized }
    },
  })

  return {
    update_config,
    update_org_info,
    manage_referrals,
    update_colors,
    get_config,
    update_widget_theme,
    update_custom_css,
  }
}
