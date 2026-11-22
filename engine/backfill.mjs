#!/usr/bin/env node
// APPENDIX B §11 historical backfill from ESPN (Node 20, GitHub Actions).
// Walks every date of every season window from 2019-10-22 to yesterday (ET), fetches the ESPN scoreboard
// (?dates=YYYYMMDD) and each event summary (box score, pickcenter odds, officials), and writes one compact
// JSON per date to data-cache/espn/YYYY/MM/DD.json. Resumable (existing files are skipped), rate-limited to
// ≤3 req/s, stops after BACKFILL_MINUTES (default 40) so it continues across nightly runs, and records which
// seasons are complete in data-cache/espn/progress.json.
//
// NOT historical in ESPN: injury reports. The summary's `injuries` block is the CURRENT report, not the T-60
// snapshot, so it is NOT stored. T-60 injury snapshots must come from the archived official PDFs
// (core/adapters/extra.js injuryReportSlotUrl: https://ak-static.cms.nba.com/referee/injury/Injury-Report_
// YYYY-MM-DD_HH_MMAP.pdf, 15-minute slots). Those are NOT fetched yet — UNVERIFIED (archive depth and the
// PDF parser in core/adapters/pdf.js are untested on real files).
//
// Odds: ESPN pickcenter after a game shows one provider's last line (≈ closing line, single book, not
// consensus). Open lines are parsed when the payload carries them. Shapes vary by season — UNVERIFIED.
import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = join(ROOT, 'data-cache', 'espn');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';

// Season windows (opening night → last possible Finals date). role: tune | freeze | score | live.
// flagged = bubble / limited-fan seasons: home-court advantage weighted 0.5 in the backtest.
export const SEASONS = Object.freeze([
  { season: '2019-20', start: '2019-10-22', end: '2020-10-11', role: 'tune', flagged: true, flagFrom: '2020-07-30', note: 'Orlando bubble from 2020-07-30' },
  { season: '2020-21', start: '2020-12-22', end: '2021-07-22', role: 'tune', flagged: true, flagFrom: '2020-12-22', note: 'limited / no fans' },
  { season: '2021-22', start: '2021-10-19', end: '2022-06-19', role: 'tune' },
  { season: '2022-23', start: '2022-10-18', end: '2023-06-18', role: 'tune' },
  { season: '2023-24', start: '2023-10-24', end: '2024-06-23', role: 'tune' },
  { season: '2024-25', start: '2024-10-22', end: '2025-06-25', role: 'freeze' },
  { season: '2025-26', start: '2025-10-21', end: '2026-06-30', role: 'score' },
  { season: '2026-27', start: '2026-10-20', end: '2027-06-30', role: 'live' },
]);
export const SCORE_SEASON = '2025-26';

