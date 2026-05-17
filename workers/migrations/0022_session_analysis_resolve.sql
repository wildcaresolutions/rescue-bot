-- 0017_placeholder.sql claimed resolved_at + resolution_notes "already exist"
-- on session_analysis. They don't — the assumption was wrong on cf-migration's
-- branch (the original 0016_resolve_workflow.sql got renumbered into the
-- magic-link migration). Without these columns, /admin/dashboard 500s on the
-- `WHERE sa.resolved_at IS NULL` predicate.

-- SQLite ALTER TABLE ADD COLUMN doesn't support IF NOT EXISTS. We split into
-- separate statements; if a database already has the column (it doesn't on
-- our prod or test), the migration fails idempotently — which is the right
-- behavior for tracked migrations.

ALTER TABLE session_analysis ADD COLUMN resolved_at TEXT;
ALTER TABLE session_analysis ADD COLUMN resolution_notes TEXT;
