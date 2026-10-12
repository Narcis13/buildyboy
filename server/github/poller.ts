// GitHub PR poller (SPEC §5.6). With a token in settings.github_token, every 2 min it reads PRs for the branches of
// active projects, their review state and check runs, links PRs to sessions by URL or branch, and notifies on CI changes.
// Without a token it does nothing.
import type { Ctx } from '../context.ts';

const API = () => process.env.BUILDYBOY_GITHUB_API ?? 'https://api.github.com';
const EVERY_MS = 2 * 60_000;

interface Target {
  projectId: number;
  owner: string;
  repo: string;
  branch: string;
  sessionId: string;
}

async function gh<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API()}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'buildyboy' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return (await res.json()) as T;
}

export function checksState(runs: { status: string; conclusion: string | null }[]): string {
  if (!runs.length) return 'none';
  if (runs.some((r) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion ?? ''))) return 'failure';
  if (runs.every((r) => r.status === 'completed')) return 'success';
  return 'pending';
}

/** One polling pass. Returns 'skipped' without a token. */
export async function pollGithub(ctx: Ctx): Promise<'skipped' | number> {
  const token = ctx.db.getSetting<string | null>('github_token', null);
  if (!token) return 'skipped';
  const { db } = ctx;
  const targets = db.all<Target>(
    `SELECT p.id AS projectId, p.gh_owner AS owner, p.gh_repo AS repo, s.git_branch AS branch, s.id AS sessionId
     FROM sessions s JOIN projects p ON p.id = s.project_id
     WHERE p.gh_owner IS NOT NULL AND s.git_branch IS NOT NULL AND s.last_event_at > ? GROUP BY p.id, s.git_branch`,
    Date.now() - 7 * 24 * 3600_000,
  );
  let updated = 0;
  for (const t of targets) {
    try {
      const pulls = await gh<any[]>(token, `/repos/${t.owner}/${t.repo}/pulls?state=all&per_page=5&head=${encodeURIComponent(`${t.owner}:${t.branch}`)}`);
      for (const pr of pulls) {
        const runs = await gh<{ check_runs: { name: string; status: string; conclusion: string | null; html_url: string }[] }>(token, `/repos/${t.owner}/${t.repo}/commits/${pr.head.sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] }));
        const reviews = await gh<{ state: string }[]>(token, `/repos/${t.owner}/${t.repo}/pulls/${pr.number}/reviews?per_page=100`).catch(() => []);
        const state = pr.merged_at ? 'merged' : pr.state;
        const cs = checksState(runs.check_runs);
        const prev = db.get<{ checks_state: string | null }>('SELECT checks_state FROM pull_requests WHERE url = ?', pr.html_url);
        db.run(
          `INSERT INTO pull_requests (project_id, number, url, title, state, branch, session_id, review_state, checks_state, checks_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(url) DO UPDATE SET title = excluded.title, state = excluded.state, branch = excluded.branch, review_state = excluded.review_state,
             checks_state = excluded.checks_state, checks_json = excluded.checks_json, updated_at = excluded.updated_at,
             session_id = COALESCE(pull_requests.session_id, excluded.session_id), project_id = COALESCE(pull_requests.project_id, excluded.project_id)`,
          t.projectId, pr.number, pr.html_url, pr.title, state, pr.head.ref, t.sessionId, reviews.at(-1)?.state ?? null, cs,
          JSON.stringify(runs.check_runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url }))), Date.now(),
        );
        updated++;
        if (prev && prev.checks_state !== cs && (cs === 'failure' || cs === 'success')) {
          const sid = db.get<{ session_id: string | null }>('SELECT session_id FROM pull_requests WHERE url = ?', pr.html_url)?.session_id ?? undefined;
          ctx.notify({ type: 'ci', title: `CI ${cs === 'failure' ? 'failed' : 'passed'}: #${pr.number} ${pr.title}`, body: `${t.owner}/${t.repo} · ${pr.head.ref}`, sessionId: sid, url: sid ? `/s/${sid}` : `/projects/${t.projectId}` });
        }
        ctx.bus.publish('floor', 'session', { id: t.sessionId });
      }
    } catch (e) {
      console.error('[github]', (e as Error).message);
    }
  }
  return updated;
}

export function startGithubPoller(ctx: Ctx): () => void {
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    pollGithub(ctx).catch((e) => console.error('[github]', e)).finally(() => (running = false));
  }, EVERY_MS);
  t.unref();
  return () => clearInterval(t);
}
