import { describe, it, expect } from 'vitest'
import { loadDashboardActionItems, loadDashboardRecentSessions } from '../src/lib/dashboard'
import type { Env } from '../src/lib/types'

// Regression for the 2026-06-17 dashboard triage rework. The dashboard splits
// analyzed sessions into two lists:
//   - action items: UNRESOLVED + (needs_action OR urgent/critical) + recent
//   - recent:       the catch-all log for the trailing window (everything not
//                   already an action item; loadDashboard dedups those out)
//
// Two bugs this guards against:
//   1. The urgency gap — an urgent session with needs_action=0 (caller left no
//      contact info) must still surface in action items; it used to match
//      NEITHER list and vanish from the dashboard while showing in the report.
//   2. The backlog — without a trailing window, resolved_at IS NULL pinned
//      every never-formally-resolved urgent session (some months old) to the
//      top of the dashboard. Action items must be bounded by a recent window;
//      older sessions fall back into the recent log.
//
// We can't run raw SQL against a real D1 here, so we capture the prepared SQL.
class RecordingD1 {
  lastSql = ''
  prepare(sql: string) {
    this.lastSql = sql
    return {
      bind: (..._args: unknown[]) => ({
        all: async () => ({ results: [] as unknown[] }),
        first: async () => null,
        run: async () => ({}),
      }),
    }
  }
}

function envWith(db: RecordingD1): Env {
  return { DB: db } as unknown as Env
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('dashboard action items', () => {
  it('surface unresolved urgent/critical even when needs_action=0', async () => {
    const db = new RecordingD1()
    await loadDashboardActionItems(envWith(db), 'wildcare')
    const sql = norm(db.lastSql)
    expect(sql).toContain('sa.resolved_at IS NULL')
    // the OR clause — without the urgency arm an urgent, no-contact session vanishes
    expect(sql).toMatch(/sa\.needs_action = 1 OR sa\.urgency IN \('critical', 'urgent'\)/)
  })

  it('are bounded to a trailing window so old unresolved sessions stop nagging', async () => {
    const db = new RecordingD1()
    await loadDashboardActionItems(envWith(db), 'wildcare')
    const sql = norm(db.lastSql)
    // the conversation (last_message), not analyzed_at, must fall in the window
    expect(sql).toMatch(/m\.last_message >= \(strftime\('%s', 'now', '-3 days'\) \* 1000\)/)
  })
})

describe('dashboard recent conversations (catch-all log)', () => {
  it('is windowed but does NOT re-filter by urgency/needs_action', async () => {
    const db = new RecordingD1()
    await loadDashboardRecentSessions(envWith(db), 'wildcare')
    const sql = norm(db.lastSql)
    expect(sql).toMatch(/m\.last_message >= \(strftime\('%s', 'now', '-3 days'\) \* 1000\)/)
    // aged-out urgent sessions must be allowed here — no urgency exclusion,
    // no needs_action gate; the action-item dedup in loadDashboard is what
    // keeps the two lists from overlapping.
    expect(sql).not.toContain("NOT IN ('critical', 'urgent')")
    expect(sql).not.toContain('sa.needs_action = 0')
  })
})
