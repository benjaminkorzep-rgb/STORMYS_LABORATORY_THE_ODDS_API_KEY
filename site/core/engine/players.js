// APPENDIX B §7 — shrunk per-minute rates, usage redistribution, stat construction, distributions, displayed splits.
import { ewmaPair, pad, normInv, clamp } from './math.js';
import { HALF_LIFE } from './ratings.js';

// Padding constants K (§7.1). Only 3P% (~240 3PA) is sourced; the rest are starting guesses to fit.
export const K = { fg3pct: 240, ftpct: 100, usgPoss: 300, astPoss: 400, rebPoss: 300 };
export const LG = { fg3pct: 0.36, ftpct: 0.78, pts36: 15.5, reb36: 6.0, ast36: 3.5, fg3a36: 4.5, tov36: 2.0 };
export const USAGE_EFF_GAMMA = 0.25; // TS pts lost per usage pt (§7.2, unverified prior)

export function playerRates(p) {
  const g = (p.log || []).filter(r => r.min > 0);
  const pair = (key, hl) => ewmaPair(g.map(r => r[key] || 0), g.map(r => r.min), hl);
  const mins = pair('min', HALF_LIFE.pts).d;
  const r36 = (key, hl, lg, Kmin) => { const { n, d } = pair(key, hl); return pad(36 * n, d, Kmin, lg); };
  const f3 = ewmaPair(g.map(r => r.fg3m || 0), g.map(r => r.fg3a || 0), HALF_LIFE.fg3pct);
  const fg3pctRaw = f3.d ? f3.n / f3.d : null;
  const fg3pct = pad(f3.n, f3.d, K.fg3pct, LG.fg3pct);   // never adjusted for opponent 3P% allowed (§7.2)
  const pts36 = r36('pts', HALF_LIFE.pts, LG.pts36, 250);
  const reb36 = r36('reb', HALF_LIFE.dreb, LG.reb36, 300);
  const ast36 = r36('ast', HALF_LIFE.ast, LG.ast36, 400);
  const fg3a36 = r36('fg3a', HALF_LIFE.fg3aShare, LG.fg3a36, 200);
  const fgaP = ewmaPair(g.map(r => (r.fga || 0) + 0.44 * (r.fta || 0) + (r.tov || 0)), g.map(r => r.min), HALF_LIFE.usage);
  const usg36 = fgaP.d ? 36 * fgaP.n / fgaP.d : 14;
  const ptsP = ewmaPair(g.map(r => r.pts || 0), g.map(r => 2 * ((r.fga || 0) + 0.44 * (r.fta || 0))), HALF_LIFE.pts);
  const ts = ptsP.d ? pad(ptsP.n, ptsP.d, 150, 0.57 * 1) : 0.57;
  return { pts36, reb36, ast36, fg3a36, fg3pct, fg3pctRaw, usg36, ts, minutesEvidence: mins, games: g.length };
}

// Displayed personal splits (§7.4): shown with n and shrinkage, NEVER in the projection unless §10 validates.
export function personalSplits(p, game) {
  const g = (p.log || []).filter(r => r.min > 0);
  const base = g.length ? g.reduce((s, r) => s + r.pts, 0) / g.length : null;
  const mk = (key, label, filter) => {
    const s = g.filter(filter); const n = s.length; if (!n || base == null) return { key, label, n, raw: null, shrunk: null, inProjection: false, why: 'no games in this split' };
    const raw = s.reduce((t, r) => t + r.pts, 0) / n - base;
    const shrunk = raw * n / (n + 25);                           // prior: ~25 games of padding toward 0
    return { key, label, n, raw: Math.round(raw * 10) / 10, shrunk: Math.round(shrunk * 10) / 10, inProjection: false, why: `display only: n=${n}; personal splits failed out of sample (FV-2026-05) and must pass §10 first` };
  };
  const d = new Date(game.date); const dow = d.getUTCDay(); const month = d.getUTCMonth();
  return [
    mk('home', p.isHome ? 'At home' : 'On the road', r => !!r.home === !!p.isHome),
    mk('opp', `vs ${p.oppAbbr}`, r => r.oppAbbr === p.oppAbbr),
    mk('dow', `On ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow]}`, r => new Date(r.date).getUTCDay() === dow),
    mk('month', `In ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month]}`, r => new Date(r.date).getUTCMonth() === month),
    mk('b2b', 'On back-to-backs', r => r.b2b === true),
    mk('afterLoss', 'After a team loss', (r, i) => false),
  ];
}

// Stat construction for one scenario (§7.2). usageBoost = vacated usage share received (fraction of own usage).
export function projectPlayer(rates, minutes, { paceFactor = 1, usageBoost = 0, oppAdj = {} } = {}) {
  const m = minutes; const f = m / 36 * paceFactor;
  const usgMult = 1 + usageBoost;
  const effPenalty = 1 - USAGE_EFF_GAMMA * usageBoost * 0.2;
  const pts = rates.pts36 * f * usgMult * effPenalty * (oppAdj.pts ?? 1);
  const fg3a = rates.fg3a36 * f * usgMult * (oppAdj.fg3a ?? 1);
  const fg3m = fg3a * rates.fg3pct;
  const reb = rates.reb36 * f * (oppAdj.reb ?? 1);
  const ast = rates.ast36 * f * (oppAdj.ast ?? 1);
  return { pts, reb, ast, fg3m, pra: pts + reb + ast };
}

// Negative-binomial-ish 10–90 bands with variance from minutes uncertainty (§7.3); dispersion phi priors.
const PHI = { pts: 1.6, reb: 1.4, ast: 1.5, fg3m: 1.3, pra: 1.7 };
export function band(mean, key, minSd, minMean) {
  if (!(mean > 0)) return { mean: 0, p10: 0, p90: 0 };
  const rate = minMean > 0 ? mean / minMean : 0;
  const v = PHI[key] * mean + (rate * minSd) ** 2;
  const s = Math.sqrt(v); const z = normInv(0.9);
  return { mean: Math.round(mean * 10) / 10, p10: Math.round(clamp(mean - z * s, 0, 999) * 10) / 10, p90: Math.round((mean + z * s) * 10) / 10 };
}
