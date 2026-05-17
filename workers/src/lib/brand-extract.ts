/**
 * Brand extraction pipeline.
 * Multi-strategy approach for colors and fonts.
 *
 * Colors: meta tags → SVG favicon → CSS variables → CSS frequency
 * Fonts: Google Fonts links → @font-face → CSS font-family → Google Fonts API match
 *
 * Shared fetch cache deduplicates HTTP calls across extractors.
 */

import { matchGoogleFont } from './google-fonts'
import { safeFetch } from './safe-url'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ColorExtractionResult {
  confidence: 'high' | 'medium' | 'low'
  colors: {
    primary?: string
    secondary?: string
    accent?: string
  }
  source: string
  evidence: string[]
  all_candidates: Array<{ hex: string; role: string; weight: number }>
  /**
   * Best-guess URL of the org's primary logo image (header img, og:image,
   * apple-touch-icon, etc.). Surfaced in the admin swatch card so the user
   * can visually compare detected colors against the actual logo and
   * override quickly if extraction missed.
   */
  logoUrl?: string
}

export interface FontExtractionResult {
  confidence: 'high' | 'medium' | 'low'
  fonts: {
    heading?: { name: string; googleFontsMatch?: string; source: string }
    body?: { name: string; googleFontsMatch?: string; source: string }
  }
  evidence: string[]
}

export interface BrandExtractionResult {
  colors: ColorExtractionResult
  fonts: FontExtractionResult
  fetchDuration: number
}

interface PageData {
  html: string
  cssTexts: string[]
  svgFavicon: string | null
  /** Best-guess logo image URL — already abs-resolved. Surfaced in the swatch card. */
  logoUrl: string | null
  /** Raw SVG content of the logo image, if the logo URL was an SVG. We can
   * extract fills/strokes from this directly (no image decoder needed). */
  logoSvg: string | null
  url: string
}

// ── Constants ────────────────────────────────────────────────────────────────

const BORING = new Set([
  '#000000', '#ffffff', '#333333', '#666666', '#999999', '#cccccc',
  '#eeeeee', '#f5f5f5', '#dddddd', '#aaaaaa', '#111111', '#222222',
  '#444444', '#555555', '#777777', '#888888', '#bbbbbb', '#f8f8f8',
  '#fafafa', '#e5e5e5', '#d4d4d4', '#737373', '#a3a3a3', '#f0f0f0',
])

// Colors from ubiquitous third-party widgets (Google sign-in, Shopify badge)
// that appear on many sites regardless of the site's own brand.
const THIRD_PARTY = new Set([
  '#4285f4', '#34a853', '#fbbc04', '#ea4335', '#fbbc05', // Google
  '#95bf47', '#5e8e3e', // Shopify
])

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Best-effort logo URL for an org's site. Tries — in order of brand
 * intent — the og:image meta tag, an <img> inside <header> with "logo" in
 * its src/alt/class, an <a class="logo"> with a child img, then the
 * apple-touch-icon, then the standard favicon. Returns null when nothing
 * looks logo-shaped.
 *
 * Surfaced in the admin's swatch card so the operator immediately sees
 * "that's our actual logo" — and can spot mismatches when the extractor
 * grabs catalog colors instead of brand colors.
 */
