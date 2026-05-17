-- Lock-1: data-only migration for the eventual lock-flag removal.
--
-- Pre-fills house_rules from custom_instruction for any tenant that has the
-- custom_instruction_locked=1 flag set, so operators don't lose their
-- hand-edited prompt content when the lock-aware code path is removed in
-- Lock-2 (a separate migration that drops the flag column itself).
--
-- This migration is REVERSIBLE: the lock branch in compile-instruction.ts is
-- left intact for one deploy cycle. If we discover the merge produced bad
-- data, we can ship a fix before Lock-2 drops the flag column.
--
-- Adds custom_instruction_locked_pending_review = 1 for the affected
-- tenants. The admin UI uses this to render a banner: "We migrated your
-- locked prompt into House Rules. Review it in the Live Prompt drawer; trim
-- duplicates if needed."
--
-- Known acceptable duplication risk: if the operator's hand-edited prompt
-- repeats a structured section header (e.g., they wrote "## Service Area"
-- themselves), the post-migration compiled prompt will have that section
-- twice — once from compileInstruction(structured), once at the end via
-- house_rules. The banner prompts the operator to review and trim. The
-- de-dup is operator-driven, not algorithmic — chasing it algorithmically
-- is brittle.

-- Add the pending-review column. Idempotent via the ADD COLUMN guard pattern
-- used elsewhere in this repo (SQLite supports IF NOT EXISTS via PRAGMA,
-- but D1's migration runner already enforces one-shot semantics, so a
-- straight ADD COLUMN is fine — re-running this migration is a no-op
-- because D1 tracks applied migrations.)
ALTER TABLE tenants ADD COLUMN custom_instruction_locked_pending_review INTEGER DEFAULT 0;

-- For each locked tenant with non-empty custom_instruction, append the
-- hand-edited text to house_rules. Preserve any existing house_rules content
-- (rare — most locked tenants are locked precisely BECAUSE they wanted to
-- write the whole prompt manually). Separator marker makes the migrated
-- content visually distinct so operators can find and trim it.
UPDATE tenants
SET house_rules = TRIM(
  COALESCE(house_rules, '') ||
  CASE
    WHEN house_rules IS NOT NULL AND TRIM(house_rules) <> ''
      THEN char(10) || char(10) || '## Migrated from custom prompt (Lock-1)' || char(10)
    ELSE ''
  END ||
  custom_instruction
),
custom_instruction_locked_pending_review = 1
WHERE custom_instruction_locked = 1
  AND custom_instruction IS NOT NULL
  AND TRIM(custom_instruction) <> '';

-- Cap house_rules at 10000 chars (matches custom_instruction cap). Operators
-- whose locked prompt exceeded 10000 chars will see a truncated house_rules
-- and the banner instructs them to review/trim. Bumping platform.ts's
-- 5000-char slice cap to 10000 ships alongside this migration in code.
UPDATE tenants
SET house_rules = SUBSTR(house_rules, 1, 10000)
WHERE LENGTH(house_rules) > 10000;
