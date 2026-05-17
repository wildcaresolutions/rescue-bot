-- Add widget_custom_css column for per-tenant CSS overrides
ALTER TABLE tenants ADD COLUMN widget_custom_css TEXT DEFAULT NULL;
