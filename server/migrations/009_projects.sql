-- Factory projects (SPEC §12.1, §12.2): a project owns its packages, its config and its history; package ids may carry
-- the project's prefix; integrated packages leave the board through the archive.
--
-- The data part turns every entry of the `factory_repos` setting (§11.7's per-repo config) into a project: key from the
-- repo name (the part after the last "/", lower case, other characters than a-z 0-9 - replaced, made unique),
-- id_prefix '', line_file = the old recipe path, config_json.legacy = the old allocation fields. Every other repo the
-- backlog names gets a project too. Packages are assigned by repo (ignoring case); packages without a repo keep no
-- project. Packages already integrated are archived, so the board starts clean. `factory_repos` stays in settings
-- untouched but is no longer read.
--
-- It also adds the columns later steps of §12 use (tasks.stage, line_json, plan_id; agent_tokens.operator, inbox), so
-- no later step has to alter these tables again.

CREATE TABLE factory_projects (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo TEXT,
  id_prefix TEXT NOT NULL DEFAULT '',
  machine_id TEXT,
  checkout TEXT,
  line_file TEXT NOT NULL DEFAULT 'factory.json',
  config_json TEXT NOT NULL DEFAULT '{}',
  line_json TEXT,
  line_seen_at INTEGER,
  line_error TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  autopilot INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

ALTER TABLE tasks ADD COLUMN project TEXT REFERENCES factory_projects(key);
ALTER TABLE tasks ADD COLUMN archived_at INTEGER;
ALTER TABLE tasks ADD COLUMN stage TEXT;
ALTER TABLE tasks ADD COLUMN line_json TEXT;
ALTER TABLE tasks ADD COLUMN plan_id TEXT;
CREATE INDEX tasks_project ON tasks(project, status);
CREATE INDEX tasks_archived ON tasks(archived_at);

ALTER TABLE agent_tokens ADD COLUMN operator INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_tokens ADD COLUMN inbox INTEGER NOT NULL DEFAULT 0;

-- ---------- data: one project per repo ----------

CREATE TEMP TABLE p9_src (
  ord INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  machine_id TEXT,
  checkout TEXT,
  line_file TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  name TEXT,
  base TEXT,
  key TEXT
);

-- the configured repos first, in the order of the setting (an entry that is not an object counts as {})
INSERT INTO p9_src (repo, machine_id, checkout, line_file, config_json, created_at)
WITH entries(i, v) AS (
  SELECT CAST(e.key AS INTEGER), CASE WHEN e.type = 'object' THEN e.value ELSE '{}' END
  FROM settings s, json_each(CASE WHEN json_valid(s.value) AND json_type(s.value) = 'array' THEN s.value ELSE '[]' END) e
  WHERE s.key = 'factory_repos'
)
SELECT trim(json_extract(v, '$.repo')),
       NULLIF(trim(COALESCE(json_extract(v, '$.machineId'), '')), ''),
       NULLIF(trim(COALESCE(json_extract(v, '$.checkout'), '')), ''),
       COALESCE(NULLIF(trim(COALESCE(json_extract(v, '$.recipe'), '')), ''), 'factory.json'),
       json_object('legacy', json_object(
         'worktree', COALESCE(json_extract(v, '$.worktree'), ''),
         'portFrom', json_extract(v, '$.portFrom'),
         'portTo', json_extract(v, '$.portTo'),
         'dbPrefix', COALESCE(json_extract(v, '$.dbPrefix'), ''),
         'migrationFrom', json_extract(v, '$.migrationFrom'),
         'migrationBlock', COALESCE(json_extract(v, '$.migrationBlock'), 10),
         'cleanup', json(CASE WHEN json_type(v, '$.cleanup') = 'array' THEN json_extract(v, '$.cleanup') ELSE '[]' END))),
       -- created when its first package was, like the projects below; now when it has none
       COALESCE((SELECT MIN(t.created_at) FROM tasks t WHERE lower(trim(t.repo)) = lower(trim(json_extract(v, '$.repo')))), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
FROM entries
WHERE json_type(v, '$.repo') = 'text' AND trim(json_extract(v, '$.repo')) <> ''
ORDER BY i;
DELETE FROM p9_src WHERE ord NOT IN (SELECT MIN(ord) FROM p9_src GROUP BY lower(repo));

-- then every other repo the backlog names, oldest first
INSERT INTO p9_src (repo, line_file, config_json, created_at)
SELECT MIN(trim(repo)), 'factory.json', '{}', MIN(created_at) FROM tasks
WHERE trim(COALESCE(repo, '')) <> '' AND lower(trim(repo)) NOT IN (SELECT lower(repo) FROM p9_src)
GROUP BY lower(trim(repo))
ORDER BY MIN(created_at), lower(trim(repo));

-- the name is the part after the last "/" ("Narcis13/arond" → "arond")
UPDATE p9_src SET name = COALESCE(NULLIF(replace(repo, rtrim(repo, replace(repo, '/', '')), ''), ''), repo);

-- the key: the name in lower case with every character outside a-z 0-9 - replaced by "-"
WITH RECURSIVE k(ord, src, i, out) AS (
  SELECT ord, lower(name), 1, '' FROM p9_src
  UNION ALL
  SELECT ord, src, i + 1, out || CASE WHEN substr(src, i, 1) GLOB '[a-z0-9-]' THEN substr(src, i, 1) ELSE '-' END FROM k WHERE i <= length(src)
)
UPDATE p9_src SET base = (SELECT out FROM k WHERE k.ord = p9_src.ord AND k.i = length(k.src) + 1);
-- ^[a-z][a-z0-9-]{1,23}$: a letter first, 2 to 24 characters
UPDATE p9_src SET base = 'p-' || base WHERE base NOT GLOB '[a-z]*';
UPDATE p9_src SET base = substr(base, 1, 24);
UPDATE p9_src SET base = base || '-p' WHERE length(base) < 2;
-- unique: the second "shop" becomes "shop-2"; a clash with another repo's own key falls back to the row number
UPDATE p9_src SET key = (
  SELECT CASE WHEN x.n = 1 THEN x.base ELSE substr(x.base, 1, 24 - length('-' || x.n)) || '-' || x.n END
  FROM (SELECT ord, base, ROW_NUMBER() OVER (PARTITION BY base ORDER BY ord) n FROM p9_src) x WHERE x.ord = p9_src.ord
);
UPDATE p9_src SET key = substr(base, 1, 24 - length('-' || ord)) || '-' || ord WHERE ord NOT IN (SELECT MIN(ord) FROM p9_src GROUP BY key);

INSERT OR IGNORE INTO factory_projects (key, name, repo, id_prefix, machine_id, checkout, line_file, config_json, state, autopilot, created_at, updated_at)
SELECT key, substr(name, 1, 120), repo, '', machine_id, checkout, line_file, config_json, 'active', 0, created_at, created_at FROM p9_src ORDER BY ord;

UPDATE tasks SET project = (SELECT p.key FROM factory_projects p WHERE lower(p.repo) = lower(trim(tasks.repo)))
WHERE trim(COALESCE(repo, '')) <> '';

-- what was already integrated goes to the archive
UPDATE tasks SET archived_at = COALESCE(integrated_at, updated_at) WHERE status = 'integrata';

DROP TABLE p9_src;
