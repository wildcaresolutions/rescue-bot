import { test, expect } from '@playwright/test'

// E2E coverage for the apply-form JS flow on the Critter Collective marketing
// page. Tests the surface that workers/test/platform.test.ts cannot reach:
// Turnstile widget mount, ?ref= URL param capture, form submission via fetch,
// and the success state render.
//
// Runs against `wrangler dev` with DEV_AUTH_BYPASS = "true" (default for the
// top-level wrangler env). The test Turnstile site key auto-approves; the
// server-side bypass means token verification doesn't actually call CF.

test.describe('Marketing page — apply form', () => {

  test('hero renders with coalition framing + 4 founding-partner slots', async ({ page }) => {
    await page.goto('/')
    // Hero headline.
    await expect(page.locator('h1')).toContainText("California's wildlife rehabs, sharing what works.")
    // Founding partners strip — WildCare anchor + 3 placeholder slots.
    await expect(page.locator('.partner-logo')).toHaveCount(4)
    await expect(page.locator('.partners-strip-label')).toHaveText(/founding partners/i)
  })

  test('apply form captures ?ref= URL param into hidden field', async ({ page }) => {
    await page.goto('/?ref=wildcare-outreach')
    const refField = page.locator('#ref_field')
    await expect(refField).toHaveAttribute('value', 'wildcare-outreach')
  })

  test('apply form clamps overlong ?ref= to 128 chars', async ({ page }) => {
    const longRef = 'x'.repeat(500)
    await page.goto(`/?ref=${longRef}`)
    const refField = page.locator('#ref_field')
    const value = await refField.getAttribute('value')
    expect(value!.length).toBe(128)
  })

  test('apply form submits successfully and shows success state', async ({ page }) => {
    // Intercept the apply POST so we can assert payload AND avoid a real
    // D1 write. DEV_AUTH_BYPASS would let it through anyway, but mocking
    // keeps the test hermetic.
    let capturedPayload: Record<string, unknown> | null = null
    await page.route('**/platform/apply', async (route) => {
      capturedPayload = JSON.parse(route.request().postData() || '{}')
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, id: 'fake-uuid-1234' }),
      })
    })

    await page.goto('/?ref=test-e2e-channel')

    // Fill the form fields.
    await page.fill('input[name="org_name"]', 'Test Wildlife Org')
    await page.fill('input[name="contact_name"]', 'Jane Smith')
    await page.fill('input[name="contact_email"]', 'jane@example.org')
    await page.fill('textarea[name="use_case"]', 'Small rehab in Test County')

    // Submit button should be enabled once Turnstile auto-passes (test site
    // key auto-approves). Wait for it.
    const submitBtn = page.locator('#appSubmit')
    await expect(submitBtn).toBeEnabled({ timeout: 15_000 })

    // Submit.
    await submitBtn.click()

    // Success block should appear.
    await expect(page.locator('#appSuccess')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('#appEmail')).toHaveText('jane@example.org')

    // Form should be hidden after success.
    await expect(page.locator('#appForm')).toBeHidden()

    // Verify the captured payload includes our fields + source/ref attribution.
    expect(capturedPayload).toBeTruthy()
    expect(capturedPayload!.org_name).toBe('Test Wildlife Org')
    expect(capturedPayload!.contact_name).toBe('Jane Smith')
    expect(capturedPayload!.contact_email).toBe('jane@example.org')
    expect(capturedPayload!.use_case).toBe('Small rehab in Test County')
    expect(capturedPayload!.source).toBe('marketing-coalition-v1')
    expect(capturedPayload!.ref).toBe('test-e2e-channel')
    // Turnstile token should be present (test site key auto-issues one).
    expect(capturedPayload!.turnstile_token).toBeTruthy()
  })

  test('apply form shows error message on server 400', async ({ page }) => {
    await page.route('**/platform/apply', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Some validation failure' }),
      })
    })

    await page.goto('/')
    await page.fill('input[name="org_name"]', 'Test')
    await page.fill('input[name="contact_name"]', 'Jane')
    await page.fill('input[name="contact_email"]', 'jane@example.org')

    await expect(page.locator('#appSubmit')).toBeEnabled({ timeout: 15_000 })
    await page.click('#appSubmit')

    await expect(page.locator('#appError')).toBeVisible()
    await expect(page.locator('#appError')).toHaveText('Some validation failure')
    // Form stays visible so user can retry.
    await expect(page.locator('#appForm')).toBeVisible()
  })
})

test.describe('/find directory page', () => {
  test('renders 4 partner tiles by default', async ({ page }) => {
    await page.goto('/find')
    await expect(page.locator('h1')).toContainText('Find your local wildlife rehab')
    await expect(page.locator('.partner-tile')).toHaveCount(4)
  })

  test('filter buttons narrow the grid', async ({ page }) => {
    await page.goto('/find')
    await page.click('button[data-filter="raptor"]')
    // Only one placeholder partner has the "raptor" specialty.
    await expect(page.locator('.partner-tile')).toHaveCount(1)
  })

  test('directory promise CTA links back to apply', async ({ page }) => {
    await page.goto('/find')
    const cta = page.locator('.find-cta a.hero-cta')
    await expect(cta).toHaveAttribute('href', '/#apply')
  })
})
