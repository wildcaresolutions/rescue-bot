import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webSearchTools } from '../src/lib/tools/web-search'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { Hono } from 'hono'
import agentApp from '../src/routes/agent'
import type { Env, Tenant, Variables } from '../src/lib/types'

let model: MockLanguageModelV4
vi.mock('../src/lib/ai-gateway-anthropic', () => ({
  buildAnthropicProvider: () => ({ ok: true, anthropic: () => model }),
}))

const endpoint = 'https://search.parallel.ai/mcp'
const requests: Array<{ url: string; headers: Headers; message: Record<string, unknown> }> = []
let failure: 'http' | 'tool' | 'malformed' | 'pending' | undefined
let pendingMethod = 'initialize'
let output = ''

beforeEach(() => {
  failure = undefined
  pendingMethod = 'initialize'
  output = 'Wildlife directory: https://example.org/rehab?state=CA#contacts'
  requests.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const message = JSON.parse(String(init?.body ?? '{}'))
    requests.push({ url, headers: new Headers(init?.headers), message })
    if (failure === 'pending' && message.method === pendingMethod) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) reject(signal.reason)
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    if (failure === 'http') return new Response('Unavailable', { status: 503 })
    if (failure === 'malformed') return new Response('not json', { headers: { 'content-type': 'application/json' } })
    if (message.id === undefined) return new Response(null, { status: 202 })
    let result: unknown
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    } else if (message.method === 'tools/list') {
      result = { tools: ['web_search', 'web_fetch'].map(name => ({ name, inputSchema: { type: 'object' } })) }
    } else if (message.method === 'tools/call') {
      result = { isError: failure === 'tool', content: [{ type: 'text', text: failure === 'tool' ? 'Quota exceeded' : output }] }
    } else throw new Error(`Unexpected MCP request: ${message.method}`)
    return Response.json({ jsonrpc: '2.0', id: message.id, result })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const search = { objective: 'Find public wildlife rehabilitation directories', search_queries: ['wildlife rehabilitation directory'] }
const options = { toolCallId: 'research', messages: [], context: {} }

