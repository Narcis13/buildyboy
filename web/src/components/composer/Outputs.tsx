// Outputs: copy the Markdown, download TASK.md, copy a ready command line, launch as a job.
import { useState } from 'react';
import { CopyButton } from '../ui.tsx';
import { Button, helpCls, inputCls, labelCls } from './fields.tsx';

export const PERMISSION_MODES = ['acceptEdits', 'default', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const;

export function commandLines(mode: string, budget: string): { bash: string; powershell: string } {
  const flags = `--permission-mode ${mode} --max-budget-usd ${budget}`;
  return {
    bash: `claude -p "$(cat TASK.md)" ${flags}`,
    powershell: `claude -p (Get-Content -Raw TASK.md) ${flags}`,
  };
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface Props {
  raw: string;
  busy: boolean;
  onLaunch: () => void;
}

export function Outputs({ raw, busy, onLaunch }: Props) {
  const [mode, setMode] = useState<string>('acceptEdits');
  const [budget, setBudget] = useState('5');
  const b = Number(budget) > 0 ? String(Number(budget)) : '5';
  const cmd = commandLines(mode, b);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <CopyButton text={raw} label="Copy Markdown" className="min-h-[44px]! px-4 text-[15px]" />
        <Button onClick={() => download('TASK.md', raw)}>Download TASK.md</Button>
        <Button variant="primary" disabled={busy} onClick={onLaunch}>
          Launch as a job
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="out-mode" className={labelCls}>
            Permission mode
          </label>
          <select id="out-mode" className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)}>
            {PERMISSION_MODES.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="out-budget" className={labelCls}>
            Max budget (USD)
          </label>
          <input id="out-budget" type="number" inputMode="decimal" min={0.01} step={0.5} className={inputCls} value={budget} onChange={(e) => setBudget(e.target.value)} />
        </div>
      </div>
      {(
        [
          ['bash', 'Bash', cmd.bash],
          ['powershell', 'PowerShell', cmd.powershell],
        ] as const
      ).map(([id, label, text]) => (
        <div key={id}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[15px] font-medium">{label}</span>
            <CopyButton text={text} label={`Copy ${label} command`} className="min-h-[44px]! px-4 text-[15px]" />
          </div>
          <pre data-testid={`cmd-${id}`} className="overflow-x-auto rounded-lg border border-line bg-bg-2 p-3 font-mono text-[15px]">
            {text}
          </pre>
        </div>
      ))}
      <p className={helpCls}>Save the Markdown as TASK.md in the project directory, then run the command there.</p>
    </div>
  );
}
