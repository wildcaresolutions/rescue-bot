/**
 * Unit tests for workers/src/lib/report.ts
 *
 * AI and email dependencies are mocked so tests run without network access.
 * buildReportHtml is pure and tested directly.
 * generateReport is tested in dry-run mode (no DB INSERT, no email) and
 * in non-dry-run mode (verifies DB writes and email dispatch).
 * analyzeSession is tested for its JSON-extraction / error-handling logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildReportHtml,
  generateReport,
  analyzeSession,
  type ReportStats,
} from '../src/lib/report'
import type { Env } from '../src/lib/types'

// ── Mocks ─────────────────────────────────────────────────────────────────────
// vi.mock calls are hoisted above imports by vitest, so the mocks are in
// place before report.ts loads its dependencies.

vi.mock('../src/lib/ai', () => ({
  runGatewayChatText: vi.fn(),
}))

vi.mock('../src/lib/email', () => ({
  sendEmail: vi.fn(),
}))

import { runGatewayChatText } from '../src/lib/ai'
import { sendEmail } from '../src/lib/email'

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
    return { success: true, meta: { changes: 1, last_row_id: 99 } }
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SAMPLE_STATS: ReportStats = {
  period_start: '2026-06-20T00:00:00.000Z',
  period_end: '2026-06-21T00:00:00.000Z',
  total_sessions: 5,
  by_urgency: { critical: 1, urgent: 2, moderate: 1, none: 1 },
  by_outcome: { bringing_in: 2, resolved: 1, redirected: 1, abandoned: 0, unknown: 1 },
}

const SAMPLE_SESSIONS = [
  {
    sessionId: 'sess-1',
    messages: [
      { role: 'user', content: 'I found a raccoon' },
      { role: 'assistant', content: 'Please bring it in.' },
    ],
    analysis: { urgency: 'urgent', animal: 'raccoon', outcome: 'bringing_in' },
  },
]

/** Make a FakeD1 that produces no sessions (for the empty-report path). */
function makeEmptyReportDb(): FakeD1 {
  return new FakeD1()
    .on('WITH session_starts AS', { all: () => [] })
    .on('SELECT report_recipients FROM tenants', { first: () => ({ report_recipients: null }) })
}

/** Make a FakeD1 with one session that has two messages. */
function makeOneSessionDb(): FakeD1 {
  return new FakeD1()
    .on('WITH session_starts AS', { all: () => [{ session_id: 'sess-1' }] })
    .on('SELECT role, content FROM messages WHERE session_id', {
      all: () => [
        { role: 'user', content: 'I found an injured raccoon' },
        { role: 'assistant', content: 'Please bring it in.' },
      ],
    })
    .on('SELECT report_recipients FROM tenants', { first: () => ({ report_recipients: null }) })
}

// ── buildReportHtml ───────────────────────────────────────────────────────────

describe('buildReportHtml', () => {
  it('returns a non-empty HTML string', () => {
    const html = buildReportHtml(SAMPLE_STATS, [], 'WildCare')
    expect(typeof html).toBe('string')
    expect(html.length).toBeGreaterThan(100)
    expect(html).toContain('<!DOCTYPE html>')
  })

  it('includes the platform name in the output', () => {
    const html = buildReportHtml(SAMPLE_STATS, [], 'TestOrg')
    expect(html).toContain('TestOrg')
  })

  it('shows total session count in the summary', () => {
    const html = buildReportHtml(SAMPLE_STATS, [], 'WildCare')
    expect(html).toContain('5 public sessions')
  })

  it('includes urgency breakdown numbers', () => {
    const html = buildReportHtml(SAMPLE_STATS, [], 'WildCare')
    // by_urgency: critical=1, urgent=2
    expect(html).toMatch(/Critical.*?1/s)
    expect(html).toMatch(/Urgent.*?2/s)
  })

  it('includes outcome breakdown numbers', () => {
    const html = buildReportHtml(SAMPLE_STATS, [], 'WildCare')
    expect(html).toContain('Bringing animal in')
    expect(html).toContain('Resolved remotely')
  })

  it('renders session rows when sessions are provided', () => {
    const html = buildReportHtml(SAMPLE_STATS, SAMPLE_SESSIONS, 'WildCare')
    expect(html).toContain('raccoon')
    expect(html).toContain('urgent')
    expect(html).toContain('bringing_in')
  })

  it('escapes HTML special characters in animal/urgency fields', () => {
    const xssSessions = [
      {
        sessionId: 'sess-xss',
        messages: [{ role: 'user', content: '<script>alert(1)</script>' }],
        analysis: { urgency: 'urgent', animal: '<b>raccoon</b>', outcome: 'bringing_in' },
      },
    ]
    const html = buildReportHtml(SAMPLE_STATS, xssSessions, 'WildCare')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;b&gt;')
  })

  it('handles sessions with no user messages gracefully', () => {
    const emptySessions = [
      {
        sessionId: 'sess-empty',
        messages: [],
        analysis: { urgency: 'none', animal: null, outcome: 'unknown' },
      },
    ]
    const html = buildReportHtml(SAMPLE_STATS, emptySessions, 'WildCare')
    expect(typeof html).toBe('string')
    expect(html.length).toBeGreaterThan(50)
  })
})

// ── analyzeSession ────────────────────────────────────────────────────────────