describe('copilot Parallel research tools', () => {
  it('defaults to anonymous search and discovers/calls only the fixed MCP endpoint', async () => {
    const tools = webSearchTools({})
    const result = await tools.web_search!.execute!(search, options)
    expect(result).toEqual({ success: true, text: 'Wildlife directory: https://example.org/rehab?state=CA#contacts' })
    expect(requests.map(r => r.message.method)).toContain('tools/list')
    expect(requests.find(r => r.message.method === 'tools/call')?.message.params).toEqual({ name: 'web_search', arguments: search })
    for (const request of requests) {
      expect(request.url).toBe(endpoint)
      expect(request.headers.get('User-Agent')).toContain('rescue-bot')
      expect(request.headers.has('Authorization')).toBe(false)
    }
  })

  it('honors explicit provider and platform identity without passing ambient keys', async () => {
    vi.stubEnv('PARALLEL_API_KEY', 'must-not-be-read')
    try {
      const tools = webSearchTools({ COPILOT_WEB_SEARCH: 'parallel', PLATFORM_NAME: 'Rescue Test' })
      await tools.web_search!.execute!(search, options)
      expect(requests.every(r => r.headers.get('User-Agent')?.includes('Rescue Test'))).toBe(true)
      expect(requests.every(r => !r.headers.has('Authorization'))).toBe(true)
    } finally { vi.unstubAllEnvs() }
  })

  it('removes both tools when disabled and rejects unknown provider settings', () => {
    expect(webSearchTools({ COPILOT_WEB_SEARCH: 'disabled' })).toEqual({})
    expect(() => webSearchTools({ COPILOT_WEB_SEARCH: 'typo' })).toThrow('COPILOT_WEB_SEARCH')
    expect(requests).toHaveLength(0)
  })

  it('fetches public URLs verbatim and rejects unsafe URLs before connecting', async () => {
    const tools = webSearchTools({})
    const urls = ['https://example.org/rehab?state=CA#contacts']
    expect(await tools.web_fetch!.execute!({ urls }, options)).toHaveProperty('success', true)
    expect(requests.find(r => r.message.method === 'tools/call')?.message.params).toEqual({ name: 'web_fetch', arguments: { urls } })
    requests.length = 0
    for (const url of ['http://example.org', 'https://127.0.0.1', 'https://user:password@example.org', 'file:///etc/passwd']) {
      expect(await tools.web_fetch!.execute!({ urls: [url] }, options)).toHaveProperty('success', false)
    }
    expect(requests).toHaveLength(0)
  })

  it.each(['http', 'tool', 'malformed'] as const)('surfaces %s failures without fallback', async mode => {
    failure = mode
    const result = await webSearchTools({}).web_search!.execute!(search, options)
    expect(result).toHaveProperty('success', false)
    expect(requests.every(r => r.url === endpoint)).toBe(true)
  })

  it.each(['initialize', 'tools/list', 'tools/call'])('bounds stalled %s with a timeout', async method => {
    vi.useFakeTimers()
    failure = 'pending'
    pendingMethod = method
    const pending = webSearchTools({}).web_search!.execute!(search, options)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(await pending).toMatchObject({ success: false, error: expect.stringMatching(/timed out/i) })
  })

  it.each(['initialize', 'tools/list', 'tools/call'])('cancels %s and sends nothing for an already aborted caller', async method => {
    failure = 'pending'
    pendingMethod = method
    const controller = new AbortController()
    const pending = webSearchTools({}, controller.signal).web_search!.execute!(search, options)
    await vi.waitFor(() => expect(requests.some(r => r.message.method === method)).toBe(true))
    controller.abort()
    expect(await pending).toMatchObject({ success: false, error: expect.stringMatching(/cancel/i) })
    requests.length = 0
    await webSearchTools({}, controller.signal).web_search!.execute!(search, options)
    expect(requests).toHaveLength(0)
  })

  it('honors the AI SDK tool cancellation signal', async () => {
    failure = 'pending'
    pendingMethod = 'tools/call'
    const controller = new AbortController()
    const pending = webSearchTools({}).web_search!.execute!(search, { ...options, abortSignal: controller.signal })
    await vi.waitFor(() => expect(requests.some(r => r.message.method === 'tools/call')).toBe(true))
    controller.abort()
    expect(await pending).toMatchObject({ success: false, error: 'Web research cancelled' })
  })

  it('bounds result text and reports empty output as a failure', async () => {
    output = 'x'.repeat(30_000)
    const result = await webSearchTools({}).web_search!.execute!(search, options)
    expect(result).toMatchObject({ success: true, text: 'x'.repeat(25_000) })
    output = ''
    expect(await webSearchTools({}).web_fetch!.execute!({ urls: ['https://example.org'] }, options))
      .toMatchObject({ success: false, error: 'Web research returned no text' })
  })
})

const tenant: Tenant = {
  id: 'test-tenant', slug: 'test', name: 'Test Rescue', phone: null, email: null, url: null,
  location_county: null, location_state: null, location_service_area: null,
  color_primary: '#000', color_secondary: '#111', color_accent: '#222', logo_r2_key: null,
  custom_instruction: null, password_hash: '', widget_theme: null, widget_custom_css: null,
  widget_published_at: null, org_config: null, bot_overrides: null, admin_token_hash: null,
  onboarded: 1, report_recipients: null, daily_reports_enabled: 0, house_rules: 'Retain my operator-approved rules',
  custom_instruction_locked: 0, custom_instruction_locked_at: null, custom_instruction_locked_pending_review: null,
  feature_flags: null, draft_config: null, draft_updated_at: null, created_at: '', updated_at: '',
}

