import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateObject } from 'ai'
import { z } from 'zod'
import {
  DEFAULT_AI_GATEWAY_ID,
  DEFAULT_MAIN_CHAT_MODEL,
  DEFAULT_PHOTO_RECOGNIZER_MODEL,
  createAiGatewayProvider,
  getAiGatewayBaseURL,
  getAiGatewayId,
  getAiGatewayToken,
  getMainChatModelName,
  getPhotoRecognizerModelName,
  runGatewayChatText,
  runGatewayImageObject,
} from '../src/lib/ai'
import type { Env } from '../src/lib/types'

const FAKE_CLOUDFLARE_TOKEN = ['cfut', 'secret', 'token'].join('_')

const stubRateLimit: RateLimit = { limit: async () => ({ success: true }) }

function env(overrides: Partial<Env> = {}): Env {
  return {
    AI: {} as Env['AI'],
    VECTORIZE: {} as Env['VECTORIZE'],
    DB: {} as Env['DB'],
    R2: {} as Env['R2'],
    MEDIA_BUCKET: {} as Env['MEDIA_BUCKET'],
    ASSETS: {} as Env['ASSETS'],
    AI_GATEWAY_ACCOUNT_ID: '',
    AI_GATEWAY_ID: '',
    AI_GATEWAY_TOKEN: '',
    ENVIRONMENT: 'dev',
    REPORT_FROM_EMAIL: '',
    SIGNING_SECRET: '',
    RL_IP_CHAT: stubRateLimit,
    RL_IP_SESSION: stubRateLimit,
    RL_TENANT: stubRateLimit,
    ...overrides,
  }
}

