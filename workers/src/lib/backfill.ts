/**
 * Session analysis backfill. Sessions imported from legacy Render Postgres
 * don't have session_analysis rows. This walks every session that has
 * messages but no session_analysis row and runs the same quick analyzer
 * that the live chat path runs after each message append.
 *
 * Idempotent — sessions already analyzed are skipped at the SELECT.
 * Triggered from /admin/analyze-backfill (route in admin.ts).
 */
import type { Env } from './types'
import { quickAnalyzeSession } from '../routes/chat'

export interface BackfillResult {
  candidates: number
  analyzed: number
  failed: number
}

export async function backfillSessionAnalysis(env: Env, tenantId: string): Promise<BackfillResult> {
  const { results: missing } = await env.DB.prepare(`
    SELECT DISTINCT m.session_id
    FROM messages m
    LEFT JOIN session_analysis sa ON sa.session_id = m.session_id AND sa.tenant_id = m.tenant_id
    WHERE m.tenant_id = ? AND m.message_type = 'chat' AND sa.id IS NULL
  `).bind(tenantId).all<{ session_id: string }>()

  let analyzed = 0
  let failed = 0
  for (const { session_id } of missing) {
    try {
      await quickAnalyzeSession(env.DB, tenantId, session_id, 'backfill')
      analyzed++
    } catch (e) {
      failed++
      console.error('[backfill] session', session_id, e)
    }
  }

  return {
    candidates: missing.length,
    analyzed,
    failed,
  }
}
