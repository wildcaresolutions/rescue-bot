#!/usr/bin/env node
/**
 * gen-wrangler.js — generate workers/wrangler.toml from wrangler.template.toml.
 *
 * Wrangler does NOT support env-var interpolation in wrangler.toml binding ID
 * fields (verified against Wrangler 4.83.0 docs and behavior). The same pattern
 * the repo uses for gen-instructions.js / gen-guides.js / gen-dev-vars.js
 * applies here: a checked-in template + a generator + a generated output.
 *
 * Two modes:
 *   - default:  substitute real values from process.env (or org.env file)
 *               → wrangler.toml is the deployable config for THIS org.
 *   - --stub:   substitute literal `REPLACE_VIA_GEN_WRANGLER` for every
 *               placeholder → produces the COMMITTED stub form so IDE
 *               TypeScript / `wrangler types` / vitest-pool-workers always
 *               have a valid file to read on a fresh clone.
 *
 * The committed wrangler.toml IS the output of `--stub`. CI asserts they
 * match (drift-prevention).
 *
 * Required env vars (default mode):
 *   ACCOUNT_ID                      — Cloudflare account ID
 *   ORG_DOMAIN                      — e.g. wildcaresolutions.org
 *   DEV_D1_DATABASE_ID              — D1 UUID for local --local dev
 *   TEST_D1_DATABASE_ID             — D1 UUID for [env.test] remote
 *   PROD_D1_DATABASE_ID             — D1 UUID for [env.production] remote
 *   PROD_TURNSTILE_SITE_KEY         — real Turnstile sitekey for prod
 *
 * org.env (gitignored) is loaded if it exists and process.env doesn't
 * override. CI sets these as typed GH Actions secrets per the eng-review
 * decision (1A) — no single ORG_ENV blob.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PLACEHOLDERS = [
  // ORG_SLUG identifies a single deployment of rescue-bot. Every Cloudflare
  // resource (worker name, D1 database name, Vectorize index name, R2 bucket
  // name) is prefixed with it. Two forks of rescue-bot in two different CF
  // accounts pick different ORG_SLUGs — no name collisions. The slug also
  // becomes the workers.dev subdomain leftmost label (e.g. `<slug>-bot-test`
  // → `<slug>-bot-test.<account>.workers.dev`).
  'ORG_SLUG',
  'ACCOUNT_ID',
  'ORG_DOMAIN',
  'DEV_D1_DATABASE_ID',
  'TEST_D1_DATABASE_ID',
  'PROD_D1_DATABASE_ID',
  'PROD_TURNSTILE_SITE_KEY',
  'AI_GATEWAY_ACCOUNT_ID',
  'AI_GATEWAY_ID',
  'MAIN_CHAT_MODEL',
  'PHOTO_RECOGNIZER_MODEL',
  // Display name the SaaS presents to tenants (magic-link emails, /api/config
  // marketing payload, admin assistant system prompt). Empty falls back to
  // 'rescue-bot' via lib/platform.ts:getPlatformName. OSS forks set this in
  // org.env to their own brand.
  'PLATFORM_NAME',
  // CDN-cached embed host for the `<script src="https://<host>/v1.js">`
  // partner snippet. Empty → /api/config returns null and the admin Publish
  // UI falls back to the worker-origin `<worker>/widget.js`, which works
  // out of the box. Set to `embed.<org-domain>` once the R2 bucket
  // (`{{ORG_SLUG}}-embed`) is bound to that hostname via R2 Custom Domains.
  'PLATFORM_EMBED_HOST',
  // Comma-separated list of platform-admin emails notified when a new org
  // submits the public /platform/apply form. NOT a secret — just a routing
  // list — so it lives in [vars] (org.env), not wrangler secrets. Empty is
  // tolerated (renders ""), in which case /platform/apply logs
  // `apply-no-admin-recipients` and sends no notification.
  'PLATFORM_ADMIN_EMAILS',
  // Watchdog Worker (infra/watchdog/) — only required when rendering the
  // watchdog template, which is optional for forking orgs. Forks that don't
  // run `make cf-deploy-watchdog` can leave these empty in org.env.
  'WATCHDOG_KV_ID',
  'WATCHDOG_HEALTH_URL_TEST',
  'WATCHDOG_HEALTH_URL_PROD',
]

const OPTIONAL_PLACEHOLDERS = new Set([
  'AI_GATEWAY_ACCOUNT_ID',
  'AI_GATEWAY_ID',
  'MAIN_CHAT_MODEL',
  'PHOTO_RECOGNIZER_MODEL',
  'PLATFORM_NAME',
  'PLATFORM_EMBED_HOST',
  'PLATFORM_ADMIN_EMAILS',
  'WATCHDOG_KV_ID',
  'WATCHDOG_HEALTH_URL_TEST',
  'WATCHDOG_HEALTH_URL_PROD',
])

export const STUB_VALUE = 'REPLACE_VIA_GEN_WRANGLER'

const REPO_ROOT = join(__dirname, '..', '..')
const ORG_ENV = join(REPO_ROOT, 'org.env')

// Each entry is rendered independently. interpolateTemplate only throws on
// missing values for placeholders the template ACTUALLY references, so a fork
// that hasn't set WATCHDOG_* values can still render the main worker.
const TARGETS = [
  {
    name: 'main',
    template: join(REPO_ROOT, 'workers', 'wrangler.template.toml'),
    output: join(REPO_ROOT, 'workers', 'wrangler.toml'),
  },
  {
    name: 'watchdog',
    template: join(REPO_ROOT, 'infra', 'watchdog', 'wrangler.template.toml'),
    output: join(REPO_ROOT, 'infra', 'watchdog', 'wrangler.toml'),
  },
]

/** Parse simple KEY=VALUE org.env (no quotes, no shell expansion). */
export function parseOrgEnv(content) {
  const out = {}
  const lines = content.split(/\r?\n/)
  lines.forEach((line, idx) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eq = trimmed.indexOf('=')
    if (eq < 1) {
      throw new Error(`org.env line ${idx + 1} is malformed (no '=' or empty key): ${JSON.stringify(line)}`)
    }
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    out[key] = value
  })
  return out
}

