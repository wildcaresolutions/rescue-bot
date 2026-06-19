import { describe, it, expect } from 'vitest'
// Pure helpers from web/src/widget-runtime.js. They live in the web tree
// because that's where the widget itself lives, but vitest is wired up here
// in workers/ so we co-locate the unit tests with the existing harness.
// @ts-expect-error — JS module without types
import { shouldHideForCMS, inPageBuilderEditor, deriveBaseUrl, sameOrigin } from '../../web/src/widget-runtime.js'

// ── inPageBuilderEditor (config-independent builder guard) ──────────────────────

describe('inPageBuilderEditor', () => {
  const env = (search = '', body: string[] = [], html: string[] = []) =>
    ({ search, bodyClassList: body, htmlClassList: html })

  it('false on a normal page', () => {
    expect(inPageBuilderEditor(env())).toBe(false)
    expect(inPageBuilderEditor(env('?foo=bar', ['home', 'et_divi_theme']))).toBe(false)
  })
  it('Divi builder via ?et_fb=1', () => {
    expect(inPageBuilderEditor(env('?et_fb=1&PageSpeed=off'))).toBe(true)
    // substring guard — et_fb=12 is not the builder
    expect(inPageBuilderEditor(env('?et_fb=12'))).toBe(false)
  })
  it('Divi builder via et-fb body/html classes (works even with NO et_fb param)', () => {
    // The real failure: config can\'t load in the builder so the param check
    // never runs — the class signal must catch it. Classes from a real session.
    expect(inPageBuilderEditor(env('', ['et_divi_theme', 'et-db', 'et-fb', 'et-fb-root-ancestor']))).toBe(true)
    expect(inPageBuilderEditor(env('', [], ['et-fb-root-ancestor', 'et-fb-top-html']))).toBe(true)
  })
  it('Elementor editor / preview', () => {
    expect(inPageBuilderEditor(env('?elementor-preview=42'))).toBe(true)
    expect(inPageBuilderEditor(env('', ['elementor-editor-active']))).toBe(true)
  })
})

// ── shouldHideForCMS ───────────────────────────────────────────────────────────

describe('shouldHideForCMS', () => {
  const env = (search = '', cls: string[] = []) => ({ search, bodyClassList: cls })

  it('returns false when embedOptions is missing', () => {
    expect(shouldHideForCMS(undefined, env())).toBe(false)
    expect(shouldHideForCMS(null, env())).toBe(false)
    expect(shouldHideForCMS({}, env())).toBe(false)
  })

  it('cms=none never hides', () => {
    expect(shouldHideForCMS({ cms: 'none' }, env('?et_fb=1', ['logged-in']))).toBe(false)
  })

  it('cms=wordpress hides ONLY when body has logged-in class', () => {
    expect(shouldHideForCMS({ cms: 'wordpress' }, env('', []))).toBe(false)
    expect(shouldHideForCMS({ cms: 'wordpress' }, env('?et_fb=1', []))).toBe(false)
    expect(shouldHideForCMS({ cms: 'wordpress' }, env('', ['logged-in']))).toBe(true)
  })

  it('cms=wordpress-divi hides ONLY in the Divi builder (?et_fb=1), not for plain logged-in', () => {
    const eo = { cms: 'wordpress-divi' }
    expect(shouldHideForCMS(eo, env('', []))).toBe(false)
    expect(shouldHideForCMS(eo, env('?et_fb=1', []))).toBe(true)
    // Logged-in admin on a NORMAL page → bot shows (so they can test it).
    expect(shouldHideForCMS(eo, env('', ['logged-in']))).toBe(false)
    expect(shouldHideForCMS(eo, env('?et_fb=1', ['logged-in']))).toBe(true)
    // Make sure the regex requires the full `et_fb=1` value, not a substring
    expect(shouldHideForCMS(eo, env('?et_fb=12', []))).toBe(false)
    // Works when the param is later in the query string
    expect(shouldHideForCMS(eo, env('?foo=bar&et_fb=1', []))).toBe(true)
  })

  it('cms=wordpress-elementor hides ONLY in the Elementor preview, not for plain logged-in', () => {
    const eo = { cms: 'wordpress-elementor' }
    expect(shouldHideForCMS(eo, env('', []))).toBe(false)
    expect(shouldHideForCMS(eo, env('?elementor-preview=42', []))).toBe(true)
    expect(shouldHideForCMS(eo, env('', ['logged-in']))).toBe(false)
  })

  it('cms=squarespace hides on body.sqs-edit-mode-active', () => {
    const eo = { cms: 'squarespace' }
    expect(shouldHideForCMS(eo, env('', ['some-other-class']))).toBe(false)
    expect(shouldHideForCMS(eo, env('', ['sqs-edit-mode-active']))).toBe(true)
    // Squarespace doesn't care about ?et_fb=1 (different CMS)
    expect(shouldHideForCMS(eo, env('?et_fb=1', []))).toBe(false)
  })

  it('legacy raw flags are still honored when cms is unset/none', () => {
    // Tenants configured before the CMS dropdown landed have boolean flags.
    expect(shouldHideForCMS({ skipLoggedIn: true }, env('', ['logged-in']))).toBe(true)
    expect(shouldHideForCMS({ skipLoggedIn: true }, env('', []))).toBe(false)
    expect(shouldHideForCMS({ skipDivi: true }, env('?et_fb=1', []))).toBe(true)
    expect(shouldHideForCMS({ skipDivi: true }, env('', []))).toBe(false)
    // Both
    expect(shouldHideForCMS({ skipDivi: true, skipLoggedIn: true }, env('?et_fb=1', []))).toBe(true)
  })

  it('legacy flags also coexist with a cms preset (additive, not exclusive)', () => {
    // If a tenant has cms=wordpress AND legacy skipDivi, both apply.
    const eo = { cms: 'wordpress', skipDivi: true }
    expect(shouldHideForCMS(eo, env('?et_fb=1', []))).toBe(true)
    expect(shouldHideForCMS(eo, env('', ['logged-in']))).toBe(true)
  })
})

