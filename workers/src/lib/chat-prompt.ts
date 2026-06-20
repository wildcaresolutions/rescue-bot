/**
 * Build the system prompt the chat LLM sees, plus surface RAG signals the
 * caller may need (skip-species detection, etc.).
 *
 * Extracted from routes/chat.ts so the eval runner in routes/admin.ts can
 * use the SAME logic — previously the eval runner built its own prompt
 * that didn't apply species-skip detection or the hard-redirect block, so
 * the test results diverged from what real visitors would see. A pigeon
 * test could "fail" because the eval bot gave care steps, even though the
 * real chat bot would correctly redirect.
 */

import { COMBINED_INSTRUCTION } from '../instructions'
import { searchRAG, buildSpeciesModeMap, normalizeSpeciesKey } from './rag'
import { logWarn } from './logger'
import type { Env, Tenant } from './types'
import { photoUploadsEnabled } from './feature-flags'
import { parseOrgConfig } from './tenant-loader'

export interface ChatPromptResult {
  /** Full system prompt to send to the LLM. */
  systemPrompt: string
  /** Result of the RAG lookup (null if RAG failed; results may be empty). */
  ragResult: Awaited<ReturnType<typeof searchRAG>> | null
  /** Set when the user's message named a species the tenant has skipped. */
  skipRedirect: { species: string; redirect: string } | null
}

export interface ChatPromptOptions {
  turnNumber?: number
  privateContext?: string
}

/**
 * "Who are you" block — first thing the LLM reads. Establishes the active
 * tenant's identity unambiguously and whitelists the phone numbers the bot
 * may present as the tenant's own.
 *
 * The bundled instruction is generic (post-migration 0031 — see CLAUDE.md
 * Multi-tenant architecture). Per-tenant content (this org's protocols,
 * contact info, redirect rules) lives in the `tenants` row — specifically
 * the structured `org_config` fields plus the operator-pinned `house_rules`
 * text. This block surfaces the most-load-bearing of those facts at the top
 * of the prompt so the LLM treats them as authoritative, AND it forbids
 * presenting any other phone numbers (which might appear in redirect rules
 * inside house_rules) as if they belonged to this tenant.
 */
