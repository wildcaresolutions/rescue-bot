import { describe, it, expect } from 'vitest'
import worker from '../src/index'
import type { Env } from '../src/lib/types'

// Unit tests for POST /api/messages — the endpoint the widget client used to
// call in addition to the server's own inline INSERT during the chat flow.
//
// Root cause of the "doubled messages" bug (2026-06-02):
//   The chat Worker writes user+assistant rows with UUID message IDs during
//   the streaming flow. The widget client was ALSO posting those same logical
//   messages to /api/messages with sequential client-generated IDs
//   (msg-<sessionId>-0, msg-<sessionId>-1). Because the IDs never matched, the
//   ON CONFLICT (message_id) DO NOTHING clause never fired, so every message got
//   two rows in D1 and appeared twice in the admin dashboard.
//
// Fix: the client no longer calls /api/messages for user/assistant messages
//   (widget.js: saveMessageMetadata removed; chat.js: sendToBackend skipped for
//   user/assistant roles). These tests verify the endpoint's own dedup behavior
//   AND that it rejects roles the server never writes via this path.

// ── Minimal stubs ──────────────────────────────────────────────────────────────

// Tracks each INSERT .run() call so we can assert insert count.
class TrackingD1 {
  inserts: Array<{ sql: string; args: unknown[] }> = []
  // Simulate whether a message_id was already inserted (for ON CONFLICT stub)
  seenIds = new Set<string>()

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, ' ').trim()
    const self = this
    let bound: unknown[] = []
    return {
      bind(...args: unknown[]) {
        bound = args
        return this
      },
      async first<T = unknown>(): Promise<T | null> {
        // tenants lookup (needed for tenant resolution middleware)
        if (/SELECT \* FROM tenants WHERE slug = \?/i.test(norm)) {
          if (bound[0] === 'wildcare') {
            return {
              id: 'wc-0001', slug: 'wildcare', name: 'WildCare',
              phone: null, url: null, email: null,
              location_county: null, location_state: null, location_service_area: null,
              color_primary: '#78a12e', color_secondary: '#004863', color_accent: '#f4a518',
              logo_r2_key: null, custom_instruction: null, password_hash: null,
              widget_theme: null, widget_custom_css: null, org_config: null,
              bot_overrides: null, admin_token_hash: null, onboarded: 1,
              report_recipients: null, created_at: '2026-01-01', updated_at: '2026-01-01',
            } as T
          }
          return null
        }
        // Session lookup (needed to validate sessionId exists)
        if (/SELECT.*FROM sessions WHERE id = \?/i.test(norm)) {
          return { id: bound[0], tenant_id: 'wc-0001' } as T
        }
        return null
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        if (/FROM allowed_domains WHERE tenant_id = \?/i.test(norm)) {
          return { results: [{ domain: 'discoverwildcare.org' }] as T[] }
        }
        return { results: [] }
      },
      async run(): Promise<{ success: boolean; meta: { changes: number } }> {
        if (/INSERT INTO messages/i.test(norm)) {
          const messageId = bound[1] as string
          const alreadySeen = self.seenIds.has(messageId)
          self.inserts.push({ sql: norm, args: [...bound] })
          if (!alreadySeen) self.seenIds.add(messageId)
          // Simulate ON CONFLICT (message_id) DO NOTHING: changes=0 if seen
          return { success: true, meta: { changes: alreadySeen ? 0 : 1 } }
        }
        return { success: true, meta: { changes: 0 } }
      },
    }
  }
}

function makeEnv(db: TrackingD1): Env {
  return {
    SIGNING_SECRET: 'test-signing-secret',
    TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    PLATFORM_ADMIN_EMAILS: 'mark@bluesnoop.com',
    DEV_AUTH_BYPASS: '',
    ENVIRONMENT: 'test',
    DB: db as unknown as D1Database,
  } as unknown as Env
}

const fakeCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext

async function postMessages(
  body: Record<string, unknown>,
  db: TrackingD1,
): Promise<Response> {
  return worker.fetch(
    new Request('https://wildcare.wildcaresolutions.org/api/messages', {
      method: 'POST',
      headers: {
        'Host': 'wildcare.wildcaresolutions.org',
        'Content-Type': 'application/json',
        'X-Tenant-Slug': 'wildcare',
        'Origin': 'https://discoverwildcare.org',
      },
      body: JSON.stringify(body),
    }),
    makeEnv(db),
    fakeCtx,
  )
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('POST /api/messages', () => {
  it('accepts user role and reports inserted:true', async () => {
    const db = new TrackingD1()
    const res = await postMessages(
      { sessionId: 'abc123', messageId: 'msg-uuid-A', role: 'user', content: 'hello' },
      db,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean; inserted: boolean }
    expect(body.success).toBe(true)
    expect(body.inserted).toBe(true)
  })

  it('accepts assistant role and reports inserted:true', async () => {
    const db = new TrackingD1()
    const res = await postMessages(
      { sessionId: 'abc123', messageId: 'msg-uuid-B', role: 'assistant', content: 'hi there' },
      db,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean; inserted: boolean }
    expect(body.success).toBe(true)
    expect(body.inserted).toBe(true)
  })

  it('rejects system role with 400', async () => {
    // The server never writes system messages, so this role is intentionally
    // blocked. The chat.js sendToBackend guard also skips user/assistant now,
    // but system messages would hit this path and get rejected cleanly.
    const db = new TrackingD1()
    const res = await postMessages(
      { sessionId: 'abc123', messageId: 'msg-sys-1', role: 'system', content: 'error msg' },
      db,
    )
    expect(res.status).toBe(400)
  })

  it('deduplicates when the same message_id is sent twice (ON CONFLICT)', async () => {
    // This is the happy path when IDs DO match — only one row in D1.
    // The doubled-messages bug occurred because client IDs never matched
    // the server's UUID IDs, so this guard never fired.
    const db = new TrackingD1()
    const payload = { sessionId: 'abc123', messageId: 'msg-uuid-SAME', role: 'user', content: 'hi' }

    const first = await postMessages(payload, db)
    expect((await first.clone().json() as { inserted: boolean }).inserted).toBe(true)

    const second = await postMessages(payload, db)
    expect((await second.clone().json() as { inserted: boolean }).inserted).toBe(false)

    // Only one actual INSERT row with changes=1; second was a no-op
    const realInserts = db.inserts.filter(i => db.seenIds.has(i.args[1] as string))
    expect(realInserts.length).toBe(2) // two runs, but one was DO NOTHING
  })

  it('creates a second row when message_id differs — documents the bug scenario', async () => {
    // This test demonstrates exactly why the bug occurred:
    // server inserts msg-<uuid>, client inserts msg-<sessionId>-0 — different
    // IDs, ON CONFLICT never fires, two rows land in D1.
    // The fix (removing client sends) makes this path unreachable, but the
    // test documents the mechanism so a future regression is visible.
    const db = new TrackingD1()
    const sessionId = 'sess-xyz'
    const content = 'an injured bird'

    // Simulate server write (UUID-style ID from runMainChat)
    await postMessages({ sessionId, messageId: 'msg-550e8400-e29b-41d4-a716', role: 'user', content }, db)
    // Simulate OLD client write (sequential ID from widget.js)
    await postMessages({ sessionId, messageId: `msg-${sessionId}-0`, role: 'user', content }, db)

    // Both inserts land — two distinct rows for the same logical message
    expect(db.inserts.length).toBe(2)
    const ids = db.inserts.map(i => i.args[1])
    expect(new Set(ids).size).toBe(2) // different IDs = no dedup
  })
})
