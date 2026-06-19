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
    // Plain WordPress (no page builder): hide for any logged-in WP user.
    if (has('logged-in')) return true
    break
  case 'wordpress-divi':
    // Builder presets hide ONLY inside the active builder so the chat bubble
    // doesn't sit over the editor — the bot still works for logged-in admins on
    // normal pages (so they can test it on the real site).
    if (hasParam(/[?&]et_fb=1\b/)) return true
    break
  case 'wordpress-elementor':
    if (hasParam(/[?&]elementor-preview=/)) return true
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
 * Universal "are we inside a page-builder EDITOR canvas?" check — INDEPENDENT of
 * any tenant config. A builder's editing surface (Divi Visual Builder, Elementor
 * editor, …) is never a place for a live chat widget, for ANY tenant. Crucially
 * this uses only LOCAL DOM signals, so it works even when /api/config can't load
 * — which it often can't inside a builder, the exact case where the
 * config-driven shouldHideForCMS check silently no-ops and the widget wrongly
 * shows. The widget calls this BEFORE fetching config or mounting anything.
 *
 * @param {object} env
 * @param {string} env.search          - window.location.search
 * @param {string[]} env.bodyClassList - document.body.classList tokens
 * @param {string[]} env.htmlClassList - document.documentElement.classList tokens
 * @returns {boolean} true → do not mount the widget here
 */
export function inPageBuilderEditor(env) {
  const search = env?.search ?? ''
  const cls = [...(env?.bodyClassList ?? []), ...(env?.htmlClassList ?? [])]
  const hasClass = (pred) => cls.some(pred)
  // Divi Visual Builder: ?et_fb=1, or the et-fb / et-fb-* root classes it stamps
  // on <html>/<body> (present even when the URL param isn't where we look).
  if (/[?&]et_fb=1\b/.test(search)) return true
  if (hasClass((c) => c === 'et-fb' || c.startsWith('et-fb-'))) return true
  // Elementor editor / preview.
  if (/[?&]elementor-preview=/.test(search)) return true
  if (hasClass((c) => c === 'elementor-editor-active')) return true
  return false
}

/**
 * Compare the origins of two URL strings.
 *
 * Both values may be the empty string (relative origin — caller falls back to
 * the page's own origin via relative fetch). Two empty strings are considered
 * the same origin. Returns false for any malformed / unparseable URL.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameOrigin(a, b) {
  if (!a && !b) return true
  if (!a || !b) return false
  try {
    return new URL(a).origin === new URL(b).origin
  } catch { return false }
}

/**
 * Pick the API origin the widget should call.
 *
 * Priority (highest first):
 *   1. `<slug>.wildcaresolutions.org` if tenantSlug is set AND scriptSrc is on
 *      a *.wildcaresolutions.org host — the SaaS default
 *   2. The script's own origin
 *   3. Empty string (caller falls back to relative `/api/...`)
 *
 * window.RescueBotChat.baseUrl overrides are intentionally NOT accepted here.
 * The widget validates them separately via `sameOrigin` in widget.js before
 * passing them on — accepting a cross-origin override without validation would
 * let a compromised embedding page redirect all API/data traffic elsewhere.
 *
 * @param {object} input
 * @param {string} [input.tenantSlug]  - <script data-tenant="...">
 * @param {string} [input.scriptSrc]   - the script tag's src URL
 * @returns {string}
 */
export function deriveBaseUrl({ tenantSlug, scriptSrc } = {}) {
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
