/**
 * Semantic Match Assertion
 *
 * Matches keywords using synonym/concept matching.
 * Checks if output contains required concepts or their synonyms.
 */

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const synonyms = _require('./config/synonyms.json')
import { containsAnyVariant } from './utils.js'

/**
 * Semantic match assertion for Promptfoo
 * Verifies output contains required concepts using synonym matching
 *
 * @param {string} output - Agent's response text
 * @param {string|Array<string>} expected - Required concept(s)
 * @param {Object} context - Promptfoo test context (vars, prompt, etc.)
 * @returns {Object} Assertion result
 * @returns {boolean} returns.pass - Whether assertion passed
 * @returns {number} returns.score - Score between 0 and 1
 * @returns {string} returns.reason - Explanation of pass/fail
 *
 * @example
 * // In promptfooconfig.yaml:
 * // assert:
 * //   - type: javascript
 * //     value: CUSTOM_ASSERTIONS['semantic-match'](output, ['transport', 'call'], context)
 */
export function semanticMatchAssertion(output, expected, _context) {
  const required = Array.isArray(expected) ? expected : [expected]
  const missing = []

  for (const concept of required) {
    const conceptLower = concept.toLowerCase()
    const variants = [conceptLower, ...(synonyms[conceptLower] || [])]

    if (!containsAnyVariant(output, variants)) {
      missing.push(concept)
    }
  }

  return {
    pass: missing.length === 0,
    score: 1 - (missing.length / required.length),
    reason: missing.length > 0
      ? `Missing required concepts: ${missing.join(', ')}`
      : 'All required concepts present',
  }
}
