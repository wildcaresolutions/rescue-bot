/**
 * Default triage rules shipped with the platform.
 * Tenants can override, augment, or delete these in their org_config.triage_config.
 */

export interface TriageRule {
  id: string
  label: string
  patterns: string[]
  urgency: 'critical' | 'urgent' | 'moderate' | 'info'
  hint: string
  builtin: boolean
}

export const DEFAULT_TRIAGE_RULES: TriageRule[] = [
  {
    id: 'bat-exposure',
    label: 'Bat in living space / rabies exposure',
    patterns: ['bat.*house', 'bat.*bedroom', 'bat.*room', 'rabies', 'bat.*inside'],
    urgency: 'critical',
    hint: 'Potential rabies exposure. Transfer to intake coordinator immediately. Do NOT advise handling.',
    builtin: true,
  },
  {
    id: 'snake-bite',
    label: 'Snake bite or venomous animal contact',
    patterns: ['snake.*bite', 'bitten.*snake', 'rattlesnake', 'venomous'],
    urgency: 'critical',
    hint: 'Direct caller to 911 or poison control first, then wildlife intake.',
    builtin: true,
  },
  {
    id: 'cat-attack',
    label: 'Cat-caught animal',
    patterns: ['cat.*caught', 'cat.*brought', 'cat.*attack', 'cat.*got', 'my cat'],
    urgency: 'urgent',
    hint: 'Cat saliva is toxic to birds/small mammals. Animal needs antibiotics within hours. Bring in ASAP.',
    builtin: true,
  },
  {
    id: 'window-strike',
    label: 'Window strike / collision',
    patterns: ['hit.*window', 'window.*strike', 'flew.*into.*window', 'window.*collision'],
    urgency: 'urgent',
    hint: 'Likely concussion. Keep in dark quiet box 2 hours. If no improvement, bring in.',
    builtin: true,
  },
  {
    id: 'bleeding-immobile',
    label: 'Bleeding or immobile animal',
    patterns: ['bleeding', 'blood', "can't move", 'not moving', 'immobile', 'paralyz'],
    urgency: 'urgent',
    hint: 'Animal needs immediate care. Guide caller through safe containment and transport.',
    builtin: true,
  },
  {
    id: 'baby-animal',
    label: 'Baby / juvenile animal found',
    patterns: ['baby', 'juvenile', 'nestling', 'fledgling', 'orphan', 'tiny', 'newborn'],
    urgency: 'moderate',
    hint: 'May not need rescue. Check if parent is nearby. Monitor before intervening.',
    builtin: true,
  },
  {
    id: 'general-injury',
    label: 'General injury or illness',
    patterns: ['injured', 'hurt', 'sick', 'found.*animal', 'found.*bird', 'limping', 'drooping'],
    urgency: 'moderate',
    hint: 'Assess situation. Guide caller through containment if animal is catchable.',
    builtin: true,
  },
  {
    id: 'general-question',
    label: 'General wildlife question',
    patterns: ['what.*do', 'how.*help', 'should.*i', 'is.*it.*normal', 'what.*kind'],
    urgency: 'info',
    hint: 'Informational inquiry. Bot can usually handle this. No follow-up needed.',
    builtin: true,
  },
]
