import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './lib/api.ts';
import { Link, match, navigate, useLocation } from './lib/router.tsx';
import { useLiveStream } from './lib/sse.ts';
import { AttentionBar } from './components/AttentionBar.tsx';
import { Login } from './pages/Login.tsx';

const Floor = lazy(() => import('./pages/Floor.tsx'));
const Session = lazy(() => import('./pages/Session.tsx'));
const Inbox = lazy(() => import('./pages/Inbox.tsx'));
const Composer = lazy(() => import('./pages/Composer.tsx'));
const Jobs = lazy(() => import('./pages/Jobs.tsx'));
const Machines = lazy(() => import('./pages/Machines.tsx'));
const Settings = lazy(() => import('./pages/Settings.tsx'));
const Projects = lazy(() => import('./pages/Projects.tsx'));
const Analytics = lazy(() => import('./pages/Analytics.tsx'));
const Search = lazy(() => import('./pages/Search.tsx'));

/** Route table. Pages are default exports taking their URL params as props. */
const routes: [string, (p: Record<string, string>) => ReactNode][] = [
  ['/', () => <Floor />],
  ['/s/:id', (p) => <Session id={p.id} />],
  ['/inbox', () => <Inbox />],
  ['/composer', () => <Composer />],
  ['/composer/:promptId', (p) => <Composer promptId={p.promptId} />],
  ['/jobs', () => <Jobs />],
  ['/jobs/:id', (p) => <Jobs id={p.id} />],
  ['/machines', () => <Machines />],
  ['/settings', () => <Settings />],
  ['/projects', () => <Projects />],
  ['/projects/:id', (p) => <Projects id={p.id} />],
  ['/analytics', () => <Analytics />],
  ['/search', () => <Search />],
];

const NAV: { to: string; label: string; icon: string; phone?: boolean }[] = [
  { to: '/', label: 'Floor', icon: '▦', phone: true },
  { to: '/inbox', label: 'Inbox', icon: '✉', phone: true },
  { to: '/composer', label: 'Composer', icon: '✎', phone: true },
  { to: '/jobs', label: 'Jobs', icon: '⚙', phone: true },
  { to: '/machines', label: 'Machines', icon: '🖧' },
  { to: '/projects', label: 'Projects', icon: '▤' },
  { to: '/analytics', label: 'Insights', icon: '📈' },
  { to: '/search', label: 'Search', icon: '⌕' },
  { to: '/settings', label: 'Settings', icon: '⚑', phone: true },
];

function isActive(to: string, path: string) {
  return to === '/' ? path === '/' || path.startsWith('/s/') : path.startsWith(to);
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('bb-theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);
  return (
    <button aria-label="Toggle theme" className="min-h-11 min-w-11 rounded-lg text-muted hover:text-ink" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
      {theme === 'dark' ? '☾' : '☀'}
    </button>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { path } = useLocation();
  const { data: inbox } = useQuery({ queryKey: ['attention'], queryFn: () => api.get<{ pending: number }>('/api/attention') });
  return (
    <div className="flex min-h-dvh flex-col">
      <AttentionBar />
      <header className="hidden items-center gap-1 border-b border-line bg-bg-2 px-4 md:flex">
        <Link to="/" className="mr-4 flex min-h-12 items-center gap-2 font-semibold tracking-widest">
          <img src="/icon.svg" alt="" className="h-7 w-7" /> BUILDYBOY
        </Link>
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className={`relative flex min-h-12 items-center px-3 text-[15px] ${isActive(n.to, path) ? 'text-ink shadow-[inset_0_-2px_0_var(--bb-accent)]' : 'text-muted hover:text-ink'}`}>
            {n.label}
            {n.to === '/inbox' && !!inbox?.pending && <span className="ml-1.5 rounded-full bg-waiting px-1.5 text-xs font-bold text-[#1d1300]">{inbox.pending}</span>}
          </Link>
        ))}
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 pb-24 pt-4 md:pb-8">{children}</main>
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-bg-2/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label="Main">
        {NAV.filter((n) => n.phone).map((n) => (
          <Link key={n.to} to={n.to} className={`relative flex min-h-14 flex-1 flex-col items-center justify-center text-xs ${isActive(n.to, path) ? 'text-accent' : 'text-muted'}`}>
            <span className="text-lg leading-none">{n.icon}</span>
            {n.label}
            {n.to === '/inbox' && !!inbox?.pending && <span className="absolute right-[22%] top-1.5 rounded-full bg-waiting px-1.5 text-[11px] font-bold text-[#1d1300]">{inbox.pending}</span>}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function App() {
  const { path } = useLocation();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<{ authenticated: boolean; setupRequired: boolean }>('/api/me'), staleTime: 60_000 });
  useLiveStream(!!me.data?.authenticated);

  useEffect(() => {
    const on = () => qc.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener('bb-unauthorized', on);
    return () => window.removeEventListener('bb-unauthorized', on);
  }, [qc]);

  if (me.isLoading) return <div className="bb-grid min-h-dvh" />;
  if (path === '/setup') return <Login setup />;
  if (!me.data?.authenticated) {
    if (me.data?.setupRequired && path !== '/login') return <Login setup />;
    return <Login />;
  }
  if (path === '/login') {
    navigate('/', true);
    return null;
  }

  let page: ReactNode = <div className="text-muted">Not found. <Link to="/" className="text-accent underline">Back to the floor</Link></div>;
  for (const [pattern, render] of routes) {
    const params = match(pattern, path);
    if (params) {
      page = render(params);
      break;
    }
  }
  return (
    <Shell>
      <Suspense fallback={<div className="p-6 text-muted">Loading…</div>}>{page}</Suspense>
    </Shell>
  );
}
