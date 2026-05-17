import { describe, it, expect } from 'vitest'
import { validateOutboundUrl, safeFetch, UnsafeUrlError } from '../src/lib/safe-url'

describe('validateOutboundUrl', () => {
  describe('protocol', () => {
    it('accepts https://', () => {
      expect(() => validateOutboundUrl('https://example.org')).not.toThrow()
      expect(() => validateOutboundUrl('https://example.org/path?q=1')).not.toThrow()
    })

    it('rejects http://', () => {
      // http leaks the request in plaintext AND defeats SSRF mitigations
      // (TLS verification would otherwise catch some redirects to wrong host).
      expect(() => validateOutboundUrl('http://example.org')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('http://example.org')).toThrow(/https/)
    })

    it('rejects non-network schemes', () => {
      // file:, ftp:, gopher:, javascript:, data: — none should be reachable
      // via the LLM-callable fetch tool. data: in particular is a classic
      // SSRF-adjacent exfil vector (encode internal data, ship as response).
      expect(() => validateOutboundUrl('file:///etc/passwd')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('ftp://example.org/file')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('javascript:alert(1)')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('data:text/plain,hello')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('gopher://example.org')).toThrow(UnsafeUrlError)
    })
  })

  describe('parse failures', () => {
    it('rejects garbage', () => {
      expect(() => validateOutboundUrl('not a url')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('')).toThrow(UnsafeUrlError)
      // No protocol → URL parser fails (we require absolute URLs)
      expect(() => validateOutboundUrl('example.org')).toThrow(UnsafeUrlError)
    })

    it('marks parse errors with kind=parse', () => {
      try { validateOutboundUrl('garbage') } catch (e) {
        expect(e).toBeInstanceOf(UnsafeUrlError)
        expect((e as UnsafeUrlError).kind).toBe('parse')
      }
    })
  })

  describe('reserved hostnames', () => {
    it('rejects localhost and its aliases', () => {
      expect(() => validateOutboundUrl('https://localhost')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('https://localhost.localdomain')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('https://0')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('https://0.0.0.0')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('https://255.255.255.255')).toThrow(UnsafeUrlError)
    })

    it('is case-insensitive on hostname check', () => {
      expect(() => validateOutboundUrl('https://LOCALHOST')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('https://LocalHost')).toThrow(UnsafeUrlError)
    })
  })

  describe('IPv4 private ranges', () => {
    // Each line tests one octet in each documented private range. The cases
    // are chosen to land near both ends of each range so off-by-one in the
    // matcher would be caught.
    const cases: Array<[string, string]> = [
      ['10.0.0.0', '10.0.0.0/8'],
      ['10.255.255.255', '10.0.0.0/8'],
      ['127.0.0.1', '127.0.0.0/8'],
      ['127.255.0.1', '127.0.0.0/8'],
      ['169.254.169.254', '169.254.0.0/16'], // AWS/GCP metadata endpoint
      ['172.16.0.1', '172.16.0.0/12'],
      ['172.31.255.255', '172.16.0.0/12'],
      ['192.168.0.1', '192.168.0.0/16'],
      ['192.168.255.255', '192.168.0.0/16'],
      ['192.0.0.5', '192.0.0.0/24'],
      ['198.18.0.1', '198.18.0.0/15'],
      ['198.19.255.255', '198.18.0.0/15'],
      ['100.64.0.1', '100.64.0.0/10'], // CGNAT
      ['100.127.255.254', '100.64.0.0/10'],
      ['224.0.0.1', '224.0.0.0/4'], // multicast
      ['239.255.255.255', '224.0.0.0/4'],
      ['240.0.0.1', '240.0.0.0/4'], // reserved
    ]

    for (const [ip, range] of cases) {
      it(`rejects ${ip} (${range})`, () => {
        expect(() => validateOutboundUrl(`https://${ip}/`)).toThrow(UnsafeUrlError)
      })
    }
  })

  describe('IPv4 boundary cases', () => {
    // 172.15.x.x and 172.32.x.x are PUBLIC (outside the /12). Make sure we
    // don't false-positive — those are legitimate fetch targets.
    it('accepts 172.15.0.1 (just below 172.16/12)', () => {
      expect(() => validateOutboundUrl('https://172.15.0.1/')).not.toThrow()
    })
    it('accepts 172.32.0.1 (just above 172.31)', () => {
      expect(() => validateOutboundUrl('https://172.32.0.1/')).not.toThrow()
    })
    it('accepts 100.63.0.1 (just below 100.64/10 CGNAT)', () => {
      expect(() => validateOutboundUrl('https://100.63.0.1/')).not.toThrow()
    })
    it('accepts 100.128.0.1 (just above 100.127)', () => {
      expect(() => validateOutboundUrl('https://100.128.0.1/')).not.toThrow()
    })
    it('accepts 1.1.1.1 (Cloudflare public DNS — definitely public)', () => {
      expect(() => validateOutboundUrl('https://1.1.1.1/')).not.toThrow()
    })
    it('accepts 8.8.8.8 (Google public DNS)', () => {
      expect(() => validateOutboundUrl('https://8.8.8.8/')).not.toThrow()
    })
  })

  describe('IPv4 encoding bypasses', () => {
    it('rejects decimal-encoded private IP (2130706433 → 127.0.0.1)', () => {
      // The single-integer form is rarely used by humans but is the most
      // common SSRF bypass attempt — the WHATWG URL parser canonicalizes
      // this to 127.0.0.1 silently.
      expect(() => validateOutboundUrl('https://2130706433/')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('https://2130706433/')).toThrow(/127\.0\.0\.0\/8/)
    })

    it('rejects decimal-encoded private 169.254 IP', () => {
      // 169.254.169.254 = 2852039166 (cloud metadata)
      expect(() => validateOutboundUrl('https://2852039166/')).toThrow(UnsafeUrlError)
    })

    it('rejects hex-encoded IPs', () => {
      // 0x7f000001 = 127.0.0.1. WHATWG URL canonicalizes 0x7f.0.0.1 to
      // 127.0.0.1 (decimal) on Workers, so the failure is caught by the
      // decimal-IPv4 private-range check rather than the hex regex —
      // either rejection is acceptable, both indicate the URL is unsafe.
      expect(() => validateOutboundUrl('https://0x7f.0.0.1/')).toThrow(UnsafeUrlError)
    })

    it('rejects octal-encoded IPs', () => {
      // 0177.0.0.1 = 127.0.0.1 in octal-leading-zero form. Same canonicalization
      // as the hex case — either rejection (octal-regex or 127/8) is fine.
      expect(() => validateOutboundUrl('https://0177.0.0.1/')).toThrow(UnsafeUrlError)
    })

    it('accepts decimal-encoded PUBLIC IP (16843009 = 1.1.1.1)', () => {
      // Don't false-positive on legitimate decimal-encoded public IPs.
      // 1.1.1.1 is Cloudflare's public DNS.
      expect(() => validateOutboundUrl('https://16843009/')).not.toThrow()
    })
  })

  describe('IPv6 private ranges', () => {
    it('rejects ::1 (loopback)', () => {
      expect(() => validateOutboundUrl('https://[::1]/')).toThrow(UnsafeUrlError)
    })

    it('rejects :: (unspecified)', () => {
      expect(() => validateOutboundUrl('https://[::]/')).toThrow(UnsafeUrlError)
    })

    it('rejects fc00:: (ULA, fc00::/7)', () => {
      expect(() => validateOutboundUrl('https://[fc00::1]/')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('https://[fd12:3456:789a::1]/')).toThrow(UnsafeUrlError)
    })

    it('rejects fe80:: (link-local)', () => {
      expect(() => validateOutboundUrl('https://[fe80::1]/')).toThrow(UnsafeUrlError)
    })

    it('rejects ff:: (multicast)', () => {
      expect(() => validateOutboundUrl('https://[ff02::1]/')).toThrow(UnsafeUrlError)
    })

    it('rejects IPv4-mapped private (::ffff:127.0.0.1)', () => {
      // Embedded-v4 attack: dress up a private v4 as a v6 to slip past v4 check.
      expect(() => validateOutboundUrl('https://[::ffff:127.0.0.1]/')).toThrow(UnsafeUrlError)
      expect(() => validateOutboundUrl('https://[::ffff:127.0.0.1]/')).toThrow(/IPv4-mapped/)
    })

    it('accepts a public IPv6 (Google DNS, 2001:4860:4860::8888)', () => {
      expect(() => validateOutboundUrl('https://[2001:4860:4860::8888]/')).not.toThrow()
    })
  })

  describe('returns canonicalized URL on success', () => {
    it('returns a URL object', () => {
      const u = validateOutboundUrl('https://example.org/path?q=1')
      expect(u).toBeInstanceOf(URL)
      expect(u.hostname).toBe('example.org')
      expect(u.pathname).toBe('/path')
      expect(u.search).toBe('?q=1')
    })
  })
})

