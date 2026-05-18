import { defineConfig, devices } from '@playwright/test'

// E2E tests for the Critter Collective marketing site. The full apply-form JS
// flow (Turnstile widget load, ?ref= URL param capture, form submission, and
// success state) cannot be tested at the unit/integration layer. This config
// drives a real Chromium against `make cf-dev` (wrangler dev on :8787).
//
// DEV_AUTH_BYPASS = "true" in the local env (workers/wrangler.toml:36) means
// Turnstile validation is skipped server-side. The client-side widget still
// renders, but with the Cloudflare "always passes" test site key
// (TURNSTILE_SITE_KEY = "1x00000000000000000000AA") so it auto-approves.

export default defineConfig({
  testDir: './e2e',
  // Exclude the cross-origin widget spec — it runs under its own config
  // (playwright-widget.config.ts) because it has no wrangler dependency.
  testIgnore: 'widget-embed.spec.ts',
  fullyParallel: false,             // single Wrangler dev server, no parallel writes
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],

  use: {
    baseURL: 'http://localhost:8787',
    trace: 'on-first-retry',
    actionTimeout: 10_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Spin up the dev server for the test run. Reuse if already running locally.
  // Required by apply.spec.ts. The widget spec (e2e/widget-embed.spec.ts) is
  // self-contained — it boots its own HTTP server and points at the prod
  // embed bundle, so it doesn't depend on this dev server.
  webServer: {
    command: 'cd workers && npx wrangler dev --local',
    url: 'http://localhost:8787/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
