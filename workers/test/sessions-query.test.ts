/**
 * Unit tests for workers/src/lib/sessions-query.ts (and safeJsonParse from
 * photo-feed.ts, which sessions-query re-exports indirectly).
 *
 * loadSessionsList has four distinct query paths:
 *   1. needs_review=true  — sessions in last 48h with no feedback & 3+ msgs
 *   2. default (no tester/rating filter, no date range)
 *   3. date-range  (from/to params)
 *   4. tester / rating filter
 *
 * loadSessionDetail fans out messages + feedback + photos; returns 404
 * sentinel for an unknown session.
 */
import { describe, it, expect } from 'vitest'
import { loadSessionsList, loadSessionDetail } from '../src/lib/sessions-query'
import { safeJsonParse } from '../src/lib/photo-feed'
import type { Env } from '../src/lib/types'

// ── FakeD1 (shared with stats.test.ts pattern) ────────────────────────────────

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
    public normSql: string,
    private route: Route | undefined,
    private db: FakeD1,
  ) {}
  bind(...args: unknown[]): this { this.binds = args; return this }
  async first<T = unknown>(): Promise<T | null> {
    this.db.calls.push({ sql: this.normSql, binds: this.binds, method: 'first' })
    return (this.route?.first ? this.route.first(this.binds) : null) as T | null
  }
  async all<T = unknown>(): Promise<{ results: T[] }> {
    this.db.calls.push({ sql: this.normSql, binds: this.binds, method: 'all' })
    return { results: (this.route?.all ? this.route.all(this.binds) : []) as T[] }
  }
  async run() {
    this.db.calls.push({ sql: this.normSql, binds: this.binds, method: 'run' })
    if (this.route?.run) return this.route.run(this.binds)
    return { success: true, meta: { changes: 1, last_row_id: 0 } }
  }
}