describe('safeFetch', () => {
  it('refuses an unsafe URL upfront', async () => {
    await expect(safeFetch('http://127.0.0.1/')).rejects.toBeInstanceOf(UnsafeUrlError)
    await expect(safeFetch('https://127.0.0.1/')).rejects.toBeInstanceOf(UnsafeUrlError)
    await expect(safeFetch('https://localhost/')).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  it('refuses a redirect to a private IP', async () => {
    // Mock fetch returns a 302 → http://127.0.0.1. safeFetch should validate
    // the redirect target BEFORE following it and throw UnsafeUrlError.
    const fakeFetch = (async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === 'https://example.org/') {
        return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/admin' } })
      }
      return new Response('should-not-reach', { status: 200 })
    }) as typeof fetch

    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      await expect(safeFetch('https://example.org/')).rejects.toBeInstanceOf(UnsafeUrlError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('follows one redirect to a public target', async () => {
    const fakeFetch = (async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === 'https://example.org/') {
        return new Response(null, { status: 302, headers: { Location: 'https://example.net/landing' } })
      }
      if (url === 'https://example.net/landing') {
        return new Response('hello', { status: 200 })
      }
      return new Response('unexpected', { status: 500 })
    }) as typeof fetch

    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const res = await safeFetch('https://example.org/')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('hello')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('caps at maxRedirects', async () => {
    const fakeFetch = (async (input: RequestInfo) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // Always redirect — should hit the cap.
      const next = `${url}#hop`
      return new Response(null, { status: 302, headers: { Location: `https://example.org/${Date.now()}` } })
    }) as typeof fetch

    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      await expect(safeFetch('https://example.org/', { maxRedirects: 2 })).rejects.toBeInstanceOf(UnsafeUrlError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
