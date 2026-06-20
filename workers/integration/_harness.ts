/**
 * Integration test harness — local branch copy.
 *
 * This file will be superseded by the canonical version added in
 * `feat/integration-test-infra`. Remove this copy once that PR merges.
 *
 * Configure via environment variables:
 *   BASE_URL           — base URL of the deployed test worker
 *                        (default: http://localhost:8787)
 *   TEST_TENANT_SLUG   — slug of the pre-seeded integration test tenant
 *                        (default: test-org)
 *   TEST_TENANT_ID     — id of the pre-seeded integration test tenant
 *                        (default: test-0001-dev-tenant)
 *   SIGNING_SECRET     — HMAC signing secret configured in the test worker
 *                        (default: dev-secret, matches wrangler dev defaults)
 *
 * Run integration tests:
 *   BASE_URL=https://wildcare-bot-test.<account>.workers.dev \
 *   SIGNING_SECRET=<secret> \
 *   TEST_TENANT_SLUG=<slug> \
 *   TEST_TENANT_ID=<id> \
 *   cd workers && npx vitest run --config vitest.integration.config.ts integration/chat.test.ts
 */
import { generateToken } from '../src/lib/auth'

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8787'
export const TENANT_SLUG = process.env.TEST_TENANT_SLUG ?? 'test-org'
export const TENANT_ID = process.env.TEST_TENANT_ID ?? 'test-0001-dev-tenant'

// Mint a v2 admin token signed with the same secret the test worker uses.
// Top-level await is valid in ESM modules (Node 20+, vitest 4).
export const adminToken = await generateToken(
  TENANT_ID,
  'admin',
  { SIGNING_SECRET: process.env.SIGNING_SECRET ?? 'dev-secret' } as never,
  'integration@test.local',
)

/** Headers for admin (authed operator) requests. */
export const adminHeaders: Record<string, string> = {
  'Authorization': `Bearer ${adminToken}`,
  'X-Tenant-Slug': TENANT_SLUG,
  'Content-Type': 'application/json',
}

/**
 * Headers for public chat widget requests.
 *
 * Origin is 'http://localhost' — the tenant resolution middleware auto-allows
 * localhost as a recognised dev/test origin, so no allowed_domains row is
 * required for the test tenant.
 */
export const chatHeaders: Record<string, string> = {
  'X-Tenant-Slug': TENANT_SLUG,
  'Origin': 'http://localhost',
  'Content-Type': 'application/json',
}
