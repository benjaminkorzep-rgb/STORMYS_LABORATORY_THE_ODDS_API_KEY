// APPENDIX B §13 — the 145-factor catalogue, evaluated for ONE game from the engine input and the engine output.
// Every row reports what this game's data says (value), which side it favours (direction), and — only where the engine
// actually has a term — its effect in points on the margin (home minus away) or on the total. Nothing is invented: a row
// whose source is not in the input returns value=null with a note naming the missing feed.
// inProjection is true only for [C] terms index.js really uses and [X] terms whose context.js PRIORS entry is inModel.
// Plain ES module, no dependencies beyond sibling engine modules, no platform APIs.
import { round, mean } from './math.js';
import { noVig } from './market.js';
import { teamGamesFromPlayers, teamPace } from './ratings.js';
import { baselineMinutes, normStatus, returnCap } from './minutes.js';
import { USAGE_EFF_GAMMA } from './players.js';
import { PRIORS, ARENAS, travelMiles, utcOffsetHours } from './context.js';

export const FACTOR_GROUP_COUNTS = Object.freeze({ A: 20, B: 10, C: 10, D: 16, E: 8, F: 14, G: 10, H: 18, I: 12, J: 5, K: 9, L: 8, M: 5 });
export const FACTOR_COUNT = 145;
export const GROUP_NAMES = Object.freeze({
  A: 'Team strength & four factors', B: 'Pace & scoring environment', C: 'Venue & home court', D: 'Rest & schedule',
  E: 'Travel & body clock', F: 'Availability & injuries', G: 'Minutes', H: 'Player rates', I: 'Matchup',
  J: 'Officials', K: 'Motivation & narrative', L: 'Market', M: 'Confidence',
});

// [n, group, name, tag, priorKey (for [X] rows: context.js PRIORS key)]
export const CATALOGUE = Object.freeze([
  [1, 'A', 'Player-based net rating', 'C'], [2, 'A', 'Results-based ORtg (Kalman)', 'C'], [3, 'A', 'Results-based DRtg', 'C'],
  [4, 'A', 'SRS/Massey margin rating', 'C-fallback'], [5, 'A', 'Elo', 'C-fallback'], [6, 'A', 'eFG% off', 'C'], [7, 'A', 'eFG% def', 'C'],
  [8, 'A', 'TOV% off', 'C'], [9, 'A', 'TOV% forced', 'C'], [10, 'A', 'ORB%', 'C'], [11, 'A', 'DRB%', 'C'], [12, 'A', 'FT rate off', 'C'],
  [13, 'A', 'FT rate allowed', 'C'], [14, 'A', '3PA rate off', 'C'], [15, 'A', '3PA rate allowed', 'C'],
  [16, 'A', 'Opp 3P% allowed (luck-adjusted, near-zero weight)', 'C'], [17, 'A', 'Rim rate / rim FG% allowed', 'C'],
  [18, 'A', 'Transition frequency', 'X'], [19, 'A', 'Half-court efficiency', 'X'], [20, 'A', 'Net rating trend last 10', 'C'],
  [21, 'B', 'Team pace', 'C'], [22, 'B', 'Opponent pace', 'C'], [23, 'B', 'Pace mismatch magnitude', 'T'],
  [24, 'B', 'League scoring environment (30-day)', 'C'], [25, 'B', 'Seasonal phase (pre/post-ASB)', 'C'], [26, 'B', 'Expected OT probability', 'C'],
  [27, 'B', 'Early-season total uncertainty', 'X'], [28, 'B', 'Rule/officiating-emphasis change flag', 'D'], [29, 'B', 'Average shot-clock usage', 'X'],
  [30, 'B', 'Free-throw volume expectation', 'X'],
  [31, 'C', 'League HCA', 'C'], [32, 'C', 'Team-specific HCA random effect', 'C'], [33, 'C', 'Altitude', 'C'], [34, 'C', 'Neutral site flag', 'C'],
  [35, 'C', 'Arena shooting background', 'T'], [36, 'C', 'Attendance/crowd size', 'T'], [37, 'C', 'Visitor games at altitude last 7 days', 'X'],
  [38, 'C', 'Home-court playoffs vs regular season', 'X'], [39, 'C', 'Same-building games (LAL/LAC)', 'C'], [40, 'C', 'International game', 'C'],
  [41, 'D', 'Days rest', 'X', 'restDiff'], [42, 'D', 'Rest differential', 'X', 'restDiff'], [43, 'D', '2nd night of B2B', 'X', 'b2b'],
  [44, 'D', 'B2B where first game was road', 'X'], [45, 'D', '3-in-4', 'X', 'threeInFour'], [46, 'D', '4-in-6', 'X'], [47, 'D', '5-in-7', 'X'],
  [48, 'D', 'Road-trip game number', 'T'], [49, 'D', 'Homestand game number', 'T'], [50, 'D', 'Miles last 72h', 'X', 'travel72'],
  [51, 'D', 'Miles last 7 days', 'X'], [52, 'D', 'Excess rest ≥4 days', 'X', 'excessRest'], [53, 'D', 'First game after All-Star break', 'X'],
  [54, 'D', 'Late arrival', 'T'], [55, 'D', "Opponent's prior-night OT", 'X'], [56, 'D', 'Starter minutes load last 3 games', 'X'],
  [57, 'E', 'Time zones crossed', 'X', 'eastJetLagHome'], [58, 'E', 'Eastward jet lag home team', 'X', 'eastJetLagHome'],
  [59, 'E', 'Westward circadian advantage', 'X', 'westAdvantage'], [60, 'E', 'Body-clock tip time (visitor)', 'X'],
  [61, 'E', 'Local tip time / day game', 'X', 'dayGame'], [62, 'E', 'Matinee after night game', 'T'], [63, 'E', 'Days since tz change', 'X'],
  [64, 'E', 'Early-start national window', 'T'],
  [65, 'F', 'Injury status per player', 'C'], [66, 'F', 'Player-specific play rate when listed', 'C'], [67, 'F', 'Hours to tip at listing', 'C'],
  [68, 'F', 'Listed early vs late', 'C'], [69, 'F', 'Injury body part/type', 'C'], [70, 'F', 'Games missed (return restriction)', 'C'],
  [71, 'F', 'Rest-risk for unlisted stars', 'C'], [72, 'F', 'National TV / PPP game', 'C'], [73, 'F', 'Two-way/G-League flags', 'C'],
  [74, 'F', 'Confirmed starters', 'C'], [75, 'F', 'Trade/new acquisition', 'C'], [76, 'F', 'Coach rotation depth', 'C'],
  [77, 'F', 'Correlated star rest (pair)', 'C'], [78, 'F', "Opponent's absences", 'C'],
  [79, 'G', 'Decayed recent minutes', 'C'], [80, 'G', 'Starter/bench role', 'C'], [81, 'G', 'Minutes CV last 10', 'C'],
  [82, 'G', 'Vacated-minutes allocation weights', 'C'], [83, 'G', 'Blowout minutes curve', 'C'], [84, 'G', 'Projected margin distribution', 'C'],
  [85, 'G', 'Foul rate PF/36', 'C'], [86, 'G', 'Opponent foul-drawing vs matchup', 'X'], [87, 'G', 'Crew foul rate', 'X'], [88, 'G', 'Minutes cap', 'C'],
  [89, 'H', 'Usage rate (shrunk)', 'C'], [90, 'H', 'Usage redistribution', 'C'], [91, 'H', 'TS% (shrunk)', 'C'], [92, 'H', 'Usage–efficiency tradeoff', 'C'],
  [93, 'H', '3PA per possession', 'C'], [94, 'H', '3P% (padding ~240)', 'C'], [95, 'H', 'FT rate', 'C'], [96, 'H', 'FT%', 'C'], [97, 'H', 'Shot diet', 'C'],
  [98, 'H', 'AST%', 'C'], [99, 'H', 'Teammate FGM (assist opps)', 'C'], [100, 'H', 'ORB%', 'C'], [101, 'H', 'DRB%', 'C'],
  [102, 'H', 'Available-rebound volume', 'C'], [103, 'H', 'Rebounder presence', 'C'], [104, 'H', 'TOV%', 'C'], [105, 'H', 'Aging curve', 'C'],
  [106, 'H', 'Rookie/draft prior', 'C'],
  [107, 'I', 'Opp points allowed by position', 'C'], [108, 'I', 'Opp 3PA allowed', 'C'], [109, 'I', 'Opp REB%', 'C'], [110, 'I', 'Opp TOV forced', 'C'],
  [111, 'I', 'Opp rim protection', 'C'], [112, 'I', 'Primary defender assignment', 'X'], [113, 'I', 'Defender archetype', 'T'],
  [114, 'I', 'Size/length mismatch', 'X'], [115, 'I', 'Opp switch/drop scheme', 'T'], [116, 'I', 'Player vs this team history', 'T'],
  [117, 'I', 'Foul-prone bigs vs foul-drawing star', 'X'], [118, 'I', 'Opp pace effect on player possessions', 'C'],
  [119, 'J', 'Crew total delta', 'X', 'refTotal'], [120, 'J', 'Crew foul rate', 'X'], [121, 'J', 'Crew home lean', 'X', 'refHome'],
  [122, 'J', 'Crew chief identity', 'T'], [123, 'J', 'Crew × star foul history', 'T'],
  [124, 'K', 'Revenge spot', 'T'], [125, 'K', 'Former-team game', 'T'], [126, 'K', 'Contract year', 'X'], [127, 'K', 'Birthday', 'T'],
  [128, 'K', 'Playoff race leverage', 'X'], [129, 'K', 'Tanking incentive', 'X'], [130, 'K', 'Rivalry/national TV spotlight', 'T'],
  [131, 'K', 'Milestone chase', 'D'], [132, 'K', 'Coach hot seat/new coach', 'T'],
  [133, 'L', 'No-vig opening line', 'C'], [134, 'L', 'No-vig current consensus', 'C'], [135, 'L', 'Line movement since open', 'C'],
  [136, 'L', 'Move after injury news vs none', 'C'], [137, 'L', 'Book hold', 'C'], [138, 'L', 'Prop lines sanity check', 'C'],
  [139, 'L', 'Prediction-market prices', 'X'], [140, 'L', 'Favorite size', 'T'],
  [141, 'M', 'Data staleness', 'confidence'], [142, 'M', 'Rating posterior SD', 'confidence'], [143, 'M', 'Scenario entropy', 'confidence'],
  [144, 'M', 'Model–market gap', 'confidence'], [145, 'M', 'Bucket calibration error', 'confidence'],
]);

