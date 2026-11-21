/**
 * logUsage — records token usage per tenant/date/model into the usage_log
 * table. Extracted from routes/chat.ts so it can be shared by any route that
 * calls the AI gateway (e.g. the copilot agent route).
 */
import type { Env } from './types'

type UsageShape = Record<string, unknown> | null | undefined

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Normalizes the usage shapes we see — AI SDK (`inputTokens`/`outputTokens`),
 * legacy camelCase, and OpenAI-format `/compat` (`prompt_tokens`/
 * `completion_tokens`/`total_tokens`) — into billable prompt/completion counts.
 *
 * Thinking models (Gemini 4) bill thinking tokens as output; some providers
 * leave them out of `completion_tokens` but include them in `total_tokens`, so
 * completion is taken as `total - prompt` when that is larger.
 */
export function usageTokens(usage: unknown): { promptTokens: number; completionTokens: number } {
  const u = usage as UsageShape
  const promptTokens = num(u?.promptTokens) ?? num(u?.inputTokens) ?? num(u?.prompt_tokens) ?? 0
  let completionTokens = num(u?.completionTokens) ?? num(u?.outputTokens) ?? num(u?.completion_tokens) ?? 0
  const total = num(u?.totalTokens) ?? num(u?.total_tokens)
  if (total !== undefined && total - promptTokens > completionTokens) {
    completionTokens = total - promptTokens
  }
  return { promptTokens, completionTokens }
}

export async function logUsage(
  env: Env,
  tenantId: string,
  model: string,
  usage: unknown,
): Promise<void> {
  const { promptTokens, completionTokens } = usageTokens(usage)
  const today = new Date().toISOString().slice(0, 10)
  await env.DB.prepare(
    `INSERT INTO usage_log (tenant_id, date, model, prompt_tokens, completion_tokens, request_count)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).bind(tenantId, today, model, promptTokens, completionTokens).run()
}
