-- Add widget_theme JSON column for per-tenant widget theming
ALTER TABLE tenants ADD COLUMN widget_theme TEXT DEFAULT NULL;
