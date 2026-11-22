// Ensemble orchestrator: player-impact layer (§2) + Kalman results layer (§3) + minutes engine (§5) + context (§6)
// + game sim (§4) + player stats (§7) + scenario tree (§8) + market anchor (§4.3) + confidence (§9) + factors (§13).
import { clamp, logit, round, hashSeed } from './math.js';
import { noVig, spreadToWp, blend, blendPoint, chooseLambda, inferredRange, consensus, LAMBDA_PRIOR } from './market.js';
import { boxSPM, playerTeamNet, teamRatings, teamPace } from './ratings.js';
import { availability, normStatus, baselineMinutes, solveTeamMinutes, foulTroubleRisk, blowoutLoss, pBlowout, returnCap } from './minutes.js';
import { simulate, analytic, MARGIN_SD } from './sim.js';
import { playerRates, projectPlayer, band, personalSplits } from './players.js';
import { enumerate, conditional, marketImpliedPlay, entropy } from './scenarios.js';
import { confidence, zParam, zDisagree, zData, zCalib, zRole } from './confidence.js';
import { contextTerms, ARENAS } from './context.js';
import { evaluateFactors } from './factors.js';

export const ENGINE_VERSION = '1.0.0-priors';
export const STATUS_LINE = 'This engine has not yet been run or backtested. Every number in the spec is a starting prior to be re-estimated by the walk-forward backtest.';
export const DEFAULT_LEAGUE = { ortg: 114.5, pace: 99.0, hca: 2.0 };   // replaced by 30-day rolling league values when available

// α (player-layer weight) prior: 0.75 for ≤15 games, falling linearly to 0.55 by game 40 (§4.1).
export const alphaFor = games => (games <= 15 ? 0.75 : games >= 40 ? 0.55 : 0.75 - 0.2 * (games - 15) / 25);

function prepTeam(team, side, game) {
  const players = (team.players || []).map(p => {
    const base = baselineMinutes(p);
    const spm = boxSPM(p.log || []);
    const status = normStatus(p.status);
    const isKey = base.mean >= 28;
    return { ...p, team: team.abbr, side, status, base, impact: spm.spm, impactSd: spm.sd, rates: playerRates(p), star: isKey, b2b: !!team.b2b,
      p: availability({ ...p, status }, { hoursToTip: game.hoursToTip, key: isKey }), retCap: returnCap(p), isHome: side === 'home' };
  }).filter(p => p.status !== 'Out For Season' || p.base.games > 0);
  // rotation = players with meaningful recent minutes or starters
  const rotation = players.filter(p => p.base.mean >= 6 || p.starter).sort((a, b) => b.base.mean - a.base.mean).slice(0, 13);
  return { ...team, prepared: rotation };
}

function evalScenario(H, A, outH, outA, qH, qA, ctx) {
  const { league, rH, rA, cterms, game } = ctx;
  const mH = solveTeamMinutes(H.prepared, outH, { pOT: 0.06, questionablePlaying: qH, returnCaps: Object.fromEntries(H.prepared.filter(p => p.retCap).map(p => [p.id, p.retCap])) });
  const mA = solveTeamMinutes(A.prepared, outA, { pOT: 0.06, questionablePlaying: qA, returnCaps: Object.fromEntries(A.prepared.filter(p => p.retCap).map(p => [p.id, p.retCap])) });
  const netPH = playerTeamNet(H.prepared, mH), netPA = playerTeamNet(A.prepared, mA);
  const aH = alphaFor(rH.gamesUsed), aA = alphaFor(rA.gamesUsed);
  const netH = aH * netPH + (1 - aH) * rH.results, netA = aA * netPA + (1 - aA) * rA.results;
  const poss = ctx.pace;
  // Offense/defense split: results layer gives the level of scoring (ppg/oppg vs league), net gives the gap.
  const lgPts = league.ortg * poss / 100;
  const offLevelH = H.ppg != null ? (H.ppg - lgPts) * 0.5 : 0, defLevelH = H.oppg != null ? (lgPts - H.oppg) * 0.5 : 0;
  const offLevelA = A.ppg != null ? (A.ppg - lgPts) * 0.5 : 0, defLevelA = A.oppg != null ? (lgPts - A.oppg) * 0.5 : 0;
  const tilt = (netH - (offLevelH + defLevelH)) / 2, tiltA = (netA - (offLevelA + defLevelA)) / 2;
  const offH = offLevelH + tilt, defH = defLevelH + tilt, offA = offLevelA + tiltA, defA = defLevelA + tiltA;
  const ptsH = poss / 100 * league.ortg + offH * poss / 100 - defA * poss / 100 + cterms.marginAdj / 2;
  const ptsA = poss / 100 * league.ortg + offA * poss / 100 - defH * poss / 100 - cterms.marginAdj / 2;
  const an = analytic({ ptsH, ptsA, poss });
  return { mH, mA, netH, netA, netPH, netPA, ptsH, ptsA, ...an };
}

