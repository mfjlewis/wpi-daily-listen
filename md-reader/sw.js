/* MD Reader service worker: offline cache + Android "share to" target. */
const VERSION = 'mdr-v5';
const ASSETS = [
  './', './index.html', './app.css', './app.js', './manifest.webmanifest',
  './vendor/marked.min.js', './vendor/purify.min.js', './vendor/docx.min.js', './vendor/html2pdf.bundle.min.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== VERSION && k !== 'mdr-share-inbox').map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Android share sheet → MD Reader
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const file = form.get('file');
      let body = '', name = 'Shared.md';
      if (file && typeof file !== 'string') { body = await file.text(); name = file.name || name; }
      else { body = form.get('text') || ''; name = (form.get('title') || 'Shared') + '.md'; }
      const inbox = await caches.open('mdr-share-inbox');
      await inbox.put('shared-file', new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Filename': encodeURIComponent(name) } }));
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // stale-while-revalidate: instant + offline, updates arrive on next launch
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const req = e.request.mode === 'navigate' ? './index.html' : e.request;
    const hit = await cache.match(req, { ignoreSearch: e.request.mode === 'navigate' });
    const net = fetch(e.request).then(res => {
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => hit);
    return hit || net;
  })());
});
