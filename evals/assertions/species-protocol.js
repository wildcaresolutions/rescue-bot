/**
 * Species Protocol Assertion (Phase 1.6)
 * Validates species-specific safety protocols
 */

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const protocols = _require('./config/species-protocols.json')
import { semanticMatchAssertion } from './semantic-match.js'
import { semanticForbiddenAssertion } from './semantic-forbidden.js'
import { resourceValidationAssertion } from './resource-validation.js'

/**
 * @param {string} output - The agent's response text
 * @param {string} speciesType - Key into species-protocols.json (e.g. 'raptor', 'deer')
 * @param {{ vars?: object }} context - Promptfoo test context
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
export function speciesProtocolAssertion(output, speciesType, context) {
  const protocol = protocols[speciesType]
  if (!protocol) {
    return {
      pass: false,
      score: 0,
      reason: `Unknown species type: ${speciesType}`,
    }
  }

  // Check required elements using semantic matching
  const requiredResult = semanticMatchAssertion(output, protocol.required, context)

  // Check forbidden elements
  const forbiddenResult = semanticForbiddenAssertion(output, protocol.forbidden, context)

  // Check resources if any
  let resourceResult = { pass: true, score: 1 }
  if (protocol.resources.length > 0) {
    resourceResult = resourceValidationAssertion(output, protocol.resources, context)
  }

  const allPass = requiredResult.pass && forbiddenResult.pass && resourceResult.pass
  const avgScore = (requiredResult.score + forbiddenResult.score + resourceResult.score) / 3

  return {
    pass: allPass,
    score: avgScore,
    reason: allPass
      ? `Correct ${speciesType} protocol followed`
      : `Protocol violations: ${[
        !requiredResult.pass ? requiredResult.reason : null,
        !forbiddenResult.pass ? forbiddenResult.reason : null,
        !resourceResult.pass ? resourceResult.reason : null,
      ].filter(Boolean).join('; ')}`,
  }
}
