// Service worker: makes the game work offline after the first visit.
// Assets are cached on first use (cache-first); the app shell is network-first so updates arrive.
const CACHE = 'pitdroids-v1';

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  // old versions of this cache go; the installed data pack ('pitdroids-data') stays
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('pitdroids-v') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isAsset = url.pathname.includes('/assets/') || url.pathname.includes('/mods/');
  if (isAsset) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok && r.status === 200) c.put(e.request, r.clone());
      return r;
    }));
  } else {
    e.respondWith(fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request)));
  }
});
