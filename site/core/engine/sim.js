// APPENDIX B §4.1–4.2 — expected points, bivariate-normal score draws with overtime, all outputs from the same draws.
import { rng, randn, quantiles, normCdf } from './math.js';

export const MARGIN_SD = 12.5;   // to verify on walk-forward residuals (§4.2)
export const TOTAL_SD = 18.0;
export const OT_TARGET = 0.059;  // empirical check (Vertize)
// Prior: share of 1–3 point regulation finishes pulled to a tie (late-game fouling / tying shots). A plain discretised
// normal gives ~3.2% ties for an even game; 0.14 lifts that to ≈ OT_TARGET. Refit on walk-forward OT frequency.
export const TIE_PULL = 0.14;

export function expectedPoints({ poss, lgOrtg, offH, defH, offA, defA, marginAdj }) {
  const ptsH = poss / 100 * (lgOrtg + offH - defA) + marginAdj / 2;
  const ptsA = poss / 100 * (lgOrtg + offA - defH) - marginAdj / 2;
  return { ptsH, ptsA };
}

// Draw (ptsH, ptsA) with corr derived from margin and total SDs; resolve ties with 5-minute OT periods.
export function simulate({ ptsH, ptsA, poss, n = 10000, seed = 7, marginSd = MARGIN_SD, totalSd = TOTAL_SD, spreadLine = null, totalLine = null }) {
  const r = rng(seed);
  const scale = Math.sqrt(poss / 99);           // σ scales with pace
  const sM = marginSd * scale, sT = totalSd * scale;
  const margins = new Float64Array(n), totals = new Float64Array(n); let wins = 0, ot = 0, cover = 0, over = 0;
  const otPer = (ptsH + ptsA) / 48 * 5;
  for (let i = 0; i < n; i++) {
    let M = ptsH - ptsA + sM * randn(r), T = ptsH + ptsA + sT * randn(r);
    let h = (T + M) / 2, a = (T - M) / 2; h = Math.round(h); a = Math.round(a);
    if (h !== a && Math.abs(h - a) <= 3 && r() < TIE_PULL) { if (h > a) h = a; else a = h; }
    let periods = 0;
    while (h === a && periods < 4) {           // overtime
      periods++; ot += periods === 1 ? 1 : 0;
      const dm = (ptsH - ptsA) / 48 * 5 + 4.0 * randn(r), dt = otPer + 3.0 * randn(r);
      h += Math.round((dt + dm) / 2); a += Math.round((dt - dm) / 2);
      if (h === a && periods === 4) h += 1;
    }
    margins[i] = h - a; totals[i] = h + a;
    if (h > a) wins++;
    if (spreadLine != null && (h - a) + spreadLine > 0) cover++;
    if (totalLine != null && (h + a) > totalLine) over++;
  }
  const ms = Array.from(margins).sort((x, y) => x - y), ts = Array.from(totals).sort((x, y) => x - y);
  return {
    wpHome: wins / n, pOT: ot / n,
    margin: { mean: ms.reduce((s, x) => s + x, 0) / n, sd: sM, q: quantiles(ms) },
    total: { mean: ts.reduce((s, x) => s + x, 0) / n, sd: sT, q: quantiles(ts) },
    pCoverHome: spreadLine != null ? cover / n : null, pOver: totalLine != null ? over / n : null,
  };
}
// Fast analytic version for scenario enumeration (no OT detail).
export function analytic({ ptsH, ptsA, poss }) {
  const sM = MARGIN_SD * Math.sqrt(poss / 99);
  return { wpHome: normCdf((ptsH - ptsA) / sM), margin: ptsH - ptsA, total: ptsH + ptsA };
}
