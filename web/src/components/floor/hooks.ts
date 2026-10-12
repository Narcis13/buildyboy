import { useEffect, useRef, useState } from 'react';

/** Current time, re-rendered every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const fn = () => setOn(m.matches);
    fn();
    m.addEventListener('change', fn);
    return () => m.removeEventListener('change', fn);
  }, [query]);
  return on;
}

export const isPhoneQuery = '(max-width: 767px)';

/** Keeps items that just disappeared around for `ms` with `leaving: true`, so they can fade out. */
export function useLeaving<T>(items: T[], key: (t: T) => string, ms = 1400): (T & { leaving?: boolean })[] {
  const [ghosts, setGhosts] = useState<T[]>([]);
  const prev = useRef<T[]>(items);
  const sig = items.map(key).join('|');
  useEffect(() => {
    const ids = new Set(items.map(key));
    const gone = prev.current.filter((p) => !ids.has(key(p)));
    prev.current = items;
    if (!gone.length) return;
    setGhosts((g) => [...g, ...gone]);
    setTimeout(() => setGhosts((g) => g.filter((x) => !gone.includes(x))), ms);
  }, [sig]);
  const ids = new Set(items.map(key));
  return [...items.map((i) => ({ ...i, leaving: false })), ...ghosts.filter((g) => !ids.has(key(g))).map((g) => ({ ...g, leaving: true }))];
}

export function readStore<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStore(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // storage unavailable: positions just aren't remembered
  }
}
