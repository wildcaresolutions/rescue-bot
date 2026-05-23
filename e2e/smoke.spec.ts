import { test, expect } from '@playwright/test'

// Production smoke tests for wildcaresolutions.org.
//
// WHY page.evaluate() INSTEAD OF THE request FIXTURE:
// Cloudflare's Bot Fight Mode blocks HTTP from GitHub Actions runner IPs.
// curl, node-fetch, and Playwright's `request` fixture all use Node.js TLS
// stacks with a JA3 fingerprint CF flags as bot traffic (returns 403). The
// only reliable workaround is page.evaluate(), which runs fetch() inside a
// real Chromium instance whose TLS fingerprint matches real Chrome. This is
// the same reason the widget-e2e job works in CI.
//
// Rule: any fetch to wildcaresolutions.org or embed.wildcaresolutions.org
// MUST go through page.evaluate(). Never use the `request` fixture for
// those hosts.
//
// TRUE CORS TEST (tests E + F):
// The smoke page at https://smoke.wildcaresolutions.org serves the embed
// widget. When Playwright navigates there, the widget's API calls carry
// Origin: https://smoke.wildcaresolutions.org — a real non-localhost origin
// that goes through the full isOriginAllowed() DB lookup against
// allowed_domains. This is exactly the path Jean's discoverwildcare.org
// visits exercise.
//
// One-time setup required: smoke.wildcaresolutions.org must be seeded in
// allowed_domains for the wildcare tenant. The `smoke` CI job handles this
// idempotently with INSERT OR IGNORE before running these tests.

const SMOKE_EMBED_URL =
  process.env.SMOKE_EMBED_URL ?? 'https://embed.wildcaresolutions.org/v1.js'
const SMOKE_TENANT = process.env.SMOKE_TENANT ?? 'wildcare'

function tenantBaseUrl(): string {
  try {
    const u = new URL(SMOKE_EMBED_URL)
    const host = u.hostname.replace(/^embed\./, `${SMOKE_TENANT}.`)
    return `${u.protocol}//${host}`
  } catch {
    return `https://${SMOKE_TENANT}.wildcaresolutions.org`
  }
}

function smokePageUrl(): string {
  try {
    const u = new URL(SMOKE_EMBED_URL)
    const host = u.hostname.replace(/^embed\./, 'smoke.')
    return `${u.protocol}//${host}/`
  } catch {
    return 'https://smoke.wildcaresolutions.org/'
  }
}

const TENANT_BASE = tenantBaseUrl()
const SMOKE_PAGE = smokePageUrl()
const SMOKE_ORIGIN = (() => {
  try { return new URL(SMOKE_PAGE).origin } catch { return 'https://smoke.wildcaresolutions.org' }
})()

const PLATFORM_BASE = (() => {
  try {
    const u = new URL(SMOKE_EMBED_URL)
    return `${u.protocol}//${u.hostname.replace(/^embed\./, '')}`
  } catch {
    return 'https://wildcaresolutions.org'
  }
})()

