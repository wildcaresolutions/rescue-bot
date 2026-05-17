-- Application/approval workflow + widget domain allowlist

-- ── Applications (pending org signups awaiting platform admin approval) ──────

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,                        -- UUID
  status TEXT NOT NULL DEFAULT 'pending',      -- pending, approved, rejected
  org_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  website TEXT,
  use_case TEXT,                               -- free-text: what they want the bot for
  animal_types TEXT,                            -- free-text: what animals they deal with
  service_area TEXT,                            -- geographic coverage
  location_county TEXT,
  location_state TEXT,
  hosting_domain TEXT,                         -- domain where widget will be embedded
  notes TEXT,                                  -- platform admin notes
  tenant_id TEXT,                              -- set when approved (FK to tenants)
  reviewed_at TEXT,                            -- when approved/rejected
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_email ON applications(contact_email);

-- ── Widget domain allowlist (per-tenant CORS enforcement) ────────────────────

CREATE TABLE IF NOT EXISTS allowed_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  domain TEXT NOT NULL,                        -- e.g., "marinwildlife.org" or "*.marinwildlife.org"
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE(tenant_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_allowed_domains_tenant ON allowed_domains(tenant_id);

-- ── Add allowed_domains column to tenants for quick CORS check ───────────────

ALTER TABLE tenants ADD COLUMN hosting_domain TEXT;
