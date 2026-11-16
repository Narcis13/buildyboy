-- The conductor and the planner (SPEC §12.5, §12.6). The conductor keeps its state in tasks.stage and tasks.line_json
-- (migration 009); a plan request and what came of it live in `plans`, and its packages carry tasks.plan_id.

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  goal TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  job_id TEXT,
  decision_id TEXT,
  summary TEXT,
  questions_json TEXT,
  error TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX plans_project ON plans(project, created_at);
CREATE INDEX plans_status ON plans(status);
CREATE INDEX tasks_plan ON tasks(plan_id);
