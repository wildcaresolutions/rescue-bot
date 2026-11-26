import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import type { Env } from './types'
import { logWarn, logError } from './logger'

export const DEFAULT_MAIN_CHAT_MODEL = 'anthropic/claude-sonnet-5'
export const DEFAULT_EVAL_JUDGE_MODEL = 'anthropic/claude-haiku-5-5'
export const DEFAULT_PHOTO_RECOGNIZER_MODEL = 'openai/gpt-4.1-mini'
export const DEFAULT_COPILOT_MODEL = 'anthropic/claude-sonnet-5'
export const DEFAULT_AI_GATEWAY_ID = 'default'

// OpenAI-style `reasoning_effort`, which /compat maps onto each provider's
// own knob (Gemini 4 `thinking_level`, etc). Unset = the provider default —
// for Gemini 4 Hydrogen that is `high`, the slowest/most expensive level.
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ReasoningEffort = typeof REASONING_EFFORTS[number]

function clean(value: string | undefined | null): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed === 'REPLACE_VIA_GEN_WRANGLER' ? '' : trimmed
}

export function parseReasoningEffort(value: string | undefined | null): ReasoningEffort | undefined {
  const v = clean(value).toLowerCase()
  return (REASONING_EFFORTS as readonly string[]).includes(v) ? v as ReasoningEffort : undefined
}

export function getMainChatModelName(env: Env): string {
  return clean(env.MAIN_CHAT_MODEL) || DEFAULT_MAIN_CHAT_MODEL
}

export function getMainChatReasoningEffort(env: Env): ReasoningEffort | undefined {
  return parseReasoningEffort(env.MAIN_CHAT_REASONING_EFFORT)
}

export function getCopilotModelName(env: Env): string {
  return clean(env.COPILOT_MODEL) || DEFAULT_COPILOT_MODEL
}

export function getCopilotReasoningEffort(env: Env): ReasoningEffort | undefined {
  return parseReasoningEffort(env.COPILOT_REASONING_EFFORT)
}

export function getEvalJudgeModelName(env: Env): string {
  return clean(env.EVAL_JUDGE_MODEL) || DEFAULT_EVAL_JUDGE_MODEL
}

export function getPhotoRecognizerModelName(env: Env): string {
  return clean(env.PHOTO_RECOGNIZER_MODEL) || DEFAULT_PHOTO_RECOGNIZER_MODEL
}

export function getAiGatewayId(env: Env): string {
  return clean(env.AI_GATEWAY_ID) || DEFAULT_AI_GATEWAY_ID
}

export function getAiGatewayToken(env: Env): string {
  return clean(env.AI_GATEWAY_TOKEN)
}

export function getAiGatewayBaseURL(env: Env): string {
  const accountId = clean(env.AI_GATEWAY_ACCOUNT_ID)
  if (!accountId) {
    throw new Error('Cloudflare AI Gateway is not configured. Set AI_GATEWAY_ACCOUNT_ID.')
  }
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${getAiGatewayId(env)}/compat`
}

export function getAiGatewayProviderBaseURL(env: Env, provider: string): string {
  const accountId = clean(env.AI_GATEWAY_ACCOUNT_ID)
  if (!accountId) {
    throw new Error('Cloudflare AI Gateway is not configured. Set AI_GATEWAY_ACCOUNT_ID.')
  }
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${getAiGatewayId(env)}/${provider}`
}

// ── Cloudflare REST API (Unified Billing catalog models) ────────────────────
//
// `google/*` models (Cloudflare catalog names, e.g. google/gemini-4-hydrogen)
// are billed to the Cloudflare account via Unified Billing, but the legacy
// /compat endpoint doesn't know them. They go to the REST API's
// OpenAI-compatible /ai/v1/chat/completions instead, still through our AI
// Gateway (cf-aig-gateway-id) so logging/caching/rate limits apply.
//
// `google-ai-studio/*` stays on /compat and bills the Google AI Studio project
// behind the gateway — the REST path exists because that project's prepaid
// credit can run dry independently of the Cloudflare account.
const REST_API_PREFIXES = ['google/']

export function usesCloudflareRestApi(model: string): boolean {
  return REST_API_PREFIXES.some(p => model.startsWith(p))
}

// AI_GATEWAY_TOKEN is itself a Cloudflare API token, so granting it the
// Workers AI permission lets one token cover both paths. CLOUDFLARE_AI_TOKEN
// only exists to keep the permissions split if you prefer.
export function getCloudflareAiToken(env: Env): string {
  return clean(env.CLOUDFLARE_AI_TOKEN) || clean(env.AI_GATEWAY_TOKEN)
}

