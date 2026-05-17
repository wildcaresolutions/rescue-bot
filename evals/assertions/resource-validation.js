/**
 * Resource Validation Assertion (Phase 1.5)
 * Ensures specific URLs, phone numbers, organizations are mentioned
 */

/**
 * @param {string} output - The agent's response text
 * @param {string|string[]} resources - URLs, phone numbers, or org names to check for
 * @param {object} _context - Promptfoo test context (unused)
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
export function resourceValidationAssertion(output, resources, _context) {
  const requiredResources = Array.isArray(resources) ? resources : [resources]
  const missing = []

  for (const resource of requiredResources) {
    let found = false

    // Check for URLs (allow paraphrasing)
    if (resource.includes('.com') || resource.includes('.org') || resource.includes('.gov')) {
      const domain = resource.match(/([a-z0-9-]+\.(com|org|gov))/i)?.[1]
      if (domain && output.toLowerCase().includes(domain.toLowerCase())) {
        found = true
      }
    }

    // Check for phone numbers (flexible formatting)
    else if (/\d{3}[-.]?\d{3}[-.]?\d{4}/.test(resource)) {
      const digits = resource.replace(/\D/g, '')
      const outputDigits = output.replace(/\D/g, '')
      if (outputDigits.includes(digits)) {
        found = true
      }
    }

    // Check for organization names (partial matching)
    else {
      const normalized = resource.toLowerCase()
      if (output.toLowerCase().includes(normalized)) {
        found = true
      }
    }

    if (!found) {
      missing.push(resource)
    }
  }

  return {
    pass: missing.length === 0,
    score: 1 - (missing.length / requiredResources.length),
    reason: missing.length > 0
      ? `Missing required resources: ${missing.join(', ')}`
      : 'All required resources mentioned',
  }
}
