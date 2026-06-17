/**
 * Dashboard data assembly — composes the action items, recent sessions,
 * and week rollup tiles that the /admin/dashboard route returns. Split
 * out of admin.ts so the LEFT JOIN-heavy queries are testable on their
 * own and the route handler just orchestrates the response shape.
 */
import type { Env } from './types'

export async function loadDashboardActionItems(env: Env, tenantId: string): Promise<unknown[]> {
  // Action items = recent, unresolved sessions an operator should follow up on:
  //   - needs_action=1 (the caller left contact info, or rated negatively), OR
  //   - urgency critical/urgent — a serious case surfaces even if the caller
  //     left no contact info.
  //   - AND the conversation happened in the trailing window (below).
  //
  // The urgency clause closes a real gap: action items used to gate on
  // needs_action=1 ALONE, so an urgent session with needs_action=0 (an injured
  // animal where the citizen never left a phone number) matched neither this
  // list nor the recent list, and vanished from the dashboard while still
  // showing in the daily report.
  //
  // The trailing-window clause is just as load-bearing in the other direction.
  // Lots of urgent/needs_action sessions are never *formally* resolved — the
  // operator handles them and moves on without clicking "resolve". Without a
  // window, resolved_at IS NULL kept months of those at the top of the
  // dashboard (some from May), turning a triage list into an ever-growing
  // backlog. Bounding to ACTION_ITEM_WINDOW_DAYS keeps the top section to
  // "what needs attention now"; older unresolved sessions fall back into the
  // Recent conversations list (which is the catch-all for the window) and then
  // age off the dashboard entirely (still findable under All Sessions).
  const { results } = await env.DB.prepare(`
    SELECT sa.*,
      COALESCE(m.message_count, 0) as message_count,
      m.first_message,
      m.last_message,
      f.rating
    FROM session_analysis sa
    LEFT JOIN (
      SELECT session_id, COUNT(*) as message_count, MIN(timestamp) as first_message, MAX(timestamp) as last_message
      FROM messages WHERE tenant_id = ? AND message_type = 'chat'
      GROUP BY session_id
    ) m ON m.session_id = sa.session_id
    LEFT JOIN (
      SELECT session_id, rating FROM feedback WHERE tenant_id = ?
      GROUP BY session_id
    ) f ON f.session_id = sa.session_id
    WHERE sa.tenant_id = ? AND sa.resolved_at IS NULL
      AND (sa.needs_action = 1 OR sa.urgency IN ('critical', 'urgent'))
      AND m.last_message >= (strftime('%s', 'now', '-3 days') * 1000)
    -- Sort by when the CONVERSATION happened, not when the analyzer ran.
    -- analyzed_at is wall-clock time of the regex pass; for sessions
    -- backfilled in batch (the /admin/analyze-backfill endpoint or a
    -- post-Render-sync run), every session's analyzed_at lands within
    -- seconds of every other, so the operator-visible order ended up
    -- driven by analyzer iteration order — putting 5/14 above 5/15.
    -- last_message reflects what the citizen actually saw.
    ORDER BY m.last_message DESC
    LIMIT 20
  `).bind(tenantId, tenantId, tenantId).all()
  return results
}

export async function loadDashboardRecentSessions(env: Env, tenantId: string): Promise<unknown[]> {
  // Recent conversations = the catch-all log for the trailing window: every
  // analyzed session in the last 3 days that ISN'T a current action item
  // (loadDashboard dedups the action-item session_ids out of this list). It
  // deliberately does NOT re-filter on needs_action/urgency — an urgent
  // session that aged out of action items (handled but never formally
  // resolved) belongs here as a record, not nowhere. That "otherwise it lands
  // in Recent" behavior is the whole point of bounding action items above.
  const { results } = await env.DB.prepare(`
    SELECT sa.*,
      COALESCE(m.message_count, 0) as message_count,
      m.first_message,
      m.last_message,
      f.rating
    FROM session_analysis sa
    LEFT JOIN (
      SELECT session_id, COUNT(*) as message_count,
             MIN(timestamp) as first_message,
             MAX(timestamp) as last_message
      FROM messages WHERE tenant_id = ? AND message_type = 'chat'
      GROUP BY session_id
    ) m ON m.session_id = sa.session_id
    LEFT JOIN (
      SELECT session_id, rating FROM feedback WHERE tenant_id = ?
      GROUP BY session_id
    ) f ON f.session_id = sa.session_id
    WHERE sa.tenant_id = ?
    -- Window by when the CONVERSATION happened, not when we analyzed it.
    -- For backfilled history a batch run sets every analyzed_at to the
    -- same minute, which both inflates the "last 3 days" filter and
    -- destroys the per-session sort. See action-items query above.
    AND m.last_message >= (strftime('%s', 'now', '-3 days') * 1000)
    ORDER BY m.last_message DESC LIMIT 30
  `).bind(tenantId, tenantId, tenantId).all()
  return results
}

