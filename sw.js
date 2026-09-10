const CACHE = 'my-diary-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/legacy.html',
  '/vendor/journal-app.js',
  '/src/journal/styles.css',
  '/src/app.js',
  '/src/model.js',
  '/src/storage.js',
  '/src/google.js',
  '/src/sync.js',
  '/src/weather.js',
  '/src/backup.js',
  '/src/notifications.js',
  '/src/styles.css',
  '/vendor/fflate.js',
  '/config.json',
  '/manifest.webmanifest',
  '/assets/icon.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
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
  if (url.pathname === '/src/keep-probe.html') return;
  if (event.request.mode === 'navigate') {
    // Serve HTML and modules from the same version until the next worker activates.
    event.respondWith(
      caches
        .open(CACHE)
        .then(
          async (cache) =>
            (await cache.match(url.pathname === '/legacy.html' ? '/legacy.html' : '/index.html')) ||
            fetch(event.request),
        ),
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
self.addEventListener('push', (event) => {
  let message;
  try {
    message = event.data?.json();
  } catch {
    message = null;
  }
  message ||= { title: 'My Diary', body: '기억하고 싶은 순간을 남겨보세요.' };
  const url = new URL(message.url || '/', self.location.origin);
  event.waitUntil(
    self.registration.showNotification(message.title || 'My Diary', {
      body: message.body || '',
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      tag: message.tag || 'my-diary',
      data: { url: url.origin === self.location.origin ? url.href : self.location.origin },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.location.origin;
  event.waitUntil(self.clients.openWindow(url));
});
