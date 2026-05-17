/**
 * Tenant row loaders + org_config JSON parsers.
 *
 * The repo had ~13 call sites loading tenant rows with subtle variations:
 *   SELECT * FROM tenants WHERE slug = ?
 *   SELECT * FROM tenants WHERE id = ?
 *   SELECT org_config FROM tenants WHERE id = ?
 *   SELECT color_primary, color_secondary, color_accent FROM tenants WHERE id = ?
 *   ...
 *
 * Most of the variation was incidental — a route loaded `*` when it only
 * needed `org_config`, or hand-rolled `JSON.parse(t.org_config)` with its
 * own try/catch. The audit (section 4.4) flagged "tenant config loaded
 * 4 different ways across routes" as a missing abstraction.
 *
 * What this module does:
 *   - loadTenantBySlug / loadTenantById: full-row loads with the cache
 *     layer threaded in. Cache hits skip the D1 round trip; misses
 *     populate the cache. Returns null when no row exists (caller should
 *     emit 404).
 *   - loadOrgConfig: returns the parsed org_config object from a tenant
 *     id (or row). Centralizes the JSON.parse + try/catch fallback that
 *     was duplicated everywhere.
 *   - extractOrgConfig: same parse but takes a Tenant directly (zero-IO
 *     path for callers that already have the row).
 *
 * What this module DOESN'T do:
 *   - Schema-narrow loads (`SELECT a,b,c FROM tenants`). Those were
 *     premature optimization in most call sites; `SELECT *` is cheap on a
 *     ~30-column table and the cache layer makes repeat reads free.
 *   - Mutation. Updates still go through hand-written prepare statements
 *     in each route — there's no shared "updateTenant" because each
 *     mutation has a different column set and side-effect requirement
 *     (compile, invalidate cache, recompute readiness, etc.).
 */

import type { Env, Tenant } from './types'
import type { OrgConfig } from './compile-instruction'
import { getCachedTenant, cacheTenant } from './cache'

export type { OrgConfig }

/**
 * Load a tenant row by slug. Cache-aware: a hit returns immediately, a
 * miss populates the cache before returning. Returns null when no row
 * exists; the caller decides whether that's a 404 or "no tenant context".
 *
 * Used by the tenant-resolution middleware (apex / subdomain / query-
 * param routing) and by the asset router that decides which HTML to serve.
 */
export async function loadTenantBySlug(env: Env, slug: string): Promise<Tenant | null> {
  const cached = getCachedTenant(slug)
  if (cached) return cached
  const row = await env.DB.prepare('SELECT * FROM tenants WHERE slug = ?')
    .bind(slug)
    .first<Tenant>()
  if (row) cacheTenant(slug, row)
  return row ?? null
}

/**
 * Load a tenant row by id. No cache (the cache is keyed on slug, not id);
 * caller is responsible for caching if they have the slug. Most id-based
 * call sites are admin/copilot tools that already have a tenant.id from
 * the auth gate, so they're fresh-loading by design.
 *
 * Takes `db` rather than `env` so callers inside lib/* (which only get a
 * D1Database, not the full Env binding) can use the loader without
 * threading env. Routes can pass `env.DB`.
 */
export async function loadTenantById(db: D1Database, id: string): Promise<Tenant | null> {
  const row = await db.prepare('SELECT * FROM tenants WHERE id = ?')
    .bind(id)
    .first<Tenant>()
  return row ?? null
}

/**
 * Parse a tenant's org_config column safely. Returns an empty object on
 * any failure mode (NULL, empty string, malformed JSON, non-object root).
 * The "non-object root" guard prevents `JSON.parse("null")` or `JSON.parse(
 * "[1,2]")` from cascading into runtime errors deeper in the call chain.
 *
 * Pure: no I/O. Takes the raw column value (string | null | undefined).
 */
export function parseOrgConfig<T extends object = OrgConfig>(
  raw: string | null | undefined,
): T {
  if (!raw) return {} as T
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as T
    }
    return {} as T
  } catch {
    return {} as T
  }
}

/** Shorthand: parse the org_config off a tenant row. */
export function extractOrgConfig<T extends object = OrgConfig>(
  tenant: Tenant,
): T {
  return parseOrgConfig<T>(tenant.org_config)
}

/**
 * Load just the org_config off a tenant row, parsed. Useful for routes
 * that don't need the rest of the columns and want to avoid the
 * full-row read.
 *
 * Returns null when the tenant row doesn't exist (vs an empty object when
 * the column is NULL/empty — those are different states).
 */
export async function loadOrgConfig(db: D1Database, tenantId: string): Promise<OrgConfig | null> {
  const row = await db.prepare('SELECT org_config FROM tenants WHERE id = ?')
    .bind(tenantId)
    .first<{ org_config: string | null }>()
  if (!row) return null
  return parseOrgConfig(row.org_config)
}
