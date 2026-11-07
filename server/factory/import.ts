// GitHub issues → backlog (SPEC §11.2), through the same token and client as the PR poller. Re-importing updates
// the title and body of tasks already imported (matched by `owner/repo#number`); their status is kept.
import type { Ctx } from '../context.ts';
import { gh } from '../github/poller.ts';
import { createTask, FactoryError } from './tasks.ts';
import { acceptanceSection } from '../../shared/tasks-md.ts';

interface Issue { number: number; title: string; body: string | null; html_url: string; pull_request?: unknown; labels: ({ name?: string } | string)[] }

export async function importGithubIssues(ctx: Ctx, owner: string, repo: string, label?: string): Promise<{ imported: string[] }> {
  const token = ctx.db.getSetting<string | null>('github_token', null);
  if (!token) throw new FactoryError(400, 'set a GitHub token in Settings first');
  const q = new URLSearchParams({ state: 'open', per_page: '100' });
  if (label) q.set('labels', label);
  const issues = (await gh<Issue[]>(token, `/repos/${owner}/${repo}/issues?${q}`)).filter((i) => !i.pull_request);
  const imported: string[] = [];
  for (const i of issues) {
    const body = `${i.body ?? ''}\n\n<${i.html_url}>`.trim();
    const t = createTask(
      ctx,
      { title: i.title.slice(0, 200), body, acceptance: acceptanceSection(i.body ?? ''), repo: `${owner}/${repo}`, extRef: `${owner}/${repo}#${i.number}`, upsert: true, source: 'github' },
      'web',
    );
    imported.push(t.id);
  }
  return { imported };
}
