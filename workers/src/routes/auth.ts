import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Env, Variables } from '../lib/types'
import {
  generateToken,
  isPlatformAdminEmail,
  isDevAuthBypass,
  resolveSession,
  tenantCookiePrefix,
  PLATFORM_COOKIE_PREFIX,
  timingSafeCompare,
  ADMIN_TOKEN_TTL_DAYS,
  type Role,
} from '../lib/auth'
import { sendEmail } from '../lib/email'
import { getAuthFromEmail, getPlatformName } from '../lib/platform'
import { verifyTurnstile } from '../lib/turnstile'
import { badRequest, notFound, unauthorized } from '../lib/errors'
import { logError, logInfo } from '../lib/logger'

const TOKEN_EXPIRY_MINUTES = 15

const auth = new Hono<{ Bindings: Env; Variables: Variables }>()

// Sentinel tenantId baked into platform-admin sessions issued at admin.<root>.
// Distinct from any real tenant slug (which can't contain ":" or be "platform"
// per RESERVED_HOST_SLUGS in lib/routing.ts).
const PLATFORM_TENANT_ID = 'platform'

// RFC 5321 caps the local-part at 64 and the domain at 253, so the total
// addressable length is bounded at 254 (plus the `@`). Audit ralph-2 H4
// noted that without the bound, a 4 KB email validates fine, gets hex-
// encoded into the v2 session token, and produces a session cookie that
// crowds out other request headers or trips browser per-cookie limits
// (most browsers cap at 4 KB per cookie).
const MAX_EMAIL_LENGTH = 254

