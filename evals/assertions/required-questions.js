/**
 * Required Questions Assertion (Phase 1.7)
 * Ensures agent asks clarifying questions
 */

/**
 * @param {string} output - The agent's response text
 * @param {string|string[]} expectedQuestions - Expected clarifying question topics
 * @param {object} _context - Promptfoo test context (unused)
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
export function requiredQuestionsAssertion(output, expectedQuestions, _context) {
  const questions = Array.isArray(expectedQuestions) ? expectedQuestions : [expectedQuestions]
  const missing = []
  const outputLower = output.toLowerCase()

  // Check if the output contains question marks (indicating clarifying questions)
  const hasQuestions = output.includes('?')
  if (!hasQuestions) {
    return {
      pass: false,
      score: 0,
      reason: 'Agent did not ask any clarifying questions',
    }
  }

  // Check if each expected topic is addressed in the full output (not just in ? sentences)
  for (const question of questions) {
    // Extract key concepts from the expected question
    const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    // Check if at least half of the keywords are present
    const foundKeywords = keywords.filter(keyword => outputLower.includes(keyword))
    const hasQuestion = foundKeywords.length >= Math.ceil(keywords.length * 0.5)

    if (!hasQuestion) {
      missing.push(question)
    }
  }

  return {
    pass: missing.length === 0,
    score: 1 - (missing.length / questions.length),
    reason: missing.length > 0
      ? `Missing required questions: ${missing.join(', ')}`
      : 'All required questions asked',
  }
}
