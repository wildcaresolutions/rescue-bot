/**
 * Route-level resilience tests for workers/src/routes/chat.ts:
 *  1. Mid-stream client disconnect still drains the upstream model inside
 *     waitUntil and persists the full assistant reply + triage analysis + usage.
 *  2. Primary model failure transparently fails over to DEFAULT_MAIN_CHAT_MODEL
 *     before HTTP 200 headers are committed, and logs usage under the active model.
 *  3. Local eval overrides (X-Eval-Model) do NOT silently fail over.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

vi.mock('../src/lib/chat-prompt', () => ({
  buildChatPrompt: vi.fn(async () => ({ systemPrompt: 'You are a wildlife rescue bot.' })),
}))

vi.mock('../src/lib/analyze-session', () => ({
  quickAnalyzeSession: vi.fn(async () => {}),
}))

vi.mock('../src/lib/usage-log', () => ({
  logUsage: vi.fn(async () => {}),
}))

import chat from '../src/routes/chat'
import { DEFAULT_MAIN_CHAT_MODEL } from '../src/lib/ai'
import { quickAnalyzeSession } from '../src/lib/analyze-session'
import { logUsage } from '../src/lib/usage-log'
import type { Env, Tenant, Variables } from '../src/lib/types'

const TENANT: Tenant = {
  id: 'tenant-1',
  slug: 'wildcare',
  name: 'WildCare',
  phone: '415-456-7283',
  url: null,
  email: null,
  location_county: null,
  location_state: null,
  location_service_area: null,
  color_primary: '',
  color_secondary: '',
  color_accent: '',
  logo_r2_key: null,
  custom_instruction: null,
  password_hash: '',
  widget_theme: null,
  widget_custom_css: null,
  widget_published_at: null,
  org_config: null,
  bot_overrides: null,
  admin_token_hash: null,
  onboarded: 1,
  report_recipients: null,
  house_rules: null,
  custom_instruction_locked: 0,
  custom_instruction_locked_at: null,
  custom_instruction_locked_pending_review: null,
  feature_flags: null,
  draft_config: null,
  draft_updated_at: null,
  daily_reports_enabled: 0,
  created_at: '',
  updated_at: '',
}

class RecordingD1 {
  insertedMessages: Array<{ role: string; content: string; sessionId: string }> = []

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, ' ').trim()
    const self = this
    return {
      binds: [] as unknown[],
      bind(...args: unknown[]) {
        this.binds = args
        return this
      },
      async first<T = unknown>(): Promise<T | null> {
        if (norm.includes('SELECT COUNT(*) as count FROM messages')) {
          return { count: 0 } as T
        }
        return null
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        return { results: [] }
      },
      async run() {
        if (norm.includes("VALUES (?, ?, 'user'")) {
          self.insertedMessages.push({
            sessionId: String(this.binds[0]),
            role: 'user',
            content: String(this.binds[2]),
          })
        } else if (norm.includes("VALUES (?, ?, 'assistant'")) {
          self.insertedMessages.push({
            sessionId: String(this.binds[0]),
            role: 'assistant',
            content: String(this.binds[2]),
          })
        }
        return { success: true, meta: { changes: 1 } }
      },
    }
  }
}

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('tenant', TENANT)
    await next()
  })
  app.route('/', chat)
  return app
}

function makeEnv(db: RecordingD1, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    AI_GATEWAY_ACCOUNT_ID: 'acct',
    AI_GATEWAY_ID: 'gw',
    AI_GATEWAY_TOKEN: 'tok',
    MAIN_CHAT_MODEL: 'google/gemini-4-hydrogen',
    MAIN_CHAT_REASONING_EFFORT: 'low',
    ENVIRONMENT: 'production',
    ...overrides,
  } as unknown as Env
}

function makeCtx() {
  const pending: Promise<unknown>[] = []
  const ctx = {
    waitUntil(p: Promise<unknown>) { pending.push(p) },
    passThroughOnException() {},
  } as unknown as ExecutionContext
  return { ctx, pending, flush: () => Promise.all(pending) }
}

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      for (const ev of events) {
        controller.enqueue(enc.encode(ev))
        await Promise.resolve()
      }
      controller.close()
    },
  })
}

describe('POST /api/sessions/:id stream resilience', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('persists full assistant reply, triage, and usage even when client disconnects mid-stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseStream([
      'data: {"choices":[{"delta":{"content":"First chunk. "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Second chunk."}}],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\n',
      'data: [DONE]\n\n',
    ]), { headers: { 'content-type': 'text/event-stream' } })))

    const db = new RecordingD1()
    const { ctx, pending, flush } = makeCtx()
    const app = makeApp()

    const res = await app.request(
      'http://localhost/api/sessions/sess-disconnect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Found a wild turkey' }),
      },
      makeEnv(db),
      ctx,
    )

    expect(res.status).toBe(200)
    // waitUntil MUST already be registered before the Response is consumed.
    expect(pending.length).toBeGreaterThan(0)

    // Simulate the visitor closing the tab immediately after receiving the first chunk.
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('First chunk. ')
    await reader.cancel()

    await flush()

    const assistantMsgs = db.insertedMessages.filter(m => m.role === 'assistant')
    expect(assistantMsgs).toHaveLength(1)
    expect(assistantMsgs[0].content).toBe('First chunk. Second chunk.')
    expect(quickAnalyzeSession).toHaveBeenCalledTimes(1)
    expect(logUsage).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'google/gemini-4-hydrogen',
      { prompt_tokens: 100, completion_tokens: 20 },
    )
  })

  it('transparently fails over to DEFAULT_MAIN_CHAT_MODEL when primary model returns 503', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      if (calls === 1) {
        return new Response('upstream 503', { status: 503 })
      }
      return new Response(sseStream([
        'data: {"choices":[{"delta":{"content":"Fallback reply"}}],"usage":{"prompt_tokens":50,"completion_tokens":10}}\n\n',
        'data: [DONE]\n\n',
      ]), { headers: { 'content-type': 'text/event-stream' } })
    }))

    const db = new RecordingD1()
    const { ctx, flush } = makeCtx()
    const app = makeApp()

    const res = await app.request(
      'http://localhost/api/sessions/sess-failover',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Found a wild turkey' }),
      },
      makeEnv(db),
      ctx,
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Fallback reply')
    await flush()

    expect(calls).toBe(2)
    expect(logUsage).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      DEFAULT_MAIN_CHAT_MODEL,
      { prompt_tokens: 50, completion_tokens: 10 },
    )
  })

  it('does NOT silently fail over when X-Eval-Model override is active in local dev', async () => {
    const fetchMock = vi.fn(async () => new Response('upstream 503', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const db = new RecordingD1()
    const { ctx } = makeCtx()
    const app = makeApp()

    const res = await app.request(
      'http://localhost/api/sessions/sess-eval',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Eval-Model': 'google/gemini-4-hydrogen',
        },
        body: JSON.stringify({ message: 'Found a wild turkey' }),
      },
      makeEnv(db, { ENVIRONMENT: 'dev', DEV_AUTH_BYPASS: 'true' }),
      ctx,
    )

    expect(res.status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
