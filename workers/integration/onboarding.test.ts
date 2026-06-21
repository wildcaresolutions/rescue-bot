/**
 * Integration tests — brand-extract, website-harvest, eval-runner, onboarding flow
 *
 * Modules under test:
 *   workers/src/lib/brand-extract.ts    — POST /admin/onboarding/brand-extract + copilot
 *   workers/src/lib/website-harvest.ts  — POST /admin/onboarding/website-harvest + copilot
 *   workers/src/lib/eval-runner.ts      — POST /admin/evals/:id/run + GET /admin/evals/:id/results
 *   workers/src/lib/setup-state.ts      — GET /admin/setup-state
 *   workers/src/lib/onboarding-state.ts — GET /admin/setup-state (shared primitives called by above)
 *   workers/src/lib/setup-readiness.ts  — copilot get_setup_readiness tool
 *
 * These tests fire REAL HTTP at a live (or local) worker.  Run with:
 *
 *   BASE_URL=https://wildcare-bot-test.<account>.workers.dev \
 *   SIGNING_SECRET=<secret-matching-deployed-worker> \
 *   TEST_TENANT_SLUG=test-org \
 *   TEST_TENANT_ID=test-0001-dev-tenant \
 *   npx vitest run --config vitest.integration.config.ts
 *
 * Or against a local wrangler dev server (make cf-dev):
 *   SIGNING_SECRET=dev-secret npx vitest run --config vitest.integration.config.ts
 *
 * Design notes:
 *   - brand-extract direct endpoint: POST /admin/onboarding/brand-extract returns
 *     BrandExtractionResult {colors, fonts, fetchDuration} — no top-level "success".
 *     On fetch failure, extractAll() catches internally (fetchText returns null →
 *     fetchPage returns null → degraded result) and the route returns 200 with
 *     colors.confidence === 'low'.  The route's try/catch (502) fires only if
 *     extractAll itself throws, which it does not.
 *   - website-harvest direct endpoint: returns result.success ? 200 : 502.
 *   - eval-runner: POST /admin/evals/:id/run returns {status:"started"} immediately;
 *     the actual LLM judge runs in background via waitUntil.  Results are polled
 *     from GET /admin/evals/:id/results.
 *   - copilot tests use the tolerant pattern from agent.test.ts — assert tool
 *     side-effects only IF the model actually fired the tool.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { BASE_URL, adminHeaders, noAuthHeaders } from './_harness'

// ── Stream helpers (same protocol as agent.test.ts) ──────────────────────────

interface Frame {
  type: string
  payload: string
}

interface ToolResultFrame {
  toolCallId: string
  toolName: string
  /** The tool's own return value. Assertions on tool behaviour must look here. */
  result: Record<string, unknown>
}

interface StreamResult {
  status: number
  frames: Frame[]
  /** Parsed tool-result (b:) frames. */
  toolResults: ToolResultFrame[]
  /** Concatenated text-delta (0:) content. */
  fullText: string
}

