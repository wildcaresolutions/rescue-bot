import { describe, it, expect } from 'vitest'
import { compileInstruction, OrgConfig, BotOverrides } from '../src/lib/compile-instruction'

function baseTenant(overrides: Partial<Parameters<typeof compileInstruction>[0]> = {}) {
  return {
    name: 'Test Rescue',
    phone: null,
    email: null,
    url: null,
    location_service_area: null,
    location_county: null,
    location_state: null,
    ...overrides,
  }
}

const emptyOrg: OrgConfig = {}
const emptyBot: BotOverrides = {}

describe('compileInstruction', () => {
  it('returns empty string when all inputs are empty', () => {
    expect(compileInstruction(baseTenant(), emptyOrg, emptyBot)).toBe('')
  })

  it('returns empty string when all inputs are empty with undefined rawProtocols', () => {
    expect(compileInstruction(baseTenant(), emptyOrg, emptyBot, undefined)).toBe('')
  })

  it('returns empty string when rawProtocols is whitespace only', () => {
    expect(compileInstruction(baseTenant(), emptyOrg, emptyBot, '   \n  ')).toBe('')
  })

  describe('contact facts are NOT compiled (surfaced once in chat-prompt identity block)', () => {
    it('does not emit a Service Area & Contact section even with full contact info', () => {
      const result = compileInstruction(
        baseTenant({
          phone: '555-1234',
          email: 'help@rescue.org',
          url: 'https://rescue.org',
          location_service_area: 'Bay Area',
          location_county: 'Marin',
          location_state: 'CA',
        }),
        { hours: '9am-5pm', after_hours_phone: '555-9999', public_address: '1 Main St' },
        emptyBot,
      )
      expect(result).not.toContain('## Service Area & Contact')
      expect(result).not.toContain('Phone: 555-1234')
      expect(result).not.toContain('Hours: 9am-5pm')
      expect(result).not.toContain('Drop-off address')
      // With only contact info and nothing protocol-shaped, output is empty.
      expect(result).toBe('')
    })
  })

  describe('Species sections', () => {
    it('generates species handled section', () => {
      const result = compileInstruction(
        baseTenant(),
        { species_handled: ['Songbirds', 'Raptors', 'Waterfowl'] },
        emptyBot,
      )
      expect(result).toContain('## Species We Handle')
      expect(result).toContain('Songbirds, Raptors, Waterfowl')
    })

    it('generates species not handled section', () => {
      const result = compileInstruction(
        baseTenant(),
        { species_not_handled: ['Marine mammals', 'Reptiles'] },
        emptyBot,
      )
      expect(result).toContain('## Species We Do Not Handle')
      expect(result).toContain('Marine mammals, Reptiles')
    })

    it('includes redirect info with species not handled', () => {
      const result = compileInstruction(
        baseTenant(),
        {
          species_not_handled: ['Reptiles'],
          redirect_info: 'Call County Animal Control at 555-0000',
        },
        emptyBot,
      )
      expect(result).toContain('## Species We Do Not Handle')
      expect(result).toContain('Reptiles')
      expect(result).toContain('Redirect callers: Call County Animal Control at 555-0000')
    })

    it('does not include redirect info when species_not_handled is absent', () => {
      const result = compileInstruction(
        baseTenant(),
        { redirect_info: 'Call County Animal Control' },
        emptyBot,
      )
      expect(result).not.toContain('Redirect callers')
    })

    it('does not generate section for empty species arrays', () => {
      const result = compileInstruction(
        baseTenant(),
        { species_handled: [], species_not_handled: [] },
        emptyBot,
      )
      expect(result).not.toContain('Species')
    })
  })

  describe('Triage Rules section', () => {
    it('generates triage rules section', () => {
      const result = compileInstruction(
        baseTenant(),
        { triage_rules: 'Priority 1: bleeding or broken bones' },
        emptyBot,
      )
      expect(result).toContain('## Triage Rules')
      expect(result).toContain('Priority 1: bleeding or broken bones')
    })
  })

  describe('Intake Procedures section', () => {
    it('generates intake procedures section', () => {
      const result = compileInstruction(
        baseTenant(),
        { intake_procedures: 'Ask species, location, condition' },
        emptyBot,
      )
      expect(result).toContain('## Intake Procedures')
      expect(result).toContain('Ask species, location, condition')
    })
  })

  describe('Emergency Contacts section', () => {
    it('generates emergency contacts section', () => {
      const result = compileInstruction(
        baseTenant(),
        { emergency_contacts: 'After hours: Dr. Smith 555-1111' },
        emptyBot,
      )
      expect(result).toContain('## Emergency Contacts')
      expect(result).toContain('After hours: Dr. Smith 555-1111')
    })
  })

  describe('Bot Behavior section', () => {
    it('generates section with tone', () => {
      const result = compileInstruction(baseTenant(), emptyOrg, { tone: 'Warm and reassuring' })
      expect(result).toContain('## Bot Behavior')
      expect(result).toContain('Tone: Warm and reassuring')
    })

    it('generates section with always_say and never_say', () => {
      const result = compileInstruction(baseTenant(), emptyOrg, {
        always_say: 'Please call us if the animal is in distress',
        never_say: 'Do not recommend euthanasia',
      })
      expect(result).toContain('Always include: Please call us if the animal is in distress')
      expect(result).toContain('Never say: Do not recommend euthanasia')
    })

    it('generates section with greeting and closing', () => {
      const result = compileInstruction(baseTenant(), emptyOrg, {
        greeting: 'Welcome to WildCare!',
        closing: 'Thank you for helping wildlife.',
      })
      expect(result).toContain('Opening greeting: Welcome to WildCare!')
      expect(result).toContain('Closing message: Thank you for helping wildlife.')
    })

    it('omits section when no overrides are present', () => {
      const result = compileInstruction(baseTenant(), emptyOrg, emptyBot)
      expect(result).not.toContain('Bot Behavior')
    })
  })

  describe('Additional Protocols section', () => {
    it('appends raw protocols', () => {
      const result = compileInstruction(
        baseTenant(),
        emptyOrg,
        emptyBot,
        'Always ask about the location of the animal.',
      )
      expect(result).toContain('## Additional Protocols')
      expect(result).toContain('Always ask about the location of the animal.')
    })

    it('trims whitespace from raw protocols', () => {
      const result = compileInstruction(
        baseTenant(),
        emptyOrg,
        emptyBot,
        '  \n  Some protocol text  \n  ',
      )
      expect(result).toContain('## Additional Protocols\nSome protocol text')
    })
  })

  describe('species_config modes', () => {
    it('builtin mode produces no output', () => {
      const result = compileInstruction(
        baseTenant(),
        { species_config: { Raccoon: { mode: 'builtin' } } },
        emptyBot,
      )
      expect(result).not.toContain('Raccoon')
    })

    it('augment mode adds org-specific notes section', () => {
      const result = compileInstruction(
        baseTenant(),
        {
          species_config: {
            Raccoon: { mode: 'augment', notes: 'We see lots of juveniles in spring' },
          },
        },
        emptyBot,
      )
      expect(result).toContain('## Organization-Specific Notes')
      expect(result).toContain('Raccoon: We see lots of juveniles in spring')
    })

    it('augment mode without notes produces no output', () => {
      const result = compileInstruction(
        baseTenant(),
        { species_config: { Raccoon: { mode: 'augment' } } },
        emptyBot,
      )
      expect(result).not.toContain('Raccoon')
    })

    it('override mode replaces guide with custom protocol', () => {
      const result = compileInstruction(
        baseTenant(),
        {
          species_config: {
            Opossum: { mode: 'override', notes: 'Our custom opossum protocol here' },
          },
        },
        emptyBot,
      )
      expect(result).toContain('## Protocol Overrides')
      expect(result).toContain('### Opossum')
      expect(result).toContain('IGNORE the built-in guide for this species')
      expect(result).toContain('Our custom opossum protocol here')
    })

    it('override mode without notes produces no output', () => {
      const result = compileInstruction(
        baseTenant(),
        { species_config: { Opossum: { mode: 'override' } } },
        emptyBot,
      )
      expect(result).not.toContain('Opossum')
    })

    it('skip mode generates redirect with per-species redirect', () => {
      const result = compileInstruction(
        baseTenant(),
        {
          species_config: {
            'Marine mammals': { mode: 'skip', redirect: 'Call Marine Mammal Center at 415-289-7325' },
          },
        },
        emptyBot,
      )
      expect(result).toContain('## Species We Do Not Handle')
      expect(result).toContain('Marine mammals: We do NOT handle this species')
      expect(result).toContain('Redirect: Call Marine Mammal Center at 415-289-7325')
    })

    it('skip mode falls back to orgConfig redirect_info', () => {
      const result = compileInstruction(
        baseTenant(),
        {
          species_config: { Reptiles: { mode: 'skip' } },
          redirect_info: 'Call County Animal Control',
        },
        emptyBot,
      )
      expect(result).toContain('Redirect: Call County Animal Control')
    })

    it('skip mode falls back to default redirect when no redirect_info', () => {
      const result = compileInstruction(
        baseTenant(),
        { species_config: { Reptiles: { mode: 'skip' } } },
        emptyBot,
      )
      expect(result).toContain('Redirect: Contact your local wildlife agency')
    })

    it('multiple species_config modes in one config', () => {
      const result = compileInstruction(
        baseTenant(),
        {
          species_config: {
            Raccoon: { mode: 'builtin' },
            Opossum: { mode: 'augment', notes: 'Extra opossum info' },
            Skunk: { mode: 'override', notes: 'Custom skunk protocol' },
            Reptiles: { mode: 'skip', redirect: 'Call reptile rescue' },
          },
        },
        emptyBot,
      )
      expect(result).not.toContain('Raccoon')
      expect(result).toContain('## Organization-Specific Notes')
      expect(result).toContain('Opossum: Extra opossum info')
      expect(result).toContain('## Protocol Overrides')
      expect(result).toContain('### Skunk')
      expect(result).toContain('## Species We Do Not Handle')
      expect(result).toContain('Reptiles')
    })

    it('species_config suppresses legacy species lists', () => {
      const result = compileInstruction(
        baseTenant(),
        {
          species_config: { Raccoon: { mode: 'builtin' } },
          species_handled: ['Songbirds', 'Raptors'],
          species_not_handled: ['Marine mammals'],
        },
        emptyBot,
      )
      // Legacy sections should not appear when species_config is present
      expect(result).not.toContain('## Species We Handle')
      expect(result).not.toContain('Songbirds')
    })
  })

  describe('custom_species', () => {
    it('generates Additional Species Protocols section', () => {
      const result = compileInstruction(
        baseTenant(),
        {
          custom_species: [
            { name: 'Sugar Glider', protocol: 'Keep warm. Do not feed cow milk.' },
          ],
        },
        emptyBot,
      )
      expect(result).toContain('## Additional Species Protocols')
      expect(result).toContain('### Sugar Glider')
      expect(result).toContain('Keep warm. Do not feed cow milk.')
    })

    it('generates multiple custom species entries', () => {
      const result = compileInstruction(
        baseTenant(),
        {
          custom_species: [
            { name: 'Sugar Glider', protocol: 'Glider protocol here' },
            { name: 'Hedgehog', protocol: 'Hedgehog protocol here' },
          ],
        },
        emptyBot,
      )
      expect(result).toContain('### Sugar Glider')
      expect(result).toContain('### Hedgehog')
    })

    it('filters out entries with empty name or protocol', () => {
      const result = compileInstruction(
        baseTenant(),
        {
          custom_species: [
            { name: '', protocol: 'No name' },
            { name: 'Valid', protocol: '' },
            { name: 'Sugar Glider', protocol: 'Real protocol' },
          ],
        },
        emptyBot,
      )
      expect(result).toContain('### Sugar Glider')
      expect(result).not.toContain('No name')
      expect(result).not.toContain('### Valid')
    })

    it('produces no section for empty custom_species array', () => {
      const result = compileInstruction(
        baseTenant(),
        { custom_species: [] },
        emptyBot,
      )
      expect(result).not.toContain('Additional Species Protocols')
    })
  })

  describe('triage_config is not compiled', () => {
    it('triage_config does not appear in compiled instruction', () => {
      const result = compileInstruction(
        baseTenant(),
        {
          triage_config: [
            { label: 'Bat exposure', patterns: ['bat'], urgency: 'critical', hint: 'Transfer immediately' },
          ],
        },
        emptyBot,
      )
      expect(result).not.toContain('Bat exposure')
      expect(result).not.toContain('Transfer immediately')
      expect(result).not.toContain('triage')
    })
  })

  describe('Bot overrides closing field', () => {
    it('generates closing message', () => {
      const result = compileInstruction(baseTenant(), emptyOrg, {
        closing: 'Thank you for helping wildlife!',
      })
      expect(result).toContain('## Bot Behavior')
      expect(result).toContain('Closing message: Thank you for helping wildlife!')
    })

    it('generates closing alongside other overrides', () => {
      const result = compileInstruction(baseTenant(), emptyOrg, {
        tone: 'Professional',
        closing: 'Goodbye and thank you.',
      })
      expect(result).toContain('Tone: Professional')
      expect(result).toContain('Closing message: Goodbye and thank you.')
    })
  })

  describe('full integration', () => {
    it('generates all sections in order when all fields provided', () => {
      const result = compileInstruction(
        baseTenant({
          phone: '555-1234',
          email: 'info@wildcare.org',
          url: 'https://wildcare.org',
          location_service_area: 'Bay Area',
          location_county: 'Marin',
          location_state: 'CA',
        }),
        {
          hours: '9am-5pm',
          after_hours_phone: '555-9999',
          species_handled: ['Songbirds', 'Raptors'],
          species_not_handled: ['Marine mammals'],
          redirect_info: 'Call Marine Mammal Center',
          triage_rules: 'Priority 1: bleeding',
          intake_procedures: 'Collect species + location',
          emergency_contacts: 'Dr. Smith 555-1111',
        },
        {
          tone: 'Warm',
          always_say: 'Call us',
          never_say: 'No euthanasia advice',
          greeting: 'Hello!',
          closing: 'Goodbye!',
        },
        'Custom protocol here.',
      )

      // Contact facts are no longer compiled here (they live in the
      // chat-prompt identity block); the first compiled section is now the
      // species list.
      expect(result).not.toContain('## Service Area & Contact')
      const handledIdx = result.indexOf('## Species We Handle')
      const notHandledIdx = result.indexOf('## Species We Do Not Handle')
      const triageIdx = result.indexOf('## Triage Rules')
      const intakeIdx = result.indexOf('## Intake Procedures')
      const emergencyIdx = result.indexOf('## Emergency Contacts')
      const behaviorIdx = result.indexOf('## Bot Behavior')
      const protocolsIdx = result.indexOf('## Additional Protocols')

      expect(handledIdx).toBeGreaterThanOrEqual(0)
      expect(notHandledIdx).toBeGreaterThan(handledIdx)
      expect(triageIdx).toBeGreaterThan(notHandledIdx)
      expect(intakeIdx).toBeGreaterThan(triageIdx)
      expect(emergencyIdx).toBeGreaterThan(intakeIdx)
      expect(behaviorIdx).toBeGreaterThan(emergencyIdx)
      expect(protocolsIdx).toBeGreaterThan(behaviorIdx)

      // Verify sections are separated by double newlines
      expect(result).toContain('\n\n## Species We Do Not Handle')
      expect(result).toContain('Redirect callers: Call Marine Mammal Center')
    })
  })
})
