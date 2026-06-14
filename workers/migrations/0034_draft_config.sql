-- Global draft/publish (staging) for tenant config.
--
-- `draft_config` holds a JSON *partial patch* of the publishable columns an
-- operator has edited but not yet published. The bot keeps reading the LIVE
-- columns (this column is invisible to the chat path); the admin editor reads
-- live-overlaid-with-draft. NULL = no unpublished changes. Publish applies the
-- patch to the real columns (re-running the instruction compile) and nulls
-- this; Discard just nulls it.
ALTER TABLE tenants ADD COLUMN draft_config TEXT DEFAULT NULL;
ALTER TABLE tenants ADD COLUMN draft_updated_at TEXT DEFAULT NULL;
