import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from './lib/router.tsx';
import { App } from './App.tsx';
import './index.css';
import '@xyflow/react/dist/style.css';

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: (n, err) => n < 2 && (err as { status?: number }).status !== 401 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <RouterProvider>
        <App />
      </RouterProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// A tab opened before a deploy still names the previous build's chunks, which are gone. Reload once to pick up the new
// build instead of leaving the page blank; the timestamp guard stops a loop if the chunk is missing for another reason.
window.addEventListener('vite:preloadError', (e) => {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem('bb-chunk-reload')) || 0;
  } catch {}
  if (Date.now() - last < 30_000) return;
  try {
    sessionStorage.setItem('bb-chunk-reload', String(Date.now()));
  } catch {}
  e.preventDefault();
  location.reload();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
