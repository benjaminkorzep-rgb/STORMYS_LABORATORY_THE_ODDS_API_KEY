// Trend engine (APPENDIX B §10).
//
// For every pre-registered hypothesis in ./registry.js:
//   effect   = mean residual in the subgroup (vs base model; the closing no-vig
//              line residual is reported alongside), never raw W/L
//   SE       = cluster-robust, clustered by team-season
//   shrunk   = raw * tau2 / (tau2 + SE^2), tau2 per family by method of moments
//   p        = permutation test, subgroup labels shuffled WITHIN team-season blocks
//   FDR      = Benjamini-Hochberg within family, Benjamini-Yekutieli across all
//   tiers    = Validated (all stability gates) / Exploratory / Narrative only
//
// Plain ES module, no dependencies, no platform APIs (Node, Deno, Workers, browsers).

import {
  REGISTRY, FAMILIES, OUTCOMES, GRID, registryByFamily, subgroupOf, assertOutcome,
  assertGridThreshold, normAbbr,
} from './registry.js';

export { REGISTRY, registryByFamily, subgroupOf, assertOutcome, assertGridThreshold, defineHypothesis, isGridThreshold } from './registry.js';

export const DEFAULTS = Object.freeze({
  permutations: 10000,
  seed: 20261122,
  seqStop: 100,          // Besag-Clifford sequential stop after this many exceedances
  bootstrap: 1000,
  qFamily: 0.10,         // BH within family
  qAll: 0.10,            // BY across all families
  requireBY: true,
  minTestN: 30,          // below this a row is registered but not tested (p = 1)
  minTeamN: 150,
  minPlayerN: 400,
  minEffectPts: 0.75,
  minEffectPp: 1.5,
  bootSelect: 0.70,
  mechanismNoneQ: 0.02,
  exploratoryP: 0.10,
  minProjectionN: 15,
});

// ---------------------------------------------------------------- RNG
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(str, seed = 0) {
  let h = 0x811C9DC5 ^ (seed >>> 0);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------- FDR
function stepUp(pvals, q, c) {
  const m = pvals.length;
  const p = pvals.map((v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1));
  const order = p.map((v, i) => i).sort((a, b) => p[a] - p[b]);
  const adj = new Array(m);
  let running = Infinity;
  for (let r = m; r >= 1; r--) {
    const i = order[r - 1];
    running = Math.min(running, (p[i] * m * c) / r);
    adj[i] = Math.min(1, running);
  }
  return { qvalues: adj, reject: adj.map((v) => v <= q) };
}

// Benjamini-Hochberg: adjusted q-values and reject flags at level q.
export function bh(pvals, q = 0.10) {
  return stepUp(pvals, q, 1);
}

// Benjamini-Yekutieli (arbitrary dependence): c(m) = sum_{i=1..m} 1/i.
export function by(pvals, q = 0.10) {
  let c = 0;
  for (let i = 1; i <= pvals.length; i++) c += 1 / i;
  return stepUp(pvals, q, c || 1);
}

// ---------------------------------------------------------------- small stats helpers
function normCdf(x) {
  // Abramowitz-Stegun 7.1.26 via erf
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
const Z80 = 1.2815515655446004;
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// Cluster-robust (CR1) SE of a mean from per-cluster sums.
// clusters: iterable of {S, k, SS} (sum, count, sum of squares of the values in the cluster)
export function clusterMean(clusters) {
  let S = 0; let K = 0; let SS = 0; let G = 0;
  const list = [];
  for (const c of clusters) {
    if (!c || !c.k) continue;
    S += c.S; K += c.k; SS += c.SS || 0; G++;
    list.push(c);
  }
  if (!K) return { mean: null, se: null, n: 0, G: 0 };
  const mean = S / K;
  let se;
  if (G >= 2) {
    let acc = 0;
    for (const c of list) { const d = c.S - c.k * mean; acc += d * d; }
    se = Math.sqrt((G / (G - 1)) * acc) / K;
  }
  if (!(se > 0)) {
    const v = K > 1 ? Math.max(0, (SS - K * mean * mean) / (K - 1)) : 0;
    se = K > 0 ? Math.sqrt(v / K) : null;
  }
  return { mean, se, n: K, G };
}

// ---------------------------------------------------------------- permutation test
// values: number[], inSub: bool[], blocks: key[] (team-season). Labels are shuffled
// within blocks; statistic = |subgroup sum - its permutation expectation|, two-sided.
export function permutationPValue(values, inSub, blocks, opts = {}) {
  const B = Math.max(1, Math.floor(opts.permutations ?? DEFAULTS.permutations));
  const seqStop = opts.seqStop ?? DEFAULTS.seqStop;
  const rng = opts.rng || mulberry32(opts.seed ?? DEFAULTS.seed);
  const groups = new Map();
  for (let i = 0; i < values.length; i++) {
    const y = values[i];
    if (!Number.isFinite(y)) continue;
    let g = groups.get(blocks[i]);
    if (!g) { g = { vals: [], k: 0, sIn: 0, total: 0 }; groups.set(blocks[i], g); }
    g.vals.push(y); g.total += y;
    if (inSub[i]) { g.k++; g.sIn += y; }
  }
  let obs = 0; let expected = 0; let fixed = 0; let K = 0;
  const vary = [];
  for (const g of groups.values()) {
    if (!g.k) continue;
    const n = g.vals.length;
    K += g.k; obs += g.sIn; expected += (g.k * g.total) / n;
    if (g.k === n) { fixed += g.total; continue; }
    const pick = Math.min(g.k, n - g.k);
    vary.push({ arr: Float64Array.from(g.vals), n, pick, comp: pick !== g.k, total: g.total });
  }
  if (!K || !vary.length) return { p: 1, permutations: 0, exceed: 0, stoppedEarly: false, tested: false };
  const obsDev = Math.abs(obs - expected);
  const tol = 1e-9 * Math.max(1, Math.abs(obsDev));
  let exceed = 0;
  for (let L = 1; L <= B; L++) {
    let s = fixed;
    for (let b = 0; b < vary.length; b++) {
      const v = vary[b]; const a = v.arr; const n = v.n;
      let ps = 0;
      for (let j = 0; j < v.pick; j++) {
        const r = j + Math.floor(rng() * (n - j));
        const t = a[j]; a[j] = a[r]; a[r] = t;
        ps += a[j];
      }
      s += v.comp ? v.total - ps : ps;
    }
    if (Math.abs(s - expected) >= obsDev - tol) {
      exceed++;
      if (seqStop && exceed >= seqStop) return { p: exceed / L, permutations: L, exceed, stoppedEarly: true, tested: true };
    }
  }
  return { p: (exceed + 1) / (B + 1), permutations: B, exceed, stoppedEarly: false, tested: true };
}

// ---------------------------------------------------------------- per-row collection
const blockKeyOf = (r) => `${normAbbr(r.teamAbbr)}|${r.season}`;
const seasonCmp = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));

