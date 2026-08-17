/* App-shell cache so MouseFlow opens as an installed app even offline.
 * Only same-origin GETs are touched - agent traffic on 127.0.0.1 must never
 * be cached or intercepted.
 */

const CACHE = 'mouseflow-v2';

const SHELL = [
  '.',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // leave the agent alone

  // Network-first for everything, cache as the offline fallback.
  //
  // The tempting alternative is cache-first (or stale-while-revalidate) for static assets,
  // but index.html references app.js and app.css by unversioned URL: serving a fresh
  // document alongside a one-deploy-old script is a real failure mode, not a theoretical
  // one. The whole shell is a few tens of KB, so there is nothing to win by racing the
  // network. Offline still works - every successful response is cached below.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
