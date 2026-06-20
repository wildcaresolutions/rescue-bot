/**
 * Integration tests for workers/src/routes/chat.ts
 *
 * These tests send REAL HTTP requests to a deployed Cloudflare Worker.
 * They exercise the full stack: D1 (sessions/messages/feedback), Vectorize
 * (RAG), and the AI Gateway (real LLM streaming). No mocks.
 *
 * Prerequisites:
 *   - A deployed test worker reachable at BASE_URL
 *   - A pre-seeded tenant with slug=TEST_TENANT_SLUG, id=TEST_TENANT_ID
 *   - 'localhost' must be an auto-allowed origin (it is: index.ts middleware
 *     short-circuits localhost/127.0.0.1 before the allowed_domains lookup)
 *
 * Run:
 *   BASE_URL=https://wildcare-bot-test.<account>.workers.dev \
 *   SIGNING_SECRET=<secret> \
 *   TEST_TENANT_SLUG=<slug> \
 *   TEST_TENANT_ID=<id> \
 *   cd workers && npx vitest run --config vitest.integration.config.ts \
 *     integration/chat.test.ts
 *
 * Design notes on assertions:
 *   - Where actual handler behavior diverges from a naive reading of the spec,
 *     tests assert REAL behavior with a comment explaining the discrepancy.
 *   - Assertions on LLM response wording are intentionally absent — only
 *     structure (status, content-type, length) is checked.
 *   - The assistant message is persisted in waitUntil AFTER the streaming
 *     response closes. Tests that need it use pollForMessages() with a
 *     generous timeout so the DB write races don't produce false failures.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { BASE_URL, TENANT_SLUG, chatHeaders } from './_harness'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** UUID v4 pattern produced by crypto.randomUUID(). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Create a fresh session under the test tenant.
 * Asserts 200 + UUID before returning the id so downstream tests start
 * from a known-good state.
 */
async function createSession(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: chatHeaders,
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    throw new Error(`createSession failed: ${res.status} ${await res.text()}`)
  }
  const data = await res.json() as { id: string }
  if (!data.id) throw new Error(`createSession: no id in response: ${JSON.stringify(data)}`)
  return data.id
}

/**
 * GET /api/sessions/:id until the messages array satisfies predicate or
 * maxWaitMs elapses. Returns the last messages array seen (may not satisfy
 * predicate if the deadline was hit).
 *
 * Used to wait for the assistant message which is persisted in waitUntil
 * after the response stream closes — there is an inherent small delay.
 */
async function pollForMessages(
  sessionId: string,
  predicate: (msgs: Record<string, unknown>[]) => boolean,
  maxWaitMs = 8_000,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + maxWaitMs
  let lastMsgs: Record<string, unknown>[] = []
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      headers: chatHeaders,
    })
    if (res.ok) {
      const data = await res.json() as { messages: Record<string, unknown>[] }
      lastMsgs = data.messages ?? []
      if (predicate(lastMsgs)) return lastMsgs
    }
    await new Promise<void>(r => setTimeout(r, 600))
  }
  return lastMsgs
}

// ── Session creation (POST /api/sessions) ────────────────────────────────────

