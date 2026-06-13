/**
 * Live Prompt drawer state. Returns everything the admin UI needs to
 * inspect or edit the bot's effective system prompt:
 *   - custom_instruction (raw, what the LLM sees)
 *   - house_rules (operator-pinned append-only text)
 *   - locked + locked_at + locked_pending_review (Lock-1 banner state)
 *   - compiled_preview: what custom_instruction WOULD be if recompiled
 *     right now from org_config + bot_overrides + house_rules
 *   - drift: when locked, whether the live custom_instruction differs from
 *     the recompiled preview
 *   - sections: parsed [{name, anchor, offset, length}] for drawer nav.
 */
import type { Tenant } from './types'
import { compileInstruction } from './compile-instruction'
import { parseOrgConfig } from './tenant-loader'
import { COMBINED_INSTRUCTION } from '../instructions'
import { buildTenantIdentityBlock, buildHouseRulesBlock } from './chat-prompt'

export interface PromptSection {
  name: string
  anchor: string
  offset: number
  length: number
}

/**
 * Parse markdown `## ` section headers from compiled prompt text. Returns
 * section metadata with byte offsets — stable for the duration of this
 * response (prompt text + offsets are computed together). Used by the
 * Live Prompt drawer to render section nav chips and scroll-to behavior.
 */
export function parsePromptSections(text: string): PromptSection[] {
  const sections: PromptSection[] = []
  const regex = /^## (.+)$/gm
  let m
  while ((m = regex.exec(text)) !== null) {
    const name = m[1].trim()
    const anchor = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    sections.push({ name, anchor, offset: m.index, length: 0 })
  }
  for (let i = 0; i < sections.length; i++) {
    const next = sections[i + 1]
    sections[i].length = (next ? next.offset : text.length) - sections[i].offset
  }
  return sections
}

export interface PromptStateResult {
  custom_instruction: string
  house_rules: string
  locked: boolean
  locked_at: string | null
  locked_pending_review: boolean
  compiled_preview: string
  drift: boolean
  sections: PromptSection[]
  /** Read-only "what your bot sees" views, assembled the way the live chat
   *  prompt is. org_view = just YOUR org's facts/rules/protocols (for the
   *  operator to verify); full_view additionally includes the built-in
   *  rescue training. Both omit per-conversation RAG + turn pacing. */
  org_view: string
  full_view: string
}

export function buildPromptState(tenant: Tenant): PromptStateResult {
  const oc = parseOrgConfig(tenant.org_config)
  const bo = parseOrgConfig<Record<string, unknown>>(tenant.bot_overrides)
  // House rules are no longer baked into custom_instruction (they render once
  // as their own top-of-prompt block at chat time), so the preview of "what
  // custom_instruction would be" must not include them either — otherwise the
  // drift check below would always show drift for tenants with house rules.
  const compiledPreview = compileInstruction(tenant, oc, bo).trim()
  const promptForSections = (tenant.custom_instruction || compiledPreview || '').trim()
  const sections = parsePromptSections(promptForSections)

  const pendingReview = tenant.custom_instruction_locked_pending_review === 1

  // Assemble the read-only "what your bot sees" views in the same order the
  // live chat prompt uses (identity → house rules → [generic] → org protocols).
  const identity = buildTenantIdentityBlock(tenant)
  const houseBlock = buildHouseRulesBlock(tenant)
  const orgProtocols = tenant.custom_instruction
    ? `## Organization-Specific Protocols\n\n${tenant.custom_instruction.trim()}`
    : ''
  const orgView = [identity, houseBlock, orgProtocols].map(s => s.trim()).filter(Boolean).join('\n\n')
  const fullView = [
    identity, houseBlock, COMBINED_INSTRUCTION, orgProtocols,
    '_(At chat time the bot also receives relevant knowledge-base passages for the visitor’s question and turn-specific pacing guidance.)_',
  ].map(s => s.trim()).filter(Boolean).join('\n\n')

  return {
    org_view: orgView,
    full_view: fullView,
    custom_instruction: tenant.custom_instruction || '',
    house_rules: tenant.house_rules || '',
    locked: tenant.custom_instruction_locked === 1,
    locked_at: tenant.custom_instruction_locked_at,
    locked_pending_review: pendingReview,
    compiled_preview: compiledPreview,
    drift: tenant.custom_instruction_locked === 1
      && (tenant.custom_instruction || '').trim() !== compiledPreview,
    sections,
  }
}
