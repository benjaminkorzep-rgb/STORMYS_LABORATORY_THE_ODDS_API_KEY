// Fallback chains + health checks. Plain ES module, zero deps, no node: imports.
//
// runChain(name, links, ctx) tries links in order and returns the first link whose result is ok AND
// non-empty, logging every attempt:
//   { ok, data, servedBy, chain, attempts: [{ name, status, ok, ms, bytes, host, error }] }
// A link is { name, run: (fetchImpl, ctx) => Promise<AdapterResult>, accept?: (result) => boolean }.
// ctx: { fetchImpl, date, eventId, teamId, season, athleteId, nbaPlayerId, brefPlayerId, nbaGameId, oddsApiKey, now }

import * as espn from './adapters/espn.js';
import {
  EXTRA_ADAPTERS,
  actionNetworkInjuries,
  actionNetworkScoreboard,
  nbaInjuryReportLatest,
  nbaDailyLineups,
  rotowireLineups,
  nbaOdds,
  theOddsApiOdds,
  pbpstatsPlayerGameLogs,
  brefGamelog,
  pbpstatsLiveGames,
  nbaPlayByPlay,
  nbaRefAssignments,
  nbastufferRefStats,
  nbaTodaysScoreboard,
  brefYear,
  seasonFor,
} from './adapters/extra.js';
import { hostOf } from './adapters/http.js';

/** true when data carries something usable (non-empty array somewhere at top level, or any keys). */
export function nonEmpty(data) {
  if (data == null) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data !== 'object') return data !== '';
  const vals = Object.values(data);
  const arrays = vals.filter(Array.isArray);
  if (arrays.length) return arrays.some((a) => a.length > 0);
  return vals.length > 0;
}

const skip = (name, why) => ({ ok: false, status: 0, bytes: 0, ms: 0, host: '', url: '', data: null, error: `skipped: ${why}` });

export async function runChain(name, links, ctx = {}) {
  const f = ctx.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const attempts = [];
  for (const link of links) {
    let r;
    try {
      r = await link.run(f, ctx);
    } catch (e) {
      r = { ok: false, status: 0, bytes: 0, ms: 0, host: '', url: '', data: null, error: `threw: ${String((e && e.message) || e)}` };
    }
    r = r || skip(link.name, 'no result');
    let good = false;
    try {
      good = !!r.ok && (link.accept ? !!link.accept(r) : nonEmpty(r.data));
    } catch {
      good = false;
    }
    attempts.push({ name: link.name, status: r.status ?? 0, ok: good, ms: r.ms ?? 0, bytes: r.bytes ?? 0, host: r.host || hostOf(r.url || ''), error: good ? null : r.error || (r.ok ? 'empty' : 'failed') });
    if (good) return { ok: true, chain: name, data: r.data, servedBy: link.name, attempts };
  }
  return { ok: false, chain: name, data: null, servedBy: null, attempts };
}

const espnSeason = (ctx) => ctx.espnSeason ?? brefYear(ctx.season || seasonFor(ctx.date || new Date()));
const need = (ctx, key, fn) => (ctx[key] == null || ctx[key] === '' ? skip('', `${key} missing`) : fn());

