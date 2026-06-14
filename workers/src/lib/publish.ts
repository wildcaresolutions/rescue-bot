/**
 * Publish / Discard for the global draft (lib/draft.ts).
 *
 * Publish promotes the staged `draft_config` patch onto the live `tenants`
 * columns, RE-RUNS the instruction compile (the only recompile point now —
 * staging never recompiles), sets the publish markers, and clears the draft —
 * all in ONE `UPDATE` so there's no half-published window. It busts the slug
 * cache exactly once so the next chat turn picks up the new live config.
 *
 * Discard just nulls the draft (live never changed) but still busts the cache,
 * because the draft rode on the same cached row.
 */
import type { Env, Tenant } from './types'
import { compileInstruction, type OrgConfig, type BotOverrides } from './compile-instruction'
import { parseOrgConfig, loadTenantById } from './tenant-loader'
import { invalidateTenantCache } from './cache'
import { loadDraft, overlayTenant, draftPatchToColumns, clearDraft } from './draft'

export interface PublishResult {
  published: boolean
  first_publish: boolean
  applied: string[]
}

export async function publishDraft(env: Env, tenant: Tenant): Promise<PublishResult> {
  // Re-read fresh (an agent turn may have staged more since the request started).
  const fresh = (await loadTenantById(env.DB, tenant.id)) ?? tenant
  const draft = loadDraft(fresh)
  const merged = overlayTenant(fresh) // live + draft = what we're publishing

  const { cols, vals } = draftPatchToColumns(draft)

  // Recompile custom_instruction from the merged config — UNLESS the operator
  // hand-edited the raw prompt in this draft (raw edit wins, mirroring
  // `platform.ts` explicitlyEditingRawPrompt) or the prompt is locked.
  const rawEdit = typeof (draft as Record<string, unknown>).custom_instruction === 'string'
  const locked = merged.custom_instruction_locked === 1
  if (!rawEdit && !locked) {
    const oc = parseOrgConfig<OrgConfig>(merged.org_config)
    const bo = parseOrgConfig<BotOverrides>(merged.bot_overrides)
    const compiled = compileInstruction(merged, oc, bo).trim().slice(0, 10_000)
    cols.push('custom_instruction = ?')
    vals.push(compiled)
  }

  const firstPublish = !fresh.widget_published_at
  // Publish markers + clear the draft, in the same statement.
  cols.push('onboarded = ?'); vals.push(1)
  cols.push('widget_published_at = ?'); vals.push(new Date().toISOString())
  cols.push('draft_config = NULL')           // literal — no bind
  cols.push('draft_updated_at = NULL')       // literal — no bind
  cols.push("updated_at = datetime('now')")  // literal — no bind

  await env.DB.prepare(`UPDATE tenants SET ${cols.join(', ')} WHERE id = ?`)
    .bind(...vals, fresh.id).run()

  invalidateTenantCache(fresh.slug)
  return { published: true, first_publish: firstPublish, applied: Object.keys(draft) }
}

export async function discardDraft(env: Env, tenant: Tenant): Promise<{ discarded: boolean }> {
  await clearDraft(env.DB, tenant.id)
  // The cached row still carries the now-cleared draft — bust it so the admin
  // overlay reads live (= published). Safe: live columns never changed.
  invalidateTenantCache(tenant.slug)
  return { discarded: true }
}
