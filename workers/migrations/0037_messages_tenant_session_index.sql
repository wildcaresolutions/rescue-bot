-- L-8: Add missing composite indexes for tenant-scoped query patterns.
--
-- idx_messages_tenant_session already exists from 0002_multi_tenant.sql (IF NOT EXISTS
-- makes this a no-op on existing DBs). Including it here for completeness per the audit.
--
-- What is actually new:
--   1. idx_messages_tenant_timestamp  — covers timeseries stats queries that filter/group
--      by tenant_id and order/filter on timestamp.
--   2. idx_session_analysis_tenant_session — covers dashboard and triage queries that join
--      or filter on both tenant_id and session_id together (previously only separate
--      single-column indexes existed).

CREATE INDEX IF NOT EXISTS idx_messages_tenant_session
  ON messages(tenant_id, session_id);

CREATE INDEX IF NOT EXISTS idx_messages_tenant_timestamp
  ON messages(tenant_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_session_analysis_tenant_session
  ON session_analysis(tenant_id, session_id);
