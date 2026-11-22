// Service worker: offline shell + last snapshot cache (fallback layer 5), and Web Push display.
// Network-first for data (tags cached replies with X-SW-Cache: offline), cache-first for the app shell.
const VER = 'v1';
const SHELL = `shell-${VER}`, DATA = `data-${VER}`;
const SHELL_FILES = ['./', './index.html', './app.js', './sources.js', './styles.css', './manifest.json', './config.json', './sim-worker.js',
  './core/engine/sim.js', './core/engine/market.js', './core/engine/math.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => ![SHELL, DATA].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
const isData = u => /\/api\/snapshot|latest\.json|daily\.json|espn\.com/.test(u);
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = req.url;
  if (isData(url)) {
    e.respondWith(fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(DATA).then(c => c.put(url, copy)); } return res; })
      .catch(async () => { const hit = await caches.open(DATA).then(c => c.match(url)); if (!hit) return new Response('{"error":"offline"}', { status: 503, headers: { 'content-type': 'application/json' } });
        const h = new Headers(hit.headers); h.set('X-SW-Cache', 'offline'); return new Response(await hit.blob(), { status: 200, headers: h }); }));
    return;
  }
  if (new URL(url).origin === self.location.origin) e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok) { const c = res.clone(); caches.open(SHELL).then(x => x.put(req, c)); } return res; })));
});
// Empty-payload push (no encryption): fetch the newest snapshot and show its newest critical alert.
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let title = 'NBA Matchup Lab', body = 'New alert on tonight’s slate.';
    try {
      const cfg = await (await fetch('./config.json')).json();
      const s = await (await fetch((cfg.workerUrl || '').replace(/\/+$/, '') + '/api/snapshot.json', { cache: 'no-store' })).json();
      const a = (s.alerts || []).filter(x => x.severity === 'crit').slice(-1)[0] || (s.alerts || []).slice(-1)[0];
      if (a) { title = a.title || title; body = a.text || a.message || body; }
    } catch {}
    await self.registration.showNotification(title, { body, icon: './icons/icon-192.png', badge: './icons/icon-192.png', data: { url: './#alerts' } });
  })());
});
self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil(clients.openWindow(e.notification.data?.url || './')); });
