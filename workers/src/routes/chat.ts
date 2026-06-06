import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env, Tenant, Variables } from '../lib/types'
import { detectSpecies } from '../lib/rag'
import { buildChatPrompt } from '../lib/chat-prompt'
import { clamp } from '../lib/utils'
import { matchTriage, type TenantTriageRule } from '../lib/match-triage'
import { mintSessionToken, validateSessionToken } from '../lib/photo-auth'
import { photoUploadsEnabled } from '../lib/feature-flags'
import { validateUploadKind } from '../lib/file-type'
import {
  getMainChatModelName,
  getPhotoRecognizerModelName,
  openGatewayChatStream,
  runGatewayChatText,
  runGatewayImageObject,
} from '../lib/ai'
import {
  buildPhotoMetadataSchema,
  buildPhotoMetadataContextSection,
  buildPhotoMetadataSystemSection,
  isCompleteMetadata,
  sanitizeVisionField,
  type PhotoMetadata,
} from '../lib/vision'
import { parseOrgConfig } from '../lib/tenant-loader'
import { dbError } from '../lib/errors'

// ── Constants ─────────────────────────────────────────────────────────────────

const HISTORY_LIMIT = 20

const MAX_MESSAGE_LEN = 8_000
const MAX_CONTENT_LEN = 32_000
const MAX_SESSION_ID_LEN = 128
const MAX_TEXT_FIELD_LEN = 1_000
const MAX_TAGS = 10
const MAX_TAG_LEN = 64

// Image triage v1 caps. Mirrors the operational defaults in the design doc
// appendix. Server enforces by validating Content-Length on the presign call.
const PHOTO_CAP_PER_SESSION_IMAGE = 3
const PHOTO_CAP_PER_SESSION_VIDEO = 1
const PHOTO_BYTES_CAP_IMAGE = 2 * 1024 * 1024     // 2MB after canvas re-encode
const PHOTO_BYTES_CAP_VIDEO = 4 * 1024 * 1024     // 4MB raw, ≤6s clip

// ── Validation helpers ────────────────────────────────────────────────────────

function validSessionId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_SESSION_ID_LEN && /^[\w-]+$/.test(id)
}

function normalizeTags(raw: string | string[] | null | undefined): string | null {
  if (!raw) return null
  const arr = Array.isArray(raw) ? raw : raw.split(',')
  const tags = arr
    .map(t => t.trim().slice(0, MAX_TAG_LEN))
    .filter(Boolean)
    .slice(0, MAX_TAGS)
  return tags.length ? tags.join(', ') : null
}

function citizenPhotoKey(tenantId: string, sessionId: string, photoId: string, ext: 'jpg' | 'mp4'): string {
  // P1-18: keyed on tenant_id, NOT tenant.slug. Slug is a display alias and
  // can change; tenant_id is the immutable identity. Keying R2 objects on
  // slug means a future slug rename (or accidental slug reuse) silently
  // exposes the renamed tenant's old objects to whoever takes the slug
  // next. tenant_id has no such reuse window.
  return `citizen/${tenantId}/${sessionId}/${photoId}.${ext}`
}

// RAG helpers are now in ../lib/rag.ts

/**
 * Build a "Recent Photos" block for the system prompt so the model treats
 * earlier in-session photo analyses as established truth instead of asking
 * the citizen to re-describe what's already in the image. Without this,
 * subsequent text turns (e.g. "what city are you in?") drop back into
 * vision-blind mode and the bot asks "is it an adult or a fledgling?" —
 * which it could have answered from the photo itself. Returns '' when no
 * extracted-metadata photos exist for the session.
 */
async function buildRecentPhotoContext(
  db: D1Database, sessionId: string, tenantId: string,
): Promise<string> {
  type Row = {
    species_guess: string | null
    urgency_score: string | null
    distress_tags: string | null
    condition_tag: string | null
    age_class: string | null
    metadata_status: string | null
    uploaded_at: number
  }
  let rows: Row[] = []
  try {
    const { results } = await db.prepare(
      `SELECT species_guess, urgency_score, distress_tags, condition_tag, age_class, metadata_status, uploaded_at
       FROM photos
       WHERE session_id = ? AND tenant_id = ? AND deleted_at IS NULL AND metadata_status = 'extracted'
       ORDER BY uploaded_at ASC LIMIT 5`,
    ).bind(sessionId, tenantId).all() as { results: Row[] }
    rows = results
  } catch (e) {
    console.warn('[chat] photo context load failed:', e)
    return ''
  }
  if (!rows.length) return ''

  // Vision-model-supplied strings get sanitized before interpolating into the
  // chat prompt — see lib/vision.ts:sanitizeVisionField for the rationale
  // (ralph-1 H1 / ralph-2 C2). The fresh-turn path (vision.ts:buildPhoto
  // MetadataContextSection) uses the same helper so the replay and fresh
  // paths can't diverge.
  const lines = rows.map((r, i) => {
    const tags = (() => {
      try { return r.distress_tags ? (JSON.parse(r.distress_tags) as string[]).join(', ') : '' }
      catch { return r.distress_tags ?? '' }
    })()
    const parts = [`Photo ${i + 1}:`]
    const species = sanitizeVisionField(r.species_guess)
    if (species) parts.push(`  - Species: ${species}`)
    const ageClass = sanitizeVisionField(r.age_class, 20)
    if (ageClass && ageClass !== 'unknown') parts.push(`  - Age class: ${ageClass}`)
    if (r.urgency_score) parts.push(`  - Urgency: ${r.urgency_score}`)
    const tagsClean = sanitizeVisionField(tags, 200)
    if (tagsClean) parts.push(`  - Distress signs visible: ${tagsClean}`)
    const condTag = sanitizeVisionField(r.condition_tag, 60)
    if (condTag) parts.push(`  - Condition match: ${condTag}`)
    return parts.join('\n')
  })
  return [
    '## Recent Photos (already analyzed in this session)',
    '',
    'The citizen uploaded these earlier in the conversation. Treat the metadata',
    'below as established truth — do NOT ask them to re-describe what species',
    'it is, what distress signs are visible, or whether it looks injured. You',
    'already saw the photo. Only ask follow-up questions about details NOT',
    'captured here (e.g. age class, exact location, time first noticed).',
    '',
    ...lines,
  ].join('\n')
}

