/**
 * Promptfoo provider for wildcare-bot (Cloudflare Workers)
 *
 * Calls the Workers API directly using the Vercel AI SDK stream format.
 * Run `make cf-dev` first, then `make eval` or `make eval-site`.
 *
 * Usage in promptfooconfig.yaml:
 *   providers:
 *     - id: file://evals/provider.js
 *       config:
 *         baseUrl: http://localhost:8787
 *         # Optional (local dev only) — score a specific model / thinking level
 *         # against the same running worker. Used by `make eval-compare`.
 *         model: google-ai-studio/gemini-4-hydrogen
 *         reasoningEffort: low        # none|minimal|low|medium|high|xhigh|default
 *
 * Override URL at runtime:
 *   WORKERS_BASE=https://your-worker.workers.dev make eval
 */

import { costFor, normalizeUsage } from './model-pricing.js'

// Must match EVAL_USAGE_MARKER in workers/src/lib/eval-overrides.ts.
const USAGE_MARKER = '\n\u001eEVAL_USAGE '

class WorkersProvider {
  constructor(options) {
    this.baseUrl = process.env.WORKERS_BASE || options.config?.baseUrl || 'http://localhost:8787'
    this.tenantSlug = process.env.EVAL_TENANT_SLUG || options.config?.tenantSlug || 'wildcare'
    this.origin = process.env.EVAL_ORIGIN || options.config?.origin || 'http://localhost:8787'
    this.model = options.config?.model
    this.reasoningEffort = options.config?.reasoningEffort
    this.label = options.label
  }

  id() {
    if (!this.model) return 'workers:wildcare'
    return `workers:${this.model}${this.reasoningEffort ? `@${this.reasoningEffort}` : ''}`
  }

  async callApi(prompt, context) {
    // Local `wrangler dev` occasionally drops a request (bare 503 from the
    // runtime, or a reset stream) under concurrent load. Retry the whole
    // conversation in a fresh session so infra noise isn't scored as a model failure.
    let last
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await this.callOnce(prompt, context)
      if (!last.error || !/: 503|terminated|fetch failed|ECONNRESET/i.test(last.error)) return last
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
    return last
  }

  async callOnce(prompt, _context) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        Origin: this.origin,
        'X-Tenant-Slug': this.tenantSlug,
        // Ignored by the worker outside local dev; harmless to always send.
        'X-Eval-Report-Usage': '1',
      }
      if (this.model) headers['X-Eval-Model'] = this.model
      if (this.reasoningEffort) headers['X-Eval-Reasoning-Effort'] = this.reasoningEffort

      const sessionRes = await fetch(`${this.baseUrl}/api/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      })
      if (!sessionRes.ok) throw new Error(`Session create failed: ${sessionRes.status}`)
      const session = await sessionRes.json()

      // Multi-turn support: split on ||| to send multiple messages in sequence.
      // The final response (from the last turn) is returned for assertion.
      const turns = prompt.split('|||').map(t => t.trim()).filter(Boolean)

      let fullResponse = ''
      const tokenUsage = { prompt: 0, completion: 0, cached: 0, total: 0, numRequests: 0 }
      let reasoningTokens = 0
      let cost = 0
      let costKnown = true
      let servedModel = this.model
      let servedEffort = this.reasoningEffort
      for (const turn of turns) {
        const msgRes = await fetch(`${this.baseUrl}/api/sessions/${session.id}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ message: turn }),
        })
        if (!msgRes.ok) throw new Error(`Message failed: ${msgRes.status}`)

        let text = await msgRes.text()
        const markerAt = text.lastIndexOf(USAGE_MARKER)
        if (markerAt !== -1) {
          try {
            const report = JSON.parse(text.slice(markerAt + USAGE_MARKER.length))
            servedModel = report.model
            servedEffort = report.reasoning_effort
            const u = normalizeUsage(report.usage)
            tokenUsage.prompt += u.prompt
            tokenUsage.completion += u.completion
            tokenUsage.cached += u.cached
            tokenUsage.total += u.total
            tokenUsage.numRequests += 1
            reasoningTokens += u.reasoning
            const turnCost = costFor(report.model, report.usage)
            if (turnCost === null || !report.usage) costKnown = false
            else cost += turnCost
          } catch {
            costKnown = false
          }
          text = text.slice(0, markerAt)
        } else {
          costKnown = false
        }
        fullResponse = text
      }
      if (!fullResponse) throw new Error('No response content from Worker')

      return {
        output: fullResponse,
        tokenUsage,
        ...(costKnown ? { cost } : {}),
        metadata: { model: servedModel, reasoningEffort: servedEffort, reasoningTokens, turns: turns.length },
      }
    } catch (err) {
      return { error: err.message, output: '' }
    }
  }
}


export { WorkersProvider as default }
