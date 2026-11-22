import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bh, by, permutationPValue, mulberry32, runTrendEngine, diffTrendRuns, singlePlayerVsTeam,
  REGISTRY, registryByFamily, subgroupOf, assertOutcome, assertGridThreshold, defineHypothesis, FAMILIES,
} from '../core/engine/trends.js';
import { TEAMS, CREW_CHIEFS } from '../core/engine/registry.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// ---------------------------------------------------------------- synthetic data
function gen(seed) {
  const r = mulberry32(seed);
  const norm = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const pick = (a) => a[Math.floor(r() * a.length)];
  return { r, norm, pick };
}
const REST = [0, 0, 1, 1, 1, 1, 1, 2, 2, 3, 4];
const TIPS = [12, 15, 17, 19, 19, 19, 20, 20, 21, 22];
const MONTH_OF = (g) => [10, 11, 11, 12, 12, 1, 1, 2, 2, 3, 3, 4][Math.min(11, Math.floor(g / 7))];

function makeTeamRecords({ seasons = [2020, 2021, 2022, 2023, 2024, 2025], seed = 7, b2bEffect = 0, denModelEffect = 0 } = {}) {
  const { r, norm, pick } = gen(seed);
  const out = [];
  for (const season of seasons) {
    for (const team of TEAMS) {
      const block = norm() * 1.5; // team-season model misfit
      for (let g = 0; g < 82; g++) {
        const home = r() < 0.5;
        const opp = pick(TEAMS.filter((t) => t !== team));
        const restDays = pick(REST);
        const b2b = restDays === 0;
        let resid = block + norm() * 12;
        let residClose = 0.5 * block + norm() * 12;
        if (b2b) { resid += b2bEffect; residClose += b2bEffect; }
        if (!home && opp === 'DEN') resid += denModelEffect;
        out.push({
          gameId: `${season}-${team}-${g}`, season, date: `${season}-01-01`, teamAbbr: team, oppAbbr: opp, home,
          restDays, oppRestDays: pick(REST), b2b, threeInFour: r() < 0.15, fourInSix: r() < 0.08,
          roadTripGame: home ? 0 : 1 + Math.floor(r() * 6), homestandGame: home ? 1 + Math.floor(r() * 6) : 0,
          tzShift: home ? 0 : Math.floor(r() * 7) - 3, tipHourLocal: pick(TIPS), month: MONTH_OF(g),
          dow: Math.floor(r() * 7), gameOfSeason: g + 1, postAllStar: g >= 55, holiday: r() < 0.02 ? 'mlk_day' : null,
          nationalTV: r() < 0.1, christmas: r() < 0.01, nbaCup: r() < 0.05,
          crewChief: r() < 0.6 ? pick(CREW_CHIEFS) : 'Other Ref', crewTotalDelta: norm() * 2, crewFtRateZ: norm(),
          paceMismatch: norm() * 3, threePaRateMismatch: norm() * 4, rebMismatch: norm() * 3, foulMismatch: norm() * 4,
          lineMove: norm() * 1.2, totalMove: norm() * 1.5, favSize: norm() * 6,
          prevMarginVsOpp: norm() * 12, rematchDays: 3 + Math.floor(r() * 60), playoffRace: pick(['in', 'out', 'eliminated', 'safe']),
          tanking: r() < 0.05, h2hStreak: Math.floor(r() * 6),
          residModel: resid, residClose, totalResidModel: norm() * 15, totalResidClose: norm() * 15,
        });
      }
    }
  }
  return out;
}

function makePlayerRecords({ seasons = [2020, 2021, 2022, 2023, 2024, 2025], seed = 11, n = 6000 } = {}) {
  const { r, norm, pick } = gen(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const restDays = pick(REST);
    const pid = Math.floor(r() * 120);
    out.push({
      playerId: `p${pid}`, playerName: `Player ${pid}`, season: pick(seasons), teamAbbr: TEAMS[pid % 30], oppAbbr: pick(TEAMS),
      home: r() < 0.5, restDays, b2b: restDays === 0, month: pick([10, 11, 12, 1, 2, 3, 4]), dow: Math.floor(r() * 7),
      tipHourLocal: pick(TIPS), vsFormerTeam: r() < 0.03, contractYear: r() < 0.15, birthday: r() < 0.01,
      ptsResid: norm() * 6, ptsResidClose: norm() * 6,
    });
  }
  return out;
}

// ---------------------------------------------------------------- FDR
test('BH against hand-computed vector p=[.01,.02,.03,.04,.2], q=.1', () => {
  const { qvalues, reject } = bh([0.01, 0.02, 0.03, 0.04, 0.2], 0.1);
  [0.05, 0.05, 0.05, 0.05, 0.2].forEach((v, i) => close(qvalues[i], v));
  assert.deepEqual(reject, [true, true, true, true, false]);
});

