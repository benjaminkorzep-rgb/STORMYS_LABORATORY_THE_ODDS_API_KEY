// ESPN JSON -> snapshot Game fields and engine inputs (docs/contract.md). Pure functions.
import { noVig } from './engine/market.js';
import { ARENAS, travelMiles, utcOffsetHours } from './engine/context.js';

const num = x => { const n = Number(String(x ?? '').replace(/[^\d.+-]/g, '')); return isFinite(n) && String(x ?? '').trim() !== '' ? n : null; };
const americanNum = x => { const s = String(x ?? '').trim(); if (!s || /off|even/i.test(s)) return /even/i.test(s) ? 100 : null; const n = Number(s.replace('+', '')); return isFinite(n) ? n : null; };
export const abbrOf = t => (t?.team?.abbreviation || t?.abbreviation || '').toUpperCase();

// ET slate date, rolling to the next day at 06:00 ET (carried forward from the claude.ai board).
export function slateDateET(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now.getTime() - 6 * 3600e3));
}
export const shiftDate = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

export function oddsFromCompetition(c) {
  const o = (c.odds || [])[0]; if (!o) return null;
  const ml = o.moneyline || {}, ps = o.pointSpread || {}, tt = o.total || {};
  const r = {
    provider: o.provider?.displayName || o.provider?.name || 'DraftKings',
    details: o.details || null,
    spreadHome: num(ps.home?.close?.line ?? o.spread), total: num(tt.over?.close?.line ?? o.overUnder),
    mlHome: americanNum(ml.home?.close?.odds ?? o.homeTeamOdds?.moneyLine), mlAway: americanNum(ml.away?.close?.odds ?? o.awayTeamOdds?.moneyLine),
    open: { spreadHome: num(ps.home?.open?.line), total: num(tt.over?.open?.line), mlHome: americanNum(ml.home?.open?.odds), mlAway: americanNum(ml.away?.open?.odds) },
  };
  r.noVigHome = noVig(r.mlHome, r.mlAway).p; r.open.noVigHome = noVig(r.open.mlHome, r.open.mlAway).p;
  r.books = [{ name: r.provider, mlHome: r.mlHome, mlAway: r.mlAway, spreadHome: r.spreadHome, total: r.total, noVigHome: r.noVigHome }];
  return r;
}

export function gameFromEvent(ev) {
  const c = ev.competitions?.[0] || {}; const st = ev.status?.type || {};
  const side = h => (c.competitors || []).find(t => t.homeAway === h) || {};
  const T = t => ({ id: t.team?.id, abbr: abbrOf(t), name: t.team?.shortDisplayName || t.team?.displayName, score: t.score != null ? Number(t.score) : null,
    record: (t.records || []).find(r => r.type === 'total' || r.name === 'overall')?.summary || (t.records || [])[0]?.summary || '',
    homeRecord: (t.records || []).find(r => r.type === 'home')?.summary || null, awayRecord: (t.records || []).find(r => r.type === 'road')?.summary || null });
  const lp = c.situation?.lastPlay?.probability;
  const home = T(side('home')), away = T(side('away'));
  const a = ARENAS[home.abbr];
  return {
    id: String(ev.id), date: ev.date, state: st.state || 'pre', detail: st.shortDetail || '', completed: !!st.completed, neutral: !!c.neutralSite,
    tv: (c.broadcasts || []).flatMap(b => b.names || []).join(', '),
    venue: { name: c.venue?.fullName || a?.arena || null, city: c.venue?.address?.city || null, team: c.neutralSite ? null : home.abbr, altFt: c.neutralSite ? null : a?.alt ?? null, tz: a?.tz ?? null, lat: a?.lat ?? null, lon: a?.lon ?? null },
    home, away, odds: oddsFromCompetition(c), liveWpHome: lp ? lp.homeWinPercentage : null,
  };
}

