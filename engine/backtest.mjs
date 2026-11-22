#!/usr/bin/env node
// APPENDIX B §11 walk-forward backtest.
//   node engine/backtest.mjs            tune-period walk-forward (2019-20 … 2023-24) + 2024-25 evaluation; never reads 2025-26
//   node engine/backtest.mjs --freeze   fit params on 2019-20 … 2023-24, validate on 2024-25, write engine/params.frozen.json
//   node engine/backtest.mjs --score    score 2025-26 ONCE vs the no-vig closing line (needs params.frozen.json; writes the lock)
// Every feature is built as of T-60: team histories contain only games from strictly earlier dates (asserted per game).
// Seasons the cache does not fully cover are reported "not run" — nothing is ever fabricated.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SEASONS, SCORE_SEASON, seasonOfDate, seasonDates, datePath, computeProgress, CACHE_DIR, addDays } from './backfill.mjs';
import { kalmanTeam } from '../core/engine/ratings.js';
import { noVig, spreadToWp, blend, blendPoint } from '../core/engine/market.js';
import { normCdf, ewma } from '../core/engine/math.js';
import { confidence, zParam, zDisagree, zCalib } from '../core/engine/confidence.js';
import * as M from './metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENGINE_DIR = HERE;
export const STATUS_LINE = 'This engine has not yet been run or backtested. Every number in the spec is a starting prior to be re-estimated by the walk-forward backtest.';
const TEAMS = new Set(['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW', 'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NOP', 'NYK', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS']);
const ALIAS = { GS: 'GSW', NY: 'NYK', NO: 'NOP', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS', BRK: 'BKN', PHO: 'PHX', CHO: 'CHA' };
const abbr = a => (a == null ? null : ALIAS[String(a).toUpperCase()] || String(a).toUpperCase());

// ================================================================ freeze guard
export class FreezeError extends Error { constructor(m) { super(m); this.name = 'FreezeError'; } }
export class LeakageError extends Error { constructor(m) { super(m); this.name = 'LeakageError'; } }
export function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const sha256Params = params => createHash('sha256').update(canonicalJson(params)).digest('hex');
export const frozenPath = (engineDir = ENGINE_DIR) => join(engineDir, 'params.frozen.json');
export const scoreLockPath = (engineDir = ENGINE_DIR) => join(engineDir, `score.${SCORE_SEASON}.lock`);

// Returns the verified frozen record; throws FreezeError unless params.frozen.json exists with a valid sha256 + frozenAt.
export function loadFrozen(engineDir = ENGINE_DIR) {
  const p = frozenPath(engineDir);
  if (!existsSync(p)) throw new FreezeError(`Refusing to read ${SCORE_SEASON} data: ${p} does not exist. Tune on 2019-20…2023-24 and freeze on 2024-25 first (node engine/backtest.mjs --freeze).`);
  let rec; try { rec = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new FreezeError(`Refusing to read ${SCORE_SEASON} data: params.frozen.json is not valid JSON (${e.message})`); }
  if (!rec || typeof rec.params !== 'object' || !rec.params) throw new FreezeError('Refusing: params.frozen.json has no params object');
  if (!rec.frozenAt || Number.isNaN(Date.parse(rec.frozenAt))) throw new FreezeError('Refusing: params.frozen.json has no valid frozenAt timestamp');
  if (typeof rec.sha256 !== 'string' || rec.sha256 !== sha256Params(rec.params)) throw new FreezeError('Refusing: params.frozen.json sha256 does not match its params (tampered or edited after freezing)');
  return rec;
}
// The one gate every cache read goes through.
export function assertMayReadSeason(season, { engineDir = ENGINE_DIR } = {}) {
  if (season === SCORE_SEASON) loadFrozen(engineDir);
  return true;
}
export function readScoreLock(engineDir = ENGINE_DIR) {
  const p = scoreLockPath(engineDir);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export async function readDateFile(dateKey, { dir = CACHE_DIR, engineDir = ENGINE_DIR } = {}) {
  const s = seasonOfDate(dateKey);
  assertMayReadSeason(s?.season, { engineDir });
  const p = datePath(dateKey, dir);
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, 'utf8'));
}

// ================================================================ params
export function loadPriorParams(engineDir = ENGINE_DIR) {
  return JSON.parse(readFileSync(join(engineDir, 'params.prior.json'), 'utf8')).params;
}

// ================================================================ walk-forward model ("analyzeGame-lite": team ratings + market blend)
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
function newTeam() { return { games: [], carry: 0, lastNet: 0, elo: 1505 }; }
export function assertNoLeakage(rows, dateKey, label) {
  for (const r of rows) if (!(r.date < dateKey)) throw new LeakageError(`Future leakage: ${label} history row dated ${r.date} used for game on ${dateKey}`);
}

function teamFeatures(T, dateKey, P, label) {
  assertNoLeakage(T.games, dateKey, label);
  const adj = T.games.map(g => ({ margin: g.margin - (g.hcaEff - 2.0) * (g.home ? 1 : -1), home: g.home })); // kalmanTeam removes a fixed 2.0
  const k = kalmanTeam(adj, { prior: T.carry, priorSd: P.priorSd, tau: P.kalmanTau, obsSd: P.obsSd, poss: P.poss });
  const last = T.games[T.games.length - 1];
  const rest = last ? Math.min(3, Math.max(0, daysBetween(last.date, dateKey) - 1)) : 3;
  const newest = [...T.games].reverse();
  return { net: k.net, sd: k.sd, rest, b2b: !!last && rest === 0, n: T.games.length, ptsFor: newest.map(g => g.ptsFor), ptsAgainst: newest.map(g => g.ptsAgainst) };
}
const paddedEwma = (vals, lg, P) => (vals.length ? (ewma(vals, P.ptsHalfLife) * vals.length + lg * P.ptsPadGames) / (vals.length + P.ptsPadGames) : lg);
const mktP = m => (m ? (noVig(m.mlHome, m.mlAway).p ?? (m.spreadHome != null ? spreadToWp(m.spreadHome) : null)) : null);

export function eventsOf(file) {
  return (file?.events || []).filter(e => e.completed && e.home?.score != null && e.away?.score != null && TEAMS.has(abbr(e.home.abbr)) && TEAMS.has(abbr(e.away.abbr)));
}

// Runs the walk-forward across `seasons` (in order). Returns per-game prediction rows.
export async function walkForward(seasons, P, { dir = CACHE_DIR, engineDir = ENGINE_DIR, log = () => {} } = {}) {
  const teams = new Map(); const team = a => { if (!teams.has(a)) teams.set(a, newTeam()); return teams.get(a); };
  const home = { w: 0, n: 0 }; const lgPts = [];
  const rows = []; let prevSeason = null;
  for (const S of seasons) {
    assertMayReadSeason(S.season, { engineDir });
    const contiguous = prevSeason && SEASONS.findIndex(x => x.season === S.season) === SEASONS.findIndex(x => x.season === prevSeason) + 1;
    for (const [, T] of teams) {
      T.carry = contiguous ? P.carryover * T.lastNet : 0;
      T.games = []; T.elo = contiguous ? 0.75 * T.elo + 0.25 * 1505 : 1505;
    }
    for (const d of seasonDates(S, '9999-12-31')) {
      const file = await readDateFile(d, { dir, engineDir });
      const evs = eventsOf(file); if (!evs.length) continue;
      const updates = [];
      for (const e of evs) {
        const hA = abbr(e.home.abbr), aA = abbr(e.away.abbr); const H = team(hA), A = team(aA);
        const flagged = !!S.flagged && d >= (S.flagFrom || S.start);
        const hcaScale = flagged ? P.flaggedHcaWeight : (e.neutral ? 0 : 1);
        const hcaEff = P.hca * hcaScale;
        const fH = teamFeatures(H, d, P, hA), fA = teamFeatures(A, d, P, aA);
        const marginModel = fH.net - fA.net + hcaEff + P.b2b * ((fH.b2b ? 1 : 0) - (fA.b2b ? 1 : 0));
        const sdModel = Math.sqrt(P.marginSd ** 2 + fH.sd ** 2 + fA.sd ** 2);
        const lg = lgPts.length ? lgPts.slice(-600).reduce((s, x) => s + x, 0) / Math.min(600, lgPts.length) : P.leaguePtsPrior;
        const offH = paddedEwma(fH.ptsFor, lg, P), defH = paddedEwma(fH.ptsAgainst, lg, P), offA = paddedEwma(fA.ptsFor, lg, P), defA = paddedEwma(fA.ptsAgainst, lg, P);
        const totalModel = (offH + defA - lg) + (offA + defH - lg);
        const pElo = 1 / (1 + Math.pow(10, -(H.elo - A.elo + P.eloHome * hcaScale) / 400));
        const close = e.odds?.close || null, open = e.odds?.open || null;
        const pClose = mktP(close), pOpen = mktP(open);
        const margin = e.home.score - e.away.score, total = e.home.score + e.away.score;
        const gapOpen = open?.spreadHome != null ? marginModel + open.spreadHome : null;
        const grade = confidence({ param: zParam((fH.sd + fA.sd) / 2), inj: 0, disagree: gapOpen != null ? zDisagree(gapOpen) : 0.5, data: 0.5, calib: zCalib(null), role: 0 }).grade;
        const dt = new Date(e.date || d + 'T23:00:00Z');
        rows.push({ id: e.id, date: d, season: S.season, role: S.role, flagged, neutral: !!e.neutral, home: hA, away: aA,
          y: margin > 0 ? 1 : 0, margin, total, marginModel, sdModel, totalModel, pModel: normCdf(marginModel / sdModel), pElo,
          pHomeRate: (home.w + P.homeRatePrior * P.homeRatePseudo) / (home.n + P.homeRatePseudo),
          pClose, pOpen, spreadClose: close?.spreadHome ?? null, totalClose: close?.total ?? null, spreadOpen: open?.spreadHome ?? null, totalOpen: open?.total ?? null,
          restH: fH.rest, restA: fA.rest, b2bH: fH.b2b, b2bA: fA.b2b, nH: fH.n, nA: fA.n, grade, month: dt.getUTCMonth() + 1, dow: new Date(d + 'T12:00:00Z').getUTCDay(),
          historyMaxDate: [...H.games, ...A.games].reduce((m, g) => (g.date > m ? g.date : m), '') || null });
        updates.push({ H, A, margin, hcaEff, hcaScale, e, fH, fA });
      }
      for (const u of updates) {                      // results become visible only after every game on this date is predicted
        const { H, A, margin, hcaEff, hcaScale, e } = u;
        H.games.push({ date: d, margin, home: true, hcaEff, ptsFor: e.home.score, ptsAgainst: e.away.score });
        A.games.push({ date: d, margin: -margin, home: false, hcaEff, ptsFor: e.away.score, ptsAgainst: e.home.score });
        const dr = H.elo - A.elo + P.eloHome * hcaScale; const exp = 1 / (1 + Math.pow(10, -dr / 400)); const won = margin > 0 ? 1 : 0;
        const mult = Math.pow(Math.abs(margin) + 3, 0.8) / (7.5 + 0.006 * (won ? dr : -dr));
        H.elo += P.eloK * mult * (won - exp); A.elo -= P.eloK * mult * (won - exp);
        if (!e.neutral && hcaScale === 1) { home.n++; home.w += won; }
        lgPts.push(e.home.score, e.away.score);
      }
    }
    for (const [, T] of teams) { const f = T.games.length ? teamFeatures(T, '9999-12-31', P, 'season-end') : null; T.lastNet = f ? f.net : 0; }
    log(`[backtest] ${S.season}: ${rows.filter(r => r.season === S.season).length} games`);
    prevSeason = S.season;
  }
  return rows;
}

// ================================================================ fitting
const llBlend = (rows, lam) => M.logLoss(rows.map(r => blend(r.pClose, r.pModel, lam)), rows.map(r => r.y));
export function fitLambda(rows) {
  const R = rows.filter(r => r.pClose != null);
  if (R.length < 20) return null;
  let a = 0, b = 1; const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a), fc = llBlend(R, c), fd = llBlend(R, d);
  for (let i = 0; i < 40; i++) { if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = llBlend(R, c); } else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = llBlend(R, d); } }
  let lam = (a + b) / 2; if (llBlend(R, 0) <= llBlend(R, lam)) lam = 0;
  return lam;
}
const isoWeek = d => { const t = new Date(d + 'T12:00:00Z'); return Math.floor((t - Date.UTC(2019, 0, 7)) / (7 * 864e5)); };
export function lambdaCI(rows, { B = 200, seed = 11 } = {}) {
  const R = rows.filter(r => r.pClose != null); if (R.length < 20) return null;
  const groups = [...R.reduce((m, r) => { const k = isoWeek(r.date); if (!m.has(k)) m.set(k, []); m.get(k).push(r); return m; }, new Map()).values()];
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const est = [];
  for (let b = 0; b < B; b++) { const smp = []; for (let i = 0; i < groups.length; i++) smp.push(...groups[Math.floor(rnd() * groups.length)]); const l = fitLambda(smp); if (l != null) est.push(l); }
  est.sort((x, y) => x - y); const q = f => est[Math.min(est.length - 1, Math.floor(f * est.length))];
  return { lambda: fitLambda(R), ci80: [q(0.1), q(0.9)], ci95: [q(0.025), q(0.975)], B: est.length, n: R.length };
}
function halves(rows, seasons) {
  const out = [];
  for (const s of seasons) {
    const r = rows.filter(x => x.season === s).sort((a, b) => a.date.localeCompare(b.date)); if (!r.length) continue;
    const mid = r[Math.floor(r.length / 2)].date;
    out.push({ key: `${s}a`, season: s, rows: r.filter(x => x.date < mid) }, { key: `${s}b`, season: s, rows: r.filter(x => x.date >= mid) });
  }
  return out;
}
// Expanding-window walk-forward λ on season halves: λ for half i is fitted on halves 0..i−1 only.
export function lambdaWalkForward(rows, seasons, prior) {
  const H = halves(rows, seasons); const steps = []; let train = [];
  for (const h of H) {
    const fit = train.length ? lambdaCI(train) : null; const lam = fit?.lambda ?? prior;
    const R = h.rows.filter(r => r.pClose != null);
    steps.push({ half: h.key, trainN: train.filter(r => r.pClose != null).length, lambda: lam, ci80: fit?.ci80 ?? null, ci95: fit?.ci95 ?? null, fromPrior: !fit,
      testN: R.length, oosLogLossBlend: R.length ? llBlend(R, lam) : null, oosLogLossClose: R.length ? llBlend(R, 0) : null });
    for (const r of h.rows) r.lambdaWF = lam;
    train = train.concat(h.rows);
  }
  return steps;
}
export function fitTuned(tuneRows, P) {
  const lam = lambdaCI(tuneRows);
  const plain = tuneRows.filter(r => !r.flagged && !r.neutral);
  const res = tuneRows.map(r => r.margin - r.marginModel), tres = tuneRows.map(r => r.total - r.totalModel);
  const sdv = a => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length - (a.reduce((s, x) => s + x, 0) / a.length) ** 2);
  const avgSdRating = Math.sqrt(tuneRows.reduce((s, r) => s + (r.sdModel ** 2 - P.marginSd ** 2), 0) / tuneRows.length);
  const tuned = { ...P,
    lambda: lam?.lambda ?? P.lambda,
    hca: plain.length ? P.hca + plain.reduce((s, r) => s + r.margin - r.marginModel, 0) / plain.length : P.hca,
    marginSd: res.length ? Math.sqrt(Math.max(1, sdv(res) ** 2 - avgSdRating ** 2)) : P.marginSd,
    totalSd: tres.length ? sdv(tres) : P.totalSd };
  return { tuned, lambdaFit: lam, n: tuneRows.length, method: 'one-step: λ by log-loss minimisation (golden section) on tune games with a closing line; hca = prior + mean home residual (non-flagged, non-neutral); marginSd/totalSd = residual SD net of rating uncertainty. Ratings are not re-run with the new hca.' };
}

