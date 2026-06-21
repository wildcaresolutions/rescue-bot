/**
 * Unit tests for workers/src/lib/stats.ts
 *
 * Uses a lightweight FakeD1 that dispatches on SQL substring so we can
 * assert return-value shape, zero-data defaults, and error propagation
 * without a real database.
 */
import { describe, it, expect } from 'vitest'
import {
  loadAggregateStats,
  loadTimeseries,
  loadOverviewStats,
} from '../src/lib/stats'
import type { Env } from '../src/lib/types'

// ── FakeD1 ────────────────────────────────────────────────────────────────────

type FirstFn = (binds: unknown[]) => unknown
type AllFn   = (binds: unknown[]) => unknown[]
type RunFn   = (binds: unknown[]) => { success: boolean; meta: Record<string, unknown> }

interface Route {
  match: (sql: string) => boolean
  first?: FirstFn
  all?: AllFn
  run?: RunFn
}

class FakeStmt {
  binds: unknown[] = []
  constructor(
    private sql: string,
    private route: Route | undefined,
    private db: FakeD1,
  ) {}
  bind(...args: unknown[]): this { this.binds = args; return this }
  async first<T = unknown>(): Promise<T | null> {
    this.db.calls.push({ sql: this.sql, binds: this.binds, method: 'first' })
    return (this.route?.first ? this.route.first(this.binds) : null) as T | null
  }
  async all<T = unknown>(): Promise<{ results: T[] }> {
    this.db.calls.push({ sql: this.sql, binds: this.binds, method: 'all' })
    return { results: (this.route?.all ? this.route.all(this.binds) : []) as T[] }
  }
  async run() {
    this.db.calls.push({ sql: this.sql, binds: this.binds, method: 'run' })
    if (this.route?.run) return this.route.run(this.binds)
    return { success: true, meta: { changes: 1, last_row_id: 0 } }
  }
}

class FakeD1 {
  routes: Route[] = []
  calls: { sql: string; binds: unknown[]; method: string }[] = []

  /** Register a route. Pattern is a substring of the normalised SQL. */
  on(pattern: string | ((sql: string) => boolean), handlers: Omit<Route, 'match'>): this {
    const match =
      typeof pattern === 'string' ? (s: string) => s.includes(pattern) : pattern
    this.routes.push({ match, ...handlers })
    return this
  }

  prepare(sql: string): FakeStmt {
    const norm = sql.replace(/\s+/g, ' ').trim()
    const route = this.routes.find(r => r.match(norm))
    return new FakeStmt(norm, route, this)
  }

  async batch(stmts: FakeStmt[]) {
    return Promise.all(stmts.map(s => s.run()))
  }
}

function makeEnv(db: FakeD1): Env {
  return { DB: db as unknown as D1Database } as unknown as Env
}

// ── loadAggregateStats ────────────────────────────────────────────────────────

