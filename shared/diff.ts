// Small line diff (LCS) producing unified-diff text. Good enough for edits and prompt versions;
// inputs past a size cap fall back to a plain remove/add block.

export interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

const MAX_CELLS = 4_000_000;

export function diffLines(a: string, b: string): DiffLine[] {
  const x = a === '' ? [] : a.split(/\r?\n/);
  const y = b === '' ? [] : b.split(/\r?\n/);
  // trim common prefix/suffix to keep the table small
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xs = x.slice(pre, x.length - suf);
  const ys = y.slice(pre, y.length - suf);
  const head: DiffLine[] = x.slice(0, pre).map((text) => ({ op: ' ', text }));
  const tail: DiffLine[] = x.slice(x.length - suf).map((text) => ({ op: ' ', text }));
  let mid: DiffLine[];
  if (xs.length * ys.length > MAX_CELLS) {
    mid = [...xs.map((text) => ({ op: '-' as const, text })), ...ys.map((text) => ({ op: '+' as const, text }))];
  } else {
    const n = xs.length;
    const m = ys.length;
    const t: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = xs[i] === ys[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    mid = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (xs[i] === ys[j]) {
        mid.push({ op: ' ', text: xs[i] });
        i++;
        j++;
      } else if (t[i + 1][j] >= t[i][j + 1]) mid.push({ op: '-', text: xs[i++] });
      else mid.push({ op: '+', text: ys[j++] });
    }
    while (i < n) mid.push({ op: '-', text: xs[i++] });
    while (j < m) mid.push({ op: '+', text: ys[j++] });
  }
  return [...head, ...mid, ...tail];
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === '+') added++;
    else if (l.op === '-') removed++;
  }
  return { added, removed };
}

/** Unified diff text with @@ hunks and `context` lines around changes. */
export function unifiedDiff(a: string, b: string, path = 'file', context = 3): string {
  const lines = diffLines(a, b);
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].op === ' ') {
      i++;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    // extend the hunk while changes are within 2*context of each other
    let k = i;
    while (k < lines.length) {
      if (lines[k].op !== ' ') {
        end = k;
        k++;
        continue;
      }
      let run = 0;
      while (k + run < lines.length && lines[k + run].op === ' ') run++;
      if (k + run >= lines.length || run > context * 2) break;
      k += run;
    }
    const stop = Math.min(lines.length, end + context + 1);
    let aLine = 1;
    let bLine = 1;
    for (let q = 0; q < start; q++) {
      if (lines[q].op !== '+') aLine++;
      if (lines[q].op !== '-') bLine++;
    }
    const hunk = lines.slice(start, stop);
    const aLen = hunk.filter((l) => l.op !== '+').length;
    const bLen = hunk.filter((l) => l.op !== '-').length;
    out.push(`@@ -${aLine},${aLen} +${bLine},${bLen} @@`);
    for (const l of hunk) out.push(l.op + l.text);
    i = stop;
  }
  return out.join('\n');
}
