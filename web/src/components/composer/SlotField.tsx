// One form control per template slot, chosen from the slot's inferred kind.
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { nameKey, type LintWarning, type Slot, type Values } from '../../../../shared/harness.ts';
import { Button, helpCls, inputCls, labelCls, Warnings } from './fields.tsx';

interface Props {
  slot: Slot;
  values: Values;
  onChange: (key: string, value: string) => void;
  warnings: LintWarning[];
}

/** Done when: one check per row. The value is the rows joined by newlines. */
function ListEditor({ slot, value, onChange }: { slot: Slot; value: string; onChange: (v: string) => void }) {
  const rows = value === '' ? [''] : value.split('\n');
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const [focus, setFocus] = useState<number | null>(null);
  useEffect(() => {
    if (focus !== null) refs.current[focus]?.focus();
    setFocus(null);
  }, [focus]);
  const set = (next: string[]) => onChange(next.join('\n'));
  const edit = (i: number, v: string) => set(rows.map((r, j) => (j === i ? v : r)));
  const insertAfter = (i: number, items: string[]) => {
    set([...rows.slice(0, i + 1), ...items, ...rows.slice(i + 1)]);
    setFocus(i + items.length);
  };
  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      insertAfter(i, ['']);
    } else if (e.key === 'Backspace' && rows[i] === '' && rows.length > 1) {
      e.preventDefault();
      set(rows.filter((_, j) => j !== i));
      setFocus(Math.max(0, i - 1));
    }
  };
  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!/\r?\n/.test(text)) return;
    e.preventDefault();
    const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim()).filter(Boolean);
    if (!lines.length) return;
    const at = rows[i] === '' ? i : i + 1;
    set([...rows.slice(0, at), ...lines, ...rows.slice(i + 1)]);
  };
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-6 shrink-0 text-right font-mono text-[15px] text-muted">{i + 1}.</span>
          <input
            ref={(el) => {
              refs.current[i] = el;
            }}
            aria-label={`${slot.key} check ${i + 1}`}
            className={inputCls}
            value={r}
            placeholder={i === 0 ? slot.hint : 'another check'}
            onChange={(e) => edit(i, e.target.value)}
            onKeyDown={(e) => onKey(i, e)}
            onPaste={(e) => onPaste(i, e)}
          />
          <Button aria-label={`Remove check ${i + 1}`} className="min-w-[44px] px-0" disabled={rows.length === 1 && r === ''} onClick={() => set(rows.length === 1 ? [''] : rows.filter((_, j) => j !== i))}>
            ✕
          </Button>
        </div>
      ))}
      <Button onClick={() => insertAfter(rows.length - 1, [''])}>+ Add check</Button>
    </div>
  );
}

export function SlotField({ slot, values, onChange, warnings }: Props) {
  const value = values[slot.key] ?? '';
  const id = `slot-${slot.key.replace(/\W+/g, '-')}`;
  const warn = <Warnings items={warnings} />;
  const help = slot.help ? <p className={helpCls}>{slot.help}</p> : null;

  if (slot.kind === 'toggle') {
    return (
      <div>
        <button
          type="button"
          role="switch"
          aria-checked={value.toLowerCase() === 'yes'}
          aria-label={slot.key}
          onClick={() => onChange(slot.key, value.toLowerCase() === 'yes' ? 'no' : 'yes')}
          className="inline-flex min-h-[44px] items-center gap-3 text-[15px]"
        >
          <span className={`relative inline-block h-6 w-11 shrink-0 rounded-full transition ${value.toLowerCase() === 'yes' ? 'bg-waiting' : 'bg-line'}`}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${value.toLowerCase() === 'yes' ? 'left-[22px]' : 'left-0.5'}`} />
          </span>
          <span className="font-medium">{slot.key}</span>
          <span className="font-mono text-muted">{value.toLowerCase() === 'yes' ? 'yes' : 'no'}</span>
        </button>
        {help}
        {warn}
      </div>
    );
  }

  if (slot.kind === 'choice') {
    const sel = value || slot.choices![0];
    return (
      <div>
        <span id={`${id}-l`} className={labelCls}>
          {slot.key}
        </span>
        <div role="radiogroup" aria-labelledby={`${id}-l`} className="flex gap-2">
          {slot.choices!.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={sel === c}
              onClick={() => onChange(slot.key, c)}
              className={`min-h-[44px] flex-1 rounded-lg border px-4 text-[15px] ${sel === c ? 'border-accent bg-accent text-accent-ink font-semibold' : 'border-line bg-panel-2 text-ink hover:border-accent'}`}
            >
              {c}
            </button>
          ))}
        </div>
        {slot.nameFor && sel === slot.nameFor && (
          <input
            aria-label={`${slot.key} name`}
            className={`${inputCls} mt-2 font-mono`}
            value={values[nameKey(slot.key)] ?? ''}
            placeholder={slot.nameExample ?? 'name'}
            onChange={(e) => onChange(nameKey(slot.key), e.target.value)}
          />
        )}
        {help}
        {warn}
      </div>
    );
  }

  if (slot.kind === 'list') {
    return (
      <fieldset>
        <legend className={labelCls}>{slot.key}</legend>
        <ListEditor slot={slot} value={value} onChange={(v) => onChange(slot.key, v)} />
        {help}
        {warn}
      </fieldset>
    );
  }

  if (slot.kind === 'number') {
    return (
      <div>
        <label htmlFor={id} className={labelCls}>
          {slot.key}
        </label>
        <input id={id} type="number" inputMode="numeric" min={0} step={1} className={`${inputCls} max-w-40`} value={value} placeholder={slot.default} onChange={(e) => onChange(slot.key, e.target.value)} />
        <p className={helpCls}>{slot.help ? slot.help.charAt(0).toUpperCase() + slot.help.slice(1) : slot.default ? `Default ${slot.default}` : ''}</p>
        {warn}
      </div>
    );
  }

  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {slot.key}
      </label>
      <textarea id={id} rows={slot.large ? 5 : 2} className={`${inputCls} resize-y ${slot.large ? 'min-h-32' : ''}`} value={value} placeholder={slot.hint} onChange={(e) => onChange(slot.key, e.target.value)} />
      {help}
      {warn}
    </div>
  );
}