// ================================================================ metrics per season
const pick = (rows, f) => rows.filter(f);
function compare(rows, a, b, label) {
  const R = rows.filter(r => r[a] != null && r[b] != null); if (R.length < 30) return { label, n: R.length, note: 'too few paired games' };
  const y = R.map(r => r.y);
  const la = M.logLosses(R.map(r => r[a]), y), lb = M.logLosses(R.map(r => r[b]), y);
  return { label, n: R.length, logLossA: la.reduce((s, x) => s + x, 0) / R.length, logLossB: lb.reduce((s, x) => s + x, 0) / R.length,
    bootstrap: M.pairedBlockBootstrap(la, lb, { blocks: R.map(r => isoWeek(r.date)), B: 1000 }), dm: M.dieboldMariano(la, lb) };
}
export function seasonMetrics(rows, lambda, { recalFrom = [] } = {}) {
  for (const r of rows) { const lam = r.lambdaWF ?? lambda; r.pBlend = r.pClose != null ? blend(r.pClose, r.pModel, lam) : null; r.marginBlend = blendPoint(r.spreadClose != null ? -r.spreadClose : null, r.marginModel, lam); }
  const y = R => R.map(r => r.y);
  const prob = key => { const R = pick(rows, r => r[key] != null); return R.length ? M.probabilitySummary(R.map(r => r[key]), y(R)) : null; };
  const withClose = pick(rows, r => r.pClose != null);
  const out = {
    n: rows.length, flagged: rows.filter(r => r.flagged).length, withClose: withClose.length, withOpen: rows.filter(r => r.pOpen != null).length,
    moneyline: { model: prob('pModel'), blend: prob('pBlend'), elo: prob('pElo'), homeRate: prob('pHomeRate'), closeNoVig: prob('pClose'), openNoVig: prob('pOpen'),
      comparisons: [compare(rows, 'pModel', 'pClose', 'model vs no-vig close'), compare(rows, 'pBlend', 'pClose', 'blend vs no-vig close'), compare(rows, 'pElo', 'pClose', 'Elo vs no-vig close'), compare(rows, 'pModel', 'pElo', 'model vs Elo'), compare(rows, 'pOpen', 'pClose', 'no-vig open vs no-vig close')] },
    spread: {
      model: M.distributionSummary(rows.map(r => r.marginModel), rows.map(r => r.sdModel), rows.map(r => r.margin)),
      close: withClose.some(r => r.spreadClose != null) ? (R => M.distributionSummary(R.map(r => -r.spreadClose), R.map(r => r.sdModel), R.map(r => r.margin)))(rows.filter(r => r.spreadClose != null)) : null,
      blend: (R => (R.length ? M.distributionSummary(R.map(r => r.marginBlend), R.map(r => r.sdModel), R.map(r => r.margin)) : null))(rows.filter(r => r.marginBlend != null)) },
    total: { model: M.distributionSummary(rows.map(r => r.totalModel), rows.map(() => r0sd(rows)), rows.map(r => r.total)),
      close: (R => (R.length ? M.distributionSummary(R.map(r => r.totalClose), R.map(() => r0sd(rows)), R.map(r => r.total)) : null))(rows.filter(r => r.totalClose != null)) },
    grades: M.monotoneGrades(rows.map(r => ({ grade: r.grade, err: Math.abs(r.margin - (r.marginBlend ?? r.marginModel)) }))),
  };
  if (recalFrom.length >= 200) {
    const pf = M.plattFit(recalFrom.map(r => r.pModel), recalFrom.map(r => r.y)); const iso = M.isotonicFit(recalFrom.map(r => r.pModel), recalFrom.map(r => r.y));
    const yy = y(rows);
    out.recalibration = { fittedOn: recalFrom.length, platt: pf, logLossRaw: M.logLoss(rows.map(r => r.pModel), yy), logLossPlatt: M.logLoss(rows.map(r => M.plattApply(pf, r.pModel)), yy), logLossIsotonic: M.logLoss(rows.map(r => Math.min(1 - 1e-6, Math.max(1e-6, M.isotonicApply(iso, r.pModel)))), yy) };
  }
  return out;
}
let TOTAL_SD = 18; const r0sd = () => TOTAL_SD;

