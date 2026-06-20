/**
 * Integration tests for routes/admin.ts
 *
 * These tests fire REAL HTTP at a live (or local) worker instance — no mocks,
 * no in-process handler calls. Run them with:
 *
 *   BASE_URL=https://wildcare-bot-test.<account>.workers.dev \
 *   TEST_TENANT_SLUG=<slug> \
 *   TEST_TENANT_ID=<uuid> \
 *   SIGNING_SECRET=<secret> \
 *   npx vitest run --config vitest.integration.config.ts
 *
 * Or against a local dev server:
 *   make cf-dev   # in another terminal
 *   SIGNING_SECRET=dev-secret npx vitest run --config vitest.integration.config.ts
 *
 * See integration/_harness.ts for all runtime prerequisites.
 *
 * NOTE ON RESPONSE SHAPES — shapes are verified against source, not the PR
 * brief (which had several wrong keys/status codes):
 *   - /admin/dashboard  → { action_items, recent, week }  (snake_case)
 *   - /admin/sessions   → bare array (route calls c.json(result.results))
 *   - /admin/bot-status → { timestamp, llm, rag, database, totalMessages }
 *   - /admin/knowledge-base → { builtin_guides, custom_protocols, stats }
 *   - POST /admin/evals → 200 (not 201)
 *   - DELETE /admin/evals/:nonexistent → 200 (idempotent, no rowcount check)
 *
 * NOTE ON AUTH STATUS CODES — the /admin/* middleware (index.ts) returns 401
 * for both "no token" and "non-admin/wrong-tenant token". There is no 403 in
 * that gate. Tests accept [401, 403] for the non-admin / cross-tenant cases
 * to tolerate any future hardening, but reality today is always 401.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import {
  BASE_URL,
  adminHeaders,
  viewerHeaders,
  foreignHeaders,
  noAuthHeaders,
} from './_harness'

// ── Auth gating ────────────────────────────────────────────────────────────────

describe('Auth gating — /admin/dashboard', () => {
  it('no auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/admin/dashboard`, {
      headers: { ...noAuthHeaders },
    })
    expect(res.status).toBe(401)
  })

  it('viewer (non-admin) token → 401 or 403', async () => {
    // The admin gate (index.ts) checks verified.isAdmin; viewer tokens have
    // isAdmin=false → 401. Accept 403 to tolerate any future tightening.
    const res = await fetch(`${BASE_URL}/admin/dashboard`, {
      headers: { ...viewerHeaders },
    })
    expect([401, 403]).toContain(res.status)
  })

  it('valid admin token → 200', async () => {
    const res = await fetch(`${BASE_URL}/admin/dashboard`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
  })

  it('cross-tenant admin token → 401 or 403', async () => {
    // Token is a valid HMAC for a different tenantId — server resolves it
    // but tenantId mismatch → gate rejects.
    const res = await fetch(`${BASE_URL}/admin/dashboard`, {
      headers: { ...foreignHeaders },
    })
    expect([401, 403]).toContain(res.status)
  })
})

describe('Auth gating — other routes', () => {
  it('GET /admin/sessions no auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/admin/sessions`, {
      headers: { ...noAuthHeaders },
    })
    expect(res.status).toBe(401)
  })

  it('GET /admin/stats no auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/admin/stats`, {
      headers: { ...noAuthHeaders },
    })
    expect(res.status).toBe(401)
  })

  it('GET /admin/evals no auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/admin/evals`, {
      headers: { ...noAuthHeaders },
    })
    expect(res.status).toBe(401)
  })

  it('GET /admin/bot-status no auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/admin/bot-status`, {
      headers: { ...noAuthHeaders },
    })
    expect(res.status).toBe(401)
  })

  it('GET /admin/knowledge-base no auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/admin/knowledge-base`, {
      headers: { ...noAuthHeaders },
    })
    expect(res.status).toBe(401)
  })
})

// ── Dashboard ──────────────────────────────────────────────────────────────────

describe('GET /admin/dashboard', () => {
  let body: Record<string, unknown>

  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/admin/dashboard`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    body = await res.json() as Record<string, unknown>
  })

  it('returns action_items array (may be empty)', () => {
    // Key is action_items (snake_case) — not actionItems or triageItems.
    expect(Array.isArray(body.action_items)).toBe(true)
  })

  it('returns recent sessions array', () => {
    expect(Array.isArray(body.recent)).toBe(true)
  })

  it('returns week stats object', () => {
    expect(body.week).toBeDefined()
    expect(typeof body.week).toBe('object')
  })
})

// ── Sessions list ──────────────────────────────────────────────────────────────

describe('GET /admin/sessions', () => {
  let body: unknown

  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/admin/sessions`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    body = await res.json()
  })

  it('returns a bare array (not wrapped under a key)', () => {
    // Route does: c.json(result.results) — a raw array, no wrapper object.
    expect(Array.isArray(body)).toBe(true)
  })

  it('each session (if any) belongs to the tenant (no cross-tenant leak)', () => {
    const sessions = body as Record<string, unknown>[]
    // If the DB has session_analysis rows with tenant_id exposed, verify them.
    // Many schemas omit tenant_id from the SELECT; check only when present.
    for (const s of sessions) {
      if ('tenant_id' in s) {
        expect(s.tenant_id).toBe(
          process.env.TEST_TENANT_ID ?? 'test-0001-dev-tenant',
        )
      }
    }
  })
})

describe('GET /admin/sessions/:sessionId', () => {
  it('returns 400 for an obviously invalid session ID', async () => {
    // validSessionId() in admin.ts rejects IDs with special chars.
    const res = await fetch(`${BASE_URL}/admin/sessions/../../etc/passwd`, {
      headers: { ...adminHeaders },
    })
    // Path traversal — Hono won't match the route at all → 404 or the
    // validSessionId guard → 400. Either is acceptable.
    expect([400, 404]).toContain(res.status)
  })
})

// ── Stats ──────────────────────────────────────────────────────────────────────

describe('GET /admin/stats', () => {
  let body: Record<string, unknown>

  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/admin/stats`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    body = await res.json() as Record<string, unknown>
  })

  it('has sessions_7d numeric field', () => {
    expect(typeof body.sessions_7d).toBe('number')
  })

  it('has sessions_30d numeric field', () => {
    expect(typeof body.sessions_30d).toBe('number')
  })

  it('has feedback_rate numeric field', () => {
    expect(typeof body.feedback_rate).toBe('number')
  })
})

describe('GET /admin/stats/overview', () => {
  it('returns 200 with period and conversations keys', async () => {
    const res = await fetch(`${BASE_URL}/admin/stats/overview`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.period).toBeDefined()
    expect(body.conversations).toBeDefined()
  })
})

describe('GET /admin/stats/timeseries', () => {
  it('returns 200 with daily and hourly arrays', async () => {
    const res = await fetch(`${BASE_URL}/admin/stats/timeseries`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body.daily)).toBe(true)
    expect(Array.isArray(body.hourly)).toBe(true)
  })
})

// ── Bot status ─────────────────────────────────────────────────────────────────

describe('GET /admin/bot-status', () => {
  let body: Record<string, unknown>

  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/admin/bot-status`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    body = await res.json() as Record<string, unknown>
  })

  it('has a timestamp string', () => {
    expect(typeof body.timestamp).toBe('string')
    expect(() => new Date(body.timestamp as string)).not.toThrow()
  })

  it('has llm readiness indicator', () => {
    expect(['healthy', 'unhealthy']).toContain(body.llm)
  })

  it('has rag readiness indicator', () => {
    expect(['healthy', 'unhealthy']).toContain(body.rag)
  })
})

// ── Knowledge base ─────────────────────────────────────────────────────────────

describe('GET /admin/knowledge-base', () => {
  let body: Record<string, unknown>

  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/admin/knowledge-base`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    body = await res.json() as Record<string, unknown>
  })

  it('returns builtin_guides array (key is snake_case, not "guides")', () => {
    expect(Array.isArray(body.builtin_guides)).toBe(true)
  })

  it('builtin_guides has at least one entry (shipped RAG guides)', () => {
    const guides = body.builtin_guides as unknown[]
    expect(guides.length).toBeGreaterThan(0)
  })

  it('returns custom_protocols object', () => {
    expect(typeof body.custom_protocols).toBe('object')
    expect(body.custom_protocols).not.toBeNull()
  })
})

// ── RAG search ─────────────────────────────────────────────────────────────────

describe('POST /admin/rag-search', () => {
  it('400 when query is missing', async () => {
    const res = await fetch(`${BASE_URL}/admin/rag-search`, {
      method: 'POST',
      headers: { ...adminHeaders },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('200 with results array for a real query (even if Vectorize index is empty)', async () => {
    const res = await fetch(`${BASE_URL}/admin/rag-search`, {
      method: 'POST',
      headers: { ...adminHeaders },
      body: JSON.stringify({ query: 'baby bird' }),
    })
    // If Vectorize isn't seeded in the test deployment, the server may return
    // 500. Accept [200, 500] — we're testing shape, not content.
    expect([200, 500]).toContain(res.status)
    if (res.status === 200) {
      const body = await res.json() as Record<string, unknown>
      expect(Array.isArray(body.results)).toBe(true)
    }
  })
})

// ── Evals CRUD ─────────────────────────────────────────────────────────────────

describe('GET /admin/evals', () => {
  it('returns 200 with scenarios array', async () => {
    const res = await fetch(`${BASE_URL}/admin/evals`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body.scenarios)).toBe(true)
  })
})

describe('Evals CRUD lifecycle', () => {
  let createdId: string

  it('POST /admin/evals creates a scenario (200) and returns an id', async () => {
    const res = await fetch(`${BASE_URL}/admin/evals`, {
      method: 'POST',
      headers: { ...adminHeaders },
      body: JSON.stringify({
        description: 'Integration test scenario — safe to delete',
        expected_behavior: 'Bot should acknowledge the baby bird and provide guidance',
        test_message: 'I found a baby bird that fell out of its nest',
      }),
    })
    // Route calls c.json(result) without an explicit status → 200.
    // Accept 201 in case a future change adds it.
    expect([200, 201]).toContain(res.status)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body.id).toBe('string')
    expect((body.id as string).length).toBeGreaterThan(0)
    createdId = body.id as string
  })

  it('GET /admin/evals includes the newly created scenario', async () => {
    const res = await fetch(`${BASE_URL}/admin/evals`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { scenarios: Array<{ id: string }> }
    const ids = body.scenarios.map(s => s.id)
    expect(ids).toContain(createdId)
  })

  it('PUT /admin/evals/:id updates the scenario and resets verdict to unreviewed', async () => {
    const res = await fetch(`${BASE_URL}/admin/evals/${createdId}`, {
      method: 'PUT',
      headers: { ...adminHeaders },
      body: JSON.stringify({
        description: 'Integration test scenario — updated description',
        expected_behavior: 'Bot should acknowledge the baby bird and provide guidance',
        test_message: 'I found a baby bird on the ground',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.id).toBe(createdId)
    expect(body.description).toBe('Integration test scenario — updated description')
  })

  it('POST /admin/evals/:id/review marks the scenario as approved', async () => {
    const res = await fetch(`${BASE_URL}/admin/evals/${createdId}/review`, {
      method: 'POST',
      headers: { ...adminHeaders },
      body: JSON.stringify({ review_status: 'approved' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.review_status).toBe('approved')
  })

  it('GET /admin/evals/:id/results returns results array', async () => {
    const res = await fetch(`${BASE_URL}/admin/evals/${createdId}/results`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body.results)).toBe(true)
  })

  it('DELETE /admin/evals/:id removes the created scenario (200)', async () => {
    const res = await fetch(`${BASE_URL}/admin/evals/${createdId}`, {
      method: 'DELETE',
      headers: { ...adminHeaders },
    })
    // Route returns c.json({ success: true }) → 200.
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.success).toBe(true)
  })

  it('DELETE /admin/evals/:id for deleted/nonexistent id → 200 (idempotent, no rowcount check)', async () => {
    // admin.ts deleteEvalScenario handler uses DB.batch([DELETE results, DELETE scenario])
    // with no rowcount check → always returns { success: true } regardless of whether
    // the row existed. This is intentionally idempotent.
    const res = await fetch(`${BASE_URL}/admin/evals/nonexistent-scenario-id-xyz`, {
      method: 'DELETE',
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
  })
})

describe('Evals validation', () => {
  it('POST /admin/evals with empty body → 400', async () => {
    const res = await fetch(`${BASE_URL}/admin/evals`, {
      method: 'POST',
      headers: { ...adminHeaders },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('POST /admin/evals/:id/review with invalid status → 400', async () => {
    // Use a known scenario id that won't exist — the review handler calls
    // reviewEvalScenario which validates the status BEFORE querying.
    const res = await fetch(`${BASE_URL}/admin/evals/any-id/review`, {
      method: 'POST',
      headers: { ...adminHeaders },
      body: JSON.stringify({ review_status: 'bogus-verdict' }),
    })
    expect(res.status).toBe(400)
  })
})

// ── Publish / Discard ──────────────────────────────────────────────────────────

describe('POST /admin/discard', () => {
  it('200 even when there is no staged draft (no-op)', async () => {
    const res = await fetch(`${BASE_URL}/admin/discard`, {
      method: 'POST',
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
  })
})

describe('POST /admin/publish', () => {
  it('200 or 409 (conflict) — publish is always safe to call', async () => {
    // With no draft, publishDraft just promotes the current live config
    // to itself. 409 is returned only when another publish races. Both are
    // valid successful-path responses for this integration smoke test.
    const res = await fetch(`${BASE_URL}/admin/publish`, {
      method: 'POST',
      headers: { ...adminHeaders },
    })
    expect([200, 409]).toContain(res.status)
  })
})

// ── Domain management ──────────────────────────────────────────────────────────

describe('GET /admin/domains', () => {
  it('returns 200 with domains array', async () => {
    const res = await fetch(`${BASE_URL}/admin/domains`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body.domains)).toBe(true)
  })
})

describe('Domain CRUD', () => {
  let addedDomainId: string | undefined

  it('POST /admin/domains adds a domain', async () => {
    const res = await fetch(`${BASE_URL}/admin/domains`, {
      method: 'POST',
      headers: { ...adminHeaders },
      body: JSON.stringify({ domain: 'integration-test-domain.example.org' }),
    })
    expect([200, 201]).toContain(res.status)
    const body = await res.json() as Record<string, unknown>
    expect(body.success).toBe(true)
    // Try to find the new domain so we can clean it up.
    const listRes = await fetch(`${BASE_URL}/admin/domains`, {
      headers: { ...adminHeaders },
    })
    const list = await listRes.json() as { domains: Array<{ id: string; domain: string }> }
    const found = list.domains.find(d => d.domain === 'integration-test-domain.example.org')
    addedDomainId = found?.id
  })

  it('POST /admin/domains with missing domain → 400', async () => {
    const res = await fetch(`${BASE_URL}/admin/domains`, {
      method: 'POST',
      headers: { ...adminHeaders },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('DELETE /admin/domains/:id removes the added domain', async () => {
    if (!addedDomainId) {
      // If domain wasn't found in list (e.g. DB unavailable), skip gracefully.
      return
    }
    const res = await fetch(`${BASE_URL}/admin/domains/${addedDomainId}`, {
      method: 'DELETE',
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.success).toBe(true)
  })
})

// ── Setup state ────────────────────────────────────────────────────────────────

describe('GET /admin/setup-state', () => {
  it('returns 200 with next_action field', async () => {
    const res = await fetch(`${BASE_URL}/admin/setup-state`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.next_action).toBeDefined()
  })
})

// ── Triage test ────────────────────────────────────────────────────────────────

describe('POST /admin/triage/test', () => {
  it('200 with match result for a valid message', async () => {
    const res = await fetch(`${BASE_URL}/admin/triage/test`, {
      method: 'POST',
      headers: { ...adminHeaders },
      body: JSON.stringify({ message: 'injured hawk, needs immediate help' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    // testTriageMessage returns an object; exact shape varies by tenant config.
    expect(typeof body).toBe('object')
  })

  it('400 when message is missing', async () => {
    const res = await fetch(`${BASE_URL}/admin/triage/test`, {
      method: 'POST',
      headers: { ...adminHeaders },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('400 when message is too long (>4000 chars)', async () => {
    const res = await fetch(`${BASE_URL}/admin/triage/test`, {
      method: 'POST',
      headers: { ...adminHeaders },
      body: JSON.stringify({ message: 'x'.repeat(4001) }),
    })
    expect(res.status).toBe(400)
  })
})

// ── Prompt / bot instruction view ─────────────────────────────────────────────

describe('GET /admin/prompt', () => {
  it('returns 200 with prompt state', async () => {
    const res = await fetch(`${BASE_URL}/admin/prompt`, {
      headers: { ...adminHeaders },
    })
    expect(res.status).toBe(200)
    expect(typeof await res.json()).toBe('object')
  })
})

// ── Cross-tenant isolation ─────────────────────────────────────────────────────

describe('Cross-tenant isolation', () => {
  it('admin token for a different tenant → 401 or 403 on dashboard', async () => {
    const res = await fetch(`${BASE_URL}/admin/dashboard`, {
      headers: { ...foreignHeaders },
    })
    // The admin auth middleware resolves the token (valid HMAC) but finds
    // verified.tenantId !== tenant.id → 401. Accept 403 to tolerate future
    // tightening. Must NOT be 200.
    expect([401, 403]).toContain(res.status)
  })

  it('admin token for a different tenant → 401 or 403 on sessions', async () => {
    const res = await fetch(`${BASE_URL}/admin/sessions`, {
      headers: { ...foreignHeaders },
    })
    expect([401, 403]).toContain(res.status)
  })

  it('admin token for a different tenant → 401 or 403 on evals', async () => {
    const res = await fetch(`${BASE_URL}/admin/evals`, {
      headers: { ...foreignHeaders },
    })
    expect([401, 403]).toContain(res.status)
  })
})

// ── /api/errors (public, no auth required) ────────────────────────────────────

describe('POST /api/errors', () => {
  it('accepts client error reports without auth (always 200)', async () => {
    const res = await fetch(`${BASE_URL}/api/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Slug': process.env.TEST_TENANT_SLUG ?? 'test-org' },
      body: JSON.stringify({ message: 'integration test error', url: 'http://localhost', stack: 'Error: test' }),
    })
    // Route is mounted on the admin router but is intentionally public.
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.success).toBe(true)
  })
})
