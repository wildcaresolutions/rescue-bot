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
  'default', 'rescue', 'test', 'staging', 'dev',
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
