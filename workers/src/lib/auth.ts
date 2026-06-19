import type { Env } from './types'

const PBKDF2_ITERATIONS = 100_000
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000  // 30 days

// ── Password hashing ─────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'],
  )
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256,
  )
  const saltHex = [...salt].map(b => b.toString(16).padStart(2, '0')).join('')
  const hashHex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
  return `pbkdf2:${saltHex}:${hashHex}`
}

/**
 * Constant-time string comparison.
 *
 * Audit ralph-1 M9: `crypto.subtle.timingSafeEqual` in the Workers runtime
 * is synchronous and returns a boolean directly. The previous async wrapper
 * inserted a microtask boundary for no reason and made callers worry about
 * Promise correctness in a hot path. Existing callers still `await` the
 * result, which compiles fine against a non-Promise return.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const aBuf = encoder.encode(a)
  const bBuf = encoder.encode(b)
  if (aBuf.byteLength !== bBuf.byteLength) {
    // Compare against self to keep constant time, but return false
    crypto.subtle.timingSafeEqual(aBuf, aBuf)
    return false
  }
  return crypto.subtle.timingSafeEqual(aBuf, bBuf)
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored === 'LEGACY_SITE_PASSWORD') return false
  if (!stored.startsWith('pbkdf2:')) return timingSafeCompare(password, stored)

  const [, saltHex, hashHex] = stored.split(':')
  const salt = new Uint8Array((saltHex.match(/.{2}/g) ?? []).map(b => parseInt(b, 16)))
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'],
  )
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256,
  )
  const computedHex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
  return timingSafeCompare(computedHex, hashHex)
}

// ── Token generation & verification ──────────────────────────────────────────

/**
 * Token roles, encoded as the leading prefix in the token payload:
 *   - 'viewer'   →  no prefix     (legacy, parts.length == 3)
 *   - 'admin'    →  "admin:..."   (tenant operator with admin perms)
 *   - 'platform' →  "platform:.." (mark@bluesnoop.com et al.; per-tenant scope)
 *
 * A platform_admin session is *per-tenant* by design — see
 * memory/feedback_no_code_review_ceremony for context, but the short of it:
 * a leaked cookie should not auto-grant access to every tenant. Platform
 * admins re-auth on each tenant subdomain.
 */
export type Role = 'viewer' | 'admin' | 'platform'

/** HMAC signing secret for session cookies. Must be independent of login passwords. */
export function signingSecret(env: Env): string {
  if (!env.SIGNING_SECRET) throw new Error('SIGNING_SECRET must be configured')
  return env.SIGNING_SECRET
}

/**
 * Generate a signed session token.
 *
 * Token versions:
 *   v1 (legacy, accepted on read):
 *     viewer: `{tenantId}:{timestamp}:{sig}`
 *     admin/platform: `{role}:{tenantId}:{timestamp}:{sig}`
 *   v2 (issued by this function when an email is supplied — audit ralph-1 C4):
 *     `v2:{role}:{tenantId}:{emailHex}:{timestamp}:{sig}`
 *
 * Why v2: the audit found that `/api/auth/me` PUT used a non-HttpOnly
 * `_tester_email` cookie as the identity for profile writes. Any XSS on the
 * admin domain could rewrite that cookie and the server happily wrote a
 * spoofed user's profile (display_name, avatar_url). Baking the email into
 * the signed token closes that hole — the email becomes HMAC-verified and
 * is no longer client-mutable.
 *
 * Legacy callers omit email; new callers (magic-link issuance, platform
 * signup) pass it. Old v1 tokens continue to verify during the rollout
 * window — verifyToken returns email: undefined for those.
 */
export async function generateToken(
  tenantId: string,
  roleOrIsAdmin: Role | boolean,
  env: Env,
  email?: string,
): Promise<string> {
  const role: Role = typeof roleOrIsAdmin === 'boolean'
    ? (roleOrIsAdmin ? 'admin' : 'viewer')
    : roleOrIsAdmin
  const encoder = new TextEncoder()
  let tokenData: string
  if (email && email.trim()) {
    const emailHex = [...encoder.encode(email.trim().toLowerCase())]
      .map(b => b.toString(16).padStart(2, '0')).join('')
    tokenData = `v2:${role}:${tenantId}:${emailHex}:${Date.now()}`
  } else {
    const prefix = role === 'viewer' ? '' : `${role}:`
    tokenData = `${prefix}${tenantId}:${Date.now()}`
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(tokenData))
  const sigHex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
  return btoa(`${tokenData}:${sigHex}`)
}

export interface VerifiedToken {
  tenantId: string
  role: Role
  /** Convenience: tenant-admin OR platform-admin. */
  isAdmin: boolean
  isPlatformAdmin: boolean
  /** Email baked into v2 tokens. Undefined for v1 tokens still in flight. */
  email?: string
}