/** Build chain link lists. `E` is the ESPN adapter module (injectable for tests). */
export function buildChains(E = espn) {
  return {
    injuries: [
      { name: 'espnInjuries', run: (f) => E.espnInjuries(f) },
      { name: 'actionNetworkInjuries', run: (f) => actionNetworkInjuries(f) },
      { name: 'nbaInjuryPdf', run: (f, c) => nbaInjuryReportLatest(f, { now: c.now || new Date() }) },
    ],
    lineups: [
      { name: 'nbaDailyLineups', run: (f, c) => nbaDailyLineups(f, { date: c.date }), accept: (r) => (r.data.games || []).some((g) => (g.home && g.home.players.length) || (g.away && g.away.players.length)) },
      { name: 'rotowireLineups', run: (f) => rotowireLineups(f), accept: (r) => (r.data.games || []).some((g) => g.home.starters.length || g.away.starters.length) },
      { name: 'espnDepthChart', run: (f, c) => need(c, 'teamId', () => E.espnDepthChart(f, { teamId: c.teamId, season: espnSeason(c) })) },
    ],
    odds: [
      { name: 'espnCoreOdds', run: (f, c) => need(c, 'eventId', () => E.espnCoreOdds(f, { eventId: c.eventId })) },
      { name: 'actionNetworkScoreboard', run: (f, c) => actionNetworkScoreboard(f, { date: c.date }), accept: (r) => (r.data.games || []).some((g) => g.books.length || g.consensus) },
      { name: 'nbaOdds', run: (f) => nbaOdds(f), accept: (r) => (r.data.games || []).some((g) => g.books.length) },
      { name: 'theOddsApi', run: (f, c) => need(c, 'oddsApiKey', () => theOddsApiOdds(f, { apiKey: c.oddsApiKey })) },
    ],
    gamelogs: [
      { name: 'espnGamelog', run: (f, c) => need(c, 'athleteId', () => E.espnGamelog(f, { athleteId: c.athleteId, season: espnSeason(c) })) },
      { name: 'pbpstatsGameLogs', run: (f, c) => need(c, 'nbaPlayerId', () => pbpstatsPlayerGameLogs(f, { entityId: c.nbaPlayerId, season: c.season })) },
      { name: 'brefGamelog', run: (f, c) => need(c, 'brefPlayerId', () => brefGamelog(f, { playerId: c.brefPlayerId, season: c.season })) },
    ],
    pbp: [
      { name: 'espnSummary', run: (f, c) => need(c, 'eventId', () => E.espnSummary(f, { eventId: c.eventId })) },
      { name: 'pbpstatsLive', run: (f) => pbpstatsLiveGames(f) },
      { name: 'nbaPlayByPlay', run: (f, c) => need(c, 'nbaGameId', () => nbaPlayByPlay(f, { gameId: c.nbaGameId })), accept: (r) => r.data.actions.length > 0 },
    ],
    referees: [
      { name: 'espnOfficials', run: (f, c) => need(c, 'eventId', () => E.espnOfficials(f, { eventId: c.eventId })) },
      { name: 'nbaRefAssignments', run: (f) => nbaRefAssignments(f), accept: (r) => r.data.games.length > 0 },
      { name: 'nbastufferRefStats', run: (f, c) => nbastufferRefStats(f, { season: c.season }), accept: (r) => r.data.referees.length > 0 },
    ],
  };
}

export const CHAIN_NAMES = ['injuries', 'lineups', 'odds', 'gamelogs', 'pbp', 'referees'];
let _chains = null;
export const CHAINS = new Proxy({}, { get: (_, k) => (_chains || (_chains = buildChains()))[k], ownKeys: () => CHAIN_NAMES, getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });

/** Run a named chain: runNamedChain('odds', { fetchImpl, date, eventId }). */
export function runNamedChain(name, ctx = {}, E) {
  const links = (E ? buildChains(E) : CHAINS)[name];
  if (!links) return Promise.resolve({ ok: false, chain: name, data: null, servedBy: null, attempts: [], error: `unknown chain ${name}` });
  return runChain(name, links, ctx);
}

// ---------------------------------------------------------------- health
// ESPN adapters live in espn.js (owned elsewhere); their descriptors are kept here so the Health tab
// covers every adapter in one place.
const ESPN_HEALTH = [
  { name: 'espnScoreboard', params: (c) => ({ date: c.date }), chains: [] },
  { name: 'espnSummary', params: (c) => ({ eventId: c.eventId }), chains: ['pbp'], needs: 'eventId' },
  { name: 'espnInjuries', params: () => ({}), chains: ['injuries'] },
  { name: 'espnStandings', params: () => ({}), chains: [] },
  { name: 'espnRoster', params: (c) => ({ team: c.team || c.teamId }), chains: [], needs: 'teamId' },
  { name: 'espnSchedule', params: (c) => ({ team: c.team || c.teamId, season: espnSeason(c) }), chains: [], needs: 'teamId' },
  { name: 'espnGamelog', params: (c) => ({ athleteId: c.athleteId, season: espnSeason(c) }), chains: ['gamelogs'], needs: 'athleteId' },
  { name: 'espnSplits', params: (c) => ({ athleteId: c.athleteId }), chains: [], needs: 'athleteId' },
  { name: 'espnCoreOdds', params: (c) => ({ eventId: c.eventId }), chains: ['odds'], needs: 'eventId' },
  { name: 'espnPropBets', params: (c) => ({ eventId: c.eventId }), chains: [], needs: 'eventId' },
  { name: 'espnOfficials', params: (c) => ({ eventId: c.eventId }), chains: ['referees'], needs: 'eventId' },
  { name: 'espnDepthChart', params: (c) => ({ teamId: c.teamId, season: espnSeason(c) }), chains: ['lineups'], needs: 'teamId' },
  { name: 'espnPowerIndex', params: (c) => ({ season: espnSeason(c) }), chains: [] },
];

