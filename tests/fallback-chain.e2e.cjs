// D5 proof: the PWA's load chain under failure. Serves site/ on localhost, blocks every external host
// (Worker, raw.githubusercontent, Supabase, ESPN), then: good snapshot -> malformed JSON -> all writers
// down (IndexedDB copy) -> browser offline (service-worker shell + IndexedDB).
// Usage: node tests/fallback-chain.e2e.cjs <snapshot.json>
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..', 'site');
const SNAP = fs.readFileSync(process.argv[2]);
let mode = 'ok';
const T = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  if (p === '/data/latest.json') {
    if (mode === 'ok') { r.writeHead(200, { 'content-type': 'application/json' }); return r.end(SNAP); }
    if (mode === 'malformed') { r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{"schemaVersion":2,"games":[{"id":'); }
    r.writeHead(503); return r.end();
  }
  const f = path.join(ROOT, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': T[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
}).listen(8788);

(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(u => !u.href.startsWith('http://localhost:8788'), rt => rt.abort());
  const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(String(e)));
  const state = async () => {
    await pg.waitForTimeout(5000);
    const badge = (await pg.textContent('#bSource').catch(() => 'n/a') || '').trim();
    const text = await pg.evaluate(() => document.body.innerText).catch(() => '');
    return { badge, gamesShown: (text.match(/to win/g) || []).length, statusLabel: /priors — backtest pending/.test(text) };
  };
  const out = [];
  await pg.goto('http://localhost:8788/'); out.push(['1 same-origin snapshot; Worker/raw/Supabase/ESPN blocked', await state()]);
  await pg.reload(); await pg.waitForTimeout(2000);
  const sw = await pg.evaluate(() => (navigator.serviceWorker.controller ? 'controlling' : 'not controlling'));
  mode = 'malformed'; await pg.reload(); out.push(['2 only writer returns malformed JSON', await state()]);
  mode = 'down'; await pg.reload(); out.push(['3 all writers down -> IndexedDB copy', await state()]);
  await ctx.setOffline(true);
  try { await pg.reload(); } catch (e) { out.push(['reload error', String(e).slice(0, 120)]); }
  out.push(['4 browser offline -> service worker shell + IndexedDB', await state()]);
  out.push(['service worker', sw], ['uncaught page errors', errs.length ? errs.slice(0, 3) : 'none']);
  await pg.screenshot({ path: path.join(__dirname, '..', 'docs', 'd5-offline.png') });
  console.log(JSON.stringify(out, null, 1));
  await b.close(); srv.close();
})();
