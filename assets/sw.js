// claude-hub service worker.
// Minimal pass-through: required for PWA installability. No caching — every
// page under this proxy is dynamic (terminals, file views, proxied dev
// servers), so a cache would lie. The fetch listener exists solely so Chrome
// treats the app as installable.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Intentionally empty — fall through to default network handling.
});