function collectRow(row, recs) {
  const meta = OUTCOMES[row.outcome];
  const values = []; const inSub = []; const keys = [];
  const blocks = new Map();       // key -> {S,k,SS,season, cS,ck,cSS}
  const seasons = new Map();      // season -> {S,k,SS}
  const homeShare = { home: 0, n: 0 };
  for (const rec of recs) {
    const y = Number(rec[meta.field]);
    if (rec[meta.field] == null || !Number.isFinite(y)) continue;
    const s = subgroupOf(row, rec);
    const key = blockKeyOf(rec);
    values.push(y); inSub.push(s); keys.push(key);
    let b = blocks.get(key);
    if (!b) { b = { S: 0, k: 0, SS: 0, season: rec.season, cS: 0, ck: 0, cSS: 0 }; blocks.set(key, b); }
    if (!s) continue;
    b.S += y; b.k++; b.SS += y * y;
    let se = seasons.get(rec.season);
    if (!se) { se = { S: 0, k: 0, SS: 0 }; seasons.set(rec.season, se); }
    se.S += y; se.k++; se.SS += y * y;
    if (meta.closeField) {
      const c = Number(rec[meta.closeField]);
      if (rec[meta.closeField] != null && Number.isFinite(c)) { b.cS += c; b.ck++; b.cSS += c * c; }
    }
    homeShare.n++; if (rec.home === true) homeShare.home++;
  }
  return { values, inSub, keys, blocks, seasons, homeShare };
}

function minEffectFor(outcome, o) {
  return OUTCOMES[outcome].unit === 'pp' ? o.minEffectPp : o.minEffectPts;
}

