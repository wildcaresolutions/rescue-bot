/**
 * Compile structured org config + bot overrides into a custom_instruction
 * text that gets sent to the LLM as part of the system prompt.
 */

export interface SpeciesConfig {
  mode: 'builtin' | 'augment' | 'override' | 'skip'
  notes?: string
  redirect?: string
}

export interface CustomSpecies {
  name: string
  protocol: string
}

export interface TriageRule {
  label: string
  patterns: string[]  // regex patterns to match in user messages
  urgency: 'critical' | 'urgent' | 'moderate'
  hint: string  // suggested action for front desk staff
}

export interface OrgConfig {
  hours?: string
  after_hours_phone?: string
  public_address?: string
  species_config?: Record<string, SpeciesConfig>
  custom_species?: CustomSpecies[]
  redirect_info?: string
  emergency_contacts?: string
  triage_config?: TriageRule[]
  // Legacy fields (backward compat)
  species_handled?: string[]
  species_not_handled?: string[]
  other_species?: string
  triage_rules?: string
  intake_procedures?: string
}

export interface BotOverrides {
  tone?: string
  always_say?: string
  never_say?: string
  greeting?: string
  closing?: string
}

export function compileInstruction(
  tenant: { name: string; phone: string | null; email: string | null; url: string | null; location_service_area: string | null; location_county: string | null; location_state: string | null },
  orgConfig: OrgConfig,
  botOverrides: BotOverrides,
  rawProtocols?: string,
): string {
  const sections: string[] = []

  // Service area and contact
  const contactLines: string[] = []
  if (tenant.location_service_area) contactLines.push(`Service area: ${tenant.location_service_area}`)
  if (tenant.location_county) contactLines.push(`County: ${tenant.location_county}`)
  if (tenant.location_state) contactLines.push(`State: ${tenant.location_state}`)
  if (tenant.phone) contactLines.push(`Phone: ${tenant.phone}`)
  if (tenant.email) contactLines.push(`Email: ${tenant.email}`)
  if (tenant.url) contactLines.push(`Website: ${tenant.url}`)
  if (orgConfig.hours) contactLines.push(`Hours: ${orgConfig.hours}`)
  if (orgConfig.after_hours_phone) contactLines.push(`After-hours phone: ${orgConfig.after_hours_phone}`)
  if (orgConfig.public_address) contactLines.push(`Drop-off address: ${orgConfig.public_address}`)
  if (contactLines.length) {
    sections.push(`## Service Area & Contact\n${contactLines.join('\n')}`)
  }

  // Per-species configuration
  const sc = orgConfig.species_config || {}
  const augments: string[] = []
  const overrides: string[] = []
  const skips: string[] = []

  for (const [species, cfg] of Object.entries(sc)) {
    if (cfg.mode === 'augment' && cfg.notes) {
      augments.push(`- ${species}: ${cfg.notes}`)
    } else if (cfg.mode === 'override' && cfg.notes) {
      overrides.push(`### ${species}\nIGNORE the built-in guide for this species. Use ONLY the following protocol:\n${cfg.notes}`)
    } else if (cfg.mode === 'skip') {
      const redirect = cfg.redirect || orgConfig.redirect_info || 'Contact your local wildlife agency'
      skips.push(`- ${species}: We do NOT handle this species. Redirect: ${redirect}`)
    }
  }

  if (augments.length) {
    sections.push(`## Organization-Specific Notes\nThese notes supplement the built-in guides:\n${augments.join('\n')}`)
  }
  if (overrides.length) {
    sections.push(`## Protocol Overrides\n${overrides.join('\n\n')}`)
  }
  if (skips.length) {
    sections.push(`## Species We Do Not Handle\n${skips.join('\n')}`)
  }

  // Custom species (not in built-in guides)
  const customs = orgConfig.custom_species?.filter(cs => cs.name && cs.protocol)
  if (customs?.length) {
    const customSections = customs.map(cs => `### ${cs.name}\n${cs.protocol}`).join('\n\n')
    sections.push(`## Additional Species Protocols\n${customSections}`)
  }

  // Legacy: flat species lists (backward compat)
  if (!Object.keys(sc).length) {
    if (orgConfig.species_handled?.length) {
      const all = [...orgConfig.species_handled]
      if (orgConfig.other_species) all.push(...orgConfig.other_species.split(',').map(s => s.trim()).filter(Boolean))
      sections.push(`## Species We Handle\n${all.join(', ')}`)
    }
    if (orgConfig.species_not_handled?.length) {
      let text = `## Species We Do Not Handle\n${orgConfig.species_not_handled.join(', ')}`
      if (orgConfig.redirect_info) text += `\n\nRedirect callers: ${orgConfig.redirect_info}`
      sections.push(text)
    }
  }

  // General redirect info (if not already covered by per-species)
  if (orgConfig.redirect_info && !skips.length) {
    sections.push(`## Redirect Policy\n${orgConfig.redirect_info}`)
  }

  // Legacy triage/intake (backward compat)
  if (orgConfig.triage_rules) sections.push(`## Triage Rules\n${orgConfig.triage_rules}`)
  if (orgConfig.intake_procedures) sections.push(`## Intake Procedures\n${orgConfig.intake_procedures}`)

  // Emergency
  if (orgConfig.emergency_contacts) {
    sections.push(`## Emergency Contacts\n${orgConfig.emergency_contacts}`)
  }

  // Bot behavior
  const behaviorLines: string[] = []
  if (botOverrides.tone) behaviorLines.push(`Tone: ${botOverrides.tone}`)
  if (botOverrides.always_say) behaviorLines.push(`Always include: ${botOverrides.always_say}`)
  if (botOverrides.never_say) behaviorLines.push(`Never say: ${botOverrides.never_say}`)
  if (botOverrides.greeting) behaviorLines.push(`Opening greeting: ${botOverrides.greeting}`)
  if (botOverrides.closing) behaviorLines.push(`Closing message: ${botOverrides.closing}`)
  if (behaviorLines.length) {
    sections.push(`## Bot Behavior\n${behaviorLines.join('\n')}`)
  }

  // Raw protocols (user-written, appended at the end)
  if (rawProtocols?.trim()) {
    sections.push(`## Additional Protocols\n${rawProtocols.trim()}`)
  }

  return sections.join('\n\n')
}

