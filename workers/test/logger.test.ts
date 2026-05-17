import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { log, logInfo, logError } from '../src/lib/logger'

/**
 * Tests for the structured logger. The output goes to console.{level} so
 * tests intercept those globals and parse the resulting JSON.
 */

let consoleSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // Spy on all four console methods so we can capture whichever level
  // each test exercises. .error is the default — others overridden in
  // individual tests as needed.
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

function parseLastCall(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalled()
  const arg = spy.mock.calls.at(-1)?.[0]
  expect(typeof arg).toBe('string')
  return JSON.parse(arg as string)
}

describe('log — output shape', () => {
  it('emits valid JSON with the required fields', () => {
    logError('test/event')
    const entry = parseLastCall(consoleSpy)
    expect(entry).toHaveProperty('ts')
    expect(entry).toHaveProperty('level', 'error')
    expect(entry).toHaveProperty('event', 'test/event')
  })

  it('includes tenant_id when provided', () => {
    logError('test/event', { tenant_id: 'wc-1' })
    const entry = parseLastCall(consoleSpy)
    expect(entry.tenant_id).toBe('wc-1')
  })

  it('includes arbitrary fields verbatim', () => {
    logError('chat/end', { session_id: 'abc', message_count: 5 })
    const entry = parseLastCall(consoleSpy)
    expect(entry.session_id).toBe('abc')
    expect(entry.message_count).toBe(5)
  })

  it('routes by severity to the right console method', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    log('info', 'x')
    log('warn', 'x')
    expect(infoSpy).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })
})

describe('log — error serialization', () => {
  it('turns Error into {message, name, stack}', () => {
    logError('test/event', { error: new Error('boom') })
    const entry = parseLastCall(consoleSpy)
    const err = entry.error as Record<string, unknown>
    expect(err.message).toBe('boom')
    expect(err.name).toBe('Error')
    expect(typeof err.stack).toBe('string')
  })

  it('passes through string errors as-is', () => {
    logError('test/event', { error: 'just a message' })
    const entry = parseLastCall(consoleSpy)
    expect(entry.error).toBe('just a message')
  })

  it('handles non-Error non-string error values', () => {
    logError('test/event', { error: { code: 'XYZ', detail: 'nope' } })
    const entry = parseLastCall(consoleSpy)
    expect(typeof entry.error).toBe('string')
    expect(entry.error as string).toContain('XYZ')
  })
})

describe('log — PII scrubbing', () => {
  it('redacts emails in arbitrary string fields', () => {
    // The audit (P3-30) wants Workers Logs / Logpush destinations to NOT
    // carry raw PII. The logger's scrub pass catches accidental PII in
    // any field — caller doesn't have to remember to redact manually.
    logError('chat/end', { last_message: 'caller emailed alice@example.org' })
    const entry = parseLastCall(consoleSpy)
    expect(entry.last_message as string).toContain('[EMAIL-REDACTED]')
    expect(entry.last_message as string).not.toContain('alice@example.org')
  })

  it('redacts phone numbers in nested fields', () => {
    logError('triage', {
      session_summary: {
        first_message: 'call me at 555-123-4567',
      },
    })
    const entry = parseLastCall(consoleSpy)
    const summary = entry.session_summary as Record<string, unknown>
    expect(summary.first_message as string).toContain('[PHONE-REDACTED]')
  })

  it('redacts in array fields', () => {
    logError('batch', { messages: ['email a@b.com', 'phone 555-123-4567'] })
    const entry = parseLastCall(consoleSpy)
    const msgs = entry.messages as string[]
    expect(msgs[0]).toContain('[EMAIL-REDACTED]')
    expect(msgs[1]).toContain('[PHONE-REDACTED]')
  })

  it('does NOT scrub the event name itself', () => {
    // The event name is operator-controlled (not citizen-supplied), and
    // log analytics relies on it being stable. We intentionally don't
    // scrub it.
    logError('chat/end-555-123-4567')
    const entry = parseLastCall(consoleSpy)
    expect(entry.event).toBe('chat/end-555-123-4567')
  })

  it('does NOT redact tenant_id (operational identifier, not PII)', () => {
    logError('x', { tenant_id: 'wc-1' })
    const entry = parseLastCall(consoleSpy)
    expect(entry.tenant_id).toBe('wc-1')
  })
})

describe('logInfo / logError / etc — convenience wrappers', () => {
  it('logInfo emits at info level', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    logInfo('x', { a: 1 })
    expect(infoSpy).toHaveBeenCalled()
    const arg = infoSpy.mock.calls.at(-1)?.[0] as string
    const entry = JSON.parse(arg)
    expect(entry.level).toBe('info')
  })

  it('logError emits at error level', () => {
    logError('x', { a: 1 })
    const entry = parseLastCall(consoleSpy)
    expect(entry.level).toBe('error')
  })
})
