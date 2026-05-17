/**
 * Website-fetching tools.
 *
 * - extract_brand_colors: BrandExtractor wrapper — returns palette +
 *   font candidates with confidence and evidence. Used by the
 *   onboarding Step-1 review card.
 * - fetch_url: low-level escape hatch for one-off page reads (embed
 *   verification, ad-hoc URL inspection).
 * - harvest_website_info: multi-page contact harvester used by the
 *   onboarding Step-2 review card. Backed by lib/website-harvest.ts.
 *
 * Extracted from workers/src/routes/agent.ts.
 */
import { tool } from 'ai'
import { z } from 'zod'
import { BrandExtractor } from '../brand-extract'
import { harvestWebsiteInfo } from '../website-harvest'
import { safeFetch, UnsafeUrlError } from '../safe-url'
import { getOutboundUserAgent } from '../platform'
import type { ToolContext } from './types'

export function fetchTools(ctx: ToolContext) {
  const { env } = ctx
  const extract_brand_colors = tool({
    description: 'Extract brand colors and fonts from a website URL. Returns a palette with confidence level, evidence, and all candidates for user approval. Use this during onboarding Step 1 instead of fetch_url.',
    inputSchema: z.object({
      url: z.string().describe('The website URL to extract brand from'),
    }),
    execute: async ({ url: targetUrl }) => {
      const extractor = new BrandExtractor()
      return await extractor.extractAll(targetUrl)
    },
  })

  const fetch_url = tool({
    description: 'Fetch a URL and return its content. For website text and embed verification. For brand colors, use extract_brand_colors instead.',
    inputSchema: z.object({
      url: z.string().describe('The URL to fetch'),
      extract: z.enum(['html', 'text']).optional().describe('What to extract: "html" for raw HTML, "text" for plain text.'),
    }),
    execute: async ({ url: targetUrl, extract }) => {
      try {
        // Audit P0-D + ralph-1 (preserved across the agent.ts split): all
        // outbound HTTP from copilot tools goes through safeFetch — https-
        // only, blocks private IPs, re-validates on every redirect hop.
        const res = await safeFetch(targetUrl, {
          headers: { 'User-Agent': getOutboundUserAgent(env) },
          maxRedirects: 3,
        })
        if (!res.ok) return { success: false, error: `HTTP ${res.status}` }
        const html = await res.text()

        if (extract === 'text') {
          // Strip tags for plain text
          const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
          return { success: true, url: targetUrl, text: text.slice(0, 8000) }
        }

        // Default: return raw HTML (truncated)
        return { success: true, url: targetUrl, html: html.slice(0, 8000) }
      } catch (e) {
        if (e instanceof UnsafeUrlError) {
          return { success: false, error: `Refused to fetch: ${e.message}` }
        }
        return { success: false, error: e instanceof Error ? e.message : 'Fetch failed' }
      }
    },
  })

  const harvest_website_info = tool({
    description: 'Fetch an organization website plus likely contact/about/help pages and extract editable onboarding details: phone, email, address, hours, service-area text, and notable intake limitations. Use this during onboarding after branding so the user can review a structured card instead of trusting a prose summary.',
    inputSchema: z.object({
      url: z.string().describe('Organization website URL'),
    }),
    execute: async ({ url: targetUrl }) => harvestWebsiteInfo(targetUrl),
  })

  return { extract_brand_colors, fetch_url, harvest_website_info }
}
