// APPENDIX B §4.3 — market anchoring. Every constant is a prior, refit walk-forward by engine/backtest.mjs.
import { logit, expit, clamp, normCdf } from './math.js';

export const LAMBDA_PRIOR = 0.10;          // model weight in the headline blend
export const LAMBDA_NEWS = 0.30;           // only after a status change <15 min old with no line move
export const MARGIN_SD_PRIOR = 12.5;       // §4.2 expectation, to verify on residuals

export function americanToProb(a) {
  const n = Number(String(a ?? '').replace('+', ''));
  if (!isFinite(n) || n === 0) return null;
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
}
export const probToAmerican = p => (p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p));

// Multiplicative (proportional) de-vig — default.
export function noVigMultiplicative(pH, pA) { if (pH == null || pA == null) return null; return pH / (pH + pA); }
// Power method: find k with pH^k + pA^k = 1.
export function noVigPower(pH, pA) {
  if (pH == null || pA == null) return null;
  let lo = 0.5, hi = 3;
  for (let i = 0; i < 60; i++) { const k = (lo + hi) / 2; (Math.pow(pH, k) + Math.pow(pA, k) > 1) ? (lo = k) : (hi = k); }
  const k = (lo + hi) / 2; return Math.pow(pH, k);
}
// Shin (1993) method for two outcomes: solve insider share z by bisection.
export function noVigShin(pH, pA) {
  if (pH == null || pA == null) return null;
  const B = pH + pA; const shinP = (pi, z) => (Math.sqrt(z * z + 4 * (1 - z) * pi * pi / B) - z) / (2 * (1 - z));
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 80; i++) { const z = (lo + hi) / 2; (shinP(pH, z) + shinP(pA, z) > 1) ? (lo = z) : (hi = z); }
  const z = (lo + hi) / 2; return shinP(pH, z);
}
// Choose method: Shin for long favorites (any side > 75%), else multiplicative (APPENDIX B §4.3).
export function noVig(mlHome, mlAway) {
  const pH = americanToProb(mlHome), pA = americanToProb(mlAway);
  if (pH == null || pA == null) return { p: null, hold: null, method: null };
  const hold = pH + pA - 1;
  const long = Math.max(pH, pA) > 0.75;
  return { p: long ? noVigShin(pH, pA) : noVigMultiplicative(pH, pA), hold, method: long ? 'shin' : 'multiplicative' };
}
// Spread → home win probability under N(-spreadHome, sd).
export const spreadToWp = (spreadHome, sd = MARGIN_SD_PRIOR) => (spreadHome == null ? null : normCdf(-spreadHome / sd));
export const wpToSpread = (p, sd = MARGIN_SD_PRIOR) => { let lo = -40, hi = 40; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; (normCdf(m / sd) < p) ? (lo = m) : (hi = m); } return -(lo + hi) / 2; };

// Consensus: weighted toward lowest-hold books.
export function consensus(books) {
  const rows = (books || []).map(b => ({ ...b, nv: noVig(b.mlHome, b.mlAway) })).filter(b => b.nv.p != null);
  if (!rows.length) return null;
  let num = 0, den = 0;
  for (const b of rows) { const w = 1 / Math.max(0.01, b.nv.hold); num += w * logit(b.nv.p); den += w; }
  return { p: expit(num / den), books: rows.map(b => ({ name: b.name, noVigHome: b.nv.p, hold: b.nv.hold, method: b.nv.method })) };
}

// Headline blend in logit space. lambda rises only under the §4.3 news condition.
export function chooseLambda(ctx = {}) {
  const m = ctx.minutesSinceStatusChange, moved = ctx.lineMovedSinceStatusChange;
  return (m != null && m <= 15 && moved === false) ? LAMBDA_NEWS : LAMBDA_PRIOR;
}
export function blend(pMarket, pModel, lambda = LAMBDA_PRIOR) {
  if (pMarket == null) return pModel;
  if (pModel == null) return pMarket;
  return expit((1 - lambda) * logit(pMarket) + lambda * logit(pModel));
}
export const blendPoint = (mkt, model, lambda = LAMBDA_PRIOR) => (mkt == null ? model : model == null ? mkt : (1 - lambda) * mkt + lambda * model);
export function inferredRange(pMarket, pBpi) {
  // Carried forward from the claude.ai board: market and ESPN BPI, widened ±5 points.
  const pts = [pMarket, pBpi].filter(v => v != null && isFinite(v));
  if (!pts.length) return null;
  return [clamp(Math.min(...pts) - 0.05, 0.01, 0.99), clamp(Math.max(...pts) + 0.05, 0.01, 0.99)];
}
