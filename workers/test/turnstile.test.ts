import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { verifyTurnstile } from '../src/lib/turnstile'

const realFetch = globalThis.fetch

function mockFetch(impl: (req: Request) => Response | Promise<Response>) {
  // @ts-expect-error overriding global for test
  globalThis.fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return impl(req)
  })
}

describe('verifyTurnstile', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('returns missing_secret when env secret is empty', async () => {
    const r = await verifyTurnstile('any-token', '1.2.3.4', '')
    expect(r).toEqual({ ok: false, reason: 'missing_secret' })
  })

  it('returns missing_token when no token from client', async () => {
    const r = await verifyTurnstile(null, '1.2.3.4', 'secret')
    expect(r).toEqual({ ok: false, reason: 'missing_token' })
  })

  it('returns ok when siteverify says success', async () => {
    let captured: URLSearchParams | null = null
    mockFetch(async (req) => {
      captured = new URLSearchParams(await req.text())
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
    const r = await verifyTurnstile('good-token', '1.2.3.4', 'secret-abc')
    expect(r).toEqual({ ok: true })
    expect(captured!.get('secret')).toBe('secret-abc')
    expect(captured!.get('response')).toBe('good-token')
    expect(captured!.get('remoteip')).toBe('1.2.3.4')
  })

  it('omits remoteip when caller IP unknown', async () => {
    let captured: URLSearchParams | null = null
    mockFetch(async (req) => {
      captured = new URLSearchParams(await req.text())
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
    await verifyTurnstile('t', null, 's')
    expect(captured!.has('remoteip')).toBe(false)
  })

  it('returns rejected with error-codes when siteverify says success=false', async () => {
    mockFetch(async () => new Response(JSON.stringify({
      success: false,
      'error-codes': ['invalid-input-response', 'timeout-or-duplicate'],
    }), { status: 200 }))
    const r = await verifyTurnstile('bad', null, 'secret')
    expect(r).toEqual({
      ok: false,
      reason: 'rejected',
      details: 'invalid-input-response,timeout-or-duplicate',
    })
  })

  it('returns network on non-2xx HTTP', async () => {
    mockFetch(async () => new Response('Server error', { status: 500 }))
    const r = await verifyTurnstile('t', null, 's')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('network')
  })

  it('returns network on fetch throw', async () => {
    mockFetch(() => { throw new Error('connection refused') })
    const r = await verifyTurnstile('t', null, 's')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('network')
      expect(r.details).toContain('connection refused')
    }
  })

  it('returns network on malformed response body', async () => {
    mockFetch(async () => new Response('not-json', { status: 200 }))
    const r = await verifyTurnstile('t', null, 's')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('network')
  })
})
