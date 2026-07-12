#!/usr/bin/env node
/**
 * init-org.js — interactive setup for forking wildlife rehab orgs.
 *
 * Prompts for the 3 things only the org knows (domain, CF account ID,
 * Turnstile site key), then runs `wrangler d1 create` / `wrangler vectorize
 * create` / `wrangler r2 bucket create` to provision the per-env resources,
 * captures the UUIDs from each command's output, and writes them to
 * `org.env` (gitignored). Idempotent: skips create steps for resources that
 * already exist by name.
 *
 * After this runs, `make cf-deploy-test` and `make cf-deploy` work without
 * any further config edits.
 *
 * Companion to gen-wrangler.js: that script renders wrangler.toml from
 * org.env. This script populates org.env in the first place.
 *
 * Run: make cf-init-org
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import readline from 'readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const ORG_ENV = join(REPO_ROOT, 'org.env')

// Resource names are derived from ORG_SLUG. Two forks of rescue-bot can use
// any slug they like (`wildcare`, `bay-rescue`, `acme-wildlife`) without
// colliding — each lives in its own CF account, but the names are also
// meaningful enough to grep for in CF dashboards across multiple accounts.
export function resourceNames(orgSlug) {
  return {
    d1: {
      DEV_D1_DATABASE_ID: `${orgSlug}-db`,
      TEST_D1_DATABASE_ID: `${orgSlug}-db-test`,
      // Same DB as dev: --env production deploys re-bind it. (`d1 list` is
      // by name; one row covers both bindings.) Forking orgs that want a
      // truly separate prod DB can rename after init-org runs.
      PROD_D1_DATABASE_ID: `${orgSlug}-db`,
    },
    vectorize: [`${orgSlug}-docs-dev`, `${orgSlug}-docs-test`, `${orgSlug}-docs`],
    r2: [`${orgSlug}-assets`, `${orgSlug}-assets-test`, `${orgSlug}-media`, `${orgSlug}-media-test`],
  }
}

// Slug grammar: lowercase letters, digits, single-hyphen separators. Must
// start and end with alphanumeric, 2-30 chars total. Same shape as a DNS
// label so it composes cleanly into workers.dev subdomains and zone routes.
// (No `?` on the trailing group — we require both first AND last chars to
// be alphanumeric, which also enforces minimum length 2.)
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/

// Reserved against confusion with platform-level subdomains. Catches the
// "I called my org `admin` and now admin.foo.org doesn't route to my
// tenant" mistake before resources are provisioned.
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'platform', 'www', 'app', 'mail', 'ftp',
  'cdn', 'static', 'assets', 'embed', 'health', 'status',
  'default', 'rescue', 'test', 'staging', 'dev', 'prod',
])

export function isValidOrgSlug(value) {
  if (!value) return 'required'
  if (!SLUG_RE.test(value)) {
    return 'must be 2-30 chars, lowercase alphanumeric, single hyphens (DNS-label shape)'
  }
  if (RESERVED_SLUGS.has(value)) {
    return `'${value}' is reserved (conflicts with platform-level subdomains). Pick another.`
  }
  return null
}

// ─── Prompt helpers ──────────────────────────────────────────────────────────

function prompt(rl, question, { default: defaultValue, validate } = {}) {
  return new Promise(resolve => {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    rl.question(`${question}${suffix}: `, answer => {
      const value = answer.trim() || defaultValue || ''
      if (validate) {
        const error = validate(value)
        if (error) {
          console.error(`  ✘ ${error}`)
          resolve(prompt(rl, question, { default: defaultValue, validate }))
          return
        }
      }
      resolve(value)
    })
  })
}

function isValidDomain(value) {
  if (!value) return 'required'
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) return 'must be a domain like example.org (no protocol, no path)'
  return null
}

function isValidAccountId(value) {
  if (!value) return 'required'
  if (!/^[a-f0-9]{32}$/i.test(value)) return 'must be a 32-char hex CF account ID'
  return null
}

// ─── Resource helpers ────────────────────────────────────────────────────────

/**
 * Run a wrangler command, return stdout. Throws on non-zero exit.
 * `wrangler --json` would be cleaner but isn't supported on every subcommand
 * we use here, so we parse human output.
 */
