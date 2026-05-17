/**
 * Assertion Utility Functions
 *
 * Helper functions for custom Promptfoo assertions.
 * Provides text matching, location extraction, and markdown handling.
 */

/**
 * Extract location from user input
 * Looks for common location patterns (city names, "in X", "from X", etc.)
 *
 * @param {string} userInput - User's input text
 * @returns {string} Extracted location or empty string if not found
 *
 * @example
 * extractLocation("I'm in San Francisco");
 * // Returns: "san francisco"
 */
export function extractLocation(userInput) {
  const text = userInput.toLowerCase()

  // Common location patterns
  const patterns = [
    /(?:in|from|at|near)\s+([a-z\s]+?)(?:\.|,|$|\s+and|\s+it)/i,
    /(san francisco|half moon bay|san mateo|sacramento|marin|novato|mill valley|sausalito|tiburon|san rafael)/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      return match[1] || match[0]
    }
  }

  return ''
}

/**
 * Check if text contains any variant from a list of patterns
 * Case-insensitive matching
 *
 * @param {string} text - Text to search in
 * @param {Array<string>} patterns - Array of patterns to search for
 * @returns {boolean} True if any pattern is found
 *
 * @example
 * containsAnyVariant("contact WildCare", ["wildcare", "wildlife center"]);
 * // Returns: true
 */
export function containsAnyVariant(text, patterns) {
  const normalized = text.toLowerCase()
  return patterns.some(pattern => normalized.includes(pattern.toLowerCase()))
}

/**
 * Strip markdown formatting for accurate text matching
 * Handles cases like "Do **not**" which should match "do not"
 *
 * @param {string} text - Text with markdown formatting
 * @returns {string} Plain text without markdown
 *
 * @example
 * stripMarkdown("Do **not** touch the animal");
 * // Returns: "Do not touch the animal"
 */
export function stripMarkdown(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')  // **bold**
    .replace(/\*([^*]+)\*/g, '$1')       // *italic*
    .replace(/__([^_]+)__/g, '$1')       // __bold__
    .replace(/_([^_]+)_/g, '$1')        // _italic_
}

/**
 * Find all word-bounded occurrences of a term
 *
 * @param {string} text - Text to search in
 * @param {string} term - Term to search for
 * @returns {Array<number>} Array of character indices where term occurs
 *
 * @example
 * findAllOccurrences("Don't touch the baby", "baby");
 * // Returns: [16]
 */
export function findAllOccurrences(text, term) {
  const indices = []
  // Use regex for word boundary matching
  const regex = new RegExp(`\\b${term}\\b`, 'gi')
  let match
  while ((match = regex.exec(text)) !== null) {
    indices.push(match.index)
  }
  return indices
}
