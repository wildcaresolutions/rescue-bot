/**
 * SSRF defense for outbound fetches.
 *
 * Cloudflare Workers don't expose DNS resolution natively (no `dns.resolve()`)
 * so we can't fully prevent DNS-rebinding attacks here — a hostname that
 * resolves to a public IP at validation time could resolve to a private IP at
 * fetch time. That's a known gap; mitigated separately by network egress
 * policies and follow-up DoH-based resolution before each fetch.
 *
 * What this module DOES defend against:
 *   - IP-literal hostnames in private/reserved ranges (10/8, 127/8, 169.254/16,
 *     172.16/12, 192.168/16, 100.64/10 CGNAT, 0/8, 224/4 multicast, IPv6 ::1,
 *     ::/128, fc00::/7 ULA, fe80::/10 link-local, ff00::/8 multicast).
 *   - Decimal-encoded IPv4 (e.g. 2130706433 → 127.0.0.1).
 *   - Hex/octal-encoded IPv4 (0x7f.0.0.1 / 0177.0.0.1).
 *   - IPv4-mapped IPv6 (::ffff:127.0.0.1).
 *   - Reserved hostnames ('localhost', '0', etc.).
 *   - Non-https protocols (http:, file:, ftp:, javascript:, data:, gopher: ...).
 *   - Server-side redirects to unsafe URLs: safeFetch uses
 *     `redirect: 'manual'` and refuses any 3xx response, since following one
 *     redirect transparently bypasses the validation we just did.
 *
 * Why this module exists:
 *   - workers/src/routes/agent.ts:994-1025 had a `fetch_url` LLM tool that
 *     accepted any URL and followed redirects. An admin (or jailbroken
 *     prompt) could ask the bot to fetch http://127.0.0.1/admin/... or
 *     http://169.254.169.254/... (AWS metadata endpoint; not exposed on
 *     Workers but adjacent platforms reuse the address).
 *   - workers/src/lib/brand-extract.ts:361,420,426,443 fetches user-supplied
 *     URLs AND URLs derived from page content (favicon/manifest/CSS hrefs),
 *     also with `redirect: 'follow'`. Same SSRF surface.
 *
 * Usage:
 *   import { safeFetch } from './lib/safe-url'
 *   const res = await safeFetch(url, { headers: {...} })
 *
 * Or for pre-validation only (no fetch):
 *   import { validateOutboundUrl, UnsafeUrlError } from './lib/safe-url'
 *   try { validateOutboundUrl(input) } catch (e) { ... }
 */

export class UnsafeUrlError extends Error {
  readonly kind: string
  constructor(message: string, kind = 'unsafe') {
    super(message)
    this.name = 'UnsafeUrlError'
    this.kind = kind
  }
}

// Hostnames that resolve (or behave as) a local/private endpoint. Some are
// platform-specific (broadcasthost on macOS, localdomain on some Linux), but
// they don't appear on the internet either way — never legitimate fetch
// targets from a server.
const RESERVED_HOSTNAMES = new Set<string>([
  'localhost',
  'localhost.localdomain',
  'localdomain',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback',
  '0',
  '0.0.0.0',
  '255.255.255.255',
])

// IPv4 ranges considered unsafe to fetch. Each entry is a function so we can
// match by parsed octets rather than fragile regex (we already parse the IP
// into 4 octets before calling these).
type Octets = [number, number, number, number]
const PRIVATE_IPV4_PREDICATES: Array<[string, (o: Octets) => boolean]> = [
  ['0.0.0.0/8 unspecified',          ([a]) => a === 0],
  ['10.0.0.0/8 private',             ([a]) => a === 10],
  ['127.0.0.0/8 loopback',           ([a]) => a === 127],
  ['169.254.0.0/16 link-local',      ([a, b]) => a === 169 && b === 254],
  ['172.16.0.0/12 private',          ([a, b]) => a === 172 && b >= 16 && b <= 31],
  ['192.0.0.0/24 protocol assignments', ([a, b, c]) => a === 192 && b === 0 && c === 0],
  ['192.0.2.0/24 TEST-NET-1',        ([a, b, c]) => a === 192 && b === 0 && c === 2],
  ['192.168.0.0/16 private',         ([a, b]) => a === 192 && b === 168],
  ['198.18.0.0/15 benchmarking',     ([a, b]) => a === 198 && (b === 18 || b === 19)],
  ['198.51.100.0/24 TEST-NET-2',     ([a, b, c]) => a === 198 && b === 51 && c === 100],
  ['203.0.113.0/24 TEST-NET-3',      ([a, b, c]) => a === 203 && b === 0 && c === 113],
  ['100.64.0.0/10 CGNAT',            ([a, b]) => a === 100 && b >= 64 && b <= 127],
  ['224.0.0.0/4 multicast',          ([a]) => a >= 224 && a <= 239],
  ['240.0.0.0/4 reserved',           ([a]) => a >= 240],
]

