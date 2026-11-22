// APPENDIX B §11 — forecast-verification metrics. Pure functions, plain ES module, no platform APIs.
// p = forecast probability of the event, y = outcome in {0,1}. All array inputs are equal length.
import { normCdf, rng } from '../core/engine/math.js';

const SQRT_PI = Math.sqrt(Math.PI);
const phi = z => Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const check = (a, b) => { if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) throw new Error('metrics: inputs must be equal-length arrays'); };

// ---------------------------------------------------------------- probability scores
export function brier(p, y) { check(p, y); return avg(p.map((q, i) => (q - y[i]) ** 2)); }
export function logLoss(p, y, eps = 1e-15) {
  check(p, y);
  return avg(p.map((q, i) => { const c = Math.min(1 - eps, Math.max(eps, q)); return -(y[i] ? Math.log(c) : Math.log(1 - c)); }));
}
export const brierLosses = (p, y) => p.map((q, i) => (q - y[i]) ** 2);
export const logLosses = (p, y, eps = 1e-15) => p.map((q, i) => { const c = Math.min(1 - eps, Math.max(eps, q)); return -(y[i] ? Math.log(c) : Math.log(1 - c)); });

// Equal-frequency bins (sorted by p; ties kept together where possible). Returns [{lo,hi,n,meanP,rate,ciLo,ciHi}].
export function equalFreqBins(p, y, k = 10) {
  check(p, y);
  const idx = p.map((q, i) => i).sort((a, b) => p[a] - p[b]);
  const N = idx.length; const bins = [];
  if (!N) return bins;
  const kk = Math.min(k, N);
  for (let b = 0; b < kk; b++) {
    const s = Math.floor(b * N / kk), e = Math.floor((b + 1) * N / kk);
    const sl = idx.slice(s, e); if (!sl.length) continue;
    const n = sl.length, meanP = avg(sl.map(i => p[i])), rate = avg(sl.map(i => y[i]));
    const [ciLo, ciHi] = wilson(rate * n, n);
    bins.push({ lo: p[sl[0]], hi: p[sl[n - 1]], n, meanP, rate, ciLo, ciHi });
  }
  return bins;
}
export function wilson(x, n, z = 1.959964) {
  if (!n) return [0, 1];
  const ph = x / n, d = 1 + z * z / n, c = ph + z * z / (2 * n), h = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}
// Expected calibration error with 10 equal-frequency bins (§11).
export function ece(p, y, k = 10) {
  const bins = equalFreqBins(p, y, k); const N = p.length;
  return N ? bins.reduce((s, b) => s + b.n / N * Math.abs(b.rate - b.meanP), 0) : NaN;
}
export const reliabilityDiagram = (p, y, k = 10) => ({ bins: equalFreqBins(p, y, k), ece: ece(p, y, k), n: p.length });

// Murphy (1973) decomposition over equal-frequency bins: BS ≈ REL − RES + UNC (+ within-bin term WBV, so the identity is exact).
export function murphy(p, y, k = 10) {
  check(p, y);
  const N = p.length; const ybar = avg(y);
  const idx = p.map((q, i) => i).sort((a, b) => p[a] - p[b]);
  let rel = 0, res = 0, wbv = 0, wbc = 0;
  const kk = Math.min(k, N);
  for (let b = 0; b < kk; b++) {
    const sl = idx.slice(Math.floor(b * N / kk), Math.floor((b + 1) * N / kk)); if (!sl.length) continue;
    const n = sl.length, mp = avg(sl.map(i => p[i])), o = avg(sl.map(i => y[i]));
    rel += n * (mp - o) ** 2; res += n * (o - ybar) ** 2;
    for (const i of sl) { wbv += (p[i] - mp) ** 2; wbc += 2 * (p[i] - mp) * (mp - y[i]); }
  }
  const unc = ybar * (1 - ybar);
  return { reliability: rel / N, resolution: res / N, uncertainty: unc, withinBin: (wbv + wbc) / N, brier: brier(p, y) };
}

