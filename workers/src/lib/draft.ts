/**
 * Global draft/publish (staging) layer for tenant config.
 *
 * The bot serves the LIVE `tenants` columns (this module never touches the bot
 * read path). Operator edits are STAGED into the `draft_config` JSON column as
 * a partial patch (keyed by column name). The admin editor reads
 * live-overlaid-with-draft (`overlayTenant`); Publish applies the patch to the
 * live columns (lib/publish.ts) and recompiles; Discard nulls the draft.
 *
 * Invariant: staging changes ONLY `draft_config`/`draft_updated_at` — never a
 * live column, never `custom_instruction` (recompile is deferred to publish).
 * It DOES bust the slug cache, because the draft rides on the same cached row
 * the admin overlay reads — and that's safe precisely because the live columns
 * are untouched, so the re-cached row serves the bot identical live config.
 */
import type { Env, Tenant } from './types'
import type { OrgConfig, BotOverrides } from './compile-instruction'
import { invalidateTenantCache } from './cache'
import { loadTenantBySlug } from './tenant-loader'

/** Columns that hold JSON — stored as parsed objects inside the draft patch,
 *  serialized to strings when overlaid onto a Tenant row or written at publish. */
const JSON_COLUMNS = new Set(['org_config', 'bot_overrides', 'widget_theme', 'feature_flags'])

/** Every column an operator can stage. `onboarded`/`widget_published_at` are
 *  publish markers (set by the publish action), never draftable. */
const PUBLISHABLE_COLUMNS = new Set([
  'phone', 'email', 'url',
  'location_county', 'location_state', 'location_service_area',
  'color_primary', 'color_secondary', 'color_accent',
  'logo_r2_key', 'custom_instruction', 'custom_instruction_locked', 'custom_instruction_locked_at',
  'widget_theme', 'widget_custom_css', 'org_config', 'bot_overrides', 'house_rules',
  'report_recipients', 'daily_reports_enabled', 'feature_flags',
])

/** Partial patch of publishable columns. JSON columns are parsed objects. */
export interface DraftConfig {
  phone?: string | null
  email?: string | null
  url?: string | null
  location_county?: string | null
  location_state?: string | null
  location_service_area?: string | null
  color_primary?: string
  color_secondary?: string
  color_accent?: string
  logo_r2_key?: string | null
  custom_instruction?: string | null
  custom_instruction_locked?: number
  custom_instruction_locked_at?: string | null
  house_rules?: string | null
  widget_custom_css?: string | null
  report_recipients?: string | null
  daily_reports_enabled?: number
  org_config?: OrgConfig
  bot_overrides?: BotOverrides
  widget_theme?: Record<string, unknown>
  feature_flags?: Record<string, unknown>
}

/** Parse a tenant's draft patch (empty object when none). */
export function loadDraft(tenant: { draft_config?: string | null } | string | null | undefined): DraftConfig {
  const raw = typeof tenant === 'string' ? tenant : tenant?.draft_config
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as DraftConfig : {}
  } catch {
    return {}
  }
}

/** True when the tenant has unpublished changes. */
export function hasDraft(tenant: { draft_config?: string | null } | null | undefined): boolean {
  return Object.keys(loadDraft(tenant ?? null)).length > 0
}

/**
 * Return a Tenant row with the draft patch applied on top of the live values —
 * the EDITING view. Pure; shape-identical to a real row (JSON columns are
 * re-serialized to strings). Returns the input unchanged when there's no draft.
 * NEVER call this on the bot read path.
 */
export function overlayTenant(tenant: Tenant): Tenant {
  const draft = loadDraft(tenant)
  const keys = Object.keys(draft)
  if (!keys.length) return tenant
  const out: Record<string, unknown> = { ...tenant }
  for (const k of keys) {
    const v = (draft as Record<string, unknown>)[k]
    if (v === undefined) continue
    out[k] = JSON_COLUMNS.has(k) && v !== null && typeof v === 'object' ? JSON.stringify(v) : v
  }
  return out as unknown as Tenant
}

/**
 * Merge a patch into the tenant's draft and persist it. Does NOT change live
 * columns or recompile; DOES bust the slug cache (see file header). Returns the
 * merged draft so callers can echo what's staged.
 */
export async function stageConfigChange(
  db: D1Database,
  tenant: Pick<Tenant, 'id' | 'slug'>,
  patch: DraftConfig,
): Promise<DraftConfig> {
  const row = await db.prepare('SELECT draft_config FROM tenants WHERE id = ?')
    .bind(tenant.id).first<{ draft_config: string | null }>()
  const merged = loadDraft(row?.draft_config ?? null)
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    ;(merged as Record<string, unknown>)[k] = v
  }
  await db.prepare("UPDATE tenants SET draft_config = ?, draft_updated_at = datetime('now') WHERE id = ?")
    .bind(JSON.stringify(merged), tenant.id).run()
  invalidateTenantCache(tenant.slug)
  return merged
}

/** Null out the draft (Discard, and the tail of Publish). */
export async function clearDraft(db: D1Database, tenantId: string): Promise<void> {
  await db.prepare('UPDATE tenants SET draft_config = NULL, draft_updated_at = NULL WHERE id = ?')
    .bind(tenantId).run()
}

/**
 * Map a draft patch to `col = ?` fragments + bind values for the publish-time
 * UPDATE. JSON columns serialized; unknown keys ignored. Shared by publish so
 * staging and publish agree on the column mapping.
 */
export function draftPatchToColumns(patch: DraftConfig): { cols: string[]; vals: unknown[] } {
  const cols: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !PUBLISHABLE_COLUMNS.has(k)) continue
    cols.push(`${k} = ?`)
    vals.push(JSON_COLUMNS.has(k) && v !== null && typeof v === 'object' ? JSON.stringify(v) : v)
  }
  return { cols, vals }
}

/** Load a tenant for EDITING (live overlaid with draft). Admin reads only. */
export async function loadTenantForEditing(env: Env, slug: string): Promise<Tenant | null> {
  const t = await loadTenantBySlug(env, slug)
  return t ? overlayTenant(t) : null
}
