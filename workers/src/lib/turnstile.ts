/**
 * Cloudflare Turnstile token verification.
 *
 * Public endpoints that trigger work (signup, magic-link request) call this
 * before doing anything. The widget runs on the client and produces a
 * single-use token; we POST it to Turnstile's siteverify endpoint to confirm
 * the user passed the challenge.
 *
 * Local dev: TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA"
 *  (Cloudflare's well-known "always passes" test secret.)
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export type TurnstileResult =
  | { ok: true }
  | { ok: false; reason: 'missing_token' | 'missing_secret' | 'rejected' | 'network'; details?: string }

/**
 * Verify a Turnstile token. Returns a discriminated result so callers can
 * decide between "no challenge presented" (4xx to client) and infrastructure
 * faults (return 503, don't burn the token).
 *
 * @param token  the cf-turnstile-response from the client form
 * @param remoteIp  caller IP (CF-Connecting-IP header) — improves scoring
 * @param secret  TURNSTILE_SECRET_KEY from env
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp: string | null | undefined,
  secret: string | null | undefined,
): Promise<TurnstileResult> {
  if (!secret) return { ok: false, reason: 'missing_secret' }
  if (!token) return { ok: false, reason: 'missing_token' }

  const body = new URLSearchParams({ secret, response: token })
  if (remoteIp) body.set('remoteip', remoteIp)

  let resp: Response
  try {
    resp = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
  } catch (e) {
    return { ok: false, reason: 'network', details: e instanceof Error ? e.message : String(e) }
  }

  if (!resp.ok) return { ok: false, reason: 'network', details: `HTTP ${resp.status}` }

  let data: { success?: boolean; 'error-codes'?: string[] }
  try { data = await resp.json() }
  catch { return { ok: false, reason: 'network', details: 'malformed response' } }

  if (data.success === true) return { ok: true }
  return { ok: false, reason: 'rejected', details: (data['error-codes'] ?? []).join(',') }
}
