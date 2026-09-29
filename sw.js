const CACHE = 'my-diary-shell-v1';
self.addEventListener('message', (event) => {
  if (event.data?.type === 'DIARY_VERSION')
    event.ports[0]?.postMessage({ version: CACHE.replace('my-diary-shell-', '') });
});
const SHELL = [
  '/',
  '/index.html',
  '/vendor/journal-app.js',
  '/src/journal/styles.css',
  '/config.json',
  '/manifest.webmanifest',
  '/assets/icon.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith('my-diary-shell-') && key !== CACHE)
              .map((key) => caches.delete(key)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only application assets are cached, never OAuth tokens or third-party API responses.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    // Serve HTML and modules from the same version until the next worker activates.
    event.respondWith(
      caches
        .open(CACHE)
        .then(async (cache) => (await cache.match('/index.html')) || fetch(event.request)),
    );
    return;
  }
  if (!SHELL.includes(url.pathname)) return;
  event.respondWith(
    caches
      .open(CACHE)
      .then(async (cache) => (await cache.match(event.request)) || fetch(event.request)),
  );
});
