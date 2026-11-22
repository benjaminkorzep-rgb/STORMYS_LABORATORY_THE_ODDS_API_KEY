// Shared numeric helpers. Pure functions, no dependencies.
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const logit = p => { const q = clamp(p, 1e-6, 1 - 1e-6); return Math.log(q / (1 - q)); };
export const expit = x => 1 / (1 + Math.exp(-x));
export const sum = a => a.reduce((s, x) => s + x, 0);
export const mean = a => (a.length ? sum(a) / a.length : NaN);
export function sd(a) { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1)); }
export const round = (x, d = 1) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

// Seeded PRNG (mulberry32) so every writer and the browser reproduce identical draws.
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function randn(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
export function hashSeed(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

// Standard normal CDF (Abramowitz–Stegun 7.1.26, |err| < 7.5e-8).
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}
// Inverse normal CDF (Acklam).
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = clamp(p, 1e-12, 1 - 1e-12), pl = 0.02425;
  if (q < pl) { const r = Math.sqrt(-2 * Math.log(q)); return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  if (q > 1 - pl) { const r = Math.sqrt(-2 * Math.log(1 - q)); return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  const r = q - 0.5, s = r * r;
  return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}
// Bivariate normal orthant probability P(X<h, Y<k) with correlation rho (Drezner–Wesolowsky Gauss–Legendre).
export function binormCdf(h, k, rho) {
  if (Math.abs(rho) < 1e-9) return normCdf(h) * normCdf(k);
  const x = [0.04691008, 0.23076534, 0.5, 0.76923466, 0.95308992], w = [0.018854042, 0.038088059, 0.0452707394, 0.038088059, 0.018854042];
  let s = 0;
  for (let i = 0; i < 5; i++) { const r = rho * x[i]; s += w[i] * Math.exp((2 * h * k * r - h * h - k * k) / (2 * (1 - r * r))) / Math.sqrt(1 - r * r); }
  return normCdf(h) * normCdf(k) + rho * s;
}
export function quantiles(sorted, ps = [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const out = {};
  for (const p of ps) { const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); out['p' + Math.round(p * 100)] = sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
  return out;
}
// Exponentially decayed weighted mean; values newest-first; halfLife in observations.
export function ewma(values, halfLife) {
  let num = 0, den = 0; const k = Math.pow(0.5, 1 / halfLife);
  values.forEach((v, i) => { if (v == null || !isFinite(v)) return; const w = Math.pow(k, i); num += w * v; den += w; });
  return den ? num / den : NaN;
}
// Decayed numerator/denominator pair for rate stats (newest-first).
export function ewmaPair(nums, dens, halfLife) {
  let n = 0, d = 0; const k = Math.pow(0.5, 1 / halfLife);
  for (let i = 0; i < nums.length; i++) { const w = Math.pow(k, i); n += w * (nums[i] || 0); d += w * (dens[i] || 0); }
  return { n, d };
}
// Empirical-Bayes padding (APPENDIX B §7.1): (x + K*mu)/(n + K).
export const pad = (x, n, K, mu) => (x + K * mu) / (n + K);
export const haversineMiles = (a, b) => {
  const R = 3958.8, toR = d => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
