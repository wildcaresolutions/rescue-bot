// Pure helpers extracted from widget.js so they can be unit-tested without
// DOM mocking. Each takes its environmental inputs as plain parameters; the
// widget itself wraps these with document/window/script reads.

/**
 * Decide whether the widget should NOT mount on the current page.
 *
 * Driven by widget_theme.embedOptions.cms (server-side config). The widget
 * reads the result and short-circuits initWidget() when this returns true.
 *
 * @param {object} embedOptions - tenant.widget_theme.embedOptions JSON
 * @param {object} env
 * @param {string} env.search   - window.location.search
 * @param {string[]} env.bodyClassList - tokens of document.body.classList
 * @returns {boolean} true → widget should hide on this page
 */
export function shouldHideForCMS(embedOptions, env) {
  if (!embedOptions) return false
  const cms = typeof embedOptions.cms === 'string' ? embedOptions.cms : 'none'
  const search = env?.search ?? ''
  const cls = env?.bodyClassList ?? []
  const has = (tok) => cls.includes(tok)
  const hasParam = (re) => re.test(search)

  switch (cms) {
  case 'wordpress':
    if (has('logged-in')) return true
    break
  case 'wordpress-divi':
    if (has('logged-in') || hasParam(/[?&]et_fb=1\b/)) return true
    break
  case 'wordpress-elementor':
    if (has('logged-in') || hasParam(/[?&]elementor-preview=/)) return true
    break
  case 'squarespace':
    if (has('sqs-edit-mode-active')) return true
    break
  default:
    break
  }
  // Legacy: tenants set up before the cms picker may have raw boolean flags.
  if (embedOptions.skipDivi && hasParam(/[?&]et_fb=1\b/)) return true
  if (embedOptions.skipLoggedIn && has('logged-in')) return true
  return false
}

/**
 * Pick the API origin the widget should call.
 *
 * Priority (highest first):
 *   1. Explicit `userBaseUrl` (legacy / self-hosted override)
 *   2. `<slug>.wildcaresolutions.org` if tenantSlug is set AND scriptSrc is on
 *      a *.wildcaresolutions.org host — the SaaS default
 *   3. The script's own origin
 *   4. Empty string (caller falls back to relative `/api/...`)
 *
 * @param {object} input
 * @param {string} [input.userBaseUrl] - window.RescueBotChat.baseUrl
 * @param {string} [input.tenantSlug]  - <script data-tenant="...">
 * @param {string} [input.scriptSrc]   - the script tag's src URL
 * @returns {string}
 */
export function deriveBaseUrl({ userBaseUrl, tenantSlug, scriptSrc }) {
  if (userBaseUrl) return userBaseUrl

  if (scriptSrc) {
    try {
      const u = new URL(scriptSrc, 'https://example.com/')
      // Require a literal subdomain match so a host like
      // `evilwildcaresolutions.org` doesn't get treated as ours and
      // accidentally route API calls to a legit tenant subdomain. Apex is
      // explicitly allowed (apex hosts the marketing site, may serve embed
      // in some setups).
      const host = u.hostname
      const isOurDomain = host === 'wildcaresolutions.org' || host.endsWith('.wildcaresolutions.org')
      if (tenantSlug && isOurDomain) {
        return `https://${tenantSlug}.wildcaresolutions.org`
      }
      return u.origin
    } catch { /* fall through */ }
  }
  return ''
}
