// Buildyboy service worker: app-shell cache (network first), Web Push with Allow/Deny actions.
const CACHE = 'bb-shell-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && (url.pathname.startsWith('/assets/') || e.request.mode === 'navigate')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request.mode === 'navigate' ? '/' : e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request.mode === 'navigate' ? '/' : e.request).then((r) => r || Response.error())),
  );
});

self.addEventListener('push', (e) => {
  let n = {};
  try {
    n = e.data ? e.data.json() : {};
  } catch {
    n = { title: 'Buildyboy', body: e.data ? e.data.text() : '' };
  }
  const actions = n.actionToken ? [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }] : [];
  e.waitUntil(
    self.registration.showNotification(n.title || 'Buildyboy', {
      body: n.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: n.actionId || n.sessionId || undefined,
      renotify: true,
      data: n,
      actions,
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  const n = e.notification.data || {};
  e.notification.close();
  if ((e.action === 'allow' || e.action === 'deny') && n.actionToken) {
    e.waitUntil(
      fetch('/api/push/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: n.actionToken, decision: e.action }) }).catch(() => {}),
    );
    return;
  }
  const target = n.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate(target).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
