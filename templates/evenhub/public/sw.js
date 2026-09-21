// <NAME> service worker.
//
// Minimal pass-through, same shape as claude-hub's own: it exists so the phone
// treats the companion page as installable, and it deliberately caches
// nothing. This page is a live view onto a dev server behind a reverse proxy —
// a cache here would serve yesterday's bundle to the glasses and look like a
// code bug. Add real caching only once the app has offline behaviour worth
// keeping, and version the cache when you do.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Intentionally empty — fall through to default network handling.
});