describe('analyzeSession', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('extracts and returns the JSON object from AI text', async () => {
    vi.mocked(runGatewayChatText).mockResolvedValueOnce({
      text: '{"urgency":"moderate","animal":"squirrel","situation":"orphaned","outcome":"bringing_in","in_service_area":true}',
    } as never)
    const result = await analyzeSession(makeEnv(makeEmptyReportDb()), [
      { role: 'user', content: 'Found a baby squirrel' },
    ])
    expect(result.urgency).toBe('moderate')
    expect(result.animal).toBe('squirrel')
    expect(result.outcome).toBe('bringing_in')
  })

  it('returns {error:"parse failed"} when AI returns non-JSON text', async () => {
    vi.mocked(runGatewayChatText).mockResolvedValueOnce({ text: 'sorry I cannot help' } as never)
    const result = await analyzeSession(makeEnv(makeEmptyReportDb()), [
      { role: 'user', content: 'test' },
    ])
    expect(result.error).toBe('parse failed')
  })

  it('returns {error:"parse failed"} when JSON block is malformed', async () => {
    vi.mocked(runGatewayChatText).mockResolvedValueOnce({ text: '{bad json}' } as never)
    const result = await analyzeSession(makeEnv(makeEmptyReportDb()), [
      { role: 'user', content: 'test' },
    ])
    expect(result.error).toBe('parse failed')
  })

  it('extracts JSON embedded in surrounding text', async () => {
    vi.mocked(runGatewayChatText).mockResolvedValueOnce({
      text: 'Here is the analysis:\n{"urgency":"critical","animal":"hawk","situation":"injured","outcome":"bringing_in","in_service_area":true}\nDone.',
    } as never)
    const result = await analyzeSession(makeEnv(makeEmptyReportDb()), [
      { role: 'user', content: 'injured hawk' },
    ])
    expect(result.urgency).toBe('critical')
    expect(result.animal).toBe('hawk')
  })
})

// ── generateReport — dry run ──────────────────────────────────────────────────

describe('generateReport — dryRun=true', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns success:true with period and stats', async () => {
    const result = await generateReport(makeEnv(makeEmptyReportDb()), 'tenant-1', true)
    expect(result.success).toBe(true)
    expect(result.period).toHaveProperty('start')
    expect(result.period).toHaveProperty('end')
    expect(result.stats).toHaveProperty('total_sessions')
    expect(result.stats).toHaveProperty('by_urgency')
    expect(result.stats).toHaveProperty('by_outcome')
  })

  it('returns zero-valued stats when no sessions exist', async () => {
    const result = await generateReport(makeEnv(makeEmptyReportDb()), 'tenant-1', true)
    expect(result.stats.total_sessions).toBe(0)
    expect(result.stats.by_urgency.critical).toBe(0)
    expect(result.stats.by_urgency.urgent).toBe(0)
    expect(result.stats.by_outcome.bringing_in).toBe(0)
  })

  it('does NOT insert into reports table in dry-run mode', async () => {
    const db = makeEmptyReportDb()
    await generateReport(makeEnv(db), 'tenant-1', true)
    const insertCall = db.calls.find(c => c.sql.includes('INSERT INTO reports'))
    expect(insertCall).toBeUndefined()
  })

  it('does NOT call sendEmail in dry-run mode', async () => {
    await generateReport(makeEnv(makeEmptyReportDb()), 'tenant-1', true)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('populates urgency/outcome counts from AI analysis for a real session', async () => {
    vi.mocked(runGatewayChatText).mockResolvedValueOnce({
      text: '{"urgency":"critical","animal":"deer","situation":"injured","outcome":"bringing_in","in_service_area":true}',
    } as never)
    const result = await generateReport(makeEnv(makeOneSessionDb()), 'tenant-1', true)
    expect(result.stats.total_sessions).toBe(1)
    expect(result.stats.by_urgency.critical).toBe(1)
    expect(result.stats.by_outcome.bringing_in).toBe(1)
  })

  it('email_sent is false in dry-run regardless of recipients', async () => {
    const db = new FakeD1()
      .on('WITH session_starts AS', { all: () => [] })
      .on('SELECT report_recipients FROM tenants', { first: () => ({ report_recipients: 'ops@example.com' }) })
    const result = await generateReport(makeEnv(db), 'tenant-1', true)
    expect(result.email_sent).toBe(false)
  })
})

// ── generateReport — non-dry-run ──────────────────────────────────────────────

describe('generateReport — dryRun=false', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('inserts a row into the reports table and returns report_id', async () => {
    const db = makeEmptyReportDb()
      .on('INSERT INTO reports', {
        run: () => ({ success: true, meta: { changes: 1, last_row_id: 42 } }),
      })
    // Second collectReportRecipients call (unconditional one at bottom)
    const result = await generateReport(makeEnv(db), 'tenant-1', false)
    expect(result.report_id).toBe(42)
    const insertCall = db.calls.find(c => c.sql.includes('INSERT INTO reports'))
    expect(insertCall).toBeDefined()
  })

  it('does not call sendEmail when report_recipients is null', async () => {
    const db = makeEmptyReportDb()
      .on('INSERT INTO reports', {
        run: () => ({ success: true, meta: { changes: 1, last_row_id: 1 } }),
      })
    await generateReport(makeEnv(db), 'tenant-1', false)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('calls sendEmail when valid report_recipients are configured', async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({ sent: true } as never)
    const db = new FakeD1()
      .on('WITH session_starts AS', { all: () => [] })
      // First collectReportRecipients (inside !dryRun block, no toOverride)
      .on('SELECT report_recipients FROM tenants', { first: () => ({ report_recipients: 'ops@example.com' }) })
      .on('INSERT INTO reports', {
        run: () => ({ success: true, meta: { changes: 1, last_row_id: 7 } }),
      })
    const result = await generateReport(makeEnv(db), 'tenant-1', false)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(result.email_sent).toBe(true)
  })
})
