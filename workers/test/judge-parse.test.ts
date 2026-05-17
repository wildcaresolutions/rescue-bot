import { describe, expect, it } from 'vitest'
import { extractJudgeJson } from '../src/lib/judge-parse'

describe('extractJudgeJson', () => {
  it('parses a clean single-line JSON verdict', () => {
    const text = '{"passed": true, "reasoning": "bot redirected correctly"}'
    expect(extractJudgeJson(text)).toEqual({ passed: true, reasoning: 'bot redirected correctly' })
  })

  it('parses a JSON object with passed:false', () => {
    const text = '{"passed": false, "reasoning": "no redirect"}'
    expect(extractJudgeJson(text)).toEqual({ passed: false, reasoning: 'no redirect' })
  })

  it('handles ```json fenced output', () => {
    const text = '```json\n{"passed": true, "reasoning": "good"}\n```'
    expect(extractJudgeJson(text)).toEqual({ passed: true, reasoning: 'good' })
  })

  it('handles bare ``` fences without language tag', () => {
    const text = '```\n{"passed": false, "reasoning": "no"}\n```'
    expect(extractJudgeJson(text)).toEqual({ passed: false, reasoning: 'no' })
  })

  it('prefers the LAST braced fragment with a "passed" key', () => {
    // llama prose pattern: includes a prose blob with braces, then a verdict.
    const text = 'Reasoning: {bot does good stuff}. Verdict: {"passed": true, "reasoning": "ok"}'
    expect(extractJudgeJson(text)).toEqual({ passed: true, reasoning: 'ok' })
  })

  it('normalizes smart quotes around keys/values', () => {
    const text = '{“passed”: true, “reasoning”: “smart quotes”}'
    expect(extractJudgeJson(text)).toEqual({ passed: true, reasoning: 'smart quotes' })
  })

  it('tolerates trailing commas', () => {
    const text = '{"passed": true, "reasoning": "ok",}'
    expect(extractJudgeJson(text)).toEqual({ passed: true, reasoning: 'ok' })
  })

  it('accepts string "true" / "pass" as passing', () => {
    expect(extractJudgeJson('{"passed": "true"}')?.passed).toBe(true)
    expect(extractJudgeJson('{"passed": "pass"}')?.passed).toBe(true)
    expect(extractJudgeJson('{"passed": "false"}')?.passed).toBe(false)
  })

  it('returns null for completely unparseable input', () => {
    expect(extractJudgeJson('this is not json at all')).toBeNull()
    expect(extractJudgeJson('')).toBeNull()
  })

  it('returns null when no candidate has a "passed" key', () => {
    const text = '{"foo": 1} {"bar": 2}'
    expect(extractJudgeJson(text)).toBeNull()
  })

  it('falls back to default reasoning when reasoning missing', () => {
    const text = '{"passed": true}'
    expect(extractJudgeJson(text)).toEqual({ passed: true, reasoning: '' })
  })

  it('handles malformed JSON in the middle, recovers from later candidate', () => {
    const text = '{passed: not json} and then {"passed": true, "reasoning": "rec"}'
    expect(extractJudgeJson(text)).toEqual({ passed: true, reasoning: 'rec' })
  })

  it('handles nested objects in reasoning', () => {
    const text = '{"passed": true, "reasoning": "outer", "details": {"inner": "yes"}}'
    expect(extractJudgeJson(text)?.passed).toBe(true)
  })

  it('parses leading prose then JSON object', () => {
    const text = 'Here is my verdict:\n{"passed": false, "reasoning": "missing X"}'
    expect(extractJudgeJson(text)).toEqual({ passed: false, reasoning: 'missing X' })
  })

  it('ignores numeric "passed" values', () => {
    // Only boolean | string is accepted.
    const text = '{"passed": 1, "reasoning": "should be ignored"}'
    expect(extractJudgeJson(text)).toBeNull()
  })
})
