// Snapshot builder shared by Writer B (GitHub Actions), Writer C (Supabase) and the browser.
// Writer A (Cloudflare Worker, 10 ms CPU) uses lightRefresh(): it re-fetches live ESPN state and merges it onto
// the newest full snapshot published by B/C, recomputing alerts, changes and line history only.
import { espnScoreboard, espnSummary, espnInjuries } from './adapters/espn.js';
import { gameFromEvent, applySummary, injuriesIndex, engineInput, slateDateET, shiftDate } from './normalize.js';
import { analyzeGame, STATUS_LINE, DEFAULT_LEAGUE, ENGINE_VERSION } from './engine/index.js';
import { LAMBDA_PRIOR } from './engine/market.js';
import { gameParagraphs, slateParagraphs, reasoningEntry } from './narrative.js';

export const SCHEMA_VERSION = 2;
const callRow = (name, r) => ({ name, url: r.url, host: r.host, status: r.status, bytes: r.bytes, ms: r.ms, ok: r.ok, error: r.error || null, attempts: r.attempts || null });

export async function fetchSlate(f, { now = new Date(), calls = [] } = {}) {
  let date = slateDateET(now);
  let sb = await espnScoreboard(f, { date }); calls.push(callRow('espn.scoreboard', sb));
  let events = sb.ok ? sb.data.events || [] : [];
  // Tonight is empty or fully final → show the next slate (up to 3 days ahead).
  for (let k = 1; k <= 3 && sb.ok && (events.length === 0 || events.every(e => e.status?.type?.state === 'post')) && now.getUTCHours() >= 0; k++) {
    if (events.length && !events.every(e => e.status?.type?.state === 'post')) break;
    const next = shiftDate(date, 1); const sb2 = await espnScoreboard(f, { date: next }); calls.push(callRow('espn.scoreboard.next', sb2));
    if (!sb2.ok) break; if ((sb2.data.events || []).length) { if (!events.length || events.every(e => e.status?.type?.state === 'post')) { date = next; events = sb2.data.events; } break; } date = next;
  }
  return { ok: sb.ok, date, events, host: sb.host };
}

function lineHistory(prevGame, g, at) {
  const h = [...(prevGame?.odds?.history || [])];
  const o = g.odds; if (!o) return h;
  const last = h[h.length - 1];
  const pt = { at, spreadHome: o.spreadHome ?? null, total: o.total ?? null, noVigHome: o.noVigHome != null ? Math.round(o.noVigHome * 1000) / 1000 : null };
  if (!last || last.spreadHome !== pt.spreadHome || last.total !== pt.total || last.noVigHome !== pt.noVigHome) h.push(pt);
  return h.slice(-150);
}

export function computeAlerts(games, now = new Date()) {
  const out = []; const t = now.toISOString();
  for (const g of games) {
    const o = g.odds, id = g.id, nm = `${g.away.abbr} @ ${g.home.abbr}`;
    if (g.state === 'pre') {
      const mins = (new Date(g.date) - now) / 60000;
      if (mins <= 60 && mins > -5) out.push({ id: `${id}:lock`, gameId: id, type: 'lock', severity: 'crit', text: `${nm}: lineup lock in ${Math.max(0, Math.round(mins))} min`, at: t });
      if (o?.open) {
        if (o.open.spreadHome != null && o.spreadHome != null && Math.abs(o.spreadHome - o.open.spreadHome) >= 2) out.push({ id: `${id}:spread`, gameId: id, type: 'line', severity: 'warn', text: `${nm}: spread moved ${o.open.spreadHome} → ${o.spreadHome} (home)`, at: t });
        if (o.open.total != null && o.total != null && Math.abs(o.total - o.open.total) >= 3) out.push({ id: `${id}:total`, gameId: id, type: 'line', severity: 'warn', text: `${nm}: total moved ${o.open.total} → ${o.total}`, at: t });
        if (o.open.noVigHome != null && o.noVigHome != null && Math.abs(o.noVigHome - o.open.noVigHome) >= 0.05) out.push({ id: `${id}:ml`, gameId: id, type: 'line', severity: 'warn', text: `${nm}: home win chance ${Math.round(o.open.noVigHome * 100)}% → ${Math.round(o.noVigHome * 100)}% since open`, at: t });
      }
      for (const i of g.injuries || []) if (/question|doubt|day-to-day|game-time/i.test(i.status || '')) out.push({ id: `${id}:inj:${i.id || i.name}`, gameId: id, type: 'injury', severity: /doubt/i.test(i.status) ? 'crit' : 'warn', text: `${i.team} ${i.name}: ${i.status}${i.detail ? ` (${i.detail})` : ''}`, at: t });
    }
  }
  return out;
}

