-- Operator-facing system prompt controls.
-- Three new fields support the "view/edit bot instructions" admin UX:
--
--   house_rules — append-only text the operator wants tacked on after
--   the auto-compiled sections. Survives recompiles (species_config /
--   org_config edits do NOT wipe it).
--
--   custom_instruction_locked — when 1, custom_instruction is treated
--   as raw operator-edited text. update_species_config /
--   bulk_skip_other_species / save_protocols write to org_config /
--   bot_overrides as usual but DO NOT recompile and overwrite
--   custom_instruction. The operator's hand-tuned prompt stays put.
--   Setting back to 0 triggers a recompile on the next config change.
--
--   custom_instruction_locked_at — when locked, ISO timestamp so the UI
--   can warn "you locked this 3 days ago — it's drifted from your
--   species config since". Null when unlocked.

ALTER TABLE tenants ADD COLUMN house_rules TEXT;
ALTER TABLE tenants ADD COLUMN custom_instruction_locked INTEGER DEFAULT 0;
ALTER TABLE tenants ADD COLUMN custom_instruction_locked_at TEXT;
