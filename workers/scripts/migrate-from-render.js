#!/usr/bin/env node
/**
 * Incremental ETL: copy NEW rows in messages/feedback/reports from the Render
 * Postgres (legacy single-tenant prod, wildcare.bluesnoop.com) into the
 * multi-tenant Cloudflare D1, tagged with TENANT_ID.
 *
 * "Incremental" = pulls only rows whose created_at is greater than the max
 * already in D1 for this tenant. No DELETE, no full reload.
 *
 * Output: workers/scripts/migrate-data.sql — apply with
 *   wrangler d1 execute <db> --env <env> --remote --file=workers/scripts/migrate-data.sql
 *
 * Required env:
 *   PG_URL                postgres connection string (Render Postgres)
 *   CLOUDFLARE_API_TOKEN  CF token with D1 read on the target db
 *   CLOUDFLARE_ACCOUNT_ID CF account id
 *
 * Optional env:
 *   TENANT_ID    target D1 tenant_id (default: wc-0001-wildcare-0001)
 *   D1_DATABASE  target D1 db name   (default: wildcare-db)
 *   WRANGLER_ENV wrangler env        (default: production)
 */

import pg from 'pg'
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const { Client } = pg
const __dirname = dirname(fileURLToPath(import.meta.url))

const PG_URL = process.env.PG_URL
if (!PG_URL) { console.error('PG_URL env var required'); process.exit(1) }
if (!process.env.CLOUDFLARE_API_TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN env var required'); process.exit(1)
}
if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error('CLOUDFLARE_ACCOUNT_ID env var required'); process.exit(1)
}

const TENANT_ID = process.env.TENANT_ID || 'wc-0001-wildcare-0001'
const D1_DATABASE = process.env.D1_DATABASE || 'wildcare-db'
const WRANGLER_ENV = process.env.WRANGLER_ENV || 'production'