function emailValid(email: string): boolean {
  if (email.length > MAX_EMAIL_LENGTH) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/** Escape a string for safe inclusion in an HTML attribute value. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function generic200(): Response {
  // We never reveal whether an email exists. Always return the same message.
  return Response.json({
    success: true,
    message: 'If this email has access, a login link has been sent.',
  })
}

/**
 * Insert a magic_tokens row and return the verify URL the recipient should
 * click. Used by both the self-serve `/api/auth/request` flow and the admin
 * `/api/auth/users` invite flow so a fresh invitee can sign in with one
 * click instead of having to request another link themselves.
 *
 * tenantId=null marks a platform-admin login (only used at admin.<root>).
 */
export async function issueMagicLink(
  env: Env,
  opts: { email: string; tenantId: string | null; tenantSlug: string; host: string },
): Promise<string> {
  // Idempotent issuance (P1-20): if an unused, unexpired token already exists
  // for this (email, tenant_id) pair, reuse it instead of minting a new one.
  //
  // Why: without this, an attacker hammering /api/auth/request with someone
  // else's email would generate N magic-link emails to that victim — draining
  // the org's Cloudflare Email Routing daily quota AND spamming the victim's
  // inbox. Reusing the outstanding token caps emails-per-email-address at one
  // per unused link; victim sees a single email no matter how many requests
  // fire. The link is still single-use, so this doesn't widen the auth window
  // (one link → one session, just like before).
  //
  // Scoping: tenant_id-aware. The same email legitimately can have separate
  // outstanding links for different tenants. The IS-NULL guard pairs both
  // sides because SQL `NULL = NULL` is unknown, not true; the explicit
  // `tenant_id IS NULL AND ? IS NULL` arm catches the platform-admin case
  // where tenant_id is intentionally NULL.
  //
  // Race tolerance: two near-simultaneous requests can each see "no existing
  // token" and both INSERT — acceptable. The flood-emails-at-victim attack
  // requires sequential requests (each waiting for the first INSERT to land),
  // so the dedup catches the high-volume case.
  const existing = await env.DB.prepare(
    `SELECT token FROM magic_tokens
     WHERE email = ?
       AND used = 0
       AND expires_at > datetime('now')
       AND (
         (tenant_id IS NULL AND ? IS NULL)
         OR tenant_id = ?
       )
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(opts.email, opts.tenantId, opts.tenantId).first<{ token: string }>()

  let token: string
  if (existing) {
    token = existing.token
  } else {
    token = crypto.randomUUID() + '-' + crypto.randomUUID()
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000).toISOString()
    await env.DB.prepare(
      'INSERT INTO magic_tokens (id, email, token, tenant_id, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), opts.email, token, opts.tenantId, expiresAt).run()
  }

  const protocol = opts.host.includes('localhost') ? 'http' : 'https'
  return opts.tenantSlug
    ? `${protocol}://${opts.host}/api/auth/verify?token=${token}&tenant=${opts.tenantSlug}&email=${encodeURIComponent(opts.email)}`
    : `${protocol}://${opts.host}/api/auth/verify?token=${token}&email=${encodeURIComponent(opts.email)}`
}

/** Request a magic link. Sends an email with a login token. */
auth.post('/api/auth/request', async (c) => {
  let body: { email?: string; turnstile_token?: string }
  try { body = await c.req.json() } catch { return badRequest(c, 'Invalid JSON') }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email || !emailValid(email)) {
    return badRequest(c, 'Valid email required')
  }

  // Turnstile (skip in local dev when DEV_AUTH_BYPASS is on).
  if (!isDevAuthBypass(c.env)) {
    const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? null
    const t = await verifyTurnstile(body.turnstile_token, ip, c.env.TURNSTILE_SECRET_KEY)
    if (!t.ok) {
      logError('auth/turnstile-rejected', { reason: t.reason, details: t.details })
      // 'missing_secret' is an env misconfiguration on our side — surface as 503
      // so we notice. Other failures are client-side; respond 400.
      if (t.reason === 'missing_secret' || t.reason === 'network') {
        return c.json({ error: 'Captcha service unavailable' }, 503)
      }
      return c.json({ error: 'Captcha verification failed', reason: t.reason, details: t.details }, 400)
    }
  }

  const tenant = c.get('tenant')
  const platformAdmin = isPlatformAdminEmail(email, c.env)

  let tenantId: string | null = null
  let tenantName = getPlatformName(c.env)
  let tenantSlug = ''

  if (tenant) {
    // Tenant subdomain login
    if (platformAdmin) {
      // Platform admin signing in to a specific tenant — bypass tenant_users.
      // We do NOT insert into tenant_users (so they stay invisible to the org).
      tenantId = tenant.id
      tenantName = tenant.name
      tenantSlug = tenant.slug
    } else {
      const user = await c.env.DB.prepare(
        'SELECT id FROM tenant_users WHERE tenant_id = ? AND email = ?',
      ).bind(tenant.id, email).first()
      if (!user) return generic200()
      tenantId = tenant.id
      tenantName = tenant.name
      tenantSlug = tenant.slug
    }
  } else {
    // No tenant context = login at admin.<root> (platform admin dashboard).
    if (!platformAdmin) {
      // Don't allow tenant-membership lookups from the platform-admin host —
      // an enumerated tenant_users email signing in here would bypass the
      // tenant subdomain. Force them to the tenant subdomain instead.
      return generic200()
    }
    tenantId = null  // null in magic_tokens marks "platform admin login"
    tenantName = `${getPlatformName(c.env)} Platform`
    tenantSlug = ''
  }

  const host = c.req.header('Host') ?? 'localhost:8787'
  const loginUrl = await issueMagicLink(c.env, { email, tenantId, tenantSlug, host })

  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      "DELETE FROM magic_tokens WHERE email = ? AND (used = 1 OR expires_at < datetime('now'))",
    ).bind(email).run().catch(() => {}),
  )

  const fromEmail = getAuthFromEmail(c.env)
  const subject = `Sign in to ${tenantName}`
  const emailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #333; margin-bottom: 8px;">Sign in to ${tenantName}</h2>
      <p style="color: #666; margin-bottom: 24px;">Click the button below to sign in. This link expires in ${TOKEN_EXPIRY_MINUTES} minutes.</p>
      <a href="${loginUrl}" style="display: inline-block; background: #6B7F5E; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 600;">Sign In</a>
      <p style="color: #999; font-size: 13px; margin-top: 32px;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  `

  const result = await sendEmail(c.env, {
    from: { name: tenantName, email: fromEmail },
    to: email,
    subject,
    html: emailHtml,
  })

  if (result.sent === false && result.reason === 'no_binding') {
    return c.json({
      success: true,
      message: 'Development mode: use the link below to sign in.',
      dev_login_url: loginUrl,
    })
  }

  // Dev convenience: even when the EMAIL binding "succeeded" (miniflare just
  // writes HTML to a tmp file in local mode — no real send), surface the
  // magic-link URL in the worker log AND in the response so the operator
  // doesn't have to dig through /var/folders to find it.
  if (isDevAuthBypass(c.env)) {
    logInfo('auth/dev-magic-link', { email, loginUrl })
    return c.json({
      success: true,
      message: 'Development mode: email "sent" but use the link below directly.',
      dev_login_url: loginUrl,
    })
  }

  return c.json({ success: true, message: 'If this email has access, a login link has been sent.' })
})