// [C] terms that index.js actually consumes when it builds the projection (audited against index.js 1.0.0-priors).
const C_USED = new Set([1, 2, 3, 21, 22, 24, 26, 31, 33, 34, 65, 66, 67, 68, 69, 70, 74, 77, 78, 79, 80, 81, 82, 83, 84, 88,
  89, 90, 92, 93, 94, 98, 118, 134, 136, 137]);

const DAY = 864e5;
const r1 = x => round(x, 1), r3 = x => round(x, 3);
const dirOf = (e, eps = 0.05) => (e == null || !isFinite(e) ? 'neutral' : e > eps ? 'home' : e < -eps ? 'away' : 'neutral');
// side with the better number: higher-is-better (hiGood) or lower-is-better.
const cmp = (h, a, hiGood = true, eps = 1e-9) => (h == null || a == null ? null : Math.abs(h - a) < eps ? 'neutral' : (h > a) === hiGood ? 'home' : 'away');
const localDate = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const localHour = (d, tz) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(d)) % 24;
const daysBetween = (isoA, isoB) => Math.round((Date.parse(isoA + 'T00:00:00Z') - Date.parse(isoB + 'T00:00:00Z')) / DAY);

// Team totals aggregated from the players' logs (only players present in the input contribute).
function teamAgg(team) {
  const t = { fgm: 0, fga: 0, fg3m: 0, fg3a: 0, ftm: 0, fta: 0, tov: 0, oreb: 0, dreb: 0, pts: 0, min: 0 };
  const dates = new Set();
  for (const p of team?.players || []) for (const r of p.log || []) {
    if (!(r.min > 0)) continue; dates.add(r.date);
    for (const k of Object.keys(t)) t[k] += r[k] || 0;
  }
  const g = dates.size;
  if (!g || !t.fga) return null;
  return { games: g, minPerGame: t.min / g, efg: (t.fgm + 0.5 * t.fg3m) / t.fga, tovPct: t.tov / (t.fga + 0.44 * t.fta + t.tov),
    ftr: t.fta / t.fga, fg3aRate: t.fg3a / t.fga, ftaPerGame: t.fta / g, missesPerGame: (t.fga - t.fgm) / g, fgmPerGame: t.fgm / g,
    orebPerGame: t.oreb / g, drebPerGame: t.dreb / g, ptsPerGame: t.pts / g };
}
const sideVals = (h, a, f) => ({ home: f(h), away: f(a) });

