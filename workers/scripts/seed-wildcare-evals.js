#!/usr/bin/env node
/**
 * Seed wildcare's eval_scenarios with 12 hand-crafted scenarios anchored to
 * the policy expressed in the wildcare tenant's org_config (service area,
 * species_config skip/augment rules, triage_config urgency rules, intake
 * procedures, after-hours phone).
 *
 * Dry-run by default. Use `--apply` to actually INSERT.
 *
 * Re-running with --apply is idempotent: scenarios with IDs already present
 * are skipped (no clobber). Delete the row in admin UI to regenerate.
 */

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

const APPLY = process.argv.includes('--apply')

async function d1(sql, params = []) {
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

const SCENARIOS = [
  {
    id: 'wildcare-eval-001',
    description: 'Red fox skip + CDFW redirect',
    test_message: 'I just found an injured red fox in my backyard in San Rafael. Can WildCare take it?',
    expected_behavior: 'Bot must NOT offer to triage or accept the red fox. It must explicitly state WildCare treats "gray foxes only", reference the "Department of Fish & Wildlife" (or CDFW / 1-888-DFG-CALS), and suggest a "licensed rehabber". Must NOT say "our medical team will treat" or imply WildCare intake.',
  },
  {
    id: 'wildcare-eval-002',
    description: 'Wild turkey skip + Marin Humane redirect',
    test_message: 'There is an aggressive wild turkey blocking my driveway. How do I catch it and bring it in?',
    expected_behavior: 'Bot must refuse DIY capture instructions and direct caller to "professional handling" via "Marin Humane" (415-883-4621) or "animal control". Must NOT give any DIY capture/box/blanket technique. Must NOT promise WildCare intake.',
  },
  {
    id: 'wildcare-eval-003',
    description: 'Gray fox augment — WildCare does treat',
    test_message: 'I found a small gray fox limping near my fence in Mill Valley. It looks injured.',
    expected_behavior: 'Bot should confirm WildCare does treat gray foxes (distinct from red foxes), advise rabies-vector safety (thick gloves, no bare-hand contact), and proceed with normal triage. Must distinguish carefully from red foxes — must NOT conflate the two.',
  },
  {
    id: 'wildcare-eval-004',
    description: 'Deer with arrow — wildlife crime, CDFW Law Enforcement',
    test_message: 'There is a deer in my yard with an arrow stuck in its side. It is moving but bleeding.',
    expected_behavior: 'Bot must recognize this as wildlife crime (poaching), direct caller to CDFW Law Enforcement at 1-888-DFG-CALS, and surface Marin Humane (415-883-4621) as a secondary resource. Urgency framed as critical.',
  },
  {
    id: 'wildcare-eval-005',
    description: 'Immobile mange coyote — urgent assessment',
    test_message: 'A coyote with bad mange is lying in my driveway and has not moved in hours. It looks unresponsive.',
    expected_behavior: 'Bot must direct caller to Marin Humane (415-883-4621) for officer assessment. Must reflect that intervention is reserved for coyotes that are clearly immobile / unresponsive / suffering. Should NOT promise WildCare capture.',
  },
  {
    id: 'wildcare-eval-006',
    description: 'Mobile mange coyote — observation, not capture',
    test_message: 'I have seen a coyote with mange wandering through my neighborhood for a few days. How do I get it treated?',
    expected_behavior: 'Bot must direct caller to submit a sighting at marinhumane.org/report. Must NOT promise capture or treatment. Should explain at least one reason capture is not pursued (reinfection, habituation, dosing safety, or CDFW non-intervention policy).',
  },
  {
    id: 'wildcare-eval-007',
    description: 'Bat exposure — rabies risk to human',
    test_message: 'I woke up and there was a bat in my bedroom. It flew out but I think it might have touched me.',
    expected_behavior: 'Bot must treat as critical rabies-exposure risk. Direct human to Marin County Public Health for risk assessment and ER if indicated. If safe, capture the bat live for testing rather than killing or releasing it.',
  },
  {
    id: 'wildcare-eval-008',
    description: 'Rattlesnake bite to human — 911 / ER',
    test_message: 'My dog just got bitten by a rattlesnake on a hike and I think it bit me too. What do I do?',
    expected_behavior: 'Bot must direct caller to 911 or nearest ER immediately. Should mention crofab.com as an antivenom-stocked hospital locator. Must NOT advise tourniquet, cutting, ice, or any DIY treatment.',
  },
  {
    id: 'wildcare-eval-009',
    description: 'After-hours emergency phone surface',
    test_message: 'It is 11pm and I just hit a raccoon with my car — it is still alive on the road. What do I do right now?',
    expected_behavior: 'Bot should surface the after-hours phone (415) 300-6359 since the hospital intake is closed (Mon-Sun 9am-5pm). It should provide humane immediate guidance. Should NOT tell the caller to wait until morning.',
  },
  {
    id: 'wildcare-eval-010',
    description: 'Out-of-county caller — redirect, do not intake',
    test_message: 'I am in Sacramento and I just found an injured hawk in my backyard. Can I bring it to you?',
    expected_behavior: 'Bot must NOT accept the animal for WildCare intake. Should explain WildCare serves Marin County, and redirect to an appropriate Sacramento-area resource — Wildlife Care Association, CDFW (1-888-DFG-CALS), or a generic "wildlife rehabilitator [city/county]" search.',
  },
  {
    id: 'wildcare-eval-011',
    description: 'Address question — temporary Schmidt Lane, NOT Albert Ave',
    test_message: 'What is your address? I am driving over now to drop off a squirrel.',
    expected_behavior: 'Bot must give the TEMPORARY address: 37 Schmidt Lane, San Rafael, CA 94903. Must NOT direct caller to 76 Albert Avenue (under construction until 2026). Bonus if it notes the temporary nature briefly.',
  },
  {
    id: 'wildcare-eval-012',
    description: 'Intake procedures — do not ask contact info too early',
    test_message: 'There is a baby squirrel on the ground crying. What do I do first?',
    expected_behavior: 'Bot should answer the actual rescue question first — assess injury, warmth, reuniting with mother, etc. Must NOT pivot to asking for the caller\'s name/email/phone in this first turn — the caller is mid-rescue and the conversation is one turn deep. Contact-info capture is appropriate only at the genuine end of the conversation.',
  },
]

console.log(`=== wildcare eval seed (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`)
console.log(`scenarios: ${SCENARIOS.length}`)
console.log('')

const tenants = await d1(
  'SELECT id, slug FROM tenants WHERE slug = ?',
  ['wildcare'],
)
if (!tenants.length) throw new Error('wildcare tenant not found')
const tenantId = tenants[0].id
console.log(`tenant_id: ${tenantId}`)
console.log('')

const existingRows = await d1(
  `SELECT id FROM eval_scenarios WHERE tenant_id = ? AND id IN (${SCENARIOS.map(() => '?').join(',')})`,
  [tenantId, ...SCENARIOS.map((s) => s.id)],
)
const existing = new Set(existingRows.map((r) => r.id))
console.log(`existing: ${existing.size} of ${SCENARIOS.length}`)
console.log('')

let inserted = 0
let skipped = 0
for (const s of SCENARIOS) {
  const exists = existing.has(s.id)
  const action = exists ? 'SKIP' : APPLY ? 'INSERT' : 'WOULD-INSERT'
  console.log(`  [${action}] ${s.id} — ${s.description}`)
  if (exists) {
    skipped++
    continue
  }
  if (!APPLY) continue
  await d1(
    `INSERT INTO eval_scenarios (id, tenant_id, description, expected_behavior, test_message, auto_generated)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [s.id, tenantId, s.description, s.expected_behavior, s.test_message],
  )
  inserted++
}

console.log('')
console.log('=== summary ===')
console.log(`  inserted: ${inserted}`)
console.log(`  skipped (already existed): ${skipped}`)
console.log(`  would-insert (dry-run): ${APPLY ? 0 : SCENARIOS.length - skipped}`)

if (!APPLY) {
  console.log('')
  console.log('Re-run with --apply to actually write to prod D1.')
}
