-- Add retention tracking. Default: 90 days for messages, 30 days for session_analysis contact_info.
-- Actual cleanup is handled by the scheduled handler, not by this migration.

-- Add retention_days column to tenants (configurable per tenant)
ALTER TABLE tenants ADD COLUMN message_retention_days INTEGER DEFAULT 90;
ALTER TABLE tenants ADD COLUMN analysis_retention_days INTEGER DEFAULT 30;
