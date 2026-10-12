// Tiny history-API router: no dependency, enough for a dozen pages.
import { createContext, useContext, useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

const RouteCtx = createContext<{ path: string; search: string; hash: string }>({ path: '/', search: '', hash: '' });

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new Event('bb-nav'));
  if (!to.includes('#')) window.scrollTo(0, 0);
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const read = () => ({ path: location.pathname, search: location.search, hash: location.hash });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener('popstate', on);
    window.addEventListener('bb-nav', on);
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('bb-nav', on);
      window.removeEventListener('hashchange', on);
    };
  }, []);
  return <RouteCtx.Provider value={loc}>{children}</RouteCtx.Provider>;
}

export function useLocation() {
  return useContext(RouteCtx);
}

export function useQueryParam(name: string): string | null {
  return new URLSearchParams(useLocation().search).get(name);
}

/** Matches `/s/:id` style patterns. Returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const a = path.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) out[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return out;
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} {...rest} onClick={onClick}>
      {children}
    </a>
  );
}
