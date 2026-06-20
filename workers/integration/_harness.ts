/**
 * Integration test harness — shared fixtures for the copilot/agent integration
 * suite. Uses a top-level `await` so the admin token is ready when any test
 * file imports from here.
 *
 * Requires environment variables (set before running `npx vitest run -c
 * vitest.integration.config.ts`):
 *
 *   BASE_URL           — Base URL of the deployed test worker
 *                        (e.g. https://wildcare-bot-test.<account>.workers.dev)
 *                        Defaults to http://localhost:8787 for local dev.
 *   TEST_TENANT_SLUG   — Slug of the tenant to test against (default: test-org)
 *   TEST_TENANT_ID     — DB row id of that tenant (default: test-0001-dev-tenant)
 *   SIGNING_SECRET     — HMAC secret matching the deployed worker's SIGNING_SECRET
 *                        binding. Must match; tokens signed with the wrong secret
 *                        fail at the worker's auth middleware.
 *
 * Usage in tests:
 *   import { BASE_URL, adminHeaders, chatHeaders } from './_harness'
 */

import { generateToken } from '../src/lib/auth'
import type { Env } from '../src/lib/types'

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8787'
export const TENANT_SLUG = process.env.TEST_TENANT_SLUG ?? 'test-org'
export const TENANT_ID = process.env.TEST_TENANT_ID ?? 'test-0001-dev-tenant'

// Warn loudly when required env vars are missing so a CI misconfiguration
// surfaces immediately rather than silently targeting localhost.
if (!process.env.SIGNING_SECRET) {
  console.warn(
    '[integration harness] SIGNING_SECRET is not set — falling back to dev-secret.\n' +
    'Tokens will be rejected by any deployed worker. Set SIGNING_SECRET to the\n' +
    'deployed worker\'s SIGNING_SECRET binding before running integration tests.',
  )
}
if (!process.env.BASE_URL) {
  console.warn(
    '[integration harness] BASE_URL is not set — targeting http://localhost:8787.\n' +
    'Run `make cf-dev` first, or set BASE_URL to a deployed test worker URL.',
  )
}

// Top-level await: generates a short-lived admin token at import time.
// The token is HMAC-signed against SIGNING_SECRET, which must match the
// deployed worker's binding.  Admin tokens expire in 24 h.
export const adminToken = await generateToken(
  TENANT_ID,
  'admin',
  { SIGNING_SECRET: process.env.SIGNING_SECRET ?? 'dev-secret' } as unknown as Env,
  'integration@test.local',
)

/** Headers for admin-authenticated requests to /admin/* routes. */
export const adminHeaders: Record<string, string> = {
  Authorization: `Bearer ${adminToken}`,
  'X-Tenant-Slug': TENANT_SLUG,
  'Content-Type': 'application/json',
}

/**
 * Headers for unauthenticated requests (public chat path).
 * Includes X-Tenant-Slug so tenant resolution succeeds;
 * omits Authorization so /admin/* routes return 401, not 400.
 */
export const chatHeaders: Record<string, string> = {
  'X-Tenant-Slug': TENANT_SLUG,
  Origin: 'http://localhost',
  'Content-Type': 'application/json',
}
