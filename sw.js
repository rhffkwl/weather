/* 하늘 날씨 service worker: offline app shell + last API responses */
const VERSION = 'v7';
const SHELL = `shell-${VERSION}`, DATA = 'data-v1';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
const API_HOSTS = ['api.open-meteo.com', 'air-quality-api.open-meteo.com', 'geocoding-api.open-meteo.com', 'api.bigdatacloud.net'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (API_HOSTS.includes(url.hostname)) {
    // network first, fall back to last cached response
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || Response.error())));
    return;
  }
  if (url.origin === self.location.origin && url.pathname.includes('/data/')) {
    // live data (data/airkorea.json): always network first, never serve a stale copy while online
    const key = new Request(url.origin + url.pathname);
    e.respondWith(fetch(req, { cache: 'no-store' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key).then(r => r || Response.error())));
    return;
  }
  if (url.origin === self.location.origin) {
    // stale-while-revalidate for the app shell
    e.respondWith(caches.open(SHELL).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await c.match('index.html') : null);
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || (req.mode === 'navigate' ? c.match('index.html') : Response.error());
    }));
  }
});