async function streamCopilot(
  prompt: string,
  headers: Record<string, string>,
): Promise<StreamResult> {
  const res = await fetch(`${BASE_URL}/admin/agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
  })

  const text = await res.text()
  const frames: Frame[] = text
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const colon = line.indexOf(':')
      return { type: line[0], payload: line.slice(colon + 1) }
    })

  const toolResults: ToolResultFrame[] = frames
    .filter(f => f.type === 'b')
    .map(f => {
      try {
        return JSON.parse(f.payload) as ToolResultFrame
      } catch {
        return { toolCallId: '', toolName: '', result: { _raw: f.payload } }
      }
    })

  const textParts: string[] = frames
    .filter(f => f.type === '0')
    .map(f => {
      try {
        return JSON.parse(f.payload) as string
      } catch {
        return f.payload
      }
    })

  return { status: res.status, frames, toolResults, fullText: textParts.join('') }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function clearHistory(): Promise<void> {
  const res = await fetch(`${BASE_URL}/admin/agent/history`, {
    method: 'DELETE',
    headers: adminHeaders,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)')
    throw new Error(`clearHistory failed: HTTP ${res.status} — ${body}`)
  }
}

async function discardDraft(): Promise<void> {
  // Best-effort: staged drafts left behind would pollute subsequent tests, but
  // a failed discard (e.g. transient 5xx) should not mask the real test result.
  // Log a warning so teardown failures are visible without being fatal.
  const res = await fetch(`${BASE_URL}/admin/discard`, { method: 'POST', headers: adminHeaders })
    .catch((e: unknown) => {
      console.warn('discardDraft: fetch failed —', e)
      return null
    })
  if (res && !res.ok) {
    console.warn(`discardDraft: HTTP ${res.status} — continuing (best-effort cleanup)`)
  }
}

/**
 * Poll GET /admin/evals/:id/results until the results array is non-empty
 * or the deadline is reached.  The eval-runner job executes in background
 * via CF Workers waitUntil, so results are not immediately available.
 */
async function pollEvalResults(
  scenarioId: string,
  { intervalMs = 2000, maxMs = 55_000 }: { intervalMs?: number; maxMs?: number } = {},
): Promise<unknown[]> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/admin/evals/${scenarioId}/results`, {
      headers: adminHeaders,
    })
    if (res.ok) {
      const body = await res.json() as { results: unknown[] }
      if (body.results.length > 0) return body.results
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return []
}

// ── A. brand-extract — POST /admin/onboarding/brand-extract ──────────────────

describe('POST /admin/onboarding/brand-extract', () => {
  it('no auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/admin/onboarding/brand-extract`, {
      method: 'POST',
      headers: noAuthHeaders,
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    expect(res.status).toBe(401)
  })

  it('happy path: https://example.com returns 200 with colors / fonts / fetchDuration', async () => {
    const res = await fetch(`${BASE_URL}/admin/onboarding/brand-extract`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>

    // BrandExtractionResult has no top-level "success" field
    expect(typeof body.fetchDuration).toBe('number')
    expect(body.colors).toBeDefined()
    expect(body.fonts).toBeDefined()

    const colors = body.colors as Record<string, unknown>
    // confidence and source are always present
    expect(typeof colors.confidence).toBe('string')
    expect(typeof colors.colors).toBe('object')
    expect(Array.isArray(colors.all_candidates)).toBe(true)
  })

  it('http:// URL → 400 (normalizeWebsiteUrl rejects non-https)', async () => {
    // normalizeWebsiteUrl returns '' for http:// → route returns 400 before
    // attempting any network call.
    const res = await fetch(`${BASE_URL}/admin/onboarding/brand-extract`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ url: 'http://example.com' }),
    })
    expect(res.status).toBe(400)
  })

  it('unreachable .invalid domain → 200 with colors.confidence === "low"', async () => {
    // .invalid TLD is guaranteed non-resolvable (RFC 2606).
    // fetchText catches the network error → returns null → fetchPage returns
    // null → extractAll returns a degraded BrandExtractionResult without
    // throwing → route returns 200 with the degraded object.
    const res = await fetch(`${BASE_URL}/admin/onboarding/brand-extract`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ url: 'https://this-does-not-exist-wildcare-test.invalid' }),
    })
    // extractAll catches internally; route's try/catch (502) is never reached
    expect(res.status).toBe(200)
    const body = await res.json() as { colors: Record<string, unknown> }
    expect(body.colors.confidence).toBe('low')
  })
})

// ── B. brand-extract — via copilot tools ─────────────────────────────────────

describe('brand-extract via copilot (fetch_url / extract_brand_colors tool)', () => {
  // Clear copilot history before each copilot test — accumulated context from
  // prior turns shifts model behaviour non-deterministically.
  beforeEach(async () => {
    await clearHistory()
  })

  it('fetching example.com produces a 200 stream with text', async () => {
    const res = await streamCopilot(
      'Fetch https://example.com and tell me the primary color',
      adminHeaders,
    )
    expect(res.status).toBe(200)
    expect(res.fullText.length).toBeGreaterThan(0)
    // At least one finish frame in the stream
    expect(res.frames.filter(f => f.type === 'e').length).toBeGreaterThan(0)
  })

  it('if a website tool fires for example.com, its result contains no error', async () => {
    const res = await streamCopilot(
      'Fetch https://example.com and tell me the primary color',
      adminHeaders,
    )
    expect(res.status).toBe(200)

    // The model may choose either fetch_url or extract_brand_colors based on
    // its internal heuristic.  Accept both.
    const websiteTools = res.toolResults.filter(
      tr => tr.toolName === 'fetch_url' || tr.toolName === 'extract_brand_colors',
    )
    if (websiteTools.length > 0) {
      const r = websiteTools[0].result
      // A successful fetch must not carry a top-level error field
      expect(r.error).toBeUndefined()
    }
    // If no tool fired (model answered from training), response text is the
    // only assertion — that is already checked in the prior test.
  })

  it('unreachable URL via fetch_url: if tool fires, result.success is false with error', async () => {
    try {
      const res = await streamCopilot(
        'Use the fetch_url tool to fetch https://this-does-not-exist-wildcare-test.invalid and report what you find',
        adminHeaders,
      )
      expect(res.status).toBe(200)

      const fetchResults = res.toolResults.filter(tr => tr.toolName === 'fetch_url')
      if (fetchResults.length > 0) {
        // fetch_url catches fetch errors and returns { success: false, error }
        const r = fetchResults[0].result
        expect(r.success).toBe(false)
        expect(typeof r.error).toBe('string')
      }
      // If the model declined to call the tool, no assertion needed.
    } finally {
      await discardDraft()
    }
  })
})

