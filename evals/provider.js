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
 *
 * Override URL at runtime:
 *   WORKERS_BASE=https://your-worker.workers.dev make eval
 */

class WorkersProvider {
  constructor(options) {
    this.baseUrl = process.env.WORKERS_BASE || options.config?.baseUrl || 'http://localhost:8787'
    this.tenantSlug = process.env.EVAL_TENANT_SLUG || options.config?.tenantSlug || 'wildcare'
    this.origin = process.env.EVAL_ORIGIN || options.config?.origin || 'http://localhost:8787'
  }

  id() {
    return 'workers:wildcare'
  }

  async callApi(prompt, _context) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        Origin: this.origin,
        'X-Tenant-Slug': this.tenantSlug,
      }

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
      for (const turn of turns) {
        const msgRes = await fetch(`${this.baseUrl}/api/sessions/${session.id}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ message: turn }),
        })
        if (!msgRes.ok) throw new Error(`Message failed: ${msgRes.status}`)

        fullResponse = await msgRes.text()
      }
      if (!fullResponse) throw new Error('No response content from Worker')

      return { output: fullResponse }
    } catch (err) {
      return { error: err.message, output: '' }
    }
  }
}


export { WorkersProvider as default }
