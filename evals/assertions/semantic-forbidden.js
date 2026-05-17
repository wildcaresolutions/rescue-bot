/**
 * Semantic Forbidden Assertion (Phase 1.3)
 * Ensures forbidden concepts are NOT present
 * IMPORTANT: Ignores mentions that are in warning/negation context (e.g., "do not touch with bare hands")
 */

import { createRequire } from 'node:module'
import { findAllOccurrences } from './utils.js'

const _require = createRequire(import.meta.url)
const synonyms = _require('./config/synonyms.json')
const safetyTerms = _require('./config/safety-terms.json')

/**
 * @param {string} output - The agent's response text
 * @param {string|string[]} forbidden - Concepts that must not appear (unless negated)
 * @param {object} _context - Promptfoo test context (unused)
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
export function semanticForbiddenAssertion(output, forbidden, _context) {
  const forbiddenList = Array.isArray(forbidden) ? forbidden : [forbidden]
  const violations = []
  const outputLower = output.toLowerCase()

  // Check if term appears in an exclusion phrase context
  function isInExclusionContext(term) {
    return safetyTerms.exclusionPhrases.some(phrase => {
      const phraseLower = phrase.toLowerCase()
      return phraseLower.includes(term) && outputLower.includes(phraseLower)
    })
  }

  for (const concept of forbiddenList) {
    const conceptLower = concept.toLowerCase()

    // Skip if this concept appears in an exclusion phrase
    if (isInExclusionContext(conceptLower)) {
      continue
    }

    const variants = [conceptLower, ...(synonyms[conceptLower] || [])]
    let foundViolation = false

    // Check if concept appears in output in a non-negated context
    for (const variant of variants) {
      if (foundViolation) break

      // Skip variants that are in exclusion context
      if (isInExclusionContext(variant)) {
        continue
      }

      const occurrences = findAllOccurrences(outputLower, variant)
      for (const idx of occurrences) {
        // Check if this mention is in a negation context (within 40 chars before OR 30 chars after)
        const contextStart = Math.max(0, idx - 40)
        const contextEnd = Math.min(outputLower.length, idx + variant.length + 30)
        const beforeContext = outputLower.substring(contextStart, idx)
        const afterContext = outputLower.substring(idx + variant.length, contextEnd)
        const isNegatedBefore = safetyTerms.negationPatterns.some(neg => beforeContext.includes(neg))
        const isNegatedAfter = safetyTerms.negationPatterns.some(neg => afterContext.includes(neg))

        if (!isNegatedBefore && !isNegatedAfter) {
          violations.push(concept)
          foundViolation = true
          break // Found a non-negated occurrence, flag this concept
        }
      }
    }
  }

  return {
    pass: violations.length === 0,
    score: violations.length > 0 ? 0 : 1,
    reason: violations.length > 0
      ? `Contains forbidden concepts: ${violations.join(', ')}`
      : 'No forbidden concepts detected',
  }
}