// ================================================================ residual records for the trend engine
export function residualRecords(rows) {
  const out = [];
  for (const r of rows) for (const side of ['home', 'away']) {
    const s = side === 'home' ? 1 : -1;
    const closeM = r.spreadClose != null ? -r.spreadClose * s : null, openM = r.spreadOpen != null ? -r.spreadOpen * s : null;
    out.push({ season: r.season, date: r.date, gameId: r.id, teamAbbr: side === 'home' ? r.home : r.away, oppAbbr: side === 'home' ? r.away : r.home, home: side === 'home',
      restDays: side === 'home' ? r.restH : r.restA, oppRestDays: side === 'home' ? r.restA : r.restH, b2b: side === 'home' ? r.b2bH : r.b2bA,
      gameNumber: (side === 'home' ? r.nH : r.nA) + 1, month: r.month, dow: r.dow, flagged: r.flagged,
      favSize: closeM, lineMove: closeM != null && openM != null ? closeM - openM : null, totalMove: r.totalClose != null && r.totalOpen != null ? r.totalClose - r.totalOpen : null,
      residModel: s * (r.margin - r.marginModel), residClose: closeM != null ? s * r.margin - closeM : null,
      totalResidModel: r.total - r.totalModel, totalResidClose: r.totalClose != null ? r.total - r.totalClose : null });
  }
  return out;
}

