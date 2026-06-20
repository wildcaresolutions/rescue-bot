#!/usr/bin/env node
/**
 * Seed an ephemeral tenant into the test D1 database for integration tests.
 *
 * Usage:
 *   node workers/integration/scripts/seed-tenant.mjs <slug> <tenant-id>
 *   node workers/integration/scripts/seed-tenant.mjs   # uses TEST_TENANT_SLUG / TEST_TENANT_ID
 *
 * Required env:
 *   CLOUDFLARE_API_TOKEN   — Cloudflare API token with D1 write access
 *
 * Optional env:
 *   TEST_D1_DB_NAME        — D1 database name (default: wildcare-db-test)
 *   TEST_TENANT_SLUG       — tenant slug (overridden by positional arg)
 *   TEST_TENANT_ID         — tenant id  (overridden by positional arg)
 */
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Script lives at workers/integration/scripts/ — workers dir is two levels up.
const workersDir = join(__dirname, '../..')

const slug      = process.argv[2] ?? process.env.TEST_TENANT_SLUG ?? `it-${Date.now()}`
const tenantId  = process.argv[3] ?? process.env.TEST_TENANT_ID  ?? `it-${randomBytes(6).toString('hex')}`
const dbName    = process.env.TEST_D1_DB_NAME ?? 'wildcare-db-test'

// Simple sanity check: only alphanum + hyphens are safe to embed in SQL without
// a real parameterised query (wrangler --command doesn't support bind params).
const safe = /^[a-zA-Z0-9_-]+$/
if (!safe.test(slug) || !safe.test(tenantId)) {
  console.error('ERROR: slug and tenant-id must contain only [a-zA-Z0-9_-]')
  process.exit(1)
}

const sql = `
INSERT OR IGNORE INTO tenants (id, slug, name, password_hash, created_at, updated_at)
VALUES (
  '${tenantId}',
  '${slug}',
  'Integration Test Tenant',
  'pbkdf2:integration-test-stub:000000000000000000000000000000000000000000000000',
  datetime('now'),
  datetime('now')
);
`.trim()

// Write to a temp file so we don't have to worry about shell quoting.
const tmpFile = `/tmp/seed-tenant-${Date.now()}.sql`
writeFileSync(tmpFile, sql)

try {
  execSync(
    `npx wrangler d1 execute ${dbName} --env test --remote --file ${tmpFile}`,
    { cwd: workersDir, stdio: 'inherit' },
  )
  console.log(`✓ Seeded tenant: slug=${slug} id=${tenantId}`)
} finally {
  unlinkSync(tmpFile)
}