test('BY against hand-computed vector: c(5)=137/60', () => {
  const c = 1 + 1 / 2 + 1 / 3 + 1 / 4 + 1 / 5;
  close(c, 137 / 60);
  const { qvalues, reject } = by([0.01, 0.02, 0.03, 0.04, 0.2], 0.1);
  [0.05 * c, 0.05 * c, 0.05 * c, 0.05 * c, 0.2 * c].forEach((v, i) => close(qvalues[i], v));
  assert.deepEqual(reject, [false, false, false, false, false]); // 0.1142 > 0.1
});

test('BH step-up on unsorted 8-vector keeps input order', () => {
  // sorted: .001 .008 .039 .041 .042 .06 .074 .205 (m=8)
  // m*p/i: .008 .032 .104 .082 .0672 .08 .08457 .205 -> cummin from right
  const p = [0.205, 0.042, 0.001, 0.074, 0.039, 0.008, 0.06, 0.041];
  const { qvalues, reject } = bh(p, 0.05);
  const want = [0.205, 0.0672, 0.008, 8 * 0.074 / 7, 0.0672, 0.032, 0.08, 0.0672];
  want.forEach((v, i) => close(qvalues[i], v, 1e-12));
  assert.deepEqual(reject, [false, false, true, false, false, true, false, false]);
});

// ---------------------------------------------------------------- registry
test('registry has >= 200 pre-registered rows across all families with grid thresholds', () => {
  assert.ok(REGISTRY.length >= 200, `registry size ${REGISTRY.length}`);
  const ids = new Set(REGISTRY.map((r) => r.id));
  assert.equal(ids.size, REGISTRY.length);
  const fams = registryByFamily();
  for (const f of FAMILIES) assert.ok(fams[f].length > 0, `family ${f} empty`);
  for (const r of REGISTRY) {
    assert.ok(assertGridThreshold(r.threshold.key, r.threshold.value));
    assertOutcome(r.outcome);
    assert.ok(r.registeredAt && r.subgroup);
  }
  const b2b = REGISTRY.find((r) => r.id === 'schedule.b2b.margin');
  assert.equal(subgroupOf(b2b, { b2b: true, teamAbbr: 'BOS' }), true);
  assert.equal(subgroupOf(b2b, { b2b: false }), false);
  assert.equal(subgroupOf(b2b, { b2b: true, playerId: 'x' }), false); // team row never matches player-game
});

// ---------------------------------------------------------------- anti-patterns
test('raw W/L outcomes are refused', () => {
  for (const o of ['win', 'wl', 'raw_wl', 'ats_cover', 'su_record', 'loss']) {
    assert.throws(() => assertOutcome(o), /raw W\/L/);
  }
  const row = REGISTRY[0];
  assert.throws(() => defineHypothesis({ ...row, id: 'x', outcome: 'win' }), /raw W\/L/);
  assert.throws(() => runTrendEngine(makeTeamRecords({ seasons: [2024] }).slice(0, 50), { registry: [{ ...row, outcome: 'ats_win' }] }), /raw W\/L/);
});

test('non-grid thresholds throw', () => {
  assert.throws(() => assertGridThreshold('paceMismatch', 3), /not on the fixed grid/);
  assert.throws(() => assertGridThreshold('lineMove', 2), /not on the fixed grid/);
  assert.throws(() => defineHypothesis({ family: 'Style', id: 'x', label: 'x', subgroup: ['paceMismatch', '>=', 5], threshold: { key: 'paceMismatch', value: 5 } }), /fixed grid/);
  assert.throws(() => assertGridThreshold('madeUp', 1), /Unknown threshold key/);
});

test('single-player vs team: n < 15 refused for projection, always Exploratory', () => {
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push({ playerId: 'p1', playerName: 'A', season: 2024, teamAbbr: 'BOS', oppAbbr: i < 8 ? 'NYK' : 'MIA', ptsResid: (i % 7) - 3 });
  assert.throws(() => singlePlayerVsTeam(recs, { playerId: 'p1', oppAbbr: 'NY', forProjection: true }), /n = 8 < 15/);
  const t = singlePlayerVsTeam(recs, { playerId: 'p1', oppAbbr: 'NYK', permutations: 200 });
  assert.equal(t.tier, 'Exploratory');
  assert.equal(t.projectionEligible, false);
  assert.ok(t.noiseNote.length > 0);
});

// ---------------------------------------------------------------- engine
test('empty records: empty tiers plus registrySize', () => {
  const out = runTrendEngine([], { now: '2026-11-22T12:00:00Z' });
  assert.deepEqual(out.validated, []);
  assert.deepEqual(out.exploratory, []);
  assert.deepEqual(out.narrative, []);
  assert.equal(out.registrySize, REGISTRY.length);
  assert.equal(out.m, REGISTRY.length);
  assert.equal(out.lastRetest, '2026-11-22T12:00:00.000Z');
});

