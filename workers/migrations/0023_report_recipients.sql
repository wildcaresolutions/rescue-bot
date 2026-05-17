-- Per-tenant additional email recipients for daily reports.
-- Comma-separated. Joined with the tenant's tenant_users emails at send time.
ALTER TABLE tenants ADD COLUMN report_recipients TEXT;
