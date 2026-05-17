/**
 * Config tools — tenant settings, brand colors, widget theme/CSS.
 *
 * Extracted from workers/src/routes/agent.ts. These tools all mutate
 * the tenant row (or its widget_theme / widget_custom_css columns) and
 * follow the same pattern: validate, UPDATE tenants, invalidate the
 * in-memory tenant cache so the next chat turn sees the new state.
 *
 * `update_org_info` is special — it writes to the org_config JSON and
 * then recompiles `custom_instruction` so the chat-time system prompt
 * reflects the new info on the very next message.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { Tenant } from '../types'
import type { ToolContext } from './types'
import { sanitizeCustomCss } from '../css-sanitize'
import { parseOrgConfig, loadTenantById } from '../tenant-loader'
import { recompileAndMaybeWrite } from '../compile-instruction'

export function configTools(ctx: ToolContext) {
  const { db, tenantId, tenant, freshTenant, invalidateCache } = ctx

  const update_config = tool({
    description: 'Updates tenant configuration fields like phone, email, url, location',
    inputSchema: z.object({
      phone: z.string().optional().describe('Phone number'),
      email: z.string().optional().describe('Email address'),
      url: z.string().optional().describe('Website URL'),
      location_county: z.string().optional().describe('County'),
      location_state: z.string().optional().describe('State'),
      location_service_area: z.string().optional().describe('Service area description'),
    }),
    execute: async (params) => {
      const updates: string[] = []
      const values: (string | null)[] = []
      const entries = Object.entries(params) as Array<[string, string | undefined]>
      for (const [key, val] of entries) {
        if (val !== undefined) {
          updates.push(`${key} = ?`)
          values.push(val)
        }
      }
      if (!updates.length) return { success: true, message: 'No changes' }
      updates.push("updated_at = datetime('now')")
      await db.prepare(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`)
        .bind(...values, tenantId).run()
      invalidateCache()
      const updated = entries.filter(([, v]) => v !== undefined).map(([k]) => k)
      // Spread values into the result so the frontend's breadcrumb chip can
      // show what was saved ("Saved: phone=805-555-…", not just "Config
      // updated"). The user complained the chip was unhelpfully vague.
      const applied: Record<string, string> = {}
      for (const [k, v] of entries) if (typeof v === 'string') applied[k] = v
      return { success: true, message: 'Configuration updated', updated, ...applied }
    },
  })

  // Hours and after-hours info live in org_config JSON, not as tenant
  // columns, so update_config can't reach them. Without this tool the
  // agent would dutifully ask the user for hours during onboarding, accept
  // an answer, then have no way to persist it — leading to a silent skip
  // we observed driving step 2 of onboarding.
  const update_org_info = tool({
    description: 'Update operational org info (hours, after-hours phone, emergency contacts, redirect-info default). All optional. Saves to tenant.org_config and recompiles the system instruction so changes take effect on the next chat turn.',
    inputSchema: z.object({
      hours: z.string().optional().describe('Operating hours, e.g. "Mon-Fri 9am-5pm; Sat-Sun 10am-4pm"'),
      after_hours_phone: z.string().optional().describe('Number callers should reach for emergencies outside hours'),
      emergency_contacts: z.string().optional().describe('Free-form contact list for non-rehab emergencies (e.g. local animal control, after-hours vet)'),
      redirect_info: z.string().optional().describe('Default redirect destination used when a skipped species has no per-species redirect set'),
    }),
    execute: async (params) => {
      const oc = parseOrgConfig<Record<string, unknown>>(freshTenant.org_config)
      const updated: string[] = []
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === 'string') { oc[k] = v; updated.push(k) }
      }
      if (!updated.length) return { success: true, message: 'No changes' }
      await db.prepare("UPDATE tenants SET org_config = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(JSON.stringify(oc), tenantId).run()
      // Recompile so the chat-time system prompt reflects the new info.
      const bo = parseOrgConfig<Record<string, unknown>>(freshTenant.bot_overrides)
      await recompileAndMaybeWrite(db, freshTenant, oc, bo)
      invalidateCache()
      return { success: true, updated, message: `Saved: ${updated.join(', ')}` }
    },
  })

  const update_colors = tool({
    description: 'Updates brand colors for the rescue bot',
    inputSchema: z.object({
      color_primary: z.string().optional().describe('Primary brand color (hex, e.g. #2d7a3c)'),
      color_secondary: z.string().optional().describe('Secondary brand color (hex)'),
      color_accent: z.string().optional().describe('Accent color (hex)'),
    }),
    execute: async (params) => {
      // Compute the effective post-update palette by merging the call args
      // over the current tenant row, then check that the three roles end up
      // with three different hexes. The agent has previously set primary,
      // secondary, AND accent all to the same #c96310 without warning the
      // user; that's almost always a mistake (the user said one role-change
      // and the agent over-applied). Refuse and return guidance so the
      // agent can re-prompt.
      const current = await db.prepare(
        'SELECT color_primary, color_secondary, color_accent FROM tenants WHERE id = ?',
      ).bind(tenantId).first<{
        color_primary: string | null
        color_secondary: string | null
        color_accent: string | null
      }>()
      const norm = (h: string | null | undefined) => h?.toLowerCase().trim() || null
      const eff = {
        color_primary: norm(params.color_primary ?? current?.color_primary),
        color_secondary: norm(params.color_secondary ?? current?.color_secondary),
        color_accent: norm(params.color_accent ?? current?.color_accent),
      }
      const collisions = ['color_primary', 'color_secondary', 'color_accent']
        .map(k => ({ k, v: eff[k as keyof typeof eff] }))
        .filter(x => x.v)
      const dup = collisions.find((a, i) =>
        collisions.findIndex(b => b.v === a.v) !== i,
      )
      if (dup) {
        return {
          success: false,
          error: 'role_collision',
          message: `Refusing to apply: ${eff.color_primary} / ${eff.color_secondary} / ${eff.color_accent} would leave two roles with the same color. Confirm with the user which role each hex belongs to before re-calling.`,
          effective: eff,
        }
      }

      const updates: string[] = []
      const values: (string | null)[] = []
      const entries = Object.entries(params) as Array<[string, string | undefined]>
      for (const [key, val] of entries) {
        if (val !== undefined) {
          updates.push(`${key} = ?`)
          values.push(val)
        }
      }
      if (!updates.length) return { success: true, message: 'No changes' }
      updates.push("updated_at = datetime('now')")
      await db.prepare(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`)
        .bind(...values, tenantId).run()
      // Original used `tenant.slug` rather than `freshTenant.slug` here —
      // they refer to the same row, but preserved verbatim for zero-diff.
      void tenant
      invalidateCache()
      return { success: true, message: 'Colors updated', applied: eff }
    },
  })

  const get_config = tool({
    description: 'Gets the current tenant configuration',
    inputSchema: z.object({}),
    execute: async () => {
      const t = await loadTenantById(db, tenantId)
      if (!t) return { error: 'Tenant not found' }
      const oc = parseOrgConfig(t.org_config)
      return {
        name: t.name,
        phone: t.phone,
        email: t.email,
        url: t.url,
        location_county: t.location_county,
        location_state: t.location_state,
        location_service_area: t.location_service_area,
        color_primary: t.color_primary,
        color_secondary: t.color_secondary,
        color_accent: t.color_accent,
        hours: oc.hours || null,
        after_hours_phone: oc.after_hours_phone || null,
        emergency_contacts: oc.emergency_contacts || null,
        species_config: oc.species_config || {},
        custom_instruction_preview: t.custom_instruction ? t.custom_instruction.slice(0, 500) + '...' : null,
        has_custom_instruction: !!t.custom_instruction,
      }
    },
  })

  const update_widget_theme = tool({
    description: 'Update widget appearance: colors, radii, button text, welcome message, header style, and position. Typography is fixed by the product design system and is not configurable.',
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
      autoOpen: z.boolean().optional(),
      // Each edge is a CSS value ("25%", "20px"). Pass only the edges
      // you want to set. Pass null for the whole field to clear.
      buttonPosition: z.object({
        bottom: z.string().optional(),
        top: z.string().optional(),
        left: z.string().optional(),
        right: z.string().optional(),
      }).nullable().optional(),
      panePosition: z.object({
        bottom: z.string().optional(),
        top: z.string().optional(),
        left: z.string().optional(),
        right: z.string().optional(),
      }).nullable().optional(),
    }),
    execute: async (params) => {
      const existing = parseOrgConfig<Record<string, unknown>>(freshTenant.widget_theme)
      const merged = { ...existing }
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) merged[k] = v
      }
      await db.prepare("UPDATE tenants SET widget_theme = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(JSON.stringify(merged), tenantId).run()
      invalidateCache()
      return { success: true, theme: merged }
    },
  })

  const update_custom_css = tool({
    description: 'Set custom CSS for the chat widget. Overwrites previous CSS. Use .rbot-widget-* classes and --rbot-* custom properties.',
    inputSchema: z.object({
      css: z.string().describe('The complete custom CSS to apply'),
    }),
    execute: async ({ css }) => {
      // Audit P1-21: operator-supplied CSS is served inline to every widget
      // visitor on the tenant's site. Without sanitization a copilot prompt-
      // injection (or just a careless operator) can ship CSS with @import,
      // expression(), behavior: url(...), or javascript: URLs to every chat
      // session. sanitizeCustomCss strips those patterns and caps length.
      const sanitized = sanitizeCustomCss(css)
      await db.prepare("UPDATE tenants SET widget_custom_css = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(sanitized, tenantId).run()
      invalidateCache()
      return { success: true, css: sanitized }
    },
  })

  return {
    update_config,
    update_org_info,
    update_colors,
    get_config,
    update_widget_theme,
    update_custom_css,
  }
}
