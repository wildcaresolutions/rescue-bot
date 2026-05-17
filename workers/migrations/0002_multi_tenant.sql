-- Multi-tenant support: tenants table, usage tracking, tenant_id on all tables

-- ── Tenants ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,                    -- UUID
  slug TEXT NOT NULL UNIQUE,              -- subdomain slug (e.g., "marin-wildlife")
  name TEXT NOT NULL,                     -- org display name
  phone TEXT,                             -- org phone number
  url TEXT,                               -- org website
  email TEXT,                             -- org contact email
  location_county TEXT,
  location_state TEXT,
  location_service_area TEXT,
  color_primary TEXT DEFAULT '#2d7a3c',
  color_secondary TEXT DEFAULT '#1a4a24',
  color_accent TEXT DEFAULT '#5cb85c',
  logo_r2_key TEXT,                       -- R2 key for logo (tenants/{slug}/logo.{ext})
  custom_instruction TEXT,                -- org-specific agent instruction (appended to base)
  password_hash TEXT NOT NULL,            -- bcrypt/scrypt hash for org auth
  admin_token_hash TEXT,                  -- separate admin auth (optional, falls back to password)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);

-- ── Usage logging (per-tenant token tracking for cost attribution) ───────────

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  date TEXT NOT NULL,                     -- YYYY-MM-DD
  model TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  request_count INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_usage_log_tenant_date ON usage_log(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_usage_log_date ON usage_log(date);

-- ── Add tenant_id to existing tables ─────────────────────────────────────────

ALTER TABLE messages ADD COLUMN tenant_id TEXT;
ALTER TABLE feedback ADD COLUMN tenant_id TEXT;
ALTER TABLE reports ADD COLUMN tenant_id TEXT;

-- ── Create default tenant for existing single-tenant data ────────────────────

INSERT INTO tenants (id, slug, name, phone, password_hash)
VALUES ('default', 'default', 'WildCare Bot', '', 'LEGACY_SITE_PASSWORD');

-- ── Backfill tenant_id on existing data ──────────────────────────────────────

UPDATE messages SET tenant_id = 'default' WHERE tenant_id IS NULL;
UPDATE feedback SET tenant_id = 'default' WHERE tenant_id IS NULL;
UPDATE reports SET tenant_id = 'default' WHERE tenant_id IS NULL;

-- ── Indexes for tenant-scoped queries ────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_tenant_session ON messages(tenant_id, session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_tenant ON feedback(tenant_id);
CREATE INDEX IF NOT EXISTS idx_reports_tenant ON reports(tenant_id);
