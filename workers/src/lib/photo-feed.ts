/**
 * Photo feed assembly + per-photo operator actions for the admin UI's
 * image triage strip (image triage v1). All routes live at /admin/photos/*
 * and /admin/photo-feed in admin.ts; the logic lives here so the route
 * handlers are thin auth-and-validation wrappers.
 */
import type { Env } from './types'
import { DISTRESS_TAGS } from './vision'

export const PHOTO_FEED_DEFAULT_LIMIT = 50
export const PHOTO_FEED_MAX_LIMIT = 200
export const PHOTO_FEED_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

interface PhotoFeedRow {
  id: string
  session_id: string
  message_id: string | null
  r2_key: string
  thumbnail_key: string | null
  kind: 'image' | 'video'
  uploaded_at: number | null
  metadata_status: string
  species_guess: string | null
  urgency_score: string | null
  distress_tags: string | null
  condition_tag: string | null
  trajectory_state: string | null
  responded_at: number | null
}

/** Parse a JSON string, return [] on failure. Used for distress_tags
 * columns that store JSON arrays. Exported because /admin/sessions/:id
 * also reads photo rows. */
export function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return [] }
}

export interface PhotoFeedResult {
  photos: unknown[]
  since: number
  server_time: number
}

/**
 * Morning briefing photo feed. Sorted with HIGH-urgency unresponded at the
 * front, then processing/metadata_failed, then resolved. Tenant-scoped via
 * existing /admin/* middleware (caller passes tenantId already validated).
 */
export async function loadPhotoFeed(
  env: Env,
  tenantId: string,
  opts: { since?: string; limit?: string } = {},
): Promise<PhotoFeedResult | { error: string; status: number }> {
  const sinceTs = opts.since
    ? Math.max(0, Number(opts.since)) || (Date.now() - PHOTO_FEED_DEFAULT_WINDOW_MS)
    : Date.now() - PHOTO_FEED_DEFAULT_WINDOW_MS
  const pageLimit = Math.min(Number(opts.limit) || PHOTO_FEED_DEFAULT_LIMIT, PHOTO_FEED_MAX_LIMIT)

  let rows: PhotoFeedRow[] = []
  try {
    // Sort key: HIGH-unresponded first (urgency='HIGH' AND responded_at IS NULL),
    // then processing/failed (metadata_status != 'extracted' AND != 'manually_tagged'),
    // then everything else by uploaded_at desc.
    const result = await env.DB.prepare(`
      SELECT id, session_id, message_id, r2_key, thumbnail_key, kind, uploaded_at,
             metadata_status, species_guess, urgency_score, distress_tags,
             condition_tag, trajectory_state, responded_at
      FROM photos
      WHERE tenant_id = ?
        AND deleted_at IS NULL
        AND uploaded_at IS NOT NULL
        AND uploaded_at >= ?
      ORDER BY
        CASE
          WHEN urgency_score = 'HIGH' AND responded_at IS NULL THEN 0
          WHEN metadata_status IN ('processing', 'metadata_failed') THEN 1
          WHEN responded_at IS NULL THEN 2
          ELSE 3
        END,
        uploaded_at DESC
      LIMIT ?
    `).bind(tenantId, sinceTs, pageLimit).all<PhotoFeedRow>()
    rows = result.results
  } catch (e) {
    console.error('[admin/photo-feed] DB error:', e)
    return { error: 'Database error', status: 500 }
  }

  // Photo URLs are Worker-served (no S3-compat presigning available); the
  // /admin/photos/:photoId/raw endpoint auths + serves the bytes.
  const photos = rows.map((row) => ({
    photo_id: row.id,
    session_id: row.session_id,
    message_id: row.message_id,
    kind: row.kind,
    uploaded_at: row.uploaded_at,
    species_guess: row.species_guess,
    urgency_score: row.urgency_score,
    distress_tags: row.distress_tags ? safeJsonParse(row.distress_tags) : [],
    condition_tag: row.condition_tag,
    trajectory_state: row.trajectory_state,
    metadata_status: row.metadata_status,
    responded: row.responded_at !== null,
    photo_url: `/admin/photos/${row.id}/raw`,
  }))

  return {
    photos,
    since: sinceTs,
    server_time: Date.now(),
  }
}

/**
 * Serve a citizen photo's bytes through the Worker. Returns a Response
 * (200 with body) on success or an error sentinel otherwise. Cache-Control
 * is short-private — leaked admin URLs expire quickly.
 *
 * Replaces the presigned-read-URL design (1A pivot — R2 S3-compat tokens
 * are dashboard-only).
 */
export async function servePhotoAsset(
  env: Env,
  tenantId: string,
  photoId: string,
): Promise<Response | { error: string; status: number }> {
  const row = await env.DB.prepare(
    `SELECT r2_key, deleted_at FROM photos WHERE id = ? AND tenant_id = ?`,
  )
    .bind(photoId, tenantId)
    .first<{ r2_key: string; deleted_at: number | null }>()

  if (!row || row.deleted_at !== null) return { error: 'Not found', status: 404 }

  const obj = await env.MEDIA_BUCKET.get(row.r2_key)
  if (!obj) return { error: 'Object missing in storage', status: 404 }

  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  // Short private cache: defends against admin URL leakage.
  headers.set('Cache-Control', 'private, max-age=300')
  return new Response(obj.body, { headers })
}

