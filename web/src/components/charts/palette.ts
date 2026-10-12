// Series colours for the hand-written charts. They are theme tokens so both themes work.
export const SERIES_COLORS = [
  'var(--bb-accent)',
  'var(--bb-tool-edit)',
  'var(--bb-tool-bash)',
  'var(--bb-tool-web)',
  'var(--bb-tool-mcp)',
  'var(--bb-tool-agent)',
  'var(--bb-working)',
  'var(--bb-tool-other)',
];

export function seriesColor(i: number): string {
  return SERIES_COLORS[i % SERIES_COLORS.length];
}

/** Keeps the `max` largest series by total and folds the rest into "other". */
export function topSeries(totals: { name: string; total: number }[], max = 6): string[] {
  const sorted = [...totals].sort((a, b) => b.total - a.total);
  const names = sorted.slice(0, max).map((t) => t.name);
  if (sorted.length > max) names.push('other');
  return names;
}

/** Re-keys a breakdown so anything outside `series` is summed under "other". */
export function foldOther(values: Record<string, number>, series: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) {
    const key = series.includes(k) ? k : 'other';
    out[key] = (out[key] ?? 0) + v;
  }
  return out;
}