/**
 * GET /api/auth/verify — show a "Click to sign in" page WITHOUT consuming the
 * magic token. Email link prefetchers (Outlook SafeLinks, Gmail/Bluesnoop
 * malware scanners, Apple Mail link previews) follow GETs eagerly; if we
 * consumed on GET, the user's actual click would land on "Link expired".
 *
 * The form on this page POSTs back to /api/auth/verify with the same token,
 * which is the endpoint that actually consumes it + sets the session cookie.
 */
auth.get('/api/auth/verify', async (c) => {
  const magicToken = c.req.query('token')
  const tenantSlug = c.req.query('tenant') ?? ''
  const email = (c.req.query('email') ?? '').trim().toLowerCase()

  if (!magicToken || !email || !emailValid(email)) return c.text('Invalid link', 400)

  // Soft check: does any unexpired, unused token for this email constant-time
  // match the submitted token? Fetching by email (non-secret) + comparing
  // in app code avoids exposing the token to the DB index timing path (M-7).
  const { results: candidates } = await c.env.DB.prepare(
    "SELECT token FROM magic_tokens WHERE email = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC",
  ).bind(email).all<{ token: string }>()

  const matched = (candidates ?? []).some(r => timingSafeCompare(r.token, magicToken))

  if (!matched) {
    return c.html(`
      <html><body style="font-family: -apple-system, sans-serif; text-align: center; padding: 80px 20px;">
        <h2>Link expired or already used</h2>
        <p style="color: #666;">Please request a new sign-in link.</p>
        <a href="/${tenantSlug ? '?tenant=' + escapeAttr(tenantSlug) : ''}" style="color: #6B7F5E;">Go back</a>
      </body></html>
    `)
  }

  // The button POSTs the token. Form submission is a "user activation" event
  // so prefetchers won't trigger it, while the user just clicks once.
  return c.html(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fafaf7;color:#2d2d2d;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{background:#fff;border:1px solid #e5e5e0;border-radius:12px;max-width:420px;width:100%;padding:40px 32px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.04)}
  h1{font-size:22px;margin:0 0 8px}
  p{color:#6b6b6b;font-size:14px;margin:0 0 24px}
  button{background:#6B7F5E;color:#fff;border:0;padding:12px 32px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit}
  button:hover{filter:brightness(.95)}
</style>
</head><body>
<div class="card">
  <h1>You're almost in</h1>
  <p>Click below to finish signing in to your account.</p>
  <form method="POST" action="/api/auth/verify">
    <input type="hidden" name="token" value="${escapeAttr(magicToken)}" />
    <input type="hidden" name="tenant" value="${escapeAttr(tenantSlug)}" />
    <input type="hidden" name="email" value="${escapeAttr(email)}" />
    <button type="submit">Sign in</button>
  </form>
</div>
</body></html>`)
})

/** POST /api/auth/verify — actually consume the token + set session cookie. */
auth.post('/api/auth/verify', async (c) => {
  let magicToken = ''
  let tenantSlug = ''
  let email = ''
  const ct = c.req.header('Content-Type') ?? ''
  if (ct.includes('application/x-www-form-urlencoded')) {
    const form = await c.req.formData()
    magicToken = String(form.get('token') ?? '')
    tenantSlug = String(form.get('tenant') ?? '')
    email = String(form.get('email') ?? '')
  } else if (ct.includes('application/json')) {
    try {
      const body = await c.req.json<{ token?: string; tenant?: string; email?: string }>()
      magicToken = body.token ?? ''
      tenantSlug = body.tenant ?? ''
      email = body.email ?? ''
    } catch { return c.text('Invalid JSON', 400) }
  } else {
    // Some clients POST without Content-Type; try form first, fall back to JSON.
    try {
      const form = await c.req.formData()
      magicToken = String(form.get('token') ?? '')
      tenantSlug = String(form.get('tenant') ?? '')
      email = String(form.get('email') ?? '')
    } catch {
      return c.text('Missing token', 400)
    }
  }

  email = email.trim().toLowerCase()
  if (!magicToken || !email || !emailValid(email)) return c.text('Invalid request', 400)

  // M-7: Fetch candidate rows by email + expiry (non-secret), then compare
  // the submitted token constant-time in application code. This removes the
  // DB index timing oracle that the previous WHERE token = ? approach exposed.
  const { results: candidates } = await c.env.DB.prepare(
    "SELECT id, token, email, tenant_id FROM magic_tokens WHERE email = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC",
  ).bind(email).all<{ id: string; token: string; email: string; tenant_id: string | null }>()

  let row: { id: string; email: string; tenant_id: string | null } | null = null
  for (const r of candidates ?? []) {
    if (timingSafeCompare(r.token, magicToken)) {
      row = { id: r.id, email: r.email, tenant_id: r.tenant_id }
      break
    }
  }

  if (!row) {
    return c.html(`
      <html><body style="font-family: -apple-system, sans-serif; text-align: center; padding: 80px 20px;">
        <h2>Link expired or already used</h2>
        <p style="color: #666;">Please request a new sign-in link.</p>
        <a href="/${tenantSlug ? '?tenant=' + escapeAttr(tenantSlug) : ''}" style="color: #6B7F5E;">Go back</a>
      </body></html>
    `)
  }

  // Mark token consumed BEFORE issuing the session — even if the rest fails,
  // the magic link is single-use. Use the row id (non-secret PK) rather than
  // the token itself so the token value never appears in a write path.
  await c.env.DB.prepare('UPDATE magic_tokens SET used = 1 WHERE id = ?').bind(row.id).run()

  // Decide role + tenant scope based on the email and the magic_tokens row.
  const platformAdmin = isPlatformAdminEmail(row.email, c.env)

  let sessionTenantId: string
  let cookiePrefix: string
  let redirectLocation: string

  if (row.tenant_id) {
    // Tenant login — session is scoped to that tenant. Preserve the slug in
    // the redirect so we keep tenant context on test env (query-param mode)
    // and idempotently include it on real subdomain prod (harmless extra qs).
    sessionTenantId = row.tenant_id
    const t = await c.env.DB.prepare('SELECT slug FROM tenants WHERE id = ?').bind(row.tenant_id).first<{ slug: string }>()
    const slug = t?.slug ?? tenantSlug ?? ''
    cookiePrefix = tenantCookiePrefix(slug || 'default')
    redirectLocation = slug ? `/?tenant=${encodeURIComponent(slug)}` : '/'
  } else if (platformAdmin) {
    // Platform admin login. On prod admin.<root>, both `/` and `/platform-admin`
    // serve platform-admin.html (per the isAdminHost branch in index.ts).
    // On test (workers.dev) and apex, only `/platform-admin` serves it — `/`
    // is the public marketing page. Redirect to `/platform-admin` so it works
    // on both hosts.
    sessionTenantId = PLATFORM_TENANT_ID
    cookiePrefix = PLATFORM_COOKIE_PREFIX
    redirectLocation = '/platform-admin'
  } else {
    // tenant_id is null and email isn't a platform admin — shouldn't happen
    // (we'd never have inserted such a magic_tokens row), but fail safely.
    return c.text('No tenant associated', 400)
  }

  const role: Role = platformAdmin ? 'platform' : 'admin'
  // Audit ralph-1 C4: bake email into the signed token (v2 shape) so the
  // server can identify the user without trusting the non-HttpOnly
  // `_tester_email` cookie. /api/auth/me PUT now reads from verifiedToken.email.
  const sessionToken = await generateToken(sessionTenantId, role, c.env, row.email)

  // M-2: In this verify flow, role is always 'admin' or 'platform' (never
  // 'viewer') — so cookie Max-Age is always ADMIN_TOKEN_TTL_DAYS (1 day).
  const maxAge = ADMIN_TOKEN_TTL_DAYS * 24 * 60 * 60
  const secure = !c.req.header('Host')?.includes('localhost')
  // _token holds the signed session — HttpOnly so JS can't read it (defense
  // against XSS exfiltration). _auth and _tester_email are presence flags for
  // client JS (`web/src/auth.js#checkAuth`) — must NOT be HttpOnly.
  const tokenOpts = `Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`
  const flagOpts  = `Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? '; Secure' : ''}`

  // URL-encode the session token so the trailing "==" base64 padding doesn't
  // confuse strict cookie parsers (the "=" is otherwise an attribute
  // separator). resolveSession decodeURIComponent's it on read.
  const encodedToken = encodeURIComponent(sessionToken)

  // _tester_email is set for everyone (incl. platform admins) so the profile
  // UI knows which account is signed in and can save display_name/avatar_url.
  // The cookie is host-scoped, so a platform admin's email cookie on tenant A
  // is not visible to tenant B and not visible to anonymous visitors.
  const cookies = [
    `${cookiePrefix}_token=${encodedToken}; ${tokenOpts}`,
    `${cookiePrefix}_auth=authenticated; ${flagOpts}`,
    `${cookiePrefix}_tester_email=${encodeURIComponent(row.email)}; ${flagOpts}`,
  ]

  // Set cookies on a 200 HTML response (NOT a 3xx redirect). Some browsers
  // (notably Safari ITP) treat cookies set on redirects more aggressively
  // than cookies set on direct 200 responses. The body has both a
  // <meta http-equiv="refresh"> AND a JS location.href as belt + suspenders,
  // plus a manual link in case both auto-paths are blocked.
  const host = c.req.header('Host') ?? 'localhost:8787'
  const proto = host.includes('localhost') ? 'http' : 'https'
  const absoluteRedirect = `${proto}://${host}${redirectLocation}`

  // Audit ralph-1 M5: lock down the verify-success HTML response. The page
  // is render-only — no fetches, no images, no inline event handlers (it
  // uses a single <script setTimeout>). A strict CSP closes any future
  // "inject something into the magic-link landing page" vector. The inline
  // <style> + inline <script> require 'unsafe-inline' here; replacing with
  // a nonce-bound shape is a follow-up if/when CSP-Report-Only data lands.
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    // Don't ever cache the auth response — cookies are unique per session.
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
  })
  for (const c2 of cookies) headers.append('Set-Cookie', c2)

  const body = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="0; url=${escapeAttr(absoluteRedirect)}" />
<title>Signed in</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fafaf7;color:#2d2d2d;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{background:#fff;border:1px solid #e5e5e0;border-radius:12px;max-width:420px;width:100%;padding:40px 32px;text-align:center}
  h1{font-size:22px;margin:0 0 8px}
  p{color:#6b6b6b;font-size:14px;margin:0 0 16px}
  a{display:inline-block;background:#6B7F5E;color:#fff;padding:12px 32px;border-radius:8px;font-size:15px;font-weight:600;text-decoration:none}
</style>
</head><body>
<div class="card">
  <h1>Signed in</h1>
  <p>Redirecting to your dashboard…</p>
  <a href="${escapeAttr(absoluteRedirect)}">Continue</a>
</div>
<script>setTimeout(function(){location.href=${JSON.stringify(absoluteRedirect)}}, 50)</script>
</body></html>`

  return new Response(body, { status: 200, headers })
})

/** Add a user to a tenant (admin only). */
auth.post('/api/auth/users', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return badRequest(c, 'Tenant required')

  let body: { email?: string; role?: string }
  try { body = await c.req.json() } catch { return badRequest(c, 'Invalid JSON') }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email || !emailValid(email)) {
    return badRequest(c, 'Valid email required')
  }

  // Refuse to insert a platform admin into tenant_users — they're a hidden
  // role and shouldn't appear in tenant-visible user lists.
  if (isPlatformAdminEmail(email, c.env)) {
    return badRequest(c, 'This email is reserved')
  }

  const role = body.role === 'viewer' ? 'viewer' : 'admin'

  try {
    await c.env.DB.prepare(
      'INSERT INTO tenant_users (id, tenant_id, email, role) VALUES (?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), tenant.id, email, role).run()

    const fromEmail = getAuthFromEmail(c.env)
    const host = c.req.header('Host') ?? 'localhost:8787'
    // Bake a real magic link into the invite so the first click signs them in.
    // Otherwise the invitee lands on the login page and has to request their
    // own link — same dance, twice.
    const loginUrl = await issueMagicLink(c.env, {
      email,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      host,
    })
    const platformName = getPlatformName(c.env)
    const roleLabel = role === 'admin' ? 'an admin' : 'a viewer'
    c.executionCtx.waitUntil(
      sendEmail(c.env, {
        from: { name: `${tenant.name} via ${platformName}`, email: fromEmail },
        to: email,
        subject: `${platformName}: your invite to ${tenant.name}'s rescue bot`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
            <h2 style="color: #333; margin-bottom: 8px;">Sign in to ${tenant.name} on ${platformName}</h2>
            <p style="color: #666; margin-bottom: 24px;">You've been added as ${roleLabel} of ${tenant.name}'s rescue bot on the ${platformName} platform. Click below to sign in — this link expires in ${TOKEN_EXPIRY_MINUTES} minutes.</p>
            <a href="${loginUrl}" style="display: inline-block; background: #6B7F5E; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 600;">Sign In</a>
            <p style="color: #999; font-size: 13px; margin-top: 32px;">If the link expires, just visit <a href="https://${host}/" style="color:#6B7F5E">the portal</a> and request a new sign-in link with this email.</p>
          </div>
        `,
      }),
    )

    return c.json({ success: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('UNIQUE constraint')) return c.json({ error: 'User already exists' }, 409)
    return c.json({ error: 'Database error' }, 500)
  }
})

/** List users for a tenant (admin only). Platform admins never appear here. */
auth.get('/api/auth/users', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return badRequest(c, 'Tenant required')

  const { results } = await c.env.DB.prepare(
    'SELECT id, email, role, created_at FROM tenant_users WHERE tenant_id = ? ORDER BY created_at',
  ).bind(tenant.id).all()

  return c.json({ users: results })
})

/** Remove a user from a tenant (admin only). */
auth.delete('/api/auth/users/:userId', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return badRequest(c, 'Tenant required')

  const userId = c.req.param('userId')
  await c.env.DB.prepare(
    'DELETE FROM tenant_users WHERE id = ? AND tenant_id = ?',
  ).bind(userId, tenant.id).run()

  return c.json({ success: true })
})

/**
 * Read the caller's identity (email) from the signed session token first,
 * falling back to the `_tester_email` cookie if the token predates the v2
 * email-baking (audit ralph-1 C4). This is the load-bearing identity
 * resolver for /api/auth/me reads and writes — the cookie path goes away
 * once all in-flight v1 tokens have aged out (TOKEN_MAX_AGE_MS = 30 days).
 */
async function resolveCallerEmail(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  cookiePrefix: string,
): Promise<string | null> {
  const verified = await resolveSession(c.req.raw, cookiePrefix, c.env)
  if (verified?.email) return verified.email.toLowerCase()
  const cookieEmail = getCookie(c, `${cookiePrefix}_tester_email`)
  if (!cookieEmail) return null
  return decodeURIComponent(cookieEmail).toLowerCase()
}

/** Get current user's profile. Platform admins are stored in platform_users. */
auth.get('/api/auth/me', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return badRequest(c, 'Tenant required')

  const cookiePrefix = tenantCookiePrefix(tenant.slug)
  const decodedEmail = await resolveCallerEmail(c, cookiePrefix)
  if (!decodedEmail) return unauthorized(c, 'Not signed in')

  const platformAdmin = isPlatformAdminEmail(decodedEmail, c.env)

  if (platformAdmin) {
    const row = await c.env.DB.prepare(
      'SELECT email, display_name, avatar_url FROM platform_users WHERE email = ?',
    ).bind(decodedEmail).first<{ email: string; display_name: string | null; avatar_url: string | null }>()
    return c.json({
      email: decodedEmail,
      display_name: row?.display_name ?? null,
      avatar_url: row?.avatar_url ?? null,
      role: 'platform_admin',
      tenant_name: tenant.name,
    })
  }

  const user = await c.env.DB.prepare(
    'SELECT email, display_name, avatar_url, role FROM tenant_users WHERE tenant_id = ? AND email = ?',
  ).bind(tenant.id, decodedEmail).first<{ email: string; display_name: string | null; avatar_url: string | null; role: string }>()

  if (!user) return notFound(c, 'user')

  return c.json({
    email: user.email,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    role: user.role,
    tenant_name: tenant.name,
  })
})

/** Update current user's profile. */
auth.put('/api/auth/me', async (c) => {
  const tenant = c.get('tenant')
  if (!tenant) return badRequest(c, 'Tenant required')

  const cookiePrefix = tenantCookiePrefix(tenant.slug)
  // Audit ralph-1 C4: identity for writes comes from the signed session
  // token, not a client-mutable cookie. resolveCallerEmail prefers
  // verifiedToken.email and falls back to the legacy cookie only for v1
  // tokens still in flight.
  const decodedEmail = await resolveCallerEmail(c, cookiePrefix)
  if (!decodedEmail) return unauthorized(c, 'Not signed in')

  const platformAdmin = isPlatformAdminEmail(decodedEmail, c.env)

  let body: { display_name?: string; avatar_url?: string | null }
  try { body = await c.req.json() } catch { return badRequest(c, 'Invalid JSON') }

  const displayName = typeof body.display_name === 'string' ? body.display_name.trim().slice(0, 100) : null
  // avatar_url: accept null to clear, or a trimmed URL up to 1024 chars. We
  // don't fetch the URL to verify — image rendering is the client's problem.
  let avatarUrl: string | null = null
  if (typeof body.avatar_url === 'string') {
    const trimmed = body.avatar_url.trim().slice(0, 1024)
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      return badRequest(c, 'avatar_url must be an http(s) URL')
    }
    avatarUrl = trimmed || null
  }

  if (platformAdmin) {
    // Upsert into platform_users — the row may not yet exist.
    await c.env.DB.prepare(
      `INSERT INTO platform_users (email, display_name, avatar_url, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(email) DO UPDATE SET
         display_name = excluded.display_name,
         avatar_url   = excluded.avatar_url,
         updated_at   = datetime('now')`,
    ).bind(decodedEmail, displayName, avatarUrl).run()
  } else {
    await c.env.DB.prepare(
      'UPDATE tenant_users SET display_name = ?, avatar_url = ? WHERE tenant_id = ? AND email = ?',
    ).bind(displayName, avatarUrl, tenant.id, decodedEmail).run()
  }

  return c.json({ success: true, display_name: displayName, avatar_url: avatarUrl })
})

export default auth