function bootstrapSelection(data, tau2, sign, minEff, o, rng) {
  const blocks = [...data.blocks.values()];
  const G = blocks.length;
  if (!G || !sign) return 0;
  let hits = 0;
  const draws = Math.max(1, o.bootstrap);
  const drawn = new Array(G);
  for (let b = 0; b < draws; b++) {
    let S = 0; let K = 0; let Gk = 0;
    for (let i = 0; i < G; i++) {
      const c = blocks[Math.floor(rng() * G)];
      drawn[i] = c;
      if (c.k) { S += c.S; K += c.k; Gk++; }
    }
    if (!K || Gk < 2) continue;
    const mean = S / K;
    let acc = 0;
    for (let i = 0; i < G; i++) { const c = drawn[i]; if (c.k) { const d = c.S - c.k * mean; acc += d * d; } }
    const se = Math.sqrt((Gk / (Gk - 1)) * acc) / K;
    if (!(se > 0)) continue;
    const shrunk = mean * (tau2 / (tau2 + se * se));
    if (sgn(shrunk) === sign && Math.abs(shrunk) >= minEff && Math.abs(mean / se) >= 1.96) hits++;
  }
  return hits / draws;
}

function holdoutCheck(data, allSeasons, tau2, sign) {
  const out = { pass: false, discovery: null, later: [], stable: 0, reason: '' };
  const last4 = allSeasons.slice(-4);
  for (const s of last4) {
    const st = data.seasons.get(s);
    if (st && st.k && sign && sgn(st.S / st.k) === sign) out.stable++;
  }
  if (allSeasons.length < 3) { out.reason = 'needs 3+ seasons for a temporal holdout'; return out; }
  const disc = new Set(allSeasons.slice(0, -2));
  const d = clusterMean([...data.blocks.values()].filter((b) => disc.has(b.season)));
  if (!d.n) { out.reason = 'no discovery-season games'; return out; }
  const shrunkD = d.mean * (tau2 / (tau2 + d.se * d.se));
  out.discovery = shrunkD;
  if (!sign || sgn(shrunkD) !== sign) { out.reason = 'discovery-season sign differs'; return out; }
  for (const s of allSeasons.slice(-2)) {
    const st = data.seasons.get(s);
    const m = st && st.k ? st.S / st.k : null;
    out.later.push(m);
    if (m == null || sgn(m) !== sign || Math.abs(m) < 0.5 * Math.abs(shrunkD)) { out.reason = `season ${s} did not hold up`; return out; }
  }
  out.pass = true;
  return out;
}

// ---------------------------------------------------------------- formatting
const f1 = (x) => (x == null || !Number.isFinite(x) ? 'n/a' : `${x > 0 ? '+' : ''}${x.toFixed(1)}`);
const f2 = (x) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(2));
const fp = (p) => (p == null ? 'n/a' : p < 0.001 ? p.toExponential(1) : p.toFixed(3));
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

export function buildNoiseNote(t, ctx = {}) {
  const unit = t.scope === 'player' ? 'player-games' : 'games';
  const u = ctx.unit || 'pts';
  const parts = [];
  parts.push(`Based on n = ${t.n} ${unit} (${t.seasons} season${t.seasons === 1 ? '' : 's'}).`);
  parts.push(`The 80% interval is ${f1(t.ci80?.[0])} to ${f1(t.ci80?.[1])} ${u}.`);
  if (ctx.familySize) {
    parts.push(`This is 1 of ${ctx.familySize} patterns we tested in the ${t.family} family (${ctx.m} across all families).`);
  } else {
    parts.push('This is a single-player pattern outside the pre-registered families, so it is never Validated.');
  }
  if (t.qBH != null) {
    parts.push(`At this p-value, about ${Math.round(Math.min(1, t.qBH) * 100)}% of results like it are false discoveries (BH q = ${f2(t.qBH)}; p = ${fp(t.p)}; BY q across all families = ${f2(t.qBY)}).`);
  } else {
    parts.push(`Permutation p = ${fp(t.p)}; no false-discovery adjustment applies to an ad-hoc single-player pattern.`);
  }
  parts.push(`Shrunk estimate is ${f1(t.shrunkEffect)} vs raw ${f1(t.rawEffect)}.`);
  const k = Number(String(t.stableSeasons || '0/4').split('/')[0]) || 0;
  parts.push(`Held up in later seasons? ${ctx.holdout ? 'Yes' : 'No'} (${k} of last 4 seasons same sign).`);
  if (t.residualVsClose == null) parts.push('Already priced by the market? Unknown: residual vs closing line unavailable.');
  else parts.push(`Already priced by the market? ${t.alreadyPriced ? 'Yes' : 'No'}. Residual vs closing line = ${f1(t.residualVsClose)}.`);
  parts.push('Confounders checked: team quality, rest, home/away, opponent strength (residuals are vs a model that includes them, and labels are shuffled within team-season).');
  if (ctx.homeShare != null && t.scope !== 'game') parts.push(`${Math.round(ctx.homeShare * 100)}% of the subgroup were home games.`);
  if (ctx.noisyInput) parts.push(ctx.noisyInput);
  if (ctx.narrativeOnly) {
    parts.push(ctx.noEffect
      ? 'Narrative only: no measurable effect in the data; shown for storytelling, never used in projections.'
      : 'Narrative only: this kind of pattern is never promoted to Validated or used in projections.');
  }
  if (ctx.failReasons && ctx.failReasons.length && t.tier === 'Exploratory') parts.push(`Not Validated because: ${ctx.failReasons.join('; ')}.`);
  return parts.join(' ');
}

