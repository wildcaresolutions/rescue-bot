/**
 * Reserved hostname labels that must NOT resolve to a tenant. These are
 * platform-level subdomains (admin, embed, etc.) and operational labels
 * (mail, ftp, etc.) that should never be valid tenant slugs.
 *
 * Distinct from the signup-time RESERVED_SLUGS in routes/platform.ts which
 * also includes things like "default" — host-routing failure modes are
 * different from signup-claim failure modes, so the lists are kept separate.
 */
export const RESERVED_HOST_SLUGS = new Set([
  'admin', 'api', 'platform', 'www', 'app', 'mail', 'ftp',
  'cdn', 'static', 'assets', 'embed', 'health', 'status',
  'default', 'rescue', 'test', 'staging', 'dev', 'smoke',
])

/** First label of the host (e.g. "admin" from "admin.wildcaresolutions.org"). */
export function hostFirstLabel(host: string): string {
  return host.split(':')[0].split('.')[0]
}

/**
 * Extract a tenant slug from a Host header. Returns null when:
 *   - host has fewer than three labels (apex, single-label, or one-deep)
 *   - host's TLD label is "localhost" (any *.localhost dev host)
 *   - host ends in `.workers.dev` (Cloudflare Workers default URL — the
 *     leftmost label is the worker name, not a tenant slug). Treat these
 *     as apex so tenant resolution falls through to the ?tenant= query
 *     param, matching how local dev's localhost URL behaves.
 *   - the first label is in the reserved set
 */
export function extractSlug(host: string): string | null {
  const hostname = host.split(':')[0]
  const parts = hostname.split('.')
  if (parts.length < 3) return null
  if (parts[parts.length - 1] === 'localhost') return null
  if (parts.length >= 2 && parts[parts.length - 2] === 'workers' && parts[parts.length - 1] === 'dev') return null
  const slug = parts[0]
  if (!slug || RESERVED_HOST_SLUGS.has(slug)) return null
  return slug
}

/** True when the host is the platform admin host (e.g. admin.wildcaresolutions.org). */
export function isAdminHost(host: string): boolean {
  return hostFirstLabel(host) === 'admin'
}

/** True when tenants are addressed via `?tenant=<slug>` on a shared host
 *  rather than their own subdomain. Mirrors the null cases in extractSlug:
 *  localhost, *.workers.dev, and any host with fewer than three labels. */
export function isQueryParamHost(host: string): boolean {
  const parts = host.split(':')[0].split('.')
  if (parts.length < 3) return true
  if (parts[parts.length - 1] === 'localhost') return true
  if (parts[parts.length - 2] === 'workers' && parts[parts.length - 1] === 'dev') return true
  return false
}

/**
 * Given the current request host (e.g. the platform-admin host an approval
 * runs on) and a tenant slug, return the host the tenant's portal lives on.
 * In subdomain mode (prod) that's `<slug>.<root>`; in query-param mode
 * (workers.dev / localhost / apex) it's the same host, with the tenant
 * carried via `?tenant=` instead. Pairs with extractSlug/isQueryParamHost so
 * a magic link minted during onboarding lands on the host that can read it.
 */
export function tenantHostFor(reqHost: string, slug: string): string {
  if (isQueryParamHost(reqHost)) return reqHost
  const [hostname, port] = reqHost.split(':')
  const root = hostname.split('.').slice(1).join('.')
  return port ? `${slug}.${root}:${port}` : `${slug}.${root}`
}

/** Absolute base URL of a tenant's portal, including `?tenant=` in
 *  query-param mode. No trailing path beyond `/`. */
export function tenantPortalUrl(reqHost: string, slug: string): string {
  const host = tenantHostFor(reqHost, slug)
  const proto = host.includes('localhost') ? 'http' : 'https'
  return isQueryParamHost(reqHost)
    ? `${proto}://${host}/?tenant=${encodeURIComponent(slug)}`
    : `${proto}://${host}/`
}
