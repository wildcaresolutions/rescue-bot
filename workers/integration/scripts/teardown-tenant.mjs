#!/usr/bin/env node
/**
 * Teardown an ephemeral integration-test tenant from the test D1 database.
 *
 * Deletes all rows for the tenant in dependency order so FK constraints
 * (if enforced) are satisfied: children before parents.
 *
 * Usage:
 *   node workers/integration/scripts/teardown-tenant.mjs
 *
 * Required env:
 *   TEST_TENANT_ID         — id of the tenant to delete
 *   CLOUDFLARE_API_TOKEN   — Cloudflare API token with D1 write access
 *
 * Optional env:
 *   TEST_D1_DB_NAME        — D1 database name (default: wildcare-db-test)
 *   TEST_TENANT_SLUG       — used only for logging
 */
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const workersDir = join(__dirname, '../..')

const tenantId = process.env.TEST_TENANT_ID
const slug     = process.env.TEST_TENANT_SLUG ?? '(unknown)'
const dbName   = process.env.TEST_D1_DB_NAME ?? 'wildcare-db-test'

if (!tenantId) {
  console.error('ERROR: TEST_TENANT_ID is required')
  process.exit(1)
}

const safe = /^[a-zA-Z0-9_-]+$/
if (!safe.test(tenantId)) {
  console.error('ERROR: TEST_TENANT_ID must contain only [a-zA-Z0-9_-]')
  process.exit(1)
}

// Delete in child-first order to respect FK constraints.
const sql = `
DELETE FROM citizen_session_tokens WHERE tenant_id = '${tenantId}';
DELETE FROM photos               WHERE tenant_id = '${tenantId}';
DELETE FROM photo_deletions      WHERE tenant_id = '${tenantId}';
DELETE FROM messages             WHERE tenant_id = '${tenantId}';
DELETE FROM feedback             WHERE tenant_id = '${tenantId}';
DELETE FROM reports              WHERE tenant_id = '${tenantId}';
DELETE FROM session_analysis     WHERE tenant_id = '${tenantId}';
DELETE FROM eval_results         WHERE tenant_id = '${tenantId}';
DELETE FROM eval_scenarios       WHERE tenant_id = '${tenantId}';
DELETE FROM magic_tokens         WHERE tenant_id = '${tenantId}';
DELETE FROM tenant_users         WHERE tenant_id = '${tenantId}';
DELETE FROM allowed_domains      WHERE tenant_id = '${tenantId}';
DELETE FROM usage_log            WHERE tenant_id = '${tenantId}';
DELETE FROM tenants              WHERE id = '${tenantId}';
`.trim()

const tmpFile = `/tmp/teardown-tenant-${Date.now()}.sql`
writeFileSync(tmpFile, sql)

try {
  execSync(
    `npx wrangler d1 execute ${dbName} --env test --remote --file ${tmpFile}`,
    { cwd: workersDir, stdio: 'inherit' },
  )
  console.log(`✓ Torn down tenant: slug=${slug} id=${tenantId}`)
} finally {
  unlinkSync(tmpFile)
}
