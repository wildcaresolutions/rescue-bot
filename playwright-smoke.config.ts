import { defineConfig, devices } from '@playwright/test'

// Standalone Playwright config for e2e/smoke.spec.ts.
//
// Smoke tests probe the live production deployment at wildcaresolutions.org.
// No webServer block — tests connect directly to live infrastructure.
//
// IMPORTANT: Tests use page.evaluate() for all direct HTTP to
// wildcaresolutions.org/embed.wildcaresolutions.org. Cloudflare's Bot Fight
// Mode blocks GHA runner IPs when they use Node.js HTTP (curl, node-fetch,
// Playwright's `request` fixture). Driving fetch() from inside a real Chromium
// instance uses Chrome's TLS/JA3 fingerprint and bypasses bot detection.
//
// Run: npx playwright test --config=playwright-smoke.config.ts
// CI:  `smoke` job, runs after deploy-prod on push to main only.

export default defineConfig({
  testDir: './e2e',
  testMatch: 'smoke.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Smoke tests hit live infra — retry transient 503s.
  retries: process.env.CI ? 2 : 0,
  // Serial: tests E and F share a local server set up in beforeAll.
  workers: 1,
  reporter: [['list']],

  use: {
    trace: 'on-first-retry',
    actionTimeout: 20_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
