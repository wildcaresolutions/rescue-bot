/**
 * Integration test harness — shared fixtures for the integration test suites.
 * Uses a top-level `await` so tokens are ready when any test file imports
 * from here.
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
export const FOREIGN_TENANT_ID = 'ffffffff-0000-0000-0000-000000000000'

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

const signingEnv = { SIGNING_SECRET: process.env.SIGNING_SECRET ?? 'dev-secret' } as unknown as Env

// Top-level await: generates short-lived tokens at import time.
// The tokens are HMAC-signed against SIGNING_SECRET, which must match the
// deployed worker's binding.  Admin tokens expire in 24 h.
export const adminToken = await generateToken(
  TENANT_ID,
  'admin',
  signingEnv,
  'integration@test.local',
)

// Viewer (non-admin) token for the same tenant — resolves but isAdmin=false → 401.
export const viewerToken = await generateToken(
  TENANT_ID,
  'viewer',
  signingEnv,
  'viewer@test.local',
)

// Admin token for a completely different tenant — valid HMAC but wrong tenantId → 401.
export const foreignAdminToken = await generateToken(
  FOREIGN_TENANT_ID,
  'admin',
  signingEnv,
  'foreign@test.local',
)

/** Headers for admin-authenticated requests to /admin/* routes. */
export const adminHeaders: Record<string, string> = {
  Authorization: `Bearer ${adminToken}`,
  'X-Tenant-Slug': TENANT_SLUG,
  'Content-Type': 'application/json',
}

/** Headers using the non-admin (viewer) token. */
export const viewerHeaders: Record<string, string> = {
  Authorization: `Bearer ${viewerToken}`,
  'X-Tenant-Slug': TENANT_SLUG,
  'Content-Type': 'application/json',
}

/** Headers using an admin token for a different tenant. */
export const foreignHeaders: Record<string, string> = {
  Authorization: `Bearer ${foreignAdminToken}`,
  'X-Tenant-Slug': TENANT_SLUG,
  'Content-Type': 'application/json',
}

/** Unauthenticated headers that still carry the tenant context. */
export const noAuthHeaders: Record<string, string> = {
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
