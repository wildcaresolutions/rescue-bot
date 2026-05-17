/**
 * Platform identity — the brand the SaaS operator presents to tenants.
 *
 * Most deployments are WildCare Solutions (PLATFORM_NAME=WildCare Solutions).
 * OSS forks override via the org.env-rendered wrangler.toml [vars] block.
 * The default — "rescue-bot" — matches the OSS project name and works as a
 * neutral fallback when an operator forgot to configure their own brand.
 *
 * Used in:
 *   - workers/src/routes/auth.ts: magic-link email subject/from name (the
 *     citizen sees "Sign in to <PlatformName>" in their inbox).
 *   - workers/src/index.ts: /api/config response for the unauthenticated
 *     marketing landing page (no tenant context).
 *   - workers/src/routes/agent.ts: admin assistant system prompt — tells
 *     the LLM what platform it's representing so it doesn't invent a
 *     different name (the previous hardcoded "Critter Collective" caused
 *     that — audit P0-F).
 *
 * KEEP THIS HELPER, NOT INLINE: env.PLATFORM_NAME may be an empty string
 * from the wrangler stub mode (REPLACE_VIA_GEN_WRANGLER sites that the
 * route gets called on a fresh-cloned dev worktree before cf-render-config
 * has run). Inlining `env.PLATFORM_NAME || 'rescue-bot'` everywhere is
 * fragile — one stray `env.PLATFORM_NAME ?? 'rescue-bot'` (nullish vs
 * falsy) and the empty-string case slips through. The helper enforces the
 * "treat empty as missing" semantic uniformly.
 */

import type { Env } from './types'

const DEFAULT_PLATFORM_NAME = 'rescue-bot'
const DEFAULT_SUPPORT_EMAIL = 'support@example.com'

/**
 * Return the platform's display name. Empty / unset / stub-mode values
 * collapse to the OSS-friendly default. The result is safe to interpolate
 * into user-facing strings (emails, prompts, marketing copy).
 */
export function getPlatformName(env: Env): string {
  const raw = env.PLATFORM_NAME?.trim()
  if (!raw) return DEFAULT_PLATFORM_NAME
  if (raw === 'REPLACE_VIA_GEN_WRANGLER') return DEFAULT_PLATFORM_NAME
  return raw
}

/**
 * Return the platform support email — where users send escalations the bot
 * can't handle ("file a bug", "test case keeps failing"). Audit ralph-1 M1
 * found `mark@bluesnoop.com` baked into the agent prompt, which is fine
 * for our deployment but wrong for forks. Set PLATFORM_SUPPORT_EMAIL in
 * org.env; falls back to a neutral placeholder.
 */
export function getPlatformSupportEmail(env: Env): string {
  const raw = env.PLATFORM_SUPPORT_EMAIL?.trim()
  if (!raw) return DEFAULT_SUPPORT_EMAIL
  if (raw === 'REPLACE_VIA_GEN_WRANGLER') return DEFAULT_SUPPORT_EMAIL
  return raw
}

/**
 * Return the canonical embed host used in the `<script src=...>` snippet
 * the copilot hands operators. Audit ralph-1 M11 found this hardcoded to
 * `embed.wildcaresolutions.org`. Set PLATFORM_EMBED_HOST in org.env when
 * a CDN/R2-cached entry point (e.g. `embed.<deployment>.example/v1.js`)
 * is available. Returns null when unconfigured — callers should fall back
 * to the worker origin (`/widget.js`), which Workers Assets serves today.
 */
export function getEmbedHost(env: Env): string | null {
  const raw = env.PLATFORM_EMBED_HOST?.trim()
  if (!raw) return null
  if (raw === 'REPLACE_VIA_GEN_WRANGLER') return null
  return raw
}

/**
 * User-Agent string for outbound HTTP from the platform — onboarding harvest,
 * brand-color extraction, and (TODO) any other server-initiated fetches.
 * Stable across the codebase so site operators can recognize traffic in
 * their logs.
 */
export function getOutboundUserAgent(env: Env): string {
  return `${getPlatformName(env)}-Bot/1.0`
}
