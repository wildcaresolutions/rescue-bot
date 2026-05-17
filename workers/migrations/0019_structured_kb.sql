-- Structured knowledge base config for guided setup.
-- Replaces raw custom_instruction textarea with structured sections.

-- Organization operational details (structured JSON)
ALTER TABLE tenants ADD COLUMN org_config TEXT DEFAULT '{}';

-- Bot behavior overrides (advanced, structured JSON)
ALTER TABLE tenants ADD COLUMN bot_overrides TEXT DEFAULT '{}';

-- Seed existing tenants: migrate custom_instruction into org_config.protocols
-- (keep custom_instruction column for backward compat, it's the final compiled output)
