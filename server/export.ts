import type { Ctx } from './context.ts';
import { sessionDetail, timeline } from './queries.ts';

/** Session as Markdown: prompts, answers, tool summaries and diffs. */
export function exportMarkdown(ctx: Ctx, sid: string): string | null {
  const s = sessionDetail(ctx, sid);
  if (!s) return null;
  const out: string[] = [
    `# ${s.name ?? s.projectName ?? 'Session'} (${sid})`,
    '',
    `- Machine: ${s.machineName}`,
    `- Directory: ${s.cwd ?? '?'}`,
    `- Branch: ${s.branch ?? '?'}`,
    `- Model: ${s.model ?? '?'}`,
    `- Started: ${new Date(s.startedAt).toISOString()}`,
    `- Cost: $${s.costUsd.toFixed(2)}`,
    `- Lines: +${s.linesAdded} −${s.linesRemoved}`,
    '',
  ];
  const fence = (t: string, lang = '') => `\`\`\`\`${lang}\n${t}\n\`\`\`\``;
  for (const it of timeline(ctx, sid, undefined, 100000).items) {
    if (it.agentId) continue;
    if (it.kind === 'prompt') out.push(`## 🧑 Prompt`, '', it.text, '');
    else if (it.kind === 'assistant') out.push(`### Claude`, '', it.text, '');
    else if (it.kind === 'tool') {
      const head = it.command ? `\`${it.tool}\`: \`${it.command.split('\n')[0]}\`` : it.filePath ? `\`${it.tool}\`: ${it.filePath}` : `\`${it.tool}\``;
      out.push(`- ${head}${it.status !== 'ok' ? ` (${it.status})` : ''}`);
      if (it.patch) out.push('', fence(it.patch, 'diff'), '');
    } else if (it.kind === 'event' && it.level !== 'info') out.push(`> ${it.event}: ${it.summary}`, '');
  }
  return out.join('\n');
}
