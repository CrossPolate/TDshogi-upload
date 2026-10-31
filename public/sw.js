/* TDShogi Service Worker：静态资源缓存 + 离线兜底。不缓存 API / WS。 */
'use strict';

const CACHE = 'tdshogi-shell-v1.7';
const SHELL = [
  '/app.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/css/style.css',
  '/css/motion.css',
  '/css/theme-pro.css',
  '/css/layout-pro.css',
  '/css/board.css',
  '/css/review.css',
  '/js/app.bundle.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u)))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r && r.ok) {
          const cache = await caches.open(CACHE);
          cache.put('/app.html', r.clone()).catch(() => {});
        }
        return r;
      } catch (_) {
        return (await caches.match('/app.html')) || (await caches.match('/offline.html')) || new Response('离线', { status: 503 });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const isShell = url.pathname === '/app.html' || url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/');
    // 代码/样式必须 network-first：否则升级后 SW 会一直拿旧 bundle，用户看不到新版本。
    if (isShell) {
      try {
        const r = await fetch(req);
        if (r && r.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, r.clone()).catch(() => {});
        }
        return r;
      } catch (_) {
        return (await caches.match(req)) || new Response('离线', { status: 503 });
      }
    }
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const r = await fetch(req);
      if (r && r.ok && (url.pathname.startsWith('/icons/') || url.pathname.startsWith('/pieces/') || url.pathname.startsWith('/sound/') || url.pathname.startsWith('/engine/'))) {
        const cache = await caches.open(CACHE);
        cache.put(req, r.clone()).catch(() => {});
      }
      return r;
    } catch (_) {
      return new Response('离线', { status: 503 });
    }
  })());
});
