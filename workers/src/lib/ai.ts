import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import type { Env } from './types'

export const DEFAULT_MAIN_CHAT_MODEL = 'anthropic/claude-sonnet-4-6'
export const DEFAULT_EVAL_JUDGE_MODEL = 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast'
export const DEFAULT_PHOTO_RECOGNIZER_MODEL = 'openai/gpt-4.1-mini'
export const DEFAULT_AI_GATEWAY_ID = 'default'

function clean(value: string | undefined | null): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed === 'REPLACE_VIA_GEN_WRANGLER' ? '' : trimmed
}

export function getMainChatModelName(env: Env): string {
  return clean(env.MAIN_CHAT_MODEL) || DEFAULT_MAIN_CHAT_MODEL
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
  const token = getAiGatewayToken(env)
  if (!token) {
    throw new Error('Cloudflare AI Gateway token is not configured. Set AI_GATEWAY_TOKEN.')
  }
  const response = await fetch(`${getAiGatewayBaseURL(env)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cf-aig-authorization': `Bearer ${token}`,
    },
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

  const token = getAiGatewayToken(opts.env)
  if (!token) {
    throw new Error('Cloudflare AI Gateway token is not configured. Set AI_GATEWAY_TOKEN.')
  }

  const response = await fetch(`${getAiGatewayBaseURL(opts.env)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cf-aig-authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: openAiMessages(opts.system, opts.messages),
      stream: true,
      ...(opts.maxOutputTokens ? { max_tokens: opts.maxOutputTokens } : {}),
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
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nlIdx
          while ((nlIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nlIdx).trim()
            buffer = buffer.slice(nlIdx + 1)
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') {
              controller.close()
              return
            }
            try {
              const ev = JSON.parse(data) as Record<string, any>
              const delta = ev.choices?.[0]?.delta?.content
              if (typeof delta === 'string' && delta.length > 0) {
                controller.enqueue(delta)
              }
              if (ev.usage && onUsage) onUsage(ev.usage)
            } catch {
              // Skip malformed SSE event — providers sometimes send keepalives
            }
          }
        }
        controller.close()
      } catch (e) {
        console.error('[ai] SSE stream error:', redactSensitive(String(e)))
        controller.close()
      } finally {
        try { reader.releaseLock() } catch { /* already released */ }
      }
    },
  })
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
    console.error('[ai] Gateway image failed; failing closed without inferred metadata:', errorMessage(e))
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
