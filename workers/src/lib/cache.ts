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

// ── Allowed-domains cache ─────────────────────────────────────────────────────
//
// Caches the allowed_domains list per tenant (keyed by tenantId) so that
// isOriginAllowed doesn't hit D1 on every cross-origin request. Same TTL
// and eviction policy as the tenant cache.
//
// Invalidate whenever a domain is added or removed via the admin API so
// CORS changes take effect immediately within the current isolate.

const DOMAINS_CACHE_TTL = TENANT_CACHE_TTL  // 5 minutes, same as tenant row
const domainsCache = new Map<string, { domains: string[]; expiry: number }>()

export function getCachedDomains(tenantId: string): string[] | null {
  const entry = domainsCache.get(tenantId)
  if (entry && entry.expiry > Date.now()) return entry.domains
  if (entry) domainsCache.delete(tenantId)
  return null
}

export function cacheDomains(tenantId: string, domains: string[]) {
  if (domainsCache.size >= MAX_CACHE_SIZE) {
    const oldest = domainsCache.keys().next().value
    if (oldest) domainsCache.delete(oldest)
  }
  domainsCache.set(tenantId, { domains, expiry: Date.now() + DOMAINS_CACHE_TTL })
}

export function invalidateDomainsCache(tenantId: string) {
  domainsCache.delete(tenantId)
}
