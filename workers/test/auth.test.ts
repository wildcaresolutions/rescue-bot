import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  hashPassword,
  verifyPassword,
  timingSafeCompare,
  signingSecret,
  generateToken,
  verifyToken,
  isPlatformAdminEmail,
  isDevAuthBypass,
  tenantCookiePrefix,
  resolveSession,
  PLATFORM_COOKIE_PREFIX,
} from '../src/lib/auth'
import type { Env } from '../src/lib/types'

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SIGNING_SECRET: 'test-signing-secret',
    ...overrides,
  } as Env
}

describe('hashPassword', () => {
  it('produces a pbkdf2:salt:hash string', async () => {
    const hashed = await hashPassword('mypassword')
    expect(hashed).toMatch(/^pbkdf2:[0-9a-f]{32}:[0-9a-f]{64}$/)
  })

  it('produces different hashes for the same password (random salt)', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
  })
})

describe('verifyPassword', () => {
  it('returns true for correct password against hashed stored value', async () => {
    const stored = await hashPassword('correct-horse')
    expect(await verifyPassword('correct-horse', stored)).toBe(true)
  })

  it('returns false for wrong password against hashed stored value', async () => {
    const stored = await hashPassword('correct-horse')
    expect(await verifyPassword('wrong-horse', stored)).toBe(false)
  })

  it('returns false for LEGACY_SITE_PASSWORD stored value', async () => {
    expect(await verifyPassword('anything', 'LEGACY_SITE_PASSWORD')).toBe(false)
  })

  it('falls back to timing-safe comparison for plain-text stored values', async () => {
    expect(await verifyPassword('plaintext', 'plaintext')).toBe(true)
    expect(await verifyPassword('plaintext', 'different')).toBe(false)
  })
})

describe('timingSafeCompare', () => {
  it('returns true for equal strings', async () => {
    expect(await timingSafeCompare('hello', 'hello')).toBe(true)
  })

  it('returns false for different strings of same length', async () => {
    expect(await timingSafeCompare('hello', 'world')).toBe(false)
  })

  it('returns false for different length strings', async () => {
    expect(await timingSafeCompare('short', 'much longer string')).toBe(false)
  })
})

describe('signingSecret', () => {
  it('throws when no secret is configured', () => {
    const env = fakeEnv({ SIGNING_SECRET: '' })
    expect(() => signingSecret(env)).toThrow('SIGNING_SECRET must be configured')
  })

  it('uses SIGNING_SECRET', () => {
    const env = fakeEnv({ SIGNING_SECRET: 'primary' })
    expect(signingSecret(env)).toBe('primary')
  })

  it('does not fall back to SITE_PASSWORD', () => {
    const env = fakeEnv({ SIGNING_SECRET: '' })
    expect(() => signingSecret(env)).toThrow('SIGNING_SECRET must be configured')
  })
})

