// APPENDIX B §9 — confidence 0–100 and grade A–D. Weights are priors; refit quarterly so grades separate realized error.
import { clamp } from './math.js';
export const WEIGHTS = { param: 0.25, inj: 0.25, disagree: 0.15, data: 0.10, calib: 0.15, role: 0.10 };
export const gradeOf = s => (s >= 75 ? 'A' : s >= 55 ? 'B' : s >= 35 ? 'C' : 'D');
export function confidence(terms, weights = WEIGHTS) {
  const t = {};
  for (const k of Object.keys(weights)) t[k] = clamp(terms[k] ?? 0, 0, 1);
  const pen = Object.keys(weights).reduce((s, k) => s + weights[k] * t[k], 0);
  const score = Math.round(100 * (1 - clamp(pen, 0, 1)));
  return { score, grade: gradeOf(score), terms: t, note: 'Describes forecast sharpness and reliability, not betting edge.' };
}
// Term builders.
export const zParam = (ratingSd, p90 = 4.0) => clamp(ratingSd / p90, 0, 1);
export const zDisagree = (gapPts, sdPts = 12.5) => clamp(Math.abs(gapPts) / sdPts / 3 * 4, 0, 1); // gap in SD units ÷ 3, scaled to margin units
export function zData({ minutesSinceInjuryReport = null, minutesSinceOdds = null, startersConfirmed = false, refsKnown = false }) {
  let z = 0;
  if (minutesSinceInjuryReport == null || minutesSinceInjuryReport > 60) z += 0.35;
  if (minutesSinceOdds == null || minutesSinceOdds > 40) z += 0.25;
  if (!startersConfirmed) z += 0.25;
  if (!refsKnown) z += 0.15;
  return clamp(z, 0, 1);
}
export const zCalib = ece => (ece == null ? 0.5 : clamp(ece / 0.05, 0, 1)); // unknown calibration until backtest → 0.5
export function zRole({ minutesCv = 0.3, gamesSinceRoleChange = 10, returning = false }) {
  return clamp(0.5 * clamp(minutesCv / 0.6, 0, 1) + 0.3 * clamp((10 - gamesSinceRoleChange) / 10, 0, 1) + (returning ? 0.2 : 0), 0, 1);
}
