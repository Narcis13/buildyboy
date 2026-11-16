import { STATUS_LABEL, type TaskEvent, type TaskStatus } from '../../../../shared/factory.ts';
import { RelTime } from '../ui.tsx';

const label = (s: string | null) => (s && s in STATUS_LABEL ? STATUS_LABEL[s as TaskStatus] : (s ?? ''));

const short = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One line saying what an event did. Details are free-form JSON written by the server and the agents. */
export function describeEvent(e: TaskEvent): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  switch (e.kind) {
    case 'created':
      return `created as ${label(e.to)}${d.title ? `: ${str(d.title)}` : ''}`;
    case 'status':
      return `${label(e.from)} → ${label(e.to)}${d.note ? ` (${str(d.note)})` : ''}${d.claimedBy ? ` · claimed by ${str(d.claimedBy)}` : ''}`;
    case 'gate':
      return `${str(d.gate)} ${str(d.verdict)}${typeof d.shots === 'number' && d.shots > 0 ? `, ${d.shots} screenshot${d.shots > 1 ? 's' : ''}` : ''}`;
    case 'note':
      return str(d.note);
    case 'control':
      return `${d.kind === 'revert' ? 'revert integration' : 'stop'} requested${d.note ? `: ${str(d.note)}` : ''}`;
    case 'control_ack':
      return `${d.kind === 'revert' ? 'revert' : 'stop'} request picked up`;
    case 'line':
      return str(d.text ?? d.waiting ?? 'line');
    case 'step_run':
      return `started step ${str(d.step)}${typeof d.round === 'number' ? `, round ${d.round}` : ''}`;
    case 'step':
      return `step ${str(d.step)}${d.verdict ? ` ${str(d.verdict)}` : d.error ? ' failed' : ' ended'}${d.summary ? `: ${short(str(d.summary))}` : d.error ? `: ${short(str(d.error))}` : ''}`;
    case 'gate_run':
      return `started ${str(d.gate)}${typeof d.round === 'number' ? `, round ${d.round}` : ''}`;
    case 'hc':
      return `terminal ${str(d.op)} ${str(d.name)}${d.text ? `: ${short(str(d.text))}` : ''}`;
    case 'hc_done':
      return `terminal ${str(d.op)} ${str(d.name)} ${str(d.status)}${d.error ? `: ${short(str(d.error))}` : ''}`;
    case 'warning':
      return `warning: ${str(d.message)}`;
    case 'update':
      return `changed ${Object.keys(d).join(', ') || 'fields'}`;
    default:
      return e.kind;
  }
}

/** Newest first, as the server returns it. */
export function TaskHistory({ events }: { events: TaskEvent[] }) {
  if (!events.length) return <div className="text-muted">Nothing yet.</div>;
  return (
    <ol className="space-y-1" data-testid="history">
      {events.map((e, i) => (
        <li key={i} className="flex flex-col gap-0.5 border-l-2 border-line py-1 pl-3 sm:flex-row sm:gap-3" data-testid="history-item" data-kind={e.kind}>
          <span className="shrink-0 text-sm text-muted sm:w-24">
            <RelTime ts={e.ts} />
          </span>
          <span className="min-w-0 text-[15px] [overflow-wrap:anywhere]">
            {e.kind === 'line' || e.actor === 'factory:line' ? (
              <>
                <span className="text-accent" title="The conductor (autopilot)">⚙ line</span> {describeEvent(e)}
              </>
            ) : (
              <>
                <span className="text-muted">{e.actor}</span> {describeEvent(e)}
              </>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
