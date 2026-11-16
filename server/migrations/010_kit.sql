-- The kit in the runner (SPEC §12.4): gate runs carry kit steps too (prepare, qa, cleanup, revert) and keep what a step
-- reported besides its verdict (G5's range, QA's commit and tag, a verifier's cost); checked herdr commands (`hc send`,
-- `hc kill`) sent to a runner, with their outcome.

ALTER TABLE gate_runs ADD COLUMN details_json TEXT;

CREATE TABLE hc_commands (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  task_id TEXT,
  op TEXT NOT NULL,
  name TEXT NOT NULL,
  command_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  result_json TEXT,
  error TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX hc_commands_task ON hc_commands(task_id, created_at);
