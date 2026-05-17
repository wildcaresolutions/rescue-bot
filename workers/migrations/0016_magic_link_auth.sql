-- Magic link authentication: email-based login without passwords.
-- Users receive a link via email, click it, and get a session token.

-- Tenant users: who has access to which tenant
CREATE TABLE IF NOT EXISTS tenant_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',  -- admin | viewer
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE(tenant_id, email)
);

-- Magic link tokens: short-lived tokens sent via email
CREATE TABLE IF NOT EXISTS magic_tokens (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  tenant_id TEXT,  -- null = platform admin login
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_magic_tokens_token ON magic_tokens(token);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_email ON magic_tokens(email);
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_email ON tenant_users(email);

-- Seed existing tenants: create admin users from tenant email
INSERT OR IGNORE INTO tenant_users (id, tenant_id, email, role)
SELECT
  lower(hex(randomblob(16))),
  id,
  email,
  'admin'
FROM tenants
WHERE email IS NOT NULL AND email != '';