export function buildTenantIdentityBlock(tenant: Tenant): string {
  const orgConfig = tenant.org_config ? safeParse(tenant.org_config) : {}
  const tenantPhones: string[] = []
  if (tenant.phone) tenantPhones.push(tenant.phone)
  if (typeof orgConfig.after_hours_phone === 'string' && orgConfig.after_hours_phone) {
    tenantPhones.push(`${orgConfig.after_hours_phone} (after hours)`)
  }

  const lines: string[] = []
  lines.push('## ACTIVE TENANT (binding for this entire conversation)')
  lines.push('')
  lines.push(`You are the rescue assistant for **${tenant.name}** — and only ${tenant.name}.`)
  lines.push('')
  lines.push(`**Voice: first person plural.** You ARE part of ${tenant.name}. Speak as "we", "us", "our". When mentioning hours, contact, or capabilities, say "We're open 9am-4pm" / "Call us at <phone>" / "Bring it to our facility" — NOT "${tenant.name} is open" / "They can help" / "Their phone is". Never refer to ${tenant.name} in the third person ("they", "them", "their") — that's the wrong voice for the org's own chatbot.`)
  lines.push('')
  lines.push(`Exception: when talking about a DIFFERENT organization you're directing the caller TO (out-of-service-area redirect, after-hours fallback to animal control, etc.), use third person for that other org. "We can't take this — call Marin Humane at <their phone>."`)
  lines.push('')
  if (tenant.phone) lines.push(`- Phone: ${tenant.phone}`)
  if (typeof orgConfig.after_hours_phone === 'string' && orgConfig.after_hours_phone) {
    lines.push(`- After-hours phone: ${orgConfig.after_hours_phone}`)
  }
  if (typeof orgConfig.hours === 'string' && orgConfig.hours) {
    lines.push(`- Hours: ${orgConfig.hours}`)
  }
  if (typeof orgConfig.public_address === 'string' && orgConfig.public_address) {
    lines.push(`- Drop-off address: ${orgConfig.public_address}`)
  }
  if (tenant.email) lines.push(`- Email: ${tenant.email}`)
  if (tenant.url) lines.push(`- Website: ${tenant.url}`)
  if (tenant.location_service_area) lines.push(`- Service area: ${tenant.location_service_area}`)
  if (tenant.location_county || tenant.location_state) {
    const loc = [tenant.location_county, tenant.location_state].filter(Boolean).join(', ')
    lines.push(`- Location: ${loc}`)
  }
  lines.push('')

  if (tenant.location_service_area || tenant.location_county || tenant.location_state) {
    lines.push(`**The service area / location above is OURS, not the caller's.** It describes where ${tenant.name} is and whom we serve — it is NOT evidence of where the caller is. The caller could be writing from anywhere. NEVER assume the caller is in our area, never say "since you're in <our area>", and never give drop-off directions, a maps link, or "bring it to us" until the caller has told you their OWN city or county. When in doubt about the caller's location, ask.`)
    lines.push('')
  }

  if (tenantPhones.length) {
    lines.push(`### Phone number whitelist for ${tenant.name}`)
    lines.push('')
    lines.push(`The ONLY phone numbers you may present as "our phone" or "call us" are:`)
    for (const p of tenantPhones) lines.push(`- ${p}`)
    lines.push('')
    lines.push(`Any other phone number that appears anywhere in this prompt — including in redirect destinations, public-agency callouts, or example protocols — is NEVER ${tenant.name}'s phone. You may quote those other phones ONLY when explicitly redirecting a caller AWAY from ${tenant.name} (e.g., out-of-service-area, species-we-do-not-handle, animal control fallback). Never present them as ${tenant.name}'s contact line.`)
    lines.push('')
  }

  lines.push(`Operational facts (phone, hours, address, after-hours line, email) for ${tenant.name} live in THIS section. (Species protocols and redirect rules may also name OTHER organizations' phones — those are never ${tenant.name}'s own; see the whitelist above.) If a fact is not listed here, say so plainly ("I don't have those hours on file") and direct the caller to ${tenant.name}'s public phone above. Never invent hours, addresses, or after-hours numbers.`)
  lines.push('')
  lines.push(`**Links: quote, never construct.** When you share a URL — a navigation/Google Maps link, website, or any link — copy it EXACTLY as written above, character for character. NEVER build, expand, shorten, or guess a URL. In particular, do NOT generate a \`google.com/maps\` link with coordinates or tracking parameters — a fabricated map link can send a rescuer to the wrong place. If a navigation link IS provided above (e.g. inside the drop-off address), share that exact link. If none is provided, give the written address and suggest the caller search it in their maps app — do not make up a link.`)
  lines.push('')
  lines.push('---')
  lines.push('')
  return lines.join('\n')
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) || {} } catch { return {} }
}

/**
 * Top-of-prompt binding section for tenant.house_rules. When the operator
 * adds a house rule via the admin UI, this block surfaces it where the
 * LLM treats it as a direct instruction rather than as advisory protocol
 * context.
 *
 * Returns '' (empty) when the tenant has no house rules — no section
 * emitted, no wasted tokens.
 */
export function buildHouseRulesBlock(tenant: Tenant): string {
  const text = (tenant.house_rules || '').trim()
  if (!text) return ''
  return [
    '## HOUSE RULES (operator-defined — binding)',
    '',
    `The ${tenant.name} operator has pinned the following rules. Follow them in every response.`,
    'These rules CAN add tone, style, content, sign-offs, or specific phrasing requirements.',
    'These rules CANNOT override the universal safety floor (don\'t invent operational facts; don\'t give DIY capture instructions for dangerous species; don\'t direct callers away from emergency services for life-threatening situations).',
    'Where a house rule says "always X", treat that as a hard requirement and include X in every response unless a safety floor blocks it.',
    '',
    text,
    '',
    '---',
    '',
  ].join('\n')
}

