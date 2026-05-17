CREATE TABLE IF NOT EXISTS eval_scenarios (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  description TEXT NOT NULL,
  expected_behavior TEXT NOT NULL,
  test_message TEXT NOT NULL,
  auto_generated INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS eval_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  response TEXT NOT NULL,
  passed INTEGER,
  judge_reasoning TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (scenario_id) REFERENCES eval_scenarios(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_eval_scenarios_tenant ON eval_scenarios(tenant_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_scenario ON eval_results(scenario_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_tenant ON eval_results(tenant_id);
