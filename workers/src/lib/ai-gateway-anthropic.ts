/**
 * Cloudflare AI Gateway fetch wrapper + provider builder for Anthropic.
 *
 * Extracted from workers/src/routes/agent.ts so the route file can stay
 * focused on request handling. When the admin copilot is configured to
 * route through the AI Gateway (no direct ANTHROPIC_API_KEY), the fetch
 * wrapper rewrites each outgoing request so:
 *   - the `x-api-key` header the Anthropic SDK adds is removed
 *   - `cf-aig-authorization: Bearer <token>` replaces it
 *   - `cf-aig-byok-alias: <alias>` tells the gateway which BYOK to use
 *
 * The provider builder picks between direct key and BYOK gateway routing
 * based on env, and returns a discriminated result the route handler can
 * either use directly or 503 on.
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import type { Env } from './types'
import {
  DEFAULT_ANTHROPIC_AI_GATEWAY_BYOK_ALIAS,
  getAiGatewayProviderBaseURL,
  getAiGatewayToken,
} from './ai'

export function gatewayAnthropicFetch(token: string, alias: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    headers.delete('x-api-key')
    if (token) headers.set('cf-aig-authorization', `Bearer ${token}`)
    if (alias) headers.set('cf-aig-byok-alias', alias)
    return fetch(input, { ...init, headers })
  }
}

export type AnthropicProviderResult =
  | {
      ok: true
      anthropic: ReturnType<typeof createAnthropic>
      byokAlias: string
      usingDirectKey: boolean
    }
  | { ok: false; status: number; body: { error: string; code?: string } }

/**
 * Build an Anthropic provider for the admin copilot.
 *
 * Two ways the platform can be wired up:
 *   (a) Configure a BYOK in the Cloudflare AI Gateway dashboard, give it
 *       an alias (e.g. "anthropic"), and set
 *       AI_GATEWAY_ANTHROPIC_BYOK_ALIAS=anthropic in wrangler vars.
 *   (b) Set ANTHROPIC_API_KEY as a worker secret. The direct path
 *       below uses the key directly and bypasses the gateway.
 *
 * Direct key wins when set — that's the deployment posture for unified
 * billing (skip gateway BYOK). BYOK alias remains available for
 * deployments that want gateway-mediated routing + usage tracking.
 *
 * If neither is configured, returns `{ ok: false }` with a 503 body the
 * route can return verbatim. The citizen chat bot continues to work
 * (uses Workers AI).
 */
export function buildAnthropicProvider(env: Env): AnthropicProviderResult {
  const gatewayToken = getAiGatewayToken(env)
  if (!gatewayToken) {
    return { ok: false, status: 500, body: { error: 'AI_GATEWAY_TOKEN not configured' } }
  }

  const byokAlias = env.AI_GATEWAY_ANTHROPIC_BYOK_ALIAS || DEFAULT_ANTHROPIC_AI_GATEWAY_BYOK_ALIAS
  const directAnthropicKey = env.ANTHROPIC_API_KEY

  if (directAnthropicKey) {
    return {
      ok: true,
      anthropic: createAnthropic({ apiKey: directAnthropicKey }),
      byokAlias: '',
      usingDirectKey: true,
    }
  }
  if (byokAlias) {
    return {
      ok: true,
      anthropic: createAnthropic({
        apiKey: 'cloudflare-ai-gateway',
        baseURL: getAiGatewayProviderBaseURL(env, 'anthropic'),
        fetch: gatewayAnthropicFetch(gatewayToken, byokAlias),
        name: 'cloudflare-ai-gateway-anthropic',
      }),
      byokAlias,
      usingDirectKey: false,
    }
  }

  console.error('[agent] Admin assistant not configured: set AI_GATEWAY_ANTHROPIC_BYOK_ALIAS or ANTHROPIC_API_KEY')
  return {
    ok: false,
    status: 503,
    body: {
      error: 'Admin assistant not configured. Anthropic API key required — either set AI_GATEWAY_ANTHROPIC_BYOK_ALIAS to a BYOK alias configured in the AI Gateway dashboard, or set ANTHROPIC_API_KEY as a worker secret. The citizen chat bot continues to work (uses Workers AI).',
      code: 'AGENT_NOT_CONFIGURED',
    },
  }
}
