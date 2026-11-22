// Non-ESPN adapters. Plain ES module, zero deps, no node: imports.
// Every adapter: async (fetchImpl, params) => { ok, status, bytes, ms, host, url, data, error } — never throws.
// Every adapter is also listed in EXTRA_ADAPTERS with a health-check descriptor.
// URLs are the exact public endpoints listed in the project brief; nothing is invented.
// Entries marked `verified:false` were not reachable from the build VM (network blocked) and their
// response shapes are parsed defensively from documented/observed structures.

import { getJSON, mapResult, CHROME_HEADERS, UA_IPHONE, UA_CHROME, hostOf } from './http.js';
import { parseInjuryReportPdf } from './pdf.js';

// ---------------------------------------------------------------- helpers
export function ymd(date) {
  // accepts 'YYYY-MM-DD', 'YYYYMMDD', Date
  if (date instanceof Date) return date.toISOString().slice(0, 10).replace(/-/g, '');
  return String(date || '').replace(/-/g, '').slice(0, 8);
}
export function isoDate(date) {
  const d = ymd(date);
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}
/** NBA season string for a date, e.g. 2026-11-22 -> '2026-27'. Season rolls in August. */
export function seasonFor(date) {
  const d = ymd(date);
  const y = +d.slice(0, 4);
  const m = +d.slice(4, 6);
  const start = m >= 8 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
/** basketball-reference season year (end year), e.g. '2026-27' -> 2027 */
export function brefYear(seasonOrDate) {
  const s = /^\d{4}-\d{2}$/.test(String(seasonOrDate)) ? seasonOrDate : seasonFor(seasonOrDate);
  return +s.slice(0, 4) + 1;
}
export const americanToProb = (o) => {
  const n = Number(o);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
};
export const decimalToAmerican = (d) => {
  const n = Number(d);
  if (!Number.isFinite(n) || n <= 1) return null;
  return n >= 2 ? Math.round((n - 1) * 100) : Math.round(-100 / (n - 1));
};
export function noVigHome(mlHome, mlAway) {
  const p = americanToProb(mlHome);
  const q = americanToProb(mlAway);
  if (p == null || q == null) return null;
  return +(p / (p + q)).toFixed(4);
}
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
export const stripTags = (s) =>
  String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
    .replace(/\s+/g, ' ')
    .trim();

/** Generic HTML table parser: [{ id, headers:[..], rows:[[cell..]], stats:[{data-stat:text}] }] */
export function parseHtmlTables(html) {
  const src = String(html || '').replace(/<!--|-->/g, ''); // bref hides tables in comments
  const out = [];
  for (const t of src.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
    const id = (/\bid="([^"]+)"/.exec(t[1]) || [])[1] || '';
    const body = t[2];
    const headRow = (/<thead[\s\S]*?<\/thead>/i.exec(body) || [''])[0];
    const lastHeadTr = [...headRow.matchAll(/<tr[\s\S]*?<\/tr>/gi)].pop();
    const headers = lastHeadTr ? [...lastHeadTr[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => stripTags(c[1])) : [];
    const rows = [];
    const stats = [];
    const tbody = (/<tbody[\s\S]*?<\/tbody>/i.exec(body) || [body])[0];
    for (const tr of tbody.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
      if (/class="[^"]*\bthead\b/.test(tr[1])) continue;
      const cells = [];
      const st = {};
      for (const c of tr[2].matchAll(/<t([hd])\b([^>]*)>([\s\S]*?)<\/t[hd]>/gi)) {
        const text = stripTags(c[3]);
        cells.push(text);
        const ds = /data-stat="([^"]+)"/.exec(c[2]);
        if (ds) st[ds[1]] = text;
        const href = /href="([^"]+)"/.exec(c[3]);
        if (ds && href) st[`${ds[1]}_href`] = href[1];
      }
      if (!cells.length) continue;
      const headerOnly = /<th/i.test(tr[2]) && !/<td/i.test(tr[2]);
      if (headerOnly && !headers.length && !rows.length) headers.push(...cells);
      else {
        rows.push(cells);
        stats.push(st);
      }
    }
    out.push({ id, headers, rows, stats });
  }
  return out;
}
const rowsAsObjects = (tbl) => tbl.rows.map((r) => Object.fromEntries(tbl.headers.map((h, i) => [h || `c${i}`, r[i] ?? ''])));

