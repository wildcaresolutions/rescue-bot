/**
 * ToolContext — everything the copilot tools need to close over.
 *
 * The route handler in workers/src/routes/agent.ts used to define all 27
 * tools inline so each could capture `tenant`, `freshTenant`, `db`, the
 * Hono context, etc. This type captures that same captured scope as an
 * explicit interface so the tool factories in lib/tools/<category>.ts
 * can take it as a parameter instead.
 *
 * `freshTenant` is the post-write tenant snapshot the route reloads
 * before building tools (see agent.ts). Tools that mutate org_config /
 * widget_theme / etc. should read from `freshTenant` and write to `db`,
 * then call `invalidateCache()` to clear the in-memory cache keyed by
 * tenant slug.
 */
import type { Context } from 'hono'
import type { Env, Tenant, Variables } from '../types'

export interface ToolContext {
  env: Env
  c: Context<{ Bindings: Env; Variables: Variables }>
  db: D1Database
  /** Tenant snapshot as resolved by middleware at request start. */
  tenant: Tenant
  /** Convenience alias for tenant.id. */
  tenantId: string
  /** Tenant snapshot after the route reloads from D1 mid-handler — the
   * post-write current state used to build the system prompt and most
   * tool execute() bodies. */
  freshTenant: Tenant
  /** Invalidate the in-memory tenant cache. Tools that mutate the
   * tenants row should call this after the UPDATE. */
  invalidateCache: () => void
}