describe('generateToken + verifyToken', () => {
  const env = fakeEnv()

  it('round-trips a viewer token (boolean false)', async () => {
    const token = await generateToken('tenant-123', false, env)
    const result = await verifyToken(token, env)
    expect(result).toEqual({
      tenantId: 'tenant-123', role: 'viewer', isAdmin: false, isPlatformAdmin: false, email: undefined,
    })
  })

  it('round-trips a tenant_admin token (boolean true)', async () => {
    const token = await generateToken('tenant-456', true, env)
    const result = await verifyToken(token, env)
    expect(result).toEqual({
      tenantId: 'tenant-456', role: 'admin', isAdmin: true, isPlatformAdmin: false, email: undefined,
    })
  })

  it('round-trips a platform_admin token', async () => {
    const token = await generateToken('tenant-789', 'platform', env)
    const result = await verifyToken(token, env)
    expect(result).toEqual({
      tenantId: 'tenant-789', role: 'platform', isAdmin: true, isPlatformAdmin: true, email: undefined,
    })
  })

  // Audit ralph-2 H3: v2 token has email baked into the signed payload.
  // The C4 mitigation is load-bearing — /api/auth/me PUT identity comes
  // from verifiedToken.email, not a non-HttpOnly cookie. These tests pin
  // the format so a refactor can't silently regress it.

  it('round-trips a v2 admin token carrying email', async () => {
    const token = await generateToken('tenant-v2', 'admin', env, 'mark@example.com')
    const result = await verifyToken(token, env)
    expect(result).toEqual({
      tenantId: 'tenant-v2',
      role: 'admin',
      isAdmin: true,
      isPlatformAdmin: false,
      email: 'mark@example.com',
    })
  })

  it('round-trips a v2 platform token carrying email', async () => {
    const token = await generateToken('tenant-v2p', 'platform', env, 'ops@example.com')
    const result = await verifyToken(token, env)
    expect(result?.role).toBe('platform')
    expect(result?.email).toBe('ops@example.com')
  })

  it('lowercases and trims the v2 email at issuance', async () => {
    const token = await generateToken('t', 'admin', env, '  MARK@EXAMPLE.COM  ')
    const result = await verifyToken(token, env)
    expect(result?.email).toBe('mark@example.com')
  })

  it('rejects a v2 token whose emailHex segment was swapped (sig invalid)', async () => {
    const token = await generateToken('t', 'admin', env, 'a@b.com')
    const decoded = atob(token)
    const parts = decoded.split(':')
    // parts: ['v2', 'admin', 't', emailHex, timestamp, sig]
    expect(parts[0]).toBe('v2')
    // Flip the first hex byte: '6' (a's hex 61) → '7' creates a different email
    // but doesn't break the hex shape — the signature was over the original.
    parts[3] = '7' + parts[3].slice(1)
    const tampered = btoa(parts.join(':'))
    expect(await verifyToken(tampered, env)).toBeNull()
  })

  it('rejects v2 token with non-hex in emailHex segment', async () => {
    const token = await generateToken('t', 'admin', env, 'a@b.com')
    const decoded = atob(token)
    const parts = decoded.split(':')
    parts[3] = 'ZZ' + parts[3].slice(2)  // invalid hex
    const tampered = btoa(parts.join(':'))
    // Sig mismatches (we changed the data but not the sig) → null
    expect(await verifyToken(tampered, env)).toBeNull()
  })

  it('rejects v2 token with too few segments', async () => {
    const malformed = btoa('v2:admin:t:abc:123')  // missing sig
    expect(await verifyToken(malformed, env)).toBeNull()
  })

  it('omits email parameter → issues v1, verifies with email: undefined', async () => {
    const v1 = await generateToken('t', 'admin', env)  // no email arg
    const result = await verifyToken(v1, env)
    expect(result).not.toBeNull()
    expect(result?.email).toBeUndefined()
  })

  it('platform_admin and tenant_admin do not collide on signature', async () => {
    // Same tenant, both roles, same timestamp window — must produce different tokens
    const adminTok = await generateToken('t', 'admin', env)
    const platformTok = await generateToken('t', 'platform', env)
    expect(adminTok).not.toBe(platformTok)
    // And cross-decoding should report the right role each time
    expect((await verifyToken(adminTok, env))?.role).toBe('admin')
    expect((await verifyToken(platformTok, env))?.role).toBe('platform')
  })

  it('rejects a tampered token', async () => {
    // Tamper the DECODED form (a hex signature in a known position) so we
    // guarantee a meaningful bit change. The previous strategy of swapping
    // the second-to-last char of the base64 token was flaky: for a token
    // with 1 padding `=`, that char carries 4 meaningful bits + 2 padding
    // zero bits. When the original happened to be 'A' (000000), swapping
    // to 'B' (000001) only flipped a padding bit — the decoded bytes were
    // unchanged and the HMAC still verified. ~6% of tokens hit that case.
    const token = await generateToken('tenant-123', false, env)
    const decoded = atob(token)
    const tamperedDecoded = decoded.slice(0, -1) + (decoded.at(-1) === '0' ? '1' : '0')
    const tampered = btoa(tamperedDecoded)
    const result = await verifyToken(tampered, env)
    expect(result).toBeNull()
  })

  it('rejects an expired token (>30 days old)', async () => {
    const thirtyOneDays = 31 * 24 * 60 * 60 * 1000
    const past = Date.now() - thirtyOneDays

    vi.spyOn(Date, 'now').mockReturnValue(past)
    const token = await generateToken('tenant-old', false, env)
    vi.restoreAllMocks()

    const result = await verifyToken(token, env)
    expect(result).toBeNull()
  })

  it('rejects a malformed token', async () => {
    // Audit ralph-2 M13: broader malformed coverage so future refactors
    // can't accidentally accept edge cases.
    expect(await verifyToken('', env)).toBeNull()
    expect(await verifyToken('a', env)).toBeNull()
    expect(await verifyToken('not-base64!@#$', env)).toBeNull()
    expect(await verifyToken(btoa(''), env)).toBeNull()
    expect(await verifyToken(btoa('one'), env)).toBeNull()
    expect(await verifyToken(btoa('only:two'), env)).toBeNull()
    expect(await verifyToken(btoa('v2:role'), env)).toBeNull()
    expect(await verifyToken(btoa('v2:bogus:t:abcd:1:sig'), env)).toBeNull()  // unknown role
    expect(await verifyToken(btoa('admin:t:NOTANUMBER:sig'), env)).toBeNull()  // bad timestamp (NaN age)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})

describe('isPlatformAdminEmail', () => {
  it('returns false when env var unset', () => {
    expect(isPlatformAdminEmail('mark@bluesnoop.com', fakeEnv())).toBe(false)
  })

  it('matches case-insensitively and trims whitespace', () => {
    const env = fakeEnv({ PLATFORM_ADMIN_EMAILS: 'Mark@Bluesnoop.com , other@x.com' })
    expect(isPlatformAdminEmail('mark@bluesnoop.com', env)).toBe(true)
    expect(isPlatformAdminEmail('  MARK@BLUESNOOP.COM  ', env)).toBe(true)
    expect(isPlatformAdminEmail('other@x.com', env)).toBe(true)
  })

  it('does not match unrelated emails', () => {
    const env = fakeEnv({ PLATFORM_ADMIN_EMAILS: 'mark@bluesnoop.com' })
    expect(isPlatformAdminEmail('attacker@evil.com', env)).toBe(false)
    expect(isPlatformAdminEmail('mark@bluesnoop.co', env)).toBe(false)
  })

  it('handles empty string and stray commas', () => {
    expect(isPlatformAdminEmail('mark@bluesnoop.com', fakeEnv({ PLATFORM_ADMIN_EMAILS: '' }))).toBe(false)
    expect(isPlatformAdminEmail('mark@bluesnoop.com', fakeEnv({ PLATFORM_ADMIN_EMAILS: ',,,' }))).toBe(false)
  })
})

describe('isDevAuthBypass', () => {
  it('only true when env value is exactly "true"', () => {
    expect(isDevAuthBypass(fakeEnv())).toBe(false)
    expect(isDevAuthBypass(fakeEnv({ DEV_AUTH_BYPASS: '' }))).toBe(false)
    expect(isDevAuthBypass(fakeEnv({ DEV_AUTH_BYPASS: 'false' }))).toBe(false)
    expect(isDevAuthBypass(fakeEnv({ DEV_AUTH_BYPASS: '1' }))).toBe(false)
    expect(isDevAuthBypass(fakeEnv({ DEV_AUTH_BYPASS: 'TRUE' }))).toBe(false)  // case-sensitive
    expect(isDevAuthBypass(fakeEnv({ DEV_AUTH_BYPASS: 'true' }))).toBe(true)
  })
})

describe('tenantCookiePrefix', () => {
  it('replaces hyphens with underscores so cookie names are valid', () => {
    expect(tenantCookiePrefix('wildcare')).toBe('wc_wildcare')
    expect(tenantCookiePrefix('marin-wildlife')).toBe('wc_marin_wildlife')
  })
})

describe('resolveSession', () => {
  const env = fakeEnv()

  function reqWith(headers: Record<string, string>): Request {
    return new Request('https://wildcare.wildcaresolutions.org/', { headers })
  }

  it('extracts and verifies a Bearer token', async () => {
    const tok = await generateToken('t1', 'admin', env)
    const r = await resolveSession(reqWith({ Authorization: `Bearer ${tok}` }), 'wc_wildcare', env)
    expect(r?.tenantId).toBe('t1')
    expect(r?.role).toBe('admin')
  })

  it('falls back to a cookie when Bearer is missing', async () => {
    const tok = await generateToken('t2', 'platform', env)
    const r = await resolveSession(
      reqWith({ Cookie: `other_thing=foo; wc_wildcare_token=${tok}; another=bar` }),
      'wc_wildcare',
      env,
    )
    expect(r?.tenantId).toBe('t2')
    expect(r?.role).toBe('platform')
  })

  it('prefers Bearer over cookie when both present', async () => {
    const cookieTok = await generateToken('cookie-tenant', 'viewer', env)
    const bearerTok = await generateToken('bearer-tenant', 'admin', env)
    const r = await resolveSession(
      reqWith({
        Authorization: `Bearer ${bearerTok}`,
        Cookie: `wc_wildcare_token=${cookieTok}`,
      }),
      'wc_wildcare',
      env,
    )
    expect(r?.tenantId).toBe('bearer-tenant')
  })

  it('returns null when no auth source is present', async () => {
    expect(await resolveSession(reqWith({}), 'wc_wildcare', env)).toBeNull()
  })

  it('returns null when cookie name does not match prefix', async () => {
    const tok = await generateToken('t', 'admin', env)
    const r = await resolveSession(
      reqWith({ Cookie: `wc_other_token=${tok}` }),
      'wc_wildcare',
      env,
    )
    expect(r).toBeNull()
  })

  it('returns null when Bearer token is invalid', async () => {
    const r = await resolveSession(reqWith({ Authorization: 'Bearer garbage' }), 'wc_wildcare', env)
    expect(r).toBeNull()
  })

  it('handles URL-encoded cookie values', async () => {
    const tok = await generateToken('t-encoded', 'admin', env)
    // Cookie values that contain '=' (base64 padding) are sometimes URL-encoded
    const encoded = encodeURIComponent(tok)
    const r = await resolveSession(
      reqWith({ Cookie: `wc_wildcare_token=${encoded}` }),
      'wc_wildcare',
      env,
    )
    expect(r?.tenantId).toBe('t-encoded')
  })

  it('uses PLATFORM_COOKIE_PREFIX for platform-admin host sessions', async () => {
    const tok = await generateToken('default', 'platform', env)
    const r = await resolveSession(
      reqWith({ Cookie: `${PLATFORM_COOKIE_PREFIX}_token=${tok}` }),
      PLATFORM_COOKIE_PREFIX,
      env,
    )
    expect(r?.role).toBe('platform')
  })
})