/** Token bucket. Default 20 requests/minute (basketball-reference policy). */
export function createTokenBucket({ capacity = 20, perMs = 60000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let tokens = capacity;
  let last = now();
  const rate = capacity / perMs;
  const refill = () => {
    const t = now();
    tokens = Math.min(capacity, tokens + (t - last) * rate);
    last = t;
  };
  return {
    get tokens() {
      refill();
      return tokens;
    },
    tryTake() {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
    async take(maxWaitMs = 3000) {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      const wait = Math.ceil((1 - tokens) / rate);
      if (wait > maxWaitMs) return false;
      await sleep(wait);
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
  };
}
export const brefBucket = createTokenBucket();
const rateLimited = (url) => ({ ok: false, status: 429, bytes: 0, ms: 0, host: hostOf(url), url, data: null, error: 'local rate limit (bref 20 req/min)' });
const badParams = (url, msg) => ({ ok: false, status: 0, bytes: 0, ms: 0, host: hostOf(url), url, data: null, error: msg });

const HTML_HEADERS = { 'User-Agent': UA_CHROME, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
const JSON_HEADERS = { 'User-Agent': UA_CHROME, Accept: 'application/json, text/plain, */*' };

// ================================================================ ACTION NETWORK
export const AN_BOOKS = { 15: 'consensus', 30: 'open', 68: 'DraftKings', 69: 'FanDuel', 75: 'BetMGM', 123: 'Caesars' };
export const actionNetworkScoreboardUrl = (date) => `https://api.actionnetwork.com/web/v2/scoreboard/nba?bookIds=15,30,68,69,75,123&date=${ymd(date)}&periods=event`;

const pickSide = (arr, side) => (Array.isArray(arr) ? arr.find((o) => o && o.side === side) : null) || null;
const betPct = (o, k) => (o && o.bet_info && o.bet_info[k] ? num(o.bet_info[k].percent) : null);

/** Normalize one Action Network game (v2 scoreboard). Exported for tests. */
export function normalizeActionNetworkGame(g) {
  const teams = Array.isArray(g.teams) ? g.teams : [];
  const team = (id) => {
    const t = teams.find((x) => x.id === id) || {};
    return { id: t.id ?? id ?? null, abbr: t.abbr || null, name: t.full_name || t.display_name || null };
  };
  const books = [];
  const markets = g.markets || {};
  for (const [bookId, mk] of Object.entries(markets)) {
    const ev = (mk && (mk.event || mk)) || {};
    const sh = pickSide(ev.spread, 'home');
    const sa = pickSide(ev.spread, 'away');
    const ov = pickSide(ev.total, 'over');
    const un = pickSide(ev.total, 'under');
    const mh = pickSide(ev.moneyline, 'home');
    const ma = pickSide(ev.moneyline, 'away');
    const mlHome = num(mh && mh.odds);
    const mlAway = num(ma && ma.odds);
    books.push({
      id: +bookId,
      name: AN_BOOKS[bookId] || `book${bookId}`,
      spreadHome: num(sh && sh.value),
      spreadHomeOdds: num(sh && sh.odds),
      spreadAwayOdds: num(sa && sa.odds),
      total: num(ov && ov.value) ?? num(un && un.value),
      overOdds: num(ov && ov.odds),
      underOdds: num(un && un.odds),
      mlHome,
      mlAway,
      noVigHome: noVigHome(mlHome, mlAway),
      betInfo: {
        spreadHomeTicketsPct: betPct(sh, 'tickets'),
        spreadHomeMoneyPct: betPct(sh, 'money'),
        overTicketsPct: betPct(ov, 'tickets'),
        overMoneyPct: betPct(ov, 'money'),
        mlHomeTicketsPct: betPct(mh, 'tickets'),
        mlHomeMoneyPct: betPct(mh, 'money'),
      },
    });
  }
  const consensus = books.find((b) => b.id === 15) || null;
  const open = books.find((b) => b.id === 30) || null;
  return {
    id: g.id ?? null,
    startTime: g.start_time || null,
    status: g.status || null,
    home: team(g.home_team_id),
    away: team(g.away_team_id),
    books: books.filter((b) => b.id !== 15 && b.id !== 30),
    consensus,
    open,
  };
}

export async function actionNetworkScoreboard(f, { date } = {}) {
  const url = actionNetworkScoreboardUrl(date || new Date());
  const r = await getJSON(f, url, { headers: JSON_HEADERS });
  return mapResult(r, (d) => ({ games: (d.games || []).map(normalizeActionNetworkGame) }));
}

export const actionNetworkInjuriesUrl = () => 'https://api.actionnetwork.com/web/v1/leagues/4/injuries';
/** Defensive: accepts flat injuries[] or teams[].injuries[]. */
export function normalizeActionNetworkInjuries(d) {
  const out = [];
  const teams = new Map((d.teams || []).map((t) => [t.id, t]));
  const push = (inj, teamHint) => {
    const p = inj.player || {};
    const t = teamHint || teams.get(inj.team_id) || {};
    out.push({
      team: t.abbr || t.full_name || inj.team_id || null,
      name: p.full_name || inj.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
      id: p.id ?? inj.player_id ?? null,
      status: inj.status || null,
      detail: inj.description || inj.injury || null,
      returnDate: inj.return_date || null,
      updated: inj.updated_at || null,
    });
  };
  if (Array.isArray(d.injuries)) d.injuries.forEach((i) => push(i));
  for (const t of d.teams || []) if (Array.isArray(t.injuries)) t.injuries.forEach((i) => push(i, t));
  return out;
}
export async function actionNetworkInjuries(f) {
  const r = await getJSON(f, actionNetworkInjuriesUrl(), { headers: JSON_HEADERS });
  return mapResult(r, normalizeActionNetworkInjuries);
}

// ================================================================ NBA CDN
const CDN = 'https://cdn.nba.com/static/json';
export const nbaUrls = {
  todaysScoreboard: () => `${CDN}/liveData/scoreboard/todaysScoreboard_00.json`,
  odds: () => `${CDN}/liveData/odds/odds_todaysGames.json`,
  boxscore: (gameId) => `${CDN}/liveData/boxscore/boxscore_${gameId}.json`,
  playbyplay: (gameId) => `${CDN}/liveData/playbyplay/playbyplay_${gameId}.json`,
  schedule: () => `${CDN}/staticData/scheduleLeagueV2_1.json`,
  playerIndex: () => `${CDN}/staticData/playerIndex.json`,
  dailyLineups: (date) => `https://stats.nba.com/js/data/leaders/00_daily_lineups_${ymd(date)}.json`,
  injuryIndex: () => 'https://official.nba.com/nba-injury-report-2026-27-season/',
  refAssignments: () => 'https://official.nba.com/referee-assignments/',
};

export async function nbaTodaysScoreboard(f) {
  const r = await getJSON(f, nbaUrls.todaysScoreboard(), { headers: CHROME_HEADERS });
  return mapResult(r, (d) => ({
    gameDate: d.scoreboard && d.scoreboard.gameDate,
    games: ((d.scoreboard && d.scoreboard.games) || []).map((g) => ({
      gameId: g.gameId,
      status: g.gameStatus,
      statusText: g.gameStatusText,
      period: g.period,
      clock: g.gameClock,
      startUtc: g.gameTimeUTC,
      home: { id: g.homeTeam && g.homeTeam.teamId, abbr: g.homeTeam && g.homeTeam.teamTricode, score: g.homeTeam && g.homeTeam.score },
      away: { id: g.awayTeam && g.awayTeam.teamId, abbr: g.awayTeam && g.awayTeam.teamTricode, score: g.awayTeam && g.awayTeam.score },
    })),
  }));
}

/** Normalize cdn odds_todaysGames.json (decimal odds, opening_odds, odds_trend). */
export function normalizeNbaOdds(d) {
  return (d.games || []).map((g) => {
    const books = new Map();
    for (const m of g.markets || []) {
      for (const b of m.books || []) {
        const key = b.name || b.id;
        if (!books.has(key)) books.set(key, { name: b.name || String(b.id), id: b.id, mlHome: null, mlAway: null, spreadHome: null, open: {}, trend: {} });
        const row = books.get(key);
        const home = (b.outcomes || []).find((o) => o.type === 'home');
        const away = (b.outcomes || []).find((o) => o.type === 'away');
        if (m.name === '2way') {
          row.mlHome = decimalToAmerican(home && home.odds);
          row.mlAway = decimalToAmerican(away && away.odds);
          row.open.mlHome = decimalToAmerican(home && home.opening_odds);
          row.open.mlAway = decimalToAmerican(away && away.opening_odds);
          row.trend.mlHome = (home && home.odds_trend) || null;
        } else if (m.name === 'spread') {
          row.spreadHome = num(home && home.spread);
          row.spreadHomeOdds = decimalToAmerican(home && home.odds);
          row.open.spreadHome = num(home && (home.opening_spread ?? home.spread));
          row.trend.spreadHome = (home && home.odds_trend) || null;
        }
      }
    }
    const list = [...books.values()].map((b) => ({ ...b, noVigHome: noVigHome(b.mlHome, b.mlAway) }));
    return { gameId: g.gameId, homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId, books: list };
  });
}
export async function nbaOdds(f) {
  const r = await getJSON(f, nbaUrls.odds(), { headers: CHROME_HEADERS });
  return mapResult(r, (d) => ({ games: normalizeNbaOdds(d) }));
}

export async function nbaBoxscore(f, { gameId } = {}) {
  const url = nbaUrls.boxscore(gameId);
  if (!gameId) return badParams(url, 'gameId required');
  const r = await getJSON(f, url, { headers: CHROME_HEADERS });
  return mapResult(r, (d) => d.game || d);
}
export async function nbaPlayByPlay(f, { gameId } = {}) {
  const url = nbaUrls.playbyplay(gameId);
  if (!gameId) return badParams(url, 'gameId required');
  const r = await getJSON(f, url, { headers: CHROME_HEADERS });
  return mapResult(r, (d) => ({
    gameId: d.game && d.game.gameId,
    actions: ((d.game && d.game.actions) || []).map((a) => ({
      n: a.actionNumber,
      period: a.period,
      clock: a.clock,
      team: a.teamTricode || null,
      player: a.playerNameI || a.playerName || null,
      type: a.actionType,
      sub: a.subType || null,
      desc: a.description || '',
      scoreHome: num(a.scoreHome),
      scoreAway: num(a.scoreAway),
    })),
  }));
}
export async function nbaSchedule(f) {
  const r = await getJSON(f, nbaUrls.schedule(), { headers: CHROME_HEADERS, timeoutMs: 15000 });
  return mapResult(r, (d) => {
    const ls = d.leagueSchedule || {};
    const games = [];
    for (const day of ls.gameDates || []) for (const g of day.games || []) games.push({ gameId: g.gameId, date: g.gameDateEst || day.gameDate, startUtc: g.gameDateTimeUTC, home: g.homeTeam && g.homeTeam.teamTricode, away: g.awayTeam && g.awayTeam.teamTricode, arena: g.arenaName });
    return { season: ls.seasonYear, games };
  });
}
export async function nbaPlayerIndex(f) {
  const r = await getJSON(f, nbaUrls.playerIndex(), { headers: CHROME_HEADERS, timeoutMs: 15000 });
  return mapResult(r, (d) => {
    // stats-style resultSets or plain array
    const rs = d.resultSets && d.resultSets[0];
    if (rs && rs.headers) return rs.rowSet.map((row) => Object.fromEntries(rs.headers.map((h, i) => [h, row[i]])));
    return Array.isArray(d) ? d : d.players || d;
  });
}

/** stats.nba.com daily lineups: games[].homeTeam/awayTeam.players[] */
export function normalizeDailyLineups(d) {
  const side = (t) =>
    t
      ? {
          abbr: t.teamAbbreviation || null,
          teamId: t.teamId ?? null,
          players: (t.players || []).map((p) => ({
            id: p.personId ?? null,
            name: p.playerName || [p.firstName, p.lastName].filter(Boolean).join(' '),
            position: p.position || '',
            starter: !!p.position, // starters carry a lineup position; bench rows have ''
            lineupStatus: p.lineupStatus || null, // 'Expected' | 'Confirmed'
            rosterStatus: p.rosterStatus || null, // 'Active' | 'Inactive'
            at: p.timestamp || null,
          })),
        }
      : null;
  return (d.games || []).map((g) => ({ gameId: g.gameId, home: side(g.homeTeam), away: side(g.awayTeam) }));
}
export async function nbaDailyLineups(f, { date } = {}) {
  const r = await getJSON(f, nbaUrls.dailyLineups(date || new Date()), { headers: CHROME_HEADERS });
  return mapResult(r, (d) => ({ games: normalizeDailyLineups(d) }));
}

// ---------- official injury report
/** Build the PDF URL for an ET slot. hour24 0-23, minute in {0,15,30,45}. */
export function injuryReportSlotUrl(date, hour24, minute = 0) {
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const ap = hour24 < 12 ? 'AM' : 'PM';
  const mm = String(Math.floor(minute / 15) * 15).padStart(2, '0');
  return `https://ak-static.cms.nba.com/referee/injury/Injury-Report_${isoDate(date)}_${String(h12).padStart(2, '0')}_${mm}${ap}.pdf`;
}
/** ET wall-clock parts for a Date (uses Intl; available in Node/Deno/Workers/browsers). */
export function etParts(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, minute: +p.minute };
}
/** Newest-first candidate slot URLs (:00/:15/:30/:45) at or before `now` (ET), `count` long, same day only. */
export function injuryReportSlots(now = new Date(), count = 8) {
  const { date, hour, minute } = now instanceof Date ? etParts(now) : now;
  const out = [];
  let mins = hour * 60 + Math.floor(minute / 15) * 15;
  while (out.length < count && mins >= 0) {
    out.push(injuryReportSlotUrl(date, Math.floor(mins / 60), mins % 60));
    mins -= 15;
  }
  return out;
}
const SLOT_RE = /Injury-Report_(\d{4}-\d{2}-\d{2})_(\d{2})_(\d{2})(AM|PM)\.pdf/;
/** Parse the official.nba.com injury index HTML for PDF links + timestamps, newest first. */
export function parseInjuryIndex(html) {
  const seen = new Set();
  const out = [];
  for (const m of String(html || '').matchAll(/href="([^"]*Injury-Report_[^"]+\.pdf)"/g)) {
    const url = m[1].startsWith('http') ? m[1] : `https://ak-static.cms.nba.com${m[1]}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const s = SLOT_RE.exec(url);
    let at = null;
    if (s) {
      let h = +s[2] % 12;
      if (s[4] === 'PM') h += 12;
      at = `${s[1]}T${String(h).padStart(2, '0')}:${s[3]}:00-ET`;
    }
    out.push({ url, at });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
export async function nbaInjuryIndex(f) {
  const r = await getJSON(f, nbaUrls.injuryIndex(), { headers: HTML_HEADERS, text: true });
  return mapResult(r, (html) => ({ reports: parseInjuryIndex(html) }));
}
/** Fetch + parse one injury-report PDF. Parser is UNVERIFIED on real PDFs. */
export async function nbaInjuryPdf(f, { url, date, hour, minute } = {}) {
  const u = url || injuryReportSlotUrl(date || new Date(), hour ?? 17, minute ?? 0);
  const r = await getJSON(f, u, { headers: { ...CHROME_HEADERS, Accept: 'application/pdf,*/*' }, binary: true, timeoutMs: 12000 });
  if (!r.ok) return r;
  const parsed = await parseInjuryReportPdf(r.data);
  const data = { url: u, rows: parsed.rows, unverified: true };
  return parsed.rows.length ? { ...r, data, error: null } : { ...r, ok: false, data, error: parsed.error || 'no rows parsed' };
}
/** Index → newest PDF, else probe recent :00/:15/:30/:45 slots. */
export async function nbaInjuryReportLatest(f, { now = new Date(), maxProbe = 6 } = {}) {
  const idx = await nbaInjuryIndex(f);
  const candidates = idx.ok && idx.data.reports.length ? [idx.data.reports[0].url] : [];
  for (const u of injuryReportSlots(now, maxProbe)) if (!candidates.includes(u)) candidates.push(u);
  let last = idx;
  for (const u of candidates.slice(0, maxProbe + 1)) {
    last = await nbaInjuryPdf(f, { url: u });
    if (last.ok) return last;
    if (last.status && last.status !== 404 && last.status !== 403 && last.status !== 200) break;
  }
  return last;
}

// ---------- referee assignments
/** official.nba.com/referee-assignments/ — rows: game, crew chief, referee, umpire, alternate. */
export function parseRefAssignments(html) {
  const games = [];
  const clean = (s) => stripTags(s).replace(/\s*\(#?\d+\)\s*/g, '').trim();
  for (const t of parseHtmlTables(html)) {
    for (const r of t.rows) {
      if (r.length < 4) continue;
      if (/crew\s*chief/i.test(r.join(' '))) continue; // header row in tbody
      const [game, crewChief, referee, umpire, alternate] = r.map(clean);
      if (!game || !/[@vV]|at /.test(game)) continue;
      games.push({ game, crewChief: crewChief || null, referee: referee || null, umpire: umpire || null, alternate: alternate || null, officials: [crewChief, referee, umpire].filter(Boolean) });
    }
  }
  return games;
}
export async function nbaRefAssignments(f) {
  const r = await getJSON(f, nbaUrls.refAssignments(), { headers: HTML_HEADERS, text: true });
  return mapResult(r, (html) => ({ games: parseRefAssignments(html) }));
}

// ================================================================ NBASTUFFER
export const nbastufferRefUrl = (season) => {
  const s = season || seasonFor(new Date());
  return `https://www.nbastuffer.com/${s.slice(0, 4)}-${+s.slice(0, 4) + 1}-nba-referee-stats/`;
};
export async function nbastufferRefStats(f, { season } = {}) {
  const r = await getJSON(f, nbastufferRefUrl(season), { headers: HTML_HEADERS, text: true });
  return mapResult(r, (html) => {
    const tbl = parseHtmlTables(html).sort((a, b) => b.rows.length - a.rows.length)[0];
    return { referees: tbl ? rowsAsObjects(tbl) : [] };
  });
}

// ================================================================ PBPSTATS
const PBP = 'https://api.pbpstats.com';
const qs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
export const pbpUrls = {
  games: ({ season, seasonType = 'Regular Season' }) => `${PBP}/get-games/nba?${qs({ Season: season, SeasonType: seasonType })}`,
  totals: ({ season, seasonType = 'Regular Season', type = 'Team' }) => `${PBP}/get-totals/nba?${qs({ Season: season, SeasonType: seasonType, Type: type })}`,
  gameLogs: ({ season, seasonType = 'Regular Season', entityId }) => `${PBP}/get-game-logs/nba?${qs({ Season: season, SeasonType: seasonType, EntityType: 'Player', EntityId: entityId })}`,
  shots: ({ season, seasonType = 'Regular Season', entityType = 'Team', entityId }) => `${PBP}/get-shots/nba?${qs({ Season: season, SeasonType: seasonType, EntityType: entityType, EntityId: entityId })}`,
  wowy: ({ season, seasonType = 'Regular Season', teamId, type = 'Player', onFloor = '' }) => `${PBP}/get-wowy-stats/nba?${qs({ Season: season, SeasonType: seasonType, TeamId: teamId, Type: type, '0Exactly1OnFloor': onFloor })}`,
  liveGames: () => `${PBP}/live/games/nba`,
};
const pbpRows = (d) => d.multi_row_table_data || d.results || d.single_row_table_data || d;
export async function pbpstatsGames(f, { season } = {}) {
  const r = await getJSON(f, pbpUrls.games({ season: season || seasonFor(new Date()) }), { headers: JSON_HEADERS });
  return mapResult(r, (d) => ({ games: pbpRows(d) }));
}
export async function pbpstatsTotals(f, { season, type = 'Team' } = {}) {
  const r = await getJSON(f, pbpUrls.totals({ season: season || seasonFor(new Date()), type }), { headers: JSON_HEADERS, timeoutMs: 15000 });
  return mapResult(r, (d) => ({ type, rows: pbpRows(d) }));
}
export const pbpstatsTeamTotals = (f, p = {}) => pbpstatsTotals(f, { ...p, type: 'Team' });
export const pbpstatsLineupTotals = (f, p = {}) => pbpstatsTotals(f, { ...p, type: 'Lineup' });
export async function pbpstatsPlayerGameLogs(f, { season, entityId, athleteId } = {}) {
  const id = entityId || athleteId;
  const url = pbpUrls.gameLogs({ season: season || seasonFor(new Date()), entityId: id });
  if (!id) return badParams(url, 'entityId (NBA personId) required');
  const r = await getJSON(f, url, { headers: JSON_HEADERS });
  return mapResult(r, (d) => ({ logs: pbpRows(d) }));
}
export async function pbpstatsShots(f, { season, entityType = 'Team', entityId } = {}) {
  const url = pbpUrls.shots({ season: season || seasonFor(new Date()), entityType, entityId });
  if (!entityId) return badParams(url, 'entityId required');
  const r = await getJSON(f, url, { headers: JSON_HEADERS, timeoutMs: 15000 });
  return mapResult(r, (d) => ({ shots: d.results || d }));
}
export async function pbpstatsWowy(f, { season, teamId, type = 'Player', onFloor } = {}) {
  const url = pbpUrls.wowy({ season: season || seasonFor(new Date()), teamId, type, onFloor });
  if (!teamId) return badParams(url, 'teamId required');
  const r = await getJSON(f, url, { headers: JSON_HEADERS, timeoutMs: 15000 });
  return mapResult(r, (d) => ({ rows: pbpRows(d) }));
}
export async function pbpstatsLiveGames(f) {
  const r = await getJSON(f, pbpUrls.liveGames(), { headers: JSON_HEADERS });
  return mapResult(r, (d) => ({ games: d.game_data || d.games || d }));
}

// ================================================================ OTHERS
export const underdogUrl = () => 'https://api.underdogfantasy.com/beta/v5/over_under_lines';
const UD_STATS = new Set(['points', 'rebounds', 'assists']);
/** Join over_under_lines → appearances → players; keep NBA points/rebounds/assists only. */
export function filterUnderdogNba(d) {
  const players = new Map((d.players || []).map((p) => [p.id, p]));
  const apps = new Map((d.appearances || []).map((a) => [a.id, a]));
  const out = [];
  for (const l of d.over_under_lines || []) {
    const st = (l.over_under && l.over_under.appearance_stat) || {};
    if (!UD_STATS.has(st.stat)) continue;
    const app = apps.get(st.appearance_id) || {};
    const pl = players.get(app.player_id) || {};
    if ((pl.sport_id || '').toUpperCase() !== 'NBA') continue;
    out.push({ id: l.id, player: [pl.first_name, pl.last_name].filter(Boolean).join(' '), playerId: pl.id ?? null, team: pl.team_id ?? null, matchId: app.match_id ?? null, stat: st.stat, line: num(l.stat_value), status: l.status || null });
  }
  return out;
}
export async function underdogLines(f) {
  const r = await getJSON(f, underdogUrl(), { headers: JSON_HEADERS, timeoutMs: 15000 });
  return mapResult(r, (d) => ({ lines: filterUnderdogNba(d) })); // server-side filter: only NBA pts/reb/ast reach the browser
}

export const polymarketUrl = () => 'https://gamma-api.polymarket.com/events?tag_slug=nba&active=true&closed=false&limit=100';
export async function polymarketNba(f) {
  const r = await getJSON(f, polymarketUrl(), { headers: JSON_HEADERS });
  return mapResult(r, (d) => ({
    events: (Array.isArray(d) ? d : d.events || []).map((e) => ({
      id: e.id,
      slug: e.slug,
      title: e.title,
      endDate: e.endDate || null,
      markets: (e.markets || []).map((m) => {
        let outcomes = m.outcomes;
        let prices = m.outcomePrices;
        try {
          if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes);
          if (typeof prices === 'string') prices = JSON.parse(prices);
        } catch {
          /* leave raw */
        }
        return { id: m.id, question: m.question, outcomes, prices: Array.isArray(prices) ? prices.map(Number) : prices, volume: num(m.volume) };
      }),
    })),
  }));
}

export const theScoreUrl = () => 'https://api.thescore.com/nba/events';
export async function theScoreEvents(f) {
  const r = await getJSON(f, theScoreUrl(), { headers: { ...JSON_HEADERS, 'User-Agent': UA_IPHONE } });
  return mapResult(r, (d) => ({
    events: (Array.isArray(d) ? d : d.events || []).map((e) => ({
      id: e.id,
      startsAt: e.game_date || e.starts_at || null,
      status: e.status || e.event_status || null,
      home: e.home_team && (e.home_team.abbreviation || e.home_team.name),
      away: e.away_team && (e.away_team.abbreviation || e.away_team.name),
      odds: e.odd || e.odds || null,
    })),
  }));
}

export const sleeperUrls = { players: () => 'https://api.sleeper.app/v1/players/nba', state: () => 'https://api.sleeper.app/v1/state/nba' };
export async function sleeperPlayers(f) {
  const r = await getJSON(f, sleeperUrls.players(), { headers: JSON_HEADERS, timeoutMs: 20000 });
  return mapResult(r, (d) => ({
    players: Object.values(d || {}).map((p) => ({ id: p.player_id, name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' '), team: p.team || null, pos: p.position || null, status: p.status || null, injury: p.injury_status || null })),
  }));
}
export async function sleeperState(f) {
  return getJSON(f, sleeperUrls.state(), { headers: JSON_HEADERS });
}

export const rotowireUrls = {
  lineups: () => 'https://www.rotowire.com/basketball/nba-lineups.php',
  injuries: () => 'https://www.rotowire.com/basketball/tables/injury-report.php?team=ALL&pos=ALL',
};
/** Parse rotowire nba-lineups.php HTML into games with starters + status. */
export function parseRotowireLineups(html) {
  const out = [];
  const blocks = String(html || '').split(/<div class="lineup is-nba/).slice(1);
  for (const b of blocks) {
    const abbrs = [...b.matchAll(/class="lineup__abbr">\s*([A-Z]{2,4})\s*</g)].map((m) => m[1]);
    const side = (cls) => {
      const seg = (new RegExp(`<ul class="lineup__list ${cls}[^"]*">([\\s\\S]*?)</ul>`).exec(b) || [])[1] || '';
      const statusM = /class="lineup__status ([^"]+)"[^>]*>([\s\S]*?)<\/li>/.exec(seg);
      const players = [];
      for (const li of seg.matchAll(/<li class="lineup__player[^"]*"[^>]*>([\s\S]*?)<\/li>/g)) {
        const pos = stripTags((/class="lineup__pos">([\s\S]*?)</.exec(li[1]) || [])[1]);
        const name = (/title="([^"]+)"/.exec(li[1]) || [])[1] || stripTags((/<a[^>]*>([\s\S]*?)<\/a>/.exec(li[1]) || [])[1]);
        const inj = stripTags((/class="lineup__inj">([\s\S]*?)</.exec(li[1]) || [])[1]);
        if (name) players.push({ name, position: pos, injury: inj || null });
      }
      const st = statusM ? statusM[1] : '';
      return { lineupStatus: /confirmed/i.test(st) ? 'Confirmed' : /expected/i.test(st) ? 'Expected' : stripTags(statusM ? statusM[2] : '') || null, starters: players.slice(0, 5), others: players.slice(5) };
    };
    out.push({ away: { abbr: abbrs[0] || null, ...side('is-visit') }, home: { abbr: abbrs[1] || null, ...side('is-home') } });
  }
  return out;
}
export async function rotowireLineups(f) {
  const r = await getJSON(f, rotowireUrls.lineups(), { headers: HTML_HEADERS, text: true });
  return mapResult(r, (html) => ({ games: parseRotowireLineups(html) }));
}
export async function rotowireInjuries(f) {
  const r = await getJSON(f, rotowireUrls.injuries(), { headers: { ...JSON_HEADERS, Referer: 'https://www.rotowire.com/basketball/injury-report.php' } });
  return mapResult(r, (d) => (Array.isArray(d) ? d : []).map((p) => ({ team: p.team, name: p.player || [p.firstname, p.lastname].filter(Boolean).join(' '), id: p.ID ?? p.id ?? null, status: p.status, detail: p.injury, returnDate: p.rDate || null })));
}

