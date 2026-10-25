import { defineConfig, devices } from '@playwright/test'

// Standalone Playwright config for the widget embed and layout specs.
//
// The widget spec is self-contained: it boots its own HTTP server on a random
// localhost port and points at the prod embed bundle
// (https://embed.wildcaresolutions.org/v1.js by default; override with
// WIDGET_SRC env var to point at a PR's test deploy). It does NOT need
// the local wrangler dev that apply.spec.ts depends on — so this config
// omits the `webServer` block.
// The layout spec serves the locally built widget (npm run build:widget
// --prefix web) with stubbed chat data and fixed CMS/donation overlays.
//
// Run: npm run e2e:widget (builds the candidate before testing)
// CI:  separate job from the apply suite, no D1 / local infra required.

export default defineConfig({
  testDir: './e2e',
  testMatch: ['widget-embed.spec.ts', 'widget-layout.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list']],

  use: {
    trace: 'on-first-retry',
    actionTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
