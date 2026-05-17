/**
 * Stats data assembly. Three callers in admin.ts: /admin/stats (aggregate
 * tiles for the home page), /admin/stats/timeseries (sessions/feedback by
 * day for charts), /admin/stats/overview (the reports-tab bundle).
 *
 * SQL is verbatim from the original route handlers — splitting it out so
 * the route file is router-only and the queries are inspectable in one
 * place.
 */
import type { Env } from './types'

export async function loadAggregateStats(env: Env, tenantId: string): Promise<Record<string, unknown>> {
  const now = Date.now()
  const ts7d = now - 7 * 24 * 60 * 60 * 1000
  const ts30d = now - 30 * 24 * 60 * 60 * 1000

  const [sessions, fb, msgs, sessions7d, sessions30d, msgs7d, msgs30d, fbSessions] = await Promise.all([
    env.DB.prepare(`
      WITH si AS (
        SELECT session_id,
               MAX(CASE WHEN tester_name IS NOT NULL AND tester_name != '' THEN 1 ELSE 0 END) AS is_tester
        FROM messages WHERE message_type = 'chat' AND tenant_id = ? GROUP BY session_id
      ),
      sf AS (SELECT session_id, MAX(is_tester) AS fi FROM feedback WHERE tenant_id = ? GROUP BY session_id)
      SELECT COUNT(*) AS total_sessions,
             SUM(CASE WHEN (si.is_tester OR COALESCE(sf.fi,0)) = 0 THEN 1 ELSE 0 END) AS public_sessions,
             SUM(CASE WHEN (si.is_tester OR COALESCE(sf.fi,0)) = 1 THEN 1 ELSE 0 END) AS tester_sessions
      FROM si LEFT JOIN sf ON si.session_id = sf.session_id
    `).bind(tenantId, tenantId).first(),
    env.DB.prepare(`
      SELECT COUNT(*) AS total_feedback,
             SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS thumbs_up,
             SUM(CASE WHEN rating = 0 THEN 1 ELSE 0 END) AS thumbs_down,
             SUM(CASE WHEN is_tester = 0 THEN 1 ELSE 0 END) AS public_feedback,
             SUM(CASE WHEN is_tester = 1 THEN 1 ELSE 0 END) AS tester_feedback
      FROM feedback WHERE tenant_id = ?
    `).bind(tenantId).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total_messages FROM messages WHERE message_type = 'chat' AND tenant_id = ?`,
    ).bind(tenantId).first(),
    // Time-windowed session counts
    env.DB.prepare(
      `SELECT COUNT(DISTINCT session_id) AS sessions_7d FROM messages WHERE message_type = 'chat' AND tenant_id = ? AND timestamp >= ?`,
    ).bind(tenantId, ts7d).first(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT session_id) AS sessions_30d FROM messages WHERE message_type = 'chat' AND tenant_id = ? AND timestamp >= ?`,
    ).bind(tenantId, ts30d).first(),
    // Time-windowed message counts
    env.DB.prepare(
      `SELECT COUNT(*) AS messages_7d FROM messages WHERE message_type = 'chat' AND tenant_id = ? AND timestamp >= ?`,
    ).bind(tenantId, ts7d).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS messages_30d FROM messages WHERE message_type = 'chat' AND tenant_id = ? AND timestamp >= ?`,
    ).bind(tenantId, ts30d).first(),
    // Feedback rate: sessions with feedback / total sessions
    env.DB.prepare(
      `SELECT COUNT(DISTINCT session_id) AS sessions_with_feedback FROM feedback WHERE tenant_id = ?`,
    ).bind(tenantId).first(),
  ])

  const totalSessions = (sessions as Record<string, number>)?.total_sessions ?? 0
  const sessionsWithFb = (fbSessions as Record<string, number>)?.sessions_with_feedback ?? 0
  const feedbackRate = totalSessions > 0 ? Math.round((sessionsWithFb / totalSessions) * 100) / 100 : 0

  return {
    ...sessions, ...fb, ...msgs,
    sessions_7d: (sessions7d as Record<string, number>)?.sessions_7d ?? 0,
    sessions_30d: (sessions30d as Record<string, number>)?.sessions_30d ?? 0,
    messages_7d: (msgs7d as Record<string, number>)?.messages_7d ?? 0,
    messages_30d: (msgs30d as Record<string, number>)?.messages_30d ?? 0,
    feedback_rate: feedbackRate,
  }
}

export async function loadTimeseries(
  env: Env,
  tenantId: string,
  period: string,
): Promise<{ daily: unknown[]; hourly: unknown[]; feedback: unknown[]; period: number }> {
  const days = period === '7d' ? 7 : period === '90d' ? 90 : 30
  const since = Date.now() - days * 24 * 60 * 60 * 1000

  // Sessions per day
  const { results: daily } = await env.DB.prepare(`
    SELECT date(timestamp/1000, 'unixepoch') as day, COUNT(DISTINCT session_id) as sessions, COUNT(*) as messages
    FROM messages WHERE tenant_id = ? AND message_type = 'chat' AND timestamp >= ?
    GROUP BY day ORDER BY day
  `).bind(tenantId, since).all()

  // Hour of day distribution
  const { results: hourly } = await env.DB.prepare(`
    SELECT cast(strftime('%H', timestamp/1000, 'unixepoch') as integer) as hour, COUNT(DISTINCT session_id) as sessions
    FROM messages WHERE tenant_id = ? AND message_type = 'chat' AND timestamp >= ?
    GROUP BY hour ORDER BY hour
  `).bind(tenantId, since).all()

  // Feedback breakdown
  const { results: feedback } = await env.DB.prepare(`
    SELECT rating, COUNT(*) as count FROM feedback WHERE tenant_id = ? AND timestamp >= ?
    GROUP BY rating
  `).bind(tenantId, since).all()

  return { daily, hourly, feedback, period: days }
}

export async function loadOverviewStats(
  env: Env,
  tenantId: string,
  period: string,
): Promise<Record<string, unknown>> {
  const days = period === '7d' ? 7 : period === '90d' ? 90 : 30
  const since = Date.now() - days * 24 * 60 * 60 * 1000

  const [
    convStats,
    feedbackBreakdown,
    speciesBreakdown,
    urgencyBreakdown,
    outcomeBreakdown,
    contactRequests,
    responseTime,
    feedbackTrend,
    dailySessions,
    deviceBreakdown,
  ] = await Promise.all([
    // 1. Conversation stats
    env.DB.prepare(`
      SELECT
        COUNT(DISTINCT session_id) as total_conversations,
        CAST(ROUND(AVG(msg_count)) AS INTEGER) as avg_messages_per_conversation,
        COUNT(DISTINCT CASE WHEN has_feedback = 1 THEN session_id END) as conversations_with_feedback
      FROM (
        SELECT m.session_id, COUNT(*) as msg_count,
          CASE WHEN f.session_id IS NOT NULL THEN 1 ELSE 0 END as has_feedback
        FROM messages m
        LEFT JOIN (SELECT DISTINCT session_id FROM feedback WHERE tenant_id = ?) f ON f.session_id = m.session_id
        WHERE m.tenant_id = ? AND m.message_type = 'chat' AND m.timestamp >= ?
        GROUP BY m.session_id
      )
    `).bind(tenantId, tenantId, since).first(),

    // 2. Feedback breakdown (thumbs up / down)
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as thumbs_up,
        SUM(CASE WHEN rating = 0 THEN 1 ELSE 0 END) as thumbs_down,
        COUNT(*) as total_feedback
      FROM feedback WHERE tenant_id = ? AND timestamp >= ?
    `).bind(tenantId, since).first(),

    // 3. Species breakdown — top animals
    env.DB.prepare(`
      SELECT animal, COUNT(*) as count
      FROM session_analysis
      WHERE tenant_id = ? AND animal IS NOT NULL AND animal != ''
        AND analyzed_at >= datetime('now', '-' || ? || ' days')
      GROUP BY LOWER(animal) ORDER BY count DESC LIMIT 10
    `).bind(tenantId, days).all(),

    // 4. Urgency distribution
    env.DB.prepare(`
      SELECT urgency, COUNT(*) as count
      FROM session_analysis
      WHERE tenant_id = ? AND analyzed_at >= datetime('now', '-' || ? || ' days')
      GROUP BY urgency ORDER BY
        CASE urgency WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END
    `).bind(tenantId, days).all(),

    // 5. Outcome distribution
    env.DB.prepare(`
      SELECT outcome, COUNT(*) as count
      FROM session_analysis
      WHERE tenant_id = ? AND analyzed_at >= datetime('now', '-' || ? || ' days')
      GROUP BY outcome ORDER BY count DESC
    `).bind(tenantId, days).all(),

    // 6. Contact requests
    env.DB.prepare(`
      SELECT COUNT(*) as count
      FROM session_analysis
      WHERE tenant_id = ? AND contact_info IS NOT NULL AND contact_info != ''
        AND analyzed_at >= datetime('now', '-' || ? || ' days')
    `).bind(tenantId, days).first(),

    // 7. Response time — avg time between first user msg and first assistant msg per session
    env.DB.prepare(`
      SELECT CAST(ROUND(AVG(response_ms)) AS INTEGER) as avg_response_ms
      FROM (
        SELECT
          MIN(CASE WHEN role = 'assistant' THEN timestamp END) -
          MIN(CASE WHEN role = 'user' THEN timestamp END) as response_ms
        FROM messages
        WHERE tenant_id = ? AND message_type = 'chat' AND timestamp >= ?
        GROUP BY session_id
        HAVING MIN(CASE WHEN role = 'user' THEN timestamp END) IS NOT NULL
           AND MIN(CASE WHEN role = 'assistant' THEN timestamp END) IS NOT NULL
      ) WHERE response_ms > 0 AND response_ms < 300000
    `).bind(tenantId, since).first(),

    // 8. Feedback trend (by day)
    env.DB.prepare(`
      SELECT date(timestamp/1000, 'unixepoch') as day,
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as thumbs_up,
        SUM(CASE WHEN rating = 0 THEN 1 ELSE 0 END) as thumbs_down
      FROM feedback WHERE tenant_id = ? AND timestamp >= ?
      GROUP BY day ORDER BY day
    `).bind(tenantId, since).all(),

    // 9. Daily sessions (for sparkline/chart)
    env.DB.prepare(`
      SELECT date(timestamp/1000, 'unixepoch') as day,
        COUNT(DISTINCT session_id) as sessions,
        COUNT(*) as messages
      FROM messages WHERE tenant_id = ? AND message_type = 'chat' AND timestamp >= ?
      GROUP BY day ORDER BY day
    `).bind(tenantId, since).all(),
    // 10. Device breakdown
    env.DB.prepare(`
      SELECT COALESCE(device_type, 'unknown') as device, COUNT(*) as count
      FROM session_analysis WHERE tenant_id = ? AND analyzed_at >= datetime('now', '-' || ? || ' days')
      GROUP BY device ORDER BY count DESC
    `).bind(tenantId, days).all(),
  ])

  return {
    period: days,
    conversations: convStats,
    feedback: feedbackBreakdown,
    species: speciesBreakdown.results,
    urgency: urgencyBreakdown.results,
    outcomes: outcomeBreakdown.results,
    contact_requests: (contactRequests as Record<string, number>)?.count || 0,
    avg_response_ms: (responseTime as Record<string, number>)?.avg_response_ms || null,
    feedback_trend: feedbackTrend.results,
    daily_sessions: dailySessions.results,
    devices: deviceBreakdown.results,
  }
}
