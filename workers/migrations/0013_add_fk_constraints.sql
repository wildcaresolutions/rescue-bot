-- Add foreign key constraints to messages, feedback, reports tables.
-- SQLite requires table recreation for adding FK constraints.

PRAGMA foreign_keys = OFF;

-- messages
CREATE TABLE messages_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  content TEXT,
  timestamp INTEGER,
  tester_name TEXT,
  time_to_first_token INTEGER,
  total_time INTEGER,
  error_type TEXT,
  message_type TEXT DEFAULT 'chat',
  client_ip TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  tenant_id TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
INSERT INTO messages_new SELECT * FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id, message_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id);

-- feedback
CREATE TABLE feedback_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating IN (0, 1)),
  feedback_text TEXT,
  tags TEXT,
  timestamp INTEGER,
  tester_name TEXT,
  message_preview TEXT,
  is_tester INTEGER DEFAULT 0,
  client_ip TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  tenant_id TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
INSERT INTO feedback_new SELECT * FROM feedback;
DROP TABLE feedback;
ALTER TABLE feedback_new RENAME TO feedback;
CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback(session_id, tenant_id);

-- reports
CREATE TABLE reports_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT DEFAULT (datetime('now')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  stats TEXT NOT NULL,
  sent_to TEXT NOT NULL,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  tenant_id TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
INSERT INTO reports_new SELECT * FROM reports;
DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;
CREATE INDEX IF NOT EXISTS idx_reports_tenant ON reports(tenant_id);

PRAGMA foreign_keys = ON;
