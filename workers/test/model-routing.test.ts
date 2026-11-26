import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateText } from 'ai'
import {
  DEFAULT_COPILOT_MODEL,
  DEFAULT_MAIN_CHAT_MODEL,
  chatCompletionsTarget,
  createCloudflareRestAiProvider,
  getCopilotModelName,
  getCopilotReasoningEffort,
  getMainChatReasoningEffort,
  openChatStreamWithFallback,
  openGatewayChatStream,
  parseReasoningEffort,
} from '../src/lib/ai'
import { readEvalOverrides, resolveReasoningEffort } from '../src/lib/eval-overrides'
import { createToolCallExtrasFetch } from '../src/lib/tool-call-extras'
import { usageTokens } from '../src/lib/usage-log'
import type { Env } from '../src/lib/types'

function env(overrides: Partial<Env> = {}): Env {
  return {
    AI_GATEWAY_ACCOUNT_ID: 'acct',
    AI_GATEWAY_ID: 'gw',
    AI_GATEWAY_TOKEN: 'tok',
    ENVIRONMENT: 'dev',
    ...overrides,
  } as Env
}

afterEach(() => vi.unstubAllGlobals())

describe('model + reasoning config', () => {
  it('defaults the copilot to Claude and reads overrides', () => {
    expect(getCopilotModelName(env())).toBe(DEFAULT_COPILOT_MODEL)
    expect(getCopilotModelName(env({ COPILOT_MODEL: 'google-ai-studio/gemini-4-hydrogen' })))
      .toBe('google-ai-studio/gemini-4-hydrogen')
    expect(getCopilotModelName(env({ COPILOT_MODEL: 'REPLACE_VIA_GEN_WRANGLER' }))).toBe(DEFAULT_COPILOT_MODEL)
  })

  it('only accepts known reasoning efforts', () => {
    expect(parseReasoningEffort(' LOW ')).toBe('low')
    expect(parseReasoningEffort('xhigh')).toBe('xhigh')
    expect(parseReasoningEffort('turbo')).toBeUndefined()
    expect(parseReasoningEffort('REPLACE_VIA_GEN_WRANGLER')).toBeUndefined()
    expect(getMainChatReasoningEffort(env({ MAIN_CHAT_REASONING_EFFORT: 'medium' }))).toBe('medium')
    expect(getCopilotReasoningEffort(env())).toBeUndefined()
  })

  it('streams with include_usage and the configured reasoning_effort', async () => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }))
    const stream = await openGatewayChatStream({
      env: env(),
      model: 'google-ai-studio/gemini-4-hydrogen',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'low',
    })
    await stream.getReader().read()
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.reasoning_effort).toBe('low')
  })

  it('errors pre-first-token when SSE emits an inline error event', async () => {
    const sse = 'data: {"error":{"message":"upstream overloaded"}}\n\n'
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    ))
    const stream = await openGatewayChatStream({
      env: env(),
      model: 'google/gemini-4-hydrogen',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await expect(stream.getReader().read()).rejects.toThrow(/upstream overloaded/)
  })

  it('preserves partial text when an inline SSE error arrives after text deltas', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}',
      'data: {"error":{"message":"connection reset"}}',
      '',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    ))
    const stream = await openGatewayChatStream({
      env: env(),
      model: 'google/gemini-4-hydrogen',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const reader = stream.getReader()
    const first = await reader.read()
    expect(first).toEqual({ done: false, value: 'Hello ' })
    const second = await reader.read()
    expect(second.done).toBe(true)
  })

  it('flushes a trailing SSE data line without a final newline', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"tail"}}]}'
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    ))
    const stream = await openGatewayChatStream({
      env: env(),
      model: 'google/gemini-4-hydrogen',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const reader = stream.getReader()
    expect(await reader.read()).toEqual({ done: false, value: 'tail' })
    expect((await reader.read()).done).toBe(true)
  })
})

