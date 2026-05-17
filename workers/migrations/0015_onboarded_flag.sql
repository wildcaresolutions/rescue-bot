-- Explicit onboarding flag. Set to 1 once tenant completes initial setup.
ALTER TABLE tenants ADD COLUMN onboarded INTEGER DEFAULT 0;

-- Mark existing tenants with custom_instruction as onboarded
UPDATE tenants SET onboarded = 1 WHERE custom_instruction IS NOT NULL AND custom_instruction != '';