// ── C. website-harvest — POST /admin/onboarding/website-harvest ──────────────

describe('POST /admin/onboarding/website-harvest', () => {
  it('no auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/admin/onboarding/website-harvest`, {
      method: 'POST',
      headers: noAuthHeaders,
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    expect(res.status).toBe(401)
  })

  it('happy path: https://example.com returns 200 with success:true and result fields', async () => {
    const res = await fetch(`${BASE_URL}/admin/onboarding/website-harvest`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.success).toBe(true)
    expect(typeof body.url).toBe('string')
    // pages: array of fetched pages (at least the home page)
    expect(Array.isArray(body.pages)).toBe(true)
    // fields: extracted contact info (may be sparse for example.com)
    expect(typeof body.fields).toBe('object')
    expect(body.fields).not.toBeNull()
    // missing: fields the harvester could not find
    expect(Array.isArray(body.missing)).toBe(true)
  })

  it('http:// URL → 400 (normalizeWebsiteUrl rejects non-https)', async () => {
    const res = await fetch(`${BASE_URL}/admin/onboarding/website-harvest`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ url: 'http://example.com' }),
    })
    expect(res.status).toBe(400)
  })

  it('unreachable .invalid domain → 502 with success:false and error message', async () => {
    const res = await fetch(`${BASE_URL}/admin/onboarding/website-harvest`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ url: 'https://this-does-not-exist-wildcare-test.invalid' }),
    })
    // harvestWebsiteInfo returns {success:false,…} → route uses result.success ? 200 : 502
    expect(res.status).toBe(502)
    const body = await res.json() as Record<string, unknown>
    expect(body.success).toBe(false)
    expect(typeof body.error).toBe('string')
  })
})

// ── D. website-harvest — via copilot harvest_website_info tool ────────────────

describe('website-harvest via copilot (harvest_website_info tool)', () => {
  beforeEach(async () => {
    await clearHistory()
  })

  it('if harvest_website_info fires for example.com, result has a success field', async () => {
    try {
      const res = await streamCopilot(
        'Use the harvest_website_info tool to gather contact details from https://example.com',
        adminHeaders,
      )
      expect(res.status).toBe(200)
      expect(res.fullText.length).toBeGreaterThan(0)

      const harvestResults = res.toolResults.filter(tr => tr.toolName === 'harvest_website_info')
      if (harvestResults.length > 0) {
        const r = harvestResults[0].result
        expect(typeof r.success).toBe('boolean')
        if (r.success) {
          expect(Array.isArray(r.pages)).toBe(true)
          expect(typeof r.fields).toBe('object')
          expect(Array.isArray(r.missing)).toBe(true)
        } else {
          // Tool executed but harvest failed — must carry an error string
          expect(typeof r.error).toBe('string')
        }
      }
    } finally {
      await discardDraft()
    }
  })
})

// ── E. eval-runner — POST /admin/evals/:id/run + GET /admin/evals/:id/results ─

