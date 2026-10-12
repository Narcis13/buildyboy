import { useQuery } from '@tanstack/react-query';
import type { AttentionSummary } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { Link } from '../lib/router.tsx';

/** Sticky bar on every page: "2 waiting for you · 1 job failed". One tap opens the Inbox. */
export function AttentionBar() {
  const { data } = useQuery({ queryKey: ['attention'], queryFn: () => api.get<AttentionSummary>('/api/attention'), refetchInterval: 30_000 });
  const { data: global } = useQuery({ queryKey: ['global'], queryFn: () => api.get<{ walk: boolean; pauseAll: boolean }>('/api/global') });
  if (!data) return null;
  const parts: string[] = [];
  if (data.waiting) parts.push(`${data.waiting} waiting for you`);
  if (data.jobsFailed) parts.push(`${data.jobsFailed} job${data.jobsFailed > 1 ? 's' : ''} failed`);
  if (data.stale) parts.push(`${data.stale} stale`);
  const flags = [global?.walk ? 'Walk mode on' : null, global?.pauseAll ? 'Everything paused' : null].filter(Boolean);
  if (!parts.length && !flags.length) return null;
  const urgent = data.waiting > 0 || data.jobsFailed > 0;
  return (
    <Link
      to="/inbox"
      data-testid="attention-bar"
      className={`sticky top-0 z-40 flex min-h-11 items-center justify-center gap-3 px-4 text-center text-[15px] font-medium ${urgent ? 'bg-waiting text-[#1d1300]' : 'bg-panel-2 text-ink border-b border-line'}`}
    >
      {urgent && <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-[#1d1300]" />}
      <span>{[...parts, ...flags].join(' · ')}</span>
    </Link>
  );
}
