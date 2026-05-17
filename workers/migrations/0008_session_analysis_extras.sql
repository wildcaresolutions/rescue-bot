-- Add needs_action and contact_info columns to session_analysis
-- Add unique index on session_id for upsert support

ALTER TABLE session_analysis ADD COLUMN needs_action INTEGER DEFAULT 0;
ALTER TABLE session_analysis ADD COLUMN contact_info TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_analysis_session ON session_analysis(session_id);
