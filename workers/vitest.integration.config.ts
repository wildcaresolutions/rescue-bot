/**
 * Vitest config for integration tests (real-HTTP, no mocks).
 *
 * This file will be overwritten/extended by the canonical version from
 * `feat/integration-test-infra`. Keep it minimal.
 *
 * Usage:
 *   BASE_URL=https://wildcare-bot-test.<account>.workers.dev \
 *   SIGNING_SECRET=<secret> \
 *   cd workers && npx vitest run --config vitest.integration.config.ts
 *
 * Integration tests are intentionally excluded from the default `vitest.config.ts`
 * (which only picks up `test/**`) so `npx vitest run` does NOT execute them —
 * they require a live deployed worker and real AI credentials.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Default pool is 'forks' (Node.js environment) — correct for HTTP tests.
    // Do NOT use @cloudflare/vitest-pool-workers here; that sandbox would
    // intercept fetch() and prevent real outbound HTTP.
  },
})