function findLogoUrl(html: string, baseUrl: string): string | null {
  const absolutize = (raw: string): string | null => {
    if (!raw) return null
    try { return new URL(raw, baseUrl).href }
    catch { return null }
  }

  // Sources, ranked by how likely they are to be the actual logo:
  const candidates: Array<string | null> = []

  // og:image is usually the share card — often the logo or a logo-on-color graphic
  candidates.push(html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? null)
  candidates.push(html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1] ?? null)

  // <header>…<img src="…logo…">
  const headerMatch = html.match(/<header[\s\S]{0,4000}?<\/header>/i)?.[0]
  if (headerMatch) {
    const logoImg = headerMatch.match(/<img[^>]*(?:src|data-src)=["']([^"']*(?:logo|brand)[^"']*)["']/i)?.[1]
      || headerMatch.match(/<img[^>]*alt=["'][^"']*logo[^"']*["'][^>]*(?:src|data-src)=["']([^"']+)["']/i)?.[1]
      || headerMatch.match(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/)?.[1] // fallback: first img in header
    candidates.push(logoImg ?? null)
  }

  // a.logo > img / .site-logo img / .navbar-brand img  (Bootstrap, common WP themes)
  const classLogo = html.match(/<(?:a|div|span)[^>]*class=["'][^"']*(?:logo|site-logo|navbar-brand|brand-logo)[^"']*["'][^>]*>[\s\S]{0,500}?<img[^>]+(?:src|data-src)=["']([^"']+)["']/i)?.[1]
  candidates.push(classLogo ?? null)

  // Apple touch icon (typically the brand mark)
  candidates.push(html.match(/<link[^>]*rel=["']apple-touch-icon[^"']*["'][^>]*href=["']([^"']+)["']/i)?.[1] ?? null)

  // Last resort: standard favicon
  candidates.push(html.match(/<link[^>]*rel=["'](?:icon|shortcut icon)["'][^>]*href=["']([^"']+\.(?:png|svg|ico)[^"']*)["']/i)?.[1] ?? null)

  for (const c of candidates) {
    const url = absolutize(c ?? '')
    if (url) return url
  }
  return null
}

function normalizeHex(c: string): string {
  c = c.toLowerCase().trim()
  if (c.length === 4) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`
  return c.slice(0, 7)
}

function isInteresting(hex: string): boolean {
  return hex.length === 7 && !BORING.has(hex) && !THIRD_PARTY.has(hex)
}

function hexDistance(a: string, b: string): number {
  const r1 = parseInt(a.slice(1, 3), 16), g1 = parseInt(a.slice(3, 5), 16), b1 = parseInt(a.slice(5, 7), 16)
  const r2 = parseInt(b.slice(1, 3), 16), g2 = parseInt(b.slice(3, 5), 16), b2 = parseInt(b.slice(5, 7), 16)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

function hexToHSL(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0, s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  return { h: h * 360, s: s * 100, l: l * 100 }
}

/**
 * Pick secondary + accent from the candidate list. Prefers strong-weighted
 * candidates (header/nav/CTA usage) over the mathematically-farthest hue from
 * primary — the old approach surfaced near-whites and pale tints because RGB
 * distance treats #f8fafc as "very far from forest green" even though it's
 * just background-ish chrome that the user almost never wants as a brand
 * accent. Filters out near-white, near-black, and washed-out greys so they
 * can't win even when nothing more saturated exists.
 */
function pickSecondaryAccent(
  primary: string,
  candidates: Array<{ hex: string; weight: number }>,
): { secondary?: string; accent?: string } {
  // Dedupe by hex, keeping the MAX weight observed for each color.
  // The old "first occurrence wins" was a real bug: PHS-SPCA's #2ea3f2 shows
  // up first as `a{color:#2ea3f2}` (weight 40 — Divi default link color),
  // then later as `.button{background:#2ea3f2}` (weight 55). First-wins
  // locked in 40 and dropped the 55 entry, then the orange #c96310 (also
  // weight 55) tied on insertion order — usually losing because anchor
  // styles come earlier in stylesheets than CTA hovers. Max-weight dedup
  // also makes output deterministic for the same input.
  const byHex = new Map<string, { hex: string; weight: number }>()
  for (const c of candidates) {
    if (c.hex === primary || !isInteresting(c.hex)) continue
    const { s, l } = hexToHSL(c.hex)
    // Reject washed-out (s<15%), near-white (l>92%), near-black (l<8%).
    if (s < 15 || l > 92 || l < 8) continue
    const existing = byHex.get(c.hex)
    if (!existing || existing.weight < c.weight) byHex.set(c.hex, c)
  }
  // Sort by weight desc, then hex asc as a stable tiebreaker so the same
  // input always produces the same output.
  const usable = [...byHex.values()].sort((a, b) =>
    b.weight - a.weight || (a.hex < b.hex ? -1 : 1),
  )

  const secondary = usable[0]?.hex
  // Accent: highest-weight remaining color that's visually distinct from
  // secondary, falling back to second-highest weight if everything is close.
  const accent = usable.slice(1).find(c =>
    secondary ? hexDistance(c.hex, secondary) > 60 : true,
  )?.hex ?? usable[1]?.hex
  return { secondary, accent }
}

/** Generate secondary + accent from a single primary via HSL color harmony */
export function generateHarmonyPalette(primaryHex: string): { secondary: string; accent: string } {
  const r = parseInt(primaryHex.slice(1, 3), 16) / 255
  const g = parseInt(primaryHex.slice(3, 5), 16) / 255
  const b = parseInt(primaryHex.slice(5, 7), 16) / 255

  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0, s = 0

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }

  const hDeg = h * 360
  const sPct = s * 100
  const lPct = l * 100

  // Secondary: same hue, reduce saturation by 20%, increase lightness by 15%
  const secS = Math.max(0, sPct - 20)
  const secL = Math.min(100, lPct + 15)

  // Accent: analogous hue (+30 degrees), similar saturation and lightness
  const accH = (hDeg + 30) % 360
  const accS = sPct
  const accL = lPct

  return {
    secondary: hslToHex(hDeg, secS, secL),
    accent: hslToHex(accH, accS, accL),
  }
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * color).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/**
 * Parse "H,S%,L%" or "H S% L%" or "hsl(H,S%,L%)" into a hex color, or null
 * if the form is bad. Squarespace defines its entire palette as HSL variables
 * (--accent-hsl: 15.53,37.78%,44.12%) and never as raw hex — without this
 * parser we can't see the brand at all on Squarespace sites.
 */
function parseHSLTriple(raw: string): string | null {
  const cleaned = raw.replace(/^hsla?\(/, '').replace(/\)$/, '').trim()
  const parts = cleaned.split(/[,\s/]+/).filter(Boolean).slice(0, 3)
  if (parts.length < 3) return null
  const h = parseFloat(parts[0])
  const s = parseFloat(parts[1])
  const l = parseFloat(parts[2])
  if (!isFinite(h) || !isFinite(s) || !isFinite(l)) return null
  if (s < 0 || s > 100 || l < 0 || l > 100) return null
  return hslToHex(((h % 360) + 360) % 360, s, l)
}

/**
 * Parse rgb()/rgba() — both legacy comma form and CSS Color 4 space form.
 * Returns hex, or null if malformed. Modern Tailwind sites and Shopify
 * themes increasingly use rgb() with custom-property channels; we'd
 * otherwise miss those colors entirely.
 */
function parseRGB(raw: string): string | null {
  const m = raw.match(/^rgba?\(([^)]+)\)$/i)
  if (!m) return null
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3)
  if (parts.length < 3) return null
  const ch = parts.map(p => {
    const n = p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p)
    return isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : null
  })
  if (ch.some(v => v === null)) return null
  return '#' + (ch as number[]).map(v => v.toString(16).padStart(2, '0')).join('')
}

