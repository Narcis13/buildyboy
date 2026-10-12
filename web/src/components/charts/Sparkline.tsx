/** A tiny line with an optional end dot. No axes; meant to sit next to a number. */
export function Sparkline({ values, width = 96, height = 28, color = 'var(--bb-accent)', ariaLabel }: { values: number[]; width?: number; height?: number; color?: string; ariaLabel?: string }) {
  if (values.length < 2) return <svg width={width} height={height} role="img" aria-label={ariaLabel ?? 'no data'} />;
  const max = Math.max(...values, 0.0001);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pad = 3;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (values.length - 1);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} role="img" aria-label={ariaLabel ?? 'trend'} className="shrink-0">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={2.5} fill={color} />
    </svg>
  );
}
