-- The factory (SPEC §11): backlog of packages, gate results, decisions, control requests, agent tokens,
-- herdr terminals and digests.

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'backlog',
  repo TEXT,
  branch TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  prompt_id INTEGER,
  prompt_version INTEGER,
  sensitive INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  claimed_by TEXT,
  claimed_at INTEGER,
  job_id TEXT,
  terminal TEXT,
  session_id TEXT,
  source TEXT NOT NULL DEFAULT 'web',
  ext_ref TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  integrated_at INTEGER
);
CREATE INDEX tasks_status ON tasks(status, priority);

CREATE TABLE task_deps (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail_json TEXT
);
CREATE INDEX task_events_task ON task_events(task_id, ts);

CREATE TABLE gate_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  gate TEXT NOT NULL,
  verdict TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  details_json TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX gate_results_task ON gate_results(task_id, gate, created_at);

CREATE TABLE gate_shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_result_id INTEGER NOT NULL REFERENCES gate_results(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX gate_shots_result ON gate_shots(gate_result_id);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  context TEXT,
  options_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  answer TEXT,
  asked_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX decisions_status ON decisions(status, created_at);

CREATE TABLE control_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  acked_at INTEGER
);
CREATE INDEX control_requests_status ON control_requests(status, task_id);

CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE hc_terminals (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  name TEXT,
  agent TEXT,
  cwd TEXT,
  state TEXT,
  status TEXT,
  turn INTEGER,
  where_label TEXT,
  task_id TEXT,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, address)
);

CREATE TABLE digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data_json TEXT
);

ALTER TABLE sessions ADD COLUMN hc_terminal TEXT;
