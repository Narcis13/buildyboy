// Form styling shared by the composer components. 44px touch targets, 15px+ text.
import type { ComponentProps, ReactNode } from 'react';
import type { LintWarning } from '../../../../shared/harness.ts';
import { Button as UiButton } from '../ui.tsx';

export const inputCls =
  'w-full min-h-[44px] rounded-lg border border-line bg-panel-2 px-3 py-2 text-[15px] text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none';

export const labelCls = 'mb-1 block text-[15px] font-medium';
export const helpCls = 'mt-1 text-[15px] text-muted';

/** Inline lint warnings for one field. */
export function Warnings({ items }: { items: LintWarning[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-1.5 space-y-1">
      {items.map((w) => (
        <li key={w.id} data-testid={`lint-${w.id}`} className="flex gap-2 text-[15px] text-waiting">
          <span aria-hidden>⚠</span>
          <span>{w.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function Section({ title, right, children, className = '' }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-panel p-3 sm:p-4 ${className}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold tracking-wide">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** ui.tsx Button with a true 44px touch target (the root font size is 15px, so min-h-11 is only 41px). */
export function Button({ className = '', ...rest }: ComponentProps<typeof UiButton>) {
  return <UiButton {...rest} className={`min-h-[44px]! ${className}`} />;
}

/** Keeps Tabs from ui.tsx at 44px tall too. */
export const tabsTap = '[&>button]:min-h-[44px]!';
