import { Hono } from 'hono'
import type { Env, Tenant, Variables } from '../lib/types'
import { hashPassword, generateToken, verifyToken, isDevAuthBypass, resolveSession, tenantCookiePrefix } from '../lib/auth'
import { invalidateTenantCache } from '../lib/cache'
import { clamp } from '../lib/utils'
import type { OrgConfig, BotOverrides } from '../lib/compile-instruction'
import { verifyTurnstile } from '../lib/turnstile'
import { sanitizeCustomCss } from '../lib/css-sanitize'
import { loadTenantBySlug } from '../lib/tenant-loader'
import { stageConfigChange, type DraftConfig } from '../lib/draft'
import { dbError } from '../lib/errors'
import { sendEmail } from '../lib/email'
import { getPlatformName, getAuthFromEmail } from '../lib/platform'
import { tenantHostFor, tenantPortalUrl } from '../lib/routing'
import { issueMagicLink } from './auth'

// ── Constants ─────────────────────────────────────────────────────────────────

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'platform', 'www', 'app', 'mail', 'ftp', 'cdn',
  'static', 'assets', 'health', 'status', 'default',
])

const MAX_LOGO_SIZE = 2 * 1024 * 1024   // 2 MB
const MAX_DOC_SIZE = 1 * 1024 * 1024     // 1 MB
const MAX_DOC_COUNT = 20
// Audit ralph-2 C1: SVG dropped from the allowlist. Operator-uploaded SVGs
// served as `image/svg+xml` from the platform origin execute arbitrary
// inline <script> on viewer load — cross-tenant XSS when a platform admin
// previews a tenant's logo, and admin-console XSS when the tenant admin
// loads their own console. The minimum-disruption fix is "no SVG"; if any
// operator needs vector logos in the future, re-add behind a real
// sanitizer (DOMPurify on the SVG namespace, or an inline-script-stripping
// pre-write filter). Raster formats cover every use case today.
const ALLOWED_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp'])

/** Sanitize a filename to prevent path traversal. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128)
}

/** Escape user-supplied text for safe interpolation into transactional
 *  email HTML (org/contact names come straight off the public apply form). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Derive safe content type from file extension. SVG intentionally absent
 *  (see ALLOWED_IMAGE_EXTS) — the upload validator refuses it upstream so
 *  the map never sees an svg extension; falls through to octet-stream
 *  defensively. */
function safeContentType(ext: string): string {
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  }
  return map[ext] || 'application/octet-stream'
}

function validSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug)
}

