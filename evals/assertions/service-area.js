/**
 * Service Area Check Assertion (Phase 1.4)
 * Validates geographic boundary handling - CRITICAL SAFETY CHECK
 */

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const serviceAreas = _require('./config/service-areas.json')
import { extractLocation } from './utils.js'

/**
 * @param {string} output - The agent's response text
 * @param {object} config - Assertion config (unused, reserved for future use)
 * @param {{ vars?: { user_input?: string } }} context - Promptfoo test context
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
export function serviceAreaCheckAssertion(output, config, context) {
  const userInput = context.vars?.user_input || ''
  const location = extractLocation(userInput)

  const isMarinCounty = serviceAreas.marinCounty.some(city => location.toLowerCase().includes(city))
  const outsideArea = Object.keys(serviceAreas.outsideAreas).find(area => location.toLowerCase().includes(area))

  if (outsideArea) {
    const outputLower = output.toLowerCase()

    // CRITICAL: Must NOT tell user to bring to WildCare
    // Note: "our facility" can be used to EXPLAIN limitations (e.g., "Our facility only treats Marin animals")
    // So we check for specific referral phrases, not explanatory phrases
    const badReferrals = [
      'bring to wildcare',
      'bring it to wildcare',
      'take to wildcare',
      'take it to wildcare',
      'come to wildcare',
      'visit wildcare',
      'drop off at wildcare',
      '76 albert',  // WildCare's address
    ]

    const hasBadReferral = badReferrals.some(phrase => outputLower.includes(phrase))

    if (hasBadReferral) {
      return {
        pass: false,
        score: 0,
        reason: `CRITICAL: Told ${location} user to bring to WildCare (outside service area)`,
      }
    }

    // MUST suggest alternative resource
    const { alternative, phone } = serviceAreas.outsideAreas[outsideArea]
    const hasAlternative = (
      outputLower.includes(alternative.toLowerCase()) ||
      (phone && output.includes(phone))
    )

    if (!hasAlternative) {
      return {
        pass: false,
        score: 0.3,
        reason: `Did not provide alternative resource for ${location} (expected: ${alternative})`,
      }
    }

    return {
      pass: true,
      score: 1,
      reason: `Correctly referred ${location} user to ${alternative}`,
    }
  }

  // If Marin County, should mention WildCare
  if (isMarinCounty) {
    const mentionsWildCare = output.toLowerCase().includes('wildcare')
    return {
      pass: mentionsWildCare,
      score: mentionsWildCare ? 1 : 0.5,
      reason: mentionsWildCare
        ? 'Correctly referred Marin County user to WildCare'
        : 'Did not mention WildCare for Marin County user',
    }
  }

  // Location unclear - not a failure, but flag it
  return {
    pass: true,
    score: 0.8,
    reason: 'Could not determine location from input',
  }
}
