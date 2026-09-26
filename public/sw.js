/* GymApp service worker — caches the app shell for instant/offline launch.
   Supabase (auth + data) is cross-origin and always goes to the network.
   RELEASE STEP: bump the version below on every deploy so all installed
   apps detect the change and auto-refresh to the new version. */
const CACHE = 'gymapp-v9';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest',
  '/icon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Only handle our own static files. Supabase / CDN calls pass straight through.
  if (url.origin !== self.location.origin) return;

  // App shell: cache-first for instant/offline launch, refresh in background.
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