export function diffChanges(prev, next, now = new Date()) {
  const out = []; const at = now.toISOString();
  const pg = new Map((prev?.games || []).map(g => [g.id, g]));
  for (const g of next.games) {
    const p = pg.get(g.id); if (!p) continue;
    const cmp = (field, a, b, why) => { if (a !== b && !(a == null && b == null)) out.push({ gameId: g.id, field, from: a, to: b, why, at }); };
    cmp('state', p.state, g.state, 'game status');
    cmp('spreadHome', p.odds?.spreadHome, g.odds?.spreadHome, 'line move (market)');
    cmp('total', p.odds?.total, g.odds?.total, 'total move (market)');
    const r3 = x => (x == null ? null : Math.round(x * 1000) / 1000);
    cmp('noVigHome', r3(p.odds?.noVigHome), r3(g.odds?.noVigHome), 'moneyline move (market)');
    const pi = new Map((p.injuries || []).map(i => [i.id || i.name, i.status])); for (const i of g.injuries || []) cmp(`status:${i.name}`, pi.get(i.id || i.name) ?? 'not listed', i.status, 'injury report change');
    const w0 = p.analysis?.wp?.headline, w1 = g.analysis?.wp?.headline;
    if (w0 != null && w1 != null && Math.abs(w1 - w0) >= 0.01) out.push({ gameId: g.id, field: 'wpHeadline', from: r3(w0), to: r3(w1), why: 'engine re-run (availability/market inputs changed)', at });
  }
  return out;
}

// Full snapshot (Writers B/C). daily = per-team rosters/logs/schedules built nightly; prev = last published snapshot.
export async function buildSnapshot({ fetchImpl, writer = 'actions', now = new Date(), prev = null, daily = null, trends = null, maxSummaries = 8, league = DEFAULT_LEAGUE, runEngine = true } = {}) {
  const f = fetchImpl || fetch; const calls = [];
  const slate = await fetchSlate(f, { now, calls });
  const inj = await espnInjuries(f); calls.push(callRow('espn.injuries', inj));
  const injIdx = inj.ok ? injuriesIndex(inj.data) : new Map();
  const prevGames = new Map((prev?.games || []).map(g => [g.id, g]));
  let games = slate.events.map(gameFromEvent);
  // Summary rotation: live and soon-tipping games first, then the stalest summaries (≤ maxSummaries ESPN calls).
  const order = [...games].sort((a, b) => rank(a, now) - rank(b, now) || (prevGames.get(a.id)?.summaryAt || '').localeCompare(prevGames.get(b.id)?.summaryAt || ''));
  const fetchIds = new Set(order.filter(g => g.state !== 'post' || !prevGames.get(g.id)?.summaryAt).slice(0, maxSummaries).map(g => g.id));
  const summaries = await Promise.all(games.map(async g => {
    if (!fetchIds.has(g.id)) return null;
    const r = await espnSummary(f, { eventId: g.id }); calls.push(callRow(`espn.summary.${g.id}`, r)); return r.ok ? r.data : null;
  }));
  const at = now.toISOString();
  games = games.map((g, i) => {
    const p = prevGames.get(g.id);
    if (summaries[i]) { applySummary(g, summaries[i]); g.summaryAt = at; }
    else if (p) { // carry forward summary-derived fields
      for (const k of ['bpiHome', 'officials', 'injuries', 'h2h', 'summaryAt']) if (g[k] == null && p[k] != null) g[k] = p[k];
      if (p.odds?.books && g.odds) g.odds.books = g.odds.books?.length > 1 ? g.odds.books : p.odds.books;
      if (p.home?.last5) g.home.last5 = p.home.last5; if (p.away?.last5) g.away.last5 = p.away.last5;
    }
    // league-injury feed overrides per-game injury rows for status (fresher)
    g.injuries = (g.injuries || []).map(x => ({ ...x, status: injIdx.get(x.id)?.status || x.status }));
    if (g.odds) g.odds.history = lineHistory(p, g, at);
    g.dataAgeSec = g.summaryAt ? Math.round((now - new Date(g.summaryAt)) / 1000) : null;
    return g;
  });
  // Engine (§1 game-day loop)
  for (const g of games) {
    if (!runEngine) { g.analysis = prevGames.get(g.id)?.analysis || null; continue; }
    try {
      const input = engineInput(g, daily, injIdx, { league, now });
      g.inputsSummary = { homePlayers: input.home.players.length, awayPlayers: input.away.players.length, market: !!input.market, dailyFile: !!daily };
      g.analysis = analyzeGame(input);
    } catch (e) { g.analysis = prevGames.get(g.id)?.analysis || null; g.engineError = String(e && e.message || e); }
  }
  const snap = {
    schemaVersion: SCHEMA_VERSION, generatedAt: at, slateDate: slate.date,
    source: { writer, espnHost: slate.host, status: calls.every(c => c.ok) ? 'ok' : calls.some(c => c.ok) ? 'partial' : 'error', calls },
    method: { status: 'priors — backtest pending', statusLine: STATUS_LINE, engineVersion: ENGINE_VERSION, lambda: LAMBDA_PRIOR, alphaPlayer: '0.75 → 0.55 by game 40', hca: league.hca, leagueOrtg: league.ortg, leaguePace: league.pace, dailyFileDate: daily?.date || null },
    league, games, narrative: null, alerts: [], changes: [],
    trends: trends || { validated: [], exploratory: [], narrative: [], registrySize: null, lastRetest: null },
  };
  finalize(snap, prev, now);
  return snap;
}

