/**
 * USD per 1M tokens, used by the model-comparison evals to turn token usage
 * into a per-conversation cost. Verified 2026-11-19 against provider pricing
 * pages — update when prices change. Keys match the gateway `provider/model`
 * name with the provider prefix stripped.
 *
 * `cachedInput` applies to the cached slice of the prompt (Gemini caches
 * implicitly; Claude via /compat sends no cache_control, so gets none).
 */
export const PRICING = {
  'claude-sonnet-5': { input: 2.0, output: 10.0, cachedInput: 0.2 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cachedInput: 0.1 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cachedInput: 0.1 },
  // Requests under 100k tokens (all of ours); $0.50 / $2.50 above that.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cachedInput: 0.01 },
  'gemini-4-hydrogen': { input: 1.5, output: 7.5, cachedInput: 0.075 },
}

export function priceFor(model) {
  const bare = String(model || '').replace(/^(google-ai-studio|google|anthropic|openai|workers-ai)\//, '')
  return PRICING[bare] ?? null
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Normalizes OpenAI-format (/compat) and AI SDK usage shapes. Thinking tokens
 * are billed as output; if a provider leaves them out of completion_tokens
 * they still show up in total_tokens, so output = max(completion, total - prompt).
 */
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return { prompt: 0, completion: 0, cached: 0, reasoning: 0, total: 0 }
  const prompt = num(u.prompt_tokens ?? u.inputTokens ?? u.promptTokens)
  let completion = num(u.completion_tokens ?? u.outputTokens ?? u.completionTokens)
  const total = num(u.total_tokens ?? u.totalTokens)
  if (total - prompt > completion) completion = total - prompt
  const cached = num(u.prompt_tokens_details?.cached_tokens ?? u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens)
  const reasoning = num(u.completion_tokens_details?.reasoning_tokens ?? u.outputTokenDetails?.reasoningTokens ?? u.reasoningTokens)
  return { prompt, completion, cached, reasoning, total: prompt + completion }
}

/** Returns USD, or null when the model isn't in the price table. */
export function costFor(model, usage) {
  const price = priceFor(model)
  if (!price) return null
  const { prompt, completion, cached } = normalizeUsage(usage)
  const uncached = Math.max(0, prompt - cached)
  return (uncached * price.input + cached * (price.cachedInput ?? price.input) + completion * price.output) / 1e6
}