describe('loadAggregateStats', () => {
  /** Build a FakeD1 with canned data for all 8 parallel queries. */
  function makeStatsDb(): FakeD1 {
    return new FakeD1()
      .on('public_sessions', {
        first: () => ({ total_sessions: 100, public_sessions: 80, tester_sessions: 20 }),
      })
      .on('total_feedback', {
        first: () => ({ total_feedback: 50, thumbs_up: 40, thumbs_down: 10, public_feedback: 45, tester_feedback: 5 }),
      })
      .on('total_messages', {
        first: () => ({ total_messages: 500 }),
      })
      .on('sessions_7d', {
        first: () => ({ sessions_7d: 10 }),
      })
      .on('sessions_30d', {
        first: () => ({ sessions_30d: 40 }),
      })
      .on('messages_7d', {
        first: () => ({ messages_7d: 80 }),
      })
      .on('messages_30d', {
        first: () => ({ messages_30d: 250 }),
      })
      .on('sessions_with_feedback', {
        first: () => ({ sessions_with_feedback: 30 }),
      })
  }

  it('returns expected numeric fields from DB rows', async () => {
    const result = await loadAggregateStats(makeEnv(makeStatsDb()), 'tenant-1') as Record<string, unknown>
    expect(result.total_sessions).toBe(100)
    expect(result.public_sessions).toBe(80)
    expect(result.tester_sessions).toBe(20)
    expect(result.total_feedback).toBe(50)
    expect(result.thumbs_up).toBe(40)
    expect(result.thumbs_down).toBe(10)
    expect(result.total_messages).toBe(500)
    expect(result.sessions_7d).toBe(10)
    expect(result.sessions_30d).toBe(40)
    expect(result.messages_7d).toBe(80)
    expect(result.messages_30d).toBe(250)
  })

  it('computes feedback_rate as sessions_with_feedback / total_sessions', async () => {
    const result = await loadAggregateStats(makeEnv(makeStatsDb()), 'tenant-1') as Record<string, unknown>
    // 30 / 100 = 0.3
    expect(result.feedback_rate).toBe(0.3)
  })

  it('returns zeroes for all windowed fields when DB returns null rows', async () => {
    // Default FakeD1 returns null for first() — exercising the ?? 0 fallbacks.
    const db = new FakeD1()
    const result = await loadAggregateStats(makeEnv(db), 'tenant-1') as Record<string, unknown>
    expect(result.sessions_7d).toBe(0)
    expect(result.sessions_30d).toBe(0)
    expect(result.messages_7d).toBe(0)
    expect(result.messages_30d).toBe(0)
    expect(result.feedback_rate).toBe(0)
  })

  it('feedback_rate is 0 when total_sessions is 0', async () => {
    const db = new FakeD1()
      .on('public_sessions', { first: () => ({ total_sessions: 0, public_sessions: 0, tester_sessions: 0 }) })
      .on('sessions_with_feedback', { first: () => ({ sessions_with_feedback: 5 }) })
    const result = await loadAggregateStats(makeEnv(db), 'tenant-1') as Record<string, unknown>
    expect(result.feedback_rate).toBe(0)
  })

  it('propagates D1 errors', async () => {
    const db = new FakeD1()
      .on('public_sessions', { first: () => { throw new Error('D1 connection failure') } })
    await expect(loadAggregateStats(makeEnv(db), 'tenant-1')).rejects.toThrow('D1 connection failure')
  })
})

// ── loadTimeseries ────────────────────────────────────────────────────────────

describe('loadTimeseries', () => {
  function makeTimeseriesDb(): FakeD1 {
    return new FakeD1()
      .on('as sessions, COUNT(*) as messages FROM messages', {
        all: () => [
          { day: '2026-06-01', sessions: 5, messages: 20 },
          { day: '2026-06-02', sessions: 3, messages: 12 },
        ],
      })
      .on('as hour', {
        all: () => [
          { hour: 9, sessions: 8 },
          { hour: 14, sessions: 12 },
        ],
      })
      .on('rating, COUNT(*) as count FROM feedback', {
        all: () => [
          { rating: 1, count: 40 },
          { rating: 0, count: 10 },
        ],
      })
  }

  it('returns daily / hourly / feedback arrays', async () => {
    const result = await loadTimeseries(makeEnv(makeTimeseriesDb()), 'tenant-1', '30d')
    expect(result.daily).toHaveLength(2)
    expect(result.hourly).toHaveLength(2)
    expect(result.feedback).toHaveLength(2)
  })

  it('returns period=7 for "7d", period=30 for "30d", period=90 for "90d"', async () => {
    const db = makeTimeseriesDb()
    expect((await loadTimeseries(makeEnv(db), 'tenant-1', '7d')).period).toBe(7)
    expect((await loadTimeseries(makeEnv(db), 'tenant-1', '30d')).period).toBe(30)
    expect((await loadTimeseries(makeEnv(db), 'tenant-1', '90d')).period).toBe(90)
  })

  it('daily entries carry day, sessions, messages fields', async () => {
    const result = await loadTimeseries(makeEnv(makeTimeseriesDb()), 'tenant-1', '7d')
    const row = result.daily[0] as { day: string; sessions: number; messages: number }
    expect(row.day).toBe('2026-06-01')
    expect(row.sessions).toBe(5)
    expect(row.messages).toBe(20)
  })

  it('returns empty arrays for tenant with no data', async () => {
    const db = new FakeD1()
    const result = await loadTimeseries(makeEnv(db), 'tenant-1', '30d')
    expect(result.daily).toEqual([])
    expect(result.hourly).toEqual([])
    expect(result.feedback).toEqual([])
  })
})

// ── loadOverviewStats ─────────────────────────────────────────────────────────

