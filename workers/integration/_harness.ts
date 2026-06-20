/**
 * Shared harness for integration tests.
 *
 * All integration tests import from this file. It mints a fresh admin token
 * per run (HMAC, pure CPU — no DB touch) and exports the base URL + tenant
 * identifiers from env vars set by the CI seed step or locally by the operator.
 *
 * Required env vars (set by `make cf-test-integration` or CI):
 *   BASE_URL            — https://<slug>-bot-test.<account>.workers.dev
 *   SIGNING_SECRET      — matches the secret deployed to the test worker
 *   TEST_TENANT_SLUG    — slug of the ephemeral tenant seeded for this run
 *   TEST_TENANT_ID      — id of the ephemeral tenant seeded for this run
 */
import { generateToken } from '../src/lib/auth'
import type { Env } from '../src/lib/types'

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8787'
export const TENANT_SLUG = process.env.TEST_TENANT_SLUG ?? 'test-org'
export const TENANT_ID = process.env.TEST_TENANT_ID ?? 'test-0001-dev-tenant'

// Require SIGNING_SECRET when targeting anything other than localhost.
// Falling back to 'dev-secret' against a real test worker produces confusing
// 401 failures; an explicit error is more actionable.
const signingSecret = process.env.SIGNING_SECRET
if (!signingSecret && !BASE_URL.includes('localhost')) {
  throw new Error(
    'SIGNING_SECRET is required when running integration tests against a non-localhost worker.\n' +
    'Set it to the SIGNING_SECRET deployed to the test worker.',
  )
}

// Mint a fresh admin token for this run (tokens expire after 24 h).
// generateToken is pure HMAC — no DB touch needed.
export const adminToken = await generateToken(
  TENANT_ID,
  'admin',
  { SIGNING_SECRET: signingSecret ?? 'dev-secret' } as unknown as Env,
  'integration@test.local',
)

export const adminHeaders: Record<string, string> = {
  'Authorization': `Bearer ${adminToken}`,
  'X-Tenant-Slug': TENANT_SLUG,
  'Content-Type': 'application/json',
}

// Public chat headers. Origin http://localhost is hardcoded-allowed in
// index.ts (originHost === 'localhost' check), so no allowed_domains row
// needed for chat-path tests.
export const chatHeaders: Record<string, string> = {
  'X-Tenant-Slug': TENANT_SLUG,
  'Origin': 'http://localhost',
  'Content-Type': 'application/json',
}
