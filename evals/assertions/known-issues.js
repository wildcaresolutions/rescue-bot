/**
 * Known Issues Check Assertion (Phase 1.9)
 * Document recurring problems (informational, not failure)
 */

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const knownIssues = _require('./config/known-issues.json')

/**
 * @param {string} output - The agent's response text
 * @param {string|string[]} knownIssuesList - Known issue keys or regex patterns to check
 * @param {object} _context - Promptfoo test context (unused)
 * @returns {{ pass: boolean, score: number, reason: string, metadata: { knownIssues: string[] } }}
 */
export function knownIssuesCheckAssertion(output, knownIssuesList, _context) {
  const issues = Array.isArray(knownIssuesList) ? knownIssuesList : [knownIssuesList]
  const detected = []

  for (const issue of issues) {
    const patternStr = knownIssues[issue] || issue
    const pattern = new RegExp(patternStr, 'i')
    if (pattern.test(output)) {
      detected.push(issue)
    }
  }

  return {
    pass: true, // Known issues don't fail tests, just document
    score: detected.length > 0 ? 0.8 : 1, // Minor penalty
    reason: detected.length > 0
      ? `Known issues detected: ${detected.join(', ')}`
      : 'No known issues detected',
    metadata: { knownIssues: detected },
  }
}