function sql(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isInteger(v) ? v.toString() : v.toString()
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (v instanceof Date) return "'" + v.toISOString().replace('T', ' ').replace('Z', '') + "'"
  if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'"
  return "'" + String(v).replace(/'/g, "''") + "'"
}

// Run a SELECT against D1 via wrangler. Returns the row array. Single-statement only.
function d1Query(sqlStr) {
  const args = [
    'wrangler', 'd1', 'execute', D1_DATABASE,
    '--env', WRANGLER_ENV, '--remote',
    '--command', sqlStr,
    '--json',
  ]
  const out = execFileSync('npx', args, {
    cwd: join(__dirname, '..'),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
  // wrangler --json prints non-JSON banner lines to stderr but pure JSON to stdout
  // (the stdout is a single JSON array of result objects).
  const trimmed = out.trim()
  // Strip any non-JSON prefix some wrangler versions print before the array.
  const start = trimmed.indexOf('[')
  if (start === -1) throw new Error(`d1Query: no JSON array in wrangler output:\n${trimmed}`)
  const parsed = JSON.parse(trimmed.slice(start))
  return parsed[0]?.results || []
}

function escapeTenant(s) {
  return s.replace(/'/g, "''")
}

async function getWatermark(table) {
  const rows = d1Query(
    `SELECT MAX(created_at) AS max_ts FROM ${table} WHERE tenant_id = '${escapeTenant(TENANT_ID)}'`
  )
  return rows[0]?.max_ts || null
}

// We compare watermarks in millisecond-precision UTC text (what JS
// Date.toISOString() emits, and therefore what gets stored in D1). Render's
// `created_at` is microsecond-precision Postgres time — comparing the raw
// timestamp against a ms-precision string makes the same row re-pull every
// run. Render the column to ms text on the PG side instead.
function tsExpr(pgType) {
  if (pgType === 'timestamp with time zone') {
    return `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS')`
  }
  return `to_char(created_at, 'YYYY-MM-DD HH24:MI:SS.MS')`
}

const watermarks = {
  messages: await getWatermark('messages'),
  feedback: await getWatermark('feedback'),
  reports:  await getWatermark('reports'),
}
console.error('CF D1 watermarks (max created_at per table for tenant):')
console.error(`  messages: ${watermarks.messages || '(none — full pull)'}`)
console.error(`  feedback: ${watermarks.feedback || '(none — full pull)'}`)
console.error(`  reports:  ${watermarks.reports  || '(none — full pull)'}`)

const client = new Client({
  connectionString: PG_URL,
  ssl: { rejectUnauthorized: false },
})
await client.connect()

// Look up created_at column types so we render the comparison expression
// correctly (timestamp vs timestamptz handle TZ differently).
const typeRows = await client.query(
  `SELECT table_name, data_type
     FROM information_schema.columns
    WHERE column_name = 'created_at'
      AND table_name IN ('messages','feedback','reports')`
)
const pgType = Object.fromEntries(typeRows.rows.map(r => [r.table_name, r.data_type]))

const lines = [
  '-- Generated by workers/scripts/migrate-from-render.js (incremental)',
  `-- Tenant: ${TENANT_ID}`,
  `-- Generated: ${new Date().toISOString()}`,
  `-- Watermarks (only rows with created_at > these are pulled):`,
  `--   messages: ${watermarks.messages || 'EPOCH'}`,
  `--   feedback: ${watermarks.feedback || 'EPOCH'}`,
  `--   reports:  ${watermarks.reports  || 'EPOCH'}`,
  '',
]

// ── messages ────────────────────────────────────────────────────────────────
// `messages.message_id` is UNIQUE in D1, so INSERT OR IGNORE makes this safe
// to re-run even if the watermark misses boundary rows.
const msgCols = ['session_id','message_id','role','content','timestamp','tester_name',
  'time_to_first_token','total_time','error_type','message_type','client_ip',
  'created_at','tenant_id']
const msgQuery = watermarks.messages
  ? `SELECT * FROM messages WHERE ${tsExpr(pgType.messages)} > $1 ORDER BY created_at, id`
  : 'SELECT * FROM messages ORDER BY created_at, id'
const msgs = await client.query(msgQuery, watermarks.messages ? [watermarks.messages] : [])
console.error(`messages: ${msgs.rows.length} new rows`)
for (const r of msgs.rows) {
  const v = [
    r.session_id, r.message_id, r.role, r.content, r.timestamp,
    r.tester_name, r.time_to_first_token, r.total_time, r.error_type,
    r.message_type, r.client_ip ? String(r.client_ip) : null,
    r.created_at, TENANT_ID,
  ]
  lines.push(`INSERT OR IGNORE INTO messages (${msgCols.join(',')}) VALUES (${v.map(sql).join(',')});`)
}

// ── feedback ────────────────────────────────────────────────────────────────
// No UNIQUE constraint to dedupe against. Strict `>` watermark prevents
// re-inserting rows we've already pulled.
const fbCols = ['session_id','message_id','rating','feedback_text','tags','timestamp',
  'tester_name','message_preview','is_tester','client_ip','created_at','tenant_id']
const fbQuery = watermarks.feedback
  ? `SELECT * FROM feedback WHERE ${tsExpr(pgType.feedback)} > $1 ORDER BY created_at, id`
  : 'SELECT * FROM feedback ORDER BY created_at, id'
const fbs = await client.query(fbQuery, watermarks.feedback ? [watermarks.feedback] : [])
console.error(`feedback: ${fbs.rows.length} new rows`)
for (const r of fbs.rows) {
  const v = [
    r.session_id, r.message_id, r.rating, r.feedback_text, r.tags,
    r.timestamp, r.tester_name, r.message_preview,
    r.is_tester ? 1 : 0,
    r.client_ip ? String(r.client_ip) : null,
    r.created_at, TENANT_ID,
  ]
  lines.push(`INSERT INTO feedback (${fbCols.join(',')}) VALUES (${v.map(sql).join(',')});`)
}

// ── reports ─────────────────────────────────────────────────────────────────
const repCols = ['generated_at','period_start','period_end','stats','sent_to','error',
  'created_at','tenant_id']
const repQuery = watermarks.reports
  ? `SELECT * FROM reports WHERE ${tsExpr(pgType.reports)} > $1 ORDER BY created_at, id`
  : 'SELECT * FROM reports ORDER BY created_at, id'
const reps = await client.query(repQuery, watermarks.reports ? [watermarks.reports] : [])
console.error(`reports: ${reps.rows.length} new rows`)
for (const r of reps.rows) {
  const v = [
    r.generated_at, r.period_start, r.period_end,
    typeof r.stats === 'string' ? r.stats : JSON.stringify(r.stats),
    r.sent_to, r.error, r.created_at, TENANT_ID,
  ]
  lines.push(`INSERT INTO reports (${repCols.join(',')}) VALUES (${v.map(sql).join(',')});`)
}

lines.push('')
const outPath = join(__dirname, 'migrate-data.sql')
writeFileSync(outPath, lines.join('\n'))
const total = msgs.rows.length + fbs.rows.length + reps.rows.length
console.error(`✓ wrote ${outPath} (${total} INSERTs across messages/feedback/reports)`)

await client.end()