function chunkText(text: string, maxTokens: number): string[] {
  const chunks: string[] = []
  const paragraphs = text.split(/\n\n+/)
  let current = ''
  for (const para of paragraphs) {
    if (current && (current.length + para.length) / 4 > maxTokens) {
      chunks.push(current.trim())
      current = ''
    }
    current += (current ? '\n\n' : '') + para
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

// ── Hono sub-app ──────────────────────────────────────────────────────────────

const platform = new Hono<{ Bindings: Env; Variables: Variables }>()

/** Submit an application to join the platform (public, no auth). */
platform.post('/platform/apply', async (c) => {
  let body: Record<string, unknown>
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  // Turnstile (this endpoint is reachable from the public-internet marketing
  // site — the only other auth in front of it is the bot challenge).
  if (!isDevAuthBypass(c.env)) {
    const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? null
    const tt = typeof body.turnstile_token === 'string' ? body.turnstile_token : null
    const tr = await verifyTurnstile(tt, ip, c.env.TURNSTILE_SECRET_KEY)
    if (!tr.ok) {
      // Always log — site/secret mismatches and timeout-or-duplicate rejections
      // were silent before, which made the form's "Captcha verification failed"
      // banner impossible to root-cause.
      console.error('[platform/apply] turnstile rejected:', tr)
      if (tr.reason === 'missing_secret' || tr.reason === 'network') {
        return c.json({ error: 'Captcha service unavailable' }, 503)
      }
      return c.json({ error: 'Captcha verification failed', reason: tr.reason, details: tr.details }, 400)
    }
  }

  const orgName = typeof body.org_name === 'string' ? body.org_name.trim() : ''
  const contactName = typeof body.contact_name === 'string' ? body.contact_name.trim() : ''
  const contactEmail = typeof body.contact_email === 'string' ? body.contact_email.trim() : ''

  if (!orgName) return c.json({ error: 'Organization name is required' }, 400)
  if (!contactName) return c.json({ error: 'Contact name is required' }, 400)
  if (!contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    return c.json({ error: 'Valid contact email is required' }, 400)
  }

  const id = crypto.randomUUID()

  try {
    await c.env.DB.prepare(
      `INSERT INTO applications (id, org_name, contact_name, contact_email, contact_phone,
         website, use_case, animal_types, service_area, location_county, location_state, hosting_domain,
         source, ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, orgName, contactName, contactEmail,
      clamp(body.contact_phone as string, 32),
      clamp(body.website as string, 512),
      clamp(body.use_case as string, 2000),
      clamp(body.animal_types as string, 1000),
      clamp(body.service_area as string, 512),
      clamp(body.location_county as string, 128),
      clamp(body.location_state as string, 64),
      clamp(body.hosting_domain as string, 256),
      clamp(body.source as string, 128),
      clamp(body.ref as string, 128),
    ).run()

    // Confirmation to the applicant — best effort. Before this, a public
    // submit returned 200 and then went silent: the applicant had no signal
    // it worked and would re-submit or assume the form was broken. A mail
    // failure must NOT fail the application, so this rides waitUntil.
    // Confirm to the applicant. sendEmail never throws (it catches its own
    // errors and reports via the result), so a mail problem can't fail the
    // submit — we just don't block the 201 on a perfect send. With no EMAIL
    // binding (local/dev) it logs the would-be message and no-ops.
    const platformName = getPlatformName(c.env)
    await sendEmail(c.env, {
      from: { name: platformName, email: getAuthFromEmail(c.env) },
      to: contactEmail,
      subject: `We received your ${platformName} application`,
      html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
            <h2 style="color: #333; margin-bottom: 8px;">Thanks, ${escapeHtml(contactName)}!</h2>
            <p style="color: #666; margin-bottom: 16px;">We've received ${escapeHtml(orgName)}'s application to join ${platformName}. Our team will review it and follow up by email — usually within a couple of business days.</p>
            <p style="color: #999; font-size: 13px; margin-top: 24px;">You don't need to do anything else right now. If you have questions, just reply to this email.</p>
          </div>
        `,
    })

    return c.json({ success: true, id }, 201)
  } catch (e) {
    return dbError(c, 'platform/apply', 'DB error', e)
  }
})

/** Create a tenant directly (platform admin only). */
platform.post('/platform/signup', async (c) => {
  // Auth is enforced by the /platform/* middleware in index.ts.

  let body: Record<string, unknown>
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  const slug = typeof body.slug === 'string' ? body.slug.toLowerCase().trim() : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const phone = clamp(body.phone as string, 32)
  const email = (typeof body.email === 'string' ? body.email.trim().toLowerCase() : '')
  const url = clamp(body.url as string, 512)
  const locationCounty = clamp(body.location_county as string, 128)
  const locationState = clamp(body.location_state as string, 64)
  const locationServiceArea = clamp(body.location_service_area as string, 512)
  const colorPrimary = clamp(body.color_primary as string, 7) ?? '#2d7a3c'
  const colorSecondary = clamp(body.color_secondary as string, 7) ?? '#1a4a24'
  const colorAccent = clamp(body.color_accent as string, 7) ?? '#5cb85c'

  if (!name) return c.json({ error: 'name is required' }, 400)
  if (!slug) return c.json({ error: 'slug is required' }, 400)
  if (!validSlug(slug)) {
    return c.json({ error: 'Invalid slug. Use 3-50 lowercase letters, numbers, and hyphens.' }, 400)
  }
  // Magic-link onboarding: the contact email is the sign-in identity, not a
  // password to read out. No operator-chosen password — we set a random one
  // just to satisfy the NOT NULL column; nobody uses legacy password login.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'A valid contact email is required' }, 400)
  }

  const id = crypto.randomUUID()
  const randomPassword = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(36).slice(-1)).join('')
  const passwordHash = await hashPassword(randomPassword)

  try {
    await c.env.DB.prepare(
      `INSERT INTO tenants (id, slug, name, phone, email, url,
         location_county, location_state, location_service_area,
         color_primary, color_secondary, color_accent, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, slug, name, phone, email, url,
      locationCounty, locationState, locationServiceArea,
      colorPrimary, colorSecondary, colorAccent, passwordHash,
    ).run()

    // The contact becomes the tenant's first admin user, so they can request a
    // magic link. Mirror of the approval flow.
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO tenant_users (id, tenant_id, email, role) VALUES (?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), id, email, 'admin').run()

    const adminToken = await generateToken(id, true, c.env, email)

    // Email the contact a one-click sign-in link to their portal. Awaited so
    // we can report whether it sent and surface a dev link when there's no
    // EMAIL binding.
    const reqHost = c.req.header('Host') ?? 'localhost:8787'
    const platformName = getPlatformName(c.env)
    const portalUrl = tenantPortalUrl(reqHost, slug)
    const loginUrl = await issueMagicLink(c.env, { email, tenantId: id, tenantSlug: slug, host: tenantHostFor(reqHost, slug) })
    const emailResult = await sendEmail(c.env, {
      from: { name: platformName, email: getAuthFromEmail(c.env) },
      to: email,
      subject: `Your ${name} rescue bot is ready on ${platformName}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #333; margin-bottom: 8px;">You're set up 🎉</h2>
          <p style="color: #666; margin-bottom: 24px;">${escapeHtml(name)}'s rescue assistant is ready on ${platformName}. Click below to sign in to your admin console — this link expires in 15 minutes.</p>
          <a href="${loginUrl}" style="display: inline-block; background: #6B7F5E; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 600;">Open your console</a>
          <p style="color: #999; font-size: 13px; margin-top: 32px;">If the link expires, visit <a href="${portalUrl}" style="color:#6B7F5E">your portal</a> and request a new sign-in link with this email (${escapeHtml(email)}).</p>
        </div>`,
    })
    if (emailResult.sent === false && emailResult.reason !== 'no_binding') {
      console.error('[platform/signup] welcome email failed:', emailResult)
    }

    return c.json({
      success: true,
      tenant: { id, slug, name },
      admin_token: adminToken,
      contact_email: email,
      portal_url: portalUrl,
      email_sent: emailResult.sent === true,
      ...(emailResult.sent === false && emailResult.reason === 'no_binding' ? { dev_login_url: loginUrl } : {}),
    }, 201)
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e)
    if (errMsg.includes('UNIQUE constraint failed') || errMsg.includes('tenants.slug')) {
      return c.json({ error: 'Slug already taken' }, 409)
    }
    return dbError(c, 'platform/signup', 'DB error', e)
  }
})

platform.post('/platform/setup/:slug', async (c) => {
  const slug = c.req.param('slug')

  // Accept either a Bearer token (legacy admin password flow) or the
  // magic-link session cookie (the standard path for tenant operators).
  // Without the cookie fallback, every cookie-authed publish failed with
  // 401 because Authorization wasn't set — silently breaking the editor
  // for any tenant signed in via magic link.
  const authHeader = c.req.header('Authorization')
  let verified: { tenantId: string; isAdmin: boolean } | null = null
  if (authHeader?.startsWith('Bearer ')) {
    verified = await verifyToken(authHeader.slice(7), c.env)
  }
  if (!verified) {
    verified = await resolveSession(c.req.raw, tenantCookiePrefix(slug), c.env)
  }
  if (!verified?.isAdmin) return c.json({ error: 'Unauthorized' }, 401)

  const tenant = await loadTenantBySlug(c.env, slug)
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
  if (verified.tenantId !== tenant.id) return c.json({ error: 'Unauthorized' }, 401)

  const contentType = c.req.header('Content-Type') ?? ''

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData()
    const results: Record<string, unknown> = {}

    const logoRaw = formData.get('logo')
    const logo = logoRaw && typeof logoRaw !== 'string' ? logoRaw as unknown as File : null
    if (logo) {
      if (logo.size > MAX_LOGO_SIZE) return c.json({ error: 'Logo too large (max 2MB)' }, 413)
      const ext = logo.name.split('.').pop()?.toLowerCase() ?? 'png'
      if (!ALLOWED_IMAGE_EXTS.has(ext)) return c.json({ error: `Invalid logo format. Allowed: ${[...ALLOWED_IMAGE_EXTS].join(', ')}` }, 400)
      // P1-18: key on tenant.id, not slug — slug is a display alias and
      // could be renamed/reused; tenant_id is immutable identity.
      const r2Key = `tenants/${tenant.id}/logo.${ext}`
      await c.env.R2.put(r2Key, logo.stream(), {
        httpMetadata: { contentType: safeContentType(ext) },
      })
      // Blob is written to R2 immediately (binary can't sit in a JSON draft),
      // but the logo_r2_key is STAGED — the live widget keeps the old logo
      // until Publish. (Reference docs below index immediately — that's RAG,
      // intentionally live, and labeled "applies immediately" in the UI.)
      await stageConfigChange(c.env.DB, tenant, { logo_r2_key: r2Key })
      results.logo = { key: r2Key, url: `/assets/${r2Key}` }
    }

    const docsRaw = formData.getAll('docs')
    const indexedDocs: string[] = []
    for (const docRaw of docsRaw) {
      if (typeof docRaw === 'string') continue
      const doc = docRaw as unknown as File
      if (doc.size > MAX_DOC_SIZE) continue
      if (indexedDocs.length >= MAX_DOC_COUNT) break

      const safeName = sanitizeFilename(doc.name)
      // P1-18: tenant_id-keyed R2 path + Vectorize ID prefix (see logo above).
      const r2Key = `tenants/${tenant.id}/docs/${safeName}`
      const content = await doc.text()
      await c.env.R2.put(r2Key, content, {
        httpMetadata: { contentType: doc.type || 'text/plain' },
      })

      try {
        const chunks = chunkText(content, 512)
        for (let i = 0; i < chunks.length; i++) {
          const embResult = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: chunks[i] }) as { data: number[][] }
          await c.env.VECTORIZE.upsert([{
            // P1-18: ID prefixed with tenant.id so two tenants' chunks of
            // the same filename never collide; the metadata.tenant_id is the
            // query-time filter, but the ID itself also disambiguates so
            // re-indexing one tenant doesn't overwrite another's vectors.
            id: `${tenant.id}-${safeName}-${i}`,
            values: embResult.data[0],
            metadata: { text: chunks[i], source: safeName, tenant_id: tenant.id },
          }])
        }
        indexedDocs.push(safeName)
      } catch (e) {
        console.error(`[setup] Failed to index doc ${doc.name}:`, e)
      }
    }
    if (indexedDocs.length) results.docs = indexedDocs

    invalidateTenantCache(slug)
    return c.json({ success: true, ...results })
  }

  // JSON body: STAGE config changes into the tenant's draft. Nothing here
  // touches the live columns the bot serves — that only happens at Publish
  // (POST /admin/publish → lib/publish.ts), which also re-runs the instruction
  // compile. Each field maps to a DraftConfig patch key (same clamps/sanitize
  // as before; JSON columns stay objects, serialized at publish).
  let body: Record<string, unknown>
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  const patch: DraftConfig = {}
  if (typeof body.custom_instruction === 'string') patch.custom_instruction = body.custom_instruction.slice(0, 10_000)
  if (typeof body.phone === 'string') patch.phone = clamp(body.phone, 32)
  if (typeof body.email === 'string') patch.email = clamp(body.email, 256)
  if (typeof body.url === 'string') patch.url = clamp(body.url, 512)
  if (typeof body.location_county === 'string') patch.location_county = clamp(body.location_county, 128)
  if (typeof body.location_state === 'string') patch.location_state = clamp(body.location_state, 64)
  if (typeof body.location_service_area === 'string') patch.location_service_area = clamp(body.location_service_area, 512)
  if (typeof body.color_primary === 'string') { const v = clamp(body.color_primary, 7); if (v) patch.color_primary = v }
  if (typeof body.color_secondary === 'string') { const v = clamp(body.color_secondary, 7); if (v) patch.color_secondary = v }
  if (typeof body.color_accent === 'string') { const v = clamp(body.color_accent, 7); if (v) patch.color_accent = v }
  if (typeof body.widget_theme === 'object' && body.widget_theme !== null) patch.widget_theme = body.widget_theme as Record<string, unknown>
  if (typeof body.widget_custom_css === 'string' || body.widget_custom_css === null) {
    // Sanitize before staging (audit P1-21) — null clears.
    const raw = body.widget_custom_css as string | null
    patch.widget_custom_css = raw === null ? null : sanitizeCustomCss(raw).css
  }
  if (typeof body.org_config === 'object' && body.org_config !== null) patch.org_config = body.org_config as OrgConfig
  if (typeof body.bot_overrides === 'object' && body.bot_overrides !== null) patch.bot_overrides = body.bot_overrides as BotOverrides
  if (typeof body.report_recipients === 'string' || body.report_recipients === null) {
    const cleaned = ((body.report_recipients ?? '') as string).split(',').map(s => s.trim()).filter(Boolean).join(',')
    patch.report_recipients = cleaned ? clamp(cleaned, 1024) : null
  }
  if (typeof body.daily_reports_enabled === 'boolean') patch.daily_reports_enabled = body.daily_reports_enabled ? 1 : 0
  if (typeof body.house_rules === 'string' || body.house_rules === null) patch.house_rules = (body.house_rules as string | null)?.slice(0, 10000) ?? null
  if (typeof body.custom_instruction_locked === 'boolean') {
    patch.custom_instruction_locked = body.custom_instruction_locked ? 1 : 0
    patch.custom_instruction_locked_at = body.custom_instruction_locked ? new Date().toISOString() : null
  }
  // NOTE: `widget_published` is no longer handled here — publishing is the
  // global POST /admin/publish action; the Preview button calls that.

  if (Object.keys(patch).length) {
    try {
      await stageConfigChange(c.env.DB, tenant, patch)
    } catch (e) {
      console.error('[platform/setup] stage failed:', e, { slug, keys: Object.keys(patch) })
      return c.json({ error: 'Couldn’t save your changes. Try again in a moment — if this keeps happening, contact support.' }, 500)
    }
  }

  return c.json({ success: true })
})

platform.get('/platform/dashboard', async (c) => {
  // Auth is enforced by the /platform/* middleware in index.ts.

  try {
    const { results: tenants } = await c.env.DB.prepare(`
      SELECT t.id, t.slug, t.name, t.email, t.created_at,
        (SELECT COUNT(DISTINCT session_id) FROM messages WHERE tenant_id = t.id AND message_type = 'chat') AS session_count,
        (SELECT COUNT(*) FROM messages WHERE tenant_id = t.id AND message_type = 'chat') AS message_count
      FROM tenants t ORDER BY t.created_at DESC
    `).all()

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const { results: usage } = await c.env.DB.prepare(`
      SELECT tenant_id, SUM(prompt_tokens) as prompt_tokens, SUM(completion_tokens) as completion_tokens,
             SUM(request_count) as request_count
      FROM usage_log WHERE date >= ?
      GROUP BY tenant_id
    `).bind(thirtyDaysAgo).all()

    const usageMap = new Map(usage.map(u => [u.tenant_id, u]))

    return c.json({
      tenants: tenants.map(t => ({
        ...t,
        usage_30d: usageMap.get(t.id as string) ?? { prompt_tokens: 0, completion_tokens: 0, request_count: 0 },
      })),
    })
  } catch (e) {
    return dbError(c, 'platform/dashboard', 'DB error', e)
  }
})

platform.get('/platform/applications', async (c) => {
  // Auth is enforced by the /platform/* middleware in index.ts.

  const status = c.req.query('status') ?? 'pending'
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM applications WHERE status = ? ORDER BY created_at DESC',
    ).bind(status).all()
    return c.json({ applications: results })
  } catch (e) {
    return dbError(c, 'platform/applications', 'DB error', e)
  }
})

platform.post('/platform/applications/:id/approve', async (c) => {
  // Auth is enforced by the /platform/* middleware in index.ts.

  const appId = c.req.param('id')

  let body: { slug?: string; password?: string } = {}
  try { body = await c.req.json() } catch { /* optional body */ }

  try {
    const application = await c.env.DB.prepare(
      'SELECT * FROM applications WHERE id = ?',
    ).bind(appId).first<Record<string, string>>()
    if (!application) return c.json({ error: 'Application not found' }, 404)
    if (application.status !== 'pending') return c.json({ error: 'Application already processed' }, 400)

    const slug = (typeof body.slug === 'string' && body.slug)
      ? body.slug.toLowerCase().trim()
      : application.org_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)

    if (!validSlug(slug)) return c.json({ error: `Invalid slug: ${slug}` }, 400)

    const password = (typeof body.password === 'string' && body.password.length >= 6)
      ? body.password
      : [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(36).slice(-1)).join('')

    const tenantId = crypto.randomUUID()
    const passwordHash = await hashPassword(password)

    await c.env.DB.prepare(
      `INSERT INTO tenants (id, slug, name, phone, email, url,
         location_county, location_state, location_service_area,
         hosting_domain, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      tenantId, slug, application.org_name,
      application.contact_phone, application.contact_email,
      application.website,
      application.location_county, application.location_state,
      application.service_area, application.hosting_domain,
      passwordHash,
    ).run()

    if (application.hosting_domain) {
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO allowed_domains (tenant_id, domain) VALUES (?, ?)',
      ).bind(tenantId, application.hosting_domain).run()
    }

    await c.env.DB.prepare(
      "UPDATE applications SET status = 'approved', tenant_id = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    ).bind(tenantId, appId).run()

    // The approved contact becomes the tenant's first admin user. Without
    // this row they can't request a magic link (the auth flow only issues
    // links to known tenant_users), so before this fix a freshly-approved
    // operator was provisioned but locked out. INSERT OR IGNORE so a re-run
    // (or a slug collision retry) doesn't 500 on the UNIQUE(tenant,email).
    const contactEmail = (application.contact_email || '').trim().toLowerCase()
    if (contactEmail) {
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO tenant_users (id, tenant_id, email, role) VALUES (?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), tenantId, contactEmail, 'admin').run()
    }

    // Audit ralph-2 H6: bake the contact email into the v2 token so the
    // first sign-in already has email identity, not a v1 fallback that
    // would require re-auth.
    const adminToken = await generateToken(tenantId, true, c.env, application.contact_email)

    // Welcome the operator with a one-click sign-in link to THEIR portal
    // (the approval runs on the platform-admin host, so the link must point
    // at the tenant's own host/slug). Mirrors the invite flow in auth.ts —
    // links expire in 15 min, so the email also tells them how to request a
    // fresh one. Awaited (not waitUntil) so the platform admin sees whether
    // the mail actually went out, and so dev (no EMAIL binding) can surface
    // the link inline.
    const reqHost = c.req.header('Host') ?? 'localhost:8787'
    const platformName = getPlatformName(c.env)
    const portalUrl = tenantPortalUrl(reqHost, slug)
    let emailResult: Awaited<ReturnType<typeof sendEmail>> | null = null
    let devLoginUrl: string | undefined
    if (contactEmail) {
      const loginUrl = await issueMagicLink(c.env, {
        email: contactEmail,
        tenantId,
        tenantSlug: slug,
        host: tenantHostFor(reqHost, slug),
      })
      devLoginUrl = loginUrl
      emailResult = await sendEmail(c.env, {
        from: { name: platformName, email: getAuthFromEmail(c.env) },
        to: contactEmail,
        subject: `Your ${application.org_name} rescue bot is ready on ${platformName}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
            <h2 style="color: #333; margin-bottom: 8px;">You're approved 🎉</h2>
            <p style="color: #666; margin-bottom: 24px;">${escapeHtml(application.org_name)}'s rescue assistant is set up on ${platformName}. Click below to sign in to your admin console and finish onboarding — this link expires in 15 minutes.</p>
            <a href="${loginUrl}" style="display: inline-block; background: #6B7F5E; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 600;">Open your console</a>
            <p style="color: #999; font-size: 13px; margin-top: 32px;">If the link expires, visit <a href="${portalUrl}" style="color:#6B7F5E">your portal</a> and request a new sign-in link with this email address (${escapeHtml(contactEmail)}).</p>
          </div>
        `,
      })
      if (emailResult.sent === false && emailResult.reason !== 'no_binding') {
        console.error('[platform/approve] welcome email failed:', emailResult)
      }
    }

    return c.json({
      success: true,
      tenant: { id: tenantId, slug, name: application.org_name },
      admin_token: adminToken,
      contact_email: application.contact_email,
      portal_url: portalUrl,
      email_sent: emailResult?.sent === true,
      // Surface the one-click link in the response when there's no EMAIL
      // binding (local dev / unconfigured) so onboarding can be demoed
      // without a working mail pipe.
      ...(emailResult && emailResult.sent === false && emailResult.reason === 'no_binding'
        ? { dev_login_url: devLoginUrl }
        : {}),
    })
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e)
    if (errMsg.includes('UNIQUE constraint failed') && errMsg.includes('tenants.slug')) {
      return c.json({ error: 'Slug already taken — provide a different slug' }, 409)
    }
    return dbError(c, 'platform/approve', 'DB error', e)
  }
})

platform.post('/platform/applications/:id/reject', async (c) => {
  // Auth is enforced by the /platform/* middleware in index.ts.

  const appId = c.req.param('id')

  let body: { notes?: string } = {}
  try { body = await c.req.json() } catch { /* optional body */ }

  try {
    const result = await c.env.DB.prepare(
      "UPDATE applications SET status = 'rejected', notes = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
    ).bind(clamp(body.notes as string, 1000), appId).run()

    if (result.meta.changes === 0) return c.json({ error: 'Application not found or already processed' }, 404)
    return c.json({ success: true })
  } catch (e) {
    return dbError(c, 'platform/reject', 'DB error', e)
  }
})

export default platform