type ChatContext = Context<{ Bindings: Env; Variables: Variables }>

type ChatHistory = Array<{ role: 'user' | 'assistant'; content: string }>

type RunMainChatOptions = {
  sessionId: string
  tenantId: string
  visibleUserMessage: string
  modelUserMessage?: string
  ragQuery?: string
  privateContext?: string
  userMessageId?: string
  linkPhotoId?: string
}

function pacificNowString(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'full',
    timeStyle: 'short',
  })
}

async function loadChatHistory(
  db: D1Database,
  sessionId: string,
  tenantId: string,
): Promise<ChatHistory> {
  try {
    const { results } = await db.prepare(
      `SELECT role, content FROM messages
       WHERE session_id = ? AND tenant_id = ? AND message_type = 'chat' AND role IN ('user','assistant')
       ORDER BY timestamp ASC LIMIT ?`,
    ).bind(sessionId, tenantId, HISTORY_LIMIT).all() as { results: Array<{ role: string; content: string }> }
    return results.map(r => ({ role: r.role as 'user' | 'assistant', content: r.content }))
  } catch (e) {
    console.error('[chat] Failed to load history — starting fresh:', e)
    return []
  }
}

async function buildMainSystemPrompt(opts: {
  env: Env
  tenant: Tenant
  tenantId: string
  sessionId: string
  ragQuery: string
  turnNumber: number
  privateContext?: string
}): Promise<string> {
  const { env, tenant, tenantId, sessionId, ragQuery, turnNumber, privateContext } = opts
  const photoContext = await buildRecentPhotoContext(env.DB, sessionId, tenantId)
  const privateSections = [photoContext, privateContext].filter(Boolean).join('\n\n')
  const { systemPrompt } = await buildChatPrompt(env, tenant, ragQuery, {
    turnNumber,
    privateContext: privateSections || undefined,
  })
  return systemPrompt
}

function usageTokens(usage: unknown): { promptTokens: number; completionTokens: number } {
  const u = usage as Record<string, number | undefined> | undefined
  return {
    promptTokens: u?.promptTokens ?? u?.inputTokens ?? 0,
    completionTokens: u?.completionTokens ?? u?.outputTokens ?? 0,
  }
}