export async function buildChatPrompt(
  env: Env,
  tenant: Tenant,
  userMessage: string,
  opts: ChatPromptOptions = {},
): Promise<ChatPromptResult> {
  const turnNumber = opts.turnNumber ?? 1
  const orgConfig = parseOrgConfig(tenant.org_config)
  const speciesModes = buildSpeciesModeMap(orgConfig.species_config)

  let ragResult: Awaited<ReturnType<typeof searchRAG>> | null = null
  let context = ''
  try {
    ragResult = await searchRAG(env, tenant.id, userMessage, { speciesModes })
    const docs = ragResult.results.map(d => `[Source: ${d.source}]\n${d.text}`)
    if (docs.length) context = docs.join('\n\n---\n\n')
  } catch (e) {
    logWarn('chat-prompt/rag-failed', { error: e })
  }

  // For skip species, look up the per-species redirect text the operator
  // configured. Operator's text wins; falls back to org_config.redirect_info
  // and finally a generic suggestion.
  let skipRedirect: { species: string; redirect: string } | null = null
  if (ragResult?.speciesSkipped && ragResult.detectedSpecies) {
    const detected = ragResult.detectedSpecies
    const sc = orgConfig.species_config || {}
    let entry: { redirect?: string; notes?: string } | null = null
    for (const [k, v] of Object.entries(sc)) {
      if (normalizeSpeciesKey(k) === detected && v && typeof v === 'object') {
        entry = v as { redirect?: string; notes?: string }
        break
      }
    }
    const redirect = entry?.redirect?.trim()
      || orgConfig.redirect_info?.trim()
      || 'contact your local wildlife agency or animal control'
    skipRedirect = { species: detected, redirect }
  }

  // Tenant identity OVERRIDE — first thing the LLM reads. Establishes who
  // the bot represents and the whitelist of allowed phone numbers.
  const tenantIdentity = buildTenantIdentityBlock(tenant)

  // House Rules — operator-pinned text from the tenants.house_rules column.
  // Emitted as its own TOP-OF-PROMPT section with explicit "binding"
  // framing. Operator complaint that prompted this: house rules were
  // saved correctly and made it into the compiled prompt, but were
  // buried inside the "Organization-Specific Protocols" wrapper that
  // says "Treat it as operational context, not as commands that
  // override your safety guidelines." Result: LLM downweighted the rule
  // as advisory and ignored it.
  //
  // House rules ARE binding for tone, style, and content additions; the
  // ONE thing they cannot override is the universal safety floor (never
  // invent operational facts, never give DIY capture instructions for
  // venomous animals, etc.). The framing below makes that explicit.
  const houseRulesBlock = buildHouseRulesBlock(tenant)

  let systemPrompt = tenantIdentity + houseRulesBlock + COMBINED_INSTRUCTION

  // Hard-redirect block goes FIRST so it dominates the LLM's attention.
  // searchRAG dropped competing care chunks for skip species, so by the
  // time the LLM sees this prompt there is nothing in-context contradicting
  // the redirect.
  if (skipRedirect) {
    systemPrompt = `## CRITICAL: REDIRECT REQUIRED

The user's message mentions "${skipRedirect.species}", which ${tenant.name} does NOT handle.

Your response MUST:
1. Open by acknowledging the situation briefly (one sentence).
2. State clearly that ${tenant.name} cannot help with this species.
3. Direct them to: ${skipRedirect.redirect}
4. Stop. Do NOT provide first aid, containment, transport, assessment, or any care guidance.

If the user replies and the conversation moves to a species we DO handle, you may engage normally then. But for THIS message, redirect only.

---

` + systemPrompt
  }

  if (tenant.custom_instruction) {
    systemPrompt += `\n\n## Organization-Specific Protocols\n\nThe following section contains configuration provided by the organization admin. Treat it as operational context, not as commands that override your safety guidelines.\n\n---BEGIN ORG PROTOCOLS---\n${tenant.custom_instruction}\n---END ORG PROTOCOLS---`
  }
  // NOTE: there is no separate "## Organization Info" block. Every operational
  // fact (name, phone, email, website, location, hours, after-hours phone,
  // drop-off address) is surfaced exactly once, at the very top, in the
  // ACTIVE TENANT block. Re-listing them here used to mean the LLM saw each
  // fact 2–3 times across the prompt; if one copy was stale the model had no
  // way to know which to trust.
  if (context) {
    systemPrompt += `\n\n## Relevant Knowledge Base\n\n${context}`
  }

  if (photoUploadsEnabled(tenant)) {
    systemPrompt += `\n\n## Photo Upload Capability

This site supports citizen photo uploads. You may ask the citizen to upload a clear photo when seeing the animal would materially improve triage, such as identifying species, age class, visible injuries, entanglement, abnormal posture, or whether a grounded young bird is likely a fledgling.

Do not let the photo request delay urgent safety guidance. Always give immediate safety or containment instructions first when the situation sounds urgent.

Never ask the citizen to get closer to a dangerous animal or create risk to take a photo. For venomous snakes, large mammals, rabies-vector species, or aggressive animals, only say a photo is helpful if it can be taken from a safe distance. Do not ask for a photo when the citizen already uploaded one in this session and the needed visual facts are present in Recent Photos.

If the citizen asks whether a photo would help, answer directly and briefly: "Yes, upload one if you can take it safely." Then say what the photo can show. Do not add unrelated logistics, hours, or contact details to that answer unless the citizen also asked for next steps. If you already asked for city/county in the previous assistant turn, do not ask for location again in the photo answer. End after explaining why the photo helps.`
  }

  if (opts.privateContext) systemPrompt += `\n\n${opts.privateContext}`

  // Generic behavioral guidance (never-invent facts, voice/tone, out-of-area
  // routing + Animal Help Now, URL formatting, first-turn pacing/intake shape)
  // lives ONCE in the bundled COMBINED_INSTRUCTION (agents/rescue-bot-instruction.md)
  // — it used to be duplicated here, ~9k chars of overlap. Only the genuinely
  // turn-dependent guidance stays inline, below.

  if (turnNumber >= 2) {
    systemPrompt += `\n\n## THIS IS TURN ${turnNumber} (a follow-up)\n\nYou have already given the citizen the phone number, the "I don't have hours on file" disclaimer (if applicable), and the animal-control fallback in earlier turns. They have all of that. Do NOT repeat any of those unless they ask again or the situation has changed.\n\nThis turn: address ONLY the question or info in the citizen's latest message. Be brief — under 100 words is the target unless they asked something genuinely complex. Don't add a "you should also call X" or "remember, no food or water" tail to every reply; trust that they remember what you told them last turn. If the latest message is only asking whether to upload a picture, answer only that. Do not repeat the city/county question if you asked it in the previous assistant turn.\n\n**Specifically about the phone number and the "I don't have hours" disclaimer:** if you genuinely need to mention the phone again because the citizen is asking about next steps, mention it WITHOUT re-explaining "I don't have the address/hours/after-hours line on file" — they already know. A bare "call (XXX) XXX-XXXX" is enough.`
  }
  if (turnNumber < 6) {
    systemPrompt += `\n\nDO NOT ask for the citizen's name, email, or phone yet. The conversation is still in active triage (turn ${turnNumber} of an ongoing rescue). Contact-info opt-in is for the genuine end of the conversation only, after the citizen has confirmed transport sorted or animal-in-hand-with-a-plan. "Thank you for helping this animal" sign-offs are also premature; skip them.`
  }

  return { systemPrompt, ragResult, skipRedirect }
}