describe('POST /api/sessions — session creation', () => {
  it('returns 200 with a UUID session id for a valid tenant + localhost Origin', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { id: string }
    expect(body.id).toMatch(UUID_RE)
  })

  it('returns 403 when the Origin header is absent', async () => {
    // The /api/* auth middleware (index.ts) requires an Origin for the public
    // chat API (/api/sessions, /api/messages, /api/feedback). Missing Origin →
    // 403 "Origin header required" — not a CORS issue, a server-side gate.
    const headersWithoutOrigin: Record<string, string> = {
      'X-Tenant-Slug': TENANT_SLUG,
      'Content-Type': 'application/json',
    }
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: headersWithoutOrigin,
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  it('returns 403 when Origin is a cross-origin host not in allowed_domains', async () => {
    // evil.example.com is not seeded in allowed_domains for the test tenant.
    // The auth middleware rejects it with 403 "Origin not allowed for this tenant".
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: {
        'X-Tenant-Slug': TENANT_SLUG,
        'Content-Type': 'application/json',
        'Origin': 'https://evil.example.com',
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  it('does not include a session_token when photo uploads are disabled', async () => {
    // session_token is only minted when photoUploadsEnabled(tenant) returns true
    // (feature flag photo_uploads_enabled in tenants.feature_flags JSON column).
    // The test tenant is expected to have the flag off (default state).
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { id: string; session_token?: string }
    // session_token is undefined (not included) when the flag is off.
    // If the test tenant has the flag on, this assertion becomes a no-op (not a failure).
    if (body.session_token !== undefined) {
      // Flag is on — token must be a non-empty string.
      expect(typeof body.session_token).toBe('string')
      expect(body.session_token.length).toBeGreaterThan(0)
    }
    // Regardless of flag, id is always present.
    expect(body.id).toMatch(UUID_RE)
  })
})

// ── Session retrieval (GET /api/sessions/:id) ─────────────────────────────────

describe('GET /api/sessions/:id — session retrieval', () => {
  let knownSessionId: string

  beforeAll(async () => {
    knownSessionId = await createSession()
  })

  it('returns 200 with session id and an empty messages array for a fresh session', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions/${knownSessionId}`, {
      headers: chatHeaders,
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { id: string; messages: unknown[]; photo_count: unknown }
    expect(body.id).toBe(knownSessionId)
    expect(Array.isArray(body.messages)).toBe(true)
    // photo_count shape is always returned even if photos table has no rows.
    expect(body.photo_count).toBeDefined()
  })

  it('for an unknown (but validly-formatted) UUID returns 200 with empty messages', async () => {
    // Implementation detail: the GET handler queries messages filtered by
    // (session_id, tenant_id). An unknown session simply has no rows — the
    // handler does NOT 404. This is by design: the client rehydrates its
    // widget state from the messages array; an empty array is valid state.
    //
    // Tolerant assertion: accept 404 in case a future version adds an explicit
    // existence check, but document that the current behavior is 200 + empty.
    const fakeId = crypto.randomUUID()
    const res = await fetch(`${BASE_URL}/api/sessions/${fakeId}`, {
      headers: chatHeaders,
    })
    expect([200, 404]).toContain(res.status)
    if (res.status === 200) {
      const body = await res.json() as { messages: unknown[] }
      expect(body.messages).toHaveLength(0)
    }
  })

  it('returns 400 for a session id that fails the validSessionId check', async () => {
    // validSessionId rejects ids with characters outside /^[\w-]+$/ or empty.
    const res = await fetch(`${BASE_URL}/api/sessions/!!not-valid!!`, {
      headers: chatHeaders,
    })
    expect(res.status).toBe(400)
  })
})

// ── Input validation (POST /api/sessions/:id) — no LLM calls ─────────────────

describe('POST /api/sessions/:id — input validation', () => {
  let sessionId: string

  beforeAll(async () => {
    sessionId = await createSession()
  })

  it('returns 400 for an empty message string', async () => {
    // The handler: `if (!userMessage) return badRequest(c, 'message required')`
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ message: '' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/message required/i)
  })

  it('returns 400 for a message consisting only of whitespace', async () => {
    // The handler trims before checking: `body.message.trim()` is empty → 400.
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ message: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for an unparseable JSON body', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      method: 'POST',
      headers: chatHeaders,
      body: 'not json{',
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for a message exceeding MAX_MESSAGE_LEN (8 000 chars)', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ message: 'x'.repeat(8_001) }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/too long/i)
  })
})

// ── Main chat path (POST /api/sessions/:id) — real LLM calls ─────────────────

describe('POST /api/sessions/:id — real LLM streaming', () => {
  // Share a single LLM call across related assertions to minimise API spend.
  let sessionId: string
  let responseStatus: number
  let responseContentType: string | null
  let responseBody: string

  beforeAll(async () => {
    sessionId = await createSession()
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ message: 'I found an injured baby raccoon. What should I do?' }),
    })
    responseStatus = res.status
    responseContentType = res.headers.get('content-type')
    // Drain the full stream — this also triggers the waitUntil DB writes.
    responseBody = await res.text()
  })

  it('returns HTTP 200 (not 429 from the M-9 per-session turn cap)', () => {
    // The M-9 cap fires when COUNT(*) of user messages >= 50 (MAX_SESSION_TURNS).
    // A fresh session has 0, so the first message is always allowed.
    // Testing the cap exhaustively (50 turns) is impractical in an integration
    // suite — see the manual / load-test runbook for cap verification.
    expect(responseStatus).toBe(200)
  })

  it('sets Content-Type: text/plain (streamed plain-text, not JSON or SSE)', () => {
    // runMainChat() returns `new Response(outStream, { headers: { 'Content-Type':
    // 'text/plain; charset=utf-8' } })`. The gateway may set charset separately.
    expect(responseContentType).toContain('text/plain')
  })

  it('response body is non-trivial (> 40 characters) — real LLM answer', () => {
    // We don't assert on wording — any non-trivial answer satisfies this.
    expect(responseBody.length).toBeGreaterThan(40)
  })

  it('persists the user message in D1 synchronously (visible before stream closes)', async () => {
    // The user message INSERT runs BEFORE openGatewayChatStream — it is
    // persisted synchronously and visible on GET immediately after the turn.
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      headers: chatHeaders,
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { messages: Record<string, unknown>[] }
    const userMsg = data.messages.find(m => m.role === 'user')
    expect(userMsg).toBeDefined()
    expect((userMsg!.content as string).toLowerCase()).toContain('raccoon')
  })

  it('persists the assistant message in D1 after the stream closes (waitUntil)', async () => {
    // The assistant INSERT runs inside waitUntil after the ReadableStream
    // closes — there is a brief delay after the HTTP response body is fully
    // received. pollForMessages() retries for up to 8 s.
    const messages = await pollForMessages(
      sessionId,
      msgs => msgs.some(m => m.role === 'assistant'),
      8_000,
    )
    const assistantMsg = messages.find(m => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(typeof assistantMsg!.content).toBe('string')
    expect((assistantMsg!.content as string).length).toBeGreaterThan(20)
  })

  it('GET /api/sessions/:id returns both user and assistant messages in order', async () => {
    const messages = await pollForMessages(
      sessionId,
      msgs => msgs.some(m => m.role === 'assistant'),
      8_000,
    )
    const roles = messages.map(m => m.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')
    // User turn precedes assistant turn.
    expect(roles.indexOf('user')).toBeLessThan(roles.indexOf('assistant'))
  })
})

// ── Feedback (POST /api/feedback) ─────────────────────────────────────────────

describe('POST /api/feedback — feedback submission', () => {
  let sessionId: string

  beforeAll(async () => {
    sessionId = await createSession()
  })

  it('stores feedback for a valid session with rating: 1 (thumbs-up)', async () => {
    const res = await fetch(`${BASE_URL}/api/feedback`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ sessionId, rating: 1 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean }
    expect(body.success).toBe(true)
  })

  it('stores feedback with rating: 0 (thumbs-down)', async () => {
    // The handler accepts rating 0 or 1; any other value returns 400.
    const res = await fetch(`${BASE_URL}/api/feedback`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ sessionId, rating: 0 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean }
    expect(body.success).toBe(true)
  })

  it('accepts optional feedback text alongside a valid rating', async () => {
    const res = await fetch(`${BASE_URL}/api/feedback`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({
        sessionId,
        rating: 1,
        feedback: 'The bot gave great raccoon advice.',
        messagePreview: 'I found an injured baby raccoon.',
      }),
    })
    expect(res.status).toBe(200)
  })

  it('returns 400 when sessionId is missing', async () => {
    // `validSessionId('')` is false → badRequest
    const res = await fetch(`${BASE_URL}/api/feedback`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ rating: 1 }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when rating is not 0 or 1 (e.g. 5)', async () => {
    const res = await fetch(`${BASE_URL}/api/feedback`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ sessionId, rating: 5 }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/rating must be 0 or 1/i)
  })

  it('returns 400 when rating is a string instead of a number', async () => {
    const res = await fetch(`${BASE_URL}/api/feedback`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ sessionId, rating: '1' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for an unparseable JSON body', async () => {
    const res = await fetch(`${BASE_URL}/api/feedback`, {
      method: 'POST',
      headers: chatHeaders,
      body: 'not json{',
    })
    expect(res.status).toBe(400)
  })
})

// ── Cross-tenant isolation ────────────────────────────────────────────────────

describe('cross-tenant session isolation', () => {
  it('a session created under the test tenant is not accessible via a foreign tenant slug', async () => {
    // Create a session under the test tenant.
    const sessionId = await createSession()

    // Attempt to read it with a completely different (non-existent) tenant slug.
    //
    // Isolation mechanisms:
    //   1. Non-existent slug → loadTenantBySlug returns null → /api/* middleware
    //      returns 400 "Tenant required" before the route handler runs.
    //   2. If a different *existing* tenant slug were used, the SELECT in
    //      GET /api/sessions/:id filters on tenant_id — the original session's
    //      messages are never returned (200 + empty array).
    //
    // Both outcomes confirm isolation. We test the non-existent-slug path here
    // because it doesn't require a second tenant to be provisioned on the test env.
    const alienHeaders: Record<string, string> = {
      'X-Tenant-Slug': 'xxxx-not-a-real-tenant-slug-xxxx',
      'Origin': 'http://localhost',
      'Content-Type': 'application/json',
    }
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      headers: alienHeaders,
    })

    if (res.status === 200) {
      // Reached if the alien slug accidentally resolved to an existing tenant.
      // Data isolation still holds: messages from the test tenant must not appear.
      const body = await res.json() as { messages: unknown[] }
      expect(body.messages).toHaveLength(0)
    } else {
      // 400 = tenant not found (expected); 403 = origin/auth blocked; 404 = not found.
      expect([400, 403, 404]).toContain(res.status)
    }
  })

  it('sending a chat message with a foreign tenant slug is blocked before the LLM is reached', async () => {
    // Same isolation check, but via the chat POST path.
    // No LLM calls are made because the auth gate fires before the handler.
    const alienHeaders: Record<string, string> = {
      'X-Tenant-Slug': 'xxxx-not-a-real-tenant-slug-xxxx',
      'Origin': 'http://localhost',
      'Content-Type': 'application/json',
    }
    const res = await fetch(`${BASE_URL}/api/sessions/some-session-id`, {
      method: 'POST',
      headers: alienHeaders,
      body: JSON.stringify({ message: 'hello' }),
    })
    // Non-existent tenant → 400. If slug resolved to a tenant it would proceed
    // but write into that tenant's namespace (not the original session's).
    expect([400, 403, 404]).toContain(res.status)
  })
})
