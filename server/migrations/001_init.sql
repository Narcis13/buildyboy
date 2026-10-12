-- Buildyboy schema v1. Raw payloads are kept next to extracted columns so `bb reindex` can re-derive.

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT,
  platform TEXT,
  arch TEXT,
  user TEXT,
  token_hash TEXT UNIQUE,
  claude_version TEXT,
  hook_version TEXT,
  runner_online INTEGER NOT NULL DEFAULT 0,
  runner_seen_at INTEGER,
  runner_info_json TEXT,
  spool_bytes INTEGER,
  walk_mode INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  name TEXT NOT NULL,
  git_remote TEXT,
  gh_owner TEXT,
  gh_repo TEXT,
  default_branch TEXT,
  UNIQUE (machine_id, root_path)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id),
  cwd TEXT,
  source TEXT NOT NULL DEFAULT 'unknown',
  name TEXT,
  model TEXT,
  effort TEXT,
  permission_mode TEXT,
  transcript_path TEXT,
  parent_session_id TEXT,
  job_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  status_reason TEXT,
  activity TEXT,
  started_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_source TEXT,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  context_pct REAL,
  compactions INTEGER NOT NULL DEFAULT 0,
  wait_ms INTEGER NOT NULL DEFAULT 0,
  waiting_since INTEGER,
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0,
  git_branch TEXT,
  git_dirty INTEGER,
  start_sha TEXT,
  end_sha TEXT,
  walk_mode INTEGER,
  stop_wait_min REAL,
  remote_control TEXT,
  kill_requested INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,
  rate_limits_json TEXT
);
CREATE INDEX sessions_last_event ON sessions(last_event_at);
CREATE INDEX sessions_project ON sessions(project_id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  tool_name TEXT,
  tool_use_id TEXT,
  summary TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX events_session_ts ON events(session_id, ts);

CREATE TABLE messages (
  uuid TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_uuid TEXT,
  agent_id TEXT,
  role TEXT,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT,
  api_message_id TEXT,
  text TEXT,
  content_json TEXT NOT NULL,
  usage_json TEXT,
  is_sidechain INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_session_ts ON messages(session_id, ts);

CREATE TABLE tool_calls (
  tool_use_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  tool_name TEXT NOT NULL,
  mcp_server TEXT,
  input_json TEXT,
  output_text TEXT,
  output_len INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  file_path TEXT,
  command TEXT,
  exit_code INTEGER
);
CREATE INDEX tool_calls_session ON tool_calls(session_id, started_at);

CREATE TABLE subagents (
  agent_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_type TEXT,
  description TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running'
);
CREATE INDEX subagents_session ON subagents(session_id);

CREATE TABLE file_changes (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_use_id TEXT,
  ts INTEGER NOT NULL,
  path TEXT NOT NULL,
  op TEXT NOT NULL,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  patch TEXT,
  UNIQUE (tool_use_id, path)
);
CREATE INDEX file_changes_session ON file_changes(session_id);

CREATE TABLE todos (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  items_json TEXT NOT NULL
);
CREATE INDEX todos_session ON todos(session_id, ts);

CREATE TABLE git_snapshots (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  branch TEXT,
  sha TEXT,
  ahead INTEGER,
  behind INTEGER,
  dirty INTEGER,
  shortstat TEXT
);
CREATE INDEX git_snapshots_session ON git_snapshots(session_id, ts);

CREATE TABLE commits (
  sha TEXT PRIMARY KEY,
  project_id INTEGER,
  session_id TEXT,
  ts INTEGER NOT NULL,
  message TEXT,
  author TEXT,
  files INTEGER,
  added INTEGER,
  removed INTEGER
);
CREATE INDEX commits_session ON commits(session_id);

CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY,
  project_id INTEGER,
  number INTEGER,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  state TEXT,
  branch TEXT,
  session_id TEXT,
  review_state TEXT,
  checks_state TEXT,
  checks_json TEXT,
  updated_at INTEGER
);

CREATE TABLE progress_docs (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  hash TEXT NOT NULL,
  content TEXT NOT NULL,
  UNIQUE (session_id, hash)
);

CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool_name TEXT,
  match_key TEXT,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  response_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  answered_at INTEGER,
  answered_by TEXT
);
CREATE INDEX pending_actions_status ON pending_actions(status, created_at);

CREATE TABLE queued_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  delivered_via TEXT
);
CREATE INDEX queued_messages_session ON queued_messages(session_id, status);

CREATE TABLE templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE prompts (
  id INTEGER PRIMARY KEY,
  template_id INTEGER REFERENCES templates(id),
  title TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  extra_md TEXT NOT NULL DEFAULT '',
  rendered TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE prompt_versions (
  prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  slots_json TEXT NOT NULL,
  extra_md TEXT NOT NULL,
  rendered TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (prompt_id, version)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  prompt_id INTEGER,
  machine_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT,
  prompt_text TEXT NOT NULL,
  options_json TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  exit_code INTEGER,
  cost_usd REAL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  verify_json TEXT,
  schedule_id TEXT,
  rerun_of TEXT
);
CREATE INDEX jobs_machine_status ON jobs(machine_id, status);

CREATE TABLE job_output (
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  line_json TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  job_template_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE otel_points (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  attrs_json TEXT
);
CREATE INDEX otel_points_session ON otel_points(session_id, name);

CREATE TABLE otel_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT,
  name TEXT NOT NULL,
  attrs_json TEXT
);
CREATE INDEX otel_events_session ON otel_events(session_id, ts);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  device_name TEXT,
  endpoint TEXT NOT NULL UNIQUE,
  keys_json TEXT NOT NULL,
  prefs_json TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
);

CREATE TABLE pairing_codes (
  code TEXT PRIMARY KEY,
  name TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  machine_id TEXT
);

CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf TEXT NOT NULL,
  device TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE search_index USING fts5(kind UNINDEXED, ref UNINDEXED, session_id UNINDEXED, text, tokenize = 'unicode61');
