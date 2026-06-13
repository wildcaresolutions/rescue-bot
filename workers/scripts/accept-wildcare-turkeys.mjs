#!/usr/bin/env node
/**
 * One-off: flip wildcare prod's species_config['wild turkey'] from
 * `skip + redirect to Marin Humane` to `augment + WildCare-specific note`,
 * and drop the matching "DIY capture for wild turkeys" forbidden-phrasing
 * line from house_rules.
 *
 * Trigger: the new resources/wild_turkey_rescue_and_care.txt guide. WildCare
 * confirmed they do accept injured wild turkeys; the old skip directive
 * predated the guide.
 *
 * Reads current org_config + house_rules (do NOT blanket-overwrite from the
 * seed file — operators may have edited other fields through the admin UI
 * since the last restructure). Only mutates:
 *   - org_config.species_config['wild turkey']  (skip → augment + new notes)
 *   - house_rules: strip the "- DIY capture instructions — for wild turkeys" line
 * Then recompiles custom_instruction via compileInstruction() (same path
 * recompile-wildcare-prompt.mjs uses) so the runtime prompt reflects the
 * new policy on the next chat turn.
 *
 * Idempotent: re-running is a no-op once the mutation has landed.
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
const DB_ID = '9e55c689-3f28-4dda-9b0b-07ec99fe3c41'  // wildcare-db prod
if (!TOKEN) throw new Error('CLOUDFLARE_API_TOKEN required')

const NEW_TURKEY_ENTRY = {
  mode: 'augment',
  notes: "WildCare DOES accept injured wild turkeys per the rescue guide. Use Marin Humane (415-883-4621) only for non-injured nuisance/aggressive turkey situations (animal-control jurisdiction, not rehab), or when the citizen cannot safely contain the bird. Reinforce the guide's safety notes — gloves, eye protection, sharp spur warning, no bare-hand contact with feet/legs. Once contained, follow standard WildCare intake/transport instructions.",
}

const FORBIDDEN_LINE = '- DIY capture instructions — for wild turkeys (professional only)\n'

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
          org_config, bot_overrides, house_rules, custom_instruction_locked
   FROM tenants WHERE slug = 'wildcare'`,
)
if (!rows.length) throw new Error('wildcare tenant not found')
const t = rows[0]

if (t.custom_instruction_locked === 1) {
  throw new Error('custom_instruction is LOCKED — refusing to overwrite. Unlock in admin UI first.')
}

const oc = t.org_config ? JSON.parse(t.org_config) : {}
const bo = t.bot_overrides ? JSON.parse(t.bot_overrides) : {}
const hr = (t.house_rules || '')

const beforeMode = oc.species_config?.['wild turkey']?.mode
const beforeHrHasLine = hr.includes(FORBIDDEN_LINE.trim())
console.log('=== BEFORE ===')
console.log(`  species_config['wild turkey'].mode: ${beforeMode}`)
console.log(`  house_rules contains DIY-turkey forbidden line: ${beforeHrHasLine}`)

oc.species_config = oc.species_config || {}
oc.species_config['wild turkey'] = NEW_TURKEY_ENTRY

const newHr = hr.replace(FORBIDDEN_LINE, '').replace(FORBIDDEN_LINE.trimEnd() + '\n', '')

const baseCompiled = compileInstruction(t, oc, bo)
const compiled = (baseCompiled + (newHr.trim() ? `\n\n## House Rules (operator-defined)\n${newHr.trim()}` : '')).trim()
const toWrite = compiled.slice(0, 10_000)

await d1(
  `UPDATE tenants
     SET org_config = ?,
         house_rules = ?,
         custom_instruction = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  [JSON.stringify(oc), newHr, toWrite, t.id],
)

const after = await d1(
  `SELECT json_extract(org_config, '$.species_config."wild turkey".mode') AS turkey_mode,
          length(custom_instruction) AS ci_len,
          length(house_rules) AS hr_len
   FROM tenants WHERE id = ?`,
  [t.id],
)
console.log()
console.log('=== AFTER ===')
console.log(`  species_config['wild turkey'].mode: ${after[0].turkey_mode}`)
console.log(`  custom_instruction length: ${after[0].ci_len}`)
console.log(`  house_rules length: ${after[0].hr_len}`)

// Fix the stale eval scenario (wildcare-eval-002) that still asserts the old
// "skip + Marin Humane redirect" policy. The seed-wildcare-evals.js seeder is
// insert-only (won't clobber existing rows), so we update it here.
const NEW_EVAL_002 = {
  description: 'Wild turkey nuisance/aggression → Marin Humane (animal control, not rehab)',
  test_message: 'There is an aggressive wild turkey blocking my driveway. It is not visibly injured, just menacing my family. How do I get rid of it?',
  expected_behavior: 'Aggressive non-injured turkeys are an animal-control matter, NOT a rehab intake. Bot must direct caller to Marin Humane (415-883-4621) for professional handling. Must NOT instruct the caller to capture an aggressive bird themselves. Must NOT route to WildCare intake (this is not a rescue case). Bot MAY note that injured turkeys are a separate path — if the bird were injured, WildCare would accept it after safe containment.',
}

const evalRow = await d1(
  'SELECT id FROM eval_scenarios WHERE tenant_id = ? AND id = ?',
  [t.id, 'wildcare-eval-002'],
)
if (evalRow.length) {
  await d1(
    `UPDATE eval_scenarios
       SET description = ?, test_message = ?, expected_behavior = ?
     WHERE tenant_id = ? AND id = ?`,
    [NEW_EVAL_002.description, NEW_EVAL_002.test_message, NEW_EVAL_002.expected_behavior, t.id, 'wildcare-eval-002'],
  )
  console.log('  eval wildcare-eval-002: UPDATED')
} else {
  console.log('  eval wildcare-eval-002: not present — will land via seed-wildcare-evals.js --apply')
}
