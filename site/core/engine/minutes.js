// APPENDIX B §5 — minutes engine: availability, baseline, redistribution (Dirichlet prior 20 games),
// 240×(1+0.104·P(OT)) constraint solve, blowout curves, foul-trouble risk, return-from-absence cap.
import { ewma, clamp, normCdf } from './math.js';

// §5.1 status priors (SwishRank; key players at T-2h from Mysports.AI).
export const STATUS_PRIOR = { Active: 0.995, Available: 0.995, Probable: 0.91, Questionable: 0.50, 'Game-Time Decision': 0.50, 'Day-To-Day': 0.70, Doubtful: 0.02, Out: 0.003, Suspended: 0.0, 'Out For Season': 0.0 };
export const KEY_PLAYER_T2H = { Probable: 0.97, Questionable: 0.56, QuestionableEarly: 0.60, QuestionableLate: 0.47, Doubtful: 0.01 };
export const PLAYED_Q_MINUTES_PENALTY = -1.8;     // §5.1, prior
export const DIRICHLET_GAMES = 20;                 // §5.3 prior concentration
export const OT_MIN_FACTOR = 0.104;                // 5 min × 5 players / 240
export const BLOWOUT_START = 13;                   // §5.4 ~12–15 pt margin
export const BLOWOUT_SLOPE = 0.9;                  // starter minutes lost per point beyond start (prior: 34→26 at 22)

export function availability(p, { hoursToTip = null, key = false } = {}) {
  const s = normStatus(p.status);
  let prob = STATUS_PRIOR[s] ?? 0.995;
  if (key && hoursToTip != null && hoursToTip <= 2.5) {
    if (s === 'Questionable') prob = p.listedLate ? KEY_PLAYER_T2H.QuestionableLate : KEY_PLAYER_T2H.QuestionableEarly;
    else if (KEY_PLAYER_T2H[s] != null) prob = KEY_PLAYER_T2H[s];
  }
  // player random effect: partial pooling of own history of playing through listings (n games played while listed)
  if (p.listedHistory && p.listedHistory.n > 0) { const { played, n } = p.listedHistory; prob = (played + 10 * prob) / (n + 10); }
  return clamp(prob, 0, 1);
}
export function normStatus(s) {
  if (!s) return 'Active';
  const t = String(s).toLowerCase();
  if (t.includes('out for season')) return 'Out For Season';
  if (t.startsWith('out')) return 'Out';
  if (t.includes('doubt')) return 'Doubtful';
  if (t.includes('question') || t === 'gtd' || t.includes('game-time')) return 'Questionable';
  if (t.includes('probable')) return 'Probable';
  if (t.includes('day-to-day') || t.includes('day to day')) return 'Day-To-Day';
  if (t.includes('suspend')) return 'Suspended';
  return 'Active';
}

const posGroup = pos => { const p = String(pos || '').toUpperCase(); if (p.includes('C')) return 'big'; if (p.includes('F')) return 'wing'; return 'guard'; };
const posSim = (a, b) => (posGroup(a) === posGroup(b) ? 1 : (posGroup(a) === 'wing' || posGroup(b) === 'wing') ? 0.55 : 0.2);

// §5.2 baseline minutes: EWMA (half-life 3 games) over games played; role from starter flag / recent starts.
export function baselineMinutes(p) {
  const played = (p.log || []).filter(r => r.min > 0);
  if (!played.length) return { mean: p.starter ? 28 : 8, cv: 0.6, games: 0, p95: 36, pf36: 3.5 };
  const mins = played.map(r => r.min);
  const m = ewma(mins.slice(0, 15), 3);
  const avg = mins.slice(0, 10).reduce((s, x) => s + x, 0) / Math.min(10, mins.length);
  const sdv = Math.sqrt(mins.slice(0, 10).reduce((s, x) => s + (x - avg) ** 2, 0) / Math.max(1, Math.min(10, mins.length) - 1));
  const sorted = [...mins].sort((a, b) => a - b); const p95 = sorted[Math.floor(0.95 * (sorted.length - 1))];
  const pfMin = played.reduce((s, r) => s + (r.min || 0), 0), pf = played.reduce((s, r) => s + (r.pf || 0), 0);
  const pf36 = (pf + 3.5 * 300 / 36) / (pfMin + 300) * 36;       // shrunk PF/36, K=300 min toward 3.5
  return { mean: m, cv: avg ? sdv / avg : 0.4, games: played.length, p95, pf36 };
}

