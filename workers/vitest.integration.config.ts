/**
 * Vitest config for integration tests.
 *
 * Integration tests live in workers/integration/ and fire real HTTP at a
 * deployed (or local) worker — no mocks. They are intentionally excluded from
 * the default vitest.config.ts (which covers test/**) so `npx vitest run`
 * (the unit suite) never requires a live deployment.
 *
 * Run with:
 *   BASE_URL=https://wildcare-bot-test.<account>.workers.dev \
 *   SIGNING_SECRET=<deployed-worker-secret> \
 *   TEST_TENANT_SLUG=test-org \
 *   TEST_TENANT_ID=test-0001-dev-tenant \
 *   npx vitest run --config vitest.integration.config.ts
 *
 * Or against a local wrangler dev server (make cf-dev):
 *   SIGNING_SECRET=dev-secret npx vitest run --config vitest.integration.config.ts
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
    // Sequential file execution — integration tests hit a shared DB so
    // parallel test files would race each other on create/delete evals.
    // fileParallelism: false is the vitest 4 replacement for singleFork.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Required for top-level await in _harness.ts
    environment: 'node',
  },
})
