// NBA Matchup Lab — iPhone-first PWA. Plain ES module, no dependencies, relative URLs only.
// Load order: 1) ESPN direct from the browser  2) snapshot race (Worker / Pages / Supabase, newest generatedAt wins)
//             3) IndexedDB last-good copy  4) service-worker cache when fully offline.
// Never calls window.claude, Firecrawl, or any LLM API.
import { resolveSources, labelFor } from './sources.js';

const STATUS_LINE = 'This engine has not yet been run or backtested. Every number in the spec is a starting prior to be re-estimated by the walk-forward backtest.';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const SB = d => `${ESPN}/scoreboard?dates=${d.replace(/-/g, '')}`;
const SUM = id => `${ESPN}/summary?event=${id}`;
const INJ = `${ESPN}/injuries`;
const TABS = ['slate', 'games', 'players', 'trends', 'changes', 'alerts', 'method', 'health'];
const PARAMS = new URLSearchParams(location.search);
const FIXTURE = PARAMS.has('fixture');
const SERVER_LABELS = new Set(['Worker', 'Pages', 'Supabase']);

// ---------------------------------------------------------------- helpers
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = x => typeof x === 'number' && isFinite(x);
const r1 = (x, d = 1) => (isNum(x) ? (Math.round(x * 10 ** d) / 10 ** d).toFixed(d) : '–');
const pct = (p, d = 0) => (isNum(p) ? (p * 100).toFixed(d) + '%' : '–');
const sgn = (x, d = 1) => (isNum(x) ? (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(d) : '–');
const pp = (x, d = 1) => (isNum(x) ? sgn(x * 100, d) + ' pp' : '–');
const line = x => (isNum(x) ? (x > 0 ? '+' : '') + x : '–');
const fmtET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const slateToday = () => fmtET.format(new Date(Date.now() - 6 * 3600e3));   // board rolls at 6 AM ET
const shiftDay = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const niceDay = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
const etTime = iso => (iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET' : '–');
const etClock = ms => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' ET';
const localTime = (iso, tz) => { try { return new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch { return ''; } };
function ago(ms) {
  if (!isNum(ms)) return '–'; const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`; const m = Math.round(s / 60); if (m < 90) return `${m} min`; const h = m / 60; if (h < 36) return `${h.toFixed(1)} h`; return `${Math.round(h / 24)} d`;
}
const amer = s => { if (s == null) return null; if (/even/i.test(String(s))) return 100; const n = parseFloat(String(s).replace('+', '')); return isFinite(n) && n !== 0 ? n : null; };
const imp = a => (a == null ? null : a < 0 ? -a / (-a + 100) : 100 / (a + 100));
const noVig = (h, a) => { const ph = imp(h), pa = imp(a); return ph == null || pa == null ? null : ph / (ph + pa); };
const num = s => { const n = parseFloat(String(s ?? '').replace(/[ou+]/gi, '')); return isFinite(n) ? n : null; };
const statusCls = s => (/out|susp/i.test(s || '') ? 's-out' : /question|doubt|day|game.time/i.test(s || '') ? 's-q' : 's-p');
const gradeCls = g => (/^A/.test(g || '') ? 'ok' : /^B/.test(g || '') ? 'info' : /^C/.test(g || '') ? 'warn' : 'crit');

async function fetchT(url, ms = 6000, opts = {}) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); const t0 = performance.now();
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal, cache: 'no-cache' });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, bytes: text.length, ms: Math.round(performance.now() - t0), headers: res.headers };
  } catch (e) {
    return { ok: false, status: e.name === 'AbortError' ? 'timeout' : 'network', text: '', bytes: 0, ms: Math.round(performance.now() - t0), error: String(e.message || e) };
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- IndexedDB (last-good snapshot, last-seen statuses)
const IDB = { db: null, status: 'not opened' };
function idbOpen() {
  if (IDB.db) return Promise.resolve(IDB.db);
  return new Promise(res => {
    try {
      const rq = indexedDB.open('nba-matchup-lab', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onsuccess = () => { IDB.db = rq.result; IDB.status = 'ok'; res(IDB.db); };
      rq.onerror = () => { IDB.status = 'error: ' + (rq.error?.message || 'open failed'); res(null); };
    } catch (e) { IDB.status = 'unavailable: ' + e.message; res(null); }
  });
}
async function idbGet(k) { const db = await idbOpen(); if (!db) return null; return new Promise(res => { try { const rq = db.transaction('kv').objectStore('kv').get(k); rq.onsuccess = () => res(rq.result ?? null); rq.onerror = () => res(null); } catch { res(null); } }); }
async function idbSet(k, v) { const db = await idbOpen(); if (!db) return false; return new Promise(res => { try { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(true); tx.onerror = () => res(false); } catch { res(false); } }); }

// ---------------------------------------------------------------- state
const S = {
  config: { snapshotTimeoutMs: 6000 },
  snapshot: null, snap: { label: null, url: null, at: null }, race: [],
  espn: { status: 'not yet', at: null, ms: null, error: null, day: null, games: [] },
  inj: { status: 'not yet', at: null, idx: new Map(), count: 0 },
  summaries: new Map(), sumStatus: new Map(),
  day: slateToday(), followToday: true,
  open: new Set(), factorFilter: new Map(), playerSort: { key: 'proj.pts.mean', dir: -1 }, playerTeam: 'all',
  seenDiff: null, seenAt: null, prevTrendIds: null,
  recomputed: new Map(), simStatus: 'idle',
  sw: { status: 'not registered', reg: null },
  push: { status: '' }, threeX: undefined,
  tab: 'slate', gameSel: null, timers: [],
};

// ---------------------------------------------------------------- ESPN (direct from the browser; CORS *)
function gameFromEspn(ev) {
  const c = ev.competitions?.[0] || {}, st = ev.status?.type || {};
  const side = h => (c.competitors || []).find(t => t.homeAway === h) || {};
  const T = t => ({ id: t.team?.id, abbr: (t.team?.abbreviation || '').toUpperCase(), name: t.team?.shortDisplayName || t.team?.displayName || t.team?.name,
    score: t.score != null && t.score !== '' ? Number(t.score) : null, record: (t.records || [])[0]?.summary || '' });
  const o = (c.odds || [])[0]; let odds = null;
  if (o) {
    const ml = o.moneyline || {}, ps = o.pointSpread || {}, tt = o.total || {};
    odds = { provider: o.provider?.displayName || o.provider?.name || 'Book', details: o.details || null,
      spreadHome: num(ps.home?.close?.line ?? o.spread), total: num(tt.over?.close?.line ?? o.overUnder),
      mlHome: amer(ml.home?.close?.odds ?? o.homeTeamOdds?.moneyLine), mlAway: amer(ml.away?.close?.odds ?? o.awayTeamOdds?.moneyLine),
      open: { spreadHome: num(ps.home?.open?.line), total: num(tt.over?.open?.line), mlHome: amer(ml.home?.open?.odds), mlAway: amer(ml.away?.open?.odds) } };
    odds.noVigHome = noVig(odds.mlHome, odds.mlAway); odds.open.noVigHome = noVig(odds.open.mlHome, odds.open.mlAway);
    odds.books = [{ name: odds.provider, mlHome: odds.mlHome, mlAway: odds.mlAway, spreadHome: odds.spreadHome, total: odds.total, noVigHome: odds.noVigHome }];
    odds.history = [];
  }
  const lp = c.situation?.lastPlay?.probability;
  return { id: String(ev.id), date: ev.date, state: st.state || 'pre', detail: st.shortDetail || '', clock: ev.status?.displayClock, period: ev.status?.period,
    tv: (c.broadcasts || []).flatMap(b => b.names || []).join(', '), neutral: !!c.neutralSite,
    venue: { name: c.venue?.fullName || null, city: c.venue?.address?.city || null }, home: T(side('home')), away: T(side('away')), odds,
    liveWpHome: lp ? lp.homeWinPercentage : null, injuries: [], _espnOnly: true };
}
async function loadEspn(day = S.day) {
  const r = await fetchT(SB(day), 8000);
  S.espn.ms = r.ms;
  if (!r.ok) { S.espn.status = `unreachable (${r.status})`; S.espn.error = r.error || null; return false; }
  try { const j = JSON.parse(r.text); S.espn.games = (j.events || []).map(gameFromEspn); S.espn.day = day; S.espn.at = Date.now(); S.espn.status = 'ok'; S.espn.bytes = r.bytes; return true; }
  catch (e) { S.espn.status = 'bad JSON'; return false; }
}
async function loadInjuries() {
  const r = await fetchT(INJ, 8000);
  if (!r.ok) { S.inj.status = `unreachable (${r.status})`; return false; }
  try {
    const j = JSON.parse(r.text); const idx = new Map(); let n = 0;
    for (const t of j.injuries || []) for (const i of t.injuries || []) {
      const name = i.athlete?.displayName; if (!name) continue; n++;
      idx.set(name, { status: i.status || i.type?.description, detail: [i.details?.type, i.details?.detail].filter(Boolean).join(' – ') || i.shortComment || '', team: t.displayName || '', returnDate: i.details?.returnDate || null });
    }
    S.inj = { status: 'ok', at: Date.now(), idx, count: n }; return true;
  } catch { S.inj.status = 'bad JSON'; return false; }
}
async function loadSummary(id) {
  if (S.sumStatus.get(id) === 'loading' || FIXTURE) return;
  S.sumStatus.set(id, 'loading');
  const r = await fetchT(SUM(id), 8000);
  if (!r.ok) { S.sumStatus.set(id, `unreachable (${r.status})`); return; }
  try {
    const s = JSON.parse(r.text);
    const bpi = s.predictor?.homeTeam?.gameProjection;
    S.summaries.set(id, { at: Date.now(), bpiHome: bpi != null ? Number(bpi) / 100 : null,
      officials: (s.gameInfo?.officials || []).map(o => o.displayName || o.fullName).filter(Boolean),
      injuries: (s.injuries || []).flatMap(t => (t.injuries || []).map(i => ({ team: (t.team?.abbreviation || '').toUpperCase(), name: i.athlete?.displayName, status: i.status, detail: [i.details?.type, i.details?.detail].filter(Boolean).join(' – ') }))),
      last5: Object.fromEntries((s.lastFiveGames || []).map(t => [(t.team?.abbreviation || '').toUpperCase(), (t.events || []).map(e => e.gameResult).join('')])) });
    S.sumStatus.set(id, 'ok'); render();
  } catch { S.sumStatus.set(id, 'bad JSON'); }
}

// ---------------------------------------------------------------- snapshot race (every URL in parallel, 6 s each, newest generatedAt wins)
function validSnap(j) { return j && typeof j === 'object' && Array.isArray(j.games) && j.generatedAt; }
async function raceSnapshots() {
  const sources = FIXTURE ? [{ url: './data/fixture-snapshot.json', label: 'Fixture' }] : resolveSources(S.config);
  const ms = S.config.snapshotTimeoutMs || 6000;
  const rows = await Promise.all(sources.map(async s => {
    const r = await fetchT(s.url, ms);
    const row = { ...s, status: r.status, ms: r.ms, bytes: r.bytes, ok: false, generatedAt: null, swCache: r.headers?.get?.('X-SW-Cache') || null, error: r.error || null };
    if (r.ok) { try { const j = JSON.parse(r.text); if (validSnap(j)) { row.ok = true; row.generatedAt = j.generatedAt; row.data = j; } else row.error = 'not a snapshot'; } catch { row.error = 'bad JSON'; } }
    return row;
  }));
  S.race = rows.map(({ data, ...rest }) => rest);
  const good = rows.filter(r => r.ok).sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
  return good[0] || null;
}

async function acceptSnapshot(snap, label, url) {
  const prev = S.snapshot;
  S.snapshot = snap; S.snap = { label, url, at: Date.now() };
  if (FIXTURE && S.followToday) S.day = snap.slateDate || S.day;
  if (!['on-phone copy', 'offline cache'].includes(label)) await idbSet('snapshot', { snap, label, url, savedAt: Date.now() });
  // trends "new validated / fell apart" fallback when the writer does not provide it
  const ids = new Set((snap.trends?.validated || []).map(t => t.id));
  const before = await idbGet('validatedTrendIds');
  if (before && !snap.trends?.newValidated) S.prevTrendIds = new Set(before);
  if (label !== 'on-phone copy') idbSet('validatedTrendIds', [...ids]);
  if (!prev || prev.generatedAt !== snap.generatedAt) scheduleSim();
}

// ---------------------------------------------------------------- merge ESPN live over the snapshot
function liveMerge(g) {
  const e = S.espn.day === S.day ? S.espn.games.find(x => x.id === g.id) : null;
  const out = { ...g, home: { ...g.home }, away: { ...g.away }, odds: g.odds ? { ...g.odds, history: [...(g.odds.history || [])] } : null, injuries: (g.injuries || []).map(i => ({ ...i })) };
  if (e) {
    out.state = e.state; out.detail = e.detail || out.detail; out.clock = e.clock; out.period = e.period;
    out.home.score = e.home.score; out.away.score = e.away.score; out.liveWpHome = e.liveWpHome; out._espnAt = S.espn.at;
    if (e.tv && !out.tv) out.tv = e.tv;
    if (e.odds && (e.odds.spreadHome != null || e.odds.mlHome != null)) {
      const o = out.odds || { books: [], history: [], open: e.odds.open };
      const changed = o.spreadHome !== e.odds.spreadHome || o.total !== e.odds.total || o.mlHome !== e.odds.mlHome;
      o.snapLine = { spreadHome: o.spreadHome, total: o.total, noVigHome: o.noVigHome ?? noVig(o.mlHome, o.mlAway) };
      Object.assign(o, { spreadHome: e.odds.spreadHome ?? o.spreadHome, total: e.odds.total ?? o.total, mlHome: e.odds.mlHome ?? o.mlHome, mlAway: e.odds.mlAway ?? o.mlAway });
      o.noVigHome = noVig(o.mlHome, o.mlAway) ?? o.noVigHome;
      if (!o.open || o.open.spreadHome == null) o.open = e.odds.open;
      if (changed) { o.history.push({ at: new Date(S.espn.at).toISOString(), spreadHome: o.spreadHome, total: o.total, noVigHome: o.noVigHome, src: 'ESPN live' }); o.liveMoved = true; }
      out.odds = o;
    }
  }
  const sm = S.summaries.get(g.id);
  if (sm) { if (sm.bpiHome != null) out.bpiHome = sm.bpiHome; if (sm.officials?.length && !(out.officials || []).length) out.officials = sm.officials; }
  // league injuries (15 min) override listed statuses
  if (S.inj.idx.size) {
    for (const i of out.injuries) { const x = S.inj.idx.get(i.name); if (x && x.status && x.status !== i.status) { i.prevStatus = i.status; i.status = x.status; i.detail = x.detail || i.detail; i._live = true; } }
    const known = new Set(out.injuries.map(i => i.name));
    for (const p of g.analysis?.players || []) { const x = S.inj.idx.get(p.name); if (x && !known.has(p.name)) out.injuries.push({ team: p.team, name: p.name, id: p.id, status: x.status, detail: x.detail, _live: true }); }
  }
  return out;
}
function currentGames() {
  const snapDayMatch = S.snapshot && (S.snapshot.slateDate === S.day || !S.snapshot.slateDate);
  if (snapDayMatch) {
    const games = S.snapshot.games.map(liveMerge);
    if (S.espn.day === S.day) for (const e of S.espn.games) if (!games.some(g => g.id === e.id)) games.push(e);
    return sortGames(games);
  }
  return S.espn.day === S.day ? sortGames(S.espn.games.map(g => ({ ...g }))) : [];
}
const sortGames = gs => gs.sort((a, b) => (a.state === 'in' ? -1 : 0) - (b.state === 'in' ? -1 : 0) || new Date(a.date) - new Date(b.date));

// ---------------------------------------------------------------- client alerts (carried forward)
function clientAlerts(games) {
  const out = []; const now = Date.now();
  for (const g of games) {
    if (g.state !== 'pre') continue;
    const o = g.odds, nm = `${g.away.abbr} @ ${g.home.abbr}`, id = g.id;
    const mins = (new Date(g.date) - now) / 60000;
    if (mins <= 60 && mins > -5) out.push({ id: `${id}:lock`, gameId: id, severity: 'crit', type: 'lock', text: `${nm}: lineup lock in ${Math.max(0, Math.round(mins))} min` });
    if (o?.open) {
      if (isNum(o.open.spreadHome) && isNum(o.spreadHome) && Math.abs(o.spreadHome - o.open.spreadHome) >= 2) out.push({ id: `${id}:spread`, gameId: id, severity: 'warn', type: 'line', text: `${nm}: spread moved ${line(o.open.spreadHome)} → ${line(o.spreadHome)} (home)` });
      if (isNum(o.open.total) && isNum(o.total) && Math.abs(o.total - o.open.total) >= 3) out.push({ id: `${id}:total`, gameId: id, severity: 'warn', type: 'line', text: `${nm}: total moved ${o.open.total} → ${o.total}` });
      const a = o.open.noVigHome ?? noVig(o.open.mlHome, o.open.mlAway), b = o.noVigHome ?? noVig(o.mlHome, o.mlAway);
      if (isNum(a) && isNum(b) && Math.abs(b - a) >= 0.05) out.push({ id: `${id}:ml`, gameId: id, severity: 'warn', type: 'line', text: `${nm}: home no-vig win chance ${pct(a)} → ${pct(b)} since open` });
    }
    for (const i of g.injuries || []) if (/question|doubt|day-to-day|game.time/i.test(i.status || '')) out.push({ id: `${id}:inj:${i.id || i.name}`, gameId: id, severity: /doubt/i.test(i.status) ? 'crit' : 'warn', type: 'injury', text: `${i.team} ${i.name}: ${i.status}${i.detail ? ` (${i.detail})` : ''}` });
  }
  return out;
}
function allAlerts(games) {
  const m = new Map();
  for (const a of S.snapshot?.alerts || []) m.set(a.id, { ...a, src: 'snapshot' });
  for (const a of clientAlerts(games)) m.set(a.id, { ...a, src: m.has(a.id) ? 'snapshot + phone' : 'phone' });
  const rank = { crit: 0, warn: 1, info: 2 };
  return [...m.values()].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
}

// ---------------------------------------------------------------- "status changed since your last look"
function seenState(games) {
  const o = {};
  for (const g of games) o[g.id] = { name: `${g.away.abbr} @ ${g.home.abbr}`, state: g.state, spread: g.odds?.spreadHome ?? null, total: g.odds?.total ?? null,
    statuses: Object.fromEntries((g.injuries || []).map(i => [i.name, i.status])) };
  return o;
}
async function computeSeenDiff(games) {
  const prev = await idbGet('lastSeen');
  const diff = [];
  if (prev?.games) {
    for (const [id, now] of Object.entries(seenState(games))) {
      const p = prev.games[id]; if (!p) continue;
      if (p.state !== now.state) diff.push({ game: now.name, field: 'game status', from: p.state, to: now.state });
      if (p.spread !== now.spread) diff.push({ game: now.name, field: 'spread (home)', from: line(p.spread), to: line(now.spread) });
      if (p.total !== now.total) diff.push({ game: now.name, field: 'total', from: p.total, to: now.total });
      const names = new Set([...Object.keys(p.statuses || {}), ...Object.keys(now.statuses)]);
      for (const n of names) if ((p.statuses || {})[n] !== now.statuses[n]) diff.push({ game: now.name, field: n, from: (p.statuses || {})[n] || 'not listed', to: now.statuses[n] || 'not listed' });
    }
  }
  S.seenDiff = diff; S.seenAt = prev?.at || null;
}
async function saveSeen() { const g = currentGames(); if (g.length) await idbSet('lastSeen', { at: Date.now(), games: seenState(g) }); }

// ---------------------------------------------------------------- in-browser simulator (Web Worker, core/engine/sim.js)
let simWorker = null;
function scheduleSim() {
  if (!S.snapshot || !('Worker' in window)) return;
  const fromServer = SERVER_LABELS.has(S.snap.label);
  const jobs = [];
  for (const g of currentGames()) {
    const a = g.analysis; if (!a?.pts || !isNum(a.pts.home)) continue;
    const snapLine = g.odds?.snapLine; const lineMoved = snapLine && (snapLine.spreadHome !== g.odds.spreadHome || snapLine.total !== g.odds.total);
    if (fromServer && !lineMoved) continue;   // the server numbers are fresh; nothing to recompute
    jobs.push({ id: g.id, ptsH: a.pts.home, ptsA: a.pts.away, poss: a.poss || 99, lambda: a.wp?.lambda ?? 0.1, marginSd: a.margin?.sd, wpModel: a.wp?.model,
      spreadLine: g.odds?.spreadHome ?? null, totalLine: g.odds?.total ?? null, mlHome: g.odds?.mlHome ?? null, mlAway: g.odds?.mlAway ?? null });
  }
  if (!jobs.length) return;
  try {
    simWorker = simWorker || new Worker('./sim-worker.js', { type: 'module' });
    simWorker.onmessage = ev => {
      const m = ev.data || {};
      if (m.type === 'result') { S.recomputed.set(m.id, { ...m.result, at: Date.now() }); S.simStatus = 'ok'; render(); }
      else if (m.type === 'error') { S.simStatus = 'error: ' + m.error; }
    };
    simWorker.onerror = e => { S.simStatus = 'worker failed: ' + (e.message || 'load error'); };
    S.simStatus = 'running';
    for (const j of jobs) simWorker.postMessage({ type: 'simulate', ...j });
  } catch (e) { S.simStatus = 'unavailable: ' + e.message; }
}

// ---------------------------------------------------------------- badge (every screen)
function sourceLabel() {
  if (S.snapshot) return S.snap.label;
  if (S.espn.status === 'ok') return 'ESPN live';
  return navigator.onLine ? 'no data yet' : 'offline';
}
function renderBadge() {
  const lab = sourceLabel();
  const b = $('bSource'); b.textContent = (lab === 'ESPN live' ? '' : 'Source: ') + lab;
  b.className = 'pill ' + (SERVER_LABELS.has(lab) || lab === 'ESPN live' ? 'ok' : lab === 'Fixture' ? 'info' : /on-phone|offline/.test(lab) ? 'warn' : 'crit');
  const age = $('bAge');
  if (S.snapshot?.generatedAt) { age.hidden = false; const ms = Date.now() - new Date(S.snapshot.generatedAt); age.textContent = `Snapshot ${ago(ms)} old`; age.className = 'pill ' + (ms > 3 * 3600e3 ? 'crit' : ms > 30 * 60e3 ? 'warn' : ''); }
  else age.hidden = true;
  const e = $('bEspn'); e.hidden = false;
  if (FIXTURE) { e.textContent = 'ESPN: fixture mode'; e.className = 'pill'; }
  else if (S.espn.status === 'ok') { e.textContent = `ESPN live · ${ago(Date.now() - S.espn.at)} ago`; e.className = 'pill ok'; }
  else { e.textContent = `ESPN ${S.espn.status}`; e.className = 'pill ' + (S.espn.status === 'not yet' ? '' : 'crit'); }
  const m = $('bMethod'); const st = S.snapshot?.method?.status;
  if (st) { m.hidden = false; m.textContent = /backtest pending/i.test(st) ? 'priors — backtest pending' : st; } else m.hidden = true;
  $('liveDot').classList.toggle('on', currentGames().some(g => g.state === 'in'));
}

// ---------------------------------------------------------------- game card pieces
function headWp(g) {
  const rc = S.recomputed.get(g.id);
  if (rc && isNum(rc.wpHome)) return { p: rc.wpHome, src: 'recomputed' };
  const a = g.analysis;
  if (a?.wp && isNum(a.wp.headline)) return { p: a.wp.headline, src: 'engine' };
  const nv = g.odds?.noVigHome ?? noVig(g.odds?.mlHome, g.odds?.mlAway);
  if (isNum(nv)) return { p: nv, src: 'market' };
  return { p: null, src: null };
}
function verdictLine(g) {
  const a = g.analysis, h = g.home.abbr, aw = g.away.abbr;
  if (g.state === 'in' && isNum(g.liveWpHome)) {
    const p = g.liveWpHome; const fav = p >= 0.5 ? h : aw;
    return `<b>LIVE: ${esc(fav)} ${pct(Math.max(p, 1 - p))}</b> to win on ESPN's in-game model · ${esc(g.detail || '')}`;
  }
  if (g.state === 'post') { const hs = g.home.score, as = g.away.score; return `<b>Final: ${esc(hs > as ? h : aw)} won ${esc(Math.max(hs, as))}–${esc(Math.min(hs, as))}</b>`; }
  const { p, src } = headWp(g);
  if (!isNum(p)) return `<b>No line or model yet.</b> Waiting for the market or the next snapshot.`;
  const fav = p >= 0.5 ? h : aw, pf = Math.max(p, 1 - p);
  const rc = S.recomputed.get(g.id);
  const marg = rc?.marginMean ?? a?.margin?.mean;
  const conf = a?.confidence;
  return `<b>${esc(fav)} ${pct(pf)}</b> to win${src === 'market' ? ' (market, no-vig)' : ' (market-anchored)'}${isNum(marg) ? ` · fair margin ${esc(fav)} by ${r1(Math.abs(marg))}` : ''}${conf ? ` · confidence <span class="pill ${gradeCls(conf.grade)}">${esc(conf.grade)} ${esc(Math.round(conf.score))}</span>` : ''}${a?.wp?.disagree ? ' · <span class="pill crit">model ≠ market</span>' : ''}${src === 'recomputed' ? ' <span class="recomp">recomputed in your browser</span>' : ''}`;
}
function keyNumbers(g) {
  const o = g.odds, a = g.analysis, rc = S.recomputed.get(g.id);
  const mv = (x, y, f) => (isNum(x) && isNum(y) && x !== y ? `<span class="mv"> (open ${f(x)})</span>` : '');
  const cells = [];
  cells.push(['Spread (home)', o ? `${line(o.spreadHome)}${mv(o.open?.spreadHome, o.spreadHome, line)}` : '–']);
  cells.push(['Total', o ? `${o.total ?? '–'}${mv(o.open?.total, o.total, x => x)}` : '–']);
  const nv = o ? (o.noVigHome ?? noVig(o.mlHome, o.mlAway)) : null;
  cells.push([`${esc(g.home.abbr)} no-vig`, isNum(nv) ? pct(nv) : '–']);
  if (a) {
    cells.push(['Model WP (home)', pct(a.wp?.model)]);
    const pc = rc?.pCoverHome ?? a.cover?.pHome, po = rc?.pOver ?? a.over?.p;
    cells.push([`${esc(g.home.abbr)} covers`, pct(pc)]);
    cells.push(['Over', pct(po)]);
    cells.push(['Proj score', isNum(a.pts?.home) ? `${esc(g.away.abbr)} ${r1(a.pts.away, 0)} – ${r1(a.pts.home, 0)} ${esc(g.home.abbr)}` : '–']);
    cells.push(['Margin 10–90', a.margin?.q ? `${sgn(a.margin.q.p10, 0)} to ${sgn(a.margin.q.p90, 0)}` : '–']);
    cells.push(['Total 10–90', a.total?.q ? `${r1(a.total.q.p10, 0)}–${r1(a.total.q.p90, 0)}` : '–']);
  }
  return `<div class="keynums">${cells.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('')}</div>`;
}
function whyList(g) {
  const a = g.analysis, out = [];
  if (!a) return `<p class="note">No engine analysis for this game in the snapshot yet; showing the live market only.</p>`;
  const rh = a.ratings?.home, ra = a.ratings?.away;
  if (rh && ra && isNum(rh.net) && isNum(ra.net)) out.push(`Blended net rating: ${esc(g.home.abbr)} ${sgn(rh.net)} vs ${esc(g.away.abbr)} ${sgn(ra.net)} per 100 (player layer + results layer).`);
  for (const c of (a.context || []).filter(c => c.inModel && isNum(c.effect)).sort((x, y) => Math.abs(y.effect) - Math.abs(x.effect)).slice(0, 2)) out.push(`${esc(c.label)}: ${esc(c.value)} → ${sgn(c.effect)} pts to ${esc(g.home.abbr)}.`);
  for (const p of (a.ifPanels || []).slice(0, 2)) out.push(`${esc(p.player)} (${esc(p.team)}) ${esc(p.status || '')} — ${pct(p.pPlay)} to play${isNum(p.marketImpliedPlay) ? `, market implies ${pct(p.marketImpliedPlay)}` : ''}.`);
  if (isNum(a.wp?.market) && isNum(a.wp?.model)) out.push(`Market ${pct(a.wp.market)} vs independent model ${pct(a.wp.model)} for ${esc(g.home.abbr)}${a.wp.disagree ? ' — disagreement flagged' : ''}; headline uses λ = ${r1(a.wp.lambda, 2)} model weight.`);
  return `<ul class="why">${out.slice(0, 4).map(x => `<li>${x}</li>`).join('')}</ul>`;
}
function changesIf(g, n = 3) {
  const sw = (g.analysis?.swing || []).slice(0, n);
  if (!sw.length) return `<p class="note">A starter moving to Out, or a 2+ point line move, changes this read.</p>`;
  return `<ul class="ifs">${sw.map(s => `<li>${esc(s.variable)}: ${esc(g.home.abbr)} WP ${pp(s.dWp)}, total ${sgn(s.dTotal)}${s.note ? ` <span class="muted">(${esc(s.note)})</span>` : ''}</li>`).join('')}</ul>`;
}
function probBar(g) {
  if (g.state === 'in' && isNum(g.liveWpHome)) {
    const p = g.liveWpHome;
    return `<div class="probbar"><div class="track" role="img" aria-label="Live ${esc(g.home.abbr)} win probability ${pct(p)}"><div class="fill" style="width:${p * 100}%"></div><div class="mid"></div></div><div class="plabels"><span class="away">${esc(g.away.abbr)} ${pct(1 - p)}</span><span class="tag inf">LIVE · ESPN</span><span class="home">${pct(p)} ${esc(g.home.abbr)}</span></div></div>`;
  }
  const r = inferredRange(g);
  if (g.state !== 'pre' || !r) return '';
  const c = (r[0] + r[1]) / 2;
  return `<div class="probbar"><div class="track" role="img" aria-label="${esc(g.home.abbr)} win range ${pct(r[0])} to ${pct(r[1])}"><div class="fill" style="width:${c * 100}%"></div><div class="rng" style="left:${r[0] * 100}%;width:${(r[1] - r[0]) * 100}%"></div><div class="mid"></div></div><div class="plabels"><span class="away">${esc(g.away.abbr)} ${pct(1 - r[1])}–${pct(1 - r[0])}</span><span class="tag inf">INFERRED RANGE</span><span class="home">${pct(r[0])}–${pct(r[1])} ${esc(g.home.abbr)}</span></div></div>`;
}
function inferredRange(g) {
  // carried forward: market (no-vig) and ESPN BPI, widened ±5 points; home perspective
  const mk = g.odds ? (g.odds.noVigHome ?? noVig(g.odds.mlHome, g.odds.mlAway)) : null;
  const bpi = g.bpiHome ?? g.analysis?.wp?.bpi ?? null;
  const pts = [mk, bpi].filter(isNum);
  if (!pts.length) return g.analysis?.wp?.inferredRange || null;
  return [Math.max(0.01, Math.min(...pts) - 0.05), Math.min(0.99, Math.max(...pts) + 0.05)];
}
function gameCard(g, { forceOpen = false } = {}) {
  const al = clientAlerts([g]); const showScore = g.state !== 'pre';
  const hs = g.home.score, as = g.away.score;
  const open = forceOpen || S.open.has(g.id);
  return `<article class="card ${g.state === 'in' ? 'live' : ''} ${al.length ? 'alerted' : ''}" data-id="${esc(g.id)}">
    <div class="ctop">
      <div class="status"><span class="st ${esc(g.state)}">${g.state === 'in' ? '● LIVE · ' : ''}${esc(g.state === 'pre' ? etTime(g.date) : g.detail)}</span><span class="muted mono" style="font-size:12px">${esc(g.tv || '')}</span></div>
      <div class="teams">
        <div class="tname away">${esc(g.away.name || g.away.abbr)}<small>${esc(g.away.record || '')}</small></div><div class="score ${showScore && as > hs ? 'lead' : ''}">${showScore ? esc(as ?? '') : ''}</div>
        <div class="tname home">@ ${esc(g.home.name || g.home.abbr)}<small>${esc(g.home.record || '')}</small></div><div class="score ${showScore && hs > as ? 'lead' : ''}">${showScore ? esc(hs ?? '') : ''}</div>
      </div>
      <p class="verdict">${verdictLine(g)}</p>
      <div><p class="lbl">Key numbers</p>${keyNumbers(g)}</div>
      ${probBar(g)}
      <div><p class="lbl">Why</p>${whyList(g)}</div>
      <div><p class="lbl">What changes if</p>${changesIf(g)}</div>
      ${al.length ? `<div class="alerts">${al.map(x => `<span class="pill ${x.severity}">${esc(x.text)}</span>`).join('')}</div>` : ''}
    </div>
    <details class="more" data-id="${esc(g.id)}" ${open ? 'open' : ''}><summary>Deep dive: every module (tap to expand)</summary><div class="dd">${open ? deepDive(g) : ''}</div></details>
  </article>`;
}

// ---------------------------------------------------------------- deep dive (every EngineOutput module)
const sec = (n, title, body, id = '') => `<section class="sec"${id ? ` id="${id}"` : ''}><h3><span class="secnum">${n}</span>${title}</h3>${body}</section>`;
const tbl = (head, rows, cls = '') => `<div class="tablewrap${cls.includes('tall') ? ' tall' : ''}"><table class="${cls}"><thead><tr>${head.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
function lineChart(hist, key, fmt) {
  const pts = hist.filter(h => isNum(h[key])); if (pts.length < 1) return '';
  const W = 320, H = 90, P = 22; const vs = pts.map(p => p[key]); let lo = Math.min(...vs), hi = Math.max(...vs); if (lo === hi) { lo -= 1; hi += 1; }
  const x = i => P + (pts.length === 1 ? (W - 2 * P) / 2 : i * (W - 2 * P) / (pts.length - 1)); const y = v => H - P + 4 - (v - lo) / (hi - lo) * (H - 2 * P);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
  const lbls = pts.map((p, i) => (i === 0 || i === pts.length - 1 ? `<text x="${x(i)}" y="${y(p[key]) - 5}" text-anchor="${i === 0 ? 'start' : 'end'}">${esc(fmt(p[key]))}</text>` : '')).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(key)} history from ${esc(fmt(vs[0]))} to ${esc(fmt(vs[vs.length - 1]))}"><path class="ln" d="${d}" stroke="var(--accent)"/>${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p[key])}" r="3" fill="${p.src ? 'var(--live)' : 'var(--accent)'}"/>`).join('')}${lbls}<text x="${P}" y="${H - 4}">open</text><text x="${W - P}" y="${H - 4}" text-anchor="end">now</text></svg>`;
}
function deepDive(g) {
  const a = g.analysis || null, o = g.odds || null, H = g.home.abbr, A = g.away.abbr;
  const rc = S.recomputed.get(g.id);
  if (!S.summaries.has(g.id) && g.state === 'pre') setTimeout(() => loadSummary(g.id), 0);
  const parts = [];
  // 0 header
  const ageS = S.snapshot?.generatedAt ? ago(Date.now() - new Date(S.snapshot.generatedAt)) : '–';
  const v = g.venue || {};
  parts.push(sec(0, 'Header', `<div class="meta">
    <div><span class="eyebrow">Tip-off</span><b class="mono">${esc(etTime(g.date))}</b><span class="muted">${esc(v.tz ? localTime(g.date, v.tz) + ' local' : '')}</span></div>
    <div><span class="eyebrow">Venue</span><b>${esc(v.name || '–')}</b><span class="muted">${esc(v.city || '')}${g.neutral ? ' · neutral site' : ''}</span></div>
    <div><span class="eyebrow">Altitude · timezone</span><b class="mono">${isNum(v.altFt) ? v.altFt.toLocaleString() + ' ft' : '–'}</b><span class="muted">${esc(v.tz || '–')}</span></div>
    <div><span class="eyebrow">TV</span><b>${esc(g.tv || '–')}</b></div>
    <div><span class="eyebrow">Data age</span><b class="mono">${esc(ageS)}</b><span class="muted">${esc(sourceLabel())}${g._espnAt ? ` · ESPN ${ago(Date.now() - g._espnAt)} ago` : ''}</span></div>
    <div><span class="eyebrow">Confidence</span><b>${a?.confidence ? `<span class="pill ${gradeCls(a.confidence.grade)}">${esc(a.confidence.grade)}</span> ${esc(Math.round(a.confidence.score))}/100` : '–'}</b><span class="muted">${a?.confidence?.capped ? esc(a.confidence.capped) : ''}</span></div>
    <div><span class="eyebrow">Officials</span><b>${esc((g.officials || []).join(', ') || 'not posted yet')}</b></div>
    <div><span class="eyebrow">Rest</span><b class="mono">${esc(A)} ${esc(g.away.restDays ?? '–')}d${g.away.b2b ? ' (B2B)' : ''} · ${esc(H)} ${esc(g.home.restDays ?? '–')}d${g.home.b2b ? ' (B2B)' : ''}</b></div>
  </div>${a?.confidence?.terms ? `<p class="note">Confidence terms (0 = best, 1 = worst): ${Object.entries(a.confidence.terms).map(([k, x]) => `${esc(k)} ${r1(x, 2)}`).join(' · ')}</p>` : ''}`));
  // 1 win probability
  if (a?.wp) {
    const w = a.wp;
    const books = (o?.books || []).map(b => `<tr><td>${esc(b.name)}</td><td class="n">${esc(line(b.mlAway))}</td><td class="n">${esc(line(b.mlHome))}</td><td class="n">${line(b.spreadHome)}</td><td class="n">${b.total ?? '–'}</td><td class="n">${pct(b.noVigHome ?? noVig(b.mlHome, b.mlAway), 1)}</td></tr>`);
    const hist = [...(o?.open ? [{ ...o.open, noVigHome: o.open.noVigHome ?? noVig(o.open.mlHome, o.open.mlAway), label: 'open' }] : []), ...(o?.history || [])];
    const hrows = hist.map((h, i) => `<tr><td>${esc(h.label || (h.src ? h.src : i === hist.length - 1 ? 'snapshot (current)' : 'snapshot'))}</td><td class="mono">${esc(h.at ? etClock(new Date(h.at).getTime()) : '–')}</td><td class="n">${line(h.spreadHome)}</td><td class="n">${h.total ?? '–'}</td><td class="n">${pct(h.noVigHome, 1)}</td></tr>`);
    const q = x => x?.q ? ['p10', 'p25', 'p50', 'p75', 'p90'].map(k => `<td class="n">${r1(x.q[k])}</td>`).join('') : '<td colspan="5">–</td>';
    parts.push(sec(1, 'Win probability', `
      <div class="cards2">
        <div><span class="eyebrow">Headline (market-anchored)</span><span class="big">${esc(H)} ${pct(w.headline, 1)}</span><span class="note">logit blend: (1 − λ)·market + λ·model, λ = ${r1(w.lambda, 2)}${isNum(w.lambdaPrior) && w.lambdaPrior !== w.lambda ? ` (prior ${r1(w.lambdaPrior, 2)}; raised for fresh news)` : ''} · range ${pct(w.range?.[0])}–${pct(w.range?.[1])}</span></div>
        <div><span class="eyebrow">Independent model</span><span class="big">${esc(H)} ${pct(w.model, 1)}</span><span class="note">market no-vig ${pct(w.market, 1)}${isNum(w.disagreeSD) ? ` · gap ${sgn(w.disagreeSD, 2)} SD` : ''} ${w.disagree ? '<span class="pill crit">disagreement flag</span>' : '<span class="pill ok">within 0.35 SD</span>'}</span></div>
        ${rc ? `<div><span class="eyebrow">Recomputed in your browser</span><span class="big">${esc(H)} ${pct(rc.wpHome, 1)}</span><span class="note"><span class="recomp">recomputed in your browser</span> ${esc(rc.n)} draws on the latest line (${line(rc.spreadLine)}, ${rc.totalLine ?? '–'}) · cover ${pct(rc.pCoverHome)} · over ${pct(rc.pOver)}</span></div>` : ''}
      </div>
      <p><span class="tag mkt">COVER</span> ${esc(H)} ${line(a.cover?.line)}: ${pct(rc?.pCoverHome ?? a.cover?.pHome, 1)} · <span class="tag mkt">OVER</span> ${a.over?.line ?? '–'}: ${pct(rc?.pOver ?? a.over?.p, 1)} · OT ${pct(a.pOT, 1)} · possessions ${r1(a.poss)}</p>
      <h4 class="eyebrow">No-vig by book</h4>${books.length ? tbl(['Book', `${esc(A)} ML`, `${esc(H)} ML`, 'Spread', 'Total', `${esc(H)} no-vig`], books) : '<p class="note">No book prices in this snapshot.</p>'}
      <h4 class="eyebrow">Line history: open → current → our snapshot</h4>
      ${lineChart(hist, 'spreadHome', line)}${tbl(['Point', 'Time', 'Spread', 'Total', `${esc(H)} no-vig`], hrows)}
      <h4 class="eyebrow">Quantiles (home margin, total)</h4>${tbl(['', 'p10', 'p25', 'p50', 'p75', 'p90'], [`<tr><td>Margin (${esc(H)} − ${esc(A)})</td>${q(rc?.margin || a.margin)}</tr>`, `<tr><td>Total</td>${q(rc?.total || a.total)}</tr>`])}`));
  } else parts.push(sec(1, 'Win probability', `<p>Market only: ${esc(H)} no-vig ${pct(o?.noVigHome ?? noVig(o?.mlHome, o?.mlAway), 1)}.</p>`));
  // 2 inferred range
  const ir = inferredRange(g); const bpi = g.bpiHome ?? a?.wp?.bpi;
  parts.push(sec(2, 'Inferred range <span class="tag inf">INFERRED</span>', `${probBar({ ...g, state: 'pre' }) || ''}<p>Market (no-vig) ${pct(o?.noVigHome ?? noVig(o?.mlHome, o?.mlAway))} and ESPN BPI ${isNum(bpi) ? pct(bpi) : (S.sumStatus.get(g.id) === 'loading' ? 'loading…' : 'not posted')}, widened ±5 points: ${esc(H)} ${ir ? `${pct(ir[0])}–${pct(ir[1])}` : '–'}.</p><p class="note">Carried forward from the original live board. A wide range means the sources disagree; treat it as low confidence.</p>`));
  // 3 head-to-head
  const h2h = g.h2h?.games || [];
  parts.push(sec(3, 'Head-to-head', h2h.length ? `${tbl(['Date', 'Winner', 'Score', 'n'], h2h.map(x => `<tr><td class="mono">${esc((x.date || '').slice(0, 10))}</td><td>${esc(x.winner || '–')}</td><td class="mono">${esc(x.score || x.status || '')}</td><td class="n">n=${esc(x.n ?? h2h.length)}</td></tr>`))}<p class="note">${esc(g.h2h?.note || '')} n = ${h2h.length}: small sample, context only, not a projection input.</p>` : '<p class="note">No meetings on record this season (n = 0).</p>'));
  // 4 lineups + minutes engine
  const players = a?.players || [];
  const confirmed = !!(g.lineupsConfirmed || g.startersConfirmed);
  const lineupFor = ab => {
    const ps = players.filter(p => p.team === ab).sort((x, y) => (y.starter - x.starter) || (y.min?.mean ?? 0) - (x.min?.mean ?? 0));
    if (!ps.length) return `<p class="note">No rotation in this snapshot.</p>`;
    return tbl(['Player', 'Role', 'Status', 'MIN', '10–90', 'Blowout', 'Foul risk', 'Return cap'], ps.map(p => `<tr><td>${esc(p.name)} <span class="muted">${esc(p.pos || '')}</span></td><td>${p.starter ? `<span class="tag ${confirmed ? 'off' : 'inf'}">${confirmed ? 'CONFIRMED' : 'PROJECTED'} START</span>` : 'bench'}</td><td class="${statusCls(p.status)}">${esc(p.status)}${isNum(p.pPlay) && p.pPlay < 0.97 ? ` · ${pct(p.pPlay)}` : ''}</td><td class="n">${r1(p.min?.mean)}</td><td class="n">${r1(p.min?.p10, 0)}–${r1(p.min?.p90, 0)}</td><td class="n">${sgn(p.min?.blowoutAdj)}</td><td class="n">${pct(p.min?.foulRisk)}</td><td class="n">${p.min?.returnCap ? esc(typeof p.min.returnCap === 'object' ? (p.min.returnCap.cap ?? JSON.stringify(p.min.returnCap)) : p.min.returnCap) : '–'}</td></tr>`));
  };
  parts.push(sec(4, 'Lineups and minutes engine', `<p class="note">${confirmed ? 'Starters confirmed by the teams.' : 'Projected starters: teams post official lineups about 30 minutes before tip.'} Minutes: mean, 10th–90th percentile band, blowout adjustment, foul-trouble risk and return-from-injury cap.</p><h4 class="away">${esc(g.away.name || A)}</h4>${lineupFor(A)}<h4 class="home">${esc(g.home.name || H)}</h4>${lineupFor(H)}`));
  // 5 injury scenario tree
  const injList = (g.injuries || []).map(i => `<li><span class="${statusCls(i.status)}">${esc(i.status)}</span> ${esc(i.team)} ${esc(i.name)} <span class="muted">${esc(i.detail || '')}${i._live ? ' · live ESPN update' : ''}${i.prevStatus ? ` (was ${esc(i.prevStatus)})` : ''}</span></li>`).join('');
  const panels = (a?.ifPanels || []).map(p => `<div><b>${esc(p.player)} <span class="muted">${esc(p.team)} · ${esc(p.status || '')}</span></b>
      <span class="mono">P(play) ${pct(p.pPlay)} · market-implied ${pct(p.marketImpliedPlay)}</span>
      ${tbl(['If…', `${esc(H)} WP`, 'Margin', 'Total'], [`<tr><td>plays</td><td class="n">${pct(p.plays?.wpHome, 1)}</td><td class="n">${sgn(p.plays?.margin)}</td><td class="n">${r1(p.plays?.total)}</td></tr>`, `<tr><td>sits</td><td class="n">${pct(p.sits?.wpHome, 1)}</td><td class="n">${sgn(p.sits?.margin)}</td><td class="n">${r1(p.sits?.total)}</td></tr>`])}
      <span class="mono">Δ if plays: WP ${pp(p.delta?.wp)} · spread ${sgn(p.delta?.spread)} · total ${sgn(p.delta?.total)}</span>
      ${(p.teammates || []).length ? `<span class="eyebrow">If ${esc(p.player)} sits, teammates</span>${tbl(['Teammate', 'ΔMIN', 'ΔPTS', 'ΔREB', 'ΔAST', 'ΔUSG'], p.teammates.map(t => `<tr><td>${esc(t.name)}</td><td class="n">${sgn(t.dMin)}</td><td class="n">${sgn(t.dPts)}</td><td class="n">${sgn(t.dReb)}</td><td class="n">${sgn(t.dAst)}</td><td class="n">${sgn(t.dUsg)}</td></tr>`))}` : ''}</div>`).join('');
  const both = (a?.bothSit || []).map(b => `<tr><td>${esc(b.players.join(' + '))}</td><td class="n">${pct(b.prob, 1)}</td><td class="n">${pct(b.wpHome, 1)}</td><td class="n">${sgn(b.margin)}</td><td class="n">${r1(b.total)}</td></tr>`);
  const scen = (a?.scenarios || []).map(s => `<tr><td>${esc(s.out?.length ? 'without ' + s.out.join(', ') : 'everyone plays')}</td><td class="n">${pct(s.prob, 1)}</td><td class="n">${pct(s.wpHome, 1)}</td><td class="n">${sgn(s.margin)}</td><td class="n">${r1(s.total)}</td></tr>`);
  parts.push(sec(5, 'Injury scenario tree', `${injList ? `<ul class="list">${injList}</ul>` : '<p class="note">No injuries listed.</p>'}
    ${panels ? `<h4 class="eyebrow">If sits / if plays — Questionable and Doubtful players</h4><div class="cards2">${panels}</div>` : '<p class="note">No uncertain players: every listed player is fixed at their most likely status.</p>'}
    ${both.length ? `<h4 class="eyebrow">Both sit</h4>${tbl(['Players', 'Prob', `${esc(H)} WP`, 'Margin', 'Total'], both)}` : ''}
    ${scen.length ? `<h4 class="eyebrow">Scenario list${isNum(a?.scenarioEntropy) ? ` · entropy ${r1(a.scenarioEntropy, 2)} bits` : ''}</h4>${tbl(['Scenario', 'Prob', `${esc(H)} WP`, 'Margin', 'Total'], scen)}` : ''}`));
  // 6 player profiles
  const prof = players.map(p => {
    const b = k => p.proj?.[k]; const brow = (lab, x) => `<tr><td>${lab}</td><td class="n">${r1(x?.mean)}</td><td class="n">${r1(x?.p10)}</td><td class="n">${r1(x?.p90)}</td></tr>`;
    const sp = (p.splits || []).map(s => `<tr><td>${esc(s.label)}</td><td class="n">n=${esc(s.n)}</td><td class="n">${sgn(s.raw)}</td><td class="n">${sgn(s.shrunk)}</td><td>${s.inProjection ? 'in projection' : `display only — ${esc(s.why || 'small sample')}`}</td></tr>`);
    return `<details class="more"><summary>${esc(p.name)} <span class="muted">${esc(p.team)} ${esc(p.pos || '')}</span> <span class="mono" style="margin-left:6px">${r1(p.proj?.pts?.mean)} pts</span> ${p.confidence ? `<span class="pill ${gradeCls(p.confidence.grade)}">${esc(p.confidence.grade)}</span>` : ''}</summary><div class="dd">
      ${tbl(['Stat', 'Mean', 'p10', 'p90'], [brow('MIN', { mean: p.min?.mean, p10: p.min?.p10, p90: p.min?.p90 }), brow('PTS', b('pts')), brow('REB', b('reb')), brow('AST', b('ast')), brow('3PM', b('fg3m')), brow('PRA', b('pra'))])}
      <p class="mono" style="font-size:13px">Season (n=${esc(p.form?.season?.n ?? '–')}): ${r1(p.form?.season?.pts)} / ${r1(p.form?.season?.reb)} / ${r1(p.form?.season?.ast)} in ${r1(p.form?.season?.min)} min · Decayed form: ${r1(p.form?.decayed?.pts)} / ${r1(p.form?.decayed?.reb)} / ${r1(p.form?.decayed?.ast)} in ${r1(p.form?.decayed?.min)} min</p>
      <p class="note">Rates: USG ${r1(p.rates?.usg ?? p.rates?.usg36)} · TS ${pct(p.rates?.ts, 1)} · 3P% raw ${pct(p.rates?.fg3pct, 1)} → shrunk ${pct(p.rates?.fg3pctShrunk, 1)} · AST/36 ${r1(p.rates?.ast36)} · REB/36 ${r1(p.rates?.reb36)}</p>
      ${sp.length ? tbl(['Split', 'n', 'Raw', 'Shrunk', 'Use'], sp) : '<p class="note">No splits.</p>'}</div></details>`;
  }).join('');
  parts.push(sec(6, 'Player profiles', prof || '<p class="note">No player projections in this snapshot.</p>'));
  // 7 factors
  parts.push(sec(7, 'Factor table', factorTable(g), `factors-${g.id}`));
  // 8 swing
  parts.push(sec(8, 'What changes if — top 5 swing', (a?.swing || []).length ? tbl(['Variable', `${esc(H)} ΔWP`, 'ΔTotal', 'Note'], a.swing.slice(0, 5).map(s => `<tr><td>${esc(s.variable)}</td><td class="n">${pp(s.dWp)}</td><td class="n">${sgn(s.dTotal)}</td><td>${esc(s.note || '')}</td></tr>`)) : '<p class="note">No swing table.</p>'));
  // 9 trends
  const tr = gameTrends(g);
  parts.push(sec(9, 'Trend cards', tr.length ? `<div class="cards2">${tr.map(trendCard).join('')}</div>` : '<p class="note">No registered trend applies to this matchup.</p>'));
  // 10 narrative
  const paras = g.narrative?.paras || [];
  parts.push(sec(10, 'Game narrative', `<div class="narr">${paras.map(p => `<p>${esc(p)}</p>`).join('') || '<p class="note">Narrative not written yet.</p>'}</div>${g.narrative?.source ? `<p class="note">Written by: ${esc(g.narrative.source)} (numbers come from the engine; the writer only phrases them).</p>` : ''}`));
  // 11 reasoning
  const rs = g.reasoning || [];
  parts.push(sec(11, 'Reasoning log', rs.length ? `<ul class="list">${rs.map(r => `<li><span class="mono muted">${esc(r.at ? etClock(new Date(r.at).getTime()) : '')}</span> ${esc(r.text)}</li>`).join('')}</ul>` : '<p class="note">No changes logged since the first snapshot.</p>'));
  return parts.join('');
}
function factorTable(g) {
  const rows = g.analysis?.factors || [];
  if (!rows.length) return '<p class="note">No factor rows in this snapshot.</p>';
  const f = S.factorFilter.get(g.id) || { group: 'all', inp: 'all' };
  const groups = [...new Set(rows.map(r => r.group || r.family || 'Other'))];
  const inProj = r => !!(r.inProjection ?? r.inModel);
  const shown = rows.filter(r => (f.group === 'all' || (r.group || r.family || 'Other') === f.group) && (f.inp === 'all' || (f.inp === 'yes') === inProj(r)));
  const val = x => (isNum(x) ? r1(x, Math.abs(x) < 1 && x !== 0 ? 3 : 1) : esc(x ?? '–'));
  return `<div class="filters" data-gid="${esc(g.id)}">
      <label>Group <select data-ff="group">${['all', ...groups].map(x => `<option ${x === f.group ? 'selected' : ''} value="${esc(x)}">${esc(x === 'all' ? 'All groups' : x)}</option>`).join('')}</select></label>
      <label>In projection <select data-ff="inp"><option value="all" ${f.inp === 'all' ? 'selected' : ''}>All</option><option value="yes" ${f.inp === 'yes' ? 'selected' : ''}>Yes</option><option value="no" ${f.inp === 'no' ? 'selected' : ''}>Display only</option></select></label>
      <span class="mono muted" data-count>${shown.length} of ${rows.length} rows</span></div>
    ${tbl(['#', 'Group', 'Factor', esc(g.away.abbr), esc(g.home.abbr), 'Value', 'Effect', 'In proj.', 'Note'], shown.map((r, i) => `<tr><td class="n">${esc(r.id ?? i + 1)}</td><td>${esc(r.group || r.family || 'Other')}</td><td>${esc(r.label || r.key)}</td><td class="n">${val(r.away)}</td><td class="n">${val(r.home)}</td><td class="n">${val(r.value)}${r.unit ? ` <span class="muted">${esc(r.unit)}</span>` : ''}</td><td class="n">${isNum(r.effect) ? sgn(r.effect, 2) : '–'}</td><td>${inProj(r) ? '<span class="tag off">YES</span>' : '<span class="tag inf">DISPLAY</span>'}</td><td class="note">${esc(r.note || r.source || '')}${isNum(r.n) ? ` · n=${r.n}` : ''}</td></tr>`), 'factors tall')}`;
}
function gameTrends(g) {
  const t = S.snapshot?.trends; if (!t) return [];
  const all = [...(t.validated || []), ...(t.exploratory || []), ...(t.narrative || [])];
  return all.filter(x => x.gameId === g.id || (x.subject && [g.home.abbr, g.away.abbr].some(ab => String(x.subject).toUpperCase().includes(ab))) || (x.subjects || []).some(s => [g.home.abbr, g.away.abbr].includes(s)));
}
function trendCard(t) {
  const tierCls = t.tier === 'Validated' ? 'tv' : t.tier === 'Exploratory' ? 'te' : 'tn';
  return `<div><span><span class="tag ${tierCls}">${esc(String(t.tier || '').toUpperCase())}</span> <span class="muted mono">${esc(t.family || '')}</span></span>
    <b>${esc(t.label)}</b>
    <span class="mono" style="font-size:12.5px">n=${esc(t.n)} · ${esc(t.seasons ?? '')} seasons · stable ${esc(t.stableSeasons ?? '–')}</span>
    <span class="mono" style="font-size:12.5px">raw ${sgn(t.rawEffect)} → shrunk ${sgn(t.shrunkEffect)} (80% CI ${sgn(t.ci80?.[0])} to ${sgn(t.ci80?.[1])})</span>
    <span class="mono" style="font-size:12.5px">residual vs model ${sgn(t.residualVsModel)} · vs close ${sgn(t.residualVsClose)} · p ${r1(t.p, 3)} · q(BH) ${r1(t.qBH, 3)} · q(BY) ${r1(t.qBY, 3)}</span>
    ${t.mechanism ? `<span class="note">Mechanism: ${esc(t.mechanism)}</span>` : ''}
    ${t.alreadyPriced ? '<span class="pill warn">already priced by the close</span>' : ''}
    <span class="note">${esc(t.noiseNote || '')}</span></div>`;
}

// ---------------------------------------------------------------- views
function viewSlate(games) {
  const live = games.filter(g => g.state === 'in').length, fin = games.filter(g => g.state === 'post').length;
  const next = games.filter(g => g.state === 'pre').map(g => g.date).sort()[0];
  const narr = S.snapshot && S.snapshot.slateDate === S.day ? (S.snapshot.narrative?.slate || []) : [];
  const al = allAlerts(games);
  const stale = S.snapshot && S.snapshot.slateDate && S.snapshot.slateDate !== S.day;
  return `<header class="row" style="justify-content:space-between">
      <div><p class="eyebrow">NBA slate · ${S.day === slateToday() ? 'today' : 'browsing'}</p><h1>${esc(niceDay(S.day))}</h1></div>
      <div class="daynav"><button data-act="prev" aria-label="Previous day">◀ Prev</button><button data-act="today" ${S.day === slateToday() ? 'disabled' : ''}>Today</button><button data-act="next" aria-label="Next day">Next ▶</button><button data-act="refresh">Refresh</button></div>
    </header>
    ${stale ? `<p class="banner">The newest snapshot is for ${esc(niceDay(S.snapshot.slateDate))}. ${S.espn.day === S.day ? 'Showing live ESPN scores and lines for this day.' : 'No live data for this day yet.'} <button data-act="snapday">Open snapshot day</button></p>` : ''}
    <div class="tiles"><div class="tile"><span class="eyebrow">Games</span><b>${games.length}</b></div><div class="tile"><span class="eyebrow">Live</span><b>${live}</b></div><div class="tile"><span class="eyebrow">Final</span><b>${fin}</b></div><div class="tile"><span class="eyebrow">Next lock</span><b>${next ? esc(etTime(next).replace(' ET', '')) : '–'}</b></div><div class="tile"><span class="eyebrow">Alerts</span><b>${al.length}</b></div></div>
    ${narr.length ? `<div class="panel narr" id="slateNarr"><p class="eyebrow">Slate read${S.snapshot.narrative?.source ? ` · ${esc(S.snapshot.narrative.source)}` : ''}</p>${narr.map(p => `<p>${esc(p)}</p>`).join('')}</div>` : ''}
    <div class="grid" aria-live="polite">${games.map(g => gameCard(g)).join('') || `<p class="muted">${S.espn.status === 'not yet' && !S.snapshot ? 'Loading…' : 'No NBA games on this date.'}</p>`}</div>
    <p class="note"><b>How to read a card.</b> Verdict → key numbers → why → what changes if → deep dive, in the same order for every game. <span class="tag mkt">MARKET</span> prices are no-vig. <span class="tag inf">INFERRED</span> range = market and ESPN BPI widened ±5 points. Live games show ESPN's in-game win probability. Scores refresh every 60 s while games are live, every 5 min otherwise; injuries every 15 min; polling pauses while the app is in the background. The board rolls to the next day at 6 AM ET.</p>`;
}
function viewGames(games) {
  if (!games.length) return `<h1>Games</h1><p class="muted">No games for ${esc(niceDay(S.day))}.</p>`;
  const sel = games.find(g => g.id === S.gameSel) || games[0]; S.gameSel = sel.id;
  return `<h1>Games</h1><div class="chips" role="tablist">${games.map(g => `<button role="tab" data-game="${esc(g.id)}" aria-pressed="${g.id === sel.id}">${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</button>`).join('')}</div>${gameCard(sel, { forceOpen: true })}`;
}
function getPath(o, p) { return p.split('.').reduce((x, k) => (x == null ? x : x[k]), o); }
function viewPlayers(games) {
  const rows = [];
  for (const g of games) for (const p of g.analysis?.players || []) rows.push({ ...p, opp: p.team === g.home.abbr ? g.away.abbr : g.home.abbr, gameId: g.id });
  const teams = [...new Set(rows.map(r => r.team))].sort();
  const { key, dir } = S.playerSort;
  const shown = rows.filter(r => S.playerTeam === 'all' || r.team === S.playerTeam).sort((a, b) => { const x = getPath(a, key), y = getPath(b, key); if (typeof x === 'string' || typeof y === 'string') return dir * String(x ?? '').localeCompare(String(y ?? '')); return dir * ((x ?? -1e9) - (y ?? -1e9)); });
  const cols = [['name', 'Player'], ['team', 'Team'], ['opp', 'Opp'], ['status', 'Status'], ['pPlay', 'P(play)'], ['min.mean', 'MIN'], ['proj.pts.mean', 'PTS'], ['proj.reb.mean', 'REB'], ['proj.ast.mean', 'AST'], ['proj.fg3m.mean', '3PM'], ['proj.pra.mean', 'PRA'], ['confidence.score', 'Conf']];
  return `<h1>Players</h1><p class="note">Every rotation player on the slate (${rows.length}). Tap a column to sort. Projections are means; open a game's deep dive for 10–90 bands.</p>
    <div class="filters"><label>Team <select data-pteam>${['all', ...teams].map(t => `<option value="${esc(t)}" ${t === S.playerTeam ? 'selected' : ''}>${esc(t === 'all' ? 'All teams' : t)}</option>`).join('')}</select></label></div>
    <div class="tablewrap tall"><table class="players"><thead><tr>${cols.map(([k, l]) => `<th scope="col" aria-sort="${k === key ? (dir > 0 ? 'ascending' : 'descending') : 'none'}"><button data-sort="${k}">${l}${k === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr></thead><tbody>
    ${shown.map(p => `<tr><td>${esc(p.name)}</td><td>${esc(p.team)}</td><td>${esc(p.opp)}</td><td class="${statusCls(p.status)}">${esc(p.status)}</td><td class="n">${pct(p.pPlay)}</td><td class="n">${r1(p.min?.mean)}</td><td class="n">${r1(p.proj?.pts?.mean)}</td><td class="n">${r1(p.proj?.reb?.mean)}</td><td class="n">${r1(p.proj?.ast?.mean)}</td><td class="n">${r1(p.proj?.fg3m?.mean)}</td><td class="n">${r1(p.proj?.pra?.mean)}</td><td class="n">${p.confidence ? `${esc(p.confidence.grade)} ${esc(Math.round(p.confidence.score))}` : '–'}</td></tr>`).join('') || '<tr><td colspan="12">No player projections in this snapshot.</td></tr>'}
    </tbody></table></div>`;
}
function viewTrends() {
  const t = S.snapshot?.trends || {};
  const list = (title, arr, note) => `<section class="panel"><h2>${title} <span class="mono muted" style="font-size:14px">(${(arr || []).length})</span></h2><p class="note">${note}</p>${(arr || []).length ? `<div class="cards2">${arr.map(trendCard).join('')}</div>` : '<p class="note">None this run.</p>'}</section>`;
  let nv = t.newValidated, fa = t.fellApart;
  if (!nv && S.prevTrendIds) { const now = new Set((t.validated || []).map(x => x.id)); nv = (t.validated || []).filter(x => !S.prevTrendIds.has(x.id)).map(x => x.label); fa = [...S.prevTrendIds].filter(id => !now.has(id)); }
  return `<h1>Trends</h1>
    <div class="tiles"><div class="tile"><span class="eyebrow">Registry size</span><b>${esc(t.registrySize ?? '–')}</b></div><div class="tile"><span class="eyebrow">Validated</span><b>${(t.validated || []).length}</b></div><div class="tile"><span class="eyebrow">Exploratory</span><b>${(t.exploratory || []).length}</b></div><div class="tile"><span class="eyebrow">Last retest</span><b style="font-size:16px">${esc(t.lastRetest ? String(t.lastRetest).slice(0, 10) : '–')}</b></div></div>
    <section class="panel"><h2>New validated / fell apart</h2><p><b>New validated:</b> ${esc((nv || []).map(x => (typeof x === 'string' ? x : x.label)).join('; ') || 'none since the last retest')}</p><p><b>Fell apart:</b> ${esc((fa || []).map(x => (typeof x === 'string' ? x : x.label)).join('; ') || 'none')}</p></section>
    ${list('Validated', t.validated, 'Survived false-discovery control (q) and held in most seasons, with residual measured against our model and against the closing line.')}
    ${list('Exploratory', t.exploratory, 'Interesting but not proven: shown for context, never in the projection.')}
    ${list('Narrative only', t.narrative, 'Popular talking points that fail the tests. Listed so you can see why they are ignored.')}`;
}
function viewChanges() {
  const ch = S.snapshot?.changes || [];
  const nm = id => { const g = (S.snapshot?.games || []).find(x => x.id === id); return g ? `${g.away.abbr} @ ${g.home.abbr}` : 'Slate'; };
  return `<h1>Changes</h1>
    <section class="panel"><h2>Since your last look</h2><p class="note">${S.seenAt ? `Compared with what this iPhone showed at ${esc(etClock(S.seenAt))} (${ago(Date.now() - S.seenAt)} ago).` : 'First visit on this device: future visits list every status, line and game-state change since you last opened the app.'}</p>
    ${(S.seenDiff || []).length ? `<ul class="list">${S.seenDiff.map(d => `<li><b>${esc(d.game)}</b> · ${esc(d.field)}: <span class="mono">${esc(d.from)} → ${esc(d.to)}</span></li>`).join('')}</ul>` : '<p class="note">Nothing changed since your last look.</p>'}</section>
    <section class="panel"><h2>Snapshot change log</h2>${ch.length ? `<ul class="list">${ch.map(c => `<li><b>${esc(nm(c.gameId))}</b> · ${esc(c.field)}: <span class="mono">${esc(c.from)} → ${esc(c.to)}</span> <span class="muted">${esc(c.why || '')}${c.at ? ' · ' + esc(etClock(new Date(c.at).getTime())) : ''}</span></li>`).join('')}</ul>` : '<p class="note">No changes between the last two snapshots.</p>'}</section>`;
}
function viewAlerts(games) {
  const al = allAlerts(games);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const vapid = !!S.config.vapidPublicKey;
  return `<h1>Alerts</h1>
    <section class="panel"><h2>Push alerts</h2>
      <p>Get a notification when a Questionable starter's status changes, a line moves past the thresholds below, or lineup lock is an hour away.</p>
      <p class="note">On iPhone, web push only works from the Home Screen app on iOS 16.4 or later: tap Share → Add to Home Screen, open Matchup Lab from that icon, then tap the button. ${standalone ? 'You are in the Home Screen app.' : 'You are in the browser right now, so iOS will not offer push here.'}</p>
      ${vapid ? '' : '<p class="banner">Push isn\'t configured yet: config.json has no VAPID public key. The button stays off until the Worker\'s push key is added.</p>'}
      <div class="row"><button data-act="push" ${vapid && 'PushManager' in window ? '' : 'disabled'}>Enable alerts on this iPhone</button><span class="note" id="pushStatus">${esc(S.push.status)}</span></div></section>
    <section class="panel"><h2>Active alerts <span class="mono muted" style="font-size:14px">(${al.length})</span></h2>
    ${al.length ? `<ul class="list">${al.map(x => `<li><span class="pill ${x.severity}">${esc(x.severity)}</span> ${esc(x.text)} <span class="muted mono" style="font-size:11px">${esc(x.src)}</span></li>`).join('')}</ul>` : '<p class="note">No alerts right now.</p>'}
    <p class="note"><b>Alerts fire on:</b> a spread move of 2+ points from open, a total move of 3+, a no-vig win-chance move of 5+ points, a Questionable / Doubtful / Day-To-Day tag, and tip within 60 minutes (lineup lock). Server alerts come from the snapshot; phone alerts are computed here from the live ESPN feed.</p></section>`;
}
function viewMethod() {
  const m = S.snapshot?.method || {};
  const tx = S.threeX;
  let threeX = '<p class="note">The 3× table (data/3x.json) has not been published yet.</p>';
  if (tx && typeof tx === 'object') {
    const rows = Array.isArray(tx) ? tx : (tx.rows || []);
    const cols = rows.length ? Object.keys(rows[0]) : [];
    threeX = rows.length ? `${tx.title ? `<p><b>${esc(tx.title)}</b></p>` : ''}${tbl(cols.map(esc), rows.map(r => `<tr>${cols.map(c => `<td>${esc(typeof r[c] === 'number' ? r1(r[c], 3) : r[c])}</td>`).join('')}</tr>`))}${tx.note ? `<p class="note">${esc(tx.note)}</p>` : ''}` : threeX;
  }
  const priors = [['Headline blend λ (model weight)', `${r1(m.lambda ?? 0.1, 2)} (0.30 only for news < 15 min old with no line move)`], ['Player-layer weight α', `${r1(m.alphaPlayer ?? 0.75, 2)} at ≤ 15 games → 0.55 by game 40`], ['Home-court advantage', `${r1(m.hca ?? S.snapshot?.league?.hca ?? 2.0)} pts`], ['League ORtg / pace', `${r1(m.leagueOrtg ?? S.snapshot?.league?.ortg ?? 114.5)} / ${r1(m.leaguePace ?? S.snapshot?.league?.pace ?? 99)}`], ['Margin SD', '12.5 pts (scaled by pace)'], ['Total SD', '18.0 pts'], ['Questionable play probability', '0.50 (key player at T−2h: 0.56)'], ['Doubtful play probability', '0.02'], ['Blowout minutes loss', 'starts at a 13-pt expected margin, 0.9 min per pt'], ['Shrinkage K (3P%)', '240 attempts'], ['Simulation', '10,000 bivariate-normal draws, 5-min overtime periods']];
  return `<h1>Method</h1>
    <p class="statusline" id="statusLine">${esc(STATUS_LINE)}</p>
    ${m.statusLine && m.statusLine !== STATUS_LINE ? `<p class="note">Writer status: ${esc(m.statusLine)}</p>` : ''}
    <section class="panel"><h2>Ensemble</h2>
      <p>Each game is an ensemble of two team-strength layers: a <b>player-impact layer</b> (box-score plus/minus for the players expected to play, weighted by the minutes engine) and a <b>results layer</b> (a Kalman-filtered team rating from margins). They are mixed with weight α toward the player layer early in the season. Context terms (home court, altitude, rest, travel, time zone) shift the expected margin. A minutes engine sets every player's minutes, including blowout and foul-trouble risk and caps for players returning from injury. Uncertain players (play probability between 3% and 97%) are enumerated into a scenario tree, so every Questionable or Doubtful player gets an if-plays / if-sits panel.</p>
      <p>The game is simulated 10,000 times. The <b>headline</b> win probability is anchored to the market: a logit blend of the no-vig market price and the independent model with weight λ on the model. The independent model is always shown next to it, with a disagreement flag when the two differ by more than 0.35 margin SDs.</p>
      <p>Player projections (MIN, PTS, REB, AST, 3PM, PRA) come from shrunk per-36 rates times projected minutes, with vacated usage reassigned. Splits are shown with their sample size and are display-only unless they pass the trend tests.</p></section>
    <section class="panel"><h2>Priors in use</h2>${tbl(['Parameter', 'Value'], priors.map(([k, x]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(x)}</td></tr>`))}<p class="note">All of these are starting values. The walk-forward backtest re-estimates them; until then the app labels every screen "priors — backtest pending".</p><p><a class="btn" href="method/backtest.html">Backtest report</a></p></section>
    <section class="panel"><h2>3× table</h2>${threeX}</section>`;
}
function viewHealth() {
  const calls = S.snapshot?.source?.calls || [];
  const swc = navigator.serviceWorker?.controller ? 'controlling this page' : (S.sw.reg ? 'registered (takes control on next load)' : S.sw.status);
  return `<h1>Health</h1>
    <section class="panel"><h2>This device</h2>${tbl(['Check', 'Status'], [
      ['Network', navigator.onLine ? 'online' : 'offline'], ['Data source in use', sourceLabel()], ['Snapshot generatedAt', S.snapshot?.generatedAt || '–'],
      ['ESPN scoreboard (browser)', `${S.espn.status}${S.espn.at ? ` · ${ago(Date.now() - S.espn.at)} ago · ${S.espn.ms} ms` : ''}`],
      ['ESPN injuries (browser)', `${S.inj.status}${S.inj.at ? ` · ${S.inj.count} listed · ${ago(Date.now() - S.inj.at)} ago` : ''}`],
      ['ESPN game summaries', [...S.sumStatus.entries()].map(([k, v]) => `${k}: ${v}`).join(', ') || 'none opened'],
      ['IndexedDB', IDB.status], ['Service worker', swc], ['In-browser simulator', S.simStatus + (S.recomputed.size ? ` · ${S.recomputed.size} game(s)` : '')],
      ['Web Push', 'PushManager' in window ? (S.config.vapidPublicKey ? 'supported' : 'supported, not configured') : 'not supported here'],
    ].map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`))}</section>
    <section class="panel"><h2>Snapshot writers (race)</h2>${S.race.length ? tbl(['Writer', 'URL', 'Status', 'generatedAt', 'ms', 'bytes'], S.race.map(r => `<tr><td>${esc(r.label)}${r.swCache ? ` <span class="muted">(SW ${esc(r.swCache)})</span>` : ''}</td><td class="mono" style="font-size:11px;overflow-wrap:anywhere">${esc(r.url)}</td><td class="${r.ok ? 's-p' : 's-out'}">${esc(r.ok ? 'ok' : r.status)}${r.error ? ` · ${esc(r.error)}` : ''}</td><td class="mono">${esc(r.generatedAt || '–')}</td><td class="n">${esc(r.ms)}</td><td class="n">${esc(r.bytes)}</td></tr>`)) : '<p class="note">Race not run yet.</p>'}</section>
    <section class="panel"><h2>Server fetches for this snapshot</h2><p class="note">Writer: ${esc(S.snapshot?.source?.writer || '–')} · ESPN host ${esc(S.snapshot?.source?.espnHost || '–')} · status ${esc(S.snapshot?.source?.status || '–')}</p>
      ${calls.length ? tbl(['Name', 'Host', 'Status', 'Bytes', 'ms'], calls.map(c => `<tr><td>${esc(c.name)}</td><td class="mono">${esc(c.host || (c.url ? new URL(c.url).host : ''))}</td><td class="${c.ok === false ? 's-out' : 's-p'}">${esc(c.status)}</td><td class="n">${esc(c.bytes)}</td><td class="n">${esc(c.ms)}</td></tr>`)) : '<p class="note">No call log in this snapshot.</p>'}</section>`;
}

// ---------------------------------------------------------------- render + routing
function render() {
  renderBadge();
  const games = currentGames();
  const v = $('view-' + S.tab); if (!v) return;
  const html = { slate: viewSlate, games: viewGames, players: viewPlayers, trends: viewTrends, changes: viewChanges, alerts: viewAlerts, method: viewMethod, health: viewHealth }[S.tab](games);
  // keep scroll position inside tall tables across refreshes
  const scrolls = [...v.querySelectorAll('.tablewrap')].map(t => [t.scrollTop, t.scrollLeft]);
  v.innerHTML = html;
  v.querySelectorAll('.tablewrap').forEach((t, i) => { if (scrolls[i]) [t.scrollTop, t.scrollLeft] = scrolls[i]; });
}
function route() {
  const [tab, arg] = location.hash.replace('#', '').split('/');
  S.tab = TABS.includes(tab) ? tab : 'slate';
  if (S.tab === 'games' && arg) S.gameSel = arg;
  for (const s of document.querySelectorAll('.view')) s.hidden = s.dataset.view !== S.tab;
  for (const a of document.querySelectorAll('#tabs a')) a.toggleAttribute('aria-current', a.dataset.tab === S.tab) || a.setAttribute('aria-current', a.dataset.tab === S.tab ? 'page' : 'false');
  for (const a of document.querySelectorAll('#tabs a')) { if (a.dataset.tab === S.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  if (S.tab === 'method' && S.threeX === undefined) loadThreeX();
  if (S.tab === 'changes') setTimeout(saveSeen, 4000);
  render(); window.scrollTo(0, 0);
}
async function loadThreeX() { S.threeX = null; const r = await fetchT('./data/3x.json', 5000); if (r.ok) { try { S.threeX = JSON.parse(r.text); } catch {} } if (S.tab === 'method') render(); }

document.addEventListener('toggle', e => {
  const d = e.target; if (!(d instanceof HTMLDetailsElement) || !d.dataset.id) return;
  const id = d.dataset.id;
  if (d.open) { S.open.add(id); const body = d.querySelector('.dd'); if (body && !body.innerHTML.trim()) { const g = currentGames().find(x => x.id === id); if (g) body.innerHTML = deepDive(g); } }
  else if (S.tab !== 'games') S.open.delete(id);
}, true);
document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.game) { location.hash = '#games/' + b.dataset.game; return; }
  if (b.dataset.sort) { const k = b.dataset.sort; S.playerSort = { key: k, dir: S.playerSort.key === k ? -S.playerSort.dir : (['name', 'team', 'opp', 'status'].includes(k) ? 1 : -1) }; render(); return; }
  const act = b.dataset.act;
  if (act === 'prev' || act === 'next') { setDay(shiftDay(S.day, act === 'prev' ? -1 : 1), false); }
  else if (act === 'today') setDay(slateToday(), true);
  else if (act === 'snapday' && S.snapshot?.slateDate) setDay(S.snapshot.slateDate, false);
  else if (act === 'refresh') { b.disabled = true; await refreshAll(true); }
  else if (act === 'push') enablePush();
});
document.addEventListener('change', e => {
  const s = e.target;
  if (s.dataset.ff) { const gid = s.closest('.filters').dataset.gid; const f = { ...(S.factorFilter.get(gid) || { group: 'all', inp: 'all' }), [s.dataset.ff]: s.value }; S.factorFilter.set(gid, f);
    const secEl = document.getElementById('factors-' + gid); const g = currentGames().find(x => x.id === gid);
    if (secEl && g) { secEl.innerHTML = `<h3><span class="secnum">7</span>Factor table</h3>` + factorTable(g); secEl.querySelector(`[data-ff="${s.dataset.ff}"]`)?.focus(); } }
  else if (s.hasAttribute('data-pteam')) { S.playerTeam = s.value; render(); }
});
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- push (Home Screen app, iOS 16.4+)
function b64uToBytes(s) { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); }
async function enablePush() {
  const set = t => { S.push.status = t; const el = $('pushStatus'); if (el) el.textContent = t; };
  try {
    if (!S.config.vapidPublicKey) return set("Push isn't configured yet.");
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return set('This browser has no web push. On iPhone, open the app from the Home Screen (iOS 16.4+).');
    const perm = await Notification.requestPermission(); if (perm !== 'granted') return set('Notifications were not allowed. Change it in iPhone Settings → Notifications → Matchup Lab.');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(S.config.vapidPublicKey) });
    const w = (S.config.workerUrl || '').replace(/\/+$/, '');
    const res = await fetch(`${w}/push/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, at: new Date().toISOString() }) });
    set(res.ok ? 'Alerts are on for this iPhone.' : `Subscribed, but the server answered ${res.status}. Try again later.`);
  } catch (e) { set('Could not enable alerts: ' + (e.message || e)); }
}

