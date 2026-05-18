import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'

// Cross-origin E2E coverage for the embeddable chat widget.
//
// The widget is dropped onto third-party sites (e.g. discoverwildcare.org)
// via a one-liner script tag. None of this can be exercised at the
// unit/integration layer — the browser's CORS enforcement on every API call
// back to the worker, combined with the worker's allowed_domains policy, is
// what makes (or breaks) the embed.
//
// This spec boots a tiny local HTTP server on a random localhost port and
// serves a page that embeds the prod widget at
// `https://embed.wildcaresolutions.org/v1.js`. Because the test page and the
// worker live on different hostnames, the browser treats every fetch as
// genuinely cross-origin — same regime Jean's site (discoverwildcare.org)
// experiences. The worker's CORS allow-list permits `localhost` automatically
// (see workers/src/index.ts), so the test page passes the policy.
//
// What we test:
//   1. Public visitor (no WP/Divi body classes) sees the launcher.
//   2. Divi public visitor (et_divi_theme present) sees the launcher.
//   3. WP-admin logged-in (logged-in class) is hidden — by design.
//   4. Divi visual-builder mode (?et_fb=1) is hidden — by design.
//   5. Clicking the launcher opens the chat pane without console errors.
//
// (1) + (2) are the regression cases for the 2026-05-18 "bot didn't fire on
// discoverwildcare.org" incident, where a malformed inline wrapper threw
// `ReferenceError: skipWidget is not defined` and silently broke the widget
// for every non-logged-in visitor. The canonical one-line snippet this spec
// uses has no such wrapper — visibility rules come from the server-side
// `embedOptions.cms` config at widget load time.

const WIDGET_SRC = process.env.WIDGET_SRC ?? 'https://embed.wildcaresolutions.org/v1.js'
const WIDGET_TENANT = process.env.WIDGET_TENANT ?? 'wildcare'

function htmlFor(opts: { bodyClass?: string } = {}): string {
  const bodyClass = opts.bodyClass ? ` class="${opts.bodyClass}"` : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>partner</title></head>
<body${bodyClass}><h1>Partner page</h1>
<script src="${WIDGET_SRC}" data-tenant="${WIDGET_TENANT}"></script>
</body></html>`
}

let server: Server
let baseUrl: string

test.beforeAll(async () => {
  // One server, four routes — `bodyClass=...` lets each test pick its
  // scenario without re-listening on a new port. Playwright's test isolation
  // handles per-page state; the HTTP server just hands out HTML.
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const bodyClass = url.searchParams.get('bodyClass') ?? ''
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(htmlFor({ bodyClass }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('listen failed')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function launcherVisible(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const btn = document.getElementById('rbot-widget-button')
    if (!btn) return false
    const cs = getComputedStyle(btn)
    return cs.display !== 'none' && cs.visibility !== 'hidden'
  })
}

test.describe('Widget embed — cross-origin (live)', () => {

  test('plain public visitor sees the launcher', async ({ page }) => {
    await page.goto(`${baseUrl}/?bodyClass=`)
    await page.waitForSelector('#rbot-widget-button', { timeout: 15_000 })
    expect(await launcherVisible(page)).toBe(true)
  })

  test('Divi public visitor sees the launcher', async ({ page }) => {
    // Divi adds these classes to every page. The widget must still render
    // for a non-logged-in visitor. Regression for the 2026-05-18 incident.
    await page.goto(`${baseUrl}/?bodyClass=${encodeURIComponent('home wp-singular et_divi_theme et-db et_pb_pagebuilder_layout')}`)
    await page.waitForSelector('#rbot-widget-button', { timeout: 15_000 })
    expect(await launcherVisible(page)).toBe(true)
  })

  test('WP-admin logged-in visitor is hidden', async ({ page }) => {
    // Worker config has embedOptions.cms = "wordpress-divi" for this tenant
    // which tells the widget to hide when the WP admin bar is present.
    await page.goto(`${baseUrl}/?bodyClass=${encodeURIComponent('home wp-singular et_divi_theme et-db logged-in admin-bar')}`)
    // Give the widget the same window it would need to render if it weren't
    // intentionally hiding — so a regression that ALWAYS shows is caught.
    await page.waitForTimeout(3000)
    expect(await launcherVisible(page)).toBe(false)
  })

  test('Divi visual-builder (et_fb=1) is hidden', async ({ page }) => {
    await page.goto(`${baseUrl}/?bodyClass=${encodeURIComponent('home wp-singular et_divi_theme et-db')}&et_fb=1`)
    await page.waitForTimeout(3000)
    expect(await launcherVisible(page)).toBe(false)
  })

  test('clicking launcher opens the chat pane with no console errors', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.goto(`${baseUrl}/?bodyClass=`)
    await page.waitForSelector('#rbot-widget-button', { timeout: 15_000 })
    await page.click('#rbot-widget-button')
    const pane = page.locator('.rbot-widget-pane')
    await expect(pane).toBeVisible({ timeout: 5_000 })

    // The widget's error-reporter sometimes fails to POST in transient setups
    // (no /api/errors hit yet) — filter that specific signature. Anything
    // else here is a real bug.
    const real = errors.filter((e) => !/Failed to report|Fetch API cannot load file/.test(e))
    expect(real, `unexpected console errors: ${JSON.stringify(real)}`).toEqual([])
  })
})