// ---------------------------------------------------------------- continuous scores
export function mae(pred, obs) { check(pred, obs); return avg(pred.map((m, i) => Math.abs(m - obs[i]))); }
export function rmse(pred, obs) { check(pred, obs); return Math.sqrt(avg(pred.map((m, i) => (m - obs[i]) ** 2))); }
// Closed-form CRPS of N(mu, sigma²) at x (Gneiting & Raftery 2007).
export function crpsNormal(mu, sigma, x) {
  if (!(sigma > 0)) return Math.abs(mu - x);
  const z = (x - mu) / sigma;
  return sigma * (z * (2 * normCdf(z) - 1) + 2 * phi(z) - 1 / SQRT_PI);
}
// Sample CRPS: E|X−x| − ½E|X−X'| using the sorted-sample identity (O(n log n)).
export function crpsSamples(samples, x) {
  const s = [...samples].sort((a, b) => a - b); const n = s.length;
  if (!n) return NaN;
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) { a += Math.abs(s[i] - x); b += s[i] * (2 * (i + 1) - n - 1); }
  return a / n - b / (n * n);
}
export const meanCrpsNormal = (mu, sd, x) => avg(x.map((v, i) => crpsNormal(mu[i], Array.isArray(sd) ? sd[i] : sd, v)));

// PIT values and histogram (uniform ⇔ calibrated predictive distribution).
export const pitNormal = (mu, sigma, x) => normCdf((x - mu) / sigma);
export function pitHistogram(pits, bins = 10) {
  const counts = new Array(bins).fill(0);
  for (const u of pits) counts[Math.min(bins - 1, Math.max(0, Math.floor(u * bins)))]++;
  const n = pits.length;
  return { bins, counts, freq: counts.map(c => (n ? c / n : 0)), n, chi2: n ? counts.reduce((s, c) => s + (c - n / bins) ** 2 / (n / bins), 0) : null };
}
// Central interval coverage of N(mu, sd) at the given levels.
export function intervalCoverage(mu, sd, x, levels = [0.5, 0.8, 0.95]) {
  const out = {};
  for (const L of levels) {
    const z = normInvLocal(0.5 + L / 2);
    const hits = x.map((v, i) => { const s = Array.isArray(sd) ? sd[i] : sd; return Math.abs(v - mu[i]) <= z * s ? 1 : 0; });
    out[String(L)] = { nominal: L, observed: avg(hits), n: x.length };
  }
  return out;
}
function normInvLocal(p) { let lo = -10, hi = 10; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; (normCdf(m) < p) ? (lo = m) : (hi = m); } return (lo + hi) / 2; }

// ---------------------------------------------------------------- comparison tests
// Paired block bootstrap CI on mean(lossA − lossB). blocks: array of block ids (e.g. ISO week) or a block length.
export function pairedBlockBootstrap(lossA, lossB, { blocks = 7, B = 2000, seed = 7, alpha = 0.05 } = {}) {
  check(lossA, lossB);
  const d = lossA.map((a, i) => a - lossB[i]); const n = d.length;
  if (!n) return { diff: NaN, lo: NaN, hi: NaN, pBetterB: NaN, B, nBlocks: 0 };
  let groups;
  if (Array.isArray(blocks)) { const m = new Map(); blocks.forEach((b, i) => { if (!m.has(b)) m.set(b, []); m.get(b).push(i); }); groups = [...m.values()]; }
  else { groups = []; for (let i = 0; i < n; i += blocks) groups.push(Array.from({ length: Math.min(blocks, n - i) }, (_, j) => i + j)); }
  const sums = groups.map(g => [g.reduce((s, i) => s + d[i], 0), g.length]);
  const r = rng(seed); const stats = [];
  for (let b = 0; b < B; b++) {
    let s = 0, c = 0;
    for (let g = 0; g < sums.length; g++) { const k = Math.floor(r() * sums.length); s += sums[k][0]; c += sums[k][1]; }
    stats.push(s / c);
  }
  stats.sort((a, b) => a - b);
  const q = f => stats[Math.min(B - 1, Math.max(0, Math.floor(f * B)))];
  return { diff: avg(d), lo: q(alpha / 2), hi: q(1 - alpha / 2), pBetterB: stats.filter(x => x > 0).length / B, B, nBlocks: groups.length };
}
// Diebold–Mariano test on loss differential d = lossA − lossB with Newey–West variance (lag h−1). Two-sided normal p.
export function dieboldMariano(lossA, lossB, { h = 1 } = {}) {
  check(lossA, lossB);
  const d = lossA.map((a, i) => a - lossB[i]); const n = d.length;
  if (n < 3) return { stat: NaN, p: NaN, meanDiff: NaN, n };
  const m = avg(d);
  const gamma = k => { let s = 0; for (let t = k; t < n; t++) s += (d[t] - m) * (d[t - k] - m); return s / n; };
  let v = gamma(0);
  for (let k = 1; k < h; k++) v += 2 * (1 - k / h) * gamma(k);
  const se = Math.sqrt(Math.max(v, 1e-300) / n);
  const stat = m / se;
  return { stat, p: 2 * (1 - normCdf(Math.abs(stat))), meanDiff: m, n };
}