export function seasonOfDate(dateKey) {
  return SEASONS.find(s => dateKey >= s.start && dateKey <= s.end) || null;
}
export function addDays(dateKey, n) {
  const d = new Date(dateKey + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export function etToday(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function seasonDates(s, lastDate) {
  const out = []; const end = s.end < lastDate ? s.end : lastDate;
  for (let d = s.start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}
export const datePath = (dateKey, dir = CACHE_DIR) => join(dir, dateKey.slice(0, 4), dateKey.slice(5, 7), dateKey.slice(8, 10) + '.json');

// ---------------------------------------------------------------- rate limiter (≤ maxPerSec)
export function createLimiter(maxPerSec = 3, { now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const gap = Math.ceil(1000 / maxPerSec); let next = 0;
  return async () => { const t = now(); const wait = Math.max(0, next - t); next = Math.max(t, next) + gap; if (wait) await sleep(wait); };
}

// ---------------------------------------------------------------- parsing (defensive; ESPN shapes vary by season)
const num = v => { if (v == null || v === '') return null; const n = Number(String(v).replace('+', '')); return Number.isFinite(n) ? n : null; };
const VALID_TYPES = new Set([2, 3, 5]); // regular, postseason, play-in

export function compactScoreboardEvent(ev) {
  const comp = ev.competitions?.[0] || {}; const cs = comp.competitors || [];
  const side = h => cs.find(c => c.homeAway === h) || {};
  const team = c => ({ id: c.team?.id ?? c.id ?? null, abbr: c.team?.abbreviation ?? null, score: num(c.score), winner: c.winner ?? null });
  const seasonType = num(ev.season?.type ?? comp.type?.id);
  return { id: String(ev.id), date: ev.date || comp.date, seasonType, neutral: !!comp.neutralSite,
    venue: comp.venue ? { name: comp.venue.fullName || null, city: comp.venue.address?.city || null } : null,
    completed: !!(comp.status?.type?.completed ?? ev.status?.type?.completed), state: comp.status?.type?.state ?? ev.status?.type?.state ?? null,
    home: team(side('home')), away: team(side('away')) };
}

const STAT_KEYS = { MIN: 'min', PTS: 'pts', REB: 'reb', OREB: 'oreb', DREB: 'dreb', AST: 'ast', STL: 'stl', BLK: 'blk', TO: 'tov', PF: 'pf', '+/-': 'pm', FG: 'fg', '3PT': 'fg3', FT: 'ft' };
const KEY_ALIASES = { minutes: 'MIN', points: 'PTS', rebounds: 'REB', offensiveRebounds: 'OREB', defensiveRebounds: 'DREB', assists: 'AST', steals: 'STL', blocks: 'BLK', turnovers: 'TO', fouls: 'PF', plusMinus: '+/-', 'fieldGoalsMade-fieldGoalsAttempted': 'FG', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted': '3PT', 'freeThrowsMade-freeThrowsAttempted': 'FT' };
export function parseBoxPlayers(box) {
  const out = [];
  for (const tp of box?.players || []) {
    const abbr = tp.team?.abbreviation ?? null, teamId = tp.team?.id ?? null;
    for (const st of tp.statistics || []) {
      const labels = (st.labels && st.labels.length ? st.labels : (st.keys || st.names || []).map(k => KEY_ALIASES[k] || k));
      for (const a of st.athletes || []) {
        const r = { id: a.athlete?.id ?? null, name: a.athlete?.displayName ?? null, teamId, teamAbbr: abbr, starter: !!a.starter, dnp: !!a.didNotPlay || !(a.stats && a.stats.length) };
        (a.stats || []).forEach((v, i) => {
          const k = STAT_KEYS[labels[i]]; if (!k) return;
          if (k === 'fg' || k === 'fg3' || k === 'ft') { const [m, at] = String(v).split('-').map(num); r[k === 'fg' ? 'fgm' : k === 'fg3' ? 'fg3m' : 'ftm'] = m; r[k === 'fg' ? 'fga' : k === 'fg3' ? 'fg3a' : 'fta'] = at; }
          else if (k === 'min') r.min = num(String(v).split(':')[0]);
          else r[k] = num(v);
        });
        if (r.dnp) r.min = 0;
        out.push(r);
      }
    }
  }
  return out;
}
function lineOf(x) { return num(x?.line ?? x?.alternateDisplayValue ?? x?.american ?? x?.value ?? x); }
export function parsePickcenter(summary) {
  const pcs = summary?.pickcenter || []; const odds = summary?.odds || [];
  const pc = pcs[0] || odds[0]; if (!pc) return null;
  let spreadHome = num(pc.spread ?? pc.details?.match?.(/-?\d+(\.\d+)?/)?.[0]);
  const hFav = pc.homeTeamOdds?.favorite, aFav = pc.awayTeamOdds?.favorite;
  if (spreadHome != null && hFav === true && spreadHome > 0) spreadHome = -spreadHome;
  if (spreadHome != null && aFav === true && hFav !== true && spreadHome < 0) spreadHome = -spreadHome;
  const close = { spreadHome, total: num(pc.overUnder), mlHome: num(pc.homeTeamOdds?.moneyLine ?? pc.moneyline?.home?.close?.odds), mlAway: num(pc.awayTeamOdds?.moneyLine ?? pc.moneyline?.away?.close?.odds) };
  const open = {
    spreadHome: lineOf(pc.pointSpread?.home?.open) ?? lineOf(pc.homeTeamOdds?.open?.pointSpread),
    total: num(String(pc.total?.over?.open?.line ?? '').replace(/^[ou]/i, '')) ?? lineOf(pc.open?.total),
    mlHome: num(pc.moneyline?.home?.open?.odds ?? pc.homeTeamOdds?.open?.moneyLine?.american),
    mlAway: num(pc.moneyline?.away?.open?.odds ?? pc.awayTeamOdds?.open?.moneyLine?.american),
  };
  const hasOpen = Object.values(open).some(v => v != null);
  return { provider: pc.provider?.name ?? null, close, open: hasOpen ? open : null, verified: false };
}
export function compactEvent(sbEvent, summary) {
  const ev = compactScoreboardEvent(sbEvent);
  const players = parseBoxPlayers(summary?.boxscore);
  const officials = (summary?.gameInfo?.officials || []).map(o => o.displayName || o.fullName).filter(Boolean);
  return { ...ev, odds: summary ? parsePickcenter(summary) : null, officials, players, injuries: null,
    injuriesNote: 'ESPN injuries are not historical; T-60 snapshots must come from archived official PDFs (not fetched, UNVERIFIED)' };
}

// ---------------------------------------------------------------- progress
export async function computeProgress({ dir = CACHE_DIR, now = new Date() } = {}) {
  const last = addDays(etToday(now), -1);
  const seasons = {}; let total = 0, done = 0;
  for (const s of SEASONS) {
    if (s.start > last) { seasons[s.season] = { role: s.role, dates: 0, cached: 0, complete: false, pct: 0, note: 'not started' }; continue; }
    const ds = seasonDates(s, last); const have = ds.filter(d => existsSync(datePath(d, dir))).length;
    const full = s.end <= last && have === ds.length;
    seasons[s.season] = { role: s.role, dates: ds.length, cached: have, complete: full, pct: ds.length ? Math.round(1000 * have / ds.length) / 10 : 0, through: s.end <= last ? s.end : last };
    if (s.role !== 'live') { total += ds.length; done += have; }
  }
  return { updatedAt: now.toISOString(), throughDate: last, pct: total ? Math.round(1000 * done / total) / 10 : 0,
    seasonsComplete: Object.entries(seasons).filter(([, v]) => v.complete).map(([k]) => k), seasons,
    injuries: 'NOT historical in ESPN; official PDF archive not fetched (UNVERIFIED)' };
}

// ---------------------------------------------------------------- runner
async function getJson(fetchImpl, url, limiter, timeoutMs = 15000) {
  await limiter();
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null; const t = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ac?.signal });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, status: r.status, data: await r.json() };
  } catch (e) { return { ok: false, status: 0, error: String(e?.message || e) }; }
  finally { if (t) clearTimeout(t); }
}
async function writeAtomic(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.tmp'; await writeFile(tmp, JSON.stringify(obj)); await rename(tmp, path);
}

export async function runBackfill({ fetchImpl = globalThis.fetch, dir = CACHE_DIR, now = new Date(), budgetMs = (Number(process.env.BACKFILL_MINUTES) || 40) * 60000,
  maxPerSec = 3, limiter = createLimiter(maxPerSec), clock = () => Date.now(), log = console.log, maxConsecutiveFailures = 12, seasons = null } = {}) {
  const t0 = clock(); const last = addDays(etToday(now), -1);
  const stats = { datesWritten: 0, datesSkipped: 0, events: 0, requests: 0, failures: 0, stoppedFor: null };
  let consecutive = 0;
  outer: for (const s of SEASONS) {
    if (seasons && !seasons.includes(s.season)) continue;
    if (s.start > last) continue;
    for (const d of seasonDates(s, last)) {
      const path = datePath(d, dir);
      if (existsSync(path)) { stats.datesSkipped++; continue; }
      if (clock() - t0 > budgetMs) { stats.stoppedFor = 'time budget'; break outer; }
      stats.requests++;
      const sb = await getJson(fetchImpl, `${SITE}/scoreboard?dates=${d.replace(/-/g, '')}&limit=100`, limiter);
      if (!sb.ok) { stats.failures++; if (++consecutive >= maxConsecutiveFailures) { stats.stoppedFor = `${consecutive} consecutive failures (last status ${sb.status}${sb.error ? ' ' + sb.error : ''})`; break outer; } continue; }
      consecutive = 0;
      const evs = (sb.data.events || []).filter(e => VALID_TYPES.has(num(e.season?.type ?? e.competitions?.[0]?.type?.id) ?? 2));
      const events = []; let notFinal = false, summaryFailed = false;
      for (const e of evs) {
        const base = compactScoreboardEvent(e);
        if (!base.completed) { notFinal = true; events.push({ ...base, odds: null, players: [], officials: [], note: 'not completed (postponed/cancelled?)' }); continue; }
        stats.requests++;
        const sm = await getJson(fetchImpl, `${SITE}/summary?event=${e.id}`, limiter);
        if (!sm.ok) { stats.failures++; summaryFailed = true; break; }
        events.push(compactEvent(e, sm.data));
      }
      if (summaryFailed) continue;                                  // never write a partial day; retried next run
      if (notFinal && d >= addDays(last, -2)) continue;              // recent date not final yet: retry next run
      await writeAtomic(path, { date: d, season: s.season, fetchedAt: new Date().toISOString(), source: 'espn site/v2 scoreboard+summary', events });
      stats.datesWritten++; stats.events += events.length;
      if (stats.datesWritten % 10 === 0) log(`[backfill] ${d} (${s.season}) written; ${stats.datesWritten} dates, ${stats.events} events, ${stats.requests} requests, ${Math.round((clock() - t0) / 1000)}s`);
    }
  }
  const progress = await computeProgress({ dir, now });
  await writeAtomic(join(dir, 'progress.json'), progress);
  log(`[backfill] done: ${JSON.stringify(stats)}; overall ${progress.pct}% — seasons complete: ${progress.seasonsComplete.join(', ') || 'none'}`);
  return { stats, progress };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBackfill().catch(e => { console.error(e); process.exit(1); });
}
