/**
 * Vitest config for integration tests.
 *
 * Run with:
 *   BASE_URL=https://wildcare-bot-test.<account>.workers.dev \
 *   SIGNING_SECRET=<deployed-worker-secret> \
 *   TEST_TENANT_SLUG=test-org \
 *   TEST_TENANT_ID=test-0001-dev-tenant \
 *   npx vitest run --config vitest.integration.config.ts
 *
 * Or via npm: npm run test:integration (requires the same env vars).
 *
 * These tests fire real HTTP at a deployed Cloudflare Worker with real LLM
 * calls.  They are intentionally excluded from the default unit run
 * (`include: ['test/**/*.test.ts']`) to keep CI fast and dependency-free.
 *
 * Per-test timeout is 60 s to accommodate real LLM streaming latency.
 * hookTimeout is also elevated for the beforeEach/afterEach cleanup fetches.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    // No workers-pool — integration tests use native Node fetch against a real
    // URL.  The workers pool intercepts fetch, which breaks real network calls.
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Required for top-level await in _harness.ts
    environment: 'node',
  },
})
