import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendEmail } from '../src/lib/email'
import type { Env } from '../src/lib/types'

type SendArg = {
  from: { name: string; email: string }
  to: string | string[]
  subject: string
  html: string
}

function fakeEnv(overrides: Partial<Env> = {}, sendImpl?: (m: SendArg) => Promise<void>): {
  env: Env
  sent: SendArg[]
} {
  const sent: SendArg[] = []
  const send = sendImpl ?? (async (m: SendArg) => { sent.push(m) })
  const env = {
    EMAIL: { send } as unknown as Env['EMAIL'],
    ...overrides,
  } as Env
  return { env, sent }
}

const baseMsg = {
  from: { name: 'Test Org', email: 'noreply@wildcaresolutions.org' },
  to: 'real-user@example.com',
  subject: 'Sign in to Test Org',
  html: '<p>hi</p>',
}

describe('sendEmail — production path (no override, binding present)', () => {
  it('sends to the original recipient unchanged', async () => {
    const { env, sent } = fakeEnv()
    const result = await sendEmail(env, baseMsg)
    expect(result).toEqual({ sent: true })
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('real-user@example.com')
    expect(sent[0].subject).toBe('Sign in to Test Org')
  })

  it('preserves array recipients when no override', async () => {
    const { env, sent } = fakeEnv()
    const result = await sendEmail(env, { ...baseMsg, to: ['a@x.com', 'b@x.com'] })
    expect(result).toEqual({ sent: true })
    expect(sent[0].to).toEqual(['a@x.com', 'b@x.com'])
  })
})

describe('sendEmail — override path (test/dev environments)', () => {
  it('redirects single recipient to override and preserves original in subject', async () => {
    const { env, sent } = fakeEnv({ EMAIL_OVERRIDE_TO: 'mark@bluesnoop.com' })
    await sendEmail(env, baseMsg)
    expect(sent[0].to).toBe('mark@bluesnoop.com')
    expect(sent[0].subject).toContain('real-user@example.com')
    expect(sent[0].subject).toContain('Sign in to Test Org')
  })

  it('redirects array recipients to override and preserves them in subject', async () => {
    const { env, sent } = fakeEnv({ EMAIL_OVERRIDE_TO: 'mark@bluesnoop.com' })
    await sendEmail(env, { ...baseMsg, to: ['a@x.com', 'b@x.com'] })
    expect(sent[0].to).toBe('mark@bluesnoop.com')
    expect(sent[0].subject).toContain('a@x.com, b@x.com')
  })

  it('prepends EMAIL_SUBJECT_PREFIX when set', async () => {
    const { env, sent } = fakeEnv({
      EMAIL_OVERRIDE_TO: 'mark@bluesnoop.com',
      EMAIL_SUBJECT_PREFIX: '[TEST]',
    })
    await sendEmail(env, baseMsg)
    expect(sent[0].subject.startsWith('[TEST]')).toBe(true)
  })

  it('prepends prefix even without override (e.g. dev)', async () => {
    const { env, sent } = fakeEnv({ EMAIL_SUBJECT_PREFIX: '[DEV]' })
    await sendEmail(env, baseMsg)
    expect(sent[0].subject).toBe('[DEV] Sign in to Test Org')
    expect(sent[0].to).toBe('real-user@example.com')  // no override → real recipient
  })

  it('treats whitespace-only override as unset', async () => {
    const { env, sent } = fakeEnv({ EMAIL_OVERRIDE_TO: '   ' })
    await sendEmail(env, baseMsg)
    expect(sent[0].to).toBe('real-user@example.com')
  })
})

describe('sendEmail — no binding (local dev)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
  })

  it('returns no_binding result without throwing', async () => {
    const result = await sendEmail({} as Env, baseMsg)
    expect(result).toEqual({ sent: false, reason: 'no_binding' })
  })

  it('logs the would-be email so dev can see what was attempted', async () => {
    await sendEmail({} as Env, baseMsg)
    expect(logSpy).toHaveBeenCalled()
    const logged = logSpy.mock.calls[0][0] as string
    expect(logged).toContain('real-user@example.com')
    expect(logged).toContain('Sign in to Test Org')
  })
})

describe('sendEmail — send failure', () => {
  it('returns send_failed and includes the error', async () => {
    const err = new Error('binding kaboom')
    const { env } = fakeEnv({}, async () => { throw err })
    const result = await sendEmail(env, baseMsg)
    expect(result).toEqual({ sent: false, reason: 'send_failed', error: err })
  })
})
