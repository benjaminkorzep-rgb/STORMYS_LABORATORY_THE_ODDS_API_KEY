// APPENDIX B §8 — injury/lineup scenario tree: enumeration (≤6 uncertain → 2^|U|, else Monte Carlo 64),
// within-team dependence via a Gaussian copula on star pairs, mixture + conditional panels + swing table.
import { normInv, binormCdf, rng } from './math.js';

export const RHO_STAR_B2B = -0.3;   // unverified prior (§8.2)
export const RHO_ILLNESS = 0.2;     // unverified prior

// Joint probability of a play/sit vector for a set of uncertain players with pairwise correlations.
// Exact for pairs (bivariate normal orthant), product-of-pair-adjustments approximation beyond 2.
export function scenarioProb(us, a, rhoFn) {
  let p = 1;
  for (let i = 0; i < us.length; i++) p *= a[i] ? us[i].p : 1 - us[i].p;
  for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) {
    const rho = rhoFn(us[i], us[j]); if (!rho) continue;
    const hi = normInv(us[i].p), hj = normInv(us[j].p);
    const pjoint = binormCdf(a[i] ? hi : -hi, a[j] ? hj : -hj, a[i] === a[j] ? rho : -rho);
    const pind = (a[i] ? us[i].p : 1 - us[i].p) * (a[j] ? us[j].p : 1 - us[j].p);
    if (pind > 0) p *= pjoint / pind;
  }
  return p;
}
export function defaultRho(x, y) {
  if (x.team !== y.team) return 0;
  if (x.b2b && x.star && y.star) return RHO_STAR_B2B;
  if (/ill/i.test(x.detail || '') && /ill/i.test(y.detail || '')) return RHO_ILLNESS;
  return 0;
}

export function enumerate(us, rhoFn = defaultRho, { maxExact = 6, mc = 64, seed = 11 } = {}) {
  const out = [];
  if (us.length <= maxExact) {
    for (let mask = 0; mask < (1 << us.length); mask++) {
      const a = us.map((_, i) => ((mask >> i) & 1) === 1);
      out.push({ a, prob: scenarioProb(us, a, rhoFn) });
    }
  } else {
    const r = rng(seed); const seen = new Map();
    for (let k = 0; k < mc; k++) { const a = us.map(u => r() < u.p); const key = a.map(Number).join(''); seen.set(key, (seen.get(key) || 0) + 1 / mc); }
    for (const [key, prob] of seen) out.push({ a: [...key].map(c => c === '1'), prob });
  }
  const tot = out.reduce((s, x) => s + x.prob, 0) || 1; out.forEach(x => { x.prob /= tot; });
  return out;
}

// Conditional mixture given player i plays (val=true) or sits.
export function conditional(scen, i, val, key) {
  const sub = scen.filter(s => s.a[i] === val); const tot = sub.reduce((t, s) => t + s.prob, 0);
  if (!tot) return null;
  return sub.reduce((acc, s) => acc + s.prob / tot * key(s), 0);
}
// Market reconciliation (§8.4): which play probability makes the model's conditional WPs reproduce the market WP.
export function marketImpliedPlay(pMarket, wpPlays, wpSits) {
  if (pMarket == null || wpPlays == null || wpSits == null || Math.abs(wpPlays - wpSits) < 0.01) return null;
  const p = (pMarket - wpSits) / (wpPlays - wpSits);
  return Math.max(0, Math.min(1, p));
}
export const entropy = scen => -scen.reduce((s, x) => s + (x.prob > 0 ? x.prob * Math.log2(x.prob) : 0), 0);