/**
 * Recompile + maybe write to custom_instruction. Centralized so every tool
 * that mutates org_config / bot_overrides can call ONE function and get
 * lock semantics for free. When the tenant's custom_instruction is
 * `_locked`, this is a no-op write — the locked-text stays in place and
 * the operator sees their hand-tuned prompt unchanged. The recompiled
 * sections are still RETURNED so the UI can preview "what would the prompt
 * look like if I unlocked".
 */
export async function recompileAndMaybeWrite(
  db: D1Database,
  tenant: {
    id: string
    name: string; phone: string | null; email: string | null; url: string | null
    location_service_area: string | null; location_county: string | null; location_state: string | null
    house_rules?: string | null
    custom_instruction_locked?: number | null
  },
  orgConfig: OrgConfig,
  botOverrides: BotOverrides,
  rawProtocols?: string,
): Promise<{ compiled: string; wrote: boolean }> {
  const baseCompiled = compileInstruction(tenant, orgConfig, botOverrides, rawProtocols)
  // House rules go LAST — operator's pin-this-here hard rules.
  const housePart = tenant.house_rules?.trim()
    ? `\n\n## House Rules (operator-defined)\n${tenant.house_rules.trim()}`
    : ''
  const compiled = (baseCompiled + housePart).trim()
  const locked = tenant.custom_instruction_locked === 1
  if (!locked) {
    await db.prepare("UPDATE tenants SET custom_instruction = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(compiled.slice(0, 10_000), tenant.id).run()
  }
  return { compiled, wrote: !locked }
}