async function logUsage(
  env: Env,
  tenantId: string,
  model: string,
  usage: unknown,
): Promise<void> {
  const { promptTokens, completionTokens } = usageTokens(usage)
  const today = new Date().toISOString().slice(0, 10)
  await env.DB.prepare(
    `INSERT INTO usage_log (tenant_id, date, model, prompt_tokens, completion_tokens, request_count)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).bind(tenantId, today, model, promptTokens, completionTokens).run()
}

async function runMainChat(
  c: ChatContext,
  opts: RunMainChatOptions,
): Promise<Response> {
  const tenant = c.get('tenant')!
  const history = await loadChatHistory(c.env.DB, opts.sessionId, opts.tenantId)
  const userTurnsSoFar = history.filter((h) => h.role === 'user').length
  const turnNumber = userTurnsSoFar + 1
  const systemPrompt = await buildMainSystemPrompt({
    env: c.env,
    tenant,
    tenantId: opts.tenantId,
    sessionId: opts.sessionId,
    ragQuery: opts.ragQuery ?? opts.visibleUserMessage,
    turnNumber,
    privateContext: opts.privateContext,
  })

  const userMsgId = opts.userMessageId ?? `msg-${crypto.randomUUID()}`
  try {
    await c.env.DB.prepare(
      `INSERT INTO messages (session_id, message_id, role, content, timestamp, message_type, tenant_id)
       VALUES (?, ?, 'user', ?, ?, 'chat', ?) ON CONFLICT (message_id) DO NOTHING`,
    ).bind(opts.sessionId, userMsgId, opts.visibleUserMessage, Date.now(), opts.tenantId).run()
    if (opts.linkPhotoId) {
      await c.env.DB.prepare(`UPDATE photos SET message_id = ? WHERE id = ?`)
        .bind(userMsgId, opts.linkPhotoId).run()
    }
  } catch (e) {
    console.error('[chat] Failed to persist user message:', e)
    return new Response('Failed to record message', { status: 500 })
  }

  const messageWithTime = `[Current time: ${pacificNowString()}]\n\n${opts.modelUserMessage ?? opts.visibleUserMessage}`
  const modelName = getMainChatModelName(c.env)

  // Open the SSE stream against the gateway. If the upstream errors at this
  // step (auth failure, model not found, etc.) we return a clean 502 BEFORE
  // any response body has been sent to the client — the widget's catch path
  // then shows the friendly "having trouble connecting" message.
  let capturedUsage: unknown = null
  let textStream: ReadableStream<string>
  try {
    textStream = await openGatewayChatStream({
      env: c.env,
      model: modelName,
      system: systemPrompt,
      messages: [...history, { role: 'user', content: messageWithTime }],
      onUsage: (u: unknown) => { capturedUsage = u },
    })
  } catch (e) {
    console.error('[chat] AI Gateway stream open failed:', e)
    return new Response('Assistant temporarily unavailable', { status: 502 })
  }

  // Forward each text delta to the client as it arrives. Accumulate the full
  // text so we can persist + analyze after the stream closes. waitUntil keeps
  // the worker alive past the response so the post-stream DB writes complete.
  const encoder = new TextEncoder()
  let fullText = ''
  const sessionId = opts.sessionId
  const tenantId = opts.tenantId
  const ua = c.req.header('User-Agent') || ''

  const outStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = textStream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          fullText += value
          controller.enqueue(encoder.encode(value))
        }
      } catch (e) {
        console.error('[chat] AI Gateway stream read failed:', e)
      } finally {
        try { reader.releaseLock() } catch { /* already released */ }
        controller.close()
      }

      // Persist the assistant message + run the regex triage analyzer once
      // streaming is done. Using waitUntil so this completes even if the
      // client disconnects mid-stream.
      if (fullText) {
        c.executionCtx.waitUntil((async () => {
          const msgId = `msg-${crypto.randomUUID()}`
          try {
            await c.env.DB.prepare(
              `INSERT INTO messages (session_id, message_id, role, content, timestamp, message_type, tenant_id)
               VALUES (?, ?, 'assistant', ?, ?, 'chat', ?) ON CONFLICT (message_id) DO NOTHING`,
            ).bind(sessionId, msgId, fullText.slice(0, MAX_CONTENT_LEN), Date.now(), tenantId).run()
            const deviceType = /Mobile|Android|iPhone|iPad/i.test(ua)
              ? (/iPad|Tablet/i.test(ua) ? 'tablet' : 'mobile') : 'desktop'
            await quickAnalyzeSession(c.env.DB, tenantId, sessionId, deviceType)
          } catch (e) {
            console.error('[chat] Failed to persist assistant message or analyze:', e)
          }
          if (capturedUsage) {
            await logUsage(c.env, tenantId, modelName, capturedUsage).catch(e =>
              console.error('[chat] Failed to log usage:', e))
          }
        })())
      }
    },
  })

  return new Response(outStream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

// ── Hono sub-app ──────────────────────────────────────────────────────────────

const chat = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── Sessions ──────────────────────────────────────────────────────────────────

chat.post('/api/sessions', async (c) => {
  const id = crypto.randomUUID()
  const tenant = c.get('tenant')

  // When photo uploads are enabled for this tenant, mint a session token. The
  // client passes it as Authorization: Bearer <token> on photo endpoints. If
  // the flag is off OR no tenant context, skip the mint (silent — keeps the
  // POST /api/sessions response shape backward-compatible for legacy callers
  // who don't know to read session_token).
  let session_token: string | undefined
  if (tenant && photoUploadsEnabled(tenant)) {
    try {
      session_token = await mintSessionToken(c.env, id, tenant.id)
    } catch (e) {
      console.warn('[sessions/post] session token mint failed (continuing):', e)
    }
  }

  return c.json({ id, session_token })
})

chat.get('/api/sessions/:id', async (c) => {
  const sessionId = c.req.param('id')
  if (!validSessionId(sessionId)) return c.json({ error: 'Invalid session ID' }, 400)

  const tenant = c.get('tenant')
  const tenantId = tenant!.id

  try {
    const [{ results: messages }, photoCountRow] = await Promise.all([
      c.env.DB.prepare(
        `SELECT message_id, role, content, timestamp, created_at
         FROM messages WHERE session_id = ? AND tenant_id = ? AND message_type = 'chat' ORDER BY timestamp ASC`,
      ).bind(sessionId, tenantId).all(),
      // photo_count is the count the client uses to rehydrate its cap counter
      // on widget reopen mid-session. Reservations + completed uploads count;
      // deleted ones don't.
      c.env.DB.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN kind = 'image' THEN 1 ELSE 0 END), 0) AS images,
           COALESCE(SUM(CASE WHEN kind = 'video' THEN 1 ELSE 0 END), 0) AS videos
         FROM photos
         WHERE session_id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      ).bind(sessionId, tenantId).first<{ images: number; videos: number }>(),
    ])

    return c.json({
      id: sessionId,
      messages,
      photo_count: {
        images: Number(photoCountRow?.images ?? 0),
        videos: Number(photoCountRow?.videos ?? 0),
        cap_images: PHOTO_CAP_PER_SESSION_IMAGE,
        cap_videos: PHOTO_CAP_PER_SESSION_VIDEO,
      },
    })
  } catch (e) {
    return dbError(c, 'sessions/get', 'DB error', e)
  }
})

// ── Photo upload (image triage v1) ────────────────────────────────────────────

/**
 * Worker-proxied citizen photo upload.
 *
 * Per /plan-eng-review 1A pivot: R2 S3-compatible API tokens for presigning
 * are not publicly available via the Cloudflare API (dashboard-only). For a
 * per-tenant feature behind a flag, Worker-proxied uploads are the pragmatic
 * choice — bytes flow through the Worker for the photo case (≤2MB) but the
 * security model collapses to a single Bearer auth check.
 *
 * Auth: existing /api/sessions/* Origin allowlist (handled by index.ts
 *       middleware) PLUS Authorization: Bearer <session_token>.
 *
 * Body: multipart/form-data with a single 'photo' field. kind defaults to
 *       'image'; pass kind=video in form for video uploads.
 *
 * Validation: feature flag, per-session cap, content-length cap, kind allowlist.
 *
 * Side effects: writes the photo row with uploaded_at = now (no separate
 * reservation phase needed since the Worker controls the byte flow), writes
 * the bytes to R2 via the binding.
 */
chat.post('/api/sessions/:id/photo', async (c) => {
  const sessionId = c.req.param('id')
  if (!validSessionId(sessionId)) return c.json({ error: 'Invalid session ID' }, 400)

  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  const tenantId = tenant.id

  if (!photoUploadsEnabled(tenant)) {
    return c.json({ error: 'Photo uploads not enabled for this tenant' }, 403)
  }
  if (!(await validateSessionToken(c.env, c.req.raw, sessionId, tenantId))) {
    return c.json({ error: 'Invalid session token' }, 401)
  }

  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return c.json({ error: 'Expected multipart/form-data with photo field' }, 400)
  }

  const fileEntry = formData.get('photo')
  const kindRaw = formData.get('kind')
  // FormDataEntryValue is `File | string`. We need a Blob-like with .size,
  // .type, and .stream(). string entries fail the typeof check.
  if (!fileEntry || typeof fileEntry === 'string') {
    return c.json({ error: 'photo field must be a file' }, 400)
  }
  const file = fileEntry as Blob & { type?: string; name?: string }
  const kind: 'image' | 'video' = kindRaw === 'video' ? 'video' : 'image'

  // Size check first — cheap, and refusing oversized uploads here avoids
  // burning bandwidth on the magic-byte read for bad inputs.
  const cap = kind === 'video' ? PHOTO_BYTES_CAP_VIDEO : PHOTO_BYTES_CAP_IMAGE
  if (file.size > cap) {
    return c.json({ error: `${kind} exceeds ${cap}-byte cap`, cap }, 413)
  }

  // Magic-byte content sniffing (audit P1-22). The client-supplied
  // file.type was previously trusted, which let an attacker upload a zip
  // (or anything) with type=image/jpeg — the worker stored it to R2 with
  // a wrong Content-Type, then operator browsers later sniffed real bytes
  // and either errored or hit content-type confusion. validateUploadKind
  // reads the first 12 bytes, matches against canonical signatures
  // (JPEG/PNG/GIF/WebP/HEIC for image, MP4/WebM for video), and refuses
  // any input whose detected kind doesn't match the caller's `kind` arg.
  // The TRUSTED MIME from sniff result is what we hand to R2 — the
  // client's file.type is discarded for storage purposes.
  const sniff = await validateUploadKind(file, kind)
  if (!sniff.ok) {
    return c.json({ error: `photo content rejected: ${sniff.reason}` }, 400)
  }
  const contentType = sniff.type!.mime

  // Cap-check including any in-flight uploads (rare with Worker-proxied path
  // but cheap to keep the same TOCTOU-resistant query as the original design).
  const countRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN kind = ? THEN 1 ELSE 0 END), 0) AS n
     FROM photos
     WHERE session_id = ? AND tenant_id = ? AND deleted_at IS NULL`,
  ).bind(kind, sessionId, tenantId).first<{ n: number }>()
  const used = Number(countRow?.n ?? 0)
  const sessionCap = kind === 'video' ? PHOTO_CAP_PER_SESSION_VIDEO : PHOTO_CAP_PER_SESSION_IMAGE
  if (used >= sessionCap) {
    return c.json({ error: `Per-session ${kind} cap reached`, cap: sessionCap, used }, 429)
  }

  const photoId = crypto.randomUUID()
  const ext = kind === 'video' ? 'mp4' : 'jpg'
  const key = citizenPhotoKey(tenant.id, sessionId, photoId, ext)
  const now = Date.now()

  // Stream bytes to R2. Worker isolate budget = 128MB; image cap is 2MB,
  // video cap is 4MB — comfortable headroom even at peak concurrency.
  try {
    await c.env.MEDIA_BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType },
    })
  } catch (e) {
    console.error('[photo-upload] R2 put failed:', e)
    return c.json({ error: 'Failed to store photo' }, 500)
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO photos (
         id, session_id, tenant_id, r2_key, kind, reserved_at, uploaded_at, metadata_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')`,
    ).bind(photoId, sessionId, tenantId, key, kind, now, now).run()
  } catch (e) {
    console.error('[photo-upload] DB insert failed:', e)
    // Roll back R2 — orphaned bytes aren't a security issue but waste storage.
    c.executionCtx.waitUntil(c.env.MEDIA_BUCKET.delete(key).catch(() => {}))
    return c.json({ error: 'Failed to record photo' }, 500)
  }

  return c.json({ photo_id: photoId, kind, content_type: contentType })
})