// ================================================================ orchestration
async function coverage({ dir, now }) { return computeProgress({ dir, now }); }
const rolesOf = role => SEASONS.filter(s => s.role === role);
// Contiguous covered runs among the requested seasons (an uncovered season breaks the chain → cold start).
function coveredSeasons(names, prog) { return SEASONS.filter(s => names.includes(s.season) && prog.seasons[s.season]?.complete); }

export async function runBacktest({ mode = 'run', dir = CACHE_DIR, engineDir = ENGINE_DIR, now = new Date(), log = console.log } = {}) {
  const prog = await coverage({ dir, now });
  const P0 = loadPriorParams(engineDir); TOTAL_SD = P0.totalSd;
  const tuneNames = rolesOf('tune').map(s => s.season), freezeName = rolesOf('freeze')[0].season;
  const results = { generatedAt: now.toISOString(), statusLine: STATUS_LINE, mode, protocol: { tune: tuneNames, freeze: freezeName, score: SCORE_SEASON, featureTime: 'T-60 (histories restricted to strictly earlier dates; asserted per game)', flaggedHcaWeight: P0.flaggedHcaWeight, marketForBlend: 'ESPN pickcenter post-game line (≈ close, single provider) used as the T-60 market proxy; leaks ≤60 min of movement' },
    coverage: prog, priorParams: P0, seasons: {} };
  for (const s of SEASONS.filter(x => x.role !== 'live')) {
    const c = prog.seasons[s.season];
    results.seasons[s.season] = s.role === 'score' ? { status: 'locked', role: s.role, reason: `scored once with --score after params.frozen.json exists (${c?.pct ?? 0}% cached)` }
      : c?.complete ? { status: 'pending', role: s.role } : { status: 'not run', role: s.role, reason: `cache does not cover this season (${c?.cached ?? 0}/${c?.dates ?? 0} dates)` };
  }

  if (mode === 'score') {
    const frozen = loadFrozen(engineDir);                      // throws FreezeError
    const lock = readScoreLock(engineDir);
    if (lock) { log(`[backtest] ${SCORE_SEASON} was already scored at ${lock.scoredAt}; refusing a second scoring run. Earlier result:`); log(JSON.stringify(lock.result, null, 2)); return { alreadyScored: true, lock }; }
    if (!prog.seasons[SCORE_SEASON]?.complete) throw new Error(`${SCORE_SEASON} is not fully cached; nothing scored, lock not written`);
    const chain = coveredSeasons([...tuneNames, freezeName, SCORE_SEASON], prog);
    TOTAL_SD = frozen.params.totalSd;
    const rows = await walkForward(chain, frozen.params, { dir, engineDir, log });
    const sr = rows.filter(r => r.season === SCORE_SEASON);
    const result = { season: SCORE_SEASON, paramsSha256: frozen.sha256, frozenAt: frozen.frozenAt, lambda: frozen.params.lambda, benchmark: 'no-vig closing line', metrics: seasonMetrics(sr, frozen.params.lambda, { recalFrom: rows.filter(r => r.season !== SCORE_SEASON) }) };
    const lockRec = { scoredAt: new Date().toISOString(), paramsSha256: frozen.sha256, result };
    await writeFile(scoreLockPath(engineDir), JSON.stringify(lockRec, null, 2), { flag: 'wx' }); // wx: fails if a lock appeared meanwhile
    const prev = existsSync(join(engineDir, 'backtest-results.json')) ? JSON.parse(await readFile(join(engineDir, 'backtest-results.json'), 'utf8')) : results;
    prev.score = result; prev.seasons = { ...(prev.seasons || {}), [SCORE_SEASON]: { status: 'scored', role: 'score', ...result } };
    await writeFile(join(engineDir, 'backtest-results.json'), JSON.stringify(prev, null, 1));
    await appendResiduals(engineDir, residualRecords(sr));
    log(`[backtest] ${SCORE_SEASON} scored once; lock written.`);
    return { result };
  }

  const chain = coveredSeasons([...tuneNames, freezeName], prog);
  if (!chain.length) {
    log('[backtest] no season is fully cached — every season reported "not run".');
    results.status = 'not run';
    await writeFile(join(engineDir, 'backtest-results.json'), JSON.stringify(results, null, 1));
    return { results };
  }
  const rows = await walkForward(chain, P0, { dir, engineDir, log });
  const tuneCovered = chain.filter(s => s.role === 'tune').map(s => s.season);
  results.lambdaWalkForward = lambdaWalkForward(rows, tuneCovered, P0.lambda);
  const tuneRows = rows.filter(r => r.role === 'tune');
  const fit = tuneRows.length ? fitTuned(tuneRows, P0) : null;
  results.tuned = fit ? { params: fit.tuned, lambdaFit: fit.lambdaFit, n: fit.n, method: fit.method } : null;
  for (const s of chain) {
    const sr = rows.filter(r => r.season === s.season);
    const lam = s.role === 'freeze' ? (fit?.tuned.lambda ?? P0.lambda) : P0.lambda;
    if (s.role === 'freeze') for (const r of sr) delete r.lambdaWF;
    results.seasons[s.season] = { status: 'ok', role: s.role, flaggedNote: s.flagged ? s.note : null, lambdaUsed: s.role === 'freeze' ? lam : 'walk-forward per half', metrics: seasonMetrics(sr, lam, { recalFrom: rows.filter(r => r.date < sr[0]?.date) }) };
  }
  results.status = 'ok';
  if (mode === 'freeze') {
    if (readScoreLock(engineDir)) throw new FreezeError(`${SCORE_SEASON} is already scored; params can no longer be re-frozen`);
    if (!tuneNames.every(n => prog.seasons[n]?.complete) || !prog.seasons[freezeName]?.complete) throw new FreezeError(`Freeze needs every tune season and ${freezeName} fully cached`);
    if (existsSync(frozenPath(engineDir)) && !process.argv.includes('--refreeze')) throw new FreezeError('params.frozen.json already exists (pass --refreeze to replace it; impossible once scored)');
    const params = fit.tuned;
    const rec = { params, sha256: sha256Params(params), frozenAt: new Date().toISOString(), tunedOn: tuneNames, validatedOn: freezeName, validation: summary(results.seasons[freezeName].metrics) };
    await writeFile(frozenPath(engineDir), JSON.stringify(rec, null, 2));
    results.freeze = rec; log(`[backtest] params frozen: sha256 ${rec.sha256}`);
  }
  await writeFile(join(engineDir, 'backtest-results.json'), JSON.stringify(results, null, 1));
  await writeFile(join(engineDir, 'backtest-residuals.json'), JSON.stringify({ generatedAt: now.toISOString(), note: `excludes ${SCORE_SEASON} until scored`, records: residualRecords(rows) }));
  log(`[backtest] wrote backtest-results.json (${rows.length} games)`);
  return { results, rows };
}
const summary = m => ({ n: m.n, logLossModel: m.moneyline.model?.logLoss, logLossBlend: m.moneyline.blend?.logLoss, logLossClose: m.moneyline.closeNoVig?.logLoss, brierBlend: m.moneyline.blend?.brier, eceModel: m.moneyline.model?.ece });
async function appendResiduals(engineDir, recs) {
  const p = join(engineDir, 'backtest-residuals.json');
  const cur = existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : { records: [] };
  cur.records = cur.records.filter(r => r.season !== SCORE_SEASON).concat(recs); cur.note = `includes ${SCORE_SEASON} (scored once)`;
  await writeFile(p, JSON.stringify(cur));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv.includes('--score') ? 'score' : process.argv.includes('--freeze') ? 'freeze' : 'run';
  runBacktest({ mode }).catch(e => { console.error(`[backtest] ${e.name}: ${e.message}`); process.exit(e instanceof FreezeError ? 2 : 1); });
}