function wrangler(args) {
  return execSync(`npx wrangler ${args}`, {
    cwd: join(REPO_ROOT, 'workers'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Create a D1 database. Returns the captured UUID. If a DB with the same
 * name already exists in the account, parses the UUID from `wrangler d1 list`
 * instead — idempotent.
 */
export function createOrLookupD1(name, runner = wrangler) {
  // Try create first. If it errors with "already exists" (or similar), fall
  // back to list. Wrangler's error messages aren't stable across versions, so
  // we take the simpler path: check list first, only create if missing.
  const listOutput = runner('d1 list')
  const existing = parseD1List(listOutput, name)
  if (existing) return existing

  const createOutput = runner(`d1 create ${name}`)
  const id = parseD1CreateOutput(createOutput)
  if (!id) throw new Error(`failed to capture D1 ID from create output for ${name}`)
  return id
}

/** Parse `wrangler d1 list` output for a database by name. */
export function parseD1List(output, name) {
  const lines = output.split('\n')
  for (const line of lines) {
    const cols = line.split('│').map(s => s.trim()).filter(Boolean)
    if (cols.length >= 2 && cols.includes(name)) {
      const idCol = cols.find(c => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(c))
      if (idCol) return idCol
    }
  }
  return null
}

/** Parse `wrangler d1 create <name>` output for the new UUID. */
export function parseD1CreateOutput(output) {
  const match = output.match(/database_id\s*=\s*"([a-f0-9-]{36})"/i)
  if (match) return match[1]
  const lineMatch = output.match(/\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i)
  return lineMatch ? lineMatch[1] : null
}

/** Create Vectorize index if missing. Idempotent — `list` then maybe `create`. */
export function ensureVectorizeIndex(name, runner = wrangler) {
  try {
    const listOutput = runner('vectorize list')
    if (listOutput.includes(name)) return 'exists'
  } catch {
    // list may fail on fresh accounts with no indexes yet; fall through to create
  }
  runner(`vectorize create ${name} --dimensions 768 --metric cosine`)
  return 'created'
}

/** Create R2 bucket if missing. */
export function ensureR2Bucket(name, runner = wrangler) {
  try {
    const listOutput = runner('r2 bucket list')
    if (listOutput.includes(name)) return 'exists'
  } catch {
    // ignore
  }
  runner(`r2 bucket create ${name}`)
  return 'created'
}

// ─── org.env writer ──────────────────────────────────────────────────────────

/**
 * Render org.env content from a values object. Pure function (no I/O) so
 * the unit tests don't have to write files.
 */
export function renderOrgEnv(values, header) {
  const lines = [header || '# Generated by `make cf-init-org`. Gitignored — never commit.']
  for (const [key, value] of Object.entries(values)) {
    lines.push(`${key}=${value}`)
  }
  return lines.join('\n') + '\n'
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (existsSync(ORG_ENV)) {
    const existing = readFileSync(ORG_ENV, 'utf8').trim()
    if (existing) {
      console.error('ERROR: org.env already exists. Remove it (or rename) before running cf-init-org.')
      console.error(`  path: ${ORG_ENV}`)
      process.exit(1)
    }
  }

  // Non-interactive mode: if all four config values are in env vars, skip
  // prompts. Useful for CI / automation / fresh-account scripts where piping
  // to readline is unreliable. Validators still run — bad values fail fast.
  const envValues = {
    ORG_SLUG: process.env.ORG_SLUG,
    ORG_DOMAIN: process.env.ORG_DOMAIN,
    ACCOUNT_ID: process.env.ACCOUNT_ID,
    PROD_TURNSTILE_SITE_KEY: process.env.PROD_TURNSTILE_SITE_KEY,
  }
  const nonInteractive = Object.values(envValues).every(v => v && v.trim())

  console.log('')
  console.log('  rescue-bot — fork-and-deploy setup')
  console.log('  ──────────────────────────────────')
  console.log('  This script provisions Cloudflare resources for your org and writes')
  console.log('  org.env. Make sure you have run `wrangler login` first.')
  if (nonInteractive) {
    console.log('  (Non-interactive mode: ORG_SLUG, ORG_DOMAIN, ACCOUNT_ID, PROD_TURNSTILE_SITE_KEY')
    console.log('   all set in env; skipping prompts.)')
  }
  console.log('')

  let ORG_SLUG, ORG_DOMAIN, ACCOUNT_ID, PROD_TURNSTILE_SITE_KEY

  if (nonInteractive) {
    const checks = [
      ['ORG_SLUG', envValues.ORG_SLUG, isValidOrgSlug],
      ['ORG_DOMAIN', envValues.ORG_DOMAIN, isValidDomain],
      ['ACCOUNT_ID', envValues.ACCOUNT_ID, isValidAccountId],
      ['PROD_TURNSTILE_SITE_KEY', envValues.PROD_TURNSTILE_SITE_KEY, v => v ? null : 'required'],
    ]
    for (const [name, value, validate] of checks) {
      const err = validate(value)
      if (err) {
        console.error(`ERROR: ${name}=${JSON.stringify(value)} is invalid: ${err}`)
        process.exit(1)
      }
    }
    ORG_SLUG = envValues.ORG_SLUG
    ORG_DOMAIN = envValues.ORG_DOMAIN
    ACCOUNT_ID = envValues.ACCOUNT_ID
    PROD_TURNSTILE_SITE_KEY = envValues.PROD_TURNSTILE_SITE_KEY
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    ORG_SLUG = await prompt(rl,
      'Org slug (lowercase identifier, becomes the prefix for every CF resource — e.g. wildcare, bay-rescue)',
      { validate: isValidOrgSlug },
    )
    ORG_DOMAIN = await prompt(rl, 'Org domain (e.g. acme-wildlife.org)', { validate: isValidDomain })
    ACCOUNT_ID = await prompt(rl, 'Cloudflare account ID (32-char hex)', { validate: isValidAccountId })
    PROD_TURNSTILE_SITE_KEY = await prompt(rl, 'Turnstile sitekey for prod (paste from CF dashboard)', {
      validate: v => v ? null : 'required',
    })
    rl.close()
  }

  // CF account context for every wrangler call.
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID

  // Pre-render wrangler.toml with REAL slug/account/domain but DUMMY D1 IDs.
  // Wrangler refuses to operate (even on account-level commands like `d1 list`)
  // when the local wrangler.toml is the committed stub — invalid worker/bucket
  // names. With this pre-render the stub is replaced by a valid-but-dummy
  // config so `d1 create` / `r2 bucket create` / `vectorize create` work. The
  // real D1 IDs get written into org.env at the end and the next cf-* target
  // re-renders wrangler.toml from there.
  const DUMMY_UUID = '00000000-0000-0000-0000-000000000000'
  process.env.ORG_SLUG = ORG_SLUG
  process.env.ORG_DOMAIN = ORG_DOMAIN
  process.env.ACCOUNT_ID = ACCOUNT_ID
  process.env.DEV_D1_DATABASE_ID = process.env.DEV_D1_DATABASE_ID || DUMMY_UUID
  process.env.TEST_D1_DATABASE_ID = process.env.TEST_D1_DATABASE_ID || DUMMY_UUID
  process.env.PROD_D1_DATABASE_ID = process.env.PROD_D1_DATABASE_ID || DUMMY_UUID
  process.env.PROD_TURNSTILE_SITE_KEY = PROD_TURNSTILE_SITE_KEY
  console.log('  Rendering pre-provision wrangler.toml...')
  execSync('node workers/scripts/gen-wrangler.js --all', { cwd: REPO_ROOT, stdio: 'inherit' })

  const names = resourceNames(ORG_SLUG)

  console.log('')
  console.log(`  Provisioning D1 databases (prefix=${ORG_SLUG})...`)
  const dbIds = {}
  for (const [varName, dbName] of Object.entries(names.d1)) {
    const id = createOrLookupD1(dbName)
    dbIds[varName] = id
    console.log(`    ${dbName}: ${id}`)
  }

  console.log(`  Provisioning Vectorize indexes (prefix=${ORG_SLUG})...`)
  for (const name of names.vectorize) {
    const status = ensureVectorizeIndex(name)
    console.log(`    ${name}: ${status}`)
  }

  console.log(`  Provisioning R2 buckets (prefix=${ORG_SLUG})...`)
  for (const name of names.r2) {
    const status = ensureR2Bucket(name)
    console.log(`    ${name}: ${status}`)
  }

  const values = {
    ORG_SLUG,
    ACCOUNT_ID,
    ORG_DOMAIN,
    DEV_D1_DATABASE_ID: dbIds.DEV_D1_DATABASE_ID,
    TEST_D1_DATABASE_ID: dbIds.TEST_D1_DATABASE_ID,
    PROD_D1_DATABASE_ID: dbIds.PROD_D1_DATABASE_ID,
    PROD_TURNSTILE_SITE_KEY,
  }
  writeFileSync(ORG_ENV, renderOrgEnv(values, `# ${ORG_DOMAIN} — generated by \`make cf-init-org\` on ${new Date().toISOString()}.\n# Gitignored — never commit.`))
  console.log('')
  console.log(`  ✓ Wrote ${ORG_ENV}`)

  console.log('')
  console.log('  ── Next steps ───────────────────────────────────────────────────────')
  console.log('  1. Set up Cloudflare Email Routing on your apex domain in the CF dashboard:')
  console.log(`       https://dash.cloudflare.com/${ACCOUNT_ID}/email/routing`)
  console.log(`     Verify a sender like noreply@${ORG_DOMAIN} — this becomes REPORT_FROM_EMAIL.`)
  console.log('')
  console.log('  2. Fill in workers/.dev.vars and .env with Gateway + platform secrets:')
  console.log('       - AI_GATEWAY_TOKEN (for chat + photo recognition through Cloudflare AI Gateway)')
  console.log('       - SIGNING_SECRET, REPORT_FROM_EMAIL (for auth + email sender)')
  console.log('       - TURNSTILE_SECRET_KEY (for auth)')
  console.log('     (PLATFORM_ADMIN_EMAILS is set in org.env — plaintext var, not a secret)')
  console.log('')
  console.log('  3. Push secrets to test + prod:')
  console.log('       make cf-push-secrets-test')
  console.log('       make cf-push-secrets')
  console.log('')
  console.log('  4. Apply D1 migrations + index RAG docs:')
  console.log('       make cf-migrate-test && make cf-migrate')
  console.log('       make cf-index-docs')
  console.log('')
  console.log('  5. Deploy:')
  console.log('       make cf-deploy-test     # ships to wildcare-bot-test.<your-acct>.workers.dev')
  console.log('       make cf-deploy          # ships to your custom domain after step 1 is done')
  console.log('')
  console.log('  6. Verify magic-link login on the test URL before pushing to prod.')
  console.log('  ────────────────────────────────────────────────────────────────────')
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  main().catch(err => {
    console.error(`init-org failed: ${err.message}`)
    process.exit(1)
  })
}