// §5.5 foul-trouble probability: Poisson P(PF ≥ 5) over projected minutes, crew foul delta optional.
export function foulTroubleRisk(pf36, minutes, crewFoulDelta = 0) {
  const lam = Math.max(0.1, (pf36 + crewFoulDelta * 0.1) * minutes / 36);
  let cdf = 0, term = Math.exp(-lam); for (let k = 0; k < 5; k++) { cdf += term; term *= lam / (k + 1); }
  return 1 - cdf;
}

// Expected starter-minute loss given margin distribution N(mu, sd): E[max(0,|M|-start)] × slope.
export function blowoutLoss(mu, sdv, start = BLOWOUT_START, slope = BLOWOUT_SLOPE) {
  let e = 0; const n = 41;
  for (let i = 0; i < n; i++) { const z = -4 + 8 * i / (n - 1); const w = Math.exp(-z * z / 2); const m = mu + sdv * z; e += w * Math.max(0, Math.abs(m) - start); }
  const norm = Array.from({ length: n }, (_, i) => { const z = -4 + 8 * i / (n - 1); return Math.exp(-z * z / 2); }).reduce((s, x) => s + x, 0);
  return slope * e / norm;
}
export const pBlowout = (mu, sdv, start = BLOWOUT_START) => normCdf((-start - mu) / sdv) + 1 - normCdf((start - mu) / sdv);

// §5.3 redistribution + constraint solve for one team in one scenario.
// players: [{id,name,pos,starter,base:{mean,p95,...}, withoutHistory?}] ; outIds: Set of players not playing.
export function solveTeamMinutes(players, outIds, { pOT = 0.06, questionablePlaying = new Set(), returnCaps = {} } = {}) {
  const avail = players.filter(p => !outIds.has(p.id));
  const out = players.filter(p => outIds.has(p.id));
  const m = {}; for (const p of avail) m[p.id] = p.base.mean + (questionablePlaying.has(p.id) ? PLAYED_Q_MINUTES_PENALTY : 0);
  // Allocation weights π_jk: prior = position similarity × depth headroom, Dirichlet-updated with observed games when k sat.
  for (const k of out) {
    const V = k.base.mean; if (V <= 0) continue;
    const w = avail.map(j => {
      const headroom = Math.max(0, (j.base.p95 || 36) - m[j.id]);
      const prior = posSim(j.pos, k.pos) * (headroom + 1) * (j.starter ? 1.2 : 1);
      const obs = j.withoutHistory?.[k.id]; // {games, extraMin}
      const dir = obs ? (DIRICHLET_GAMES * prior + obs.games * Math.max(0, obs.extraMin)) / (DIRICHLET_GAMES + obs.games) : prior;
      return { j, w: dir };
    });
    const tot = w.reduce((s, x) => s + x.w, 0) || 1;
    for (const { j, w: wj } of w) m[j.id] += V * wj / tot;
  }
  // Iterative proportional fitting to 240 × (1 + 0.104·P(OT)) with caps min(42, p95+4) and return-from-absence caps.
  const target = 240 * (1 + OT_MIN_FACTOR * pOT);
  const cap = p => Math.min(42, (p.base.p95 || 38) + 4, returnCaps[p.id] ?? 99);
  for (let it = 0; it < 50; it++) {
    const total = Object.values(m).reduce((s, x) => s + x, 0); if (Math.abs(total - target) < 0.05) break;
    const free = avail.filter(p => (total < target ? m[p.id] < cap(p) - 1e-6 : m[p.id] > 0));
    const freeSum = free.reduce((s, p) => s + m[p.id], 0) || 1;
    for (const p of free) m[p.id] = clamp(m[p.id] * (1 + (target - total) / freeSum), 0, cap(p));
  }
  return m;
}

// Return-from-absence cap (§5.1): games 1–3 after ≥5 missed → cap prior 26 (wide).
export function returnCap(p) {
  if ((p.gamesMissed || 0) >= 5) { const back = (p.log || []).filter(r => r.min > 0).length; return 26; }
  return null;
}