// ---------- basketball-reference (20 req/min token bucket)
export const brefUrls = {
  schedule: ({ season, month = 'november' }) => `https://www.basketball-reference.com/leagues/NBA_${brefYear(season || new Date())}_games-${month}.html`,
  gamelog: ({ playerId, season }) => `https://www.basketball-reference.com/players/${String(playerId || 'x')[0]}/${playerId}/gamelog/${brefYear(season || new Date())}`,
  referees: ({ season }) => `https://www.basketball-reference.com/referees/${brefYear(season || new Date())}_register.html`,
};
async function brefGet(f, url, bucket) {
  if (!(await (bucket || brefBucket).take(3000))) return rateLimited(url);
  return getJSON(f, url, { headers: HTML_HEADERS, text: true, timeoutMs: 12000 });
}
export async function brefSchedule(f, { season, month, bucket } = {}) {
  const r = await brefGet(f, brefUrls.schedule({ season, month }), bucket);
  return mapResult(r, (html) => {
    const t = parseHtmlTables(html).find((x) => x.id === 'schedule') || parseHtmlTables(html)[0];
    return { games: t ? t.stats.map((s) => ({ date: s.date_game, start: s.game_start_time || null, away: s.visitor_team_name, awayPts: num(s.visitor_pts), home: s.home_team_name, homePts: num(s.home_pts), box: s.box_score_text_href || null })) : [] };
  });
}
export async function brefGamelog(f, { playerId, season, bucket } = {}) {
  const url = brefUrls.gamelog({ playerId, season });
  if (!playerId) return badParams(url, 'bref playerId (e.g. jamesle01) required');
  const r = await brefGet(f, url, bucket);
  return mapResult(r, (html) => {
    const tables = parseHtmlTables(html);
    const t = tables.find((x) => x.id === 'pgl_basic' || x.id === 'player_game_log_reg') || tables.find((x) => x.stats.some((s) => 'pts' in s));
    const logs = t ? t.stats.filter((s) => s.pts !== undefined && s.pts !== '').map((s) => ({ date: s.date_game || s.date, opp: s.opp_id || s.opp_name_abbr, home: s.game_location !== '@', result: s.game_result, min: s.mp, pts: num(s.pts), reb: num(s.trb), ast: num(s.ast), fg3m: num(s.fg3), fg3a: num(s.fg3a), fgm: num(s.fg), fga: num(s.fga), ftm: num(s.ft), fta: num(s.fta), tov: num(s.tov), pf: num(s.pf), stl: num(s.stl), blk: num(s.blk), oreb: num(s.orb), dreb: num(s.drb) })) : [];
    return { logs: logs.reverse() }; // newest first, matching the engine contract
  });
}
export async function brefReferees(f, { season, bucket } = {}) {
  const r = await brefGet(f, brefUrls.referees({ season }), bucket);
  return mapResult(r, (html) => {
    const t = parseHtmlTables(html).sort((a, b) => b.rows.length - a.rows.length)[0];
    return { referees: t ? rowsAsObjects(t) : [] };
  });
}