/**
 * Substitute every {{KEY}} in template with values from the resolver.
 * Throws if any required key is missing or template has unknown placeholder.
 * Optionally warns when the resolver supplied vars that the template doesn't use.
 */
export function interpolateTemplate(template, resolver, { warnExtras = null, warn = console.error } = {}) {
  const present = new Set()
  const re = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g
  const result = template.replace(re, (_match, key) => {
    if (!PLACEHOLDERS.includes(key)) {
      throw new Error(`Template references unknown placeholder {{${key}}} — add to PLACEHOLDERS or fix typo`)
    }
    present.add(key)
    const value = resolver(key)
    if (value === undefined || value === null || value === '') {
      if (OPTIONAL_PLACEHOLDERS.has(key)) return ''
      throw new Error(`Missing required value for ${key}. Set it in org.env or as a process.env var.`)
    }
    return value
  })
  if (warnExtras) {
    const extras = warnExtras.filter(k => PLACEHOLDERS.includes(k) && !present.has(k))
    if (extras.length > 0) {
      warn(`[gen-wrangler] note: org.env defines unused placeholder(s): ${extras.join(', ')}`)
    }
  }
  return result
}

export function resolvePlaceholder(key, fileVars, env = process.env) {
  if (key === 'AI_GATEWAY_ACCOUNT_ID') {
    return env.AI_GATEWAY_ACCOUNT_ID
      ?? fileVars.AI_GATEWAY_ACCOUNT_ID
      ?? env.ACCOUNT_ID
      ?? fileVars.ACCOUNT_ID
  }
  return env[key] ?? fileVars[key]
}

function loadResolver() {
  let fileVars = {}
  if (existsSync(ORG_ENV)) {
    fileVars = parseOrgEnv(readFileSync(ORG_ENV, 'utf8'))
  }
  // process.env wins. Lets CI inject typed secrets without writing org.env.
  return key => resolvePlaceholder(key, fileVars, process.env)
}

/**
 * Default behavior renders ONLY the main worker target. Watchdog is opt-in
 * (via `--target watchdog` or `--all`) so a fork that hasn't set up the
 * watchdog can still run cf-render-config without errors. Back-compat for
 * existing Makefile targets and CI invocations.
 */
export function generate({ stub = false, stdout = false, only = 'main' } = {}) {
  const targets = only === 'all'
    ? TARGETS
    : TARGETS.filter(t => t.name === only)
  if (targets.length === 0) {
    throw new Error(`unknown target: ${only}. Valid: ${TARGETS.map(t => t.name).join(', ')}, all`)
  }

  let resolver
  let orgEnvKeys = []
  if (!stub) {
    resolver = loadResolver()
    if (existsSync(ORG_ENV)) {
      try {
        orgEnvKeys = Object.keys(parseOrgEnv(readFileSync(ORG_ENV, 'utf8')))
      } catch {
        // parseOrgEnv error surfaces below in interpolate.
      }
    }
  }

  const outputs = []
  for (const target of targets) {
    if (!existsSync(target.template)) {
      throw new Error(`missing template: ${target.template}`)
    }
    const template = readFileSync(target.template, 'utf8')

    let output
    if (stub) {
      output = interpolateTemplate(template, () => STUB_VALUE)
    } else {
      // warnExtras only emitted on the first target to avoid duplicate noise.
      output = interpolateTemplate(template, resolver, {
        warnExtras: target === targets[0] ? orgEnvKeys : null,
      })
    }

    if (stdout) {
      process.stdout.write(output)
    } else {
      writeFileSync(target.output, output)
      const mode = stub ? 'stub' : 'real-values'
      console.error(`[gen-wrangler] wrote ${relative(REPO_ROOT, target.output)} (${mode}, ${output.length} bytes)`)
    }
    outputs.push(output)
  }

  // Back-compat: callers expect a single string when only one target is rendered.
  return outputs.length === 1 ? outputs[0] : outputs
}

// Run as CLI when invoked directly (`node gen-wrangler.js [...args]`).
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  try {
    const argv = process.argv.slice(2)
    const targetIdx = argv.indexOf('--target')
    let only = 'main'
    if (argv.includes('--all')) only = 'all'
    else if (targetIdx >= 0 && argv[targetIdx + 1]) only = argv[targetIdx + 1]
    generate({
      stub: argv.includes('--stub'),
      stdout: argv.includes('--stdout'),
      only,
    })
  } catch (err) {
    console.error(`[gen-wrangler] ERROR: ${err.message}`)
    process.exit(1)
  }
}
