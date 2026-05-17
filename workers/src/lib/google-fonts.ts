/**
 * Google Fonts metadata matching.
 * Lazily fetches the font list on first call to avoid cold-start CPU cost.
 * Stores only lowercase family names (~90% smaller than full metadata).
 * Fails open: if the metadata fetch fails, all matches return null.
 */

const METADATA_URL = 'https://fonts.google.com/metadata/fonts'

let cachedFamilies: Set<string> | null = null
let fetchAttempted = false

async function loadFamilies(): Promise<Set<string>> {
  if (cachedFamilies) return cachedFamilies
  if (fetchAttempted) return new Set() // previous fetch failed, don't retry

  fetchAttempted = true
  try {
    const res = await fetch(METADATA_URL, {
      headers: { 'User-Agent': 'RescueBot/1.0' },
    })
    if (!res.ok) return new Set()

    const text = await res.text()
    // Response starts with ")]}'" prefix (XSSI protection), strip it
    const json = JSON.parse(text.replace(/^\)\]\}'/, ''))
    const families = new Set<string>()
    for (const item of json.familyMetadataList || []) {
      if (item.family) families.add(item.family.toLowerCase())
    }
    cachedFamilies = families
    return families
  } catch {
    return new Set()
  }
}

/**
 * Check if a font name matches a Google Fonts family.
 * Returns the canonical family name if matched, null otherwise.
 * Fails open: returns null on any error (font detection degrades gracefully).
 */
export async function matchGoogleFont(name: string): Promise<string | null> {
  if (!name) return null
  const families = await loadFamilies()
  const lower = name.toLowerCase().trim()
  if (families.has(lower)) {
    // Return with proper casing for the Google Fonts URL
    for (const f of families) {
      if (f === lower) return name.trim()
    }
  }
  return null
}