describe('loadOverviewStats', () => {
  function makeOverviewDb(): FakeD1 {
    return new FakeD1()
      // 1. convStats (first)
      .on('total_conversations', {
        first: () => ({ total_conversations: 42, avg_messages_per_conversation: 5, conversations_with_feedback: 10 }),
      })
      // 2. feedbackBreakdown (first) — matched before thumbs_up route
      .on('COUNT(*) as total_feedback FROM feedback', {
        first: () => ({ thumbs_up: 30, thumbs_down: 5, total_feedback: 35 }),
      })
      // 3. speciesBreakdown (all)
      .on("AND animal IS NOT NULL AND animal != ''", {
        all: () => [{ animal: 'raccoon', count: 15 }, { animal: 'bird', count: 8 }],
      })
      // 4. urgencyBreakdown (all)
      .on("CASE urgency WHEN 'critical'", {
        all: () => [{ urgency: 'critical', count: 2 }, { urgency: 'moderate', count: 10 }],
      })
      // 5. outcomeBreakdown (all)
      .on('GROUP BY outcome', {
        all: () => [{ outcome: 'bringing_in', count: 12 }, { outcome: 'resolved', count: 8 }],
      })
      // 6. contactRequests (first)
      .on('contact_info IS NOT NULL', {
        first: () => ({ count: 7 }),
      })
      // 7. responseTime (first)
      .on('avg_response_ms', {
        first: () => ({ avg_response_ms: 1200 }),
      })
      // 8. feedbackTrend (all) — "thumbs_down FROM feedback" is unique to trend query
      .on('as thumbs_down FROM feedback', {
        all: () => [
          { day: '2026-06-01', thumbs_up: 5, thumbs_down: 1 },
          { day: '2026-06-02', thumbs_up: 8, thumbs_down: 2 },
        ],
      })
      // 9. dailySessions (all)
      .on('as sessions, COUNT(*) as messages FROM messages', {
        all: () => [
          { day: '2026-06-01', sessions: 10, messages: 50 },
        ],
      })
      // 10. deviceBreakdown (all)
      .on('COALESCE(device_type', {
        all: () => [{ device: 'mobile', count: 25 }, { device: 'desktop', count: 17 }],
      })
  }

  it('returns all expected top-level keys', async () => {
    const result = await loadOverviewStats(makeEnv(makeOverviewDb()), 'tenant-1', '30d') as Record<string, unknown>
    expect(result).toHaveProperty('period')
    expect(result).toHaveProperty('conversations')
    expect(result).toHaveProperty('feedback')
    expect(result).toHaveProperty('species')
    expect(result).toHaveProperty('urgency')
    expect(result).toHaveProperty('outcomes')
    expect(result).toHaveProperty('contact_requests')
    expect(result).toHaveProperty('avg_response_ms')
    expect(result).toHaveProperty('feedback_trend')
    expect(result).toHaveProperty('daily_sessions')
    expect(result).toHaveProperty('devices')
  })

  it('period matches the passed string', async () => {
    const r30 = await loadOverviewStats(makeEnv(makeOverviewDb()), 'tenant-1', '30d') as Record<string, unknown>
    expect(r30.period).toBe(30)
    const r7 = await loadOverviewStats(makeEnv(makeOverviewDb()), 'tenant-1', '7d') as Record<string, unknown>
    expect(r7.period).toBe(7)
  })

  it('species, urgency, outcomes, devices are arrays', async () => {
    const result = await loadOverviewStats(makeEnv(makeOverviewDb()), 'tenant-1', '30d') as Record<string, unknown>
    expect(Array.isArray(result.species)).toBe(true)
    expect(Array.isArray(result.urgency)).toBe(true)
    expect(Array.isArray(result.outcomes)).toBe(true)
    expect(Array.isArray(result.devices)).toBe(true)
    expect((result.species as unknown[]).length).toBe(2)
  })

  it('contact_requests is a number', async () => {
    const result = await loadOverviewStats(makeEnv(makeOverviewDb()), 'tenant-1', '30d') as Record<string, unknown>
    expect(typeof result.contact_requests).toBe('number')
    expect(result.contact_requests).toBe(7)
  })

  it('contact_requests defaults to 0 when DB returns null', async () => {
    const db = new FakeD1()
    const result = await loadOverviewStats(makeEnv(db), 'tenant-1', '30d') as Record<string, unknown>
    expect(result.contact_requests).toBe(0)
  })

  it('avg_response_ms defaults to null when DB returns null', async () => {
    const db = new FakeD1()
    const result = await loadOverviewStats(makeEnv(db), 'tenant-1', '30d') as Record<string, unknown>
    expect(result.avg_response_ms).toBeNull()
  })
})
