-- Agents that start workers and coordinators (tasks_launch, coordinator_launch). Off for every token until the owner
-- turns it on in Settings → Factory → Agent tokens: `launch` is what the token may start, `launch_approval` asks the
-- owner (a decision) before each launch.
ALTER TABLE agent_tokens ADD COLUMN launch TEXT NOT NULL DEFAULT 'off';
ALTER TABLE agent_tokens ADD COLUMN launch_approval INTEGER NOT NULL DEFAULT 1;

-- A launch waiting for (or given) the owner's approval. The agent calls again with the same arguments: `args_key` finds
-- the request, its decision says whether it may go ahead.
CREATE TABLE launch_requests (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_id TEXT,
  args_key TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  job_id TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX launch_requests_match ON launch_requests(token_id, args_key, status);
