#!/usr/bin/env node
/**
 * Build the widget and deploy it to the `${ORG_SLUG}-embed` R2 bucket with
 * versioned URLs and appropriate cache headers.
 *
 * Reads version from web/package.json and writes three keys:
 *   widget.js        — latest (max-age=300, must-revalidate)
 *   v{major}.js      — latest 1.x  (max-age=3600)
 *   v{full}.js       — exact pin   (max-age=31536000, immutable)
 *
 * Customers paste `<script src="https://${PLATFORM_EMBED_HOST}/v1.js">`.
 * They get patches/minor updates; major version pin protects them from
 * breaking changes.
 *
 * Required env: CLOUDFLARE_API_TOKEN, ORG_SLUG (org.env or process.env).
 * PLATFORM_EMBED_HOST is consumed for the success-summary printout.
 *
 * Run from repo root: node workers/scripts/deploy-embed.js
 */

import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '../..')

// org.env is the source of truth for per-deployment values; process.env
// (CI) takes precedence so the GHA workflow can override without writing
// a temp file. Mirrors the loader pattern in recompile-wildcare-prompt.mjs.
function loadOrgEnv() {
  const p = join(root, 'org.env')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (!m) continue
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadOrgEnv()

const ORG_SLUG = process.env.ORG_SLUG?.trim()
if (!ORG_SLUG) {
  console.error('ERROR: ORG_SLUG required (set in org.env or process.env)')
  process.exit(1)
}
const EMBED_HOST = process.env.PLATFORM_EMBED_HOST?.trim() || `embed.${process.env.ORG_DOMAIN ?? '<your-domain>'}`

const pkg = JSON.parse(readFileSync(join(root, 'web/package.json'), 'utf8'))
const version = pkg.version
const [major] = version.split('.')

const widgetPath = join(root, 'web/widget-dist/widget.js')
if (!existsSync(widgetPath)) {
  console.log('Building widget...')
  execSync('npm run build:widget', { cwd: join(root, 'web'), stdio: 'inherit' })
}

if (!existsSync(widgetPath)) {
  console.error(`ERROR: widget not found at ${widgetPath} after build`)
  process.exit(1)
}

const bucket = `${ORG_SLUG}-embed`
const bytes = readFileSync(widgetPath).length
console.log(`Deploying widget v${version} (${bytes} bytes) to R2 bucket "${bucket}":`)

const targets = [
  { key: 'widget.js',          cacheControl: 'public, max-age=300, must-revalidate' },
  { key: `v${major}.js`,       cacheControl: 'public, max-age=3600' },
  { key: `v${version}.js`,     cacheControl: 'public, max-age=31536000, immutable' },
]

for (const t of targets) {
  console.log(`  → ${t.key}  (${t.cacheControl})`)
  execSync(
    `cd workers && npx wrangler r2 object put "${bucket}/${t.key}" ` +
    `--file="${widgetPath}" ` +
    '--content-type="application/javascript; charset=utf-8" ' +
    `--cache-control="${t.cacheControl}" ` +
    '--remote --force',
    { stdio: 'inherit', cwd: root },
  )
}

console.log('')
console.log(`✓ Widget v${version} deployed to:`)
console.log(`    https://${EMBED_HOST}/widget.js     (latest)`)
console.log(`    https://${EMBED_HOST}/v${major}.js               (default for embeds)`)
console.log(`    https://${EMBED_HOST}/v${version}.js   (exact pin)`)