function firstEspnEvent(d) {
  if (!d) return {};
  const ev = (d.events && d.events[0]) || (d.games && d.games[0]) || (Array.isArray(d) && d[0]) || null;
  if (!ev) return {};
  const comp = ev.competitions && ev.competitions[0];
  const home = comp && (comp.competitors || []).find((x) => x.homeAway === 'home');
  return { eventId: ev.id, teamId: (home && (home.id || (home.team && home.team.id))) || (ev.home && ev.home.id) || undefined };
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) {
      const k = i++;
      out[k] = await tasks[k]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
}

/**
 * Probe one call per adapter. Returns rows for the Health tab:
 * [{ adapter, source, chains, serverOnly, host, url, ok, status, ms, bytes, error, skipped }]
 * Missing ids (eventId, teamId, nbaGameId) are discovered from espnScoreboard / nbaTodaysScoreboard.
 */
export async function healthCheckAll(fetchImpl, { date, concurrency = 6, E = espn, ...rest } = {}) {
  const ctx = { date: date || new Date(), ...rest };
  if (!ctx.eventId || !ctx.teamId) {
    try {
      const sb = E.espnScoreboard ? await E.espnScoreboard(fetchImpl, { date: ctx.date }) : null;
      const d = firstEspnEvent(sb && sb.data);
      ctx.eventId = ctx.eventId || d.eventId;
      ctx.teamId = ctx.teamId || d.teamId;
    } catch {
      /* ignore */
    }
  }
  if (!ctx.nbaGameId) {
    const nb = await nbaTodaysScoreboard(fetchImpl);
    if (nb.ok && nb.data.games[0]) ctx.nbaGameId = nb.data.games[0].gameId;
  }
  if (ctx.nbaGameId && !ctx.gameId) ctx.gameId = ctx.nbaGameId;
  const row = (adapter, source, d, r, skipped = false) => ({
    adapter,
    source,
    chains: d.chains || [],
    serverOnly: source === 'espn' ? false : !!d.serverOnly,
    verified: d.verified !== false,
    host: r.host || hostOf(r.url || ''),
    url: r.url || '',
    ok: !!r.ok,
    status: r.status ?? 0,
    ms: r.ms ?? 0,
    bytes: r.bytes ?? 0,
    error: r.error || null,
    skipped,
  });
  const tasks = [];
  for (const d of ESPN_HEALTH) {
    tasks.push(async () => {
      const fn = E[d.name];
      if (typeof fn !== 'function') return row(d.name, 'espn', d, { error: 'adapter not exported' }, true);
      if (d.needs && ctx[d.needs] == null) return row(d.name, 'espn', d, { error: `skipped: ${d.needs} missing` }, true);
      try {
        return row(d.name, 'espn', d, (await fn(fetchImpl, d.params(ctx))) || {});
      } catch (e) {
        return row(d.name, 'espn', d, { error: `threw: ${e && e.message}` });
      }
    });
  }
  for (const [name, d] of Object.entries(EXTRA_ADAPTERS)) {
    tasks.push(async () => {
      if (d.needs && ctx[d.needs] == null) return row(name, 'extra', d, { url: d.url(ctx), error: `skipped: ${d.needs} missing` }, true);
      try {
        return row(name, 'extra', d, (await d.fn(fetchImpl, d.params(ctx))) || {});
      } catch (e) {
        return row(name, 'extra', d, { url: d.url(ctx), error: `threw: ${e && e.message}` });
      }
    });
  }
  return pool(tasks, concurrency);
}