// ---------------------------------------------------------------- load chain + refresh loop
function setBanner(text, crit = false) { const b = $('banner'); if (!text) { b.hidden = true; return; } b.hidden = false; b.className = 'banner' + (crit ? ' crit' : ''); b.textContent = text; }
async function loadSnapshotChain() {
  const best = await raceSnapshots();
  if (best) {
    const offline = best.swCache === 'offline' || !navigator.onLine;
    await acceptSnapshot(best.data, offline ? 'offline cache' : best.label, best.url);
    return true;
  }
  const saved = await idbGet('snapshot');                      // 3) IndexedDB last-good copy
  if (saved?.snap) { await acceptSnapshot(saved.snap, 'on-phone copy', saved.url); return true; }
  return false;                                                 // 4) the SW cache already answered inside the race if it could
}
let busy = false;
async function refreshAll(force = false) {
  if (busy) return; busy = true;
  try {
    const tasks = [FIXTURE ? Promise.resolve(false) : loadEspn(S.day).then(render), loadSnapshotChain()];
    const [, gotSnap] = await Promise.all(tasks);
    if (!gotSnap && S.espn.status !== 'ok') setBanner(navigator.onLine ? 'No snapshot writer answered and ESPN is unreachable. Retrying on the next refresh.' : 'Offline and no saved copy on this iPhone yet. Open the app once while online.', true);
    else if (!gotSnap) setBanner('Snapshot writers are down; showing live ESPN scores and lines only. Engine numbers return when a writer answers.');
    else if (!['Worker', 'Pages', 'Supabase', 'Fixture'].includes(S.snap.label)) setBanner(`Showing the ${S.snap.label} from ${S.snapshot.generatedAt ? etClock(new Date(S.snapshot.generatedAt).getTime()) : 'earlier'}. ${navigator.onLine ? 'Writers did not answer.' : 'You are offline.'}`);
    else setBanner('');
    if (S.seenDiff === null) await computeSeenDiff(currentGames());
    scheduleSim();
  } finally { busy = false; render(); if (force) schedule(); }
}
function schedule() {
  for (const t of S.timers) clearTimeout(t); S.timers = [];
  if (document.hidden) return;                                  // pause when hidden
  const anyLive = currentGames().some(g => g.state === 'in');
  const soon = currentGames().some(g => g.state === 'pre' && new Date(g.date) - Date.now() < 30 * 60000);
  S.timers.push(setTimeout(async () => { await refreshAll(); schedule(); }, anyLive || soon ? 60000 : 300000));
  if (!FIXTURE) S.timers.push(setTimeout(async () => { await loadInjuries(); render(); }, S.inj.at ? Math.max(1000, 15 * 60000 - (Date.now() - S.inj.at)) : 15 * 60000));
}
function setDay(d, follow) { S.day = d; S.followToday = follow; S.open.clear(); S.summaries.clear(); S.sumStatus.clear(); S.espn.games = []; S.espn.day = null; render(); refreshAll(true); }
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { for (const t of S.timers) clearTimeout(t); S.timers = []; saveSeen(); }
  else refreshAll(true);
});
window.addEventListener('online', () => refreshAll(true));
window.addEventListener('offline', render);
setInterval(() => {                                             // 6 AM ET roll + keep ages/lock countdowns fresh
  if (S.followToday && !FIXTURE && slateToday() !== S.day) setDay(slateToday(), true);
  else renderBadge();
}, 30000);

async function registerSW() {
  if (!('serviceWorker' in navigator)) { S.sw.status = 'not supported'; return; }
  try { S.sw.reg = await navigator.serviceWorker.register('./sw.js', { scope: './' }); S.sw.status = 'registered'; }
  catch (e) { S.sw.status = 'failed: ' + e.message; }
}
async function boot() {
  route();
  registerSW();
  const c = await fetchT('./config.json', 4000);
  if (c.ok) { try { Object.assign(S.config, JSON.parse(c.text)); } catch {} }
  await refreshAll(true);
  if (!FIXTURE) { loadInjuries().then(ok => { if (ok) render(); }); }
}
boot();