export function evaluateFactors(input = {}, out = {}) {
  const H = input.home || {}, A = input.away || {};
  const league = { ortg: 114.5, pace: 99.0, hca: 2.0, ...(input.league || {}) };
  const mk = input.market || null;
  const gameDate = input.game?.date ? new Date(input.game.date) : null;
  const venue = input.game?.venueTeam || H.abbr;
  const vArena = ARENAS[venue] || null;
  const gameLocal = gameDate ? localDate(gameDate, vArena?.tz) : null;
  const aggH = teamAgg(H), aggA = teamAgg(A);
  const gH = teamGamesFromPlayers(H.players || []), gA = teamGamesFromPlayers(A.players || []);
  const ctxRows = out.context || [];
  const ctxEff = (key, filter = () => true) => { const rows = ctxRows.filter(r => r.key === key && filter(r)); return rows.length ? rows.reduce((s, r) => s + r.effect, 0) : null; };
  const players = out.players || [];
  const byTeam = abbr => players.filter(p => p.team === abbr);
  const inputPlayers = [...(H.players || []).map(p => ({ ...p, team: H.abbr })), ...(A.players || []).map(p => ({ ...p, team: A.abbr }))];
  const top = (abbr, n = 3) => byTeam(abbr).slice().sort((a, b) => (b.min?.base || 0) - (a.min?.base || 0)).slice(0, n);
  const poss = out.poss ?? null;
  const ratings = out.ratings || {};
  const asb = d => { if (!d) return null; const m = d.getUTCMonth(); if (m === 1) return null; return m >= 2 && m <= 5 ? 'post-ASB' : 'pre-ASB'; };
  const venueOf = (team, g) => (g.home ? team.abbr : g.oppAbbr);

  const calc = {
    // ---------------- A
    1: () => {
      const h = ratings.home?.player, a = ratings.away?.player; if (h == null || a == null || poss == null) return miss('engine output ratings.player');
      const eff = poss / 100 * ((ratings.home.alpha ?? 0.75) * h - (ratings.away.alpha ?? 0.75) * a);
      return { value: { home: r1(h), away: r1(a) }, effect: r1(eff), effectOn: 'margin', source: 'ratings.js boxSPM → playerTeamNet (out.ratings.*.player)',
        note: 'box-score SPM proxy per 100 poss over the scenario minutes mix; weight α by games played; RAPM refit pending' };
    },
    2: () => {
      const h = ratings.home?.results, a = ratings.away?.results; if (h == null || a == null || poss == null) return miss('engine output ratings.results');
      const eff = poss / 100 * ((1 - (ratings.home.alpha ?? 0.75)) * h - (1 - (ratings.away.alpha ?? 0.75)) * a);
      const ortg = t => (t.ppg != null ? r1(100 * t.ppg / teamPace(t, league.pace)) : null);
      return { value: { homeKalmanNet: r1(h), awayKalmanNet: r1(a), homeOrtg: ortg(H), awayOrtg: ortg(A) }, effect: r1(eff), effectOn: 'margin',
        source: 'ratings.js kalmanTeam (net) + TeamIn.ppg (offence level in index.js evalScenario)', note: 'Kalman filters net margin; the ORtg level comes from ppg vs league and enters the total' };
    },
    3: () => {
      if (H.oppg == null || A.oppg == null || poss == null) return miss('TeamIn.oppg');
      const lgPts = league.ortg * poss / 100;
      const offL = t => (t.ppg != null ? (t.ppg - lgPts) * 0.5 : 0), defL = t => (lgPts - t.oppg) * 0.5;
      const effTotal = poss / 100 * (offL(H) - defL(H) + offL(A) - defL(A));
      const drtg = t => r1(100 * t.oppg / teamPace(t, league.pace));
      return { value: { home: drtg(H), away: drtg(A) }, direction: cmp(drtg(H), drtg(A), false), effect: r1(effTotal), effectOn: 'total',
        source: 'TeamIn.oppg → index.js evalScenario defLevel', note: 'offence/defence levels move the total; they cancel out of the margin' };
    },
    4: () => {
      if (!gH.length || !gA.length) return miss('team game results (player logs with teamPts/oppPts)');
      const mov = g => mean(g.map(x => x.margin - (x.home ? 2 : -2)));
      return { value: { homeMovAdj: r1(mov(gH)), awayMovAdj: r1(mov(gA)), games: { home: gH.length, away: gA.length } }, direction: cmp(mov(gH), mov(gA)),
        source: 'ratings.js teamGamesFromPlayers', note: 'HCA-adjusted mean margin only; opponent-strength (SRS) solve needs league-wide results — Writer B nightly; fallback, not in projection' };
    },
    5: () => (ratings.home?.elo == null ? miss('engine output ratings.elo')
      : { value: { home: Math.round(ratings.home.elo), away: Math.round(ratings.away.elo) }, direction: cmp(ratings.home.elo, ratings.away.elo),
        source: 'ratings.js elo (out.ratings.*.elo)', note: 'anomaly detector / fallback only; opponents assumed 1500 until league-wide Elo is run' }),
    6: () => (aggH && aggA ? { value: { home: r3(aggH.efg), away: r3(aggA.efg) }, direction: cmp(aggH.efg, aggA.efg), source: 'player logs aggregated (fgm, fg3m, fga)',
      note: `own shooting from ${aggH.games}/${aggA.games} games of listed players; not a separate engine term (enters only via player SPM)` } : miss('player logs with fga')),
    7: () => miss('opponent box scores (team game logs) — Writer B nightly'),
    8: () => (aggH && aggA ? { value: { home: r3(aggH.tovPct), away: r3(aggA.tovPct) }, direction: cmp(aggH.tovPct, aggA.tovPct, false),
      source: 'player logs aggregated (tov, fga, fta)', note: 'not a separate engine term (enters via player SPM)' } : miss('player logs')),
    9: () => miss('opponent turnovers (team game logs) — Writer B nightly'),
    10: () => miss('opponent DRB to form ORB% (team game logs) — Writer B nightly'),
    11: () => miss('opponent ORB to form DRB% (team game logs) — Writer B nightly'),
    12: () => (aggH && aggA ? { value: { home: r3(aggH.ftr), away: r3(aggA.ftr) }, direction: cmp(aggH.ftr, aggA.ftr), source: 'player logs aggregated (fta/fga)', note: 'display only' } : miss('player logs')),
    13: () => miss('opponent FTA/FGA (team game logs) — Writer B nightly'),
    14: () => (aggH && aggA ? { value: { home: r3(aggH.fg3aRate), away: r3(aggA.fg3aRate) }, direction: 'neutral', source: 'player logs aggregated (fg3a/fga)', note: 'style descriptor; display only' } : miss('player logs')),
    15: () => miss('opponent 3PA (team game logs) — Writer B nightly'),
    16: () => miss('opponent 3P% allowed (team game logs) — Writer B nightly; by design near-zero weight (luck)'),
    17: () => miss('shot-location data — needs pbpstats Team totals — Writer B nightly'),
    18: () => miss('possession-type data — needs pbpstats Team totals — Writer B nightly'),
    19: () => miss('possession-type data — needs pbpstats Team totals — Writer B nightly'),
    20: () => {
      if (gH.length < 3 || gA.length < 3) return miss('≥3 team results in player logs');
      const tr = g => mean(g.slice(-10).map(x => x.margin)) - mean(g.map(x => x.margin));
      return { value: { homeL10MinusSeason: r1(tr(gH)), awayL10MinusSeason: r1(tr(gA)), homeL10: r1(mean(gH.slice(-10).map(x => x.margin))), awayL10: r1(mean(gA.slice(-10).map(x => x.margin))) },
        direction: cmp(tr(gH), tr(gA)), source: 'ratings.js teamGamesFromPlayers', note: 'raw per-game margin; trend is already absorbed by the Kalman random walk, no separate term' };
    },
    // ---------------- B
    21: () => paceRow(H, A, 'home'),
    22: () => paceRow(A, H, 'away'),
    23: () => { const h = teamPace(H, league.pace), a = teamPace(A, league.pace); return { value: r1(Math.abs(h - a)), direction: 'neutral', source: 'ratings.js teamPace', note: 'tempo-control hypothesis; display only' }; },
    24: () => ({ value: { ortg: league.ortg, pace: league.pace, hca: league.hca }, direction: 'neutral', source: input.league ? 'input.league' : 'index.js DEFAULT_LEAGUE (prior)',
      note: input.league ? 'baseline scoring level for both teams' : 'no 30-day league table supplied — using defaults' }),
    25: () => { const s = asb(gameDate); return s ? { value: s, direction: 'neutral', source: 'input.game.date', note: 'calendar phase; no seasonal term in projection yet' } : miss('All-Star break date (February game)'); },
    26: () => (out.pOT == null ? miss('engine sim pOT') : { value: r3(out.pOT), direction: 'neutral', effect: r1(out.pOT * (out.total?.model ?? 0) * 5 / 48), effectOn: 'total',
      source: 'sim.js simulate (out.pOT)', note: 'OT periods are simulated; effect ≈ pOT × one 5-min period of scoring' }),
    27: () => ({ value: { homeGames: (H.wins ?? 0) + (H.losses ?? 0), awayGames: (A.wins ?? 0) + (A.losses ?? 0), totalSd: r1(out.total?.sd) }, direction: 'neutral',
      source: 'TeamIn wins/losses; out.total.sd', note: 'no separate early-season widening prior yet' }),
    28: () => miss('manual rule/emphasis flag (league memo) — not ingested'),
    29: () => miss('shot-clock data — needs pbpstats Team totals — Writer B nightly'),
    30: () => (aggH && aggA ? { value: { homeFtaPerGame: r1(aggH.ftaPerGame), awayFtaPerGame: r1(aggA.ftaPerGame), combined: r1(aggH.ftaPerGame + aggA.ftaPerGame) }, direction: 'neutral',
      source: 'player logs aggregated (fta)', note: 'own FTA only; crew/opponent adjustment needs crew history' } : miss('player logs')),
    // ---------------- C
    31: () => { const e = ctxEff('hca'); return { value: input.game?.neutral ? 0 : league.hca, effect: e, effectOn: 'margin', source: 'context.js contextTerms hca (league.hca or prior 2.0 ± 0.6)', note: PRIORS.hca.basis }; },
    32: () => {
      const hm = gH.filter(g => g.home), rd = gH.filter(g => !g.home);
      if (!hm.length || !rd.length) return miss('home and road results for the home team');
      return { value: { homeTeamHomeMinusRoad: r1(mean(hm.map(g => g.margin)) - mean(rd.map(g => g.margin))), nHome: hm.length, nRoad: rd.length }, direction: 'neutral',
        source: 'player logs (home flag, margins)', note: 'raw split only; random effect needs multi-season hierarchical fit — Writer B nightly; not in projection' };
    },
    33: () => ({ value: vArena ? vArena.alt : null, effect: ctxEff('altDEN') ?? ctxEff('altUTA') ?? 0, effectOn: 'margin', source: 'context.js ARENAS + PRIORS.altDEN/altUTA',
      note: vArena ? `${vArena.arena}, ${vArena.alt} ft` : 'venue not in arena table' }),
    34: () => ({ value: !!input.game?.neutral, direction: 'neutral', source: 'input.game.neutral', note: 'neutral removes HCA and altitude terms' }),
    35: () => miss('arena-level shooting splits — not ingested'),
    36: () => miss('attendance feed (ESPN box score) — not ingested'),
    37: () => {
      if (!gameLocal || !gA.length) return miss('visitor logs and game date');
      const alt = new Set(['DEN', 'UTAH', 'UTA']);
      const n = gA.filter(g => !g.home && alt.has(g.oppAbbr) && daysBetween(gameLocal, g.date) <= 7 && daysBetween(gameLocal, g.date) > 0).length;
      return { value: n, direction: 'neutral', source: 'visitor player logs (road games at DEN/UTAH)', note: 'acclimatisation hypothesis; no prior' };
    },
    38: () => { if (!gameDate) return miss('game date'); const m = gameDate.getUTCMonth(); return (m >= 9 || m <= 2) ? { value: 'regular season', direction: 'neutral', source: 'input.game.date', note: 'inferred from calendar month' } : miss('season type (April–June ambiguous)'); },
    39: () => { const a = ARENAS[H.abbr], b = ARENAS[A.abbr]; if (!a || !b) return miss('arena table entries'); const same = a.arena === b.arena; return { value: same, direction: 'neutral', source: 'context.js ARENAS', note: same ? 'shared arena: HCA should be removed — not handled by index.js' : 'different arenas (LAC moved to Intuit Dome in 2024)' }; },
    40: () => (input.game?.international != null ? { value: !!input.game.international, direction: 'neutral', source: 'input.game.international', note: 'not handled by index.js beyond neutral flag' }
      : vArena && !input.game?.neutral ? { value: false, direction: 'neutral', source: 'venue is a home NBA arena', note: '' } : miss('international flag / venue')),
    // ---------------- D
    41: () => (H.restDays == null || A.restDays == null ? miss('TeamIn.restDays') : { value: { home: H.restDays, away: A.restDays }, direction: cmp(H.restDays, A.restDays), source: 'TeamIn.restDays', note: 'enters the projection through the rest differential (D42)' }),
    42: () => (H.restDays == null || A.restDays == null ? miss('TeamIn.restDays') : { value: H.restDays - A.restDays, effect: ctxEff('restDiff') ?? 0, effectOn: 'margin', source: 'context.js PRIORS.restDiff', note: `prior ${PRIORS.restDiff.mean} ± ${PRIORS.restDiff.sd} per day, cap 3` }),
    43: () => ({ value: { home: !!H.b2b, away: !!A.b2b }, effect: ctxEff('b2b') ?? 0, effectOn: 'margin', source: 'context.js PRIORS.b2b', note: `prior ${PRIORS.b2b.mean} ± ${PRIORS.b2b.sd}` }),
    44: () => { const f = (t, g) => (!t.b2b ? false : g.length ? !g[g.length - 1].home : null); const v = { home: f(H, gH), away: f(A, gA) }; return v.home == null || v.away == null ? miss('last game location in logs') : { value: v, direction: 'neutral', source: 'TeamIn.b2b + latest log home flag', note: 'no prior; display only' }; },
    45: () => ({ value: { home: !!H.threeInFour, away: !!A.threeInFour }, effect: ctxEff('threeInFour'), effectOn: 'margin', source: 'context.js PRIORS.threeInFour', note: 'prior effect shown; display-only until §6 rule passes' }),
    46: () => nInM(4, 6), 47: () => nInM(5, 7),
    48: () => { if (!gA.length) return miss('visitor logs'); let k = 0; for (let i = gA.length - 1; i >= 0 && !gA[i].home; i--) k++; return { value: { away: k + 1 }, direction: 'neutral', source: 'visitor player logs (consecutive road games)', note: 'trip length limited to the log window' }; },
    49: () => { if (!gH.length) return miss('home logs'); let k = 0; for (let i = gH.length - 1; i >= 0 && gH[i].home; i--) k++; return { value: { home: k + 1 }, direction: 'neutral', source: 'home player logs (consecutive home games)', note: '' }; },
    50: () => (A.milesLast72 == null ? miss('TeamIn.milesLast72') : { value: { home: H.milesLast72 ?? null, away: A.milesLast72 }, effect: ctxEff('travel72'), effectOn: 'margin', source: 'TeamIn.milesLast72 → PRIORS.travel72', note: 'prior effect shown; display only' }),
    51: () => { const f = (t, g) => miles7(t, g); const v = { home: f(H, gH), away: f(A, gA) }; return v.home == null && v.away == null ? miss('logs + arena table') : { value: v, direction: cmp(v.home, v.away, false), source: 'player logs venues → context.js travelMiles', note: 'great-circle arena-to-arena; display only' }; },
    52: () => ({ value: { home: (H.restDays ?? 0) >= 4, away: (A.restDays ?? 0) >= 4 }, effect: ctxEff('excessRest') ?? 0, effectOn: 'margin', source: 'context.js PRIORS.excessRest', note: 'display only' }),
    53: () => { if (!gameDate) return miss('game date'); const m = gameDate.getUTCMonth(); return m === 1 ? miss('All-Star break date') : { value: false, direction: 'neutral', source: 'input.game.date', note: 'not February' }; },
    54: () => miss('team travel / flight arrival data — not ingested'),
    55: () => { const f = (t, g) => { if (!t.b2b) return false; if (!g.length) return null; const d = g[g.length - 1].date; const mins = (t.players || []).reduce((s, p) => s + ((p.log || []).find(r => r.date === d)?.min || 0), 0); return mins >= 262 ? true : Math.abs(mins - 240) <= 2 ? false : null; };
      const v = { homeOppPlayedOT: f(A, gA), awayOppPlayedOT: f(H, gH) }; return v.homeOppPlayedOT == null || v.awayOppPlayedOT == null ? miss('complete prior-night box score (period count)') : { value: v, direction: 'neutral', source: 'player logs (team minutes on prior night: 240 = regulation)', note: 'display only' }; },
    56: () => { const f = t => { const st = (t.players || []).filter(p => p.starter); const m = st.map(p => mean((p.log || []).filter(r => r.min > 0).slice(0, 3).map(r => r.min))).filter(isFinite); return m.length ? r1(mean(m)) : null; };
      const v = { home: f(H), away: f(A) }; return v.home == null ? miss('starter logs') : { value: v, direction: cmp(v.home, v.away, false), source: 'player logs (starters, last 3 games)', note: 'display only' }; },
    // ---------------- E
    57: () => (A.tzShift == null ? miss('TeamIn.tzShift') : { value: { away: A.tzShift, home: H.tzShift ?? 0 }, direction: 'neutral', source: 'TeamIn.tzShift', note: 'signed hours (+ = travelled east); effect carried on E58/E59' }),
    58: () => { const e = ctxRows.filter(r => r.key === 'eastJetLagHome'); return { value: { awayEastHours: Math.max(0, A.tzShift || 0), homeEastHours: Math.max(0, H.tzShift || 0) }, effect: e.length ? e.reduce((s, r) => s + r.effect, 0) : 0, effectOn: 'margin', source: 'context.js PRIORS.eastJetLagHome', note: 'per-hour prior; home-team jet lag not yet modelled; display only' }; },
    59: () => ({ value: { awayWestHours: Math.max(0, -(A.tzShift || 0)) }, effect: ctxEff('westAdvantage') ?? 0, effectOn: 'margin', source: 'context.js PRIORS.westAdvantage', note: 'display only' }),
    60: () => { const t = ARENAS[A.abbr]; if (!gameDate || !t) return miss('visitor home tz'); return { value: localHour(gameDate, t.tz), direction: 'neutral', source: 'game date in visitor home tz', note: 'hour on visitor body clock; display only' }; },
    61: () => { if (!gameDate || !vArena) return miss('venue tz'); return { value: localHour(gameDate, vArena.tz), effect: ctxEff('dayGame') ?? 0, effectOn: 'margin', source: 'game date in venue tz → PRIORS.dayGame', note: 'day-game prior mean 0' }; },
    62: () => { if (!gameDate || !vArena) return miss('venue tz'); const day = localHour(gameDate, vArena.tz) < 17; return { value: { home: day && !!H.b2b, away: day && !!A.b2b }, direction: 'neutral', source: 'tip hour + b2b', note: '' }; },
    63: () => { const f = (t, g) => tzDays(t, g); const v = { home: f(H, gH), away: f(A, gA) }; return v.home == null && v.away == null ? miss('tz change within log window') : { value: v, direction: 'neutral', source: 'player logs venues → arena tz', note: 'null side = no tz change inside the log window' }; },
    64: () => { if (!gameDate) return miss('game date'); const et = localHour(gameDate, 'America/New_York'); return { value: et < 15, direction: 'neutral', source: 'tip hour ET', note: `tip ${et}:00 ET` }; },
    // ---------------- F
    65: () => {
      const listed = players.filter(p => p.status && p.status !== 'Active').map(p => ({ name: p.name, team: p.team, status: p.status, pPlay: p.pPlay }));
      const all = (out.scenarios || []).find(s => !s.out?.length);
      const eff = all && out.margin?.model != null ? out.margin.model - all.margin : null;
      return { value: listed, effect: r1(eff), effectOn: 'margin', source: 'minutes.js availability (STATUS_PRIOR) → scenarios.js', note: 'effect = scenario-mixture margin minus "every uncertain player plays"' };
    },
    66: () => { const h = inputPlayers.filter(p => p.listedHistory?.n > 0).map(p => ({ name: p.name, played: p.listedHistory.played, n: p.listedHistory.n }));
      return h.length ? { value: h, direction: 'neutral', source: 'PlayerIn.listedHistory → minutes.js availability (10-game pooling)', note: '' } : miss('per-player listing history — Writer B nightly'); },
    67: () => { if (!gameDate || !input.now) return miss('input.now (listing timestamp)'); const h = (gameDate - new Date(input.now)) / 3.6e6; return { value: r1(h), direction: 'neutral', source: 'input.game.date − input.now', note: h <= 2.5 ? 'inside T-2h window: key-player priors apply' : 'outside T-2h window: base status priors' }; },
    68: () => { const l = inputPlayers.filter(p => p.listedLate != null && normStatus(p.status) !== 'Active').map(p => ({ name: p.name, late: !!p.listedLate })); return l.length ? { value: l, direction: 'neutral', source: 'PlayerIn.listedLate → KEY_PLAYER_T2H', note: '' } : miss('PlayerIn.listedLate'); },
    69: () => { const d = inputPlayers.filter(p => p.detail).map(p => ({ name: p.name, detail: p.detail })); return d.length ? { value: d, direction: 'neutral', source: 'PlayerIn.detail → scenarios.js defaultRho (illness pairs)', note: 'only illness enters (copula ρ prior 0.2)' } : miss('injury detail text'); },
    70: () => { const g = inputPlayers.filter(p => (p.gamesMissed || 0) > 0).map(p => ({ name: p.name, gamesMissed: p.gamesMissed, cap: returnCap(p) })); return { value: g, direction: 'neutral', source: 'PlayerIn.gamesMissed → minutes.js returnCap', note: g.length ? '' : 'nobody returning from absence' }; },
    71: () => { const s = players.filter(p => p.status === 'Active' && (p.min?.base || 0) >= 28 && ((p.team === H.abbr && H.b2b) || (p.team === A.abbr && A.b2b))).map(p => p.name); return { value: s, direction: 'neutral', source: 'unlisted ≥28-min players on a b2b', note: 'load-management model not built; listed candidates only, not in projection' }; },
    72: () => (input.game?.tv ? { value: input.game.tv, direction: 'neutral', source: 'input.game.tv', note: 'no rest-risk or effort term' } : miss('broadcast info (input.game.tv)')),
    73: () => miss('roster contract type (two-way / G-League assignment) — not ingested'),
    74: () => { const c = input.context?.startersConfirmed; const n = sideVals(H, A, t => (t.players || []).filter(p => p.starter).length); return { value: { confirmed: c ?? null, starterFlags: n }, direction: 'neutral', source: 'PlayerIn.starter (minutes role) + context.startersConfirmed (confidence data term)', note: c ? '' : 'starters inferred from recent role, not confirmed' }; },
    75: () => miss('transaction feed — not ingested'),
    76: () => ({ value: sideVals(H.abbr, A.abbr, ab => byTeam(ab).filter(p => (p.min?.mean || 0) >= 10).length), direction: 'neutral', source: 'out.players (projected ≥10 min)', note: 'descriptive; no coach-specific depth parameter' }),
    77: () => { const b = out.bothSit || []; if (!b.length) return { value: [], direction: 'neutral', source: 'scenarios.js bothSit', note: 'no same-team pair of uncertain players' };
      return { value: b.map(x => ({ team: x.team, players: x.players, prob: x.prob })), effect: r1(b[0].margin - (out.margin?.model ?? b[0].margin)), effectOn: 'margin', source: 'scenarios.js copula (RHO_STAR_B2B)', note: 'effect = first pair both-sit margin minus mixture' }; },
    78: () => ({ value: sideVals(H.abbr, A.abbr, ab => byTeam(ab).filter(p => p.pPlay < 0.5).map(p => p.name)), direction: 'neutral', source: 'out.players pPlay < 0.5', note: 'both rosters enter every scenario' }),
    // ---------------- G
    79: () => ({ value: sideVals(H.abbr, A.abbr, ab => top(ab, 5).map(p => ({ name: p.name, base: p.min.base }))), direction: 'neutral', source: 'minutes.js baselineMinutes (EWMA, half-life 3)', note: '' }),
    80: () => ({ value: sideVals(H.abbr, A.abbr, ab => ({ starters: byTeam(ab).filter(p => p.starter).length, bench: byTeam(ab).filter(p => !p.starter).length })), direction: 'neutral', source: 'PlayerIn.starter', note: '' }),
    81: () => { const f = t => { const c = (t.players || []).map(p => baselineMinutes(p)).filter(b => b.games > 0).map(b => b.cv); return c.length ? r3(mean(c)) : null; }; return { value: { home: f(H), away: f(A) }, direction: 'neutral', source: 'minutes.js baselineMinutes cv', note: 'widens minute bands' }; },
    82: () => { const p = (out.ifPanels || []).find(x => x.teammates?.length); return p ? { value: { if: p.player, sits: p.teammates.slice(0, 4).map(t => ({ name: t.name, dMin: t.dMin })) }, direction: 'neutral', source: 'minutes.js solveTeamMinutes (position × headroom, Dirichlet 20)', note: '' } : miss('an uncertain player to reallocate'); },
    83: () => { const st = players.filter(p => p.starter && p.pPlay > 0.5); return { value: { meanStarterLoss: st.length ? r1(mean(st.map(p => -(p.min.blowoutAdj || 0)))) : null, pBlowout15: r3(out.pBlowout15) }, direction: 'neutral', source: 'minutes.js blowoutLoss (start 13, slope 0.9)', note: 'expected starter minutes lost' }; },
    84: () => (out.margin?.q ? { value: { mean: r1(out.margin.mean), sd: r1(out.margin.sd), q: out.margin.q }, direction: dirOf(out.margin.mean), source: 'sim.js simulate', note: 'drives blowout minutes' } : miss('sim margin')),
    85: () => { const f = ab => top(ab, 13).filter(p => p.min?.foulRisk != null).sort((a, b) => b.min.foulRisk - a.min.foulRisk).slice(0, 2).map(p => ({ name: p.name, pFoulOut: p.min.foulRisk })); return { value: { home: f(H.abbr), away: f(A.abbr) }, direction: 'neutral', source: 'minutes.js foulTroubleRisk (shrunk PF/36)', note: 'reported, does not yet reduce projected minutes' }; },
    86: () => (aggH && aggA ? { value: { homeFacesFtr: r3(aggA.ftr), awayFacesFtr: r3(aggH.ftr) }, direction: 'neutral', source: 'opponent FTA/FGA from logs', note: 'no matchup prior; display only' } : miss('player logs')),
    87: () => miss(`crew foul history (Ref Watch) — Writer B nightly${(input.officials || []).length ? '; crew known' : '; crew not announced'}`),
    88: () => ({ value: players.filter(p => p.min?.returnCap).map(p => ({ name: p.name, cap: p.min.returnCap })), direction: 'neutral', source: 'minutes.js cap min(42, p95+4, return cap)', note: 'global cap always applies' }),
    // ---------------- H
    89: () => topRate('usg36', 'players.js playerRates usg36 ((FGA+0.44FTA+TOV)/36)', 'usage proxy per 36, not possession-shrunk'),
    90: () => { const p = (out.ifPanels || []).find(x => x.teammates?.length); return p ? { value: { if: p.player, sits: p.teammates.slice(0, 4).map(t => ({ name: t.name, dUsg: t.dUsg, dPts: t.dPts })) }, direction: 'neutral', source: 'index.js usage redistribution (usg^1.5 shares)', note: '' } : miss('an uncertain player'); },
    91: () => topRate('ts', 'players.js playerRates ts (padded 150 shots → .570)', 'computed; not used in projectPlayer'),
    92: () => ({ value: USAGE_EFF_GAMMA, direction: 'neutral', source: 'players.js USAGE_EFF_GAMMA', note: 'unverified prior: TS lost per usage gained' }),
    93: () => { const f = ab => top(ab).map(p => ({ name: p.name, fg3a: p.proj?.fg3m && p.rates?.fg3pctShrunk ? r1(p.proj.fg3m.mean / p.rates.fg3pctShrunk) : null })); return { value: { home: f(H.abbr), away: f(A.abbr) }, direction: 'neutral', source: 'players.js fg3a36 × minutes × pace', note: 'projected 3PA this game' }; },
    94: () => ({ value: sideVals(H.abbr, A.abbr, ab => top(ab).map(p => ({ name: p.name, raw: p.rates?.fg3pct, shrunk: p.rates?.fg3pctShrunk }))), direction: 'neutral', source: 'players.js pad K=240 3PA → .360', note: 'never opponent-adjusted' }),
    95: () => logRate((s) => (s.fga ? s.fta / s.fga : null), 'FTA/FGA', 'not in player projection'),
    96: () => logRate((s) => (s.fta ? s.ftm / s.fta : null), 'FTM/FTA (raw)', 'not in player projection'),
    97: () => logRate((s) => (s.fga ? s.fg3a / s.fga : null), '3PA share of FGA', 'rim/mid split needs shot-location data'),
    98: () => topRate('ast36', 'players.js ast36 (padded 400 min)', 'per-36 rate, not AST%'),
    99: () => { const f = (t, agg) => (agg ? (t.players || []).slice().sort((a, b) => baselineMinutes(b).mean - baselineMinutes(a).mean).slice(0, 2).map(p => { const g = (p.log || []).filter(r => r.min > 0); return { name: p.name, teammateFgmPerGame: g.length ? r1(agg.fgmPerGame - mean(g.map(r => r.fgm || 0))) : null }; }) : null);
      return aggH ? { value: { home: f(H, aggH), away: f(A, aggA) }, direction: 'neutral', source: 'player logs', note: 'display only' } : miss('player logs'); },
    100: () => logRate((s) => (s.min ? 36 * s.oreb / s.min : null), 'OREB per 36', 'ORB% needs opponent DRB; reb36 combined in projection'),
    101: () => logRate((s) => (s.min ? 36 * s.dreb / s.min : null), 'DREB per 36', 'DRB% needs opponent ORB'),
    102: () => (aggH && aggA ? { value: { homeOwnMissesPerGame: r1(aggH.missesPerGame), awayOwnMissesPerGame: r1(aggA.missesPerGame) }, direction: 'neutral', source: 'player logs (fga−fgm)', note: 'opponent misses need opponent box scores' } : miss('player logs')),
    103: () => ({ value: sideVals(H.abbr, A.abbr, ab => { const p = byTeam(ab).slice().sort((a, b) => (b.rates?.reb36 || 0) - (a.rates?.reb36 || 0))[0]; return p ? { name: p.name, reb36: p.rates.reb36, pPlay: p.pPlay } : null; }), direction: 'neutral', source: 'players.js reb36', note: 'no rebound-share redistribution term' }),
    104: () => logRate((s) => { const d = s.fga + 0.44 * s.fta + s.tov; return d ? s.tov / d : null; }, 'TOV / (FGA+0.44FTA+TOV)', 'not in player projection'),
    105: () => miss('player birthdates — not ingested'),
    106: () => miss('draft position / rookie flag — not ingested'),
    // ---------------- I
    107: () => miss('opponent points allowed by position — needs team defense splits, Writer B nightly'),
    108: () => miss('opponent 3PA allowed — needs opponent box scores, Writer B nightly'),
    109: () => miss('opponent REB% — needs opponent box scores, Writer B nightly'),
    110: () => miss('opponent TOV forced — needs opponent box scores, Writer B nightly'),
    111: () => miss('rim protection data — needs pbpstats / tracking, Writer B nightly'),
    112: () => miss('matchup (defender assignment) data — needs NBA matchups endpoint'),
    113: () => miss('defender archetype tags — not built'),
    114: () => miss('height/wingspan data — not ingested'),
    115: () => miss('scheme tags (switch/drop) — not built'),
    116: () => ({ value: sideVals(H.abbr, A.abbr, ab => top(ab).map(p => { const s = (p.splits || []).find(x => x.key === 'opp'); return { name: p.name, n: s?.n ?? 0, raw: s?.raw ?? null, shrunk: s?.shrunk ?? null }; })), direction: 'neutral', source: 'players.js personalSplits (opp)', note: 'display only; personal splits must pass §10' }),
    117: () => { const pf = ab => { const b = byTeam(ab).filter(p => /C/i.test(p.pos || '')); return b.length ? r3(Math.max(...b.map(p => p.min?.foulRisk || 0))) : null; };
      return { value: { homeBigsFoulOut: pf(H.abbr), awayBigsFoulOut: pf(A.abbr), homeFtr: aggH ? r3(aggH.ftr) : null, awayFtr: aggA ? r3(aggA.ftr) : null }, direction: 'neutral', source: 'foulTroubleRisk (C) + team FTA/FGA', note: 'no interaction prior; display only' }; },
    118: () => (poss == null ? miss('out.poss') : { value: r3(poss / league.pace), direction: 'neutral', effect: null, source: 'index.js paceFactor = poss / league pace', note: 'scales every player counting stat' }),
    // ---------------- J
    119: () => crewMiss('crew total history (Ref Watch) — Writer B nightly'),
    120: () => crewMiss('crew foul history — Writer B nightly'),
    121: () => crewMiss('crew home-lean history — Writer B nightly'),
    122: () => ((input.officials || []).length ? { value: input.officials[0], direction: 'neutral', source: 'input.officials[0]', note: 'first listed official assumed crew chief' } : miss('officials assignment (posted ~9 am ET)')),
    123: () => crewMiss('crew × player foul history — Writer B nightly'),
    // ---------------- K
    124: () => { const last = [...gH].reverse().find(g => g.oppAbbr === A.abbr); return last ? { value: { lastMeeting: last.date, homeMargin: last.margin }, direction: 'neutral', effect: null, source: 'home player logs vs opponent', note: `prior ${PRIORS.revenge.mean} ± ${PRIORS.revenge.sd}; display only` } : { value: null, direction: null, source: 'home player logs', note: 'no meeting inside the log window' }; },
    125: () => miss('player transaction history — not ingested'),
    126: () => miss('contract data — not ingested'),
    127: () => miss('player birthdates — not ingested'),
    128: () => miss('standings + remaining schedule simulation — not built'),
    129: () => miss('standings / lottery context — not built'),
    130: () => (input.game?.tv ? { value: input.game.tv, direction: 'neutral', source: 'input.game.tv', note: 'display only' } : miss('broadcast info')),
    131: () => miss('milestone tracker (manual) — not ingested'),
    132: () => miss('coaching-change feed — not ingested'),
    // ---------------- L
    133: () => { const o = mk?.open; if (!o || o.mlHome == null) return miss('market.open moneylines'); const nv = noVig(o.mlHome, o.mlAway); return { value: { pHome: r3(nv.p), spreadHome: o.spreadHome ?? null, total: o.total ?? null }, direction: dirOf(nv.p - 0.5, 1e-6), source: 'market.js noVig(open)', note: 'not used by index.js (current consensus anchors)' }; },
    134: () => (out.wp?.market == null ? miss('market moneylines') : { value: { pHome: r3(out.wp.market), books: (out.wp.books || []).length }, direction: dirOf(out.wp.market - 0.5, 1e-6),
      effect: out.margin?.mean != null && out.margin?.model != null ? r1(out.margin.mean - out.margin.model) : null, effectOn: 'margin', source: 'market.js consensus (low-hold weighted, logit)', note: `headline = (1−λ)·market + λ·model, λ=${out.wp.lambda}; effect = headline margin − model margin` }),
    135: () => { if (!mk?.open || mk.spreadHome == null || mk.open.spreadHome == null) return miss('open and current lines'); const nvO = noVig(mk.open.mlHome, mk.open.mlAway).p, nvC = noVig(mk.mlHome, mk.mlAway).p;
      return { value: { spread: r1(mk.spreadHome - mk.open.spreadHome), total: mk.total != null && mk.open.total != null ? r1(mk.total - mk.open.total) : null, pHome: nvO != null && nvC != null ? r3(nvC - nvO) : null }, direction: dirOf(-(mk.spreadHome - mk.open.spreadHome)), source: 'market.open vs market', note: 'display only (already inside the current price)' }; },
    136: () => { const c = input.context || {}; if (c.minutesSinceStatusChange == null) return miss('context.minutesSinceStatusChange'); return { value: { minutesSinceStatusChange: c.minutesSinceStatusChange, lineMoved: c.lineMovedSinceStatusChange ?? null, lambda: out.wp?.lambda ?? null }, direction: 'neutral', source: 'market.js chooseLambda', note: 'λ rises to 0.30 only within 15 min of news with no line move' }; },
    137: () => { if (!mk || mk.mlHome == null) return miss('market moneylines'); const nv = noVig(mk.mlHome, mk.mlAway); return { value: { hold: r3(nv.hold), books: (out.wp?.books || []).map(b => ({ name: b.name, hold: r3(b.hold) })) }, direction: 'neutral', source: 'market.js noVig / consensus weights 1/hold', note: '' }; },
    138: () => miss('player prop lines feed — not ingested'),
    139: () => miss('prediction-market prices (Kalshi/Polymarket) — not ingested'),
    140: () => (mk?.spreadHome == null ? miss('market spread') : { value: Math.abs(mk.spreadHome), direction: dirOf(-mk.spreadHome), source: 'market.spreadHome', note: mk.spreadHome < 0 ? 'home favourite' : 'away favourite' }),
    // ---------------- M
    141: () => { const c = input.context || {}; return { value: { minutesSinceInjuryReport: c.minutesSinceInjuryReport ?? null, minutesSinceOdds: c.minutesSinceOdds ?? null, term: r3(out.confidence?.terms?.data) }, direction: null, source: 'confidence.js zData', note: '' }; },
    142: () => ({ value: { homeSd: r1(ratings.home?.sd), awaySd: r1(ratings.away?.sd), term: r3(out.confidence?.terms?.param) }, direction: null, source: 'ratings.js kalmanTeam sd → confidence.js zParam', note: '' }),
    143: () => (out.scenarioEntropy == null ? miss('scenario tree') : { value: { bits: r3(out.scenarioEntropy), uncertain: out.uncertainCount, injTerm: r3(out.confidence?.terms?.inj) }, direction: null, source: 'scenarios.js entropy', note: '' }),
    144: () => (out.wp?.disagreeSD == null ? miss('market line') : { value: { gapSD: r3(out.wp.disagreeSD), gapPts: out.margin?.model != null && out.margin?.market != null ? r1(out.margin.model - out.margin.market) : null, flagged: !!out.wp.disagree, term: r3(out.confidence?.terms?.disagree) }, direction: null, source: 'index.js disagreeSD → confidence.js zDisagree', note: '' }),
    145: () => ({ value: null, direction: null, source: 'confidence.js zCalib', note: `needs walk-forward backtest calibration (ECE by bucket); term held at neutral ${out.confidence?.terms?.calib ?? 0.5}` }),
  };

  function miss(what) { return { value: null, direction: null, effect: null, note: `missing: needs ${what}` }; }
  function crewMiss(what) { return miss(`${what}${(input.officials || []).length ? `; crew known: ${input.officials.join(', ')}` : '; crew not announced'}`); }
  function paceRow(T, O, side) {
    const p = teamPace(T, league.pace), q = teamPace(O, league.pace);
    const dPoss = q * (p - league.pace) / league.pace;
    return { value: r1(p), direction: 'neutral', effect: poss ? r1(dPoss * (out.total?.model ?? 0) / poss) : null, effectOn: 'total',
      source: T.pace ? 'TeamIn.pace' : 'ratings.js teamPace (padded estimate from logs)', note: `${side} team; game poss = pH·pA/league` };
  }
  function nInM(k, m) {
    if (!gameLocal) return miss('game date');
    const f = g => g.filter(x => { const d = daysBetween(gameLocal, x.date); return d > 0 && d < m; }).length + 1 >= k;
    return gH.length && gA.length ? { value: { home: f(gH), away: f(gA) }, direction: 'neutral', source: 'player log dates', note: 'no prior; display only' } : miss('player logs');
  }
  function miles7(t, g) {
    if (!gameLocal || !g.length || !ARENAS[t.abbr]) return null;
    const legs = g.filter(x => { const d = daysBetween(gameLocal, x.date); return d > 0 && d <= 7; }).map(x => venueOf(t, x));
    const path = [...legs, venue]; let s = 0;
    for (let i = 1; i < path.length; i++) { const d = travelMiles(path[i - 1], path[i]); if (d == null) return null; s += d; }
    return Math.round(s);
  }
  function tzDays(t, g) {
    if (!gameLocal || !vArena || !gameDate) return null;
    const off = tz => utcOffsetHours(tz, gameDate); const cur = off(vArena.tz);
    for (let i = g.length - 1; i >= 0; i--) { const a = ARENAS[venueOf(t, g[i])]; if (a && off(a.tz) !== cur) return daysBetween(gameLocal, g[i].date); }
    return null;
  }
  function topRate(key, source, note) { return { value: sideVals(H.abbr, A.abbr, ab => top(ab).map(p => ({ name: p.name, [key]: p.rates?.[key] ?? null }))), direction: 'neutral', source, note }; }
  function logRate(fn, label, note) {
    const f = t => (t.players || []).slice().sort((a, b) => baselineMinutes(b).mean - baselineMinutes(a).mean).slice(0, 3).map(p => {
      const s = { fga: 0, fta: 0, ftm: 0, fg3a: 0, oreb: 0, dreb: 0, tov: 0, min: 0 };
      for (const r of (p.log || []).filter(x => x.min > 0)) for (const k of Object.keys(s)) s[k] += r[k] || 0;
      const v = fn(s); return { name: p.name, value: v == null ? null : r3(v) };
    });
    return (H.players || []).length ? { value: { home: f(H), away: f(A), stat: label }, direction: 'neutral', source: 'player logs (season to date in window)', note } : miss('player logs');
  }

  const rows = CATALOGUE.map(([n, group, name, tag, priorKey]) => {
    let r;
    try { r = calc[n] ? calc[n]() : miss('evaluator'); } catch (e) { r = { value: null, direction: null, effect: null, note: `error: ${e.message}` }; }
    const inProjection = tag === 'C' ? C_USED.has(n) : tag === 'X' ? !!(priorKey && PRIORS[priorKey]?.inModel) : false;
    const value = r.value === undefined ? null : r.value;
    const effect = r.effect == null || !isFinite(r.effect) ? null : r.effect;
    let direction = r.direction !== undefined ? r.direction : value == null ? null : effect != null && r.effectOn !== 'total' ? dirOf(effect) : 'neutral';
    if (value == null && r.direction === undefined) direction = null;
    return { n, group, groupName: GROUP_NAMES[group], name, tag, value, direction, effect, effectOn: effect != null ? (r.effectOn || 'margin') : null,
      inProjection, priorKey: priorKey || null, source: r.source || null, note: r.note || '' };
  });
  return rows;
}
