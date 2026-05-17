-- Profile storage for platform admins (mark@bluesnoop.com et al.).
-- Platform admins aren't members of any tenant_users — they're cross-tenant
-- by design — so their display_name and avatar_url need their own home.

CREATE TABLE IF NOT EXISTS platform_users (
  email TEXT PRIMARY KEY,
  display_name TEXT,
  avatar_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
