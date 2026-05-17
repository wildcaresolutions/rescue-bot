/**
 * Session-list + session-detail queries for the admin UI.
 *
 * The list endpoint has four modes (needs_review, default, default+date-range,
 * tester/rating-filtered) — each backed by a distinct query. The detail
 * endpoint fans out messages + feedback + photos. SQL is verbatim from the
 * original /admin/sessions[/:id] handlers.
 */
import type { Env } from './types'
import { safeJsonParse } from './photo-feed'

export interface SessionsListQuery {
  tester?: string
  rating?: string
  limit?: string
  offset?: string
  needs_review?: string
  from?: string
  to?: string
}

export type SessionsListResult =
  | { results: unknown[] }
  | { error: string; status: number }

export async function loadSessionsList(
  env: Env,
  tenantId: string,
  q: SessionsListQuery,
): Promise<SessionsListResult> {
  const pageLimit = Math.min(parseInt(q.limit ?? '50') || 50, 200)
  const pageOffset = parseInt(q.offset ?? '0') || 0

  // Needs review: no feedback, created in last 48h, 3+ messages
  if (q.needs_review === 'true') {
    const ts48h = Date.now() - 48 * 60 * 60 * 1000
    const { results } = await env.DB.prepare(`
      SELECT m.session_id, COUNT(*) as message_count,
             MIN(m.timestamp) as first_message, MAX(m.timestamp) as last_message
      FROM messages m
      WHERE m.message_type = 'chat' AND m.tenant_id = ?
        AND m.session_id NOT IN (SELECT DISTINCT session_id FROM feedback WHERE tenant_id = ?)
        AND m.timestamp >= ?
      GROUP BY m.session_id
      HAVING COUNT(*) >= 3
      ORDER BY first_message DESC
      LIMIT ? OFFSET ?
    `).bind(tenantId, tenantId, ts48h, pageLimit, pageOffset).all()
    return { results }
  }

  if (q.tester === undefined && q.rating === undefined) {
    const { from, to } = q

    // Date-range filtered query with session_analysis data
    if (from || to) {
      const fromTs = from ? new Date(from).getTime() : 0
      const toTs = to ? new Date(to + 'T23:59:59').getTime() : Date.now()
      const { results } = await env.DB.prepare(`
        SELECT m.session_id, COUNT(*) as message_count,
               MIN(m.timestamp) as first_message, MAX(m.timestamp) as last_message,
               sa.urgency, sa.animal, sa.outcome, sa.situation, sa.needs_action, sa.contact_info, sa.triage_hint,
               f.rating
        FROM messages m
        LEFT JOIN session_analysis sa ON sa.session_id = m.session_id AND sa.tenant_id = m.tenant_id
        LEFT JOIN (SELECT session_id, rating FROM feedback WHERE tenant_id = ? GROUP BY session_id) f ON f.session_id = m.session_id
        WHERE m.message_type = 'chat' AND m.tenant_id = ?
          AND m.timestamp >= ? AND m.timestamp <= ?
        GROUP BY m.session_id ORDER BY first_message DESC
        LIMIT ? OFFSET ?
      `).bind(tenantId, tenantId, fromTs, toTs, pageLimit, pageOffset).all()
      return { results }
    }

    const { results } = await env.DB.prepare(`
      SELECT session_id, COUNT(*) as message_count,
             MIN(timestamp) as first_message, MAX(timestamp) as last_message
      FROM messages WHERE message_type = 'chat' AND tenant_id = ?
      GROUP BY session_id ORDER BY first_message DESC
      LIMIT ? OFFSET ?
    `).bind(tenantId, pageLimit, pageOffset).all()
    return { results }
  }

  const params: (string | number)[] = [tenantId]
  let where = ''
  if (q.tester !== undefined) {
    where += ' AND (si.is_tester = ? OR COALESCE(sf.fi, 0) = ?)'
    const v = q.tester === 'true' ? 1 : 0
    params.push(v, v)
  }
  if (q.rating !== undefined) {
    const r = parseInt(q.rating)
    if (r !== 0 && r !== 1) return { error: 'rating must be 0 or 1', status: 400 }
    where += ' AND sf.rating = ?'
    params.push(r)
  }

  const { results } = await env.DB.prepare(`
    WITH si AS (
      SELECT session_id,
             MAX(CASE WHEN tester_name IS NOT NULL AND tester_name != '' THEN 1 ELSE 0 END) AS is_tester,
             COUNT(*) AS message_count,
             MIN(timestamp) AS first_message,
             MAX(timestamp) AS last_message
      FROM messages WHERE message_type = 'chat' AND tenant_id = ? GROUP BY session_id
    ),
    sf AS (SELECT session_id, MAX(is_tester) AS fi, MAX(rating) AS rating FROM feedback WHERE tenant_id = ? GROUP BY session_id)
    SELECT si.session_id, si.message_count, si.first_message, si.last_message,
           (si.is_tester OR COALESCE(sf.fi, 0)) AS is_tester, sf.rating
    FROM si LEFT JOIN sf ON si.session_id = sf.session_id
    WHERE 1=1${where}
    ORDER BY si.first_message DESC LIMIT ? OFFSET ?
  `).bind(tenantId, tenantId, ...params, pageLimit, pageOffset).all()

  return { results }
}

