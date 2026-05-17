/**
 * Website harvest — fetch an organization's homepage plus likely
 * contact/about/help pages and extract editable onboarding fields:
 * phone, email, address, hours, service area, and intake limitations.
 *
 * Extracted from workers/src/routes/agent.ts so:
 *   - the route file stays focused on request handling
 *   - both the `/admin/onboarding/website-harvest` HTTP endpoint AND
 *     the `harvest_website_info` agent tool can share this code
 *   - the regex set is testable in isolation
 *
 * No external dependencies; runs in the Workers runtime.
 *
 * Security: every outbound HTTP is funneled through safeFetch (lib/safe-url.ts)
 * which enforces https-only, blocks private-IP egress, and re-validates the
 * destination on every redirect hop. The harvest tool is callable from the
 * admin copilot, so the URL is operator/LLM-supplied and SSRF defense is
 * non-negotiable. See audit ralph-1 C1 + M16.
 */

import { safeFetch } from './safe-url'

const HARVEST_PAGE_LIMIT = 5
const HARVEST_USER_AGENT = 'RescueBot-Onboarding/1.0'

export type HarvestField = {
  value: string
  sourceUrl: string
  evidence: string
  confidence: 'high' | 'medium' | 'low'
}

export type HarvestPage = {
  url: string
  title: string
  text: string
}