export interface DashboardWeekStats {
  sessions_week: number
  thumbs_up_week: number
  thumbs_down_week: number
  people_helped: number
  top_animals: unknown[]
  in_area: number
  out_of_area: number
}

export interface DashboardResponse {
  action_items: unknown[]
  recent: unknown[]
  week: DashboardWeekStats
}

/** Compose the full /admin/dashboard response shape: action items +
 * recent (deduped against action items) + week rollup. */
export async function loadDashboard(env: Env, tenantId: string): Promise<DashboardResponse> {
  const actionItems = await loadDashboardActionItems(env, tenantId)
  const recentSessions = await loadDashboardRecentSessions(env, tenantId)

  // Filter out any recent rows that are already in action items so we
  // don't show the same session twice.
  const actionSet = new Set(actionItems.map(a => (a as { session_id: string }).session_id))
  const filteredRecent = recentSessions.filter(
    r => !actionSet.has((r as { session_id: string }).session_id),
  )

  const week = await loadDashboardWeekStats(env, tenantId)

  return {
    action_items: actionItems,
    recent: filteredRecent,
    week,
  }
}

/** Mark a session analysis as resolved with optional operator notes. Returns
 * the count of rows touched so the route can 404 when nothing matched. */
export async function resolveActionItem(
  env: Env,
  tenantId: string,
  sessionId: string,
  notes: string | null,
): Promise<{ ok: true } | { error: string; status: number }> {
  try {
    const result = await env.DB.prepare(`
      UPDATE session_analysis
      SET needs_action = 0, resolved_at = datetime('now'), resolution_notes = ?
      WHERE session_id = ? AND tenant_id = ?
    `).bind(notes, sessionId, tenantId).run()

    if (result.meta.changes === 0) {
      return { error: 'Session analysis not found', status: 404 }
    }
    return { ok: true }
  } catch (e) {
    console.error('[admin/resolve] DB error:', e)
    return { error: 'Database error', status: 500 }
  }
}

export async function loadDashboardWeekStats(env: Env, tenantId: string): Promise<DashboardWeekStats> {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const weekStats = await env.DB.prepare(`
    SELECT
      COUNT(DISTINCT session_id) as sessions_week,
      (SELECT COUNT(*) FROM feedback WHERE tenant_id = ? AND rating = 1 AND timestamp >= ?) as thumbs_up_week,
      (SELECT COUNT(*) FROM feedback WHERE tenant_id = ? AND rating = 0 AND timestamp >= ?) as thumbs_down_week
    FROM messages WHERE tenant_id = ? AND message_type = 'chat' AND timestamp >= ?
  `).bind(tenantId, sevenDaysAgo, tenantId, sevenDaysAgo, tenantId, sevenDaysAgo).first()

  // Top animals this week
  const { results: topAnimals } = await env.DB.prepare(`
    SELECT animal, COUNT(*) as count FROM session_analysis
    WHERE tenant_id = ? AND animal IS NOT NULL AND analyzed_at >= datetime('now', '-7 days')
    GROUP BY animal ORDER BY count DESC LIMIT 5
  `).bind(tenantId).all()

  // Service area split this week — return both in-area and out-of-area so
  // the dashboard can show "in / out" rather than a bare out-of-area count.
  const serviceArea = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN outcome = 'redirected' THEN 1 ELSE 0 END) as out_of_area,
      SUM(CASE WHEN outcome != 'redirected' AND outcome != 'unknown' THEN 1 ELSE 0 END) as in_area
    FROM session_analysis
    WHERE tenant_id = ? AND analyzed_at >= datetime('now', '-7 days')
  `).bind(tenantId).first<{ out_of_area: number; in_area: number }>()

  // Resolved + bringing_in count for "people helped"
  const helped = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM session_analysis
    WHERE tenant_id = ? AND outcome IN ('resolved', 'bringing_in') AND analyzed_at >= datetime('now', '-7 days')
  `).bind(tenantId).first()

  return {
    ...(weekStats as Record<string, number>),
    people_helped: (helped as Record<string, number>)?.count || 0,
    top_animals: topAnimals,
    in_area: serviceArea?.in_area ?? 0,
    out_of_area: serviceArea?.out_of_area ?? 0,
  } as DashboardWeekStats
}