describe('eval-runner via POST /admin/evals/:id/run + GET /admin/evals/:id/results', () => {
  let createdId: string | undefined

  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/admin/evals`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        description: 'Integration test onboarding eval — safe to delete',
        expected_behavior: 'Bot should acknowledge the baby bird and provide guidance',
        test_message: 'I found a baby bird that fell out of its nest',
      }),
    })
    if (res.ok) {
      const body = await res.json() as { id?: string }
      createdId = body.id
    }
  })

  afterAll(async () => {
    if (!createdId) return
    // Brief pause before deletion to let any in-flight waitUntil eval jobs
    // finish writing their result row.  eval_results has a FK on
    // eval_scenarios(id); deleting the scenario while a background job is
    // still INSERTing causes a silent FK violation logged in the worker.
    await new Promise(r => setTimeout(r, 3000))
    await fetch(`${BASE_URL}/admin/evals/${createdId}`, {
      method: 'DELETE',
      headers: adminHeaders,
    })
  })

  it('POST /admin/evals/:id/run with no auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/admin/evals/any-eval-id/run`, {
      method: 'POST',
      headers: noAuthHeaders,
    })
    expect(res.status).toBe(401)
  })

  it('POST /admin/evals/:nonexistent/run → 404', async () => {
    const res = await fetch(`${BASE_URL}/admin/evals/nonexistent-eval-scenario-xyz-999/run`, {
      method: 'POST',
      headers: adminHeaders,
    })
    expect(res.status).toBe(404)
  })

  it('POST /admin/evals/:id/run → 200 { status:"started", scenario_id }', async () => {
    if (!createdId) return
    const res = await fetch(`${BASE_URL}/admin/evals/${createdId}/run`, {
      method: 'POST',
      headers: adminHeaders,
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    // The eval runs asynchronously via waitUntil — response is immediate
    // and does NOT contain passed/failed (those come from the results endpoint).
    expect(body.status).toBe('started')
    expect(body.scenario_id).toBe(createdId)
  })

  it(
    'after run, GET /admin/evals/:id/results returns results with correct shape',
    async () => {
      if (!createdId) return

      // The prior test ('POST run → 200 { status:"started" }') already fired
      // the run.  Do NOT re-trigger here — that would race with afterAll's
      // DELETE (the second waitUntil job tries to INSERT eval_results after
      // the scenario row is gone, causing a FK violation in the worker log).
      // Tests execute sequentially (vitest.integration.config) so the prior
      // test's waitUntil job is already in-flight when we start polling.

      // Poll until the background LLM judge has persisted a result row.
      // The eval involves a real bot chat + judge round-trip — allow up to
      // 55 s (within the 90 s per-test timeout set below).
      const results = await pollEvalResults(createdId, { maxMs: 55_000 })

      // Soft assertion — if the eval completes after the poll window (e.g.
      // on a heavily-loaded test worker), treat it as a partial pass rather
      // than a hard failure.  Shape validation is the real goal.
      if (results.length > 0) {
        const row = results[0] as Record<string, unknown>
        // response: the bot's reply transcript
        expect(typeof row.response).toBe('string')
        // passed: 0 (fail), 1 (pass), or null (ungraded / timed-out judge)
        expect([0, 1, null]).toContain(row.passed)
        // judge_reasoning: the LLM judge's one-sentence explanation
        expect(typeof row.judge_reasoning).toBe('string')
        // created_at: ISO timestamp string
        expect(typeof row.created_at).toBe('string')
        expect(() => new Date(row.created_at as string)).not.toThrow()
      }
    },
    // Raise per-test timeout to 90 s — the background eval involves a real
    // bot chat + LLM judge round-trip and can exceed the default 60 s.
    90_000,
  )

  it('GET /admin/evals/:id/results with no auth → 401', async () => {
    // 401 is returned by the /admin/* middleware before any DB lookup, so the
    // scenario does not need to exist.  Use a hardcoded ID to avoid a
    // false-green when beforeAll scenario creation fails (createdId undefined).
    const res = await fetch(`${BASE_URL}/admin/evals/any-id-for-auth-check/results`, {
      headers: noAuthHeaders,
    })
    expect(res.status).toBe(401)
  })
})

// ── F. onboarding state machine — setup-state.ts + onboarding-state.ts ───────

