/**
 * Cloudflare AI Gateway provider for Anthropic — used by the admin copilot.
 *
 * Routes every Anthropic call through the gateway URL. The gateway billed
 * via Cloudflare's Unified Billing — no BYOK alias header is sent, no
 * direct ANTHROPIC_API_KEY worker secret is needed. The only credential
 * the worker holds is `AI_GATEWAY_TOKEN`, which authorizes the gateway
 * request itself.
 *
 * The fetch wrapper rewrites each outgoing request:
 *   - drops the `x-api-key` header the Anthropic SDK adds
 *   - sets `cf-aig-authorization: Bearer <AI_GATEWAY_TOKEN>` so the gateway
 *     accepts the call
 *   - leaves the request body verbatim (gateway forwards it to Anthropic
 *     and bills CF unified billing)
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import type { Env } from './types'
import { getAiGatewayProviderBaseURL, getAiGatewayToken } from './ai'

export function gatewayAnthropicFetch(token: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    headers.delete('x-api-key')
    if (token) headers.set('cf-aig-authorization', `Bearer ${token}`)
    return fetch(input, { ...init, headers })
  }
}

export type AnthropicProviderResult =
  | { ok: true; anthropic: ReturnType<typeof createAnthropic> }
  | { ok: false; status: number; body: { error: string; code?: string } }

/**
 * Build an Anthropic provider for the admin copilot. Always routes through
 * the AI Gateway with unified billing — no BYOK, no direct key.
 *
 * Returns `{ ok: false }` only when `AI_GATEWAY_TOKEN` is missing. The
 * citizen chat bot (Workers AI path in lib/ai.ts) continues to work even
 * in that error case.
 */
export function buildAnthropicProvider(env: Env): AnthropicProviderResult {
  const gatewayToken = getAiGatewayToken(env)
  if (!gatewayToken) {
    return { ok: false, status: 500, body: { error: 'AI_GATEWAY_TOKEN not configured' } }
  }

  return {
    ok: true,
    anthropic: createAnthropic({
      // The Anthropic SDK requires *some* apiKey to construct; the gateway
      // fetch wrapper strips the `x-api-key` header it would otherwise add,
      // so this value never reaches a network. Kept as a placeholder string
      // so the SDK doesn't error on init.
      apiKey: 'cloudflare-ai-gateway',
      baseURL: getAiGatewayProviderBaseURL(env, 'anthropic'),
      fetch: gatewayAnthropicFetch(gatewayToken),
      name: 'cloudflare-ai-gateway-anthropic',
    }),
  }
}