// ── deriveBaseUrl ──────────────────────────────────────────────────────────────

describe('deriveBaseUrl', () => {
  it('SaaS path: derives <slug>.wildcaresolutions.org from data-tenant + embed host', () => {
    expect(deriveBaseUrl({
      tenantSlug: 'wildcare',
      scriptSrc: 'https://embed.wildcaresolutions.org/v1.js',
    })).toBe('https://wildcare.wildcaresolutions.org')
  })

  it('also matches when the script host is the tenant subdomain itself', () => {
    expect(deriveBaseUrl({
      tenantSlug: 'wildcare',
      scriptSrc: 'https://wildcare.wildcaresolutions.org/widget.js',
    })).toBe('https://wildcare.wildcaresolutions.org')
  })

  it('also matches when loaded from the apex', () => {
    expect(deriveBaseUrl({
      tenantSlug: 'other',
      scriptSrc: 'https://wildcaresolutions.org/widget.js',
    })).toBe('https://other.wildcaresolutions.org')
  })

  it('falls back to script origin when tenantSlug is missing', () => {
    expect(deriveBaseUrl({
      scriptSrc: 'https://embed.wildcaresolutions.org/v1.js',
    })).toBe('https://embed.wildcaresolutions.org')
  })

  it('falls back to script origin when host is not wildcaresolutions.org', () => {
    // Self-hosted on a customer's own domain.
    expect(deriveBaseUrl({
      tenantSlug: 'wildcare',
      scriptSrc: 'https://customer-site.com/widget.js',
    })).toBe('https://customer-site.com')
  })

  it('returns empty string when no scriptSrc', () => {
    expect(deriveBaseUrl({ tenantSlug: 'wildcare' })).toBe('')
    expect(deriveBaseUrl({})).toBe('')
    expect(deriveBaseUrl()).toBe('')
  })

  it('does not treat a host that merely contains "wildcaresolutions.org" as ours', () => {
    // Suffix-match guard: `evil-wildcaresolutions.org` is NOT us. The
    // `endsWith` check in the original code relied on the dotted-prefix
    // rule from URL parsing, but verifying explicitly here.
    expect(deriveBaseUrl({
      tenantSlug: 'wildcare',
      scriptSrc: 'https://evilwildcaresolutions.org/widget.js',
    })).toBe('https://evilwildcaresolutions.org')
    // The genuine subdomain still works:
    expect(deriveBaseUrl({
      tenantSlug: 'wildcare',
      scriptSrc: 'https://embed.wildcaresolutions.org/v1.js',
    })).toBe('https://wildcare.wildcaresolutions.org')
  })

  it('handles a bad scriptSrc by falling through to empty string', () => {
    // URL constructor throws on garbage; we expect graceful fallback.
    expect(deriveBaseUrl({ tenantSlug: 'wildcare', scriptSrc: '' })).toBe('')
  })
})

// ── sameOrigin ─────────────────────────────────────────────────────────────────────────────

describe('sameOrigin', () => {
  it('two empty strings are same-origin', () => {
    expect(sameOrigin('', '')).toBe(true)
  })

  it('one empty, one non-empty is not same-origin', () => {
    expect(sameOrigin('', 'https://example.com')).toBe(false)
    expect(sameOrigin('https://example.com', '')).toBe(false)
  })

  it('same scheme+host+port are same-origin', () => {
    expect(sameOrigin('https://example.com', 'https://example.com')).toBe(true)
    expect(sameOrigin('https://example.com/foo', 'https://example.com/bar')).toBe(true)
    expect(sameOrigin(
      'https://slug.wildcaresolutions.org',
      'https://slug.wildcaresolutions.org',
    )).toBe(true)
  })

  it('different host is not same-origin', () => {
    expect(sameOrigin('https://example.com', 'https://attacker.com')).toBe(false)
    expect(sameOrigin('https://slug.wildcaresolutions.org', 'https://evil.example.com')).toBe(false)
  })

  it('different scheme is not same-origin', () => {
    expect(sameOrigin('https://example.com', 'http://example.com')).toBe(false)
  })

  it('different port is not same-origin', () => {
    expect(sameOrigin('https://example.com:8443', 'https://example.com')).toBe(false)
    expect(sameOrigin('http://localhost:8787', 'http://localhost:9000')).toBe(false)
  })

  it('same-origin localhost dev URLs', () => {
    expect(sameOrigin('http://localhost:8787', 'http://localhost:8787')).toBe(true)
    expect(sameOrigin('http://localhost:8787/api', 'http://localhost:8787')).toBe(true)
  })

  it('malformed URL returns false', () => {
    expect(sameOrigin('not-a-url', 'https://example.com')).toBe(false)
    expect(sameOrigin('https://example.com', 'not-a-url')).toBe(false)
  })
})
