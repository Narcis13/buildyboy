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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
