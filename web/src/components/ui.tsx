// Shared UI primitives. Phone-first: 44px touch targets, 15px+ text.
import { useEffect, useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { marked } from 'marked';
import type { SessionStatus } from '../../../shared/types.ts';
import { exactTime, relTime } from '../lib/format.ts';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Raw HTML in markdown is shown as text, never rendered.
marked.use({ gfm: true, breaks: false, renderer: { html: (t) => escapeHtml(t.text) } });

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const out = marked.parse(text, { async: false }) as string;
    // links open in a new tab and can't use javascript:
    return out.replace(/<a href="(?!https?:|\/|#)[^"]*"/g, '<a href="#"').replace(/<a /g, '<a target="_blank" rel="noreferrer" ');
  }, [text]);
  return <div className={`bb-md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

type Variant = 'primary' | 'ghost' | 'danger' | 'ok' | 'warn';
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110',
  ghost: 'bg-panel-2 text-ink border border-line hover:border-accent',
  danger: 'bg-error text-white hover:brightness-110',
  ok: 'bg-working text-[#04121f] hover:brightness-110',
  warn: 'bg-waiting text-[#1d1300] hover:brightness-110',
};

export function Button({ variant = 'ghost', className = '', size = 'md', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'lg' ? 'min-h-14 px-5 text-base font-semibold' : size === 'sm' ? 'min-h-9 px-3 text-sm' : 'min-h-11 px-4 text-[15px]';
  return <button {...rest} className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${sz} ${variants[variant]} ${className}`} />;
}

export function Card({ children, className = '', ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={`rounded-xl border border-line bg-panel ${className}`}>
      {children}
    </div>
  );
}

export function Lamp({ status, size = 14, className = '' }: { status: SessionStatus; size?: number; className?: string }) {
  return <span role="img" aria-label={status} title={status} className={`inline-block shrink-0 bb-lamp bb-lamp-${status} ${className}`} style={{ width: size, height: size }} />;
}

export function statusLabel(s: SessionStatus): string {
  return { working: 'Working', waiting: 'Waiting on you', idle: 'Idle', compacting: 'Compacting', stale: 'Stale', ended: 'Ended', error: 'Error' }[s];
}

/** Relative time that ticks, with the exact time on hover / long-press. */
export function RelTime({ ts, className = '' }: { ts: number | null | undefined; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <time className={className} title={exactTime(ts)} dateTime={ts ? new Date(ts).toISOString() : undefined}>
      {relTime(ts)}
    </time>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="inline-flex min-h-11 items-center gap-2 text-[15px] disabled:opacity-50"
    >
      <span className={`relative inline-block h-6 w-11 rounded-full transition ${on ? 'bg-waiting' : 'bg-line'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
      </span>
      <span>{label}</span>
    </button>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className = '' }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div role="tablist" className={`flex gap-1 overflow-x-auto border-b border-line ${className}`}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3 text-[15px] ${value === t.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line p-6 text-center text-muted">{children}</div>;
}

export function PageTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-xl font-semibold tracking-wide">{children}</h1>
      {right}
    </div>
  );
}

export function Badge({ children, color = 'var(--bb-muted)', className = '' }: { children: ReactNode; color?: string; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-xs uppercase tracking-wider ${className}`} style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}>
      {children}
    </span>
  );
}
