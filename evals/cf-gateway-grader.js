/**
 * Promptfoo grader provider backed by Cloudflare AI Gateway.
 *
 * The built-in promptfoo cloudflare-gateway Anthropic provider still goes
 * through the Anthropic SDK and requires ANTHROPIC_API_KEY. This provider
 * calls the Gateway OpenAI-compatible endpoint directly, relying on the
 * provider key stored in Cloudflare AI Gateway instead of local provider keys.
 */

const DEFAULT_GATEWAY_ID = 'default'
const DEFAULT_MODEL = 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast'

function clean(value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed === 'REPLACE_VIA_GEN_WRANGLER' ? '' : trimmed
}

function required(name, value) {
  const v = clean(value)
  if (!v) throw new Error(`${name} is required for Cloudflare AI Gateway grading`)
  return v
}

function redact(value) {
  return String(value)
    .replace(/cfut_[A-Za-z0-9_-]+/g, 'cfut_[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[REDACTED]')
}

class CloudflareGatewayGrader {
  constructor(options = {}) {
    const config = options.config || {}
    this.accountId = clean(config.accountId) ||
      clean(process.env.CLOUDFLARE_ACCOUNT_ID) ||
      clean(process.env.ACCOUNT_ID) ||
      clean(process.env.AI_GATEWAY_ACCOUNT_ID)
    this.gatewayId = clean(config.gatewayId) ||
      clean(process.env.CLOUDFLARE_GATEWAY_ID) ||
      clean(process.env.AI_GATEWAY_ID) ||
      DEFAULT_GATEWAY_ID
    this.token = clean(config.cfAigToken) ||
      clean(process.env.AI_GATEWAY_TOKEN) ||
      clean(process.env.CF_AIG_TOKEN)
    this.model = clean(config.model) || clean(process.env.EVAL_JUDGE_MODEL) || DEFAULT_MODEL
    this.byokAlias = clean(config.byokAlias) || clean(process.env.AI_GATEWAY_ANTHROPIC_BYOK_ALIAS)
  }

  id() {
    return `cloudflare-gateway-grader:${this.model}`
  }

  async callApi(prompt) {
    const accountId = required('CLOUDFLARE_ACCOUNT_ID', this.accountId)
    const token = required('AI_GATEWAY_TOKEN', this.token)
    const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.gatewayId}/compat/chat/completions`
    const headers = {
      'Content-Type': 'application/json',
      'cf-aig-authorization': `Bearer ${token}`,
    }
    if (this.byokAlias) headers['cf-aig-byok-alias'] = this.byokAlias

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      const text = await response.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        // Keep json null.
      }

      if (!response.ok) {
        const message = json?.error?.message || json?.error || text.slice(0, 500)
        return { error: `Cloudflare AI Gateway grader failed: ${redact(message)}`, output: '' }
      }

      const output = json?.choices?.[0]?.message?.content || ''
      return { output }
    } catch (err) {
      return {
        error: `Cloudflare AI Gateway grader failed: ${redact(err instanceof Error ? err.message : err)}`,
        output: '',
      }
    }
  }
}

export default CloudflareGatewayGrader
