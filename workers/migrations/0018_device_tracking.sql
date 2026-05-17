-- Track device type (mobile/desktop/tablet) for analytics
ALTER TABLE session_analysis ADD COLUMN device_type TEXT DEFAULT 'unknown';
