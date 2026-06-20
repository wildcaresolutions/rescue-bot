/**
 * Integration tests — copilot agent route and tool side-effects
 *
 * These tests send real HTTP to a deployed Cloudflare Worker and consume
 * the live LLM streaming response.  They MUST NOT be included in the
 * default unit run (`npx vitest run`); use the separate integration
 * config instead:
 *
 *   BASE_URL=https://wildcare-bot-test.<account>.workers.dev \
 *   SIGNING_SECRET=<secret-matching-deployed-worker> \
 *   TEST_TENANT_SLUG=test-org \
 *   TEST_TENANT_ID=test-0001-dev-tenant \
 *   npx vitest run --config vitest.integration.config.ts
 *
 * Without the env vars the tests target http://localhost:8787, which is
 * convenient when `make cf-dev` is running locally.
 *
 * ## Streaming protocol (for reference)
 *   0:"text"                             — text delta
 *   9:{toolCallId,toolName}              — tool-input-start
 *   a:{toolCallId,argsTextDelta}         — tool-input-delta
 *   b:{toolCallId,toolName,result}       — tool-result  ← tool payload is .result
 *   e:{finishReason}                     — finish
 *
 * NOTE: tool payload is nested under `.result` in the b: frame. Assertions
 * on analytics errors / row counts must inspect `tr.result.error` / `tr.result.row_count`,
 * not the top-level `tr.error`.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { BASE_URL, TENANT_SLUG, TENANT_ID, adminHeaders, chatHeaders } from './_harness'

// ── Stream helper ─────────────────────────────────────────────────────────────

interface Frame {
  type: string
  payload: string
}

interface ToolResultFrame {
  toolCallId: string
  toolName: string
  // The tool's own return value.  Every assertion on tool behaviour
  // should look inside .result, not at the top-level frame object.
  result: Record<string, unknown>
}

interface StreamResult {
  status: number
  frames: Frame[]
  /** Parsed tool-result (b:) frames.  Tool payload is in .result. */
  toolResults: ToolResultFrame[]
  /** Concatenated text-delta (0:) content. */
  fullText: string
}