export function analyzeGame(input) {
  const league = { ...DEFAULT_LEAGUE, ...(input.league || {}) };
  const game = { ...input.game };
  game.hoursToTip = (new Date(game.date) - new Date(input.now || Date.now())) / 3.6e6;
  const H = prepTeam(input.home, 'home', game), A = prepTeam(input.away, 'away', game);
  const rH = teamRatings(input.home, league), rA = teamRatings(input.away, league);
  const venue = game.venueTeam || input.home.abbr;
  const tipLocalHour = ARENAS[venue] ? Number(new Intl.DateTimeFormat('en-US', { timeZone: ARENAS[venue].tz, hour: 'numeric', hour12: false }).format(new Date(game.date))) : null;
  const cterms = contextTerms({ home: input.home, away: input.away, venueTeam: venue, neutral: game.neutral, tipLocalHour, hca: league.hca });
  const pace = (teamPace(input.home, league.pace) * teamPace(input.away, league.pace)) / league.pace;
  const ctx = { league, rH, rA, cterms, game, pace };

  // Uncertain set U (§8.1): p in (0.03, 0.97); fix the rest at their mode. Cap at 6 by leverage (p(1-p)·minutes).
  const all = [...H.prepared, ...A.prepared];
  let U = all.filter(p => p.p > 0.03 && p.p < 0.97).sort((a, b) => b.p * (1 - b.p) * b.base.mean - a.p * (1 - a.p) * a.base.mean);
  const exact = U.slice(0, 6), mcExtra = U.slice(6);
  const fixedOut = new Set(all.filter(p => p.p <= 0.03).map(p => p.id));
  const scen = enumerate([...exact, ...mcExtra], undefined, { maxExact: 6, mc: 64 });
  const Uall = [...exact, ...mcExtra];
  const results = scen.map(s => {
    const outH = new Set([...fixedOut].filter(id => H.prepared.some(p => p.id === id))), outA = new Set([...fixedOut].filter(id => A.prepared.some(p => p.id === id)));
    const qH = new Set(), qA = new Set();
    Uall.forEach((u, i) => { const side = u.side === 'home'; if (!s.a[i]) (side ? outH : outA).add(u.id); else if (u.status === 'Questionable' || u.status === 'Day-To-Day') (side ? qH : qA).add(u.id); });
    return { ...s, ...evalScenario(H, A, outH, outA, qH, qA, ctx), out: Uall.filter((u, i) => !s.a[i]).map(u => u.name) };
  });
  const mix = key => results.reduce((t, r) => t + r.prob * r[key], 0);
  const wpModel = mix('wpHome'), marginModel = mix('margin'), totalModel = mix('total');
  const scenVarMargin = results.reduce((t, r) => t + r.prob * (r.margin - marginModel) ** 2, 0);
  const scenVarTotal = results.reduce((t, r) => t + r.prob * (r.total - totalModel) ** 2, 0);
  const ptsHmix = mix('ptsH'), ptsAmix = mix('ptsA');

  // Market (§4.3)
  const mk = input.market || null;
  const cons = mk?.books?.length ? consensus(mk.books) : null;
  const nv = mk ? noVig(mk.mlHome, mk.mlAway) : { p: null };
  const pMarket = cons?.p ?? nv.p ?? (mk?.spreadHome != null ? spreadToWp(mk.spreadHome) : null);
  const lambda = chooseLambda(input.context || {});
  const marketMargin = mk?.spreadHome != null ? -mk.spreadHome : null;
  const headMargin = blendPoint(marketMargin, marginModel, lambda);
  const headTotal = blendPoint(mk?.total ?? null, totalModel, lambda);
  const sdM = Math.sqrt(MARGIN_SD ** 2 * pace / 99 + scenVarMargin);
  const sim = simulate({ ptsH: (headTotal + headMargin) / 2, ptsA: (headTotal - headMargin) / 2, poss: pace, n: 10000, seed: hashSeed(game.id), marginSd: sdM / Math.sqrt(pace / 99), totalSd: Math.sqrt(18 ** 2 + scenVarTotal), spreadLine: mk?.spreadHome ?? null, totalLine: mk?.total ?? null });
  const wpHeadline = pMarket != null ? blend(pMarket, wpModel, lambda) : sim.wpHome;
  const gapPts = marketMargin != null ? marginModel - marketMargin : null;
  const disagreeSD = gapPts != null ? gapPts / MARGIN_SD : null;

  // Conditional panels (§8.4)
  const ifPanels = Uall.map((u, i) => {
    const c = (val, key) => conditional(results, i, val, r => r[key]);
    const plays = { wpHome: c(true, 'wpHome'), margin: c(true, 'margin'), total: c(true, 'total') };
    const sits = { wpHome: c(false, 'wpHome'), margin: c(false, 'margin'), total: c(false, 'total') };
    const team = u.side === 'home' ? H : A; const mk2 = u.side === 'home' ? 'mH' : 'mA';
    const teammates = team.prepared.filter(t => t.id !== u.id).map(t => {
      const minP = conditional(results, i, true, r => r[mk2][t.id] || 0), minS = conditional(results, i, false, r => r[mk2][t.id] || 0);
      if (minP == null || minS == null) return null;
      const dMin = minS - minP; const pr = t.rates; const usgShare = (u.rates.usg36 * (u.base.mean / 36)) * (t.rates.usg36 / team.prepared.reduce((s, x) => s + x.rates.usg36, 0));
      return { name: t.name, dMin: round(dMin), dPts: round(pr.pts36 * dMin / 36 + usgShare * 0.55), dReb: round(pr.reb36 * dMin / 36), dAst: round(pr.ast36 * dMin / 36), dUsg: round(100 * usgShare / Math.max(1, t.rates.usg36 * (t.base.mean / 36))) };
    }).filter(Boolean).filter(t => Math.abs(t.dMin) >= 0.5).sort((a, b) => b.dMin - a.dMin);
    const ok = plays.wpHome != null && sits.wpHome != null;
    return { player: u.name, id: u.id, team: u.team, status: u.status, pPlay: round(u.p, 3), marketImpliedPlay: ok ? round(marketImpliedPlay(pMarket, plays.wpHome, sits.wpHome), 2) : null,
      plays, sits, delta: ok ? { wp: plays.wpHome - sits.wpHome, spread: -(plays.margin - sits.margin), total: plays.total - sits.total } : null, teammates };
  });
  const bothSit = [];
  for (let i = 0; i < Uall.length; i++) for (let j = i + 1; j < Uall.length; j++) {
    if (Uall[i].team !== Uall[j].team) continue;
    const sub = results.filter(r => !r.a[i] && !r.a[j]); const tot = sub.reduce((t, r) => t + r.prob, 0); if (!tot) continue;
    bothSit.push({ team: Uall[i].team, players: [Uall[i].name, Uall[j].name], prob: round(tot, 3), wpHome: sub.reduce((t, r) => t + r.prob / tot * r.wpHome, 0), margin: sub.reduce((t, r) => t + r.prob / tot * r.margin, 0), total: sub.reduce((t, r) => t + r.prob / tot * r.total, 0) });
  }

  // Players (§5, §7)
  const pOT = sim.pOT; const margSd = sdM;
  const playersOut = [];
  for (const [team, mk2, opp] of [[H, 'mH', A], [A, 'mA', H]]) {
    const usgTot = team.prepared.reduce((s, x) => s + x.rates.usg36 * x.base.mean / 36, 0) || 1;
    for (const p of team.prepared) {
      const playing = results.filter(r => (r[mk2][p.id] || 0) > 0); const pt = playing.reduce((t, r) => t + r.prob, 0);
      const minGivenPlay = pt ? playing.reduce((t, r) => t + r.prob / pt * r[mk2][p.id], 0) : 0;
      // usage redistribution (§5.3 step 5): vacated usage weighted toward primary creators
      const vacated = pt ? playing.reduce((t, r) => { const outUsg = team.prepared.filter(x => !(r[mk2][x.id] > 0)).reduce((s, x) => s + x.rates.usg36 * x.base.mean / 36, 0); return t + r.prob / pt * outUsg; }, 0) : 0;
      const myShare = (p.rates.usg36 ** 1.5) / team.prepared.reduce((s, x) => s + x.rates.usg36 ** 1.5, 0);
      const usageBoost = vacated > 0 ? (vacated * myShare) / Math.max(0.5, p.rates.usg36 * Math.max(1, minGivenPlay) / 36) : 0;
      // blowoutLoss is symmetric in the margin sign; starters lose minutes, bench players gain 0.4× of that.
      // A player who sits in every scenario (pt = 0, e.g. Doubtful/Out fixed at mode) gets no minutes and no band.
      const lossFrac = !pt ? 0 : p.starter ? blowoutLoss(mk2 === 'mH' ? marginModel : -marginModel, margSd) : -0.4 * blowoutLoss(marginModel, margSd);
      const minMean = pt ? Math.max(0, minGivenPlay - lossFrac) : 0;
      const minSd = pt ? Math.max(2.5, (p.base.cv || 0.3) * minMean) : 0;
      const foul = foulTroubleRisk(p.base.pf36, minMean);
      const proj = projectPlayer(p.rates, minMean, { paceFactor: pace / league.pace, usageBoost: Math.min(0.6, usageBoost) });
      const pc = confidence({ param: zParam(p.impactSd, 2.5), inj: p.p * (1 - p.p) * 4, disagree: 0, data: zData(input.context || {}), calib: zCalib(null), role: zRole({ minutesCv: p.base.cv, returning: !!p.retCap }) });
      playersOut.push({ id: p.id, name: p.name, team: p.team, pos: p.pos, starter: !!p.starter, status: p.status, pPlay: round(p.p, 3),
        min: { mean: round(minMean), p10: round(Math.max(0, minMean - 1.2816 * minSd)), p90: round(Math.min(48, minMean + 1.2816 * minSd)), base: round(p.base.mean), blowoutAdj: round(-lossFrac), foulRisk: round(foul, 3), returnCap: p.retCap },
        proj: { pts: band(proj.pts, 'pts', minSd, minMean), reb: band(proj.reb, 'reb', minSd, minMean), ast: band(proj.ast, 'ast', minSd, minMean), fg3m: band(proj.fg3m, 'fg3m', minSd, minMean), pra: band(proj.pra, 'pra', minSd, minMean) },
        rates: { usg36: round(p.rates.usg36), ts: round(p.rates.ts, 3), fg3pct: p.rates.fg3pctRaw != null ? round(p.rates.fg3pctRaw, 3) : null, fg3pctShrunk: round(p.rates.fg3pct, 3), ast36: round(p.rates.ast36), reb36: round(p.rates.reb36), impact: round(p.impact) },
        form: formOf(p), splits: personalSplits({ ...p, oppAbbr: opp.abbr }, game), confidence: { score: pc.score, grade: pc.grade } });
    }
  }

  // Confidence (§9)
  const injVar = scenVarMargin / (scenVarMargin + MARGIN_SD ** 2);
  const conf = confidence({ param: zParam((rH.resultsSd + rA.resultsSd) / 2), inj: clamp(injVar * 6, 0, 1), disagree: gapPts != null ? zDisagree(gapPts) : 0.5, data: zData(input.context || {}), calib: zCalib(null), role: 0 });
  if (pMarket == null && conf.score > 74) { conf.score = 74; conf.grade = 'B'; conf.capped = 'no market line: capped at Medium'; }

  // Swing table (top 5)
  const swing = ifPanels.filter(x => x.delta).map(x => ({ variable: `${x.player} ${x.status}`, dWp: x.delta.wp, dTotal: x.delta.total, note: `play prob ${Math.round(100 * x.pPlay)}%` }));
  swing.push({ variable: 'Pace ±3 possessions', dWp: 0, dTotal: 3 * league.ortg / 100 * 2, note: 'possession estimate uncertainty' });
  swing.push({ variable: 'Three-point variance (team 3P% ±4 pp)', dWp: 0.08, dTotal: 0.04 * 35 * 3, note: '~35 attempts per team' });
  for (const r of cterms.rows.filter(r => r.inModel && r.key !== 'hca')) swing.push({ variable: r.label, dWp: r.effect / MARGIN_SD * 0.4, dTotal: 0, note: `prior ${r.prior}` });
  swing.sort((a, b) => (Math.abs(b.dWp) + Math.abs(b.dTotal) / 20) - (Math.abs(a.dWp) + Math.abs(a.dTotal) / 20));

  const out = {
    engineVersion: ENGINE_VERSION,
    wp: { headline: wpHeadline, model: wpModel, market: pMarket, lambda, lambdaPrior: LAMBDA_PRIOR, disagree: disagreeSD != null && Math.abs(disagreeSD) > 0.35, disagreeSD, range: wpRange(wpHeadline, conf.score), inferredRange: inferredRange(pMarket, input.bpiHome ?? null), bpi: input.bpiHome ?? null, books: cons?.books || null, method: nv.method || null },
    margin: { mean: headMargin, model: marginModel, market: marketMargin, sd: sdM, q: sim.margin.q },
    total: { mean: headTotal, model: totalModel, market: mk?.total ?? null, sd: sim.total.sd, q: sim.total.q },
    pts: { home: ptsHmix, away: ptsAmix }, poss: pace, pOT,
    cover: { line: mk?.spreadHome ?? null, pHome: sim.pCoverHome }, over: { line: mk?.total ?? null, p: sim.pOver },
    pBlowout15: pBlowout(headMargin, sdM, 15),
    ratings: { home: { player: mix('netPH'), results: rH.results, sd: rH.resultsSd, net: mix('netH'), elo: rH.elo, games: rH.gamesUsed, alpha: alphaFor(rH.gamesUsed) }, away: { player: mix('netPA'), results: rA.results, sd: rA.resultsSd, net: mix('netA'), elo: rA.elo, games: rA.gamesUsed, alpha: alphaFor(rA.gamesUsed) } },
    context: cterms.rows,
    scenarios: results.sort((a, b) => b.prob - a.prob).slice(0, 16).map(r => ({ key: r.out.length ? 'without ' + r.out.join(', ') : 'everyone plays', prob: round(r.prob, 4), out: r.out, wpHome: round(r.wpHome, 4), margin: round(r.margin), total: round(r.total) })),
    scenarioEntropy: entropy(results), uncertainCount: Uall.length,
    ifPanels, bothSit, players: playersOut, confidence: conf, swing: swing.slice(0, 5),
  };
  out.factors = evaluateFactors(input, out);
  return out;
}

function wpRange(p, score) {
  // Width shrinks with confidence: D ≈ ±12 pp, A ≈ ±4 pp (prior until calibration maps exist).
  const w = 0.04 + 0.08 * (1 - score / 100);
  return [clamp(p - w, 0.01, 0.99), clamp(p + w, 0.01, 0.99)];
}
function formOf(p) {
  const g = (p.log || []).filter(r => r.min > 0); const n = g.length;
  const avg = k => (n ? round(g.reduce((s, r) => s + (r[k] || 0), 0) / n) : null);
  const dec = k => { let num = 0, den = 0; g.forEach((r, i) => { const w = Math.pow(0.5, i / 5); num += w * (r[k] || 0); den += w; }); return den ? round(num / den) : null; };
  return { season: { pts: avg('pts'), reb: avg('reb'), ast: avg('ast'), min: avg('min'), n }, decayed: { pts: dec('pts'), reb: dec('reb'), ast: dec('ast'), min: dec('min'), halfLifeGames: 5 } };
}