/**
 * Parse oklch()/lch() into hex. Tailwind 4 ships oklch by default and many
 * 2025-era design systems are migrating off HSL, so brand colors on those
 * sites are invisible to us without this. Implementation: oklch -> oklab ->
 * linear sRGB -> sRGB (gamma-corrected) -> hex. Returns null if input is
 * outside the parsable shape.
 */
function parseOKLCH(raw: string): string | null {
  const m = raw.match(/^oklch\(([^)]+)\)$/i)
  if (!m) return null
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3)
  if (parts.length < 3) return null
  const L = (parts[0].endsWith('%') ? parseFloat(parts[0]) / 100 : parseFloat(parts[0]))
  const C = parseFloat(parts[1])
  const H = parseFloat(parts[2])
  if (!isFinite(L) || !isFinite(C) || !isFinite(H)) return null
  // OKLCH -> OKLab
  const a = C * Math.cos(H * Math.PI / 180)
  const b = C * Math.sin(H * Math.PI / 180)
  // OKLab -> linear LMS via inverse M2
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const lL = l_ ** 3, mL = m_ ** 3, sL = s_ ** 3
  // LMS -> linear sRGB via inverse M1
  const lr =  4.0767416621 * lL - 3.3077115913 * mL + 0.2309699292 * sL
  const lg = -1.2684380046 * lL + 2.6097574011 * mL - 0.3413193965 * sL
  const lb = -0.0041960863 * lL - 0.7034186147 * mL + 1.7076147010 * sL
  // gamma-correct
  const toSRGB = (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    return x >= 0.0031308 ? 1.055 * Math.pow(x, 1 / 2.4) - 0.055 : 12.92 * x
  }
  const r = Math.round(toSRGB(lr) * 255)
  const g = Math.round(toSRGB(lg) * 255)
  const bch = Math.round(toSRGB(lb) * 255)
  return '#' + [r, g, bch].map(v => v.toString(16).padStart(2, '0')).join('')
}

/**
 * Last-stop "any color value" parser: hex, hsl(), oklch(), rgb(), or
 * Squarespace-style raw HSL triples. Returns null if it doesn't recognize
 * the form. Used by every per-format strategy below so each one stays
 * focused on WHERE the value lives, not on PARSING — that's done once here.
 */
