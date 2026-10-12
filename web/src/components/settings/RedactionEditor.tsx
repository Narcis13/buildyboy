import { useMemo, useState } from 'react';
import { compileRules } from '../../../../shared/redact.ts';
import { Button } from './Touch.tsx';
import { inputClass, SaveButton, SectionCard } from './bits.tsx';
import { useSettings, type RedactionRule, type SettingsData } from './useSettings.ts';

function ruleError(r: RedactionRule): string | null {
  if (!r.name.trim()) return 'needs a name';
  if (!r.pattern) return 'needs a pattern';
  try {
    new RegExp(r.pattern, r.flags ?? '');
    return null;
  } catch (e) {
    return (e as Error).message.replace(/^Invalid regular expression: /, '');
  }
}

/** Masks the text exactly the way the server would (same compileRules), for the live preview. */
function preview(rules: RedactionRule[], text: string): string {
  let out = text;
  for (const { re, replace } of compileRules(rules.filter((r) => !ruleError(r)))) out = out.replace(re, replace);
  return out;
}

export function RedactionEditor({ data }: { data: SettingsData }) {
  const { save } = useSettings();
  const [rules, setRules] = useState<RedactionRule[]>(() => (data.redaction_rules ?? []).map((r) => ({ ...r })));
  const [sample, setSample] = useState('curl -H "X-Internal: abc123-secret" https://example.com');
  const errors = rules.map(ruleError);
  const out = useMemo(() => preview(rules, sample), [rules, sample]);
  const patch = (i: number, p: Partial<RedactionRule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <SectionCard
      title="Redaction rules"
      hint="Built-in rules already mask API keys, tokens, JWTs, Bearer headers, password= values and .env contents before anything is stored. Add your own here (JavaScript regular expressions)."
      testId="settings-redaction"
    >
      <ul className="space-y-3">
        {rules.map((r, i) => (
          <li key={i} className="space-y-2 rounded-lg border border-line p-3" data-testid="redaction-rule">
            <div className="grid gap-2 sm:grid-cols-[1fr_2fr_6rem]">
              <input aria-label={`Rule ${i + 1} name`} value={r.name} onChange={(e) => patch(i, { name: e.target.value })} placeholder="name" className={inputClass} />
              <input aria-label={`Rule ${i + 1} pattern`} value={r.pattern} onChange={(e) => patch(i, { pattern: e.target.value })} placeholder="pattern, e.g. acme-[a-z0-9]{16}" className={`${inputClass} font-mono`} spellCheck={false} />
              <input aria-label={`Rule ${i + 1} flags`} value={r.flags ?? ''} onChange={(e) => patch(i, { flags: e.target.value })} placeholder="flags (g)" className={`${inputClass} font-mono`} spellCheck={false} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className={`min-w-0 break-words text-sm ${errors[i] ? 'text-error' : 'text-muted'}`}>{errors[i] ? `Invalid: ${errors[i]}` : 'Valid'}</span>
              <Button size="sm" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          </li>
        ))}
      </ul>
      <Button onClick={() => setRules((rs) => [...rs, { name: '', pattern: '', flags: '' }])} data-testid="redaction-add">Add a rule</Button>
      {rules.length > 0 && (
        <div className="space-y-1">
          <label htmlFor="redaction-sample" className="block text-sm text-muted">Try it on sample text</label>
          <textarea id="redaction-sample" rows={2} value={sample} onChange={(e) => setSample(e.target.value)} className={`${inputClass} font-mono text-sm`} spellCheck={false} />
          <pre className="whitespace-pre-wrap break-all rounded-lg bg-bg-2 p-2 font-mono text-sm" data-testid="redaction-preview">{out}</pre>
        </div>
      )}
      <SaveButton
        testId="redaction-save"
        pending={save.isPending}
        error={save.error as Error | null}
        disabled={errors.some(Boolean)}
        onSave={() => save.mutate({ redaction_rules: rules.map((r) => ({ name: r.name.trim(), pattern: r.pattern, ...(r.flags ? { flags: r.flags } : {}) })) })}
      />
    </SectionCard>
  );
}
