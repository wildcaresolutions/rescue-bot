// Session-bound nonce validation for citizen photo endpoints.
//
// Per /plan-eng-review OV2: Origin-allowlist alone is spoofable from
// non-browser clients. The photo endpoints (mint URL, attach in chat, delete)
// additionally require an Authorization: Bearer <session_token> header that
// matches the token minted at POST /api/sessions and stored in the
// citizen_session_tokens table.
//
// In dev / DEV_AUTH_BYPASS, validation short-circuits to allow.

import type { Env } from './types'

const SESSION_TOKEN_TTL_SECONDS = 24 * 60 * 60 // 24 hours per design doc

/** Generate a fresh opaque session token (256 bits of entropy, hex-encoded). */
export function generateSessionToken(): string {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Mint and persist a new session token. Replaces any existing token for the
 * session id (idempotent — POST /api/sessions can be called multiple times).
 */
export async function mintSessionToken(
  env: Env,
  sessionId: string,
  tenantId: string,
): Promise<string> {
  const token = generateSessionToken()
  const now = Date.now()
  const expiresAt = now + SESSION_TOKEN_TTL_SECONDS * 1000
  await env.DB.prepare(
    `INSERT INTO citizen_session_tokens (session_id, tenant_id, token, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`,
  )
    .bind(sessionId, tenantId, token, now, expiresAt)
    .run()
  return token
}

/**
 * Validate an Authorization: Bearer <token> header against the session.
 * Returns true if the token matches and hasn't expired. DEV_AUTH_BYPASS
 * short-circuits to true.
 */
export async function validateSessionToken(
  env: Env,
  request: Request,
  sessionId: string,
  tenantId: string,
): Promise<boolean> {
  if (env.DEV_AUTH_BYPASS === 'true') return true

  const authHeader = request.headers.get('authorization') ?? ''
  const match = authHeader.match(/^Bearer (.+)$/i)
  if (!match) return false
  const presented = match[1].trim()
  if (!presented) return false

  const row = await env.DB.prepare(
    `SELECT token, expires_at FROM citizen_session_tokens
     WHERE session_id = ? AND tenant_id = ?`,
  )
    .bind(sessionId, tenantId)
    .first<{ token: string; expires_at: number }>()

  if (!row) return false
  if (row.expires_at < Date.now()) return false

  // Constant-time-ish equality (length-checked + char-by-char). The token is
  // 64 hex chars; timing leaks here are not a meaningful attack surface, but
  // we still don't want to short-circuit on the first mismatched byte.
  if (row.token.length !== presented.length) return false
  let diff = 0
  for (let i = 0; i < row.token.length; i++) {
    diff |= row.token.charCodeAt(i) ^ presented.charCodeAt(i)
  }
  return diff === 0
}
