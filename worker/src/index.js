// Writer A — Cloudflare Worker. Cron "*/20 * * * *" (snapshot) and "5-59/20 * * * *" (push).
// Serves /api/snapshot.json from KV and the PWA from static assets. Heavy math stays in Writer B and the browser:
// this Worker re-fetches live ESPN state (2–3 calls) and merges it onto the newest full snapshot (lightRefresh),
// falling back to a team-level full build only when no full snapshot exists anywhere.
import { lightRefresh, buildSnapshot } from '../../core/snapshot.js';
import { slateDateET } from '../../core/normalize.js';
import { sendPush } from './push.js';

const PAGES = 'https://benjaminkorzep-rgb.github.io/STORMYS_LABORATORY_THE_ODDS_API_KEY/data/latest.json';
const RAW = 'https://raw.githubusercontent.com/benjaminkorzep-rgb/STORMYS_LABORATORY_THE_ODDS_API_KEY/snapshot-data/latest.json';
const SUPABASE = 'https://doojcjhztpxacnuyqitm.supabase.co/storage/v1/object/public/snapshots/latest.json';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
const json = (body, extra = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'max-age=60', ...CORS, ...extra } });
const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast'; // checked against the account's model list at deploy; any failure → rules text

async function getJSON(url, ms = 6000) { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms), cf: { cacheTtl: 30 } }); return r.ok ? await r.json() : null; } catch { return null; } }


