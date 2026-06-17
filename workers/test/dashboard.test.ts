import { describe, it, expect } from 'vitest'
import { loadDashboardActionItems, loadDashboardRecentSessions } from '../src/lib/dashboard'
import type { Env } from '../src/lib/types'

// Regression for the 2026-06-17 "report shows sessions the dashboard doesn't"
// bug. The dashboard splits analyzed sessions into two complementary lists:
//   - action items: unresolved + (needs_action OR urgent/critical)
//   - recent:       calm (needs_action=0 AND NOT urgent/critical)
// An urgent session with needs_action=0 (caller left no contact info) used to
// match NEITHER — action items gated on needs_action=1 alone, recent excludes
// urgent — so it silently disappeared from the dashboard while still appearing
// in the daily report. We can't run the raw SQL against a real D1 in this
// harness, so we capture the prepared SQL and assert the two lists stay
// complementary: whatever recent EXCLUDES by urgency, action items must
// INCLUDE.
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

describe('dashboard action-items / recent are complementary (no urgency gap)', () => {
  it('action items surface unresolved urgent/critical even when needs_action=0', async () => {
    const db = new RecordingD1()
    await loadDashboardActionItems(envWith(db), 'wildcare')
    const sql = norm(db.lastSql)
    // unresolved only
    expect(sql).toContain('sa.resolved_at IS NULL')
    // the load-bearing OR: needs_action OR a serious urgency — without the
    // second clause the bloody-skunk (urgent, needs_action=0) vanishes.
    expect(sql).toMatch(/sa\.needs_action = 1 OR sa\.urgency IN \('critical', 'urgent'\)/)
  })

  it('recent list still excludes urgent/critical (they belong to action items)', async () => {
    const db = new RecordingD1()
    await loadDashboardRecentSessions(envWith(db), 'wildcare')
    const sql = norm(db.lastSql)
    expect(sql).toContain("sa.urgency NOT IN ('critical', 'urgent')")
    expect(sql).toContain('sa.needs_action = 0')
  })
})