export function getCloudflareRestAiBaseURL(env: Env): string {
  const accountId = clean(env.AI_GATEWAY_ACCOUNT_ID)
  if (!accountId) {
    throw new Error('Cloudflare AI Gateway is not configured. Set AI_GATEWAY_ACCOUNT_ID.')
  }
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
}

/** Where to POST an OpenAI-format chat completion for `model`, with auth headers. */
export function chatCompletionsTarget(env: Env, model: string): { url: string; headers: Record<string, string> } {
  if (usesCloudflareRestApi(model)) {
    const token = getCloudflareAiToken(env)
    if (!token) {
      throw new Error(`${model} needs AI_GATEWAY_TOKEN (or CLOUDFLARE_AI_TOKEN) with the Workers AI permission.`)
    }
    return {
      url: `${getCloudflareRestAiBaseURL(env)}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'cf-aig-gateway-id': getAiGatewayId(env),
      },
    }
  }
  const token = getAiGatewayToken(env)
  if (!token) {
    throw new Error('Cloudflare AI Gateway token is not configured. Set AI_GATEWAY_TOKEN.')
  }
  return {
    url: `${getAiGatewayBaseURL(env)}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      'cf-aig-authorization': `Bearer ${token}`,
    },
  }
}

/**
 * OpenAI-format AI SDK provider for `google/*` models on the Cloudflare REST
 * API. Counterpart of createAiGatewayProvider (which targets /compat).
 */
export function createCloudflareRestAiProvider(env: Env, opts: { fetch?: typeof fetch } = {}) {
  const token = getCloudflareAiToken(env)
  if (!token) {
    throw new Error('AI_GATEWAY_TOKEN / CLOUDFLARE_AI_TOKEN not configured (needed for google/* models).')
  }
  const baseFetch = opts.fetch ?? fetch
  const gatewayId = getAiGatewayId(env)
  return createOpenAI({
    apiKey: token,
    baseURL: getCloudflareRestAiBaseURL(env),
    name: 'cloudflare-rest-ai',
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('cf-aig-gateway-id', gatewayId)
      return baseFetch(input, { ...init, headers })
    },
  })
}

async function getAiGatewayCompatBaseURL(env: Env): Promise<string> {
  const gatewayId = getAiGatewayId(env)
  if (env.AI?.gateway) {
    const bindingUrl = await env.AI.gateway(gatewayId).getUrl('compat')
    return bindingUrl.replace(/\/$/, '')
  }
  return getAiGatewayBaseURL(env)
}

