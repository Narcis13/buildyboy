import { useEffect, useState } from 'react';
import { GATES, GATE_LABEL, type Gate, type GateResult, type GateShot } from '../../../../shared/factory.ts';
import { Button, Card, RelTime } from '../ui.tsx';
import { VerdictBadge } from './common.tsx';

/** Full-size screenshot over the page: Escape, the close button or a tap outside closes it. */
function Lightbox({ shot, onClose }: { shot: GateShot; onClose: () => void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={shot.name} data-testid="lightbox" className="fixed inset-0 z-50 flex flex-col bg-black/85 p-3" onClick={onClose}>
      <div className="mb-2 flex items-center justify-between gap-3 text-white">
        <span className="min-w-0 truncate font-mono text-sm">{shot.name}</span>
        <Button onClick={onClose} data-testid="lightbox-close">Close</Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
        <img src={shot.url} alt={shot.name} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
      </div>
    </div>
  );
}

function Shots({ shots, open }: { shots: GateShot[]; open: (s: GateShot) => void }) {
  if (!shots.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2" data-testid="gate-shots">
      {shots.map((s) => (
        <li key={s.id}>
          <button
            type="button"
            onClick={() => open(s)}
            className="block min-h-[44px] min-w-[44px] overflow-hidden rounded-lg border border-line bg-bg-2 hover:border-accent"
            aria-label={`Open screenshot ${s.name}`}
            title={s.name}
            data-testid="gate-shot"
          >
            <img src={s.url} alt={s.name} loading="lazy" className="block h-24 w-auto max-w-[12rem] object-cover" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function ResultBody({ r, open }: { r: GateResult; open: (s: GateShot) => void }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <VerdictBadge verdict={r.verdict} />
        <span className="text-sm text-muted">{r.actor}</span>
        <RelTime ts={r.createdAt} className="text-sm text-muted" />
      </div>
      {r.summary && <p className="mt-1 whitespace-pre-wrap text-[15px] [overflow-wrap:anywhere]">{r.summary}</p>}
      <Shots shots={r.shots} open={open} />
    </>
  );
}

/** One row per gate G1–G5 with its latest result; earlier attempts fold away. `results` is newest first per gate. */
export function GatesSection({ results }: { results: GateResult[] }) {
  const [shot, setShot] = useState<GateShot | null>(null);
  const byGate = (g: Gate) => results.filter((r) => r.gate === g);
  return (
    <>
      <ul className="space-y-2" data-testid="gates">
        {GATES.map((g) => {
          const [latest, ...earlier] = byGate(g);
          return (
            <li key={g}>
              <Card className="p-3" data-testid="gate-row" data-gate={g}>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono font-semibold text-accent">{g}</span>
                  <span className="min-w-0 text-[15px] text-muted [overflow-wrap:anywhere]">{GATE_LABEL[g]}</span>
                </div>
                <div className="mt-1.5">
                  {latest ? <ResultBody r={latest} open={setShot} /> : <span className="text-sm text-muted">No result yet</span>}
                </div>
                {earlier.length > 0 && (
                  <details className="mt-1" data-testid="gate-earlier">
                    <summary className="flex min-h-[44px] cursor-pointer items-center text-sm text-muted">
                      {earlier.length} earlier attempt{earlier.length > 1 ? 's' : ''}
                    </summary>
                    <ul className="space-y-3 border-l border-line pl-3">
                      {earlier.map((r) => (
                        <li key={r.id}>
                          <ResultBody r={r} open={setShot} />
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
      {shot && <Lightbox shot={shot} onClose={() => setShot(null)} />}
    </>
  );
}
