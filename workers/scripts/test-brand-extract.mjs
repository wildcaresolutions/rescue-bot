#!/usr/bin/env node
/**
 * Multi-site brand extraction harness.
 *
 * Hits a list of real org websites with the SAME logic the Worker runs,
 * prints the detected primary/secondary/accent + top candidates so we can
 * eyeball whether it picked the actual brand colors or got fooled by
 * theme defaults.
 *
 * Usage: node workers/scripts/test-brand-extract.mjs [url1 url2 ...]
 *
 * Without args, runs against the curated list below. Tweak the heuristics
 * in workers/src/lib/brand-extract.ts and re-run to compare.
 *
 * NOTE: this script DOES NOT import the TS extractor — it inlines the same
 * logic as plain JS so we can run it under bare Node without a build step.
 * The two must stay in sync; if you change the regexes or weights in
 * brand-extract.ts, mirror the change here.
 */

const SITES = [
  // PHS-SPCA — the failure mode we're trying to fix. Real brand: green
  // primary (#4b711d), orange CTA (#c96310). Used to pick blue catalog.
  'https://phs-spca.org/',
  // Marin Humane — green/brown brand, simpler WP theme.
  'https://www.marinhumane.org/',
  // WildCare San Rafael — green primary, established brand.
  'https://www.wildcarebayarea.org/',
  // Lindsay Wildlife — multi-color brand, harder.
  'https://lindsaywildlife.org/',
  // Sonoma County Wildlife Rescue — orange primary.
  'https://scwildliferescue.org/',
  // Native Animal Rescue — distinct teal brand.
  'https://www.nativeanimalrescue.org/',
  // Yggdrasil Urban Wildlife Rescue — different tech stack.
  'https://yggdrasilrescue.org/',
  // International Bird Rescue — strong blue/yellow brand.
  'https://www.birdrescue.org/',
]

const BORING = new Set([
  '#000000', '#ffffff', '#333333', '#666666', '#999999', '#cccccc',
  '#eeeeee', '#f5f5f5', '#dddddd', '#aaaaaa', '#111111', '#222222',
  '#444444', '#555555', '#777777', '#888888', '#bbbbbb', '#f8f8f8',
  '#fafafa', '#e5e5e5', '#d4d4d4', '#737373', '#a3a3a3', '#f0f0f0',
])
const THIRD_PARTY = new Set([
  '#4285f4', '#34a853', '#fbbc04', '#ea4335', '#fbbc05',
  '#95bf47', '#5e8e3e',
])