// ---------------------------------------------------------------- main entry
export function runTrendEngine(records, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = opts.now ? new Date(opts.now) : new Date();
  const lastRetest = Number.isNaN(now.getTime()) ? null : now.toISOString();
  const registry = opts.registry || REGISTRY;
  for (const r of registry) assertOutcome(r.outcome);
  const base = { validated: [], exploratory: [], narrative: [], registrySize: registry.length, m: registry.length, lastRetest, tested: 0 };
  if (!Array.isArray(records) || !records.length) return base;

  const teamRecs = []; const playerRecs = [];
  const seasonSet = new Set();
  for (const r of records) {
    if (!r || r.season == null) continue;
    seasonSet.add(r.season);
    (r.playerId != null ? playerRecs : teamRecs).push(r);
  }
  const allSeasons = [...seasonSet].sort(seasonCmp);
  const fams = registryByFamily(registry);

  // pass 1: raw effect, cluster SE, permutation p
  const res = registry.map((row) => {
    const data = collectRow(row, row.scope === 'player' ? playerRecs : teamRecs);
    const cm = clusterMean(data.blocks.values());
    const close = clusterMean([...data.blocks.values()].map((b) => ({ S: b.cS, k: b.ck, SS: b.cSS })));
    let perm = { p: 1, tested: false };
    if (cm.n >= o.minTestN) {
      perm = permutationPValue(data.values, data.inSub, data.keys, {
        permutations: o.permutations, seqStop: o.seqStop, rng: mulberry32(hashSeed(row.id, o.seed)),
      });
    }
    return { row, data, cm, close, perm, tested: !!perm.tested };
  });

  // pass 2: tau2 per family (method of moments, prior mean 0)
  const tau2 = {};
  for (const fam of Object.keys(fams)) {
    const xs = res.filter((x) => x.row.family === fam && x.tested);
    if (!xs.length) { tau2[fam] = 0; continue; }
    let a = 0; let b = 0;
    for (const x of xs) { a += x.cm.mean * x.cm.mean; b += x.cm.se * x.cm.se; }
    tau2[fam] = Math.max(0, (a - b) / xs.length);
  }

  // pass 3: FDR — BH within family, BY across all registered rows (untested rows p = 1)
  const allP = res.map((x) => (x.tested ? x.perm.p : 1));
  const byAll = by(allP, o.qAll);
  const qBH = new Array(res.length);
  for (const fam of Object.keys(fams)) {
    const idx = res.map((x, i) => (x.row.family === fam ? i : -1)).filter((i) => i >= 0);
    const adj = bh(idx.map((i) => allP[i]), o.qFamily);
    idx.forEach((i, j) => { qBH[i] = adj.qvalues[j]; });
  }

  // pass 4: shrinkage, stability, tiers, notes
  const out = { ...base, tested: res.filter((x) => x.tested).length };
  res.forEach((x, i) => {
    if (!x.cm.n) return;
    const { row, data, cm, close, perm } = x;
    const t2 = tau2[row.family];
    const se2 = cm.se * cm.se;
    const shrinkF = t2 > 0 ? t2 / (t2 + se2) : 0;
    const shrunk = cm.mean * shrinkF;
    const postSd = Math.sqrt(shrinkF * se2);
    const ci80 = [shrunk - Z80 * postSd, shrunk + Z80 * postSd];
    const minEff = minEffectFor(row.outcome, o);
    const sign = sgn(shrunk) || sgn(cm.mean);
    const qb = x.tested ? qBH[i] : 1;
    const qy = x.tested ? byAll.qvalues[i] : 1;
    const p = x.tested ? perm.p : 1;

    let closeMean = null; let alreadyPriced = false;
    if (close.n) {
      closeMean = close.mean;
      const zc = close.se > 0 ? close.mean / close.se : 0;
      const beatsModel = x.tested && qb <= o.qFamily && sign !== 0;
      const beatsMarket = sgn(close.mean) === sign && Math.abs(zc) >= 1.645;
      alreadyPriced = beatsModel && !beatsMarket;
    }

    const minN = row.scope === 'player' ? o.minPlayerN : o.minTeamN;
    const fail = [];
    if (!x.tested) fail.push(`n below ${o.minTestN}, not tested`);
    if (cm.n < minN) fail.push(`n = ${cm.n} below ${minN}`);
    if (Math.abs(shrunk) < minEff) fail.push(`|shrunk| below ${minEff}`);
    if (!(qb <= o.qFamily)) fail.push(`BH q above ${o.qFamily}`);
    if (o.requireBY && !(qy <= o.qAll)) fail.push(`BY q above ${o.qAll}`);
    if (!row.mechanism) fail.push('no mechanism tag');
    if (row.mechanism === 'none' && !(qb <= o.mechanismNoneQ)) fail.push(`no mechanism needs q <= ${o.mechanismNoneQ}`);

    // stability gates are only worth computing for candidates that passed the cheap ones
    let hold = { pass: false, stable: 0 };
    let bootRate = null;
    if (!fail.length && !row.narrativeOnly) {
      hold = holdoutCheck(data, allSeasons, t2, sign);
      if (!hold.pass) fail.push(hold.reason || 'temporal holdout failed');
      if (hold.stable < 3) fail.push(`sign held in ${hold.stable}/4 recent seasons`);
      if (!fail.length) {
        bootRate = bootstrapSelection(data, t2, sign, minEff, o, mulberry32(hashSeed(row.id, o.seed + 1)));
        if (bootRate < o.bootSelect) fail.push(`bootstrap selection ${Math.round(bootRate * 100)}% < ${Math.round(o.bootSelect * 100)}%`);
      }
    } else {
      hold = holdoutCheck(data, allSeasons, t2, sign);
    }

    const tier = row.narrativeOnly ? 'Narrative only' : fail.length ? 'Exploratory' : 'Validated';
    const seasonsN = [...data.seasons.values()].filter((s) => s.k).length;
    const trend = {
      id: row.id,
      family: row.family,
      label: row.label,
      scope: row.scope,
      subject: row.scope === 'player' ? 'All players' : row.scope === 'game' ? 'All games' : 'All teams',
      outcome: row.outcome,
      n: cm.n,
      seasons: seasonsN,
      rawEffect: r3(cm.mean),
      shrunkEffect: r3(shrunk),
      ci80: [r3(ci80[0]), r3(ci80[1])],
      residualVsModel: r3(cm.mean),
      residualVsClose: r3(closeMean),
      p: x.tested ? r3(p) : null,
      qBH: x.tested ? r3(qb) : null,
      qBY: x.tested ? r3(qy) : null,
      tier,
      mechanism: row.mechanism,
      stableSeasons: `${hold.stable}/4`,
      alreadyPriced,
      bootstrapSelected: bootRate == null ? null : r3(bootRate),
      threshold: row.threshold,
      noiseNote: '',
    };
    trend.p = x.tested ? p : null; // keep full precision for p
    trend.noiseNote = buildNoiseNote(trend, {
      familySize: fams[row.family].length, m: registry.length, holdout: hold.pass,
      homeShare: data.homeShare.n ? data.homeShare.home / data.homeShare.n : null,
      noisyInput: row.noisyInput, narrativeOnly: row.narrativeOnly,
      noEffect: !x.tested || !(qb <= o.qFamily) || Math.abs(shrunk) < minEff,
      failReasons: fail, unit: OUTCOMES[row.outcome].unit,
    });

    if (tier === 'Validated') out.validated.push(trend);
    else if (tier === 'Narrative only') out.narrative.push(trend);
    else if (x.tested && p <= o.exploratoryP) out.exploratory.push(trend);
  });

  const byQ = (a, b) => (a.qBH ?? 1) - (b.qBH ?? 1) || Math.abs(b.shrunkEffect) - Math.abs(a.shrunkEffect);
  out.validated.sort(byQ); out.exploratory.sort(byQ); out.narrative.sort(byQ);
  out.tau2 = tau2;
  return out;
}

