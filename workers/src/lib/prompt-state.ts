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
}

export function buildPromptState(tenant: Tenant): PromptStateResult {
  const oc = parseOrgConfig(tenant.org_config)
  const bo = parseOrgConfig<Record<string, unknown>>(tenant.bot_overrides)
  const baseCompiled = compileInstruction(tenant, oc, bo)
  const housePart = tenant.house_rules?.trim()
    ? `\n\n## House Rules (operator-defined)\n${tenant.house_rules.trim()}`
    : ''
  const compiledPreview = (baseCompiled + housePart).trim()
  const promptForSections = (tenant.custom_instruction || compiledPreview || '').trim()
  const sections = parsePromptSections(promptForSections)

  const pendingReview = tenant.custom_instruction_locked_pending_review === 1

  return {
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