/**
 * Citizen-requested photo deletion. Auth: session_token Bearer + Origin allowlist.
 * Idempotent (returns 204 even if already deleted).
 */
chat.delete('/api/sessions/:id/photo/:photoId', async (c) => {
  const sessionId = c.req.param('id')
  const photoId = c.req.param('photoId')
  if (!validSessionId(sessionId)) return c.json({ error: 'Invalid session ID' }, 400)
  if (!validSessionId(photoId)) return c.json({ error: 'Invalid photo ID' }, 400)

  const tenant = c.get('tenant')
  if (!tenant) return c.json({ error: 'Tenant required' }, 400)
  const tenantId = tenant.id

  if (!(await validateSessionToken(c.env, c.req.raw, sessionId, tenantId))) {
    return c.json({ error: 'Invalid session token' }, 401)
  }

  const row = await c.env.DB.prepare(
    `SELECT r2_key, thumbnail_key, deleted_at FROM photos
     WHERE id = ? AND session_id = ? AND tenant_id = ?`,
  )
    .bind(photoId, sessionId, tenantId)
    .first<{ r2_key: string; thumbnail_key: string | null; deleted_at: number | null }>()

  if (!row) return c.json({ error: 'Not found' }, 404)
  if (row.deleted_at !== null) return new Response(null, { status: 204 })

  try {
    await Promise.all([
      c.env.MEDIA_BUCKET.delete(row.r2_key),
      row.thumbnail_key ? c.env.MEDIA_BUCKET.delete(row.thumbnail_key) : Promise.resolve(),
    ])
  } catch (e) {
    console.error('[photo-delete] R2 delete failed:', e)
    return c.json({ error: 'Failed to delete photo' }, 500)
  }

  const now = Date.now()
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE photos SET deleted_at = ? WHERE id = ?`).bind(now, photoId),
    c.env.DB.prepare(
      `INSERT INTO photo_deletions (id, photo_id, tenant_id, deleted_by, reason, ts)
       VALUES (?, ?, ?, 'citizen', 'citizen-request', ?)`,
    ).bind(crypto.randomUUID(), photoId, tenantId, now),
  ])

  return new Response(null, { status: 204 })
})

// ── Chat ──────────────────────────────────────────────────────────────────────

chat.post('/api/sessions/:id', async (c) => {
  const sessionId = c.req.param('id')
  if (!validSessionId(sessionId)) return c.json({ error: 'Invalid session ID' }, 400)

  const tenant = c.get('tenant')
  const tenantId = tenant!.id

  let body: { message?: string; photo_id?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const userMessage = typeof body?.message === 'string' ? body.message.trim() : ''
  const photoId = typeof body?.photo_id === 'string' ? body.photo_id.trim() : ''

  // Photo branch: when a photo_id is attached, route to the vision flow.
  // Vision flow has its own auth (session_token Bearer) + flag gate + R2 read
  // path + tool-call metadata persistence. Otherwise it shares everything
  // (history, RAG, system prompt, persistence) with the text-only path.
  if (photoId) {
    return handlePhotoMessage(c, sessionId, tenantId, photoId, userMessage)
  }

  if (!userMessage) return c.json({ error: 'message required' }, 400)
  if (userMessage.length > MAX_MESSAGE_LEN) {
    return c.json({ error: `Message too long (max ${MAX_MESSAGE_LEN} characters)` }, 400)
  }

  return runMainChat(c, {
    sessionId,
    tenantId,
    visibleUserMessage: userMessage,
    ragQuery: userMessage,
  })
})

// ── Photo branch (image triage v1, Day 3) ─────────────────────────────────────

type PhotoRecognitionResult = {
  metadata: PhotoMetadata | null
  usage: unknown | null
  model: string
}

async function recognizePhoto(opts: {
  env: Env
  bytes: Uint8Array
  mediaType: string
  userMessage: string
}): Promise<PhotoRecognitionResult> {
  const model = getPhotoRecognizerModelName(opts.env)
  const system = buildPhotoMetadataSystemSection({
    hasImage: true,
    hasVideo: false,
  })
  const messageText = opts.userMessage
    ? `Citizen caption: ${opts.userMessage}\n\nExtract metadata from the uploaded media.`
    : 'Extract metadata from the uploaded media.'
  const result = await runGatewayImageObject({
    env: opts.env,
    model,
    system,
    text: messageText,
    bytes: opts.bytes,
    mediaType: opts.mediaType,
    schema: buildPhotoMetadataSchema(),
    schemaName: 'photo_metadata',
    schemaDescription: 'Structured triage metadata extracted from the uploaded wildlife photo.',
  })

  return {
    metadata: isCompleteMetadata(result.object) ? result.object as PhotoMetadata : null,
    usage: result.usage,
    model,
  }
}

function buildPhotoRagQuery(userMessage: string, metadata: PhotoMetadata | null): string {
  const parts = [userMessage.trim()]
  if (metadata) {
    if (metadata.species && metadata.species !== 'unknown') parts.push(metadata.species)
    if (metadata.age_class && metadata.age_class !== 'unknown') parts.push(metadata.age_class)
    if (metadata.distress_tags.length) parts.push(metadata.distress_tags.join(' '))
    if (metadata.urgency) parts.push(metadata.urgency)
  }
  return parts.filter(Boolean).join(' ')
}

function buildPhotoPrivateContext(photoId: string, metadata: PhotoMetadata | null): string {
  if (metadata) return buildPhotoMetadataContextSection(metadata)
  return `

## Known Photo Facts — unavailable

The user uploaded photo ${photoId}, but the stateless vision recognizer failed to return complete metadata.

Hard rule: you have NOT seen usable visual facts from this photo. Do not write "based on the photo/image", do not identify a species, do not infer age class, and do not mention injuries, blood, posture, or condition from the image. Ask the citizen to briefly describe the animal and visible condition in words, while still giving safe general containment guidance if the situation sounds urgent.`
}

function buildPhotoModelUserMessage(userMessage: string, metadata: PhotoMetadata | null): string {
  if (metadata) {
    return userMessage
      ? `${userMessage}\n\n[The user also uploaded a photo. Use only the private photo facts in the system prompt.]`
      : 'The user uploaded a photo. Use only the private photo facts in the system prompt.'
  }

  const caption = userMessage.trim()
  return caption
    ? `Citizen message accompanying an uploaded photo whose recognizer failed: ${caption}\n\n[No usable visual facts are available. Do not claim to inspect or infer anything from the photo. Ask the citizen to describe the animal and visible condition in words.]`
    : 'The user uploaded a photo, but no usable visual facts are available. Do not claim to inspect or infer anything from the photo. Ask the citizen to describe the animal and visible condition in words.'
}

async function handlePhotoMessage(
  c: ChatContext,
  sessionId: string,
  tenantId: string,
  photoId: string,
  userMessage: string,
): Promise<Response> {
  if (!validSessionId(photoId)) return c.json({ error: 'Invalid photo_id' }, 400)
  const tenant = c.get('tenant')!

  if (!photoUploadsEnabled(tenant)) {
    return c.json({ error: 'Photo uploads not enabled for this tenant' }, 403)
  }
  if (!(await validateSessionToken(c.env, c.req.raw, sessionId, tenantId))) {
    return c.json({ error: 'Invalid session token' }, 401)
  }
  // userMessage is optional in vision flow — citizen can upload a photo with
  // no text and the bot speaks first ("photo opens the conversation"). Cap
  // length defensively.
  if (userMessage.length > MAX_MESSAGE_LEN) {
    return c.json({ error: `Message too long (max ${MAX_MESSAGE_LEN} characters)` }, 400)
  }

  // Look up the photo. Must belong to session + tenant + have an uploaded_at
  // (a reservation row that was never PUT can't be referenced here). If the
  // chat path runs before the head() check on the upload-url endpoint had a
  // chance, we 409 — client retries.
  const photoRow = await c.env.DB.prepare(
    `SELECT r2_key, kind, uploaded_at, deleted_at, message_id
     FROM photos
     WHERE id = ? AND session_id = ? AND tenant_id = ?`,
  )
    .bind(photoId, sessionId, tenantId)
    .first<{
      r2_key: string
      kind: 'image' | 'video'
      uploaded_at: number | null
      deleted_at: number | null
      message_id: string | null
    }>()

  if (!photoRow) return c.json({ error: 'Photo not found' }, 404)
  if (photoRow.deleted_at !== null) return c.json({ error: 'Photo deleted' }, 410)
  if (photoRow.message_id) {
    return c.json({ error: 'Photo has already been attached to a chat turn' }, 409)
  }
  if (photoRow.kind !== 'image') {
    return c.json({ error: 'Video triage is not supported yet. Please upload a still photo.' }, 415)
  }
  if (photoRow.uploaded_at === null) {
    // The R2 PUT didn't complete (or the head() check hasn't been done yet).
    // Verify directly with R2 — the head() resolves the race for us.
    const head = await c.env.MEDIA_BUCKET.head(photoRow.r2_key)
    if (!head) return c.json({ error: 'Photo upload not yet complete' }, 409)
    // Mark the row as uploaded so subsequent calls don't re-do this.
    await c.env.DB.prepare(`UPDATE photos SET uploaded_at = ? WHERE id = ?`)
      .bind(Date.now(), photoId).run()
  }

  // Pull bytes from R2. Workers memory budget allows up to ~128MB per isolate;
  // images are <2MB per the operational caps, so this is safe.
  const obj = await c.env.MEDIA_BUCKET.get(photoRow.r2_key)
  if (!obj) {
    return c.json({ error: 'Photo body not found in storage' }, 404)
  }
  const bytes = new Uint8Array(await obj.arrayBuffer())
  const mediaType = obj.httpMetadata?.contentType ?? 'image/jpeg'

  const userMsgId = `msg-${crypto.randomUUID()}`
  let metadata: PhotoMetadata | null = null
  try {
    const recognition = await recognizePhoto({
      env: c.env,
      bytes,
      mediaType,
      userMessage,
    })
    metadata = recognition.metadata
    c.executionCtx.waitUntil(
      recognition.usage
        ? logUsage(c.env, tenantId, recognition.model, recognition.usage)
          .catch(e => console.error('[chat/photo] Failed to log vision usage:', e))
        : Promise.resolve(),
    )
  } catch (e) {
    console.error('[chat/photo] metadata extraction failed:', e)
  }

  if (metadata) {
    try {
      await c.env.DB.prepare(
        `UPDATE photos
         SET metadata_status = 'extracted',
             species_guess = ?,
             urgency_score = ?,
             distress_tags = ?,
             condition_tag = ?,
             age_class = ?
         WHERE id = ?`,
      )
        .bind(
          metadata.species,
          metadata.urgency,
          JSON.stringify(metadata.distress_tags),
          metadata.condition_tag ?? null,
          metadata.age_class ?? null,
          photoId,
        )
        .run()
    } catch (e) {
      console.error('[chat/photo] persist photo metadata failed:', e)
    }
  } else {
    await c.env.DB.prepare(`UPDATE photos SET metadata_status = 'metadata_failed' WHERE id = ?`)
      .bind(photoId).run()
      .catch((e) => console.error('[chat/photo] mark metadata_failed failed:', e))
  }

  return runMainChat(c, {
    sessionId,
    tenantId,
    visibleUserMessage: userMessage || `[photo: ${photoId}]`,
    modelUserMessage: buildPhotoModelUserMessage(userMessage, metadata),
    ragQuery: buildPhotoRagQuery(userMessage, metadata),
    privateContext: buildPhotoPrivateContext(photoId, metadata),
    userMessageId: userMsgId,
    linkPhotoId: photoId,
  })
}

// ── Frontend event ingestion ──────────────────────────────────────────────────

chat.post('/api/messages', async (c) => {
  const tenant = c.get('tenant')
  const tenantId = tenant!.id

  let body: Record<string, unknown>
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const role = typeof body.role === 'string' ? body.role : ''
  if (!sessionId || !validSessionId(sessionId)) return c.json({ error: 'Valid sessionId required' }, 400)
  if (role !== 'user' && role !== 'assistant') return c.json({ error: 'role must be user or assistant' }, 400)

  const messageId = typeof body.messageId === 'string' && body.messageId
    ? body.messageId.slice(0, 128) : `msg-${crypto.randomUUID()}`

  const timing = body.timing && typeof body.timing === 'object' ? body.timing as Record<string, unknown> : {}

  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO messages
         (session_id, message_id, role, content, timestamp, tester_name,
          time_to_first_token, total_time, error_type, message_type, client_ip, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO NOTHING`,
    ).bind(
      sessionId, messageId, role,
      clamp(body.content as string, MAX_CONTENT_LEN),
      typeof body.timestamp === 'number' ? body.timestamp : Date.now(),
      clamp(body.testerName as string, MAX_TEXT_FIELD_LEN),
      typeof timing.timeToFirstToken === 'number' ? timing.timeToFirstToken : null,
      typeof timing.totalTime === 'number' ? timing.totalTime : null,
      clamp(body.errorType as string, 64),
      clamp(body.messageType as string, 32) ?? 'chat',
      c.req.header('CF-Connecting-IP') ?? null,
      tenantId,
    ).run()
    return c.json({ success: true, inserted: result.meta.changes > 0 })
  } catch (e) {
    return dbError(c, 'feedback/message', 'DB error', e)
  }
})