export function finalize(snap, prev, now = new Date()) {
  snap.alerts = computeAlerts(snap.games, now);
  snap.changes = diffChanges(prev, snap, now).concat((prev?.changes || []).filter(c => (now - new Date(c.at)) < 24 * 3600e3)).slice(0, 300);
  const pg = new Map((prev?.games || []).map(g => [g.id, g]));
  for (const g of snap.games) {
    try { g.narrative = { paras: gameParagraphs(g, snap), source: 'rules' }; } catch (e) { g.narrative = { paras: [], source: 'rules', error: String(e) }; }
    const p = pg.get(g.id); const entry = p ? reasoningEntry(p, g) : null;
    g.reasoning = [...(p?.reasoning || [])]; if (entry) g.reasoning.push({ at: snap.generatedAt, text: entry });
    if (!p) g.reasoning.push({ at: snap.generatedAt, text: 'First analysis of this game today: engine run on priors with the current injury report and market line.' });
    g.reasoning = g.reasoning.slice(-60);
  }
  try { snap.narrative = { slate: slateParagraphs(snap, prev), source: 'rules' }; } catch (e) { snap.narrative = { slate: [], source: 'rules', error: String(e) }; }
  return snap;
}

function rank(g, now) {
  if (g.state === 'in') return 0;
  if (g.state === 'pre') { const h = (new Date(g.date) - now) / 3.6e6; return h < 3 ? 1 : 2; }
  return 3;
}

// Writer A: cheap refresh. Fetch scoreboard + injuries (2 calls), merge onto `base` (newest full snapshot).
export async function lightRefresh({ fetchImpl, base, prev, now = new Date(), writer = 'worker' }) {
  const f = fetchImpl || fetch; const calls = [];
  const slate = await fetchSlate(f, { now, calls });
  const inj = await espnInjuries(f); calls.push(callRow('espn.injuries', inj));
  const injIdx = inj.ok ? injuriesIndex(inj.data) : new Map();
  const baseGames = new Map((base?.games || []).map(g => [g.id, g]));
  const prevGames = new Map((prev?.games || []).map(g => [g.id, g]));
  const at = now.toISOString();
  const games = slate.events.map(ev => {
    const live = gameFromEvent(ev); const b = baseGames.get(live.id) || {}; const p = prevGames.get(live.id) || b;
    const g = { ...b, ...live, venue: b.venue || live.venue, home: { ...b.home, ...live.home }, away: { ...b.away, ...live.away } };
    if (live.odds) g.odds = { ...b.odds, ...live.odds, books: b.odds?.books || live.odds.books };
    g.injuries = (b.injuries || []).map(x => ({ ...x, status: injIdx.get(x.id)?.status || x.status }));
    if (g.odds) g.odds.history = lineHistory(p, g, at);
    g.dataAgeSec = b.summaryAt ? Math.round((now - new Date(b.summaryAt)) / 1000) : null;
    return g;
  });
  const snap = { ...(base || {}), schemaVersion: SCHEMA_VERSION, generatedAt: at, slateDate: slate.date, games,
    source: { writer, espnHost: slate.host, status: calls.every(c => c.ok) ? 'ok' : 'partial', calls, analysisFrom: base ? { writer: base.source?.writer, generatedAt: base.generatedAt } : null } };
  snap.method = base?.method || { status: 'priors — backtest pending', statusLine: STATUS_LINE };
  finalize(snap, prev, now);
  return snap;
}
