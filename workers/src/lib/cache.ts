import type { Tenant } from './types'

/**
 * In-process tenant cache.
 *
 * Known limitation: Cloudflare Workers run across multiple isolates. Cache
 * invalidation only clears the current isolate's Map. Other isolates retain
 * stale data until their TTL expires (up to 5 minutes). This means password
 * changes may take up to 5 minutes to propagate across all isolates.
 *
 * Acceptable at current scale. If this becomes a problem, switch to the
 * Cache API with cf.cacheKey for cross-isolate invalidation.
 */

const TENANT_CACHE_TTL = 5 * 60 * 1000  // 5 minutes
const MAX_CACHE_SIZE = 500               // prevent unbounded memory growth
const tenantCache = new Map<string, { tenant: Tenant; expiry: number }>()

export function getCachedTenant(slug: string): Tenant | null {
  const entry = tenantCache.get(slug)
  if (entry && entry.expiry > Date.now()) return entry.tenant
  if (entry) tenantCache.delete(slug)
  return null
}

export function cacheTenant(slug: string, tenant: Tenant) {
  // Evict oldest entries if at capacity
  if (tenantCache.size >= MAX_CACHE_SIZE) {
    const oldest = tenantCache.keys().next().value
    if (oldest) tenantCache.delete(oldest)
  }
  tenantCache.set(slug, { tenant, expiry: Date.now() + TENANT_CACHE_TTL })
}

export function invalidateTenantCache(slug: string) {
  tenantCache.delete(slug)
}