export function normalizeWebsiteUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) return ''
  // Audit ralph-1 H4: refuse explicit http://. safeFetch would reject it
  // downstream anyway (https-only) but refusing here surfaces the rejection
  // at input-shape time. Bare hostnames still get prefixed with https://.
  if (/^http:\/\//i.test(trimmed)) return ''
  return /^https:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, '')}`
}

function absolutizeUrl(href: string, base: string): string | null {
  if (!href || href.startsWith('#') || /^mailto:|^tel:/i.test(href)) return null
  try {
    const u = new URL(href, base)
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '-')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractTitle(html: string, fallbackUrl: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  return stripHtml(title || '').slice(0, 80) || new URL(fallbackUrl).pathname || 'Home'
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function findRelevantLinks(html: string, homeUrl: string): string[] {
  const home = new URL(homeUrl)
  const links: string[] = []
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    const href = absolutizeUrl(match[1], homeUrl)
    if (!href) continue
    const u = new URL(href)
    if (u.hostname !== home.hostname) continue
    const label = stripHtml(match[2]).toLowerCase()
    const haystack = `${u.pathname.toLowerCase()} ${label}`
    if (/(contact|about|hours|visit|location|directions|injured|found|wildlife|help|faq)/.test(haystack)) {
      links.push(u.toString())
    }
  }

  const guesses = ['/contact', '/contact-us', '/about', '/about-us', '/faq', '/faqs', '/wildlife-help', '/found-an-animal']
    .map(path => new URL(path, homeUrl).toString())
  return unique([homeUrl, ...links, ...guesses]).slice(0, HARVEST_PAGE_LIMIT + 4)
}

async function fetchHarvestPage(url: string): Promise<HarvestPage | null> {
  try {
    const res = await safeFetch(url, {
      headers: { 'User-Agent': HARVEST_USER_AGENT },
      maxRedirects: 3,
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') || ''
    if (contentType && !/text\/html|text\/plain|application\/xhtml/i.test(contentType)) return null
    const html = await res.text()
    // Audit ralph-1 M16: pin the display URL to the (validated) input rather
    // than res.url. safeFetch's redirect re-validation prevents a private-IP
    // landing, but the displayed URL is what the operator sees and what
    // confidence judgments hang on — keep it stable.
    return {
      url,
      title: extractTitle(html, url),
      text: stripHtml(html).slice(0, 20_000),
    }
  } catch {
    return null
  }
}

function compactEvidence(text: string, index: number, length = 220): string {
  const start = Math.max(0, index - 80)
  return text.slice(start, start + length).replace(/\s+/g, ' ').trim()
}

function firstMatchingSnippet(pages: HarvestPage[], matcher: (text: string) => RegExpMatchArray | null): HarvestField | null {
  for (const page of pages) {
    const match = matcher(page.text)
    if (!match) continue
    return {
      value: match[1] || match[0],
      sourceUrl: page.url,
      evidence: compactEvidence(page.text, match.index ?? 0),
      confidence: 'high',
    }
  }
  return null
}

function extractHours(pages: HarvestPage[]): HarvestField | null {
  const directPatterns = [
    /((?:hours?(?:\s+of\s+operation)?|open(?:ing)?\s+hours?|intake\s+hours?)\s*:?\s*(?:will remain (?:the )?same,\s*)?\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?\s*(?:-|–|to)\s*\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)(?:\s*(?:daily|monday\s*(?:-|–|to)\s*sunday|mon(?:day)?\s*(?:-|–|to)\s*sun(?:day)?))?)/i,
    /(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?\s*(?:-|–|to)\s*\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)\s*(?:daily|monday\s*(?:-|–|to)\s*sunday|mon(?:day)?\s*(?:-|–|to)\s*sun(?:day)?))/i,
  ]
  for (const page of pages) {
    for (const pattern of directPatterns) {
      const match = page.text.match(pattern)
      if (!match) continue
      const value = match[1]
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s+\*.*/, '')
        .replace(/^hours?\s+will\s+remain\s+(?:the\s+)?same,\s*/i, '')
      return {
        value,
        sourceUrl: page.url,
        evidence: compactEvidence(page.text, match.index ?? 0),
        confidence: 'high',
      }
    }

    // No broad "label nearby" fallback here. A blank editable field is safer
    // than persisting surrounding page prose as operating hours.
  }
  return null
}

function extractServiceArea(pages: HarvestPage[]): HarvestField | null {
  const terms = /(service area|serving [^.]{0,80}(?:county|counties|area|region)|serves [^.]{0,80}(?:county|counties|area|region)|counties served|greater [a-z ]+ area)/i
  for (const page of pages) {
    const chunks = page.text.split(/\n+|(?<=\.)\s+/).map(s => s.trim()).filter(Boolean)
    for (const chunk of chunks) {
      if (chunk.length < 25 || chunk.length > 260) continue
      if (terms.test(chunk) && !/(copyright|privacy|newsletter|donate|sponsor)/i.test(chunk)) {
        return {
          value: chunk,
          sourceUrl: page.url,
          evidence: chunk,
          confidence: 'medium',
        }
      }
    }
  }
  return null
}

function extractWebsiteInfoFromPages(url: string, pages: HarvestPage[]) {
  const phone = firstMatchingSnippet(pages, text =>
    text.match(/((?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4})/),
  )
  if (phone) {
    const digits = phone.value.replace(/\D/g, '').replace(/^1/, '')
    if (digits.length === 10) phone.value = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
  }

  const email = firstMatchingSnippet(pages, text =>
    text.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i),
  )

  const address = firstMatchingSnippet(pages, text =>
    text.match(/(\d{2,6}\s+(?:[A-Z0-9][\w'.-]*\s+){1,6}(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Way|Bend|Court|Ct\.?|Place|Pl\.?)(?:[, ]+[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\s*\d{5})?)/i),
  )

  const hours = extractHours(pages)
  const serviceArea = extractServiceArea(pages)

  const notes: HarvestField[] = []
  for (const page of pages) {
    const match = page.text.match(/(unable to pick up|unable to transport|cannot accept|do not accept|not open to the public|call[^.]{0,120}hotline)[^.]{0,220}/i)
    if (match) {
      notes.push({
        value: match[0].trim(),
        sourceUrl: page.url,
        evidence: compactEvidence(page.text, match.index || 0),
        confidence: 'medium',
      })
    }
  }

  const fields = { phone, email, address, hours, service_area: serviceArea }
  const missing = Object.entries(fields)
    .filter(([, v]) => !v)
    .map(([k]) => k)

  return {
    success: true,
    url,
    pages: pages.map(p => ({ url: p.url, title: p.title })),
    fields,
    notes: notes.slice(0, 4),
    missing,
  }
}

export async function harvestWebsiteInfo(rawUrl: string) {
  const url = normalizeWebsiteUrl(rawUrl)
  if (!url) return { success: false, error: 'URL is required' }
  const home = await fetchHarvestPage(url)
  if (!home) return { success: false, url, error: 'Could not fetch website' }

  const linkUrls = findRelevantLinks(await (async () => {
    try {
      const res = await safeFetch(home.url, {
        headers: { 'User-Agent': HARVEST_USER_AGENT },
        maxRedirects: 3,
      })
      return await res.text()
    } catch {
      return ''
    }
  })(), home.url)

  const pages: HarvestPage[] = [home]
  for (const candidate of linkUrls) {
    if (pages.length >= HARVEST_PAGE_LIMIT) break
    if (pages.some(p => p.url === candidate)) continue
    const page = await fetchHarvestPage(candidate)
    if (page && !pages.some(p => p.url === page.url)) pages.push(page)
  }

  return extractWebsiteInfoFromPages(home.url, pages)
}
