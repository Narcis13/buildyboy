-- Sessions started in a linked git worktree used to get a project of their own, keyed on the worktree folder.
-- They now belong to the main checkout's project. This moves the old ones there when it is certain:
--   * every git-reporting session of the project said `worktree: true` (and at least one did). Older hooks also said
--     so in a subfolder of a normal checkout, so `worktree: true` only counts from an event whose cwd is the git root;
--   * exactly one other project on the same machine has the same git remote, and it is not a worktree project.
-- Its sessions, commits and pull requests move over and the emptied worktree project is removed.
-- Anything else (no remote, no main project seen yet, several candidates) is left as it is.

CREATE TEMP TABLE wt_flags AS
  SELECT s.project_id AS id,
         MAX(CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json, '$._git.worktree') = 1
           AND lower(rtrim(replace(json_extract(e.payload_json, '$.cwd'), char(92), '/'), '/'))
             = lower(rtrim(replace(json_extract(e.payload_json, '$._git.root'), char(92), '/'), '/')) END) AS any_wt,
         MAX(CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json, '$._git.worktree') = 0 END) AS any_main
  FROM events e JOIN sessions s ON s.id = e.session_id
  WHERE s.project_id IS NOT NULL AND e.payload_json LIKE '%"worktree":%'
  GROUP BY s.project_id;

CREATE TEMP TABLE wt_projects AS SELECT id FROM wt_flags WHERE any_wt = 1 AND COALESCE(any_main, 0) = 0;

CREATE TEMP TABLE wt_map AS
  SELECT p.id AS from_id, MIN(m.id) AS to_id
  FROM projects p JOIN wt_projects w ON w.id = p.id
  JOIN projects m ON m.machine_id = p.machine_id AND m.git_remote = p.git_remote AND m.id <> p.id AND m.id NOT IN (SELECT id FROM wt_projects)
  WHERE p.git_remote IS NOT NULL
  GROUP BY p.id
  HAVING COUNT(m.id) = 1;

UPDATE sessions SET project_id = (SELECT to_id FROM wt_map WHERE from_id = sessions.project_id) WHERE project_id IN (SELECT from_id FROM wt_map);
UPDATE commits SET project_id = (SELECT to_id FROM wt_map WHERE from_id = commits.project_id) WHERE project_id IN (SELECT from_id FROM wt_map);
UPDATE pull_requests SET project_id = (SELECT to_id FROM wt_map WHERE from_id = pull_requests.project_id) WHERE project_id IN (SELECT from_id FROM wt_map);
DELETE FROM projects WHERE id IN (SELECT from_id FROM wt_map);

DROP TABLE wt_map;
DROP TABLE wt_projects;
DROP TABLE wt_flags;
