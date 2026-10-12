-- M7 runner and jobs: dispatch bookkeeping and the output cap counter.
ALTER TABLE jobs ADD COLUMN dispatched_at INTEGER;
ALTER TABLE jobs ADD COLUMN updated_at INTEGER;
ALTER TABLE jobs ADD COLUMN output_lines INTEGER NOT NULL DEFAULT 0;
CREATE INDEX jobs_created ON jobs(created_at);
CREATE INDEX job_output_ts ON job_output(ts);
