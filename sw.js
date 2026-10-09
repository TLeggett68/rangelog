/*
 * Service worker: keeps a copy of the site on the phone so it still opens at
 * the range with weak or no signal. (Data syncing is handled separately by
 * Firestore's own offline cache.)
 *
 * - Site files: try the network first so updates show up right away; if the
 *   network is slow (3 s) or offline, use the saved copy. GitHub Pages tells
 *   browsers to reuse files for 10 minutes, so ask the server every time
 *   (cache: 'no-cache' — a quick "has this changed?" check).
 * - Fonts and the Firebase library: use the saved copy (they never change).
 * - Everything else (the Firestore database itself) is not touched.
 */
const CACHE = 'rangelog-v4';
const SHELL = [
  './', 'index.html', 'css/style.css',
  'js/version.js', 'js/config.js', 'js/store.js', 'js/target.js', 'js/stage.js', 'js/ballistics.js', 'js/app.js',
  'manifest.webmanifest', 'icons/icon-192.png',
];
const STATIC_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(networkFirst(req));
  else if (STATIC_HOSTS.includes(url.hostname)) e.respondWith(cacheFirst(req));
});

function networkFirst(req) {
  return caches.open(CACHE).then(cache => new Promise(resolve => {
    let done = false;
    const finish = res => { if (!done && res) { done = true; resolve(res); } };
    const fromCache = () => cache.match(req, { ignoreSearch: true });
    const timer = setTimeout(() => fromCache().then(finish), 3000);
    // Page loads are "navigate" requests, which some browsers won't copy with new options; fetch by URL.
    const fresh = req.mode === 'navigate'
      ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      : fetch(req, { cache: 'no-cache' });
    fresh
      .then(res => {
        clearTimeout(timer);
        if (res.ok) cache.put(req, res.clone());
        finish(res);
      })
      .catch(() => {
        clearTimeout(timer);
        fromCache().then(res => finish(res || Response.error()));
      });
  }));
}

function cacheFirst(req) {
  return caches.open(CACHE).then(cache => cache.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  })));
}
