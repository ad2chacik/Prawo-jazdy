'use strict';
const CACHE_NAME = 'prawko-shell-gh-v9';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './vendor/jszip.min.js'
];
const SCOPE = new URL(self.registration.scope);
const SHELL_URLS = new Set(SHELL.map(path => new URL(path, SCOPE).href));

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('prawko-shell-') && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;

  // Cache only the application shell. Questions live in IndexedDB;
  // media use browser-native HTTP Range and streaming.
  const navigationTarget = request.mode === 'navigate' &&
    (url.pathname === SCOPE.pathname || url.pathname === new URL('./index.html', SCOPE).pathname);
  if (!SHELL_URLS.has(url.href) && !navigationTarget) return;

  // Extend the event synchronously. Calling waitUntil only after fetch()
  // resolves is too late in Safari and may throw InvalidStateError.
  let finishCacheUpdate;
  event.waitUntil(new Promise(resolve => { finishCacheUpdate = resolve; }));
  event.respondWith(
    fetch(request).then(response => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE_NAME)
          .then(cache => cache.put(request, copy))
          .catch(error => console.warn('PWA cache:', error))
          .finally(finishCacheUpdate);
      } else {
        finishCacheUpdate();
      }
      return response;
    }).catch(async () => {
      finishCacheUpdate();
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const fallback = await caches.match(new URL('./index.html', SCOPE).href);
        if (fallback) return fallback;
      }
      return Response.error();
    })
  );
});