function classifyPrivateIPv4(octets: Octets): string | null {
  for (const [label, predicate] of PRIVATE_IPV4_PREDICATES) {
    if (predicate(octets)) return label
  }
  return null
}

// Parse the four canonical (decimal-dotted) forms an IPv4 can take. Returns
// null for anything that doesn't parse as an IPv4 literal.
function parseIPv4(hostname: string): Octets | null {
  const parts = hostname.split('.')

  // Standard four-octet form: 127.0.0.1
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    const octets = parts.map(p => Number(p)) as Octets
    if (octets.every(o => o >= 0 && o <= 255)) return octets
    return null
  }

  // Decimal-encoded form: 2130706433 → 127.0.0.1. WHATWG URL parser accepts
  // these and the underlying fetch may resolve them. Catch explicitly.
  if (parts.length === 1 && /^\d+$/.test(parts[0])) {
    const n = Number(parts[0])
    if (n >= 0 && n <= 0xFFFFFFFF) {
      return [
        (n >>> 24) & 0xFF,
        (n >>> 16) & 0xFF,
        (n >>> 8) & 0xFF,
        n & 0xFF,
      ]
    }
    return null
  }

  // Hex / octal dotted forms: 0x7f.0.0.1, 0177.0.0.1, 0x7f000001. The WHATWG
  // URL parser actually rejects most of these now, but defense-in-depth: if
  // any segment starts with 0x or 0 (multi-digit), refuse to parse — caller
  // gets UnsafeUrlError via the caller hitting the "encoded hostname" check.
  if (parts.length >= 1 && parts.length <= 4) {
    for (const p of parts) {
      if (/^0x[0-9a-f]+$/i.test(p) || /^0\d+$/.test(p)) {
        return null // signal "encoded form" — caller raises a clear error
      }
    }
  }

  return null
}

// Quick check: does the hostname LOOK like an attempted hex/octal IP that we
// refused to parse? Used to give a clearer error than "not a valid IP".
function looksLikeEncodedIPv4(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length > 4 || parts.length < 1) return false
  return parts.some(p => /^0x[0-9a-f]+$/i.test(p) || /^0\d+$/.test(p))
}

const PRIVATE_IPV6_PREFIXES: Array<[string, (h: string) => boolean]> = [
  ['::1/128 loopback',          h => h === '::1'],
  ['::/128 unspecified',        h => h === '::'],
  // IPv4-mapped IPv6: ::ffff:a.b.c.d — extract the v4 part and re-check.
  // Caller handles via parseIPv4 fallback.
  ['fc00::/7 ULA',              h => /^f[cd]/i.test(h)],
  ['fe80::/10 link-local',      h => /^fe[89ab]/i.test(h)],
  ['ff00::/8 multicast',        h => /^ff/i.test(h)],
]

function classifyPrivateIPv6(hostname: string): string | null {
  for (const [label, predicate] of PRIVATE_IPV6_PREFIXES) {
    if (predicate(hostname)) return label
  }
  return null
}

// Detect IPv4-mapped IPv6 in either decimal form (::ffff:127.0.0.1) or the
// hex form WHATWG URL canonicalizes to (::ffff:7f00:1). Both encode the same
// 32 bits of IPv4; we re-extract and recurse into the v4 private check.
function classifyMappedIPv4(hostname: string): string | null {
  const decMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(hostname)
  if (decMatch) {
    const v4 = parseIPv4(decMatch[1])
    if (!v4) return null
    const v4Private = classifyPrivateIPv4(v4)
    return v4Private ? `IPv4-mapped IPv6 → ${v4Private}` : null
  }
  // Hex form: ::ffff:HHHH:HHHH where each 16-bit group encodes 2 octets.
  // Example: ::ffff:7f00:1 = 127.0.0.1, ::ffff:a9fe:a9fe = 169.254.169.254.
  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname)
  if (hexMatch) {
    const high = parseInt(hexMatch[1], 16)
    const low = parseInt(hexMatch[2], 16)
    if (Number.isNaN(high) || Number.isNaN(low) || high < 0 || high > 0xFFFF || low < 0 || low > 0xFFFF) {
      return null
    }
    const octets: Octets = [
      (high >> 8) & 0xFF,
      high & 0xFF,
      (low >> 8) & 0xFF,
      low & 0xFF,
    ]
    const v4Private = classifyPrivateIPv4(octets)
    return v4Private ? `IPv4-mapped IPv6 → ${v4Private}` : null
  }
  return null
}

