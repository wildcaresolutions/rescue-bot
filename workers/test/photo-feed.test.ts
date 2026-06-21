/**
 * Unit tests for:
 *   workers/src/lib/photo-feed.ts  — loadPhotoFeed, servePhotoAsset, resolvePhoto, manualTagPhoto, deletePhoto
 *   workers/src/lib/backfill.ts    — backfillSessionAnalysis
 *
 * analyze-session is mocked so backfill tests control success / failure per
 * session without touching any real DB logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  loadPhotoFeed,
  servePhotoAsset,
  resolvePhoto,
  manualTagPhoto,
  deletePhoto,
  PHOTO_FEED_DEFAULT_LIMIT,
  PHOTO_FEED_MAX_LIMIT,
} from '../src/lib/photo-feed'
import { backfillSessionAnalysis } from '../src/lib/backfill'
import type { Env } from '../src/lib/types'

// Mock analyze-session so we never execute the real quickAnalyzeSession logic
vi.mock('../src/lib/analyze-session', () => ({
  quickAnalyzeSession: vi.fn(),
}))
import { quickAnalyzeSession } from '../src/lib/analyze-session'

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

function makeEnv(db: FakeD1, bucketOverride?: Partial<R2Bucket>): Env {
  const bucket = {
    get: async () => null,
    delete: async () => {},
    ...bucketOverride,
  } as unknown as R2Bucket
  return { DB: db as unknown as D1Database, MEDIA_BUCKET: bucket } as unknown as Env
}

// ── Sample photo row ──────────────────────────────────────────────────────────

const PHOTO_ROW = {
  id: 'photo-abc',
  session_id: 'sess-1',
  message_id: 'msg-1',
  r2_key: 'citizen/t1/sess-1/photo.jpg',
  thumbnail_key: null,
  kind: 'image',
  uploaded_at: Date.now() - 1000,
  metadata_status: 'extracted',
  species_guess: 'raccoon',
  urgency_score: 'HIGH',
  distress_tags: '["bleeding"]',
  condition_tag: 'injured',
  trajectory_state: null,
  responded_at: null,
}

// ── loadPhotoFeed ─────────────────────────────────────────────────────────────

describe('loadPhotoFeed', () => {
  it('returns shaped photo objects with photo_url', async () => {
    const db = new FakeD1().on('FROM photos', { all: () => [PHOTO_ROW] })
    const result = await loadPhotoFeed(makeEnv(db), 'tenant-1', {})
    expect('photos' in result).toBe(true)
    if ('photos' in result) {
      expect(result.photos).toHaveLength(1)
      const p = result.photos[0] as Record<string, unknown>
      expect(p.photo_id).toBe('photo-abc')
      expect(p.photo_url).toBe('/admin/photos/photo-abc/raw')
      expect(p.species_guess).toBe('raccoon')
      expect(p.urgency_score).toBe('HIGH')
    }
  })

  it('parses distress_tags from JSON string', async () => {
    const db = new FakeD1().on('FROM photos', { all: () => [PHOTO_ROW] })
    const result = await loadPhotoFeed(makeEnv(db), 'tenant-1', {})
    if (!('photos' in result)) throw new Error('expected photos')
    const p = result.photos[0] as Record<string, unknown>
    expect(p.distress_tags).toEqual(['bleeding'])
  })

  it('distress_tags is [] when null in DB', async () => {
    const row = { ...PHOTO_ROW, distress_tags: null }
    const db = new FakeD1().on('FROM photos', { all: () => [row] })
    const result = await loadPhotoFeed(makeEnv(db), 'tenant-1', {})
    if (!('photos' in result)) throw new Error('expected photos')
    const p = result.photos[0] as Record<string, unknown>
    expect(p.distress_tags).toEqual([])
  })

  it('returns empty photos array for tenant with no photos', async () => {
    const db = new FakeD1()  // all() returns [] by default
    const result = await loadPhotoFeed(makeEnv(db), 'tenant-1', {})
    expect('photos' in result && result.photos).toHaveLength(0)
  })

  it('responds=true when responded_at is set', async () => {
    const row = { ...PHOTO_ROW, responded_at: Date.now() }
    const db = new FakeD1().on('FROM photos', { all: () => [row] })
    const result = await loadPhotoFeed(makeEnv(db), 'tenant-1', {})
    if (!('photos' in result)) throw new Error('expected photos')
    expect((result.photos[0] as { responded: boolean }).responded).toBe(true)
  })

  it('caps limit at PHOTO_FEED_MAX_LIMIT (200)', async () => {
    const db = new FakeD1().on('FROM photos', { all: () => [] })
    await loadPhotoFeed(makeEnv(db), 'tenant-1', { limit: '9999' })
    const call = db.calls.find(c => c.method === 'all')!
    // 3rd bind is the limit (tenantId, sinceTs, limit)
    const binds = call.binds as number[]
    expect(binds[2]).toBe(PHOTO_FEED_MAX_LIMIT)
  })

  it('uses PHOTO_FEED_DEFAULT_LIMIT when no limit provided', async () => {
    const db = new FakeD1().on('FROM photos', { all: () => [] })
    await loadPhotoFeed(makeEnv(db), 'tenant-1', {})
    const call = db.calls.find(c => c.method === 'all')!
    const binds = call.binds as number[]
    expect(binds[2]).toBe(PHOTO_FEED_DEFAULT_LIMIT)
  })

  it('returns 500 error sentinel on DB exception', async () => {
    const db = new FakeD1().on('FROM photos', {
      all: () => { throw new Error('db crash') },
    })
    const result = await loadPhotoFeed(makeEnv(db), 'tenant-1', {})
    expect('error' in result && result.status).toBe(500)
  })
})

// ── servePhotoAsset ───────────────────────────────────────────────────────────

describe('servePhotoAsset', () => {
  it('returns 404 sentinel for unknown photo (DB row is null)', async () => {
    const db = new FakeD1()  // first() returns null by default
    const result = await servePhotoAsset(makeEnv(db), 'tenant-1', 'no-photo')
    expect('error' in result && result.status).toBe(404)
  })

  it('returns 404 sentinel for deleted photo (deleted_at is non-null)', async () => {
    const db = new FakeD1().on('SELECT r2_key, deleted_at', {
      first: () => ({ r2_key: 'k1', deleted_at: 1234567890 }),
    })
    const result = await servePhotoAsset(makeEnv(db), 'tenant-1', 'deleted-photo')
    expect('error' in result && result.status).toBe(404)
  })

  it('returns 404 sentinel when R2 object is missing', async () => {
    const db = new FakeD1().on('SELECT r2_key, deleted_at', {
      first: () => ({ r2_key: 'missing-key', deleted_at: null }),
    })
    // MEDIA_BUCKET.get returns null by default
    const result = await servePhotoAsset(makeEnv(db), 'tenant-1', 'photo-1')
    expect('error' in result && result.status).toBe(404)
  })

  it('returns a Response with security headers when R2 object exists', async () => {
    const db = new FakeD1().on('SELECT r2_key, deleted_at', {
      first: () => ({ r2_key: 'valid-key', deleted_at: null }),
    })
    const mockObj = {
      writeHttpMetadata: (h: Headers) => h.set('Content-Type', 'image/jpeg'),
      body: new ReadableStream(),
    }
    const env = makeEnv(db, { get: async () => mockObj as unknown as R2ObjectBody })
    const result = await servePhotoAsset(env, 'tenant-1', 'photo-1')
    expect(result instanceof Response).toBe(true)
    const resp = result as Response
    expect(resp.headers.get('Cache-Control')).toContain('private')
    expect(resp.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})

// ── resolvePhoto ──────────────────────────────────────────────────────────────

describe('resolvePhoto', () => {
  it('returns success when photo row is found and updated', async () => {
    const db = new FakeD1().on('UPDATE photos SET responded_at', {
      run: () => ({ success: true, meta: { changes: 1 } }),
    })
    const result = await resolvePhoto(makeEnv(db), 'tenant-1', 'photo-1')
    expect(result).toEqual({ success: true })
  })

  it('returns 404 when no row was updated (changes=0)', async () => {
    const db = new FakeD1().on('UPDATE photos SET responded_at', {
      run: () => ({ success: true, meta: { changes: 0 } }),
    })
    const result = await resolvePhoto(makeEnv(db), 'tenant-1', 'missing-photo')
    expect('error' in result && result.status).toBe(404)
  })
})

// ── manualTagPhoto ────────────────────────────────────────────────────────────

describe('manualTagPhoto', () => {
  it('returns 400 when species or urgency is missing', async () => {
    const db = new FakeD1()
    const result = await manualTagPhoto(makeEnv(db), 'tenant-1', 'p1', {
      species: '', urgency: 'HIGH',
    })
    expect('error' in result && result.status).toBe(400)
  })

  it('returns 400 for invalid urgency value', async () => {
    const db = new FakeD1()
    const result = await manualTagPhoto(makeEnv(db), 'tenant-1', 'p1', {
      species: 'raccoon', urgency: 'EXTREME',
    })
    expect('error' in result && result.status).toBe(400)
  })

  it('returns success and filters distress_tags to known vocabulary', async () => {
    const db = new FakeD1().on("metadata_status = 'manually_tagged'", {
      run: () => ({ success: true, meta: { changes: 1 } }),
    })
    const result = await manualTagPhoto(makeEnv(db), 'tenant-1', 'p1', {
      species: 'raccoon',
      urgency: 'HIGH',
      distress_tags: ['bleeding', 'unknown_tag_xyz'],
    })
    expect(result).toEqual({ success: true })
    // Verify only valid tag was persisted — check the bind args
    const call = db.calls.find(c => c.method === 'run')!
    const tags = JSON.parse(call.binds[2] as string) as string[]
    expect(tags).toContain('bleeding')
    expect(tags).not.toContain('unknown_tag_xyz')
  })
})

// ── deletePhoto ───────────────────────────────────────────────────────────────

describe('deletePhoto', () => {
  it('returns 404 when photo row does not exist', async () => {
    const db = new FakeD1()  // first() returns null
    const result = await deletePhoto(makeEnv(db), 'tenant-1', 'no-photo', {}, () => {})
    expect('error' in result && result.status).toBe(404)
  })

  it('returns already_deleted:true when deleted_at is already set', async () => {
    const db = new FakeD1().on('SELECT r2_key, thumbnail_key, deleted_at', {
      first: () => ({ r2_key: 'k', thumbnail_key: null, deleted_at: 12345 }),
    })
    const result = await deletePhoto(makeEnv(db), 'tenant-1', 'p1', {}, () => {})
    expect('success' in result && result.success).toBe(true)
    expect('already_deleted' in result && result.already_deleted).toBe(true)
  })

  it('executes batch (UPDATE + INSERT audit) and returns success', async () => {
    const db = new FakeD1()
      .on('SELECT r2_key, thumbnail_key, deleted_at', {
        first: () => ({ r2_key: 'citizen/t/s/p.jpg', thumbnail_key: null, deleted_at: null }),
      })
      .on('UPDATE photos SET deleted_at', {
        run: () => ({ success: true, meta: { changes: 1 } }),
      })
      .on('INSERT INTO photo_deletions', {
        run: () => ({ success: true, meta: { changes: 1 } }),
      })
    const waitFns: Promise<unknown>[] = []
    const result = await deletePhoto(makeEnv(db), 'tenant-1', 'p1', { reason: 'pii' }, (p) => { waitFns.push(p) })
    expect('success' in result && result.success).toBe(true)
    // Batch was used: both UPDATE and INSERT calls present
    const updateCall = db.calls.find(c => c.sql.includes('UPDATE photos SET deleted_at'))
    const insertCall = db.calls.find(c => c.sql.includes('INSERT INTO photo_deletions'))
    expect(updateCall).toBeDefined()
    expect(insertCall).toBeDefined()
  })
})

// ── backfillSessionAnalysis ───────────────────────────────────────────────────

describe('backfillSessionAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns {candidates:0,analyzed:0,failed:0} when no un-analyzed sessions exist', async () => {
    const db = new FakeD1().on('sa.id IS NULL', { all: () => [] })
    const result = await backfillSessionAnalysis(makeEnv(db), 'tenant-1')
    expect(result).toEqual({ candidates: 0, analyzed: 0, failed: 0 })
    expect(quickAnalyzeSession).not.toHaveBeenCalled()
  })

  it('calls quickAnalyzeSession once per candidate and reports analyzed count', async () => {
    const db = new FakeD1().on('sa.id IS NULL', {
      all: () => [{ session_id: 'sess-a' }, { session_id: 'sess-b' }],
    })
    vi.mocked(quickAnalyzeSession).mockResolvedValue(undefined as never)
    const result = await backfillSessionAnalysis(makeEnv(db), 'tenant-1')
    expect(result.candidates).toBe(2)
    expect(result.analyzed).toBe(2)
    expect(result.failed).toBe(0)
    expect(quickAnalyzeSession).toHaveBeenCalledTimes(2)
    expect(quickAnalyzeSession).toHaveBeenCalledWith(
      expect.anything(), 'tenant-1', 'sess-a', 'backfill',
    )
  })

  it('increments failed when quickAnalyzeSession throws', async () => {
    const db = new FakeD1().on('sa.id IS NULL', {
      all: () => [{ session_id: 'bad-sess' }],
    })
    vi.mocked(quickAnalyzeSession).mockRejectedValue(new Error('analyze failed'))
    const result = await backfillSessionAnalysis(makeEnv(db), 'tenant-1')
    expect(result.candidates).toBe(1)
    expect(result.analyzed).toBe(0)
    expect(result.failed).toBe(1)
  })

  it('processes partial failures: analyzed + failed sum to candidates', async () => {
    const db = new FakeD1().on('sa.id IS NULL', {
      all: () => [{ session_id: 'ok-sess' }, { session_id: 'err-sess' }],
    })
    vi.mocked(quickAnalyzeSession)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error('oops'))
    const result = await backfillSessionAnalysis(makeEnv(db), 'tenant-1')
    expect(result.analyzed).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.analyzed + result.failed).toBe(result.candidates)
  })
})