class FakeD1 {
  routes: Route[] = []
  calls: { sql: string; binds: unknown[]; method: string }[] = []

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

// ── safeJsonParse ─────────────────────────────────────────────────────────────

describe('safeJsonParse', () => {
  it('parses a valid JSON array', () => {
    expect(safeJsonParse('["bleeding","lethargy"]')).toEqual(['bleeding', 'lethargy'])
  })

  it('returns [] for malformed JSON', () => {
    expect(safeJsonParse('not-valid-json')).toEqual([])
  })

  it('returns [] for empty string', () => {
    expect(safeJsonParse('')).toEqual([])
  })
})

// ── loadSessionsList ──────────────────────────────────────────────────────────

const SESSION_ROWS = [
  { session_id: 'sess-1', message_count: 5, first_message: 1700000000000, last_message: 1700001000000 },
  { session_id: 'sess-2', message_count: 3, first_message: 1700002000000, last_message: 1700003000000 },
]

describe('loadSessionsList — default mode', () => {
  it('returns array of session rows', async () => {
    const db = new FakeD1().on('ORDER BY first_message DESC', { all: () => SESSION_ROWS })
    const result = await loadSessionsList(makeEnv(db), 'tenant-1', {})
    expect('results' in result).toBe(true)
    if ('results' in result) {
      expect(result.results).toHaveLength(2)
      expect((result.results[0] as { session_id: string }).session_id).toBe('sess-1')
    }
  })

  it('applies limit and offset as bind args', async () => {
    const db = new FakeD1().on('ORDER BY first_message DESC', { all: () => [] })
    await loadSessionsList(makeEnv(db), 'tenant-1', { limit: '20', offset: '40' })
    const call = db.calls.find(c => c.method === 'all')!
    const binds = call.binds as unknown[]
    // last two binds are limit and offset
    expect(binds[binds.length - 2]).toBe(20)
    expect(binds[binds.length - 1]).toBe(40)
  })

  it('caps limit at 200', async () => {
    const db = new FakeD1().on('ORDER BY first_message DESC', { all: () => [] })
    await loadSessionsList(makeEnv(db), 'tenant-1', { limit: '999' })
    const call = db.calls.find(c => c.method === 'all')!
    const binds = call.binds as unknown[]
    expect(binds[binds.length - 2]).toBe(200)
  })
})

describe('loadSessionsList — needs_review mode', () => {
  it('returns sessions with 3+ messages and no feedback', async () => {
    const reviewRows = [
      { session_id: 'sess-nr', message_count: 4, first_message: 1700000000000, last_message: 1700001000000 },
    ]
    const db = new FakeD1().on('HAVING COUNT(*) >= 3', { all: () => reviewRows })
    const result = await loadSessionsList(makeEnv(db), 'tenant-1', { needs_review: 'true' })
    expect('results' in result && result.results).toHaveLength(1)
  })
})

describe('loadSessionsList — date-range mode', () => {
  it('returns sessions filtered by from/to and includes session_analysis fields', async () => {
    const rangeRows = [
      {
        session_id: 'sess-range',
        message_count: 6,
        first_message: 1700000000000,
        last_message: 1700001000000,
        urgency: 'urgent',
        animal: 'raccoon',
        outcome: 'bringing_in',
        situation: null,
        needs_action: 0,
        contact_info: null,
        triage_hint: null,
        rating: 1,
      },
    ]
    const db = new FakeD1().on('LEFT JOIN session_analysis', { all: () => rangeRows })
    const result = await loadSessionsList(makeEnv(db), 'tenant-1', { from: '2026-06-01', to: '2026-06-30' })
    expect('results' in result && result.results).toHaveLength(1)
    const row = ('results' in result ? result.results[0] : null) as Record<string, unknown> | null
    expect(row?.urgency).toBe('urgent')
    expect(row?.animal).toBe('raccoon')
  })
})

describe('loadSessionsList — tester/rating filter mode', () => {
  it('returns results filtered by tester flag', async () => {
    const testerRows = [
      { session_id: 'tester-1', message_count: 3, first_message: 1700000000000, last_message: 1700001000000, is_tester: 1, rating: null },
    ]
    const db = new FakeD1().on('WITH si AS', { all: () => testerRows })
    const result = await loadSessionsList(makeEnv(db), 'tenant-1', { tester: 'true' })
    expect('results' in result && result.results).toHaveLength(1)
  })

  it('returns 400 error for invalid rating value', async () => {
    const db = new FakeD1()
    const result = await loadSessionsList(makeEnv(db), 'tenant-1', { rating: '5' })
    expect('error' in result && result.status).toBe(400)
  })

  it('accepts rating=0 (thumbs down) without error', async () => {
    const db = new FakeD1().on('WITH si AS', { all: () => [] })
    const result = await loadSessionsList(makeEnv(db), 'tenant-1', { rating: '0' })
    expect('results' in result).toBe(true)
  })
})

// ── loadSessionDetail ─────────────────────────────────────────────────────────

const MESSAGES = [
  { message_id: 'msg-1', role: 'user', content: 'Help!', timestamp: 1700000000000,
    tester_name: null, time_to_first_token: null, total_time: null, error_type: null,
    message_type: 'chat', created_at: '2026-06-01T00:00:00Z' },
  { message_id: 'msg-2', role: 'assistant', content: 'Sure.', timestamp: 1700000001000,
    tester_name: null, time_to_first_token: 300, total_time: 1000, error_type: null,
    message_type: 'chat', created_at: '2026-06-01T00:00:01Z' },
]

const FEEDBACK_ROWS = [
  { message_id: 'msg-1', rating: 1, feedback_text: null, tags: null,
    tester_name: null, is_tester: 0, created_at: '2026-06-01T00:01:00Z' },
]

const PHOTO_ROW = {
  id: 'photo-1',
  message_id: 'msg-1',
  kind: 'image',
  uploaded_at: 1700000000500,
  metadata_status: 'extracted',
  species_guess: 'raccoon',
  urgency_score: 'HIGH',
  distress_tags: '["bleeding","lethargy"]',
  condition_tag: 'injured',
  trajectory_state: 'worsening',
  responded_at: null,
}

describe('loadSessionDetail', () => {
  function makeDetailDb(): FakeD1 {
    return new FakeD1()
      .on('FROM messages WHERE session_id = ? AND tenant_id = ?', { all: () => MESSAGES })
      .on('FROM feedback WHERE session_id = ? AND tenant_id = ?', { all: () => FEEDBACK_ROWS })
      .on('FROM photos', { all: () => [PHOTO_ROW] })
  }

  it('returns session_id, messages, feedback, photos for a known session', async () => {
    const result = await loadSessionDetail(makeEnv(makeDetailDb()), 'tenant-1', 'sess-1')
    expect('session_id' in result).toBe(true)
    if ('session_id' in result) {
      expect(result.session_id).toBe('sess-1')
      expect(result.messages).toHaveLength(2)
      expect(result.feedback).toHaveLength(1)
      expect(result.photos).toHaveLength(1)
    }
  })

  it('returns 404 sentinel for an unknown session (no messages)', async () => {
    const db = new FakeD1()
      .on('FROM messages WHERE session_id = ? AND tenant_id = ?', { all: () => [] })
    const result = await loadSessionDetail(makeEnv(db), 'tenant-1', 'unknown')
    expect('error' in result && result.status).toBe(404)
    expect(('error' in result && result.error)).toMatch(/not found/i)
  })

  it('shapes photo rows: adds photo_url, parses distress_tags JSON, adds responded bool', async () => {
    const result = await loadSessionDetail(makeEnv(makeDetailDb()), 'tenant-1', 'sess-1')
    if (!('photos' in result)) throw new Error('expected photos')
    const photo = result.photos[0] as Record<string, unknown>
    expect(photo.photo_id).toBe('photo-1')
    expect(photo.photo_url).toBe('/admin/photos/photo-1/raw')
    expect(photo.distress_tags).toEqual(['bleeding', 'lethargy'])
    expect(photo.responded).toBe(false)
  })

  it('distress_tags defaults to [] for null DB value', async () => {
    const photoNoTags = { ...PHOTO_ROW, distress_tags: null }
    const db = new FakeD1()
      .on('FROM messages WHERE session_id = ? AND tenant_id = ?', { all: () => MESSAGES })
      .on('FROM feedback WHERE session_id = ? AND tenant_id = ?', { all: () => [] })
      .on('FROM photos', { all: () => [photoNoTags] })
    const result = await loadSessionDetail(makeEnv(db), 'tenant-1', 'sess-1')
    if (!('photos' in result)) throw new Error('expected photos')
    const photo = result.photos[0] as Record<string, unknown>
    expect(photo.distress_tags).toEqual([])
  })

  it('responded=true when responded_at is not null', async () => {
    const respondedPhoto = { ...PHOTO_ROW, responded_at: 1700001000000 }
    const db = new FakeD1()
      .on('FROM messages WHERE session_id = ? AND tenant_id = ?', { all: () => MESSAGES })
      .on('FROM feedback WHERE session_id = ? AND tenant_id = ?', { all: () => [] })
      .on('FROM photos', { all: () => [respondedPhoto] })
    const result = await loadSessionDetail(makeEnv(db), 'tenant-1', 'sess-1')
    if (!('photos' in result)) throw new Error('expected photos')
    const photo = result.photos[0] as Record<string, unknown>
    expect(photo.responded).toBe(true)
  })

  it('returns empty photos array when no photos exist for the session', async () => {
    const db = new FakeD1()
      .on('FROM messages WHERE session_id = ? AND tenant_id = ?', { all: () => MESSAGES })
      .on('FROM feedback WHERE session_id = ? AND tenant_id = ?', { all: () => FEEDBACK_ROWS })
      .on('FROM photos', { all: () => [] })
    const result = await loadSessionDetail(makeEnv(db), 'tenant-1', 'sess-1')
    if (!('photos' in result)) throw new Error('expected photos')
    expect(result.photos).toHaveLength(0)
  })
})
