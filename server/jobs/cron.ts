// Tiny 5-field cron matcher: minute hour day-of-month month day-of-week, with `*`, lists, ranges, steps
// and 3-letter month/day names. Day-of-month and day-of-week OR together when both are restricted (as in cron).

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function field(src: string, min: number, max: number, names?: string[], nameBase = 0): Set<number> {
  const out = new Set<number>();
  const val = (s: string) => {
    const i = names?.indexOf(s.toLowerCase()) ?? -1;
    if (i >= 0) return i + nameBase;
    if (!/^\d+$/.test(s)) throw new Error(`bad value '${s}'`);
    const n = Number(s);
    if (n < min || n > max) throw new Error(`'${s}' is out of range ${min}-${max}`);
    return n;
  };
  for (const part of src.split(',')) {
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad field '${part}'`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`bad step in '${part}'`);
    let lo: number;
    let hi: number;
    if (m[1] === '*') [lo, hi] = [min, max];
    else if (m[1].includes('-')) {
      const [a, b] = m[1].split('-');
      [lo, hi] = [val(a), val(b)];
      if (lo > hi) throw new Error(`bad range '${m[1]}'`);
    } else {
      lo = val(m[1]);
      hi = m[2] ? max : lo;
    }
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

/** Throws with a readable message on a bad expression. */
export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron needs 5 fields: minute hour day-of-month month day-of-week');
  const dow = field(f[4], 0, 7, DAYS);
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute: field(f[0], 0, 59),
    hour: field(f[1], 0, 23),
    dom: field(f[2], 1, 31),
    month: field(f[3], 1, 12, MONTHS, 1),
    dow,
    domAny: f[2] === '*',
    dowAny: f[4] === '*',
  };
}

function dayMatches(c: Cron, d: Date): boolean {
  if (!c.month.has(d.getMonth() + 1)) return false;
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

/** True when the cron fires in the (local time) minute containing `d`. */
export function cronMatches(cron: Cron | string, d: Date): boolean {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  return c.minute.has(d.getMinutes()) && c.hour.has(d.getHours()) && dayMatches(c, d);
}

/** Next firing time strictly after `from` (within ~4 years), or null. */
export function nextRun(cron: Cron | string, from = new Date()): Date | null {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 4 * 366 * 86400_000;
  while (d.getTime() < limit) {
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else return d;
  }
  return null;
}