describe('ai provider config', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to the selected main and photo models', () => {
    expect(getMainChatModelName(env())).toBe(DEFAULT_MAIN_CHAT_MODEL)
    expect(getPhotoRecognizerModelName(env())).toBe(DEFAULT_PHOTO_RECOGNIZER_MODEL)
    // Default must NOT be a workers-ai model (those are for evals only)
    expect(DEFAULT_MAIN_CHAT_MODEL).not.toMatch(/^workers-ai\//)
    expect(DEFAULT_PHOTO_RECOGNIZER_MODEL).toMatch(/^openai\//)
  })

  it('allows per-env model overrides', () => {
    expect(getMainChatModelName(env({ MAIN_CHAT_MODEL: 'anthropic/claude-sonnet-4-6' })))
      .toBe('anthropic/claude-sonnet-4-6')
    expect(getPhotoRecognizerModelName(env({ PHOTO_RECOGNIZER_MODEL: 'google-ai-studio/gemini-3.1-flash-image-preview' })))
      .toBe('google-ai-studio/gemini-3.1-flash-image-preview')
  })

  it('builds the Cloudflare AI Gateway OpenAI-compatible base URL', () => {
    expect(() => getAiGatewayBaseURL(env())).toThrow(/AI_GATEWAY_ACCOUNT_ID/)
    expect(getAiGatewayBaseURL(env({
      AI_GATEWAY_ACCOUNT_ID: 'acct',
      AI_GATEWAY_ID: 'wildcare',
    }))).toBe('https://gateway.ai.cloudflare.com/v1/acct/wildcare/compat')
    expect(getAiGatewayBaseURL(env({
      AI_GATEWAY_ACCOUNT_ID: 'acct',
      AI_GATEWAY_ID: '',
    }))).toBe('https://gateway.ai.cloudflare.com/v1/acct/default/compat')
    expect(getAiGatewayId(env())).toBe(DEFAULT_AI_GATEWAY_ID)
  })

  it('ignores generated wrangler stub placeholders', () => {
    const stubbed = env({
      AI_GATEWAY_ACCOUNT_ID: 'REPLACE_VIA_GEN_WRANGLER',
      AI_GATEWAY_ID: 'REPLACE_VIA_GEN_WRANGLER',
      AI_GATEWAY_TOKEN: 'REPLACE_VIA_GEN_WRANGLER',
      MAIN_CHAT_MODEL: 'REPLACE_VIA_GEN_WRANGLER',
      PHOTO_RECOGNIZER_MODEL: 'REPLACE_VIA_GEN_WRANGLER',
    })
    expect(() => getAiGatewayBaseURL(stubbed)).toThrow(/AI_GATEWAY_ACCOUNT_ID/)
    expect(getAiGatewayToken(stubbed)).toBe('')
    expect(getMainChatModelName(stubbed)).toBe(DEFAULT_MAIN_CHAT_MODEL)
    expect(getPhotoRecognizerModelName(stubbed)).toBe(DEFAULT_PHOTO_RECOGNIZER_MODEL)
  })

  it('requires a token only when the Worker AI binding is unavailable', async () => {
    await expect(createAiGatewayProvider(env())).rejects.toThrow(/AI_GATEWAY_TOKEN/)
    await expect(createAiGatewayProvider(env({
      AI_GATEWAY_TOKEN: 'cf-token',
    }))).rejects.toThrow(/AI_GATEWAY_ACCOUNT_ID/)
    await expect(createAiGatewayProvider(env({
      AI_GATEWAY_ACCOUNT_ID: 'acct',
      AI_GATEWAY_ID: 'wildcare',
      AI_GATEWAY_TOKEN: 'cf-token',
    }))).resolves.toBeTruthy()
  })

  it('uses the Worker AI Gateway binding URL without requiring a token', async () => {
    const gateway = await createAiGatewayProvider(env({
      AI: {
        gateway: (id: string) => ({
          getUrl: async (provider?: string) => `https://gateway.ai.cloudflare.com/v1/acct/${id}/${provider}`,
        }),
      } as unknown as Env['AI'],
      AI_GATEWAY_ID: 'wildcare',
      AI_GATEWAY_TOKEN: '',
    }))
    expect(gateway).toBeTruthy()
  })

  it('uses OpenAI chat-completions image_url blocks for image inputs', async () => {
    let requestUrl = ''
    let requestBody: any = null
    let cfGatewayAuth: string | null = null
    let sentProviderAuth = false
    const fakeFetch: typeof fetch = async (input, init) => {
      requestUrl = String(input)
      requestBody = JSON.parse(String(init?.body))
      const requestHeaders = new Headers(init?.headers)
      cfGatewayAuth = requestHeaders.get('cf-aig-authorization')
      sentProviderAuth = requestHeaders.has('authorization')
      return new Response(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'google-ai-studio/gemini-3.1-flash-image-preview',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '{"accepted_image":true}',
          },
        }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const gateway = await createAiGatewayProvider(env({
      AI_GATEWAY_ACCOUNT_ID: 'acct',
      AI_GATEWAY_ID: 'wildcare',
      AI_GATEWAY_TOKEN: 'cf-token',
    }), { fetch: fakeFetch })

    await generateObject({
      model: gateway.chat('google-ai-studio/gemini-3.1-flash-image-preview'),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Return metadata for this image.' },
          { type: 'image', image: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
        ],
      }],
      schema: z.object({ accepted_image: z.boolean() }),
      schemaName: 'photo_metadata_smoke',
      providerOptions: {
        openai: {
          strictJsonSchema: false,
        },
      },
    })

    expect(requestUrl).toBe('https://gateway.ai.cloudflare.com/v1/acct/wildcare/compat/chat/completions')
    expect(cfGatewayAuth).toBe('Bearer cf-token')
    expect(sentProviderAuth).toBe(false)
    expect(requestBody?.model).toBe('google-ai-studio/gemini-3.1-flash-image-preview')
    expect(requestBody?.messages[0].content[1]).toMatchObject({
      type: 'image_url',
      image_url: {
        url: expect.stringMatching(/^data:image\/png;base64,/),
      },
    })
    expect(requestBody?.response_format.type).toBe('json_schema')
    expect(requestBody?.response_format.json_schema.strict).toBe(false)
  })

  it('authenticates compat image calls to Cloudflare without sending the gateway token as a provider key', async () => {
    let cfGatewayAuth: string | null = null
    let sentProviderAuth = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const requestHeaders = new Headers(init?.headers)
      cfGatewayAuth = requestHeaders.get('cf-aig-authorization')
      sentProviderAuth = requestHeaders.has('authorization')
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: '{"species":"unknown"}',
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    await runGatewayImageObject({
      env: env({
        AI_GATEWAY_ACCOUNT_ID: 'acct',
        AI_GATEWAY_ID: 'wildcare',
        AI_GATEWAY_TOKEN: 'cf-token',
      }),
      model: 'openai/gpt-4.1-mini',
      system: 'Return JSON.',
      text: 'Classify this image.',
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png',
      schema: z.object({ species: z.string() }),
      schemaName: 'photo_metadata',
    })

    expect(cfGatewayAuth).toBe('Bearer cf-token')
    expect(sentProviderAuth).toBe(false)
  })

  it('fails image metadata closed when the gateway image call fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: `provider key missing: ${FAKE_CLOUDFLARE_TOKEN}` },
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await runGatewayImageObject({
      env: env({
        AI: {
          run: vi.fn(() => {
            throw new Error('Workers AI vision fallback must not be called')
          }),
        } as unknown as Env['AI'],
        AI_GATEWAY_ACCOUNT_ID: 'acct',
        AI_GATEWAY_ID: 'wildcare',
        AI_GATEWAY_TOKEN: 'cf-token',
      }),
      model: 'openai/gpt-4.1-mini',
      system: 'Return JSON.',
      text: 'Classify this image.',
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png',
      schema: z.object({ species: z.string() }),
      schemaName: 'photo_metadata',
    })

    expect(result.object).toBeNull()
    expect(result.usage).toBeNull()
    expect(result.raw).toMatchObject({
      error: 'provider key missing: cfut_[REDACTED]',
      fallback: 'disabled',
    })
  })

  it('does not hide chat gateway failures behind direct Workers AI fallback', async () => {
    const aiRun = vi.fn(() => {
      throw new Error('direct Workers AI fallback must not be called')
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: `gateway auth failed: ${FAKE_CLOUDFLARE_TOKEN}` },
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(runGatewayChatText({
      env: env({
        AI: { run: aiRun } as unknown as Env['AI'],
        AI_GATEWAY_ACCOUNT_ID: 'acct',
        AI_GATEWAY_ID: 'wildcare',
        AI_GATEWAY_TOKEN: 'cf-token',
      }),
      model: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toThrow('gateway auth failed: cfut_[REDACTED]')
    expect(aiRun).not.toHaveBeenCalled()
  })
})