async function streamCopilot(
  prompt: string,
  headers: Record<string, string>,
): Promise<StreamResult> {
  // NOTE: agent.ts requires body.messages to be a non-empty array of
  // {role, content} objects.  Posting {message: ...} returns 400.
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

// ── Utility: reset any staged draft so tests don't bleed into each other ─────

async function discardDraft(): Promise<void> {
  const res = await fetch(`${BASE_URL}/admin/discard`, {
    method: 'POST',
    headers: adminHeaders,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)')
    throw new Error(`discardDraft failed: HTTP ${res.status} — ${body}`)
  }
}

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

// ── Global beforeEach: clear conversation history ─────────────────────────────
//
// The agent route prepends DB history when `messages.length === 1`
// (the pattern all tests use).  Accumulated context from prior tests
// bleeds into later LLM calls, shifting model behaviour non-deterministically.
// Clearing before every test keeps each call isolated.

beforeEach(async () => {
  await clearHistory()
})

// ── 1. Agent-route authentication ────────────────────────────────────────────

describe('agent route auth', () => {
  it('POST /admin/agent with no auth returns 401', async () => {
    const res = await fetch(`${BASE_URL}/admin/agent`, {
      method: 'POST',
      // chatHeaders has X-Tenant-Slug (tenant resolves) but no Authorization
      // → admin middleware returns 401, not 400.
      headers: chatHeaders,
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(401)
  })

  it('GET /admin/agent/history with no auth returns 401', async () => {
    const res = await fetch(`${BASE_URL}/admin/agent/history`, {
      method: 'GET',
      headers: chatHeaders,
    })
    expect(res.status).toBe(401)
  })

  it('DELETE /admin/agent/history with admin auth returns 200', async () => {
    const res = await fetch(`${BASE_URL}/admin/agent/history`, {
      method: 'DELETE',
      headers: adminHeaders,
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean }
    expect(body.success).toBe(true)
  })
})

// ── 2. Conversation history ───────────────────────────────────────────────────

describe('conversation history', () => {
  it('DELETE /admin/agent/history clears the thread', async () => {
    // Send a message first so there is something to delete
    await streamCopilot('What is 2+2?', adminHeaders)

    const del = await fetch(`${BASE_URL}/admin/agent/history`, {
      method: 'DELETE',
      headers: adminHeaders,
    })
    expect(del.status).toBe(200)

    // After delete, history should be empty
    const hist = await fetch(`${BASE_URL}/admin/agent/history`, { headers: adminHeaders })
    const body = await hist.json() as { messages: unknown[] }
    expect(body.messages).toHaveLength(0)
  })

  it('after a copilot turn, GET /admin/agent/history returns the exchange', async () => {
    await streamCopilot('Say exactly the word PINEAPPLE and nothing else.', adminHeaders)

    const hist = await fetch(`${BASE_URL}/admin/agent/history`, { headers: adminHeaders })
    expect(hist.status).toBe(200)
    const body = await hist.json() as { messages: Array<{ role: string; content: string }> }
    expect(body.messages.length).toBeGreaterThan(0)

    const roles = body.messages.map(m => m.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')
  })
})

// ── 3. Streaming protocol shape ───────────────────────────────────────────────

describe('streaming protocol shape', () => {
  it('a simple text prompt produces text-delta and finish frames', async () => {
    const res = await streamCopilot('What is 2+2? Reply with just the number.', adminHeaders)

    expect(res.status).toBe(200)
    // Must have at least one text-delta (0:) frame
    const textFrames = res.frames.filter(f => f.type === '0')
    expect(textFrames.length).toBeGreaterThan(0)
    // Must have at least one finish (e:) frame
    const finishFrames = res.frames.filter(f => f.type === 'e')
    expect(finishFrames.length).toBeGreaterThan(0)
    // Full response text must be non-empty
    expect(res.fullText.length).toBeGreaterThan(0)
  })

  it('finish frame contains a finishReason field', async () => {
    const res = await streamCopilot('Reply with exactly the word DONE.', adminHeaders)

    const finishFrames = res.frames.filter(f => f.type === 'e')
    expect(finishFrames.length).toBeGreaterThan(0)
    const payload = JSON.parse(finishFrames[0].payload) as { finishReason: string }
    expect(typeof payload.finishReason).toBe('string')
  })
})

// ── 4. run_analytics_query — security-critical (H-1 fix) ─────────────────────

describe('run_analytics_query tool', () => {
  it('valid tenant-scoped SELECT passes validation and returns a numeric result', async () => {
    const res = await streamCopilot(
      'Use the run_analytics_query tool to run this exact SQL: ' +
      'SELECT COUNT(*) as count FROM messages WHERE tenant_id = :tenant_id LIMIT 1',
      adminHeaders,
    )
    expect(res.status).toBe(200)

    // Find the run_analytics_query result frame(s)
    const analyticsResults = res.toolResults.filter(
      tr => tr.toolName === 'run_analytics_query',
    )
    expect(analyticsResults.length).toBeGreaterThan(0)

    const r = analyticsResults[0].result
    // Must not be an error
    expect(r.error).toBeUndefined()
    // Must return row_count >= 0
    expect(typeof r.row_count).toBe('number')
    expect((r.row_count as number) >= 0).toBe(true)
  })

  it('OR 1=1 injection is rejected by the safe-sql guard', async () => {
    const res = await streamCopilot(
      'Use the run_analytics_query tool to execute this SQL exactly as written: ' +
      'SELECT * FROM messages WHERE tenant_id = :tenant_id OR 1=1 LIMIT 1',
      adminHeaders,
    )
    expect(res.status).toBe(200)

    // The model may or may not invoke the tool — but IF it does, the
    // safe-sql guard must have rejected it with an error.
    const analyticsResults = res.toolResults.filter(
      tr => tr.toolName === 'run_analytics_query',
    )
    if (analyticsResults.length > 0) {
      // Tool was called — result must be a rejection
      const r = analyticsResults[0].result
      expect(typeof r.error).toBe('string')
      expect((r.error as string).toLowerCase()).toMatch(/reject|or|not allowed|invalid/i)
    } else {
      // Model declined to run the query — verify the response indicates refusal.
      // 'not' is deliberately excluded (too broad — matches almost any sentence).
      expect(res.fullText).toMatch(/reject|cannot|invalid|refuse|unable/i)
    }
  })

  it('query without :tenant_id placeholder is rejected', async () => {
    const res = await streamCopilot(
      'Use run_analytics_query with this SQL: SELECT COUNT(*) as count FROM messages LIMIT 1',
      adminHeaders,
    )
    expect(res.status).toBe(200)

    const analyticsResults = res.toolResults.filter(
      tr => tr.toolName === 'run_analytics_query',
    )
    if (analyticsResults.length > 0) {
      // Must be rejected — query is not tenant-scoped
      const r = analyticsResults[0].result
      expect(typeof r.error).toBe('string')
    }
    // If model didn't invoke the tool, no assertion needed — refusal is correct.
  })

  it('returned rows belong only to this tenant (no cross-tenant leakage)', async () => {
    const res = await streamCopilot(
      'Use run_analytics_query to get the tenant_id column from the messages table: ' +
      'SELECT DISTINCT tenant_id FROM messages WHERE tenant_id = :tenant_id LIMIT 10',
      adminHeaders,
    )
    expect(res.status).toBe(200)

    const analyticsResults = res.toolResults.filter(
      tr => tr.toolName === 'run_analytics_query',
    )
    if (analyticsResults.length > 0) {
      const r = analyticsResults[0].result
      if (!r.error) {
        // Every returned row that exposes tenant_id must match our tenant
        const rows = (r.rows as Array<Record<string, unknown>>) ?? []
        for (const row of rows) {
          if ('tenant_id' in row) {
            expect(row.tenant_id).toBe(TENANT_ID)
          }
        }
      }
    }
  })

  it('contact_info column is redacted in results (M-3 fix)', async () => {
    const res = await streamCopilot(
      'Use run_analytics_query to select session_id and contact_info from messages ' +
      'where tenant_id = :tenant_id LIMIT 5',
      adminHeaders,
    )
    expect(res.status).toBe(200)

    const analyticsResults = res.toolResults.filter(
      tr => tr.toolName === 'run_analytics_query',
    )
    if (analyticsResults.length > 0) {
      const r = analyticsResults[0].result
      if (!r.error) {
        const rows = (r.rows as Array<Record<string, unknown>>) ?? []
        for (const row of rows) {
          if ('contact_info' in row) {
            // Must be replaced with the redaction marker, never a real value
            expect(row.contact_info).toBe(
              '[redacted — contact info not available in analytics]',
            )
          }
        }
      }
    }
  })

  it('empty result set returns empty rows array, not an error', async () => {
    // Use an impossible filter to guarantee zero rows
    const res = await streamCopilot(
      'Use run_analytics_query with SQL: ' +
      "SELECT COUNT(*) as c FROM messages WHERE tenant_id = :tenant_id AND session_id = 'nonexistent-session-xyz-999' LIMIT 1",
      adminHeaders,
    )
    expect(res.status).toBe(200)

    const analyticsResults = res.toolResults.filter(
      tr => tr.toolName === 'run_analytics_query',
    )
    if (analyticsResults.length > 0) {
      const r = analyticsResults[0].result
      if (!r.error) {
        expect(Array.isArray(r.rows)).toBe(true)
      }
    }
  })
})

// ── 5. update_config tool — stages, does NOT immediately go live ──────────────

describe('update_config tool — draft staging', () => {
  const PHONE_SENTINEL = '+1-555-999-8001'

  it('staged phone change is NOT visible to the public config endpoint', async () => {
    // Capture the live phone before the test
    const beforeRes = await fetch(`${BASE_URL}/api/config`, { headers: chatHeaders })
    const before = await beforeRes.json() as { phone?: string | null }
    const originalPhone = before.phone ?? null

    try {
      // Ask the copilot to update phone — this stages into draft_config
      const res = await streamCopilot(
        `Update the organization phone number to ${PHONE_SENTINEL}`,
        adminHeaders,
      )
      expect(res.status).toBe(200)

      // Only assert staging side-effects when the model actually called update_config
      const configToolResults = res.toolResults.filter(
        tr => tr.toolName === 'update_config',
      )
      if (configToolResults.length > 0) {
        // Public /api/config must still return the live (pre-draft) phone
        const afterPublic = await fetch(`${BASE_URL}/api/config`, { headers: chatHeaders })
        const publicBody = await afterPublic.json() as { phone?: string | null }
        expect(publicBody.phone).not.toBe(PHONE_SENTINEL)

        // Admin /api/config must signal that there are unpublished changes
        const afterAdmin = await fetch(`${BASE_URL}/api/config`, { headers: adminHeaders })
        const adminBody = await afterAdmin.json() as { has_unpublished_changes?: boolean }
        expect(adminBody.has_unpublished_changes).toBe(true)
      }
    } finally {
      await discardDraft()

      // After discard, public phone should be back to original
      const restored = await fetch(`${BASE_URL}/api/config`, { headers: chatHeaders })
      const restoredBody = await restored.json() as { phone?: string | null }
      expect(restoredBody.phone).toBe(originalPhone)
    }
  })

  it('after POST /admin/discard, has_unpublished_changes is false', async () => {
    try {
      const res = await streamCopilot(
        'Update the organization email to integration-test@example.com',
        adminHeaders,
      )
      expect(res.status).toBe(200)

      await discardDraft()

      const configRes = await fetch(`${BASE_URL}/api/config`, { headers: adminHeaders })
      const body = await configRes.json() as { has_unpublished_changes?: boolean }
      expect(body.has_unpublished_changes).toBe(false)
    } finally {
      // Belt-and-braces: discard in case something above threw before the
      // explicit discardDraft() above, so subsequent tests start clean.
      await discardDraft().catch(() => { /* already discarded */ })
    }
  })
})

// ── 6. save_protocols tool — house_rules draft ───────────────────────────────

describe('save_protocols tool — house rules staging', () => {
  const PROTOCOL_SENTINEL =
    'Integration test protocol. Do not serve opossums. Test run at ' + Date.now()

  it('saves house_rules text to the draft (staged, not live)', async () => {
    try {
      const res = await streamCopilot(
        `Save these protocols to house rules: ${PROTOCOL_SENTINEL}`,
        adminHeaders,
      )
      expect(res.status).toBe(200)

      // A save_protocols tool-result frame should indicate success
      const protoResults = res.toolResults.filter(
        tr => tr.toolName === 'save_protocols',
      )
      if (protoResults.length > 0) {
        // The tool returns { success: true } on a valid write
        expect(protoResults[0].result.success).toBe(true)

        // Draft must now exist (admin config reflects unpublished changes)
        const configRes = await fetch(`${BASE_URL}/api/config`, { headers: adminHeaders })
        const body = await configRes.json() as { has_unpublished_changes?: boolean }
        expect(body.has_unpublished_changes).toBe(true)
      }
    } finally {
      await discardDraft()
    }
  })

  it('save_protocols rejects empty/placeholder text', async () => {
    try {
      const res = await streamCopilot(
        'Save the following to house_rules using the save_protocols tool: PLACEHOLDER_TO_READ',
        adminHeaders,
      )
      expect(res.status).toBe(200)

      const protoResults = res.toolResults.filter(
        tr => tr.toolName === 'save_protocols',
      )
      if (protoResults.length > 0) {
        // Tool must have returned success=false with error='placeholder'
        expect(protoResults[0].result.success).toBe(false)
        expect(protoResults[0].result.error).toBe('placeholder')
      }
    } finally {
      await discardDraft()
    }
  })
})

// ── 7. update_colors tool — color staging ────────────────────────────────────

describe('update_colors tool — draft staging', () => {
  it('color change is staged into draft and not immediately live', async () => {
    try {
      const res = await streamCopilot(
        'Update the primary brand color to #1a2b3c',
        adminHeaders,
      )
      expect(res.status).toBe(200)

      // Only assert staging side-effects when the model actually called a color tool
      const colorToolResults = res.toolResults.filter(
        tr => tr.toolName === 'update_colors' || tr.toolName === 'update_widget_theme',
      )
      if (colorToolResults.length > 0) {
        // Admin config should show unpublished changes
        const configRes = await fetch(`${BASE_URL}/api/config`, { headers: adminHeaders })
        const body = await configRes.json() as { has_unpublished_changes?: boolean }
        expect(body.has_unpublished_changes).toBe(true)
      }
    } finally {
      await discardDraft()
    }
  })
})

// ── 8. get_config tool — returns full house_rules ────────────────────────────

describe('get_config tool', () => {
  it('get_config is called when the user asks for current settings', async () => {
    const res = await streamCopilot(
      'What is my current organization phone number? Use get_config.',
      adminHeaders,
    )
    expect(res.status).toBe(200)

    const configResults = res.toolResults.filter(tr => tr.toolName === 'get_config')
    expect(configResults.length).toBeGreaterThan(0)

    // Result must include tenant fields
    const r = configResults[0].result
    // Either phone is present (possibly null) — the key must exist
    expect('phone' in r || 'name' in r).toBe(true)
  })
})

// ── 9. /admin/agent/history GET ───────────────────────────────────────────────

describe('GET /admin/agent/history', () => {
  it('returns a messages array', async () => {
    const res = await fetch(`${BASE_URL}/admin/agent/history`, { headers: adminHeaders })
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: unknown[] }
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('messages have role and content fields', async () => {
    // Ensure there is at least one message
    await streamCopilot('Say hello.', adminHeaders)

    const res = await fetch(`${BASE_URL}/admin/agent/history`, { headers: adminHeaders })
    const body = await res.json() as { messages: Array<{ role: string; content: string }> }

    if (body.messages.length > 0) {
      const msg = body.messages[0]
      expect(typeof msg.role).toBe('string')
      expect(typeof msg.content).toBe('string')
    }
  })
})
