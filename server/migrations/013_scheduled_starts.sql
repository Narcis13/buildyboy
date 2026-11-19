-- Scheduled starts (SPEC §11.8): a package's start time, launches kept on the server for a set time, and cron
-- schedules that catch up a run missed while the server was down.

-- epoch ms; a gata package is not ready (nor claimable) before it
ALTER TABLE tasks ADD COLUMN not_before INTEGER;

-- a run whose minute fell while the scheduler was not running fires once at the next tick within this window (0 = off)
ALTER TABLE schedules ADD COLUMN catch_up_minutes INTEGER NOT NULL DEFAULT 120;
ALTER TABLE jobs ADD COLUMN caught_up INTEGER NOT NULL DEFAULT 0;

-- tasks_launch / coordinator_launch with notBefore: approved (when the token needs it) at scheduling time, started by
-- the server's tick once the time has come and the governor and the runner allow it
CREATE TABLE scheduled_launches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                       -- worker | coordinator
  args_json TEXT NOT NULL,                  -- the tool's arguments, as validated
  actor TEXT NOT NULL,
  token_id TEXT,
  decision_id TEXT,                         -- the owner's approval, when the token needed one
  task_id TEXT,
  project TEXT,
  machine_id TEXT NOT NULL,
  title TEXT NOT NULL,
  launcher TEXT NOT NULL,
  not_before INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | starting | started | missed | cancelled
  waits TEXT,                               -- why it has not started yet, once its time has come
  job_id TEXT,
  stale_start INTEGER NOT NULL DEFAULT 0,   -- started on stale usage data (governor rule for scheduled starts)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX scheduled_launches_status ON scheduled_launches(status, not_before);
CREATE INDEX scheduled_launches_task ON scheduled_launches(task_id);