// Enrich a Game from an ESPN summary payload.
export function applySummary(g, s) {
  if (!s) return g;
  const pc = (s.pickcenter || [])[0];
  if (pc) {
    const ml = pc.moneyline || {}, ps = pc.pointSpread || {}, tt = pc.total || {};
    const o = g.odds || { books: [] };
    o.provider = pc.provider?.name || o.provider;
    o.spreadHome = num(ps.home?.close?.line) ?? (pc.spread != null ? Number(pc.spread) : o.spreadHome);
    o.total = num(tt.over?.close?.line) ?? (pc.overUnder ?? o.total);
    o.mlHome = americanNum(ml.home?.close?.odds ?? pc.homeTeamOdds?.moneyLine) ?? o.mlHome;
    o.mlAway = americanNum(ml.away?.close?.odds ?? pc.awayTeamOdds?.moneyLine) ?? o.mlAway;
    o.open = { spreadHome: num(ps.home?.open?.line) ?? o.open?.spreadHome ?? null, total: num(tt.over?.open?.line) ?? o.open?.total ?? null, mlHome: americanNum(ml.home?.open?.odds) ?? o.open?.mlHome ?? null, mlAway: americanNum(ml.away?.open?.odds) ?? o.open?.mlAway ?? null };
    o.noVigHome = noVig(o.mlHome, o.mlAway).p; o.open.noVigHome = noVig(o.open.mlHome, o.open.mlAway).p;
    o.books = (s.pickcenter || []).map(b => ({ name: b.provider?.name, mlHome: americanNum(b.homeTeamOdds?.moneyLine), mlAway: americanNum(b.awayTeamOdds?.moneyLine), spreadHome: b.spread ?? null, total: b.overUnder ?? null })).map(b => ({ ...b, noVigHome: noVig(b.mlHome, b.mlAway).p }));
    g.odds = o;
  }
  const bpi = s.predictor?.homeTeam?.gameProjection; g.bpiHome = bpi != null ? Number(bpi) / 100 : null;
  g.officials = (s.gameInfo?.officials || []).map(o => o.displayName || o.fullName).filter(Boolean);
  g.injuries = (s.injuries || []).flatMap(t => (t.injuries || []).map(i => ({ team: abbrOf(t) || t.team?.abbreviation, name: i.athlete?.displayName, id: String(i.athlete?.id || ''), status: i.status || i.type?.description, detail: [i.details?.type, i.details?.detail].filter(Boolean).join(' – '), returnDate: i.details?.returnDate || null })));
  for (const t of s.lastFiveGames || []) { const ab = abbrOf(t); const lf = (t.events || []).map(e => e.gameResult).join(''); if (ab === g.home.abbr) g.home.last5 = lf; if (ab === g.away.abbr) g.away.last5 = lf; }
  const ss = (s.seasonseries || [])[0];
  if (ss) g.h2h = { summary: ss.summary || ss.description || null, games: (ss.events || []).map(e => ({ date: e.date, status: e.statusType?.shortDetail || e.status, score: (e.competitors || []).map(c => `${abbrOf(c)} ${c.score}`).join(' – '), winner: abbrOf((e.competitors || []).find(c => c.winner)) || null })), n: (ss.events || []).length, note: 'This season only (ESPN seasonseries). Small samples: context, not a projection input.' };
  // team season stats when present pre-game
  for (const t of s.boxscore?.teams || []) {
    const ab = abbrOf(t); const stats = Object.fromEntries((t.statistics || []).map(x => [x.name, Number(x.displayValue ?? x.value)]));
    const tgt = ab === g.home.abbr ? g.home : ab === g.away.abbr ? g.away : null; if (tgt) tgt.seasonStats = stats;
  }
  return g;
}

export function injuriesIndex(leagueInjuries) {
  const idx = new Map();
  for (const t of leagueInjuries?.injuries || []) for (const i of t.injuries || []) {
    const id = String(i.athlete?.id || (i.athlete?.links?.[0]?.href || '').match(/id\/(\d+)/)?.[1] || '');
    const name = i.athlete?.displayName;
    const rec = { status: i.status, detail: [i.details?.type, i.details?.detail].filter(Boolean).join(' – ') || i.shortComment || '', date: i.date, returnDate: i.details?.returnDate || null, team: t.displayName || t.abbreviation };
    if (id) idx.set(id, rec); if (name) idx.set('n:' + name, rec);
  }
  return idx;
}

// ESPN athlete gamelog -> compact log rows (newest first).
export function parseGamelog(json, teamAbbr) {
  if (!json) return [];
  const labels = (json.names || json.labels || []).map(x => String(x).toUpperCase());
  const L = name => labels.indexOf(name);
  const evMeta = json.events || {};
  const rows = [];
  for (const st of json.seasonTypes || []) {
    if (!/regular|postseason/i.test(st.displayName || 'regular')) continue;
    for (const cat of st.categories || []) for (const e of cat.events || []) {
      const m = evMeta[e.eventId] || {}; const s = e.stats || [];
      const split = v => String(v || '0-0').split('-').map(Number);
      const get = names => { for (const n of names) { const i = L(n); if (i >= 0) return s[i]; } return null; };
      const [fgm, fga] = split(get(['FG', 'FIELDGOALSMADE-FIELDGOALSATTEMPTED'])), [fg3m, fg3a] = split(get(['3PT', 'THREEPOINTFIELDGOALSMADE-THREEPOINTFIELDGOALSATTEMPTED'])), [ftm, fta] = split(get(['FT', 'FREETHROWSMADE-FREETHROWSATTEMPTED']));
      const score = String(m.score || '').split('-').map(Number); const won = m.gameResult === 'W';
      const hi = Math.max(...score), lo = Math.min(...score);
      rows.push({ date: (m.gameDate || '').slice(0, 10), min: Number(get(['MIN', 'MINUTES'])) || 0, pts: Number(get(['PTS', 'POINTS'])) || 0, reb: Number(get(['REB', 'TOTALREBOUNDS'])) || 0, ast: Number(get(['AST', 'ASSISTS'])) || 0, stl: Number(get(['STL', 'STEALS'])) || 0, blk: Number(get(['BLK', 'BLOCKS'])) || 0, tov: Number(get(['TO', 'TURNOVERS'])) || 0, pf: Number(get(['PF', 'FOULS'])) || 0,
        oreb: Number(get(['OREB', 'OFFENSIVEREBOUNDS'])) || 0, dreb: Number(get(['DREB', 'DEFENSIVEREBOUNDS'])) || 0, fgm, fga, fg3m, fg3a, ftm, fta,
        oppAbbr: (m.opponent?.abbreviation || '').toUpperCase(), home: m.atVs === 'vs', result: m.gameResult || null, teamPts: score.length === 2 && isFinite(hi) ? (won ? hi : lo) : null, oppPts: score.length === 2 && isFinite(hi) ? (won ? lo : hi) : null, team: teamAbbr });
    }
  }
  return rows.filter(r => r.date).sort((a, b) => b.date.localeCompare(a.date));
}

