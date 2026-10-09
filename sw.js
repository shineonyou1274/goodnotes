// 오프라인에서도 앱이 열리도록 파일을 저장해 둔다
const VERSION = 'v10';
const CACHE = `goodnotes-web-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/db.js',
  './js/model.js',
  './js/ink.js',
  './js/render.js',
  './js/view.js',
  './js/editor.js',
  './js/library.js',
  './js/pdf.js',
  './js/backup.js',
  './js/util.js',
  './js/icons.js',
  './js/settings.js',
  './js/cloud.js',
  './js/cloud-ui.js',
  './js/tasks.js',
  './setup.html',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('goodnotes-web-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 네트워크를 먼저 쓰고, 안 되면 저장해 둔 파일을 쓴다 (PDF 라이브러리는 한 번 받으면 저장해 둔다)
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isVendor = req.url.includes('/vendor/');
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isVendor) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return cache.match('./index.html');
      throw err;
    }
  })());
});
