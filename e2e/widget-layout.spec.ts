import { test, expect, type Locator, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'

// Reproduce the discoverwildcare.org integration without depending on its
// changing content, optimization cache, or production chat API. Always test
// the candidate bundle: npm run build:widget --prefix web before this suite.
let server: Server
let baseUrl: string

test.beforeAll(async () => {
  const bundle = readFileSync(new URL('../web/widget-dist/widget.js', import.meta.url))
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/widget.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' })
      res.end(bundle)
      return
    }
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'layout-test',
        messages: Array.from({ length: 30 }, (_, i) => ({
          role: i % 2 ? 'assistant' : 'user',
          content: i % 2
            ? 'Keep the animal in a quiet, dark place.\n\nContact a wildlife rehabilitator for the next steps.'
            : 'I found an injured bird. What should I do?',
        })),
      }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!doctype html><html lang="en"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body { margin: 0; font-size: 17px; line-height: 1.5; }
        #main-header { position: fixed; top: 0; width: 100%; height: 161px;
          background: #333; color: white; z-index: 99999; }
        #wpadminbar { position: fixed; top: 0; width: 100%; height: 32px;
          background: black; z-index: 999999; }
      </style></head><body class="et_divi_theme">
      <header id="main-header">Website navigation</header>
      <iframe title="Donation Activity Popup" srcdoc="Donation notification"
        style="position:fixed;bottom:0;left:0;width:428px;height:116px;
        border:0;z-index:2147483643"></iframe>
      ${url.searchParams.has('admin') ? '<div id="wpadminbar">WordPress admin toolbar</div>' : ''}
      <main><h1>Partner website</h1></main>
      <script>window.RescueBotChat = {
        autoOpen: false,
        agentName: "WildCare's Emergency Wildlife Advice",
        buttonPosition: { bottom: '25%', right: '.25%' },
        panePosition: { top: '1%', right: '1%' }
      }</script>
      <script src="/widget.js"></script></body></html>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('listen failed')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

test.afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
})

async function openChat(page: Page, admin = false) {
  await page.context().addCookies([{
    name: 'rescue_bot_session_id', value: 'layout-test', url: baseUrl,
  }])
  await page.goto(`${baseUrl}/${admin ? '?admin=1' : ''}`)
  await page.locator('#rbot-widget-button').click()
  await expect(page.locator('.rbot-widget-message')).toHaveCount(30)
}

async function expectInsideViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  const viewport = page.viewportSize()!
  expect(box!.x).toBeGreaterThanOrEqual(-1)
  expect(box!.y).toBeGreaterThanOrEqual(-1)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1)
}

async function expectUnobstructed(locator: Locator) {
  expect(await locator.evaluate(el => {
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const root = el.getRootNode() as ShadowRoot
    return document.elementFromPoint(x, y) === root.host
      && root.elementFromPoint(x, y) === el
  })).toBe(true)
}

test('desktop header and close control stay above fixed CMS navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openChat(page)
  const pane = await page.locator('.rbot-widget-pane').boundingBox()
  expect(pane!.y).toBeCloseTo(10, 0)
  expect(pane!.x + pane!.width).toBeCloseTo(1440 * 0.99, 0)
  await expectUnobstructed(page.locator('.rbot-widget-title'))
  await expectUnobstructed(page.locator('.rbot-widget-close'))
  await expectInsideViewport(page, page.locator('.rbot-widget-input-area'))
  await page.locator('.rbot-widget-close').click()
  await expect(page.locator('.rbot-widget-pane')).toBeHidden()
  await expect(page.locator('#rbot-widget-button')).toBeVisible()
})

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 667, height: 375 },
  { width: 768, height: 600 },
]) {
  test(`mobile controls fit at ${viewport.width} × ${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openChat(page)
    for (const selector of ['.rbot-widget-pane', '.rbot-widget-header',
      '.rbot-widget-input', '.rbot-widget-send', '.rbot-widget-close']) {
      await expectInsideViewport(page, page.locator(selector))
    }
    await expectUnobstructed(page.locator('.rbot-widget-close'))
    await expectUnobstructed(page.locator('.rbot-widget-send'))
    expect(await page.locator('.rbot-widget-messages').evaluate(el =>
      el.scrollHeight > el.clientHeight)).toBe(true)
    await page.locator('.rbot-widget-input').fill('The input remains usable.')
    await page.locator('.rbot-widget-close').click()
    await expect(page.locator('.rbot-widget-pane')).toBeHidden()
  })
}

test('mobile respects the WordPress toolbar inset', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openChat(page, true)
  const header = await page.locator('.rbot-widget-header').boundingBox()
  expect(header!.y).toBeGreaterThanOrEqual(32)
  await expectInsideViewport(page, page.locator('.rbot-widget-pane'))
  await expectUnobstructed(page.locator('.rbot-widget-close'))
})

test('switching to mobile overrides dimensions from desktop drag-resizing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openChat(page)
  await page.locator('.rbot-widget-pane').evaluate(el => {
    // Browsers persist resize:both dimensions as inline styles.
    const pane = el as HTMLElement
    pane.style.width = '900px'
    pane.style.height = '700px'
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectInsideViewport(page, page.locator('.rbot-widget-pane'))
  await expectUnobstructed(page.locator('.rbot-widget-close'))
  await expectUnobstructed(page.locator('.rbot-widget-send'))
})