// Schedule context from the team's completed-game dates & venues (daily file).
export function scheduleContext(teamAbbr, schedule, gameDate, venueTeam) {
  const d0 = gameDate.slice(0, 10);
  const prior = (schedule || []).filter(g => g.date < d0).sort((a, b) => b.date.localeCompare(a.date));
  if (!prior.length) return { restDays: null, b2b: false, threeInFour: false, milesLast72: null, tzShift: 0 };
  const days = (a, b) => Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 864e5);
  const restDays = days(d0, prior[0].date) - 1;
  const inLast4 = prior.filter(g => days(d0, g.date) <= 3).length + 1;
  let miles = 0; let prevVenue = venueTeam;
  for (const g of prior.filter(g => days(d0, g.date) <= 3)) { const m = travelMiles(g.venueTeam, prevVenue); if (m) miles += m; prevVenue = g.venueTeam; }
  const homeTz = ARENAS[teamAbbr]?.tz, venTz = ARENAS[venueTeam]?.tz;
  const tzShift = homeTz && venTz ? Math.round(utcOffsetHours(venTz, new Date(gameDate)) - utcOffsetHours(homeTz, new Date(gameDate))) : 0;
  return { restDays, b2b: restDays === 0, threeInFour: inLast4 >= 3, milesLast72: Math.round(miles), tzShift };
}

const recordWL = s => { const m = String(s || '').match(/(\d+)-(\d+)/); return m ? { wins: +m[1], losses: +m[2] } : { wins: null, losses: null }; };

// Build analyzeGame() input for a Game, using the daily player file and the league injury index.
export function engineInput(g, daily, injIdx, { league, now } = {}) {
  const team = side => {
    const t = g[side]; const d = daily?.teams?.[t.abbr] || {};
    const sc = scheduleContext(t.abbr, d.schedule, g.date, g.venue?.team || g.home.abbr);
    const players = (d.players || []).map(p => {
      const inj = injIdx?.get(String(p.id)) || injIdx?.get('n:' + p.name) || (g.injuries || []).find(i => i.id === String(p.id) || i.name === p.name);
      const missed = p.log ? countMissed(p.log, d.schedule) : 0;
      return { id: String(p.id), name: p.name, pos: p.pos, starter: !!p.starter, status: inj?.status || 'Active', injury: inj?.detail || null, gamesMissed: missed, log: p.log || [] };
    });
    const ss = t.seasonStats || {};
    return { id: t.id, abbr: t.abbr, ...recordWL(t.record), ppg: ss.avgPoints ?? d.ppg ?? null, oppg: ss.avgPointsAgainst ?? d.oppg ?? null, pace: d.pace ?? null, ...sc, players };
  };
  const o = g.odds;
  return { game: { id: g.id, date: g.date, neutral: g.neutral, venueTeam: g.venue?.team || g.home.abbr }, home: team('home'), away: team('away'),
    market: o && (o.mlHome != null || o.spreadHome != null) ? { spreadHome: o.spreadHome, total: o.total, mlHome: o.mlHome, mlAway: o.mlAway, open: o.open, books: (o.books || []).filter(b => b.mlHome != null && b.mlAway != null) } : null,
    bpiHome: g.bpiHome ?? null, officials: g.officials || [], league, now, context: g.context || {} };
}
function countMissed(log, schedule) {
  if (!schedule?.length || !log.length) return 0;
  const played = new Set(log.map(r => r.date)); let missed = 0;
  for (const g of [...schedule].sort((a, b) => b.date.localeCompare(a.date))) { if (played.has(g.date)) break; missed++; }
  return missed;
}
