-- Backfill session_analysis for demo data
INSERT OR REPLACE INTO session_analysis (session_id, tenant_id, urgency, outcome, animal, situation, in_service_area, needs_action, contact_info, analyzed_at)
VALUES
('demo-sess-001', 'demo-0001-bay-rescue', 'moderate', 'resolved', 'raccoon', 'I found a baby raccoon in my backyard. It looks lost and keeps crying.', 1, 0, NULL, datetime('now', '-30 days')),
('demo-sess-002', 'demo-0001-bay-rescue', 'urgent', 'bringing_in', 'raptor', 'A hawk hit my window and is on the ground not moving', 1, 0, NULL, datetime('now', '-29 days')),
('demo-sess-003', 'demo-0001-bay-rescue', 'critical', 'bringing_in', 'bat', 'Theres a bat in my house what do I do', 1, 1, NULL, datetime('now', '-25 days')),
('demo-sess-004', 'demo-0001-bay-rescue', 'moderate', 'redirected', 'songbird', 'I found an injured bird on my porch in Sacramento', 0, 0, NULL, datetime('now', '-25 days')),
('demo-sess-005', 'demo-0001-bay-rescue', 'moderate', 'resolved', 'squirrel', 'Found a baby squirrel that fell out of a tree', 1, 0, NULL, datetime('now', '-22 days')),
('demo-sess-006', 'demo-0001-bay-rescue', 'moderate', 'unknown', 'coyote', 'Sick looking coyote in my yard with no fur', 1, 0, NULL, datetime('now', '-20 days')),
('demo-sess-007', 'demo-0001-bay-rescue', 'urgent', 'bringing_in', 'hummingbird', 'Hummingbird on the ground not flying', 1, 0, NULL, datetime('now', '-18 days')),
('demo-sess-008', 'demo-0001-bay-rescue', 'critical', 'bringing_in', 'opossum', 'Found a dead opossum on the road, there are babies crawling on it', 1, 1, NULL, datetime('now', '-15 days')),
('demo-sess-009', 'demo-0001-bay-rescue', 'urgent', 'bringing_in', 'songbird', 'Cat brought in a bird', 1, 0, NULL, datetime('now', '-12 days')),
('demo-sess-010', 'demo-0001-bay-rescue', 'moderate', 'unknown', 'snake', 'There is a snake in my garage', 1, 0, NULL, datetime('now', '-10 days')),
('demo-sess-011', 'demo-0001-bay-rescue', 'none', 'resolved', 'deer', 'Baby deer in my yard', 1, 0, NULL, datetime('now', '-7 days')),
('demo-sess-012', 'demo-0001-bay-rescue', 'moderate', 'unknown', 'waterfowl', 'Found injured goose at Lake Merritt', 1, 0, NULL, datetime('now', '-5 days')),
('demo-sess-013', 'demo-0001-bay-rescue', 'urgent', 'bringing_in', 'raptor', 'Owl on the ground during the day', 1, 0, NULL, datetime('now', '-3 days')),
('demo-sess-014', 'demo-0001-bay-rescue', 'urgent', 'bringing_in', 'pelican', 'help theres a pelican on the beach that cant fly', 1, 1, '{"phone":"510-555-1234","name":"Maria"}', datetime('now', '-1 day'));
