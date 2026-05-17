-- D1 initial schema for wildcare-bot
-- Consolidates all Postgres migrations into SQLite-compatible schema

CREATE TABLE IF NOT EXISTS messages (
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
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_tester ON messages(tester_name);
CREATE INDEX IF NOT EXISTS idx_messages_error_type ON messages(error_type) WHERE error_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_message_type ON messages(message_type);

CREATE TABLE IF NOT EXISTS feedback (
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
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);
CREATE INDEX IF NOT EXISTS idx_feedback_is_tester_rating ON feedback(is_tester, rating);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT DEFAULT (datetime('now')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  stats TEXT NOT NULL,
  sent_to TEXT NOT NULL,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_generated_at ON reports(generated_at DESC);