// ---------------------------------------------------------------- recalibration
// Platt scaling on logit(p): q = σ(a·logit(p) + b), fitted by Newton–Raphson on log loss.
export function plattFit(p, y, { iters = 50 } = {}) {
  check(p, y);
  const x = p.map(q => { const c = Math.min(1 - 1e-9, Math.max(1e-9, q)); return Math.log(c / (1 - c)); });
  let a = 1, b = 0;
  for (let it = 0; it < iters; it++) {
    let ga = 0, gb = 0, haa = 1e-9, hab = 0, hbb = 1e-9;
    for (let i = 0; i < x.length; i++) {
      const q = 1 / (1 + Math.exp(-(a * x[i] + b))); const e = q - y[i]; const w = q * (1 - q);
      ga += e * x[i]; gb += e; haa += w * x[i] * x[i]; hab += w * x[i]; hbb += w;
    }
    const det = haa * hbb - hab * hab; if (Math.abs(det) < 1e-12) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a -= da; b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  return { a, b };
}
export const plattApply = ({ a, b }, p) => { const c = Math.min(1 - 1e-9, Math.max(1e-9, p)); return 1 / (1 + Math.exp(-(a * Math.log(c / (1 - c)) + b))); };

// Isotonic regression by pool-adjacent-violators (non-decreasing). Returns { x: block upper bounds, xs: block lower bounds, y: fitted }.
export function isotonicFit(x, y, w = null) {
  check(x, y);
  const idx = x.map((v, i) => i).sort((a, b) => x[a] - x[b]);
  const blocks = [];
  for (const i of idx) {
    blocks.push({ lo: x[i], hi: x[i], sw: w ? w[i] : 1, sy: (w ? w[i] : 1) * y[i] });
    while (blocks.length > 1) {
      const B = blocks[blocks.length - 1], A = blocks[blocks.length - 2];
      if (A.sy / A.sw <= B.sy / B.sw) break;
      blocks.splice(blocks.length - 2, 2, { lo: A.lo, hi: B.hi, sw: A.sw + B.sw, sy: A.sy + B.sy });
    }
  }
  return { xs: blocks.map(b => b.lo), x: blocks.map(b => b.hi), y: blocks.map(b => b.sy / b.sw) };
}
// Step-function evaluation with linear interpolation between block centres (stays monotone).
export function isotonicApply(fit, v) {
  const n = fit.y.length; if (!n) return v;
  const c = fit.x.map((hi, i) => (hi + fit.xs[i]) / 2);
  if (v <= c[0]) return fit.y[0];
  if (v >= c[n - 1]) return fit.y[n - 1];
  let i = 0; while (i < n - 1 && c[i + 1] < v) i++;
  const t = (v - c[i]) / ((c[i + 1] - c[i]) || 1);
  return fit.y[i] + t * (fit.y[i + 1] - fit.y[i]);
}

// ---------------------------------------------------------------- §9 grade check
// rows: [{ grade: 'A'|'B'|'C'|'D', err: number }]. Passes when mean realized error is non-decreasing A ≤ B ≤ C ≤ D
// (strict A<B<C<D reported separately); grades with no rows are skipped.
export function monotoneGrades(rows) {
  const G = ['A', 'B', 'C', 'D']; const by = {};
  for (const g of G) { const e = rows.filter(r => r.grade === g).map(r => r.err); by[g] = { n: e.length, meanErr: e.length ? avg(e) : null }; }
  const present = G.filter(g => by[g].n > 0).map(g => by[g].meanErr);
  let monotone = true, strict = true;
  for (let i = 1; i < present.length; i++) { if (present[i] < present[i - 1]) monotone = false; if (!(present[i] > present[i - 1])) strict = false; }
  return { byGrade: by, monotone, strict, gradesPresent: present.length };
}

// ---------------------------------------------------------------- bundles
export function probabilitySummary(p, y) {
  if (!p.length) return null;
  const m = murphy(p, y);
  return { n: p.length, brier: brier(p, y), logLoss: logLoss(p, y), ece: ece(p, y), murphy: m, reliability: equalFreqBins(p, y, 10) };
}
export function distributionSummary(mu, sd, x) {
  if (!x.length) return null;
  const sds = Array.isArray(sd) ? sd : x.map(() => sd);
  return { n: x.length, mae: mae(mu, x), rmse: rmse(mu, x), crps: meanCrpsNormal(mu, sds, x), pit: pitHistogram(x.map((v, i) => pitNormal(mu[i], sds[i], v))), coverage: intervalCoverage(mu, sds, x) };
}
