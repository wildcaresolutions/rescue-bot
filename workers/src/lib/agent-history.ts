/**
 * Agent conversation persistence helpers.
 *
 * Extracted from workers/src/routes/agent.ts. Three operations the
 * route was doing inline:
 *   - loadAgentHistory:  fetch the most recent N user/assistant messages
 *     for a tenant's single setup_agent thread.
 *   - persistAgentMessage:  insert a user or assistant message into that
 *     thread (idempotent via ON CONFLICT message_id DO NOTHING).
 *   - clearAgentHistory:  drop all setup_agent messages for a tenant.
 *
 * One thread per tenant. We used to split by `agent-${context}` so each
 * tab had its own history, but the chat continuity was broken every
 * time the agent navigated the user between tabs. The context is now
 * communicated via the system prompt's `current_view`, not the
 * session_id.
 */

import { logError } from './logger'

const SESSION_ID = 'agent-main'

export async function loadAgentHistory(
  db: D1Database,
  tenantId: string,
  limit: number,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  try {
    const { results } = await db.prepare(
      `SELECT role, content FROM messages
       WHERE tenant_id = ? AND message_type = 'setup_agent' AND role IN ('user','assistant')
       ORDER BY timestamp ASC LIMIT ?`,
    ).bind(tenantId, limit).all() as { results: Array<{ role: string; content: string }> }
    return results.map(r => ({ role: r.role as 'user' | 'assistant', content: r.content }))
  } catch (e) {
    logError('agent/load-history-failed', { error: e })
    return []
  }
}

/**
 * Fire-and-forget insert. The route wraps this in `c.executionCtx.waitUntil`.
 * `content` is hard-capped at 32k chars to avoid blowing past D1 row limits
 * if the assistant returns an absurdly long stream.
 */
export function persistAgentMessage(
  db: D1Database,
  tenantId: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<unknown> {
  const msgId = `msg-${crypto.randomUUID()}`
  return db.prepare(
    `INSERT INTO messages (session_id, message_id, role, content, timestamp, message_type, tenant_id)
     VALUES (?, ?, ?, ?, ?, 'setup_agent', ?) ON CONFLICT (message_id) DO NOTHING`,
  ).bind(SESSION_ID, msgId, role, content.slice(0, 32_000), Date.now(), tenantId).run()
    .catch(e => logError('agent/persist-message-failed', { role, error: e }))
}

export async function clearAgentHistory(db: D1Database, tenantId: string): Promise<void> {
  await db.prepare(
    "DELETE FROM messages WHERE tenant_id = ? AND message_type = 'setup_agent'",
  ).bind(tenantId).run()
}