// ---------- The Odds API v4
export const oddsApiUrl = (apiKey) => `https://api.the-odds-api.com/v4/sports/basketball_nba/odds?${qs({ apiKey: apiKey || '', regions: 'us', markets: 'h2h,spreads,totals', oddsFormat: 'american' })}`;
export function normalizeOddsApi(d) {
  return (Array.isArray(d) ? d : []).map((g) => ({
    id: g.id,
    commence: g.commence_time,
    home: g.home_team,
    away: g.away_team,
    books: (g.bookmakers || []).map((b) => {
      const m = (k) => (b.markets || []).find((x) => x.key === k) || { outcomes: [] };
      const o = (k, name) => m(k).outcomes.find((x) => x.name === name) || {};
      const mlHome = num(o('h2h', g.home_team).price);
      const mlAway = num(o('h2h', g.away_team).price);
      return { name: b.title || b.key, mlHome, mlAway, spreadHome: num(o('spreads', g.home_team).point), total: num(o('totals', 'Over').point), noVigHome: noVigHome(mlHome, mlAway), updated: b.last_update || null };
    }),
  }));
}
export async function theOddsApiOdds(f, { apiKey } = {}) {
  const url = oddsApiUrl(apiKey);
  if (!apiKey) return badParams(url.replace(/apiKey=[^&]*/, 'apiKey=***'), 'apiKey required (server-only secret)');
  const r = await getJSON(f, url, { headers: JSON_HEADERS });
  const quota = { remaining: num(r.headers && r.headers['x-requests-remaining']), used: num(r.headers && r.headers['x-requests-used']) };
  const safeUrl = url.replace(/apiKey=[^&]*/, 'apiKey=***'); // never leak the key into logs/snapshots
  const out = mapResult({ ...r, url: safeUrl }, (d) => ({ games: normalizeOddsApi(d), quota }));
  return { ...out, quota };
}

