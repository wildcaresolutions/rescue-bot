-- Track the operator's explicit widget publish action separately from draft
-- widget_theme saves. Onboarding readiness needs to know whether someone has
-- actually clicked Publish, not merely whether theme JSON exists.

ALTER TABLE tenants ADD COLUMN widget_published_at TEXT;

UPDATE tenants
SET widget_published_at = COALESCE(updated_at, datetime('now'))
WHERE widget_theme IS NOT NULL AND widget_theme != '';