/** Mark a single photo as resolved (per-photo, not per-session — multiple
 * photos in one session may have different lifecycles). */
export async function resolvePhoto(
  env: Env,
  tenantId: string,
  photoId: string,
): Promise<{ success: true } | { error: string; status: number }> {
  try {
    const result = await env.DB.prepare(
      `UPDATE photos SET responded_at = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    ).bind(Date.now(), photoId, tenantId).run()
    if (result.meta.changes === 0) return { error: 'Not found', status: 404 }
    return { success: true }
  } catch (e) {
    console.error('[admin/photo-resolve] DB error:', e)
    return { error: 'Database error', status: 500 }
  }
}

/**
 * Manual-tag a processing/metadata_failed photo. The rehabber assigns the
 * species + urgency directly when the model didn't (per Pass 2A).
 */
export async function manualTagPhoto(
  env: Env,
  tenantId: string,
  photoId: string,
  body: { species?: string; urgency?: string; distress_tags?: string[]; condition_tag?: string | null },
): Promise<{ success: true } | { error: string; status: number }> {
  const species = typeof body.species === 'string' ? body.species.trim().slice(0, 200) : null
  const urgency = typeof body.urgency === 'string' && ['HIGH', 'MEDIUM', 'LOW'].includes(body.urgency)
    ? body.urgency : null
  if (!species || !urgency) {
    return { error: 'species and urgency (HIGH|MEDIUM|LOW) required', status: 400 }
  }
  // Distress tags from controlled vocabulary only.
  const incomingTags = Array.isArray(body.distress_tags) ? body.distress_tags : []
  const distressTags = incomingTags
    .filter((t): t is string => typeof t === 'string')
    .filter((t) => (DISTRESS_TAGS as readonly string[]).includes(t))
  const conditionTag = typeof body.condition_tag === 'string' ? body.condition_tag.slice(0, 100) : null

  try {
    const result = await env.DB.prepare(
      `UPDATE photos
       SET metadata_status = 'manually_tagged',
           species_guess = ?,
           urgency_score = ?,
           distress_tags = ?,
           condition_tag = ?
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    ).bind(
      species,
      urgency,
      JSON.stringify(distressTags),
      conditionTag,
      photoId,
      tenantId,
    ).run()
    if (result.meta.changes === 0) return { error: 'Not found', status: 404 }
    return { success: true }
  } catch (e) {
    console.error('[admin/photo-manual-tag] DB error:', e)
    return { error: 'Database error', status: 500 }
  }
}

/**
 * Admin-side hard delete with PII reason. Per /plan-eng-review OV3: rehabber
 * sees identifying info in a photo (kid in frame, license plate, etc.) and
 * deletes immediately. Hard delete + audit row. R2 deletion happens in a
 * background task — caller passes a `waitUntil` function from the request's
 * executionCtx.
 */
export async function deletePhoto(
  env: Env,
  tenantId: string,
  photoId: string,
  body: { reason?: string; deleted_by?: string },
  waitUntil: (p: Promise<unknown>) => void,
): Promise<
  | { success: true; already_deleted?: true }
  | { error: string; status: number }
> {
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : 'pii'
  const deletedBy = typeof body.deleted_by === 'string' ? body.deleted_by.trim().slice(0, 200) : 'admin'

  const row = await env.DB.prepare(
    `SELECT r2_key, thumbnail_key, deleted_at FROM photos WHERE id = ? AND tenant_id = ?`,
  ).bind(photoId, tenantId).first<{ r2_key: string; thumbnail_key: string | null; deleted_at: number | null }>()

  if (!row) return { error: 'Not found', status: 404 }
  if (row.deleted_at !== null) return { success: true, already_deleted: true }

  const now = Date.now()
  const auditId = crypto.randomUUID()
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE photos SET deleted_at = ? WHERE id = ?`).bind(now, photoId),
      env.DB.prepare(
        `INSERT INTO photo_deletions (id, photo_id, tenant_id, deleted_by, reason, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(auditId, photoId, tenantId, deletedBy, reason, now),
    ])
  } catch (e) {
    console.error('[admin/photo-delete] DB error:', e)
    return { error: 'Database error', status: 500 }
  }

  waitUntil(
    Promise.allSettled([
      env.MEDIA_BUCKET.delete(row.r2_key),
      row.thumbnail_key ? env.MEDIA_BUCKET.delete(row.thumbnail_key) : Promise.resolve(),
    ]).then((rs) => rs.forEach((r, i) => {
      if (r.status === 'rejected') console.warn(`[admin/photo-delete] R2 delete ${i} failed:`, r.reason)
    })),
  )

  return { success: true }
}
