import { useEffect, useState, type ReactNode } from 'react';
import { Card } from '../ui.tsx';
import { Button } from './Touch.tsx';

export const inputClass = 'min-h-[44px] w-full rounded-lg border border-line bg-bg-2 px-3 text-base outline-none focus:border-accent';

export function SectionCard({ title, hint, children, testId }: { title: string; hint?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <Card className="min-w-0 p-4" data-testid={testId}>
      <h2 className="text-base font-semibold tracking-wide">{title}</h2>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      <div className="mt-3 space-y-4">{children}</div>
    </Card>
  );
}

export function Field({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-[15px] font-medium">{label}</label>
      {children}
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </div>
  );
}

/** Number input that keeps its text while typing; commits null for an empty box. */
export function NumberField({ id, value, onChange, min = 0, step = 1, placeholder }: { id: string; value: number | null; onChange: (v: number | null) => void; min?: number; step?: number; placeholder?: string }) {
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      min={min}
      step={step}
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      className={inputClass}
    />
  );
}

/** A Save button with "Saved" / error feedback, for one section. */
export function SaveButton({ onSave, pending, error, disabled, testId }: { onSave: () => void; pending: boolean; error: Error | null; disabled?: boolean; testId?: string }) {
  const [saved, setSaved] = useState(false);
  const [wasPending, setWasPending] = useState(false);
  useEffect(() => {
    if (pending) setWasPending(true);
    else if (wasPending) {
      setWasPending(false);
      if (!error) {
        setSaved(true);
        const t = setTimeout(() => setSaved(false), 2000);
        return () => clearTimeout(t);
      }
    }
  }, [pending, wasPending, error]);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" disabled={pending || disabled} onClick={onSave} data-testid={testId}>{pending ? 'Saving…' : 'Save'}</Button>
      {saved && <span className="text-working" role="status">Saved</span>}
      {error && <span className="text-error" role="alert">{error.message}</span>}
    </div>
  );
}