function redactSensitive(value: unknown): string {
  return String(value)
    .replace(/cfut_[A-Za-z0-9_-]+/g, 'cfut_[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]+/g, 'AIza[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[REDACTED]')
    .replace(/postgresql:\/\/[^\s"')]+/g, 'postgresql://[REDACTED]')
}

function errorMessage(e: unknown): string {
  return redactSensitive(e instanceof Error ? e.message : e)
}

function createGatewayFetch(token: string, customFetch?: typeof fetch): typeof fetch {
  const baseFetch = customFetch ?? fetch
  return (input, init) => {
    const headers = new Headers(init?.headers)
    headers.delete('authorization')
    if (token) headers.set('cf-aig-authorization', `Bearer ${token}`)
    return baseFetch(input, { ...init, headers })
  }
}

export async function createAiGatewayProvider(env: Env, opts: { fetch?: typeof fetch } = {}) {
  const token = getAiGatewayToken(env)
  const hasBinding = Boolean(env.AI?.gateway)
  if (!token && !hasBinding) {
    throw new Error('Cloudflare AI Gateway token is not configured. Set AI_GATEWAY_TOKEN.')
  }

  return createOpenAI({
    apiKey: 'cloudflare-ai-gateway',
    baseURL: await getAiGatewayCompatBaseURL(env),
    name: 'cloudflare-ai-gateway',
    fetch: createGatewayFetch(token, opts.fetch),
  })
}

type GatewayMessage = {
  role: 'system' | 'user' | 'assistant'
  content: unknown
}

type GatewayRunRequest = {
  provider: string
  endpoint: string
  headers: Record<string, string>
  query: Record<string, unknown>
}

function googleStudioModelName(model: string): string {
  const prefix = 'google-ai-studio/'
  if (!model.startsWith(prefix)) {
    throw new Error(`AI Gateway binding currently supports google-ai-studio models, got ${model}`)
  }
  return model.slice(prefix.length)
}

function extractGatewayText(result: unknown): string {
  if (typeof result === 'string') return result
  const r = result as Record<string, any> | null
  if (!r) return ''
  if (typeof r.text === 'string') return r.text
  if (typeof r.response === 'string') return r.response
  const anthropicText = r.content?.find?.((part: any) => part?.type === 'text' && typeof part.text === 'string')?.text
  if (typeof anthropicText === 'string') return anthropicText
  const content = r.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part?.text === 'string' ? part.text : '')
      .join('')
  }
  const geminiParts = r.candidates?.[0]?.content?.parts
  if (Array.isArray(geminiParts)) {
    return geminiParts
      .map((part) => typeof part?.text === 'string' ? part.text : '')
      .join('')
  }
  return ''
}

async function readGatewayResponse(response: Response): Promise<Record<string, any>> {
  const text = await response.text()
  let json: Record<string, any> | null = null
  try {
    json = JSON.parse(text)
  } catch {
    // Keep json null.
  }
  if (!response.ok) {
    throw new Error(redactSensitive(json?.error?.message ?? json?.error ?? text.slice(0, 500)))
  }
  return json ?? { text }
}

async function runGatewayRequest(env: Env, request: GatewayRunRequest): Promise<Record<string, any>> {
  const token = getAiGatewayToken(env)
  if (token) {
    const headers = new Headers(request.headers)
    // Unified Billing: cf-aig-authorization is the only auth header. No
    // cf-aig-byok-alias — the gateway charges the request to the CF account
    // via unified billing rather than a BYOK-stored provider credential.
    headers.set('cf-aig-authorization', `Bearer ${token}`)
    const response = await fetch(`${getAiGatewayProviderBaseURL(env, request.provider)}/${request.endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request.query),
    })
    return readGatewayResponse(response)
  }

  throw new Error('Cloudflare AI Gateway token is not configured. Set AI_GATEWAY_TOKEN.')
}

async function runGatewayCompatRequest(env: Env, query: Record<string, unknown>): Promise<Record<string, any>> {
  const { url, headers } = chatCompletionsTarget(env, String(query.model ?? ''))
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(query),
  })
  return readGatewayResponse(response)
}

function googleContents(messages: GatewayMessage[]): {
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>
} {
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = []
  const systemText: string[] = []
  for (const message of messages) {
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    if (message.role === 'system') {
      systemText.push(text)
    } else {
      contents.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text }],
      })
    }
  }
  if (systemText.length) {
    const folded = `System instructions:\n${systemText.join('\n\n')}`
    const firstUser = contents.find((content) => content.role === 'user')
    if (firstUser) {
      firstUser.parts[0].text = `${folded}\n\nUser message:\n${firstUser.parts[0].text}`
    } else {
      contents.unshift({ role: 'user', parts: [{ text: folded }] })
    }
  }
  return { contents }
}

function openAiMessages(system: string | undefined, messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
  return [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    ...messages,
  ]
}

export async function runGatewayChatText(opts: {
  env: Env
  model: string
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
}): Promise<{ text: string; usage: unknown; raw: unknown }> {
  let result: Record<string, any>
  if (opts.model.startsWith('openai/') || opts.model.startsWith('anthropic/') || opts.model.startsWith('google/') || opts.model.startsWith('google-ai-studio/') || opts.model.startsWith('workers-ai/')) {
    // google-ai-studio/ intentionally routes through /compat (Unified Billing), NOT the
    // native Google AI Studio endpoint. The native path requires a Google API key even
    // when Unified Billing is enabled — /compat handles provider auth automatically.
    result = await runGatewayCompatRequest(opts.env, {
      model: opts.model,
      messages: openAiMessages(opts.system, opts.messages),
      ...(opts.maxOutputTokens ? { max_tokens: opts.maxOutputTokens } : {}),
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
    })
  } else {
    throw new Error(`Unsupported AI Gateway model prefix: ${opts.model}`)
  }

  return {
    text: extractGatewayText(result),
    usage: result.usage ?? result.usageMetadata ?? null,
    raw: result,
  }
}

// ── Streaming variant ─────────────────────────────────────────────────────────
//
// Typed interface for OpenAI-compatible SSE stream events.
// Matches the shape emitted by the Cloudflare AI Gateway /compat and REST endpoints.
interface OpenAIStreamEvent {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string; code?: string | number; type?: string } | string
}

// Opens an SSE chat-completions stream against /compat with `stream: true`,
// parses the delta events, and returns a ReadableStream of text-only chunks
// the caller can pipe into a streaming HTTP response. Usage tokens (when the
// provider includes them in the final SSE event) are surfaced via the optional
// `onUsage` callback so the caller can log them after the stream closes.
//
// Caller responsibility: handle the fetch-time error (bad token, 4xx/5xx)
// before piping to the response. Errors discovered DURING streaming are
// logged and close the inner stream cleanly so the partial response still
// reaches the user.
export async function openGatewayChatStream(opts: {
  env: Env
  model: string
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
  onUsage?: (usage: unknown) => void
}): Promise<ReadableStream<string>> {
  const supported = opts.model.startsWith('openai/')
    || opts.model.startsWith('anthropic/')
    || opts.model.startsWith('google/')
    || opts.model.startsWith('google-ai-studio/')
    || opts.model.startsWith('workers-ai/')
  if (!supported) {
    throw new Error(`Streaming not supported for model prefix: ${opts.model}`)
  }

  const target = chatCompletionsTarget(opts.env, opts.model)
  const response = await fetch(target.url, {
    method: 'POST',
    headers: target.headers,
    body: JSON.stringify({
      model: opts.model,
      messages: openAiMessages(opts.system, opts.messages),
      stream: true,
      // Without this, OpenAI-format streams omit the final usage event and
      // usage_log records nothing for the main chat.
      stream_options: { include_usage: true },
      ...(opts.maxOutputTokens ? { max_tokens: opts.maxOutputTokens } : {}),
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
    }),
  })

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    throw new Error(redactSensitive(`Gateway ${response.status}: ${errBody.slice(0, 500)}`))
  }
  if (!response.body) {
    throw new Error('Gateway streaming response had no body')
  }

  const decoder = new TextDecoder()
  const upstream = response.body
  const onUsage = opts.onUsage

  return new ReadableStream<string>({
    async start(controller) {
      const reader = upstream.getReader()
      let buffer = ''
      let emittedText = false
      let lastFinishReason: string | null = null
      let sawError: string | null = null

      const processLine = (rawLine: string): 'done' | 'error' | 'continue' => {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) return 'continue'
        const data = line.slice(5).trim()
        if (data === '[DONE]') return 'done'
        try {
          const ev = JSON.parse(data) as OpenAIStreamEvent
          if (ev.error) {
            const rawMsg = typeof ev.error === 'string'
              ? ev.error
              : (ev.error.message ?? JSON.stringify(ev.error))
            sawError = redactSensitive(rawMsg).slice(0, 500)
            logError('ai/sse-stream-inline-error', { model: opts.model, error: sawError })
            if (!emittedText) {
              controller.error(new Error(`Gateway stream error: ${sawError}`))
              return 'error'
            }
            return 'done'
          }
          const choice = ev.choices?.[0]
          if (choice?.finish_reason) lastFinishReason = choice.finish_reason
          const delta = choice?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) {
            emittedText = true
            controller.enqueue(delta)
          }
          if (ev.usage && onUsage) onUsage(ev.usage)
        } catch {
          // Skip malformed SSE event — providers sometimes send keepalives
        }
        return 'continue'
      }

      try {
        let ended = false
        while (!ended) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nlIdx
          while ((nlIdx = buffer.indexOf('\n')) !== -1) {
            const rawLine = buffer.slice(0, nlIdx)
            buffer = buffer.slice(nlIdx + 1)
            const status = processLine(rawLine)
            if (status === 'error') return
            if (status === 'done') {
              ended = true
              break
            }
          }
        }
        if (!ended) {
          buffer += decoder.decode()
          if (buffer.trim()) {
            const status = processLine(buffer)
            if (status === 'error') return
          }
        }
        if (!emittedText) {
          logWarn('ai/sse-stream-empty', {
            model: opts.model,
            finishReason: lastFinishReason,
            sawError,
          })
        }
        controller.close()
      } catch (e) {
        const msg = redactSensitive(String(e))
        logError('ai/sse-stream-error', { model: opts.model, error: msg })
        if (!emittedText) {
          controller.error(new Error(`Gateway stream read error: ${msg}`))
        } else {
          controller.close()
        }
      } finally {
        try { reader.releaseLock() } catch { /* already released */ }
      }
    },
  })
}

export type PrimedChatStream = {
  firstChunk: string
  reader: ReadableStreamDefaultReader<string>
  model: string
  reasoningEffort?: ReasoningEffort
  usedFallback: boolean
}

async function primeTextStream(
  stream: ReadableStream<string>,
  model: string,
): Promise<{ firstChunk: string; reader: ReadableStreamDefaultReader<string> }> {
  const reader = stream.getReader()
  try {
    const { done, value } = await reader.read()
    if (done || !value) {
      reader.releaseLock()
      throw new Error(`Gateway stream for ${model} closed without emitting any text`)
    }
    return { firstChunk: value, reader }
  } catch (e) {
    try { reader.releaseLock() } catch { /* already released */ }
    throw e
  }
}

/**
 * Open a main-chat SSE stream and verify at least one text delta arrives before
 * returning. If the primary model fails at HTTP time, emits an inline SSE error
 * before text, or closes with zero text chunks — and a distinct `fallbackModel`
 * is provided — automatically fails over to `fallbackModel` before the caller
 * commits HTTP 200 headers to the browser.
 */
export async function openChatStreamWithFallback(opts: {
  env: Env
  model: string
  fallbackModel?: string
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
  onUsage?: (usage: unknown) => void
  onResetUsage?: () => void
}): Promise<PrimedChatStream> {
  try {
    const stream = await openGatewayChatStream({
      env: opts.env,
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      maxOutputTokens: opts.maxOutputTokens,
      reasoningEffort: opts.reasoningEffort,
      onUsage: opts.onUsage,
    })
    const primed = await primeTextStream(stream, opts.model)
    return {
      ...primed,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      usedFallback: false,
    }
  } catch (primaryErr) {
    const fallback = opts.fallbackModel && opts.fallbackModel !== opts.model
      ? opts.fallbackModel
      : null
    if (!fallback) throw primaryErr
    logWarn('ai/chat-stream-fallback', {
      primaryModel: opts.model,
      fallbackModel: fallback,
      error: errorMessage(primaryErr),
    })
    opts.onResetUsage?.()
    // Don't forward primary-model reasoningEffort to the fallback model (e.g.
    // Gemini Hydrogen's "low" effort doesn't apply to Claude Sonnet).
    const stream = await openGatewayChatStream({
      env: opts.env,
      model: fallback,
      system: opts.system,
      messages: opts.messages,
      maxOutputTokens: opts.maxOutputTokens,
      onUsage: opts.onUsage,
    })
    const primed = await primeTextStream(stream, fallback)
    return {
      ...primed,
      model: fallback,
      reasoningEffort: undefined,
      usedFallback: true,
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

export async function runGatewayImageObject<T>(opts: {
  env: Env
  model: string
  system: string
  text: string
  bytes: Uint8Array
  mediaType: string
  schema: z.ZodType<T>
  schemaName: string
  schemaDescription?: string
}): Promise<{ object: T | null; usage: unknown; raw: unknown }> {
  let result: Record<string, any>
  try {
    if (opts.model.startsWith('openai/')) {
      result = await runGatewayCompatRequest(opts.env, {
        model: opts.model,
        messages: [
          { role: 'system', content: opts.system },
          {
            role: 'user',
            content: [
              { type: 'text', text: opts.text },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${opts.mediaType};base64,${bytesToBase64(opts.bytes)}`,
                },
              },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 1200,
      })
    } else {
      const model = googleStudioModelName(opts.model)
      result = await runGatewayRequest(opts.env, {
        provider: 'google-ai-studio',
        endpoint: `v1beta/models/${model}:generateContent`,
        headers: { 'Content-Type': 'application/json' },
        query: {
          contents: [{
            role: 'user',
            parts: [
              { text: `System instructions:\n${opts.system}\n\nUser request:\n${opts.text}` },
              {
                inlineData: {
                  mimeType: opts.mediaType,
                  data: bytesToBase64(opts.bytes),
                },
              },
            ],
          }],
          generationConfig: {
            responseMimeType: 'application/json',
          },
        },
      })
    }
  } catch (e) {
    logError('ai/gateway-image-failed', { error: errorMessage(e) })
    return {
      object: null,
      usage: null,
      raw: {
        error: errorMessage(e),
        fallback: 'disabled',
      },
    }
  }
  const text = extractGatewayText(result)
  const parsed = opts.schema.safeParse(parseJsonObject(text))
  return {
    object: parsed.success ? parsed.data : null,
    usage: result.usage ?? result.usageMetadata ?? null,
    raw: result,
  }
}
