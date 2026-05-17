#!/usr/bin/env node
/**
 * One-off: recompile wildcare's custom_instruction from the structured
 * org_config that restructure-wildcare-tenant.js wrote, by invoking the
 * canonical compileInstruction() that every other tenant uses.
 *
 * Why: restructure-wildcare-tenant.js intentionally left
 * custom_instruction = NULL with the expectation that the operator's
 * next admin save would trigger /platform/setup/:slug to recompile.
 * That never happened, so the runtime chat prompt has been operating
 * with house_rules only (no species_config, no triage rules, no
 * intake_procedures). The bot was effectively still running the legacy
 * one-off prose.
 *
 * After this script: custom_instruction contains the structured-derived
 * sections (service area, species notes, skips, redirects, intake,
 * emergency contacts) and the runtime prompt appends them as
 * "Organization-Specific Protocols". Re-running is idempotent because
 * the inputs are deterministic.
 */

import { compileInstruction } from '../src/lib/compile-instruction.ts'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

function loadEnv() {
  const envPath = join(REPO_ROOT, '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (!m) continue
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadEnv()

const TOKEN = process.env.CLOUDFLARE_API_TOKEN
const ACCOUNT_ID = process.env.ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || 'c6e2a7b5499ec794272783240727d65b'
const DB_ID = '9e55c689-3f28-4dda-9b0b-07ec99fe3c41'
if (!TOKEN) throw new Error('CLOUDFLARE_API_TOKEN required')

async function d1(sql, params) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    },
  )
  const data = await r.json()
  if (!data.success) throw new Error(`D1: ${JSON.stringify(data.errors)}`)
  return data.result[0].results
}

const rows = await d1(
  `SELECT id, name, phone, email, url, location_service_area, location_county, location_state,
          org_config, bot_overrides, house_rules, custom_instruction_locked,
          length(custom_instruction) AS ci_len_before
   FROM tenants WHERE slug = 'wildcare'`,
)
if (!rows.length) throw new Error('wildcare tenant not found')
const t = rows[0]
console.log('=== BEFORE ===')
console.log(`  custom_instruction length: ${t.ci_len_before}`)
console.log(`  custom_instruction_locked: ${t.custom_instruction_locked}`)
console.log(`  house_rules length: ${t.house_rules?.length ?? 0}`)
console.log(`  org_config length: ${t.org_config?.length ?? 0}`)

if (t.custom_instruction_locked === 1) {
  throw new Error('custom_instruction is LOCKED — refusing to overwrite. Unlock in admin UI first.')
}

const oc = t.org_config ? JSON.parse(t.org_config) : {}
const bo = t.bot_overrides ? JSON.parse(t.bot_overrides) : {}
const hr = (t.house_rules || '').trim()

const baseCompiled = compileInstruction(t, oc, bo)
const compiled = (baseCompiled + (hr ? `\n\n## House Rules (operator-defined)\n${hr}` : '')).trim()

console.log()
console.log('=== COMPILED (preview) ===')
console.log(compiled.slice(0, 1200))
console.log(`... (total ${compiled.length} chars, will be sliced to 10000)`)

const toWrite = compiled.slice(0, 10_000)
await d1(
  "UPDATE tenants SET custom_instruction = ?, updated_at = datetime('now') WHERE id = ?",
  [toWrite, t.id],
)

const after = await d1(
  'SELECT length(custom_instruction) AS ci_len FROM tenants WHERE id = ?',
  [t.id],
)
console.log()
console.log('=== AFTER ===')
console.log(`  custom_instruction length: ${after[0].ci_len}`)
