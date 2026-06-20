/**
 * logUsage — records token usage per tenant/date/model into the usage_log
 * table. Extracted from routes/chat.ts so it can be shared by any route that
 * calls the AI gateway (e.g. the copilot agent route).
 */
import type { Env } from './types'

function usageTokens(usage: unknown): { promptTokens: number; completionTokens: number } {
  const u = usage as Record<string, number | undefined> | undefined
  return {
    promptTokens: u?.promptTokens ?? u?.inputTokens ?? 0,
    completionTokens: u?.completionTokens ?? u?.outputTokens ?? 0,
  }
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
