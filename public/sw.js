// Offline support: everything the app fetches from its own origin is cached on first use
// (including the ~30 MB of OpenCascade WASM). Hashed build assets are served cache-first;
// the page itself is network-first so a new deployment is picked up when online.
const CACHE = 'pcb-maker-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './occt/occt-import-js.js', './occt/occt-import-js.wasm', './occt/occt-import-js-worker.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const isPage = req.mode === 'navigate';
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: isPage });
      const fetched = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      // Page: network first (falls back to cache offline). Assets: cache first.
      return isPage ? fetched.then((r) => r ?? cached) : (cached ?? fetched);
    }),
  );
});