export const cbsInjuriesUrl = () => 'https://www.cbssports.com/nba/injuries/';
export function parseCbsInjuries(html) {
  const out = [];
  const parts = String(html || '').split(/class="TeamLogoNameLockup-name"/).slice(1);
  for (const p of parts) {
    const team = stripTags((/>([\s\S]*?)<\/(?:span|a|div)>/.exec(p) || [])[1]);
    const tbl = parseHtmlTables(p)[0];
    if (!tbl) continue;
    for (const r of tbl.rows) {
      // Player | Position | Updated | Injury | Injury Status ; long+short names are both present in cell 0
      const nameCell = r[0] || '';
      const words = nameCell.split(' ');
      const half = Math.floor(words.length / 2);
      const name = words.length > 2 && words.slice(0, half).join(' ').match(/^[A-Z]\./) ? words.slice(half).join(' ') : nameCell;
      out.push({ team, name, pos: r[1] || null, updated: r[2] || null, detail: r[3] || null, status: r[4] || null });
    }
  }
  return out;
}
export async function cbsInjuries(f) {
  const r = await getJSON(f, cbsInjuriesUrl(), { headers: HTML_HEADERS, text: true });
  return mapResult(r, parseCbsInjuries);
}

// ================================================================ health-check descriptors
// serverOnly: true when the endpoint needs CORS bypass, Chrome client hints, a secret, or rate control
// (i.e. it cannot be called directly from the browser). chains: which fallback chains use it.
const today = (ctx) => ctx.date || new Date();
export const EXTRA_ADAPTERS = {
  actionNetworkScoreboard: { fn: actionNetworkScoreboard, url: (c) => actionNetworkScoreboardUrl(today(c)), params: (c) => ({ date: today(c) }), chains: ['odds'], serverOnly: true },
  actionNetworkInjuries: { fn: actionNetworkInjuries, url: actionNetworkInjuriesUrl, params: () => ({}), chains: ['injuries'], serverOnly: true },
  nbaTodaysScoreboard: { fn: nbaTodaysScoreboard, url: nbaUrls.todaysScoreboard, params: () => ({}), chains: [], serverOnly: true },
  nbaOdds: { fn: nbaOdds, url: nbaUrls.odds, params: () => ({}), chains: ['odds'], serverOnly: true },
  nbaBoxscore: { fn: nbaBoxscore, url: (c) => nbaUrls.boxscore(c.gameId || '{gameId}'), params: (c) => ({ gameId: c.gameId }), chains: [], serverOnly: true, needs: 'gameId' },
  nbaPlayByPlay: { fn: nbaPlayByPlay, url: (c) => nbaUrls.playbyplay(c.gameId || '{gameId}'), params: (c) => ({ gameId: c.gameId }), chains: ['pbp'], serverOnly: true, needs: 'gameId' },
  nbaSchedule: { fn: nbaSchedule, url: nbaUrls.schedule, params: () => ({}), chains: [], serverOnly: true },
  nbaPlayerIndex: { fn: nbaPlayerIndex, url: nbaUrls.playerIndex, params: () => ({}), chains: [], serverOnly: true, verified: false },
  nbaDailyLineups: { fn: nbaDailyLineups, url: (c) => nbaUrls.dailyLineups(today(c)), params: (c) => ({ date: today(c) }), chains: ['lineups'], serverOnly: true },
  nbaInjuryIndex: { fn: nbaInjuryIndex, url: nbaUrls.injuryIndex, params: () => ({}), chains: ['injuries'], serverOnly: true },
  nbaInjuryPdf: { fn: (f) => nbaInjuryReportLatest(f, { maxProbe: 2 }), url: () => injuryReportSlots(new Date(), 1)[0], params: () => ({}), chains: ['injuries'], serverOnly: true, verified: false },
  nbaRefAssignments: { fn: nbaRefAssignments, url: nbaUrls.refAssignments, params: () => ({}), chains: ['referees'], serverOnly: true },
  nbastufferRefStats: { fn: nbastufferRefStats, url: (c) => nbastufferRefUrl(c.season), params: (c) => ({ season: c.season }), chains: ['referees'], serverOnly: true },
  pbpstatsGames: { fn: pbpstatsGames, url: (c) => pbpUrls.games({ season: c.season || seasonFor(today(c)) }), params: (c) => ({ season: c.season }), chains: [], serverOnly: false },
  pbpstatsTeamTotals: { fn: pbpstatsTeamTotals, url: (c) => pbpUrls.totals({ season: c.season || seasonFor(today(c)), type: 'Team' }), params: (c) => ({ season: c.season }), chains: [], serverOnly: false },
  pbpstatsLineupTotals: { fn: pbpstatsLineupTotals, url: (c) => pbpUrls.totals({ season: c.season || seasonFor(today(c)), type: 'Lineup' }), params: (c) => ({ season: c.season }), chains: [], serverOnly: false },
  pbpstatsPlayerGameLogs: { fn: pbpstatsPlayerGameLogs, url: (c) => pbpUrls.gameLogs({ season: c.season || seasonFor(today(c)), entityId: c.nbaPlayerId || '{personId}' }), params: (c) => ({ season: c.season, entityId: c.nbaPlayerId }), chains: ['gamelogs'], serverOnly: false, needs: 'nbaPlayerId' },
  pbpstatsShots: { fn: pbpstatsShots, url: (c) => pbpUrls.shots({ season: c.season || seasonFor(today(c)), entityId: c.nbaTeamId || '{teamId}' }), params: (c) => ({ season: c.season, entityId: c.nbaTeamId }), chains: [], serverOnly: false, needs: 'nbaTeamId' },
  pbpstatsWowy: { fn: pbpstatsWowy, url: (c) => pbpUrls.wowy({ season: c.season || seasonFor(today(c)), teamId: c.nbaTeamId || '{teamId}' }), params: (c) => ({ season: c.season, teamId: c.nbaTeamId }), chains: [], serverOnly: false, needs: 'nbaTeamId' },
  pbpstatsLiveGames: { fn: pbpstatsLiveGames, url: pbpUrls.liveGames, params: () => ({}), chains: ['pbp'], serverOnly: false },
  underdogLines: { fn: underdogLines, url: underdogUrl, params: () => ({}), chains: [], serverOnly: true },
  polymarketNba: { fn: polymarketNba, url: polymarketUrl, params: () => ({}), chains: [], serverOnly: false },
  theScoreEvents: { fn: theScoreEvents, url: theScoreUrl, params: () => ({}), chains: [], serverOnly: true, verified: false },
  sleeperPlayers: { fn: sleeperPlayers, url: sleeperUrls.players, params: () => ({}), chains: [], serverOnly: false },
  sleeperState: { fn: sleeperState, url: sleeperUrls.state, params: () => ({}), chains: [], serverOnly: false },
  rotowireLineups: { fn: rotowireLineups, url: rotowireUrls.lineups, params: () => ({}), chains: ['lineups'], serverOnly: true },
  rotowireInjuries: { fn: rotowireInjuries, url: rotowireUrls.injuries, params: () => ({}), chains: [], serverOnly: true },
  brefSchedule: { fn: brefSchedule, url: (c) => brefUrls.schedule({ season: c.season }), params: (c) => ({ season: c.season }), chains: [], serverOnly: true },
  brefGamelog: { fn: brefGamelog, url: (c) => brefUrls.gamelog({ playerId: c.brefPlayerId || '{brefId}', season: c.season }), params: (c) => ({ playerId: c.brefPlayerId, season: c.season }), chains: ['gamelogs'], serverOnly: true, needs: 'brefPlayerId' },
  brefReferees: { fn: brefReferees, url: (c) => brefUrls.referees({ season: c.season }), params: (c) => ({ season: c.season }), chains: [], serverOnly: true },
  theOddsApiOdds: { fn: theOddsApiOdds, url: () => oddsApiUrl('***'), params: (c) => ({ apiKey: c.oddsApiKey }), chains: ['odds'], serverOnly: true, needs: 'oddsApiKey' },
  cbsInjuries: { fn: cbsInjuries, url: cbsInjuriesUrl, params: () => ({}), chains: [], serverOnly: true },
};
