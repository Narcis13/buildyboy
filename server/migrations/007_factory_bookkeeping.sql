-- The factory's bookkeeping (SPEC §11.7): gate rounds, resources per package, structured findings, gate runs on the
-- runner, sessions linked to a package by role, and idempotent agent calls (the `bb mcp` outbox replays them).

ALTER TABLE tasks ADD COLUMN round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN extra_rounds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN res_port INTEGER;
ALTER TABLE tasks ADD COLUMN res_db TEXT;
ALTER TABLE tasks ADD COLUMN res_mig_from INTEGER;
ALTER TABLE tasks ADD COLUMN res_mig_to INTEGER;
ALTER TABLE tasks ADD COLUMN migrations_used_json TEXT;

ALTER TABLE gate_results ADD COLUMN round INTEGER NOT NULL DEFAULT 1;

CREATE TABLE findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  gate_result_id INTEGER REFERENCES gate_results(id) ON DELETE SET NULL,
  gate TEXT NOT NULL,
  round INTEGER NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  detail TEXT,
  fix TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  note TEXT,
  deferred_to TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX findings_task ON findings(task_id, gate, status);
CREATE INDEX findings_status ON findings(status, severity);

CREATE TABLE gate_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  gate TEXT NOT NULL,
  round INTEGER NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  machine_id TEXT NOT NULL,
  command_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  verdict TEXT,
  summary TEXT,
  findings_json TEXT,
  gate_result_id INTEGER,
  exit_code INTEGER,
  error TEXT,
  log TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX gate_runs_task ON gate_runs(task_id, created_at);

-- Sessions tagged with BB_TASK / BB_ROLE by the hook. Not tied to tasks by a foreign key: the tag may arrive first.
CREATE TABLE task_sessions (
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, session_id)
);
CREATE INDEX task_sessions_session ON task_sessions(session_id);

-- Sessions are linked by an incremental sweep of new hook events; nothing before this migration carries BB_TASK.
INSERT OR IGNORE INTO settings (key, value) SELECT 'task_link_event_id', CAST(COALESCE(MAX(id), 0) AS TEXT) FROM events;

CREATE TABLE agent_calls (
  key TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX agent_calls_created ON agent_calls(created_at);