chat.post('/api/feedback', async (c) => {
  const tenant = c.get('tenant')
  const tenantId = tenant!.id

  let body: Record<string, unknown>
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (!sessionId || !validSessionId(sessionId)) return c.json({ error: 'Valid sessionId required' }, 400)

  const rating = body.rating
  if (rating !== 0 && rating !== 1) return c.json({ error: 'rating must be 0 or 1' }, 400)

  const testerName = clamp(body.testerName as string, MAX_TEXT_FIELD_LEN)
  const isTester = testerName ? 1 : 0

  try {
    await c.env.DB.prepare(
      `INSERT INTO feedback
         (session_id, message_id, rating, feedback_text, tags, timestamp,
          tester_name, message_preview, is_tester, client_ip, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      sessionId,
      clamp(body.messageId as string, 128),
      rating,
      clamp(body.feedback as string, MAX_TEXT_FIELD_LEN),
      normalizeTags(body.tags as string | string[]),
      typeof body.timestamp === 'number' ? body.timestamp : Date.now(),
      testerName,
      clamp(body.messagePreview as string, 200),
      isTester,
      c.req.header('CF-Connecting-IP') ?? null,
      tenantId,
    ).run()
    return c.json({ success: true })
  } catch (e) {
    return dbError(c, 'feedback/feedback', 'DB error', e)
  }
})

// ── Post-session quick analysis (no LLM — regex only) ────────────────────────

export async function quickAnalyzeSession(db: D1Database, tenantId: string, sessionId: string, deviceType = 'unknown') {
  const { results: msgs } = await db.prepare(
    `SELECT role, content FROM messages WHERE session_id = ? AND tenant_id = ? AND message_type = 'chat' ORDER BY timestamp ASC LIMIT 50`,
  ).bind(sessionId, tenantId).all()

  // Threshold is <2 (not <3) because callers sometimes dump a full report —
  // species, situation, name, phone — into a single user message, bot replies
  // once, conversation ends. Skipping those at <3 hides legitimate action
  // items (e.g. callers who left contact info in one block).
  if (msgs.length < 2) return

  const allContent = msgs.map(m => (m.content as string || '').toLowerCase()).join(' ')
  const userContent = msgs.filter(m => m.role === 'user').map(m => (m.content as string || '').toLowerCase()).join(' ')

  // Detect contact info (callback requested)
  const hasPhone = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(allContent) &&
    msgs.some(m => m.role === 'user' && /\d{3}[-.]?\d{3}[-.]?\d{4}/.test(m.content as string))
  const hasEmail = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/.test(userContent)
  const requestsCallback = /call me|contact me|please call|my (name|number|email|phone) is|reach me/i.test(userContent)
  const hasContactInfo = hasPhone || hasEmail || requestsCallback

  // Extract contact info
  let contactInfo: string | null = null
  if (hasContactInfo) {
    const phoneMatch = userContent.match(/\b(\d{3}[-.]?\d{3}[-.]?\d{4})\b/)
    const emailMatch = userContent.match(/\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/)
    const nameMatch = userContent.match(/my name is ([a-z]+ ?[a-z]*)/i)
    contactInfo = JSON.stringify({
      phone: phoneMatch?.[1] || null,
      email: emailMatch?.[1] || null,
      name: nameMatch?.[1] || null,
    })
  }

  // Detect urgency — tenant rules override defaults, defaults fill in gaps
  const tenantRow = await db.prepare('SELECT org_config FROM tenants WHERE id = ?').bind(tenantId).first<{ org_config: string | null }>()
  const orgCfg = parseOrgConfig(tenantRow?.org_config)
  const tenantRules = orgCfg.triage_config as TenantTriageRule[] | undefined

  const triage = matchTriage(userContent, tenantRules)
  const urgency = triage.urgency
  const triageHint: string | null = triage.hint

  // Detect animal type
  let animal: string | null = null
  const animalPatterns: Array<[RegExp, string]> = [
    [/raccoon|coon/i, 'raccoon'], [/bat\b/i, 'bat'], [/hawk|owl|eagle|raptor|falcon/i, 'raptor'],
    [/squirrel/i, 'squirrel'], [/opossum|possum/i, 'opossum'], [/deer|fawn/i, 'deer'],
    [/hummingbird/i, 'hummingbird'], [/snake|rattlesnake/i, 'snake'], [/coyote/i, 'coyote'],
    [/pelican/i, 'pelican'], [/goose|duck/i, 'waterfowl'], [/gull|seagull/i, 'gull'],
    [/bird|robin|sparrow|finch|jay|crow|dove|pigeon/i, 'songbird'],
    [/heron|egret/i, 'heron/egret'],
  ]
  for (const [pattern, name] of animalPatterns) {
    if (pattern.test(userContent)) { animal = name; break }
  }

  // Simple outcome detection
  let outcome = 'unknown'
  const lastAssistant = msgs.filter(m => m.role === 'assistant').pop()
  const lastContent = (lastAssistant?.content as string || '').toLowerCase()
  if (/call us|bring.*to|come to|intake/i.test(lastContent)) outcome = 'bringing_in'
  else if (/leave.*alone|monitor|watch|mom.*return|reunif/i.test(lastContent)) outcome = 'resolved'
  else if (/outside.*service|not.*our.*area|redirect|peninsula|sacramento/i.test(lastContent)) outcome = 'redirected'

  // Check feedback
  const hasFeedback = await db.prepare(
    'SELECT rating FROM feedback WHERE session_id = ? AND tenant_id = ? LIMIT 1',
  ).bind(sessionId, tenantId).first()

  // Determine if this needs action.
  //
  // Per WildCare ops: front-desk only follows up on conversations where the
  // caller left contact info (name/phone/email or explicit callback request).
  // Urgency labels are still computed (and visible in the report) but they
  // don't gate "needs follow-up" — without contact info there's no one to
  // follow up with.
  //
  // A negative feedback rating still flags for follow-up so we can review
  // bad bot answers even when the caller didn't share contact info.
  const needsAction = (hasContactInfo || (hasFeedback && hasFeedback.rating === 0)) ? 1 : 0

  // Generate a brief situation summary
  const firstUserMsg = msgs.find(m => m.role === 'user')?.content as string || ''
  const situation = firstUserMsg.slice(0, 200)

  // Detect service area (simple: check if redirected)
  const inServiceArea = outcome === 'redirected' ? 0 : 1

  // Delete + insert (no unique constraint migration dependency)
  await db.prepare(
    'DELETE FROM session_analysis WHERE session_id = ? AND tenant_id = ?',
  ).bind(sessionId, tenantId).run()

  await db.prepare(`
    INSERT INTO session_analysis (session_id, tenant_id, urgency, outcome, animal, situation, in_service_area, needs_action, contact_info, device_type, triage_hint, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(sessionId, tenantId, urgency, outcome, animal, situation, inServiceArea, needsAction, contactInfo, deviceType, triageHint).run()
}

export default chat