function parseAnyColor(raw: string): string | null {
  const v = raw.trim()
  // hex
  const hexM = v.match(/^#[0-9a-fA-F]{3,8}$/)
  if (hexM) return normalizeHex(v)
  if (/^hsla?\(/i.test(v)) return parseHSLTriple(v)
  if (/^rgba?\(/i.test(v)) return parseRGB(v)
  if (/^oklch\(/i.test(v)) return parseOKLCH(v)
  // Bare HSL triple ("15.53,37.78%,44.12%") — Squarespace's --accent-hsl form
  if (/^[\d.]+\s*[,\s]\s*[\d.]+%\s*[,\s]\s*[\d.]+%/.test(v)) return parseHSLTriple(v)
  return null
}

// ── BrandExtractor ───────────────────────────────────────────────────────────

export class BrandExtractor {
  private fetchCache = new Map<string, string | null>()

  private async fetchText(url: string): Promise<string | null> {
    if (this.fetchCache.has(url)) return this.fetchCache.get(url)!
    try {
      // safeFetch refuses http://, private IPs (10/8, 127/8, 169.254/16,
      // 172.16/12, 192.168/16, etc.), file://data:javascript: schemes, and
      // 3xx redirects to any of those. This matters because BrandExtractor
      // fetches URLs derived from page content — favicon hrefs, CSS hrefs,
      // manifest hrefs — which a malicious site could craft to point at
      // internal infrastructure.
      const res = await safeFetch(url, {
        headers: { 'User-Agent': 'RescueBot/1.0' },
        maxRedirects: 3,
      })
      if (!res.ok) {
        this.fetchCache.set(url, null)
        return null
      }
      const text = (await res.text()).slice(0, 100_000)
      this.fetchCache.set(url, text)
      return text
    } catch {
      // UnsafeUrlError lands here too — treat any failure as "couldn't
      // fetch", cache the null so we don't retry on the same input.
      this.fetchCache.set(url, null)
      return null
    }
  }

  async fetchPage(url: string): Promise<PageData | null> {
    // Normalize bare hostnames ("phs-spca.org") — fetch() throws on those
    // and the agent then has to retry with the user. The retry message ("I
    // wasn't able to reach…") is annoying when the user just typed the host.
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '')

    const html = await this.fetchText(url)
    if (!html) return null

    // Fetch SVG favicon
    const svgFaviconHref = html.match(/<link[^>]*href=["']([^"']+\.svg[^"']*)["'][^>]*rel=["'][^"]*icon[^"]*["']/i)?.[1]
      || html.match(/<link[^>]*rel=["'][^"]*icon[^"]*["'][^>]*href=["']([^"']+\.svg[^"']*)["']/i)?.[1]

    // Collect CSS hrefs. We used to cap at 5 — too small for WP sites,
    // which routinely ship 20+ stylesheets where the actual brand colors
    // live in the theme's customizer file (e.g. PHS-SPCA's #c96310 CTA
    // hover color is in stylesheet #22). Sort theme-looking files first
    // so we always fetch them before icon-font / plugin filler.
    const allHrefs = (html.match(/<link[^>]*href=["']([^"']+\.css[^"']*)["']/gi) || [])
      .map(tag => tag.match(/href=["']([^"']+)["']/)?.[1])
      .filter(Boolean) as string[]
    const themeFirst = (h: string) => /(?:theme|customizer|child[/-]?style|style-static|main\.css|brand)/i.test(h) ? 0 : 1
    const cssHrefs = allHrefs
      .sort((a, b) => themeFirst(a) - themeFirst(b))
      .slice(0, 15)

    // Fetch SVG favicon + CSS files + manifest in parallel (D3: parallelize fetches)
    const manifestHref = html.match(/<link[^>]*rel=["']manifest["'][^>]*href=["']([^"']+)["']/i)?.[1]

    const fetchPromises: Promise<void>[] = []
    let svgFavicon: string | null = null
    let manifestText: string | null = null
    const cssTexts: string[] = []

    // Inline styles first (no fetch needed)
    const inlineStyles = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []
    for (const block of inlineStyles) {
      cssTexts.push(block.replace(/<\/?style[^>]*>/gi, ''))
    }

    // SVG favicon fetch
    if (svgFaviconHref) {
      const svgUrl = svgFaviconHref.startsWith('http') ? svgFaviconHref : new URL(svgFaviconHref, url).href
      fetchPromises.push(this.fetchText(svgUrl).then(text => { svgFavicon = text }))
    }

    // Manifest fetch
    if (manifestHref) {
      const manifestUrl = manifestHref.startsWith('http') ? manifestHref : new URL(manifestHref, url).href
      fetchPromises.push(this.fetchText(manifestUrl).then(text => { manifestText = text }))
    }

    // Logo image: if it's an SVG, fetch + parse fills directly. The logo is
    // the most direct visual brand signal — when CSS heuristics flounder, the
    // logo's own colors are usually the brand. Raster (PNG/JPG) logos we
    // can't decode in a Worker without an image library; we still surface
    // the URL to the UI for visual override.
    const logoUrl = findLogoUrl(html, url)
    let logoSvg: string | null = null
    if (logoUrl && /\.svg(?:\?|$)/i.test(logoUrl)) {
      fetchPromises.push(this.fetchText(logoUrl).then(text => { logoSvg = text }))
    }

    // CSS file fetches
    for (const href of cssHrefs) {
      const cssUrl = href.startsWith('http') ? href : new URL(href, url).href
      fetchPromises.push(this.fetchText(cssUrl).then(text => { if (text) cssTexts.push(text) }))
    }

    await Promise.all(fetchPromises)

    // Store manifest in cache for color extraction to use
    if (manifestText) {
      this.fetchCache.set('__manifest__', manifestText)
    }

    return { html, cssTexts, svgFavicon, logoUrl, logoSvg, url }
  }

  extractColors(page: PageData): ColorExtractionResult {
    const { html, cssTexts, svgFavicon, logoUrl: pageLogoUrl, logoSvg } = page
    const evidence: string[] = []
    const candidates: Array<{ hex: string; role: string; weight: number }> = []

    // ── Strategy 1: Meta tags ──────────────────────────────────────────────
    const themeColor = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i)?.[1]
    if (themeColor && themeColor.startsWith('#')) {
      const hex = normalizeHex(themeColor)
      candidates.push({ hex, role: 'primary', weight: 100 })
      evidence.push(`theme-color: ${hex}`)
    }

    const tileColor = html.match(/<meta[^>]*name=["']msapplication-TileColor["'][^>]*content=["']([^"']+)["']/i)?.[1]
    if (tileColor && tileColor.startsWith('#')) {
      candidates.push({ hex: normalizeHex(tileColor), role: 'primary', weight: 90 })
      evidence.push(`msapplication-TileColor: ${tileColor}`)
    }

    // Web manifest (already fetched in fetchPage)
    const manifestText = this.fetchCache.get('__manifest__')
    if (manifestText) {
      try {
        const m = JSON.parse(manifestText)
        if (m.theme_color) {
          candidates.push({ hex: normalizeHex(m.theme_color), role: 'primary', weight: 95 })
          evidence.push(`manifest theme_color: ${m.theme_color}`)
        }
      } catch { /* bad JSON */ }
    }

    // ── Strategy 2: SVG favicon ────────────────────────────────────────────
    if (svgFavicon) {
      const svgColors = svgFavicon.match(/(?:fill|stroke)=["']#[0-9a-fA-F]{3,8}["']/gi) || []
      const bgFills = svgFavicon.match(/<rect[^>]*fill=["']#([0-9a-fA-F]{3,8})["']/gi) || []
      for (const match of [...svgColors, ...bgFills]) {
        const hex = normalizeHex((match.match(/#[0-9a-fA-F]{3,8}/)?.[0]) || '')
        if (hex.length === 7 && isInteresting(hex)) {
          candidates.push({ hex, role: 'primary', weight: 85 })
          evidence.push(`SVG favicon fill: ${hex}`)
        }
      }
    }

    // ── Strategy 3: CSS variables ──────────────────────────────────────────
    const allCSS = cssTexts.join('\n')

    // CSS custom properties with brand-related names.
    // 79, not 80: keeps CSS vars at "medium" confidence (threshold is >=80), requiring user confirmation.
    //
    // 'theme' is intentionally NOT in this list — it's a false positive in WP
    // themes that ship a catalog like `--theme-color-1: blue; --theme-color-2:
    // green` (same problem as `--wp--preset--color--*`). PHS-SPCA's site has
    // a green visible brand but its `--theme: #007cba` declaration gets us to
    // pick blue. Generic theme vars now go through the WP-preset-tier path
    // (low weight) instead of beating real CSS-frequency signal.
    const brandVarPattern = /--[a-z-]*(primary|brand|main|accent|secondary)[a-z-]*\s*:\s*#([0-9a-fA-F]{3,8})/gi
    let varMatch: RegExpExecArray | null
    while ((varMatch = brandVarPattern.exec(allCSS)) !== null) {
      const hex = normalizeHex('#' + varMatch[2])
      if (hex.length === 7 && isInteresting(hex)) {
        const keyword = varMatch[1].toLowerCase()
        const role = keyword === 'accent' ? 'accent' : keyword === 'secondary' ? 'secondary' : 'primary'
        candidates.push({ hex, role, weight: 79 })
        evidence.push(`CSS var --*${keyword}*: ${hex}`)
      }
    }

    // Same-name patterns but for HSL variables — Squarespace and modern
    // Shopify/Webflow themes define brand colors purely as HSL triples
    // (e.g. `--accent-hsl: 15.53,37.78%,44.12%`) which the hex regex above
    // can't see. Without this strategy the extractor has zero brand signal
    // on any Squarespace site and falls back to scraping random link blues.
    //
    // Match either `--name-hsl: H,S%,L%` (Squarespace's convention) or
    // `--brand-color: hsl(H S% L%)` (newer CSS-color-4 sites). Same scoring
    // as the hex variant — these are explicit brand declarations.
    const brandHSLPattern = /--[a-z-]*(primary|brand|main|accent|secondary)[a-z-]*(?:-hsl)?\s*:\s*(?:hsla?\([^)]+\)|[\d.]+\s*[, ]\s*[\d.]+%\s*[, ]\s*[\d.]+%)/gi
    let hslMatch: RegExpExecArray | null
    while ((hslMatch = brandHSLPattern.exec(allCSS)) !== null) {
      const valuePart = hslMatch[0].slice(hslMatch[0].indexOf(':') + 1).trim()
      const hex = parseHSLTriple(valuePart)
      if (!hex || !isInteresting(hex)) continue
      const keyword = hslMatch[1].toLowerCase()
      // Ignore pure-grey / near-white HSL palette entries (Squarespace ships
      // --black-hsl: 0,0%,8% etc. — those would otherwise win as primary on a
      // site whose actual brand is also defined here).
      const { s, l } = hexToHSL(hex)
      if (s < 10 || l > 95 || l < 5) continue
      const role = keyword === 'accent' ? 'accent' : keyword === 'secondary' ? 'secondary' : 'primary'
      candidates.push({ hex, role, weight: 79 })
      evidence.push(`CSS HSL var --*${keyword}*: ${hex}`)
    }

    // Generic --theme / --theme-color-N catalog vars (WP & many themes ship
    // these as a designer palette, not a brand assertion). Demoted to 35 so
    // they only bubble up when nothing stronger exists; the user still sees
    // them in all_candidates for manual override.
    const themeVarPattern = /--theme(?:-color)?(?:-\d+)?\s*:\s*#([0-9a-fA-F]{3,8})/gi
    let themeMatch: RegExpExecArray | null
    while ((themeMatch = themeVarPattern.exec(allCSS)) !== null) {
      const hex = normalizeHex('#' + themeMatch[1])
      if (hex.length === 7 && isInteresting(hex)) {
        candidates.push({ hex, role: 'primary', weight: 35 })
        evidence.push(`generic --theme var: ${hex} (catalog, not necessarily brand)`)
      }
    }

    // WordPress-specific: --wp--preset--color--*
    // These are the THEME's color CATALOG — every option a theme designer
    // shipped, not necessarily what the org's brand actually uses. Peninsula
    // Humane Society's site exposes 7+ preset colors (luminous-vivid-amber,
    // luminous-vivid-orange, etc.) but the visible brand is green; the WP
    // catalog still made our extractor pick blue+yellow+orange. Now scored
    // low (35) so they don't beat actual usage signals from CSS frequency.
    // They still appear in all_candidates for the user to pick from.
    const wpColorPattern = /--wp--preset--color--([a-z-]+)\s*:\s*#([0-9a-fA-F]{3,8})/gi
    let wpMatch: RegExpExecArray | null
    while ((wpMatch = wpColorPattern.exec(allCSS)) !== null) {
      const hex = normalizeHex('#' + wpMatch[2])
      if (hex.length === 7 && isInteresting(hex)) {
        candidates.push({ hex, role: 'primary', weight: 35 })
        evidence.push(`WP preset color "${wpMatch[1]}": ${hex} (catalog, not necessarily brand)`)
      }
    }

    // ── Strategy 3b: Platform-specific brand-color conventions ──────────────
    //
    // These are explicit brand declarations from popular CMS platforms.
    // Recognising them named-by-name lets us assign the right ROLE (primary
    // vs accent) instead of guessing. Same weight as the generic brand-var
    // pattern (79). Each entry: regex + role.
    const platformPatterns: Array<{ re: RegExp; role: string; label: string }> = [
      // Bootstrap (Bootstrap 4/5) — `--bs-primary`, `--bs-secondary`, etc.
      // Lots of nonprofit sites still ship Bootstrap.
      { re: /--bs-primary\s*:\s*([^;}\n]+)/gi, role: 'primary', label: 'Bootstrap --bs-primary' },
      { re: /--bs-secondary\s*:\s*([^;}\n]+)/gi, role: 'secondary', label: 'Bootstrap --bs-secondary' },
      { re: /--bs-info\s*:\s*([^;}\n]+)/gi, role: 'accent', label: 'Bootstrap --bs-info' },
      // Elementor (WordPress) — global colors named `--e-global-color-*`.
      { re: /--e-global-color-primary\s*:\s*([^;}\n]+)/gi, role: 'primary', label: 'Elementor primary' },
      { re: /--e-global-color-secondary\s*:\s*([^;}\n]+)/gi, role: 'secondary', label: 'Elementor secondary' },
      { re: /--e-global-color-accent\s*:\s*([^;}\n]+)/gi, role: 'accent', label: 'Elementor accent' },
      // Shopify Online Store 2.0 — `--color-primary`, `--color-button`, etc.
      // Distinct from a generic --primary because these names are emitted by
      // the Shopify themer engine and almost always carry brand intent.
      { re: /--color-button(?:-background)?\s*:\s*([^;}\n]+)/gi, role: 'accent', label: 'Shopify --color-button' },
      // Ghost publishing — `--ghost-accent-color` is the single brand color.
      { re: /--ghost-accent-color\s*:\s*([^;}\n]+)/gi, role: 'accent', label: 'Ghost --ghost-accent-color' },
      // Divi (WordPress) — accent-color is the global accent (besides what
      // already lives in the customizer file we now fetch).
      { re: /--accent-color\s*:\s*([^;}\n]+)/gi, role: 'accent', label: 'Divi --accent-color' },
    ]
    for (const { re, role, label } of platformPatterns) {
      let m: RegExpExecArray | null
      while ((m = re.exec(allCSS)) !== null) {
        const hex = parseAnyColor(m[1].trim())
        if (!hex || !isInteresting(hex)) continue
        candidates.push({ hex, role, weight: 79 })
        evidence.push(`${label}: ${hex}`)
      }
    }

    // ── Strategy 3c: Inline style="..." on root tags ────────────────────────
    //
    // Squarespace and a few other platforms write user-overrides for site
    // colors as inline custom-property declarations on <html> or <body>:
    //
    //   <html style="--accent-hsl: 15 38% 44%; --bg-hsl: 0 0% 99%">
    //
    // These never hit any external stylesheet, so without scanning the
    // inline `style` attribute we miss the user's actual theme overrides.
    const rootStyleMatches: string[] = []
    const htmlStyle = html.match(/<html[^>]*\sstyle=["']([^"']+)["']/i)?.[1]
    const bodyStyle = html.match(/<body[^>]*\sstyle=["']([^"']+)["']/i)?.[1]
    if (htmlStyle) rootStyleMatches.push(htmlStyle)
    if (bodyStyle) rootStyleMatches.push(bodyStyle)
    for (const styleAttr of rootStyleMatches) {
      // Each declaration is `--name: value;`
      const decls = styleAttr.match(/--[a-zA-Z][a-zA-Z0-9-]*\s*:\s*[^;]+/g) || []
      for (const decl of decls) {
        const ix = decl.indexOf(':')
        if (ix < 0) continue
        const name = decl.slice(2, ix).toLowerCase()
        const val = decl.slice(ix + 1).trim()
        if (!/(primary|brand|main|accent|secondary)/.test(name)) continue
        const hex = parseAnyColor(val)
        if (!hex || !isInteresting(hex)) continue
        const role = name.includes('accent') ? 'accent' : name.includes('secondary') ? 'secondary' : 'primary'
        candidates.push({ hex, role, weight: 82 })
        evidence.push(`inline style --${name}: ${hex}`)
      }
    }

    // ── Strategy 3d: Logo SVG fills ─────────────────────────────────────────
    //
    // The logo image is the most direct visual brand signal we can sample —
    // when the logo is an SVG, we can read its `fill=`/`stroke=` attrs
    // straight out of the markup without needing an image decoder. Every
    // distinct interesting color in the logo is brand-intent by definition,
    // so they get high weight. Raster (PNG/JPG) logos are skipped here —
    // we'd need a real image decoder, which is out of scope for a Worker
    // (the logo URL is still surfaced to the UI for visual override).
    if (logoSvg) {
      const seenInLogo = new Set<string>()
      const fillRe = /(?:fill|stroke|stop-color)\s*=\s*["']([^"']+)["']/gi
      let lm: RegExpExecArray | null
      while ((lm = fillRe.exec(logoSvg)) !== null) {
        if (lm[1].toLowerCase() === 'none') continue
        const hex = parseAnyColor(lm[1].trim())
        if (!hex || !isInteresting(hex)) continue
        if (seenInLogo.has(hex)) continue
        seenInLogo.add(hex)
        candidates.push({ hex, role: 'primary', weight: 85 })
        evidence.push(`logo SVG fill: ${hex}`)
      }
      // Also catch fills in inline SVG style="fill:#xxx" attributes.
      const styleFillRe = /style\s*=\s*["'][^"']*(?:fill|stroke|stop-color)\s*:\s*([^;"']+)/gi
      while ((lm = styleFillRe.exec(logoSvg)) !== null) {
        const hex = parseAnyColor(lm[1].trim())
        if (!hex || !isInteresting(hex)) continue
        if (seenInLogo.has(hex)) continue
        seenInLogo.add(hex)
        candidates.push({ hex, role: 'primary', weight: 85 })
        evidence.push(`logo SVG style: ${hex}`)
      }
    }

    // ── Strategy 4: CSS frequency with selector context ────────────────────
    const declPattern = /([^{}]+)\{[^}]*((?:background-color|background|color)\s*:\s*#[0-9a-fA-F]{3,8})[^}]*\}/gi
    let declMatch: RegExpExecArray | null
    while ((declMatch = declPattern.exec(allCSS)) !== null) {
      const selector = declMatch[1].toLowerCase()
      const hexMatch = declMatch[2].match(/#[0-9a-fA-F]{3,8}/)
      if (!hexMatch) continue
      const hex = normalizeHex(hexMatch[0])
      if (!isInteresting(hex)) continue

      let weight = 20
      let role = 'unknown'
      // Header/nav backgrounds. Word boundaries on the bare keywords —
      // without \b, "nav" matches "nav-single", ".navigation-pill", etc.,
      // pulling in dozens of links at 65 weight that drown out actual brand.
      if (/\bheader\b|\bnav\b|\.site-header|\.main-header|\.navbar|\.main-nav|\.top-nav|\.hero\b|\.banner\b/.test(selector)) { weight = 65; role = 'primary' }
      else if (/btn|button|\.cta|submit|get-started|donate|sign[-_]?up|signup|register|subscribe|join-?(?:us|now)/.test(selector)) { weight = 55; role = 'accent' }
      else if (/footer/.test(selector)) { weight = 30; role = 'secondary' }
      // Plain `a` color is the theme's default link color — almost always set
      // by the theme designer, not the brand owner. Below CTAs (55) so brand
      // CTA colors win for accent. PHS-SPCA's Divi default link blue
      // (#2ea3f2) used to beat their actual CTA orange (#c96310).
      else if (/^a\b|\.link/.test(selector)) { weight = 25; role = 'accent' }
      else if (/body|main|\.content/.test(selector)) { weight = 15; role = 'background' }

      candidates.push({ hex, role, weight })
    }

    const logoUrl = pageLogoUrl ?? undefined

    // ── Pick winners ─────────────────────────────────────────────────────────
    if (candidates.length === 0) {
      return {
        confidence: 'low',
        colors: {},
        source: 'none',
        evidence: ['No colors found in HTML, CSS, meta tags, or favicon'],
        all_candidates: [],
        logoUrl,
      }
    }

    candidates.sort((a, b) => b.weight - a.weight)

    const primaryCandidate = candidates.find(c => c.role === 'primary') || candidates[0]
    const primary = primaryCandidate.hex

    const { secondary, accent } = pickSecondaryAccent(primary, candidates)

    const topWeight = primaryCandidate.weight
    const confidence: 'high' | 'medium' | 'low' = topWeight >= 80 ? 'high' : topWeight >= 50 ? 'medium' : 'low'
    const source = topWeight >= 85 ? 'meta-or-favicon' : topWeight >= 60 ? 'css-variables' : 'css-frequency'

    return {
      confidence,
      colors: { primary, secondary, accent },
      source,
      evidence,
      all_candidates: candidates.slice(0, 15),
      logoUrl,
    }
  }

  async extractFonts(page: PageData): Promise<FontExtractionResult> {
    const { html, cssTexts } = page
    const evidence: string[] = []
    const detected: Array<{ name: string; role: 'heading' | 'body'; source: string }> = []
    const allCSS = cssTexts.join('\n')

    // ── Strategy 1: Google Fonts links ─────────────────────────────────────
    const gfLinks = html.match(/fonts\.googleapis\.com\/css2?\?[^"'<>]+/gi) || []
    for (const link of gfLinks) {
      const families = link.match(/family=([^&"'<>]+)/gi) || []
      for (const fam of families) {
        const name = decodeURIComponent(fam.replace(/^family=/, '').split(':')[0]).replace(/\+/g, ' ')
        if (name) {
          detected.push({ name, role: 'body', source: 'Google Fonts link' })
          evidence.push(`Google Fonts link: ${name}`)
        }
      }
    }

    // ── Strategy 2: @font-face declarations ────────────────────────────────
    const fontFacePattern = /@font-face\s*\{[^}]*font-family\s*:\s*['"]?([^;'"}\n]+)['"]?/gi
    let ffMatch: RegExpExecArray | null
    while ((ffMatch = fontFacePattern.exec(allCSS)) !== null) {
      const name = ffMatch[1].trim().replace(/['"]/g, '')
      if (name && !name.startsWith('dashicons') && !name.startsWith('fontawesome')) {
        detected.push({ name, role: 'body', source: '@font-face' })
        evidence.push(`@font-face: ${name}`)
      }
    }

    // ── Strategy 3: CSS font-family on key selectors ───────────────────────
    // Heading fonts
    const headingPattern = /(?:h[1-3]|\.hero|\.header-title|\.site-title)[^{]*\{[^}]*font-family\s*:\s*['"]?([^;'"}\n,]+)/gi
    let hMatch: RegExpExecArray | null
    while ((hMatch = headingPattern.exec(allCSS)) !== null) {
      const name = hMatch[1].trim().replace(/['"]/g, '')
      if (name && !isSystemFont(name)) {
        detected.push({ name, role: 'heading', source: 'CSS heading selector' })
        evidence.push(`Heading font: ${name}`)
      }
    }

    // Body fonts
    const bodyPattern = /(?:body|\.content|\.entry-content|main)[^{]*\{[^}]*font-family\s*:\s*['"]?([^;'"}\n,]+)/gi
    let bMatch: RegExpExecArray | null
    while ((bMatch = bodyPattern.exec(allCSS)) !== null) {
      const name = bMatch[1].trim().replace(/['"]/g, '')
      if (name && !isSystemFont(name)) {
        detected.push({ name, role: 'body', source: 'CSS body selector' })
        evidence.push(`Body font: ${name}`)
      }
    }

    // ── Deduplicate and assign roles ───────────────────────────────────────
    const headingFont = detected.find(f => f.role === 'heading') || detected[0]
    const bodyFont = detected.find(f => f.role === 'body' && f.name !== headingFont?.name) || detected.find(f => f.name !== headingFont?.name)

    // ── Match against Google Fonts ─────────────────────────────────────────
    const result: FontExtractionResult = {
      confidence: detected.length > 0 ? (gfLinks.length > 0 ? 'high' : 'medium') : 'low',
      fonts: {},
      evidence,
    }

    if (headingFont) {
      const gfMatch = await matchGoogleFont(headingFont.name)
      result.fonts.heading = {
        name: headingFont.name,
        googleFontsMatch: gfMatch || undefined,
        source: headingFont.source,
      }
    }

    if (bodyFont) {
      const gfMatch = await matchGoogleFont(bodyFont.name)
      result.fonts.body = {
        name: bodyFont.name,
        googleFontsMatch: gfMatch || undefined,
        source: bodyFont.source,
      }
    }

    return result
  }

  async extractAll(url: string): Promise<BrandExtractionResult> {
    const start = Date.now()

    const page = await this.fetchPage(url)
    if (!page) {
      return {
        colors: { confidence: 'low', colors: {}, source: 'failed', evidence: ['Could not fetch URL'], all_candidates: [] },
        fonts: { confidence: 'low', fonts: {}, evidence: ['Could not fetch URL'] },
        fetchDuration: Date.now() - start,
      }
    }

    const colors = this.extractColors(page)
    const fonts = await this.extractFonts(page)

    return {
      colors,
      fonts,
      fetchDuration: Date.now() - start,
    }
  }
}

function isSystemFont(name: string): boolean {
  const system = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
    'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui',
    'roboto', 'helvetica', 'arial', 'times new roman', 'times',
    'courier new', 'courier', 'verdana', 'georgia', 'palatino',
    'garamond', 'trebuchet ms', 'arial black', 'impact',
    'inherit', 'initial', 'unset', 'revert',
  ])
  return system.has(name.toLowerCase())
}