// Day-1 tests T1/T4 run from Cloudflare egress: one request per host variant, at most once an hour.
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PROBES = [
  ['espn site.api scoreboard', 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'],
  ['espn site.web.api scoreboard', 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'],
  ['espn cdn scoreboard', 'https://cdn.espn.com/core/nba/scoreboard?xhr=1'],
  ['espn site.api summary', 'SUMMARY'],
  ['cdn.nba.com todaysScoreboard', 'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json'],
];
export async function probe(env) {
  const out = { at: new Date().toISOString(), colo: null, results: [] };
  let eventId = null;
  for (const [name, u0] of PROBES) {
    const u = u0 === 'SUMMARY' ? (eventId ? `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}` : null) : u0;
    if (!u) { out.results.push({ name, status: 'skipped (no event id)' }); continue; }
    const t0 = Date.now();
    try {
      const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json', 'accept-language': 'en-US,en;q=0.9', referer: 'https://www.nba.com/', origin: 'https://www.nba.com' }, signal: AbortSignal.timeout(8000) });
      const txt = await r.text();
      if (!eventId && /scoreboard/.test(u) && r.ok) { try { eventId = JSON.parse(txt).events?.[0]?.id || null; } catch {} }
      out.results.push({ name, url: u, status: r.status, bytes: txt.length, ms: Date.now() - t0, cfRay: r.headers.get('cf-ray'), server: r.headers.get('server') });
    } catch (e) { out.results.push({ name, url: u, status: 'error', error: String(e.message || e), ms: Date.now() - t0 }); }
  }
  await env.SNAP.put('probe', JSON.stringify(out));
  return out;
}

export async function refresh(env, { trigger = 'cron' } = {}) {
  const now = new Date();
  const [kvPrev, pages, raw, supa] = await Promise.all([env.SNAP.get('latest', 'json'), getJSON(PAGES), getJSON(RAW), getJSON(SUPABASE)]);
  const fulls = [kvPrev, pages, raw, supa].filter(s => s && s.schemaVersion === 2 && s.games?.some(g => g.analysis));
  // Prefer a base built with player data (Writer B's daily.json), then the newest analysis.
  const today = slateDateET(now);
  const rich = s => (s.slateDate === today ? 2 : 0) + (s.games.some(g => g.analysis?.players?.length) ? 1 : 0);
  const at = s => String(s.source?.analysisFrom?.generatedAt || s.generatedAt);
  const base = fulls.sort((a, b) => rich(b) - rich(a) || at(b).localeCompare(at(a)))[0] || null;
  let snap;
  if (base && base.slateDate === slateDateET(now)) snap = await lightRefresh({ base, prev: kvPrev || base, now, writer: 'worker' });
  else snap = await buildSnapshot({ writer: 'worker', prev: kvPrev, now, maxSummaries: 6, daily: (await getJSON(RAW.replace('latest.json', 'daily.json'))) || (await getJSON(PAGES.replace('latest.json', 'daily.json'))) });
  snap.source.trigger = trigger;
  // Workers-AI polish removed 2026-11-22: in production it invented figures (e.g. a game not on the slate). Rules text only.
  snap.narrative.source = 'rules';
  const hhmm = now.toISOString().slice(11, 16).replace(':', '');
  const body = JSON.stringify(snap);
  await env.SNAP.put('latest', body);                                   // 3 KV writes per run → 216/day (limit 1,000)
  await env.SNAP.put('latest:' + snap.slateDate, body, { expirationTtl: 60 * 86400 });
  const runs = (await env.SNAP.get('runs', 'json')) || [];
  runs.push({ writer: 'worker', trigger, generatedAt: snap.generatedAt, status: snap.source.status, games: snap.games.length, base: snap.source.analysisFrom || null, hist: `${snap.slateDate}/${hhmm}` });
  await env.SNAP.put('runs', JSON.stringify(runs.slice(-500)));
  return snap;
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === '5-59/20 * * * *') { ctx.waitUntil(sendPush(env)); return; }
    ctx.waitUntil(refresh(env, { trigger: 'cron:' + event.cron }));
    if (new Date(event.scheduledTime).getUTCMinutes() < 20) ctx.waitUntil(probe(env));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/api/snapshot.json') return json((await env.SNAP.get('latest')) || '{"schemaVersion":2,"games":[],"error":"no snapshot yet"}');
    if (url.pathname.startsWith('/api/snapshot/')) return json((await env.SNAP.get('latest:' + url.pathname.split('/').pop().replace('.json', ''))) || '{"error":"not found"}');
    if (url.pathname === '/api/probe') return json((await env.SNAP.get('probe')) || '{"error":"probe not run yet"}');
    if (url.pathname === '/api/runs.json') return json((await env.SNAP.get('runs')) || '[]');
    if (url.pathname === '/api/health') { const s = await env.SNAP.get('latest', 'json'); return json({ ok: !!s, generatedAt: s?.generatedAt, ageMin: s ? Math.round((Date.now() - new Date(s.generatedAt)) / 60000) : null, stale: !s || (Date.now() - new Date(s.generatedAt)) > 60 * 60000, calls: s?.source?.calls?.map(c => ({ name: c.name, status: c.status, ms: c.ms })) }); }
    if (url.pathname === '/refresh') {
      if (!env.REFRESH_KEY || url.searchParams.get('key') !== env.REFRESH_KEY) return json({ error: 'bad key' }, { status: 403 });
      const s = await refresh(env, { trigger: 'external' }); return json({ ok: true, generatedAt: s.generatedAt, games: s.games.length, status: s.source.status });
    }
    if (url.pathname === '/push/vapid') return json({ publicKey: env.VAPID_PUBLIC || null });
    if (url.pathname === '/push/subscribe' && req.method === 'POST') {
      const body = await req.json().catch(() => null); const sub = body?.subscription || body;
      if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint)) return json({ error: 'invalid subscription' }, { status: 400 });
      const id = btoa(sub.endpoint).replace(/[^a-z0-9]/gi, '').slice(-40);
      await env.SNAP.put('sub:' + id, JSON.stringify({ endpoint: sub.endpoint, at: new Date().toISOString() }), { expirationTtl: 90 * 86400 });
      return json({ ok: true, id });
    }
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return Response.redirect(PAGES.replace('data/latest.json', '') + url.pathname.replace(/^\//, '') + url.search, 302);
  },
};
