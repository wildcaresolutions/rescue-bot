-- Image triage v1 schema.
-- Two new tables (photos, photo_deletions) + two altered columns on existing
-- tables (tenants.feature_flags, sessions.session_token). See the design doc
-- appendix at:
-- ~/.gstack/projects/mcavage-wildcare-bot/mcavage-cf-migration-design-20260426-image-triage.md

-- Per-photo state: one row per citizen upload (image or video). Reservation
-- rows (uploaded_at IS NULL) resolve TOCTOU on the per-session cap by being
-- created before the Worker writes the object to R2 and reaped if the upload
-- fails before completion.
CREATE TABLE IF NOT EXISTS photos (
  id              TEXT PRIMARY KEY,           -- ulid, server-minted at reservation
  session_id      TEXT NOT NULL,
  message_id      TEXT,                        -- nullable until attached to a chat turn
  tenant_id       TEXT NOT NULL,
  r2_key          TEXT NOT NULL,               -- citizen/{tenant}/{session}/{id}.{ext}
  thumbnail_key   TEXT,                        -- citizen/{tenant}/{session}/{id}-thumb.jpg
  kind            TEXT NOT NULL,               -- 'image' | 'video'
  uploaded_at     INTEGER,                     -- nullable: NULL = mint reservation
  reserved_at     INTEGER NOT NULL,
  metadata_status TEXT NOT NULL DEFAULT 'processing',
                                               -- 'processing' | 'extracted' | 'metadata_failed' | 'manually_tagged'
  species_guess   TEXT,
  urgency_score   TEXT,                        -- 'HIGH' | 'MEDIUM' | 'LOW'
  distress_tags   TEXT,                        -- json array
  condition_tag   TEXT,                        -- closed-set, drives reference compare
  trajectory_state TEXT,                       -- v1.5: 'deteriorating' | 'stable' | 'improving' | NULL
  prior_photo_id   TEXT,                       -- v1.5 FK
  retention_class TEXT NOT NULL DEFAULT 'standard',
                                               -- 'standard' (30d) | 'clinical' (90d)
  responded_at    INTEGER,
  deleted_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_photos_session ON photos(session_id);
CREATE INDEX IF NOT EXISTS idx_photos_tenant_uploaded ON photos(tenant_id, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_photos_unresponded_high ON photos(tenant_id, urgency_score, responded_at)
  WHERE deleted_at IS NULL;

-- Audit trail for hard-delete actions (citizen-requested, retention sweep, or
-- admin "contains identifying info" flow). PII stays in R2 only as long as
-- needed; we keep the audit row indefinitely.
CREATE TABLE IF NOT EXISTS photo_deletions (
  id              TEXT PRIMARY KEY,
  photo_id        TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  deleted_by      TEXT NOT NULL,               -- 'citizen' | admin email | 'retention_sweep'
  reason          TEXT,                        -- 'citizen-request' | 'pii' | 'expired' | etc.
  ts              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photo_deletions_tenant ON photo_deletions(tenant_id, ts);

-- Per-tenant feature flags. Json blob so future flags don't proliferate
-- columns. Primary use case for v1: photo_uploads_enabled. Worker reads
-- JSON.parse(tenant.feature_flags || '{}').photo_uploads_enabled.
ALTER TABLE tenants ADD COLUMN feature_flags TEXT DEFAULT '{}';

-- Session-bound nonce minted on POST /api/sessions. Validated as
-- Authorization: Bearer <session_token> on photo endpoints. Closes the
-- spoofed-Origin token-burn abuse vector (existing chat path stays
-- Origin-allowlist-gated for v1).
--
-- Citizen sessions are otherwise stateless (just UUIDs in messages.session_id),
-- so we keep this in its own table rather than introducing a sessions row
-- that would need joins everywhere else.
CREATE TABLE IF NOT EXISTS citizen_session_tokens (
  session_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL                  -- 24h from creation; reaped by retention sweep
);

CREATE INDEX IF NOT EXISTS idx_citizen_session_tokens_expires ON citizen_session_tokens(expires_at);
