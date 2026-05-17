/**
 * RAG Retrieval Quality Assertion
 *
 * Verifies that the response contains terminology specific to an expected
 * document section, confirming the correct RAG chunk was retrieved.
 *
 * Usage in promptfooconfig.yaml:
 *   assert:
 *     - type: javascript
 *       value: |
 *         const { ragRetrievalAssertion } = await import('./evals/assertions/rag-retrieval.js')
 *         return ragRetrievalAssertion(output, {
 *           requiredTerms: ['neonate', 'light gloves', 'warmth'],
 *           forbiddenTerms: ['heavy gloves'],  // optional
 *           source: 'raccoon_rescue_and_care.txt'
 *         })
 */

/**
 * @param {string} output - Agent's response text
 * @param {Object} config - Assertion config
 * @param {string[]} config.requiredTerms - Terms that must appear (from expected doc section)
 * @param {string[]} [config.forbiddenTerms] - Terms that must NOT appear
 * @param {string} config.source - Expected source document (for error messages)
 * @returns {Object} Assertion result { pass, score, reason }
 */
export function ragRetrievalAssertion(output, config) {
  const lower = output.toLowerCase()
  const { requiredTerms, forbiddenTerms = [], source } = config

  const foundRequired = requiredTerms.filter(t => lower.includes(t.toLowerCase()))
  const missingRequired = requiredTerms.filter(t => !lower.includes(t.toLowerCase()))
  const foundForbidden = forbiddenTerms.filter(t => lower.includes(t.toLowerCase()))

  const requiredScore = requiredTerms.length > 0
    ? foundRequired.length / requiredTerms.length
    : 1
  const forbiddenPenalty = foundForbidden.length > 0 ? 0.3 : 0
  const score = Math.max(0, requiredScore - forbiddenPenalty)
  const pass = missingRequired.length === 0 && foundForbidden.length === 0

  const reasons = []
  if (missingRequired.length > 0) {
    reasons.push(`Missing retrieval markers: ${missingRequired.join(', ')}`)
  }
  if (foundForbidden.length > 0) {
    reasons.push(`Found forbidden terms: ${foundForbidden.join(', ')}`)
  }
  if (pass) {
    reasons.push(`All ${requiredTerms.length} retrieval markers present from ${source}`)
  }

  return { pass, score, reason: reasons.join('; ') }
}
