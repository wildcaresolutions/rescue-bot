import { describe, it, expect } from 'vitest'
import { generateSessionToken, mintSessionToken, validateSessionToken } from '../src/lib/photo-auth'
import type { Env } from '../src/lib/types'

describe('photo-auth.generateSessionToken', () => {
  it('produces 64-char hex strings', () => {
    const token = generateSessionToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces different tokens on each call', () => {
    const tokens = new Set<string>()
    for (let i = 0; i < 100; i++) {
      tokens.add(generateSessionToken())
    }
    // 256 bits of entropy — collisions in 100 tries would be a CSPRNG bug.
    expect(tokens.size).toBe(100)
  })
})

// Audit ralph-2 M9: validateSessionToken is the security boundary on the
// citizen photo endpoints (mint URL, attach, delete). It needs explicit
// behavioral tests so refactors can't silently regress the gating logic.
//
// We use a stub D1 that returns whatever the test prepared — same approach
// as workers/test/platform.test.ts.

class FakeD1 {
  rows = new Map<string, { token: string; expires_at: number }>()
  prepare(_sql: string) {
    let bindArgs: unknown[] = []
    const me = this
    return {
      bind(...args: unknown[]) { bindArgs = args; return this },
      first: async <T>() => {
        const [sessionId, tenantId] = bindArgs as [string, string]
        const key = `${sessionId}|${tenantId}`
        return (me.rows.get(key) ?? null) as T | null
      },
      run: async () => {},
      all: async () => ({ results: [] }),
    }
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new FakeD1() as unknown as D1Database,
    DEV_AUTH_BYPASS: 'false',
    SIGNING_SECRET: 'test-secret',
    AI_GATEWAY_ACCOUNT_ID: '',
    AI_GATEWAY_ID: '',
    REPORT_FROM_EMAIL: '',
    ...overrides,
  } as Env
}

function reqWith(authHeader: string | null): Request {
  const headers = new Headers()
  if (authHeader !== null) headers.set('authorization', authHeader)
  return new Request('https://x/y', { headers })
}

describe('validateSessionToken', () => {
  it('short-circuits to TRUE when DEV_AUTH_BYPASS is "true"', async () => {
    const env = makeEnv({ DEV_AUTH_BYPASS: 'true' })
    // No auth header, no DB rows — bypass still grants.
    expect(await validateSessionToken(env, reqWith(null), 's', 't')).toBe(true)
  })

  it('does NOT short-circuit when ENVIRONMENT is production, even with DEV_AUTH_BYPASS=true', async () => {
    // Belt-and-braces: the isDevAuthBypass() ENVIRONMENT guard must prevent the
    // photo validation path from fail-opening on a production worker, even if
    // DEV_AUTH_BYPASS is accidentally set.
    const env = makeEnv({ DEV_AUTH_BYPASS: 'true', ENVIRONMENT: 'production' })
    // No auth header → no valid token → must return false.
    expect(await validateSessionToken(env, reqWith(null), 's', 't')).toBe(false)
  })

  it('returns FALSE when DEV_AUTH_BYPASS is anything other than "true"', async () => {
    for (const v of ['', 'false', '0', '1', 'yes']) {
      const env = makeEnv({ DEV_AUTH_BYPASS: v })
      expect(await validateSessionToken(env, reqWith(null), 's', 't')).toBe(false)
    }
  })

  it('returns FALSE when Authorization header is missing', async () => {
    const env = makeEnv()
    expect(await validateSessionToken(env, reqWith(null), 's', 't')).toBe(false)
  })

  it('returns FALSE when Authorization is not Bearer-shaped', async () => {
    const env = makeEnv()
    expect(await validateSessionToken(env, reqWith('Basic abc'), 's', 't')).toBe(false)
    expect(await validateSessionToken(env, reqWith('Bearer '), 's', 't')).toBe(false)
    expect(await validateSessionToken(env, reqWith('Bearer'), 's', 't')).toBe(false)
  })

  it('returns FALSE when no row exists for session/tenant', async () => {
    const env = makeEnv()
    expect(await validateSessionToken(env, reqWith('Bearer abc'), 's', 't')).toBe(false)
  })

  it('returns FALSE when the row exists but the token differs', async () => {
    const env = makeEnv()
    const db = env.DB as unknown as FakeD1
    db.rows.set('s|t', { token: 'correct', expires_at: Date.now() + 10_000 })
    expect(await validateSessionToken(env, reqWith('Bearer wrong'), 's', 't')).toBe(false)
  })

  it('returns FALSE when the row has expired', async () => {
    const env = makeEnv()
    const db = env.DB as unknown as FakeD1
    db.rows.set('s|t', { token: 'good', expires_at: Date.now() - 1 })
    expect(await validateSessionToken(env, reqWith('Bearer good'), 's', 't')).toBe(false)
  })

  it('returns TRUE when token matches and is unexpired', async () => {
    const env = makeEnv()
    const db = env.DB as unknown as FakeD1
    db.rows.set('s|t', { token: 'good', expires_at: Date.now() + 10_000 })
    expect(await validateSessionToken(env, reqWith('Bearer good'), 's', 't')).toBe(true)
  })

  it('does not match when the SESSION ID does not match (different key)', async () => {
    const env = makeEnv()
    const db = env.DB as unknown as FakeD1
    db.rows.set('s1|t', { token: 'good', expires_at: Date.now() + 10_000 })
    expect(await validateSessionToken(env, reqWith('Bearer good'), 's2', 't')).toBe(false)
  })

  it('does not match when the TENANT ID does not match (key collision check)', async () => {
    const env = makeEnv()
    const db = env.DB as unknown as FakeD1
    db.rows.set('s|t1', { token: 'good', expires_at: Date.now() + 10_000 })
    expect(await validateSessionToken(env, reqWith('Bearer good'), 's', 't2')).toBe(false)
  })

  it('refuses tokens whose length differs (no early-return timing leak)', async () => {
    const env = makeEnv()
    const db = env.DB as unknown as FakeD1
    db.rows.set('s|t', { token: 'abcdef', expires_at: Date.now() + 10_000 })
    expect(await validateSessionToken(env, reqWith('Bearer abc'), 's', 't')).toBe(false)
    expect(await validateSessionToken(env, reqWith('Bearer abcdefg'), 's', 't')).toBe(false)
  })
})