// ---------------------------------------------------------------- single-player "vs team"
// Always Exploratory. For projection use, refuses n < 15.
export function singlePlayerVsTeam(records, { playerId, oppAbbr, outcome = 'player_pts_resid', forProjection = false, permutations, seed, tau2 = 1 } = {}) {
  assertOutcome(outcome);
  if (!outcome.startsWith('player_')) throw new Error('singlePlayerVsTeam needs a player residual outcome');
  const opp = normAbbr(oppAbbr);
  assertGridThreshold('opponent', opp);
  const meta = OUTCOMES[outcome];
  const mine = (records || []).filter((r) => r && r.playerId != null && String(r.playerId) === String(playerId) && Number.isFinite(Number(r[meta.field])) && r[meta.field] != null);
  const inSub = mine.map((r) => normAbbr(r.oppAbbr) === opp);
  const n = inSub.filter(Boolean).length;
  if (forProjection && n < DEFAULTS.minProjectionN) {
    throw new Error(`Refusing single-player "vs ${opp}" trend for projection use: n = ${n} < ${DEFAULTS.minProjectionN}`);
  }
  const blocks = new Map(); const seasons = new Set();
  let cS = 0; let ck = 0;
  mine.forEach((r, i) => {
    if (!inSub[i]) return;
    const key = blockKeyOf(r);
    let b = blocks.get(key);
    if (!b) { b = { S: 0, k: 0, SS: 0 }; blocks.set(key, b); }
    const y = Number(r[meta.field]);
    b.S += y; b.k++; b.SS += y * y; seasons.add(r.season);
    const c = Number(r[meta.closeField]);
    if (meta.closeField && r[meta.closeField] != null && Number.isFinite(c)) { cS += c; ck++; }
  });
  const cm = clusterMean(blocks.values());
  const perm = n ? permutationPValue(mine.map((r) => Number(r[meta.field])), inSub, mine.map(() => String(playerId)), { permutations: permutations ?? DEFAULTS.permutations, seed: hashSeed(`${playerId}|${opp}`, seed ?? DEFAULTS.seed) }) : { p: 1 };
  const se2 = (cm.se || 0) ** 2;
  const f = tau2 > 0 ? tau2 / (tau2 + se2) : 0;
  const shrunk = (cm.mean || 0) * f;
  const sd = Math.sqrt(f * se2);
  const name = mine.find((r) => r.playerName)?.playerName || String(playerId);
  const trend = {
    id: `player.single.${playerId}.vs_${opp.toLowerCase()}.${outcome}`,
    family: 'Player', label: `${name} vs ${opp}`, scope: 'player', subject: name, outcome,
    n, seasons: seasons.size, rawEffect: r3(cm.mean), shrunkEffect: r3(shrunk),
    ci80: [r3(shrunk - Z80 * sd), r3(shrunk + Z80 * sd)],
    residualVsModel: r3(cm.mean), residualVsClose: ck ? r3(cS / ck) : null,
    p: perm.p, qBH: null, qBY: null, tier: 'Exploratory', mechanism: 'matchup',
    stableSeasons: '0/4', alreadyPriced: false, projectionEligible: n >= DEFAULTS.minProjectionN, noiseNote: '',
  };
  trend.noiseNote = buildNoiseNote(trend, { holdout: false, unit: meta.unit, noisyInput: n < DEFAULTS.minProjectionN ? `Only ${n} games vs ${opp}: too few to use in projections.` : null });
  return trend;
}

// ---------------------------------------------------------------- weekly diff
export function diffTrendRuns(prev, next) {
  const pv = new Map(((prev && prev.validated) || []).map((t) => [t.id, t]));
  const nv = new Map(((next && next.validated) || []).map((t) => [t.id, t]));
  const nowTier = new Map();
  for (const k of ['exploratory', 'narrative']) for (const t of (next && next[k]) || []) nowTier.set(t.id, t);
  const newValidated = [...nv.values()].filter((t) => !pv.has(t.id));
  const fellApart = [...pv.values()].filter((t) => !nv.has(t.id)).map((t) => {
    const cur = nowTier.get(t.id);
    return cur ? { ...cur, previousTier: 'Validated' } : { ...t, tier: 'Exploratory', previousTier: 'Validated', nowTier: 'below exploratory threshold' };
  });
  return { newValidated, fellApart };
}

export { GRID, FAMILIES, OUTCOMES };
