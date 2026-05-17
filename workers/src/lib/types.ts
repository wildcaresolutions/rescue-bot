import type { Hono } from 'hono'

// ── Environment ───────────────────────────────────────────────────────────────

export interface Env {
  AI: Ai
  VECTORIZE: VectorizeIndex
  DB: D1Database
  R2: R2Bucket
  // Image triage v1: citizen-uploaded photos + curated reference photos.
  // Single bucket, prefix discipline: citizen/{tenant}/{session}/* and
  // reference/{condition_tag}/*.
  MEDIA_BUCKET: R2Bucket
  ASSETS: Fetcher
  EMAIL?: SendEmail
  AI_GATEWAY_ACCOUNT_ID: string
  AI_GATEWAY_ID: string
  AI_GATEWAY_TOKEN?: string
  MAIN_CHAT_MODEL?: string
  EVAL_JUDGE_MODEL?: string
  PHOTO_RECOGNIZER_MODEL?: string
  REPORT_FROM_EMAIL: string
  SIGNING_SECRET: string
  ENVIRONMENT?: string
  EMAIL_OVERRIDE_TO?: string
  EMAIL_SUBJECT_PREFIX?: string
  // Cloudflare Turnstile (signup form + magic-link request CAPTCHA)
  TURNSTILE_SITE_KEY?: string      // public, embedded in HTML
  TURNSTILE_SECRET_KEY?: string    // wrangler secret per env
  // Comma-separated emails granted platform-admin role on any tenant they
  // sign in to. Never inserted into tenant_users; never appear in UI.
  PLATFORM_ADMIN_EMAILS?: string
  // Platform display name — what the SaaS operator brands itself as.
  // Used in magic-link email subject lines, /api/config response, and the
  // admin-assistant system prompt. Empty defaults to "rescue-bot" via
  // lib/platform.ts:getPlatformName. OSS forks set this in org.env.
  PLATFORM_NAME?: string
  // Email the bot tells users to contact when a test or platform issue is
  // beyond the bot's recovery. Per audit ralph-1 M1. OSS forks set this.
  PLATFORM_SUPPORT_EMAIL?: string
  // Hostname for the chat-widget embed script. Used by the copilot's
  // get_embed_code tool. Per audit ralph-1 M11.
  PLATFORM_EMBED_HOST?: string
  // When "true", server-side auth gate + Turnstile checks short-circuit.
  // Set in [vars] of the default (local dev) wrangler config.
  DEV_AUTH_BYPASS?: string
}

// ── Tenant types ──────────────────────────────────────────────────────────────

export interface Tenant {
  id: string
  slug: string
  name: string
  phone: string | null
  url: string | null
  email: string | null
  location_county: string | null
  location_state: string | null
  location_service_area: string | null
  color_primary: string
  color_secondary: string
  color_accent: string
  logo_r2_key: string | null
  custom_instruction: string | null
  password_hash: string
  widget_theme: string | null
  widget_custom_css: string | null
  widget_published_at: string | null
  org_config: string | null
  bot_overrides: string | null
  admin_token_hash: string | null
  onboarded: number
  report_recipients: string | null
  daily_reports_enabled: number
  /** Operator-pinned instructions appended at the end of the compiled
   * system prompt. Survives recompiles. */
  house_rules: string | null
  /** When 1, custom_instruction is treated as raw operator-edited text and
   * NOT regenerated when species_config / org_config change. */
  custom_instruction_locked: number
  /** ISO timestamp the operator locked custom_instruction. NULL when unlocked. */
  custom_instruction_locked_at: string | null
  /** 1 when Lock-1 migration moved this tenant's hand-edited locked text
   * into house_rules and the operator hasn't dismissed the banner yet.
   * Set by migration 0030. Cleared via /admin/prompt/dismiss-migration-banner. */
  custom_instruction_locked_pending_review: number | null
  /** JSON-encoded feature-flag map read by lib/feature-flags.ts. Audit M13:
   * previously routed through `tenant as unknown as { feature_flags?: string }`
   * casts at three call sites; declared here so the casts can be removed. */
  feature_flags: string | null
  created_at: string
  updated_at: string
}

// ── Hono app context ──────────────────────────────────────────────────────────

export type Variables = {
  tenant: Tenant | null
  authToken: string | null
}

export type AppType = Hono<{ Bindings: Env; Variables: Variables }>
