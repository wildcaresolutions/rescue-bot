import { describe, it, expect } from 'vitest'
import { normalizeDomain } from '../src/lib/admin-misc'

describe('normalizeDomain', () => {
  // ── Valid inputs ──────────────────────────────────────────────────────────

  it('accepts a plain two-label domain', () => {
    const r = normalizeDomain('example.com')
    expect(r).toEqual({ domain: 'example.com' })
  })

  it('accepts a subdomain', () => {
    const r = normalizeDomain('sub.example.com')
    expect(r).toEqual({ domain: 'sub.example.com' })
  })

  it('strips a leading https:// scheme', () => {
    const r = normalizeDomain('https://example.com')
    expect(r).toEqual({ domain: 'example.com' })
  })

  it('strips a leading http:// scheme', () => {
    const r = normalizeDomain('http://example.com')
    expect(r).toEqual({ domain: 'example.com' })
  })

  it('strips a trailing path', () => {
    const r = normalizeDomain('example.com/some/path')
    expect(r).toEqual({ domain: 'example.com' })
  })

  it('normalizes upper-case input to lowercase', () => {
    const r = normalizeDomain('  Example.COM  ')
    expect(r).toEqual({ domain: 'example.com' })
  })

  // ── Bare TLD rejections ───────────────────────────────────────────────────

  it('rejects bare TLD "com"', () => {
    const r = normalizeDomain('com')
    expect(r).toMatchObject({ error: expect.stringContaining('bare TLD') })
  })

  it('rejects bare TLD "net"', () => {
    const r = normalizeDomain('net')
    expect(r).toMatchObject({ error: expect.stringContaining('bare TLD') })
  })

  it('rejects bare TLD "org"', () => {
    const r = normalizeDomain('org')
    expect(r).toMatchObject({ error: expect.stringContaining('bare TLD') })
  })

  // ── Empty / blank ─────────────────────────────────────────────────────────

  it('rejects empty string', () => {
    const r = normalizeDomain('')
    expect(r).toMatchObject({ error: 'Domain required' })
  })

  it('rejects whitespace-only string', () => {
    const r = normalizeDomain('   ')
    expect(r).toMatchObject({ error: 'Domain required' })
  })

  // ── Wildcard rejection ────────────────────────────────────────────────────

  it('rejects wildcard patterns', () => {
    const r = normalizeDomain('*.example.com')
    expect(r).toMatchObject({ error: 'Wildcard domains are not supported' })
  })

  // ── Invalid hostname ──────────────────────────────────────────────────────

  it('rejects a trailing-dot hostname', () => {
    // new URL('https://example.com.').hostname preserves the trailing dot,
    // so stripped === hostname and the round-trip guard passes. The trailing
    // dot is then caught by the empty-label check: 'example.com.'.split('.')
    // yields ['example', 'com', ''] and the empty last label triggers
    // { error: 'Invalid domain' }.
    const r = normalizeDomain('example.com.')
    expect(r).toMatchObject({ error: 'Invalid domain' })
  })

  it('rejects a hostname with a port', () => {
    // new URL('https://example.com:8080').hostname === 'example.com' which
    // !== 'example.com:8080' → invalid
    const r = normalizeDomain('example.com:8080')
    expect(r).toMatchObject({ error: 'Invalid domain' })
  })

  it('rejects a double-dot hostname', () => {
    // 'example..com'.split('.') yields ['example', '', 'com'] — the empty
    // middle label triggers the empty-label guard.
    const r = normalizeDomain('example..com')
    expect(r).toMatchObject({ error: 'Invalid domain' })
  })
})