const normalizeHex = (c) => {
  c = c.toLowerCase().trim()
  if (c.length === 4) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`
  return c.slice(0, 7)
}
const isInteresting = (h) => h.length === 7 && !BORING.has(h) && !THIRD_PARTY.has(h)
const hexDistance = (a, b) => {
  const r1 = parseInt(a.slice(1, 3), 16), g1 = parseInt(a.slice(3, 5), 16), b1 = parseInt(a.slice(5, 7), 16)
  const r2 = parseInt(b.slice(1, 3), 16), g2 = parseInt(b.slice(3, 5), 16), b2 = parseInt(b.slice(5, 7), 16)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}
const hexToHSL = (hex) => {
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

const fetchText = async (url) => {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'RescueBot/1.0' }, redirect: 'follow' })
    if (!r.ok) return null
    return (await r.text()).slice(0, 100_000)
  } catch { return null }
}

async function extract(rawUrl) {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl.replace(/^\/+/, '')
  const html = await fetchText(url)
  if (!html) return { url, error: 'fetch_failed' }

  const allHrefs = (html.match(/<link[^>]*href=["']([^"']+\.css[^"']*)["']/gi) || [])
    .map(t => t.match(/href=["']([^"']+)["']/)?.[1])
    .filter(Boolean)
  const themeFirst = (h) => /(?:theme|customizer|child[/-]?style|style-static|main\.css|brand)/i.test(h) ? 0 : 1
  const cssHrefs = allHrefs.slice().sort((a, b) => themeFirst(a) - themeFirst(b)).slice(0, 15)

  const inlineStyles = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).map(b => b.replace(/<\/?style[^>]*>/gi, ''))
  let allCSS = inlineStyles.join('\n')
  for (const href of cssHrefs) {
    const cssUrl = href.startsWith('http') ? href : new URL(href, url).href
    const t = await fetchText(cssUrl)
    if (t) allCSS += '\n' + t
  }

  const candidates = []
  const evidence = []

  // meta theme-color
  const tc = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i)?.[1]
  if (tc?.startsWith('#')) { candidates.push({ hex: normalizeHex(tc), role: 'primary', weight: 100 }); evidence.push(`theme-color: ${tc}`) }

  // brand var
  const brandVar = /--[a-z-]*(primary|brand|main|accent|secondary)[a-z-]*\s*:\s*#([0-9a-fA-F]{3,8})/gi
  let m
  while ((m = brandVar.exec(allCSS)) !== null) {
    const hex = normalizeHex('#' + m[2])
    if (hex.length === 7 && isInteresting(hex)) {
      const role = m[1].toLowerCase() === 'accent' ? 'accent' : m[1].toLowerCase() === 'secondary' ? 'secondary' : 'primary'
      candidates.push({ hex, role, weight: 79 })
    }
  }

  // HSL brand vars (Squarespace, modern Shopify themes — they define palette
  // as HSL triples, never as hex)
  const parseHSL = (raw) => {
    const cleaned = raw.replace(/^hsla?\(/, '').replace(/\)$/, '').trim()
    const parts = cleaned.split(/[,\s]+/).filter(Boolean).slice(0, 3)
    if (parts.length < 3) return null
    const h = parseFloat(parts[0]), s = parseFloat(parts[1]), l = parseFloat(parts[2])
    if (!isFinite(h) || !isFinite(s) || !isFinite(l)) return null
    if (s < 0 || s > 100 || l < 0 || l > 100) return null
    return hslToHex(((h % 360) + 360) % 360, s, l)
  }
  const hslToHex = (h, s, l) => {
    s /= 100; l /= 100
    const a = s * Math.min(l, 1 - l)
    const f = (n) => {
      const k = (n + h / 30) % 12
      const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
      return Math.round(255 * c).toString(16).padStart(2, '0')
    }
    return `#${f(0)}${f(8)}${f(4)}`
  }
  const brandHSL = /--[a-z-]*(primary|brand|main|accent|secondary)[a-z-]*(?:-hsl)?\s*:\s*(?:hsla?\([^)]+\)|[\d.]+\s*[, ]\s*[\d.]+%\s*[, ]\s*[\d.]+%)/gi
  while ((m = brandHSL.exec(allCSS)) !== null) {
    const value = m[0].slice(m[0].indexOf(':') + 1).trim()
    const hex = parseHSL(value)
    if (!hex || !isInteresting(hex)) continue
    const { s, l } = hexToHSL(hex)
    if (s < 10 || l > 95 || l < 5) continue
    const role = m[1].toLowerCase() === 'accent' ? 'accent' : m[1].toLowerCase() === 'secondary' ? 'secondary' : 'primary'
    candidates.push({ hex, role, weight: 79 })
  }
  // generic --theme catalog
  const themeVar = /--theme(?:-color)?(?:-\d+)?\s*:\s*#([0-9a-fA-F]{3,8})/gi
  while ((m = themeVar.exec(allCSS)) !== null) {
    const hex = normalizeHex('#' + m[1])
    if (hex.length === 7 && isInteresting(hex)) candidates.push({ hex, role: 'primary', weight: 35 })
  }
  // wp preset
  const wpVar = /--wp--preset--color--([a-z-]+)\s*:\s*#([0-9a-fA-F]{3,8})/gi
  while ((m = wpVar.exec(allCSS)) !== null) {
    const hex = normalizeHex('#' + m[2])
    if (hex.length === 7 && isInteresting(hex)) candidates.push({ hex, role: 'primary', weight: 35 })
  }
  // CSS frequency
  const declPat = /([^{}]+)\{[^}]*((?:background-color|background|color)\s*:\s*#[0-9a-fA-F]{3,8})[^}]*\}/gi
  while ((m = declPat.exec(allCSS)) !== null) {
    const sel = m[1].toLowerCase()
    const hexMatch = m[2].match(/#[0-9a-fA-F]{3,8}/)
    if (!hexMatch) continue
    const hex = normalizeHex(hexMatch[0])
    if (!isInteresting(hex)) continue
    let weight = 20, role = 'unknown'
    if (/\bheader\b|\bnav\b|\.site-header|\.main-header|\.navbar|\.main-nav|\.top-nav|\.hero\b|\.banner\b/.test(sel)) { weight = 65; role = 'primary' }
    else if (/btn|button|\.cta|submit|get-started|donate|sign[-_]?up|signup|register|subscribe|join-?(?:us|now)/.test(sel)) { weight = 55; role = 'accent' }
    else if (/footer/.test(sel)) { weight = 30; role = 'secondary' }
    else if (/^a\b|\.link/.test(sel)) { weight = 25; role = 'accent' }
    else if (/body|main|\.content/.test(sel)) { weight = 15; role = 'background' }
    candidates.push({ hex, role, weight })
  }

  candidates.sort((a, b) => b.weight - a.weight)
  const primaryCand = candidates.find(c => c.role === 'primary') || candidates[0]
  if (!primaryCand) return { url, error: 'no_candidates' }
  const primary = primaryCand.hex

  // pickSecondaryAccent (max-weight dedup)
  const byHex = new Map()
  for (const c of candidates) {
    if (c.hex === primary || !isInteresting(c.hex)) continue
    const { s, l } = hexToHSL(c.hex)
    if (s < 15 || l > 92 || l < 8) continue
    const ex = byHex.get(c.hex)
    if (!ex || ex.weight < c.weight) byHex.set(c.hex, c)
  }
  const usable = [...byHex.values()].sort((a, b) => b.weight - a.weight || (a.hex < b.hex ? -1 : 1))
  const secondary = usable[0]?.hex
  const accent = usable.slice(1).find(c => secondary ? hexDistance(c.hex, secondary) > 60 : true)?.hex ?? usable[1]?.hex

  return {
    url,
    primary,
    secondary,
    accent,
    top5: usable.slice(0, 5).map(c => `${c.hex}@${c.weight}`),
    cssFiles: cssHrefs.length,
  }
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : SITES
console.log(`\nTesting brand extraction on ${targets.length} site${targets.length === 1 ? '' : 's'}...\n`)
for (const url of targets) {
  const r = await extract(url)
  if (r.error) {
    console.log(`✗ ${r.url} — ${r.error}`)
    continue
  }
  console.log(`${r.url}`)
  console.log(`  primary:   ${r.primary}`)
  console.log(`  secondary: ${r.secondary}`)
  console.log(`  accent:    ${r.accent}`)
  console.log(`  top5 (non-primary): ${r.top5.join(' ')}`)
  console.log(`  css files: ${r.cssFiles}`)
  console.log('')
}