export async function verifyToken(token: string, env: Env): Promise<VerifiedToken | null> {
  try {
    const decoded = atob(token)
    const parts = decoded.split(':')
    if (parts.length < 3) return null

    let role: Role
    let tenantId: string
    let timestamp: string
    let sigHex: string
    let email: string | undefined
    let tokenData: string

    if (parts[0] === 'v2') {
      // v2:role:tenantId:emailHex:timestamp:sig — audit ralph-1 C4. The email
      // is part of the signed payload, so it can't be swapped by a non-HttpOnly
      // cookie or any client-side rewrite. Any profile-write endpoint should
      // prefer this value over a cookie.
      if (parts.length < 6) return null
      const v2Role = parts[1]
      if (v2Role !== 'viewer' && v2Role !== 'admin' && v2Role !== 'platform') return null
      role = v2Role
      tenantId = parts[2]
      const emailHex = parts[3]
      timestamp = parts[4]
      sigHex = parts[5]
      tokenData = `v2:${role}:${tenantId}:${emailHex}:${timestamp}`
      // Hex-decode the email back to UTF-8.
      const emailBytes = new Uint8Array((emailHex.match(/.{2}/g) ?? []).map(b => parseInt(b, 16)))
      email = new TextDecoder().decode(emailBytes)
    } else if (parts[0] === 'admin' || parts[0] === 'platform') {
      if (parts.length < 4) return null
      role = parts[0]
      tenantId = parts[1]
      timestamp = parts[2]
      sigHex = parts[3]
      tokenData = `${role}:${tenantId}:${timestamp}`
    } else {
      role = 'viewer'
      tenantId = parts[0]
      timestamp = parts[1]
      sigHex = parts[2]
      tokenData = `${tenantId}:${timestamp}`
    }

    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(signingSecret(env)),
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['verify'],
    )
    const sigBytes = new Uint8Array((sigHex.match(/.{2}/g) ?? []).map(b => parseInt(b, 16)))
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(tokenData))
    if (!valid) return null

    // Audit ralph-2 M13: validate the timestamp shape explicitly. parseInt
    // returns NaN on a malformed string, and `Date.now() - NaN > N` is
    // `false`, which would accept the token if the signature ever
    // collided. Belt-and-braces — the signature check above already gates
    // this, but the cost of checking is one regex.
    if (!/^\d+$/.test(timestamp)) return null
    const tsNum = parseInt(timestamp, 10)
    const age = Date.now() - tsNum
    if (!Number.isFinite(age) || age > TOKEN_MAX_AGE_MS) return null

    const isPlatformAdmin = role === 'platform'
    const isAdmin = role === 'admin' || isPlatformAdmin
    return { tenantId, role, isAdmin, isPlatformAdmin, email }
  } catch {
    return null
  }
}

// ── Platform admin email allowlist ───────────────────────────────────────────

/**
 * Returns true if the given email is configured as a platform admin via the
 * PLATFORM_ADMIN_EMAILS env var (comma-separated, case-insensitive).
 *
 * Platform admins:
 *   - bypass the per-tenant tenant_users membership check at magic-link time
 *   - never get inserted into any tenant_users table
 *   - get sessions with role='platform' tied to whichever tenant they signed in to
 */
export function isPlatformAdminEmail(email: string, env: Env): boolean {
  const list = env.PLATFORM_ADMIN_EMAILS?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) ?? []
  return list.includes(email.trim().toLowerCase())
}

// ── Local dev auth bypass ────────────────────────────────────────────────────

/**
 * When DEV_AUTH_BYPASS is "true" (in the default/local wrangler env), the
 * server-side auth gate treats every request as authenticated as a tenant
 * admin. Magic-link Turnstile verification is also skipped. Off in test/prod.
 *
 * This is here so day-to-day local dev doesn't require clicking a magic link
 * or wiring Turnstile keys — but flipping it to anything other than "true" in
 * .dev.vars exercises the real flow when you're testing auth changes.
 *
 * The ENVIRONMENT guard is belt-and-braces: even if DEV_AUTH_BYPASS is
 * accidentally set to "true" in a named environment's vars, the check returns
 * false for ENVIRONMENT === 'production' or ENVIRONMENT === 'test'. This
 * prevents the fail-open default from shipping when a bare `wrangler deploy`
 * (no --env) is run, or from leaking into a named env via copy-paste.
 */
export function isDevAuthBypass(env: Env): boolean {
  if (env.ENVIRONMENT === 'production' || env.ENVIRONMENT === 'test') return false
  return env.DEV_AUTH_BYPASS === 'true'
}

// ── Cookie + Bearer extraction ───────────────────────────────────────────────

/** Cookie name prefix for tenant-scoped sessions. Matches web/src/auth.js. */
export function tenantCookiePrefix(slug: string): string {
  return `wc_${slug.replace(/-/g, '_')}`
}

/** Cookie name prefix for the platform admin dashboard at admin.<root>. */
export const PLATFORM_COOKIE_PREFIX = 'wc_platform'

/**
 * Resolve a session from either the Authorization: Bearer header (preferred
 * by API callers) or a cookie. Cookie name is derived from the cookie prefix
 * (tenant-scoped or platform-scoped). Returns null if no valid session.
 */
export async function resolveSession(
  request: Request,
  cookiePrefix: string,
  env: Env,
): Promise<VerifiedToken | null> {
  const auth = request.headers.get('Authorization')
  if (auth?.startsWith('Bearer ')) {
    const verified = await verifyToken(auth.slice(7), env)
    if (verified) return verified
  }

  const cookieHeader = request.headers.get('Cookie') ?? ''
  const cookieName = `${cookiePrefix}_token`
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`))
  if (!match) return null
  return verifyToken(decodeURIComponent(match[1]), env)
}