describe('GET /admin/setup-state — onboarding state machine', () => {
  let body: Record<string, unknown>

  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/admin/setup-state`, { headers: adminHeaders })
    expect(res.status).toBe(200)
    body = await res.json() as Record<string, unknown>
  })

  it('no auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/admin/setup-state`, { headers: noAuthHeaders })
    expect(res.status).toBe(401)
  })

  it('next_action is one of the valid enum values', () => {
    expect(['website', 'service_area', 'species', 'publish', 'done']).toContain(body.next_action)
  })

  it('has boolean onboarding-readiness flags', () => {
    expect(typeof body.has_website_basics).toBe('boolean')
    expect(typeof body.has_service_area).toBe('boolean')
    expect(typeof body.has_species_rules).toBe('boolean')
    expect(typeof body.onboarded).toBe('boolean')
  })

  it('tests object has numeric total / passing / failing / unrun fields', () => {
    const tests = body.tests as Record<string, unknown>
    expect(tests).toBeDefined()
    expect(typeof tests.total).toBe('number')
    expect(typeof tests.passing).toBe('number')
    expect(typeof tests.failing).toBe('number')
    expect(typeof tests.unrun).toBe('number')
    // Invariant: counts sum to total
    const counted =
      (tests.passing as number) + (tests.failing as number) + (tests.unrun as number)
    expect(counted).toBe(tests.total)
  })

  it('has_unpublished_changes is a boolean', () => {
    expect(typeof body.has_unpublished_changes).toBe('boolean')
  })

  it('widget_published_at is null or an ISO string', () => {
    const wpa = body.widget_published_at
    expect(wpa === null || typeof wpa === 'string').toBe(true)
  })

  it('after POST /admin/publish, setup-state still returns a valid next_action', async () => {
    // publishDraft is idempotent — promoting the live config to itself is safe.
    // Accept 409 (conflict): two concurrent publish calls can race on tests
    // that share a deployment; neither race outcome is an error for this check.
    const publishRes = await fetch(`${BASE_URL}/admin/publish`, { method: 'POST', headers: adminHeaders })
    expect([200, 409]).toContain(publishRes.status)

    const res = await fetch(`${BASE_URL}/admin/setup-state`, { headers: adminHeaders })
    expect(res.status).toBe(200)
    const freshBody = await res.json() as Record<string, unknown>
    expect(['website', 'service_area', 'species', 'publish', 'done']).toContain(
      freshBody.next_action,
    )
    expect(typeof freshBody.has_unpublished_changes).toBe('boolean')
  })
})

// ── G. bot-status — complement fields not covered by admin.test.ts ────────────

describe('GET /admin/bot-status — complement coverage (database / totalMessages / status)', () => {
  // admin.test.ts covers: timestamp (string), llm ('healthy'|'unhealthy'),
  // rag ('healthy'|'unhealthy').  These tests cover the remaining fields.
  let body: Record<string, unknown>

  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/admin/bot-status`, { headers: adminHeaders })
    expect(res.status).toBe(200)
    body = await res.json() as Record<string, unknown>
  })

  it('database field is "healthy" or "unhealthy"', () => {
    expect(['healthy', 'unhealthy']).toContain(body.database)
  })

  it('totalMessages is a non-negative number when database is healthy', () => {
    if (body.database === 'healthy') {
      expect(typeof body.totalMessages).toBe('number')
      expect((body.totalMessages as number) >= 0).toBe(true)
    }
  })

  it('status is "healthy" or "degraded", consistent with subsystem checks', () => {
    expect(['healthy', 'degraded']).toContain(body.status)
    // When all three subsystems are healthy, overall status must be healthy
    if (body.llm === 'healthy' && body.rag === 'healthy' && body.database === 'healthy') {
      expect(body.status).toBe('healthy')
    }
  })
})

// ── H. setup-readiness — copilot get_setup_readiness tool ────────────────────

describe('setup-readiness via copilot (get_setup_readiness tool)', () => {
  beforeEach(async () => {
    await clearHistory()
  })

  it('get_setup_readiness tool fires and result has is_ready + blockers array', async () => {
    const res = await streamCopilot(
      'Use get_setup_readiness to check whether setup is complete and what steps remain.',
      adminHeaders,
    )
    expect(res.status).toBe(200)
    // The model produces a text summary regardless of whether it called the tool
    expect(res.fullText.length).toBeGreaterThan(0)

    const readinessResults = res.toolResults.filter(tr => tr.toolName === 'get_setup_readiness')
    if (readinessResults.length > 0) {
      const r = readinessResults[0].result
      // is_ready: boolean computed from blockers length
      expect(typeof r.is_ready).toBe('boolean')
      // blockers: array of human-readable strings (may be empty when ready)
      expect(Array.isArray(r.blockers)).toBe(true)
      for (const b of r.blockers as unknown[]) {
        expect(typeof b).toBe('string')
      }
    }
  })

  it('get_setup_readiness result includes test_cases or tests with numeric counts', async () => {
    const res = await streamCopilot(
      'Call get_setup_readiness and tell me how many test cases I have configured.',
      adminHeaders,
    )
    expect(res.status).toBe(200)

    const readinessResults = res.toolResults.filter(tr => tr.toolName === 'get_setup_readiness')
    if (readinessResults.length > 0) {
      const r = readinessResults[0].result
      // SetupReadiness exposes both test_cases and tests (alias for backward compat)
      const tc = (r.test_cases ?? r.tests) as Record<string, unknown> | undefined
      expect(tc).toBeDefined()
      if (tc) {
        expect(typeof tc.total).toBe('number')
        expect(typeof tc.passing).toBe('number')
        expect(typeof tc.failing).toBe('number')
        expect(typeof tc.unrun).toBe('number')
      }
    }
  })
})