async function callAgent(provider?: string) {
  const writes: string[] = []
  const pending: Promise<unknown>[] = []
  const empty: D1Result<never> = {
    success: true, results: [],
    meta: { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 },
  }
  const prepare = (sql: string): D1PreparedStatement => {
    const statement: D1PreparedStatement = {
      bind: (..._args: unknown[]) => statement,
      first: async () => null,
      all: async () => empty,
      run: async () => { writes.push(sql); return empty },
      raw: async () => { throw new Error('Unexpected raw SQL') },
    }
    return statement
  }
  const db: D1Database = {
    prepare, batch: async () => [], exec: async () => ({ count: 0, duration: 0 }),
    withSession: () => ({ prepare, batch: async () => [], getBookmark: () => null }),
    dump: async () => new ArrayBuffer(0),
  }
  const env = {
    COPILOT_WEB_SEARCH: provider,
    DB: db,
  } as Env
  const app = new Hono<{ Bindings: Env; Variables: Variables }>()
  // The real authorization middleware is exercised separately in router.test.ts.
  app.use('*', async (c, next) => { c.set('tenant', tenant); await next() })
  app.route('/', agentApp)
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} }
  const response = await app.fetch(new Request('https://example.org/admin/agent', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Find a public rehabilitation directory and read its contact page.' }] }),
  }), env, ctx)
  const text = await response.text()
  await Promise.all(pending)
  return { response, text, writes }
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function modelStep(parts: LanguageModelV4StreamPart[]) {
  return { stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null, initialDelayInMs: null }) }
}

describe('scripted model through the real copilot route and AI SDK dispatcher', () => {
  it('searches, reads a result, consumes both outputs and streams the cited answer', async () => {
    const url = 'https://example.org/rehab?state=CA#contacts'
    model = new MockLanguageModelV4({ doStream: [
      modelStep([
        { type: 'tool-call', toolCallId: 'search-1', toolName: 'web_search', input: JSON.stringify(search) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
      ]),
      modelStep([
        { type: 'tool-call', toolCallId: 'fetch-1', toolName: 'web_fetch', input: JSON.stringify({ urls: [url] }) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
      ]),
      modelStep([
        { type: 'text-start', id: 'answer' },
        { type: 'text-delta', id: 'answer', delta: `Review ${url} and confirm intake policies before saving.` },
        { type: 'text-end', id: 'answer' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
      ]),
    ] })
    const { response, text, writes } = await callAgent()
    expect(response.status).toBe(200)
    expect(text).toContain('"toolName":"web_search"')
    expect(text).toContain('"toolName":"web_fetch"')
    expect(text).toContain(`0:"Review ${url}`)
    expect(text).toContain('"success":true')
    expect(model.doStreamCalls).toHaveLength(3)
    const consumed = JSON.stringify(model.doStreamCalls[2].prompt)
    expect(consumed).toContain('Wildlife directory:')
    expect(consumed).toContain('web_fetch')
    expect(consumed).toContain(tenant.house_rules ? 'read the full text with get_config' : 'not set')
    expect(writes.some(sql => /UPDATE\s+tenants/i.test(sql))).toBe(false)
    expect(requests.filter(r => r.message.method === 'tools/call')).toHaveLength(2)
    expect(requests.every(r => r.url === endpoint && r.headers.get('User-Agent')?.includes('rescue-bot'))).toBe(true)
  })

  it('preserves existing tools while withholding disabled research tools', async () => {
    model = new MockLanguageModelV4({ doStream: modelStep([
      { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: 'Public search is disabled.' },
      { type: 'text-end', id: 'answer' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
    ]) })
    expect((await callAgent('disabled')).response.status).toBe(200)
    const names = model.doStreamCalls[0].tools?.map(t => t.name)
    expect(names).not.toContain('web_search')
    expect(names).not.toContain('web_fetch')
    expect(names).toContain('fetch_url')
    expect(names).toContain('harvest_website_info')
    expect(names).toContain('search_knowledge_base')
    expect(requests).toHaveLength(0)
  })

  it('returns an explicit configuration error for an unknown provider', async () => {
    model = new MockLanguageModelV4()
    const { response, text } = await callAgent('typo')
    expect(response.status).toBe(500)
    expect(text).toContain('COPILOT_WEB_SEARCH must be parallel or disabled')
    expect(model.doStreamCalls).toHaveLength(0)
    expect(requests).toHaveLength(0)
  })
})
