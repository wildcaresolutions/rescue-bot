-- Remove the "default" tenant and replace with a real "wildcare" tenant
-- All existing data is remapped from tenant_id='default' to the new wildcare tenant

-- ── Create the wildcare tenant with real config from site.yaml ──────────────

INSERT INTO tenants (
  id, slug, name, phone, url, email,
  location_county, location_state, location_service_area,
  color_primary, color_secondary, color_accent,
  password_hash
) VALUES (
  'wc-0001-wildcare-0001', 'wildcare', 'WildCare', '(415) 456-7283',
  'https://www.discoverwildcare.org', NULL,
  'Marin', 'CA', 'Marin County, CA',
  '#78a12e', '#004863', '#f4a518',
  'LEGACY_SITE_PASSWORD'
);

-- ── Remap all existing data from default → wildcare ─────────────────────────

UPDATE messages SET tenant_id = 'wc-0001-wildcare-0001' WHERE tenant_id = 'default';
UPDATE feedback SET tenant_id = 'wc-0001-wildcare-0001' WHERE tenant_id = 'default';
UPDATE reports  SET tenant_id = 'wc-0001-wildcare-0001' WHERE tenant_id = 'default';

-- ── Delete the default tenant ───────────────────────────────────────────────

DELETE FROM tenants WHERE slug = 'default';

-- ── Session analysis table (for triage queue in Phase 3) ────────────────────

CREATE TABLE IF NOT EXISTS session_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  urgency TEXT,           -- none, moderate, urgent, critical
  outcome TEXT,           -- bringing_in, resolved, redirected, abandoned, unknown
  animal TEXT,
  situation TEXT,
  in_service_area INTEGER,
  analyzed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_session_analysis_tenant ON session_analysis(tenant_id);
CREATE INDEX IF NOT EXISTS idx_session_analysis_urgency ON session_analysis(tenant_id, urgency);