describe('openChatStreamWithFallback', () => {
  async function drain(primed: { firstChunk: string; reader: ReadableStreamDefaultReader<string> }) {
    let text = primed.firstChunk
    while (true) {
      const { done, value } = await primed.reader.read()
      if (done) break
      text += value
    }
    return text
  }

  it('fails over to fallbackModel on HTTP 503 and drops primary reasoningEffort', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      calls.push({ url, body })
      if (calls.length === 1) {
        return new Response('service unavailable', { status: 503 })
      }
      const sse = [
        'data: {"choices":[{"delta":{"content":"Help is "}}]}',
        'data: {"choices":[{"delta":{"content":"here."}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
        'data: [DONE]',
        '',
      ].join('\n')
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    }))

    let usage: unknown = null
    let resets = 0
    const primed = await openChatStreamWithFallback({
      env: env(),
      model: 'google/gemini-4-hydrogen',
      fallbackModel: DEFAULT_MAIN_CHAT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'low',
      onUsage: (u) => { usage = u },
      onResetUsage: () => { resets++; usage = null },
    })

    expect(primed.usedFallback).toBe(true)
    expect(primed.model).toBe(DEFAULT_MAIN_CHAT_MODEL)
    expect(primed.reasoningEffort).toBeUndefined()
    expect(resets).toBe(1)
    expect(await drain(primed)).toBe('Help is here.')
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 })
    expect(calls[0].body.model).toBe('google/gemini-4-hydrogen')
    expect(calls[0].body.reasoning_effort).toBe('low')
    expect(calls[1].body.model).toBe(DEFAULT_MAIN_CHAT_MODEL)
    expect(calls[1].body.reasoning_effort).toBeUndefined()
  })

  it('fails over when primary returns HTTP 200 with an empty SSE stream', async () => {
    let attempt = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempt++
      if (attempt === 1) {
        return new Response('data: {"choices":[{"delta":{"content":""}}]}\ndata: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response('data: {"choices":[{"delta":{"content":"Fallback ok"}}]}\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    }))

    const primed = await openChatStreamWithFallback({
      env: env(),
      model: 'google/gemini-4-hydrogen',
      fallbackModel: DEFAULT_MAIN_CHAT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(primed.usedFallback).toBe(true)
    expect(await drain(primed)).toBe('Fallback ok')
  })

  it('fails over when primary returns HTTP 200 with an inline SSE error', async () => {
    let attempt = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempt++
      if (attempt === 1) {
        return new Response('data: {"error":{"message":"quota exceeded"}}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response('data: {"choices":[{"delta":{"content":"Recovered"}}]}\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    }))

    const primed = await openChatStreamWithFallback({
      env: env(),
      model: 'google/gemini-4-hydrogen',
      fallbackModel: DEFAULT_MAIN_CHAT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(primed.usedFallback).toBe(true)
    expect(await drain(primed)).toBe('Recovered')
  })

  it('does not fail over when fallbackModel is omitted or matches primary', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(openChatStreamWithFallback({
      env: env(),
      model: 'google/gemini-4-hydrogen',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/502/)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await expect(openChatStreamWithFallback({
      env: env(),
      model: DEFAULT_MAIN_CHAT_MODEL,
      fallbackModel: DEFAULT_MAIN_CHAT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/502/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('chatCompletionsTarget', () => {
  it('sends google/* catalog models to the Cloudflare REST API through our gateway', () => {
    const t = chatCompletionsTarget(env({ CLOUDFLARE_AI_TOKEN: 'cf-rest' }), 'google/gemini-4-hydrogen')
    expect(t.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions')
    expect(t.headers.Authorization).toBe('Bearer cf-rest')
    expect(t.headers['cf-aig-gateway-id']).toBe('gw')
    expect(t.headers['cf-aig-authorization']).toBeUndefined()
  })

  it('keeps every other prefix on /compat with the gateway token', () => {
    for (const model of ['anthropic/claude-sonnet-5', 'google-ai-studio/gemini-4-hydrogen', 'openai/gpt-4.1-mini']) {
      const t = chatCompletionsTarget(env({ CLOUDFLARE_AI_TOKEN: 'cf-rest' }), model)
      expect(t.url).toBe('https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions')
      expect(t.headers['cf-aig-authorization']).toBe('Bearer tok')
      expect(t.headers.Authorization).toBeUndefined()
    }
  })

  it('falls back to AI_GATEWAY_TOKEN, and fails clearly with no token at all', () => {
    expect(chatCompletionsTarget(env(), 'google/gemini-4-hydrogen').headers.Authorization).toBe('Bearer tok')
    expect(() => chatCompletionsTarget(env({ AI_GATEWAY_TOKEN: '' }), 'google/gemini-4-hydrogen')).toThrow(/Workers AI/)
  })

  it('REST AI SDK provider adds the gateway header', async () => {
    let seen: Headers | undefined
    let url = ''
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input)
      seen = new Headers(init?.headers)
      return new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'google/gemini-4-hydrogen',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const provider = createCloudflareRestAiProvider(env({ CLOUDFLARE_AI_TOKEN: 'cf-rest' }), { fetch: fakeFetch })
    await generateText({ model: provider.chat('google/gemini-4-hydrogen'), prompt: 'hi' })
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions')
    expect(seen?.get('authorization')).toBe('Bearer cf-rest')
    expect(seen?.get('cf-aig-gateway-id')).toBe('gw')
  })
})

describe('eval overrides', () => {
  const headers = new Headers({
    'X-Eval-Model': 'google-ai-studio/gemini-4-hydrogen',
    'X-Eval-Reasoning-Effort': 'medium',
    'X-Eval-Report-Usage': '1',
  })

  it('are honored only in local dev with the auth bypass on', () => {
    expect(readEvalOverrides(env({ DEV_AUTH_BYPASS: 'true' }), headers)).toEqual({
      model: 'google-ai-studio/gemini-4-hydrogen',
      reasoningEffort: 'medium',
      reportUsage: true,
    })
    expect(readEvalOverrides(env(), headers)).toBeNull()
    expect(readEvalOverrides(env({ DEV_AUTH_BYPASS: 'true', ENVIRONMENT: 'test' }), headers)).toBeNull()
    expect(readEvalOverrides(env({ DEV_AUTH_BYPASS: 'true', ENVIRONMENT: 'production' }), headers)).toBeNull()
  })

  it('rejects malformed model names', () => {
    const o = readEvalOverrides(env({ DEV_AUTH_BYPASS: 'true' }), new Headers({ 'X-Eval-Model': 'evil model; drop' }))
    expect(o?.model).toBeUndefined()
  })

  it('resolves effort: override > configured, and "default" clears it', () => {
    expect(resolveReasoningEffort(null, 'low')).toBe('low')
    expect(resolveReasoningEffort({ reasoningEffort: 'high', reportUsage: false }, 'low')).toBe('high')
    expect(resolveReasoningEffort({ reasoningEffort: 'default', reportUsage: false }, 'low')).toBeUndefined()
  })
})

describe('usageTokens', () => {
  it('reads OpenAI-format usage and counts thinking tokens as output', () => {
    expect(usageTokens({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1300 }))
      .toEqual({ promptTokens: 1000, completionTokens: 300 })
    expect(usageTokens({ inputTokens: 10, outputTokens: 5 })).toEqual({ promptTokens: 10, completionTokens: 5 })
  })
})

describe('createToolCallExtrasFetch', () => {
  it('echoes Gemini thought signatures from a streamed tool call into the next request', async () => {
    const sig = { google: { thought_signature: 'sig-abc' } }
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_config', arguments: '' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' }, extra_content: sig }] } }] })}`,
      'data: [DONE]',
      '',
    ].join('\n')
    const bodies: unknown[] = []
    const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const f = createToolCallExtrasFetch(base)

    const first = await f('https://gw/compat/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [] }) })
    expect(await first.text()).toBe(sse) // passes the stream through unchanged

    await f('https://gw/compat/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_config', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '{}' },
        ],
      }),
    })
    const second = bodies[1] as { messages: Array<{ tool_calls?: Array<{ extra_content?: unknown }> }> }
    expect(second.messages[0].tool_calls?.[0].extra_content).toEqual(sig)
  })

  it('leaves requests untouched when nothing was captured', async () => {
    const base = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const f = createToolCallExtrasFetch(base)
    const init = { method: 'POST', body: '{"messages":[]}' }
    await f('https://gw', init)
    expect((base as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1]).toBe(init)
  })
})
