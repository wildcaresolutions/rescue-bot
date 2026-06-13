/**
 * Pull a {passed, reasoning} object out of the judge LLM's response.
 * Tolerates: leading prose, ```json fences, multiple JSON-shaped fragments
 * (returns the one with a "passed" key — typically the last/intended one),
 * smart quotes, trailing commas. Returns null if nothing recoverable.
 *
 * The previous one-liner — `text.match(/\{[\s\S]*\}/)` — grabbed the
 * widest brace pair, which on llama prose like "Reasoning: {bot does
 * good stuff}. Verdict: {passed: true, reasoning: ...}" returned the
 * FIRST brace pair (the prose one) and JSON.parse failed → fell to the
 * deterministic regex.
 */
export function extractJudgeJson(text: string): { passed: boolean; reasoning?: string } | null {
  // Strip ```json … ``` fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const haystack = fenced ? fenced[1] : text
  // Find all balanced {...} substrings via depth scan. Walk left-to-right;
  // each time depth returns to 0, capture the candidate.
  const candidates: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < haystack.length; i++) {
    const c = haystack[i]
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        candidates.push(haystack.slice(start, i + 1))
        start = -1
      }
    }
  }
  // Reverse so we prefer the LAST candidate that parses + contains 'passed'.
  for (const cand of candidates.reverse()) {
    try {
      // Smart-quote tolerance + trailing comma cleanup.
      const cleaned = cand
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/,\s*([}\]])/g, '$1')
      const parsed = JSON.parse(cleaned)
      const p = parsed.passed
      if (typeof p === 'boolean' || typeof p === 'string' || typeof p === 'number') {
        // Accept the spread of shapes judge models actually emit:
        // true/false, "true"/"pass"/"yes", or 1/0. Anything else is a miss.
        const passed = p === true || p === 1
          || (typeof p === 'string' && /^(true|pass|passed|yes|y)$/i.test(p.trim()))
        return { passed, reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '' }
      }
    } catch { /* try next candidate */ }
  }
  return null
}

/**
 * Sanitize the eval judge's reasoning string for surface-area exposed to
 * end-users via the run_test_scenario tool. Strips internal phrasing
 * (judge call failed, deterministic fallback) and replaces "judge" with
 * "result check" so operators don't see the internal noun.
 *
 * Moved here from the deleted lib/test-state.ts (ralph-2 M3).
 */
export function formatTestResultExplanation(reason: string | null | undefined): string {
  return String(reason || '')
    .replace(/^Basic scoring check:\s*/i, '')
    .replace(/^Deterministic fallback:\s*/i, '')
    .replace(/^Judge call failed:.*$/i, 'The result could not be scored.')
    .replace(/^Eval run failed\.?$/i, 'The test could not be completed.')
    .replace(/^(AI judge|Scoring service) unavailable\s*\((.*?)\)\.\s*/i, 'The result could not be scored. ')
    .replace(/\bjudge\b/gi, 'result check')
    .trim()
}
