-- Seed a test tenant for local development
-- Login: test@test.com / testpass123
-- Admin: http://localhost:8787/?tenant=test-org

-- Password hash for 'testpass123' using PBKDF2-SHA256 (100k iterations)
-- Generated deterministically so it works on every fresh DB
-- To regenerate: the Worker's hashPassword('testpass123') produces this
INSERT OR IGNORE INTO tenants (
  id, slug, name, phone, email, url,
  location_county, location_state, location_service_area,
  color_primary, color_secondary, color_accent,
  password_hash
) VALUES (
  'test-0001-dev-tenant',
  'test-org',
  'Test Wildlife Center',
  '555-TEST',
  'test@test.com',
  'https://testwildlife.org',
  'Test County',
  'CA',
  'Test County and surrounding areas',
  '#2d7a3c',
  '#1a4a24',
  '#C4883A',
  'LEGACY_SITE_PASSWORD'
);
