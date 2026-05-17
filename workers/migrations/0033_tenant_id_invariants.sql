-- P1-19: enforce tenant_id NOT NULL on tenant-scoped tables + cascade
-- magic_tokens on tenant delete.
--
-- AUDIT FINDINGS (workers/audits/2026-05-16-pre-prod-audit.md sections 1.5,
-- 1.6): five tables (messages, feedback, reports, usage_log, photos) had
-- tenant_id columns declared as `TEXT` without NOT NULL. A NULL row was
-- invisible to every per-tenant query and never garbage-collected — a
-- silent gap in the multi-tenant invariant. Separately, magic_tokens.tenant_id
-- referenced tenants(id) without ON DELETE CASCADE (migration 0013 added
-- cascade to messages/feedback/reports but not magic_tokens), so deleting a
-- tenant left dangling auth-link rows that could in principle issue sessions
-- for a tenant that no longer existed.
--
-- WHY TRIGGERS, NOT ALTER TABLE: SQLite doesn't support adding NOT NULL or
-- FK constraints to existing columns. The strict alternative — drop + recreate
-- + reinsert + reindex per table — is 30+ lines per table, risks dropping
-- legacy indexes, and isn't safe to retry on a partial failure. BEFORE-INSERT
-- triggers give equivalent runtime safety at microsecond cost per write, and
-- they're transparent: a future operator who runs `.schema messages` sees
-- the trigger right next to the table definition.
--
-- IDEMPOTENCY: every CREATE TRIGGER uses IF NOT EXISTS; the DELETEs are
-- naturally idempotent (rerunning is a no-op once cleaned). Safe to apply
-- to dev, test, and prod in any order.
--
-- AUDIT CLEANUP: the DELETEs at the top scrub any pre-existing NULL or
-- orphan rows. Run BEFORE the triggers are installed so we don't fail on
-- legitimate-historic NULLs while installing the trigger that forbids them
-- going forward.

-- ── One-time cleanup: scrub NULL tenant_id rows ──────────────────────────────

DELETE FROM messages         WHERE tenant_id IS NULL;
DELETE FROM feedback         WHERE tenant_id IS NULL;
DELETE FROM reports          WHERE tenant_id IS NULL;
DELETE FROM usage_log        WHERE tenant_id IS NULL;
DELETE FROM photos           WHERE tenant_id IS NULL;

-- Scrub magic_tokens rows pointing to a tenant that no longer exists. These
-- are auth-shaped orphans: a stale magic link that could re-issue a session
-- for a tenant the operator already deleted. Platform-admin links
-- (tenant_id IS NULL by design) are NOT touched.
DELETE FROM magic_tokens
WHERE tenant_id IS NOT NULL
  AND tenant_id NOT IN (SELECT id FROM tenants);

-- ── BEFORE-INSERT triggers: refuse NULL tenant_id on new writes ──────────────

CREATE TRIGGER IF NOT EXISTS enforce_messages_tenant_id_not_null
BEFORE INSERT ON messages
FOR EACH ROW WHEN NEW.tenant_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'messages.tenant_id cannot be NULL');
END;

CREATE TRIGGER IF NOT EXISTS enforce_feedback_tenant_id_not_null
BEFORE INSERT ON feedback
FOR EACH ROW WHEN NEW.tenant_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'feedback.tenant_id cannot be NULL');
END;

CREATE TRIGGER IF NOT EXISTS enforce_reports_tenant_id_not_null
BEFORE INSERT ON reports
FOR EACH ROW WHEN NEW.tenant_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'reports.tenant_id cannot be NULL');
END;

CREATE TRIGGER IF NOT EXISTS enforce_usage_log_tenant_id_not_null
BEFORE INSERT ON usage_log
FOR EACH ROW WHEN NEW.tenant_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'usage_log.tenant_id cannot be NULL');
END;

CREATE TRIGGER IF NOT EXISTS enforce_photos_tenant_id_not_null
BEFORE INSERT ON photos
FOR EACH ROW WHEN NEW.tenant_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'photos.tenant_id cannot be NULL');
END;

-- ── ON-DELETE-CASCADE trigger for magic_tokens (audit 1.6) ──────────────────
--
-- Migration 0013 added ON DELETE CASCADE to messages/feedback/reports via
-- the FK constraint, but magic_tokens.tenant_id only got `FOREIGN KEY
-- (tenant_id) REFERENCES tenants(id)` with no cascade clause. Adding a
-- cascade clause now requires recreating the table; the trigger achieves
-- the same effect: when a tenant is deleted, fire a DELETE on its
-- magic_tokens rows. Platform-admin tokens (tenant_id IS NULL) survive
-- intentionally — they're not tenant-scoped.

CREATE TRIGGER IF NOT EXISTS cascade_magic_tokens_on_tenant_delete
BEFORE DELETE ON tenants
FOR EACH ROW
BEGIN
  DELETE FROM magic_tokens WHERE tenant_id = OLD.id;
END;