test('permutation null calibrates: ~10% of null tests have p < 0.10', () => {
  const { r, norm } = gen(99);
  const N = 2000; const G = 40;
  const blocks = []; const values = [];
  const offs = Array.from({ length: G }, () => norm() * 3);
  for (let i = 0; i < N; i++) { const b = i % G; blocks.push(`b${b}`); values.push(offs[b] + norm() * 10); }
  let hits = 0; const H = 300;
  for (let h = 0; h < H; h++) {
    const rate = Array.from({ length: G }, () => 0.05 + r() * 0.45); // label rate varies by block
    const inSub = blocks.map((_, i) => r() < rate[i % G]);
    const { p } = permutationPValue(values, inSub, blocks, { permutations: 500, seed: 1000 + h });
    if (p < 0.10) hits++;
  }
  const frac = hits / H;
  assert.ok(frac >= 0.05 && frac <= 0.15, `null fraction p<0.10 = ${frac}`);
});

test('permutation p is reproducible with a seed', () => {
  const vals = Array.from({ length: 300 }, (_, i) => Math.sin(i) * 5);
  const lab = vals.map((_, i) => i % 3 === 0);
  const blk = vals.map((_, i) => `b${i % 10}`);
  const a = permutationPValue(vals, lab, blk, { permutations: 400, seed: 5 });
  const b = permutationPValue(vals, lab, blk, { permutations: 400, seed: 5 });
  assert.equal(a.p, b.p);
});

let plantedRun;
test('a planted real effect is detected and Validated; model-only effect flagged as already priced', () => {
  const recs = [...makeTeamRecords({ b2bEffect: -3, denModelEffect: -6 }), ...makePlayerRecords()];
  plantedRun = runTrendEngine(recs, { permutations: 10000, seed: 42, now: '2026-11-22T00:00:00Z' });
  const ids = plantedRun.validated.map((t) => t.id);
  assert.ok(ids.includes('schedule.b2b.margin'), `validated: ${ids.join(',')}`);
  const b2b = plantedRun.validated.find((t) => t.id === 'schedule.b2b.margin');
  assert.ok(b2b.shrunkEffect < -2 && b2b.shrunkEffect > -4, `shrunk ${b2b.shrunkEffect}`);
  assert.ok(Math.abs(b2b.shrunkEffect) <= Math.abs(b2b.rawEffect));
  assert.equal(b2b.alreadyPriced, false);
  assert.ok(b2b.qBH <= 0.10 && b2b.qBY <= 0.10);
  const all = [...plantedRun.validated, ...plantedRun.exploratory];
  const den = all.find((t) => t.id === 'travelclock.altden.margin');
  assert.ok(den && den.qBH <= 0.10, 'DEN altitude effect detected');
  assert.equal(den.alreadyPriced, true);
  // the only true effects are b2b-related (b2b == rest 0) and DEN; nothing else may validate
  for (const id of ids) assert.ok(['schedule.b2b.margin', 'schedule.rest0.margin', 'travelclock.altden.margin'].includes(id), `spurious validated ${id}`);
});

test('every output trend has a non-empty noiseNote and contract fields', () => {
  const keys = ['id', 'family', 'label', 'scope', 'subject', 'n', 'seasons', 'rawEffect', 'shrunkEffect', 'ci80', 'residualVsModel', 'residualVsClose', 'p', 'qBH', 'qBY', 'tier', 'mechanism', 'stableSeasons', 'alreadyPriced', 'noiseNote'];
  const all = [...plantedRun.validated, ...plantedRun.exploratory, ...plantedRun.narrative];
  assert.ok(all.length > 0);
  assert.ok(plantedRun.narrative.length > 0);
  for (const t of all) {
    for (const k of keys) assert.ok(k in t, `${t.id} missing ${k}`);
    assert.equal(typeof t.noiseNote, 'string');
    assert.ok(t.noiseNote.length > 50, `${t.id} noiseNote empty`);
    assert.match(t.noiseNote, /Based on n = \d+/);
    assert.match(t.noiseNote, /Confounders checked/);
    assert.match(t.stableSeasons, /^\d\/4$/);
  }
  for (const t of plantedRun.narrative) assert.equal(t.tier, 'Narrative only');
});

test('pure noise: nothing Validated; diffTrendRuns reports what fell apart', () => {
  const noise = runTrendEngine([...makeTeamRecords({ seed: 3 }), ...makePlayerRecords({ seed: 4 })], { permutations: 2000, seed: 1 });
  assert.equal(noise.validated.length, 0, noise.validated.map((t) => t.id).join(','));
  for (const t of [...noise.exploratory, ...noise.narrative]) assert.ok(t.noiseNote.length > 0);
  const d = diffTrendRuns(plantedRun, noise);
  assert.deepEqual(d.newValidated, []);
  assert.equal(d.fellApart.length, plantedRun.validated.length);
  const d2 = diffTrendRuns(null, plantedRun);
  assert.equal(d2.newValidated.length, plantedRun.validated.length);
});