test.describe('Production smoke tests', () => {

  // A. Health — all four dependencies must report healthy.
  // Navigate directly to /health (same-origin) so no CORS needed.
  test('health endpoint: all services healthy', async ({ page }) => {
    await page.goto(`${PLATFORM_BASE}/health`)
    const body = await page.evaluate(() => JSON.parse(document.body.innerText))

    expect(body).toMatchObject({
      status: 'healthy',
      database: 'healthy',
      vectorize: 'healthy',
      storage: 'healthy',
    })
  })

  // B. CDN: v1.js is deployed, is valid JS, and contains widget bootstrap.
  test('CDN: v1.js serves widget JS', async ({ page }) => {
    await page.goto(new URL(SMOKE_EMBED_URL).origin, { waitUntil: 'commit' })
    const result = await page.evaluate(async (url) => {
      const res = await fetch(url)
      const body = await res.text()
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        bodyLength: body.length,
        hasButtonId: body.includes('rbot-widget-button'),
      }
    }, SMOKE_EMBED_URL)

    expect(result.status).toBe(200)
    expect(result.contentType).toContain('javascript')
    expect(result.hasButtonId).toBe(true)
    expect(result.bodyLength).toBeGreaterThan(50_000)
  })

  // C. CDN: widget.js (the max-age=300 latest alias) also loads.
  test('CDN: widget.js latest alias serves', async ({ page }) => {
    const widgetUrl = SMOKE_EMBED_URL.replace(/\/v\d+\.js$/, '/widget.js')
    await page.goto(new URL(SMOKE_EMBED_URL).origin, { waitUntil: 'commit' })
    const result = await page.evaluate(async (url) => {
      const res = await fetch(url)
      return { status: res.status, bodyLength: (await res.text()).length }
    }, widgetUrl)

    expect(result.status).toBe(200)
    expect(result.bodyLength).toBeGreaterThan(50_000)
  })

  // D. /api/config: Worker is up, returns real tenant data, embed_host wired.
  test('/api/config returns tenant data', async ({ page }) => {
    await page.goto(SMOKE_PAGE, { waitUntil: 'commit' })
    const result = await page.evaluate(async (url) => {
      const res = await fetch(url)
      return { status: res.status, body: await res.json() }
    }, `${TENANT_BASE}/api/config`)

    expect(result.status).toBe(200)
    expect(result.body.platform).toBe(false)
    expect(result.body.name).toBeTruthy()
    expect(result.body.embed_host).toBeTruthy()
  })

  // E. TRUE CORS: smoke.wildcaresolutions.org origin → ACAO header equals that
  // origin exactly. This proves isOriginAllowed() ran a real DB lookup against
  // allowed_domains and found the domain — the identical code path Jean's
  // browser exercises from discoverwildcare.org. Not localhost. Not a stub.
  //
  // Uses page.waitForResponse() instead of waitForSelector so we don't depend
  // on the widget button being visible (Cloudflare challenge pages in CI can
  // briefly hide elements while the challenge resolves). The widget makes its
  // /api/config call automatically on load regardless of button visibility.
  // page.waitForResponse() reads raw response headers before CORS filtering.
  test('CORS: real non-localhost origin gets correct Access-Control-Allow-Origin', async ({ page }) => {
    // Arm the response waiter BEFORE navigating so we don't miss the request.
    const configResponse = page.waitForResponse(
      r => r.url().includes('/api/config') && r.request().method() === 'GET',
      { timeout: 20_000 },
    )
    await page.goto(SMOKE_PAGE, { waitUntil: 'commit', timeout: 30_000 })
    const response = await configResponse
    const acao = response.headers()['access-control-allow-origin'] ?? null
    expect(acao).toBe(SMOKE_ORIGIN)
  })

  // F. Session create: POST /api/sessions succeeds from the smoke origin.
  // Verifies the full chat API path is live. We POST directly via page.evaluate()
  // from the smoke page — the browser automatically sends Origin: smoke.* and
  // the CORS check fires against the real allowed_domains DB. If the origin
  // isn't allowed, fetch() throws (CORS error) and status is -1. status 200
  // implies both the API is live AND CORS allowed the request.
  //
  // This avoids the button-click approach (which had a race: waitForFunction
  // checking `pane !== null` resolved immediately since the pane is always in
  // the DOM, causing the page to close while the route callback was in flight).
  test('POST /api/sessions: chat API live from real allowed origin', async ({ page }) => {
    await page.goto(SMOKE_PAGE, { waitUntil: 'networkidle', timeout: 30_000 })

    const result = await page.evaluate(async ([sessUrl, tenantSlug]: [string, string]) => {
      try {
        const res = await fetch(sessUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-Slug': tenantSlug },
          body: '{}',
        })
        const body = await res.json() as { id?: string }
        return { status: res.status, id: body.id ?? null }
      } catch (e) {
        return { status: -1, id: null, error: String(e) }
      }
    }, [TENANT_BASE + '/api/sessions', SMOKE_TENANT] as [string, string])

    expect(result.status).toBe(200)
    expect(typeof result.id).toBe('string')
  })

})
