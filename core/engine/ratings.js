// APPENDIX B §2 (player impact layer) and §3 (results-based Kalman layer, pace, Elo fallback).
import { ewma, ewmaPair, pad, mean } from './math.js';

// DARKO-like half-lives (games) — starting priors (§2.3).
export const HALF_LIFE = { start: 1, minutes: 2, played: 3, fg3aShare: 13, usage: 17, ast: 24, pts: 31, blk: 41, dreb: 46, oreb: 54, stl: 75, tov: 90, ft: 115, fg3pct: 120 };

// §2.1 box-score prior (SPM proxy). Without stint data in the 10 ms writer we use a game-score-per-36 SPM,
// shrunk toward replacement (−2.0 pts/100) with a minutes-based weight. Coefficients are priors to refit
// against multi-year RAPM in engine/nightly (§2.2) once the backfill exists.
export function boxSPM(log) {
  const g = log.filter(r => r.min > 0);
  if (!g.length) return { spm: -2.0, minutes: 0, sd: 2.5 };
  const k = HALF_LIFE.pts;
  const f = key => ewmaPair(g.map(r => r[key] || 0), g.map(r => r.min), k);
  const s = {}; for (const key of ['pts', 'fgm', 'fga', 'ftm', 'fta', 'oreb', 'dreb', 'stl', 'ast', 'blk', 'pf', 'tov']) s[key] = f(key);
  const per36 = key => (s[key].d ? 36 * s[key].n / s[key].d : 0);
  const gs36 = per36('pts') + 0.4 * per36('fgm') - 0.7 * per36('fga') - 0.4 * (per36('fta') - per36('ftm')) + 0.7 * per36('oreb') + 0.3 * per36('dreb') + per36('stl') + 0.7 * per36('ast') + 0.7 * per36('blk') - 0.4 * per36('pf') - per36('tov');
  const raw = (gs36 - 12.0) * 0.45;                 // map to ~pts/100 scale (prior slope)
  const minutes = s.pts.d;                           // decayed minutes of evidence
  const K = 600;                                     // minutes of padding toward replacement (prior)
  const spm = pad(raw * minutes, minutes, K, -2.0);
  return { spm, minutes, sd: 2.5 * Math.sqrt(K / (minutes + K)) };
}

// §2.4 team rating from players for a given minutes vector.
export function playerTeamNet(players, minutesById) {
  let net = 0;
  for (const p of players) { const m = minutesById[p.id] || 0; net += (p.impact ?? -2) * m / 48; }
  return net + 10.0; // centre: a rotation of replacement-level (−2/100 × 5) sums to −10; re-centred so league-average ≈ 0
}

// §3.1 Kalman filter on team net margin per 100 possessions (random walk, τ≈0.8/game, obs noise ≈13.5 pts/game).
export function kalmanTeam(games, { prior = 0, priorSd = 4.0, tau = 0.8, obsSd = 13.5, poss = 99 } = {}) {
  // games oldest-first: [{ margin, home }]; margin in points; home advantage removed with the 2.0 prior.
  let m = prior, v = priorSd ** 2; const R = (obsSd * 100 / poss) ** 2;
  for (const g of games) {
    v += tau ** 2;
    const y = (g.margin - (g.home ? 2.0 : -2.0)) * 100 / poss;
    const K = v / (v + R); m = m + K * (y - m); v = (1 - K) * v;
  }
  return { net: m * poss / 100, sd: Math.sqrt(v) * poss / 100 };
}

// Reconstruct a team's games from its players' logs (dates with teamPts/oppPts). Newest-first in, oldest-first out.
export function teamGamesFromPlayers(players) {
  const byDate = new Map();
  for (const p of players) for (const r of p.log || []) if (r.teamPts != null && r.oppPts != null && !byDate.has(r.date)) byDate.set(r.date, { date: r.date, margin: r.teamPts - r.oppPts, home: !!r.home, pts: r.teamPts, opp: r.oppPts, oppAbbr: r.oppAbbr, fga: null });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// §3.2 pace: padded decayed average (≈10 games of league average) of estimated possessions.
export function teamPace(team, leaguePace) {
  if (team.pace) return team.pace;
  const games = teamGamesFromPlayers(team.players || []);
  const est = games.map(g => (g.pts + g.opp) / 2 / 1.12).reverse(); // pts/possession ≈ 1.12 (prior), newest-first
  if (!est.length) return leaguePace;
  const m = ewma(est, 15); const n = est.length;
  return (m * n + leaguePace * 10) / (n + 10);
}

// §3.3 Elo fallback / anomaly detector (538-style, home +62 Elo ≈ 2 pts after refit prior).
export function elo(games, { k = 20, home = 62 } = {}) {
  let r = 1500;
  for (const g of games) {
    const opp = 1500; const d = r + (g.home ? home : -home) - opp;
    const exp = 1 / (1 + Math.pow(10, -d / 400)); const won = g.margin > 0 ? 1 : 0;
    const mult = Math.log(Math.abs(g.margin) + 1) * 2.2 / ((won ? d : -d) * 0.001 + 2.2);
    r += k * mult * (won - exp);
  }
  return { elo: r, net: (r - 1500) / 28 };
}

export function teamRatings(team, league) {
  const games = teamGamesFromPlayers(team.players || []);
  const seasonPrior = (team.ppg != null && team.oppg != null) ? (team.ppg - team.oppg) * 0.5 : 0; // shrink record-based net 50% toward 0
  const k = kalmanTeam(games, { prior: seasonPrior, poss: league.pace });
  const e = elo(games);
  const recent = games.slice(-10).map(g => g.margin);
  return { results: k.net, resultsSd: k.sd, elo: e.elo, eloNet: e.net, gamesUsed: games.length, last10Net: recent.length ? mean(recent) : null };
}