export type SessionDetailResult =
  | { session_id: string; messages: unknown[]; feedback: unknown[]; photos: unknown[] }
  | { error: string; status: number }

export async function loadSessionDetail(
  env: Env,
  tenantId: string,
  sessionId: string,
): Promise<SessionDetailResult> {
  const { results: messages } = await env.DB.prepare(`
    SELECT message_id, role, content, timestamp, tester_name,
           time_to_first_token, total_time, error_type, message_type, created_at
    FROM messages WHERE session_id = ? AND tenant_id = ? AND message_type = 'chat' ORDER BY timestamp ASC
  `).bind(sessionId, tenantId).all()

  if (!messages.length) return { error: 'Session not found', status: 404 }

  const [{ results: feedbackRows }, { results: photos }] = await Promise.all([
    env.DB.prepare(
      `SELECT message_id, rating, feedback_text, tags, tester_name, is_tester, created_at
       FROM feedback WHERE session_id = ? AND tenant_id = ?`,
    ).bind(sessionId, tenantId).all(),
    // Photos uploaded in this session (image triage v1). Linked to messages
    // via photos.message_id. The admin UI renders them inline in the
    // transcript, plus the per-photo resolve / manual-tag / delete actions.
    env.DB.prepare(
      `SELECT id, message_id, kind, uploaded_at, metadata_status, species_guess,
              urgency_score, distress_tags, condition_tag, trajectory_state,
              responded_at
       FROM photos
       WHERE session_id = ? AND tenant_id = ? AND deleted_at IS NULL
       ORDER BY uploaded_at ASC`,
    ).bind(sessionId, tenantId).all(),
  ])

  const photosShaped = photos.map((p) => ({
    photo_id: (p as { id: string }).id,
    message_id: (p as { message_id: string | null }).message_id,
    kind: (p as { kind: string }).kind,
    uploaded_at: (p as { uploaded_at: number }).uploaded_at,
    metadata_status: (p as { metadata_status: string }).metadata_status,
    species_guess: (p as { species_guess: string | null }).species_guess,
    urgency_score: (p as { urgency_score: string | null }).urgency_score,
    distress_tags: (p as { distress_tags: string | null }).distress_tags
      ? safeJsonParse((p as { distress_tags: string }).distress_tags)
      : [],
    condition_tag: (p as { condition_tag: string | null }).condition_tag,
    trajectory_state: (p as { trajectory_state: string | null }).trajectory_state,
    responded: (p as { responded_at: number | null }).responded_at !== null,
    photo_url: `/admin/photos/${(p as { id: string }).id}/raw`,
  }))

  return {
    session_id: sessionId,
    messages,
    feedback: feedbackRows,
    photos: photosShaped,
  }
}
