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
  test('CORS: real non-localhost origin gets correct Access-Control-Allow-Origin', async ({ page }) => {
    let capturedAcao: string | null = null

    await page.route(`${TENANT_BASE}/api/config`, async (route) => {
      const response = await route.fetch()
      capturedAcao = response.headers()['access-control-allow-origin'] ?? null
      await route.fulfill({ response })
    })

    await page.goto(SMOKE_PAGE)
    await page.waitForSelector('#rbot-widget-button', { timeout: 15_000 })

    expect(capturedAcao).toBe(SMOKE_ORIGIN)
  })

  // F. Session create: POST /api/sessions succeeds from a real allowed origin.
  // Verifies the full chat API path is live end-to-end. Creates a stub session
  // (no messages sent) that the daily retention sweep will clean up.
  test('POST /api/sessions: chat API live from real allowed origin', async ({ page }) => {
    let capturedStatus: number | null = null
    let capturedId: string | null = null

    await page.route(`${TENANT_BASE}/api/sessions`, async (route) => {
      if (route.request().method() === 'POST') {
        const response = await route.fetch()
        capturedStatus = response.status()
        try {
          const body = await response.json() as { id?: string }
          capturedId = body.id ?? null
        } catch { /* ignore parse errors */ }
        await route.fulfill({ response })
      } else {
        await route.continue()
      }
    })

    await page.goto(SMOKE_PAGE)
    await page.waitForSelector('#rbot-widget-button', { timeout: 15_000 })
    await page.click('#rbot-widget-button')
    await page.waitForFunction(
      () => document.querySelector('.rbot-widget-pane') !== null,
      { timeout: 10_000 },
    )

    expect(capturedStatus).toBe(200)
    expect(typeof capturedId).toBe('string')
  })

})