/**
 * Validate a URL is safe to fetch from the Worker. Throws UnsafeUrlError on
 * anything we can identify as private/loopback/link-local/reserved/etc., or
 * any non-https protocol, or invalid URL syntax.
 *
 * Returns the parsed URL object on success so the caller can use the
 * normalized form (handy because WHATWG URL canonicalizes a lot of trickery).
 */
export function validateOutboundUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${String(rawUrl).slice(0, 200)}`, 'parse')
  }

  if (url.protocol !== 'https:') {
    throw new UnsafeUrlError(`Protocol must be https; got ${url.protocol}`, 'protocol')
  }

  const hostname = url.hostname.toLowerCase()
  if (!hostname) {
    throw new UnsafeUrlError('URL has no hostname', 'hostname')
  }

  if (RESERVED_HOSTNAMES.has(hostname)) {
    throw new UnsafeUrlError(`Hostname '${hostname}' is reserved`, 'reserved')
  }

  // Encoded IPv4 (hex/octal) — refuse outright. WHATWG URL canonicalization
  // would partially normalize these but the surface for sneaky inputs is
  // wider than we want to reason about.
  if (looksLikeEncodedIPv4(hostname)) {
    throw new UnsafeUrlError(
      `Hex/octal IPv4 hostnames not allowed: ${hostname}`,
      'encoded-ipv4',
    )
  }

  // Decimal-dotted or single-decimal IPv4.
  const v4 = parseIPv4(hostname)
  if (v4) {
    const v4Private = classifyPrivateIPv4(v4)
    if (v4Private) {
      throw new UnsafeUrlError(
        `IPv4 ${v4.join('.')} is in ${v4Private}`,
        'private-ipv4',
      )
    }
  }

  // IPv6 literal. WHATWG URL parses `https://[::1]/` and url.hostname returns
  // '[::1]' on some implementations, '::1' on Workers per WHATWG spec.
  // Normalize by stripping outer brackets if present.
  const v6Raw = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  if (v6Raw.includes(':')) {
    const mappedClass = classifyMappedIPv4(v6Raw)
    if (mappedClass) {
      throw new UnsafeUrlError(`IPv6 ${v6Raw} is in ${mappedClass}`, 'private-ipv6')
    }
    const v6Private = classifyPrivateIPv6(v6Raw)
    if (v6Private) {
      throw new UnsafeUrlError(`IPv6 ${v6Raw} is in ${v6Private}`, 'private-ipv6')
    }
  }

  return url
}

export interface SafeFetchOptions extends Omit<RequestInit, 'redirect'> {
  /** Maximum number of redirects to follow (each re-validated). Default 3. */
  maxRedirects?: number
}

/**
 * Fetch with SSRF guardrails: validate target URL, follow up to maxRedirects
 * (default 3) redirects WITH per-hop validation, throw UnsafeUrlError if any
 * step lands on a private/reserved address.
 *
 * Reasons this matters over `fetch(url, { redirect: 'follow' })`:
 *   - Server-side redirects to private IPs (e.g. `Location: http://127.0.0.1`)
 *     are followed silently by the default redirect handler.
 *   - DNS-rebinding-style attacks where a benign-looking redirect lands on a
 *     cloud-metadata endpoint.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { maxRedirects = 3, ...init } = opts
  let currentUrl = validateOutboundUrl(rawUrl).toString()
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(currentUrl, { ...init, redirect: 'manual' })
    if (res.status < 300 || res.status >= 400) return res
    const loc = res.headers.get('location')
    if (!loc) return res
    if (hop >= maxRedirects) {
      throw new UnsafeUrlError(
        `Too many redirects (${hop + 1}); refusing to follow further`,
        'redirect-limit',
      )
    }
    // Resolve relative redirects against current URL, then re-validate.
    currentUrl = validateOutboundUrl(new URL(loc, currentUrl).toString()).toString()
  }
  // Unreachable — loop returns above. The TS compiler doesn't know that.
  /* c8 ignore next */
  throw new UnsafeUrlError('redirect loop exhausted', 'redirect-limit')
}
