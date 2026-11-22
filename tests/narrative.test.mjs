// node --test tests/narrative.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  gameParagraphs, slateParagraphs, reasoningEntry, polish, stateHash,
  pct, signed, etTime, nextInjurySlot, numbersPreserved,
} from '../core/narrative.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/narrative-game.json', import.meta.url), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

// Second game built from the fixture: different teams, players and numbers.
function makeSecondGame() {
  const g = clone(fixture);
  g.id = '401705124';
  g.date = '2026-11-23T00:30:00Z';
  g.venue = { name: 'TD Garden', city: 'Boston', team: 'BOS', altFt: 20, tz: 'America/New_York', lat: 42.366, lon: -71.062 };
  g.home = { id: '2', abbr: 'BOS', name: 'Boston Celtics', record: '12-4', homeRecord: '7-2', awayRecord: '5-2', score: null, last5: 'WWWLW', restDays: 1, b2b: false };
  g.away = { id: '14', abbr: 'MIA', name: 'Miami Heat', record: '8-8', homeRecord: '5-3', awayRecord: '3-5', score: null, last5: 'LLWWL', restDays: 1, b2b: false };
  g.odds.spreadHome = -8.5; g.odds.total = 218.5;
  g.odds.books.forEach((b) => { b.spreadHome = -8.5; b.total = 218.5; b.noVigHome = 0.761; });
  g.injuries = [{ team: 'MIA', name: 'Tyler Herro', id: '4395725', status: 'Questionable', detail: 'Ankle', returnDate: null }];
  const A = g.analysis;
  A.wp = { headline: 0.758, model: 0.801, market: 0.761, lambda: 0.35, disagree: true, disagreeSD: 1.9, range: [0.69, 0.82], inferredRange: [0.66, 0.84] };
  A.margin = { mean: 8.9, sd: 12.1, q: { p10: -6.4, p25: 0.8, p50: 9.0, p75: 17.1, p90: 24.2 } };
  A.total = { mean: 216.8, sd: 16.9, q: { p10: 195.1, p25: 205.4, p50: 216.7, p75: 228.0, p90: 238.6 } };
  A.pts = { home: 112.9, away: 103.9 };
  A.poss = 95.2;
  A.ratings = { home: { player: 7.8, results: 9.1, net: 8.4, off: 120.1, def: 111.7, sd: 2.0 }, away: { player: -0.4, results: 0.3, net: -0.1, off: 113.0, def: 113.1, sd: 2.3 } };
  A.context = [{ key: 'hca', label: 'Home court', value: 2.1, effect: 2.1, inModel: true }];
  A.scenarios = [
    { key: 'all-in', prob: 0.55, out: [], wpHome: 0.741, margin: 8.2, total: 217.9 },
    { key: 'herro-out', prob: 0.45, out: ['Tyler Herro'], wpHome: 0.779, margin: 9.8, total: 215.4 },
  ];
  A.ifPanels = [{
    player: 'Tyler Herro', team: 'MIA', pPlay: 0.55, marketImpliedPlay: 0.6,
    plays: { wpHome: 0.741, margin: 8.2, total: 217.9 }, sits: { wpHome: 0.779, margin: 9.8, total: 215.4 },
    delta: { wp: 0.038, spread: -1.6, total: -2.5 },
    teammates: [{ name: 'Duncan Robinson', dMin: 7.2, dPts: 3.4, dReb: 0.8, dAst: 0.9, dUsg: 1.9 }],
  }];
  A.bothSit = [];
  const names = [
    ['Jayson Tatum', 'BOS'], ['Jaylen Brown', 'BOS'], ['Derrick White', 'BOS'],
    ['Bam Adebayo', 'MIA'], ['Tyler Herro', 'MIA'], ['Duncan Robinson', 'MIA'], ['Kristaps Porzingis', 'BOS'],
  ];
  A.players.forEach((p, i) => {
    p.id = `x${i}`; p.name = names[i][0]; p.team = names[i][1];
    p.min.mean = +(p.min.mean - 1.3).toFixed(1);
    p.proj.pts.mean = +(p.proj.pts.mean - 2.2 + i * 0.3).toFixed(1);
    delete p.props;
  });
  A.confidence = { score: 64, grade: 'B-', terms: A.confidence.terms };
  A.swing = [{ variable: 'Tyler Herro status', dWp: 0.038, dTotal: -2.5, note: 'Questionable, 55% to play' }];
  g.officials = ['Scott Foster', 'Marc Davis', 'Kevin Scott'];
  g.dataAgeSec = 95;
  return g;
}

const trends = {
  registrySize: 212,
  lastRetest: '2026-11-21T10:00:00Z',
  validated: [{
    id: 't1', family: 'rest', label: 'Road teams on a back-to-back vs rested home teams', scope: 'team', subject: 'LAL',
    n: 412, seasons: 4, rawEffect: -2.9, shrunkEffect: -1.6, ci80: [-2.4, -0.8], residualVsModel: -0.4, residualVsClose: -0.1,
    p: 0.0009, qBH: 0.011, qBY: 0.048, tier: 'Validated', mechanism: 'fatigue', stableSeasons: '4/4', alreadyPriced: true, noiseNote: '',
  }],
  exploratory: [{
    id: 't2', family: 'h2h', label: 'BOS covers at home vs MIA', scope: 'team', subject: 'BOS', n: 19, seasons: 4,
    rawEffect: 4.2, shrunkEffect: 0.7, ci80: [-1.1, 2.4], p: 0.08, qBH: 0.41, qBY: 0.9, tier: 'Exploratory', stableSeasons: '2/4',
    alreadyPriced: false, noiseNote: 'opponent-specific splits rarely persist',
  }],
  narrative: [{
    id: 't3', family: 'streak', label: 'Lakers are 1-4 in their last 5 road games', scope: 'team', subject: 'LAL', n: 5, seasons: 1,
    rawEffect: -7.8, shrunkEffect: -0.3, ci80: [-2.0, 1.4], p: 0.42, qBH: 0.88, qBY: 1, tier: 'Narrative only', stableSeasons: '0/4',
    alreadyPriced: true, residualVsClose: 0.2, noiseNote: 'five-game streaks are mostly schedule and variance',
  }],
};

function makeSnapshot(games, generatedAt = '2026-11-22T17:05:00Z') {
  return {
    schemaVersion: 2, generatedAt, slateDate: '2026-11-22',
    source: { writer: 'actions', status: 'ok', calls: [] },
    method: { status: 'priors — backtest pending', leagueOrtg: 115.3, leaguePace: 99.1 },
    league: { ortg: 115.3, pace: 99.1, hca: 2.2 },
    games, alerts: [], changes: [], trends,
  };
}

const g1 = fixture;
const g2 = makeSecondGame();
const snap = makeSnapshot([g1, g2]);

test('helpers format percentages, signs and ET times', () => {
  assert.equal(pct(0.684), '68%');
  assert.equal(signed(-6.5), '-6.5');
  assert.equal(signed(3), '+3.0');
  assert.equal(etTime('2026-11-23T02:00:00Z'), '9:00 PM ET');
  assert.equal(nextInjurySlot('2026-11-22T17:05:00Z').toISOString(), '2026-11-22T17:15:00.000Z');
  assert.equal(nextInjurySlot('2026-11-22T17:15:00Z').toISOString(), '2026-11-22T17:30:00.000Z');
});

test('fixture game yields >=4 paragraphs, each containing digits', () => {
  const paras = gameParagraphs(g1, snap);
  assert.ok(paras.length >= 4, `got ${paras.length}`);
  for (const p of paras) {
    assert.equal(typeof p, 'string');
    assert.match(p, /\d/, `paragraph without digits: ${p}`);
    assert.doesNotMatch(p, /\bedge\b/i);
  }
  assert.match(paras[0], /DEN/);
  assert.match(paras[0], /68%/);
  assert.match(paras[1], /Jamal Murray/);
  assert.match(paras[1], /63%/);
  assert.match(paras[1], /bits/);
  assert.match(paras[2], /market context/);
  assert.match(paras[3], /q=0\.011/);
  assert.match(paras[3], /not posted/);
});

test('slate returns exactly 5 paragraphs', () => {
  const s = slateParagraphs(snap, null);
  assert.equal(s.length, 5);
  for (const p of s) assert.match(p, /\d/);
  assert.match(s[2], /first snapshot/);
  assert.match(s[4], /12:25 PM ET/); // +20 min from 12:05 PM ET
  assert.match(s[4], /12:15 PM ET/); // next injury slot
});

test('slate diff against a previous snapshot lists moves', () => {
  const prevG1 = clone(g1);
  prevG1.odds.spreadHome = -5.5; prevG1.odds.total = 229.5;
  prevG1.injuries[0].status = 'Probable';
  prevG1.analysis.wp.headline = 0.661;
  const prev = makeSnapshot([prevG1, clone(g2)], '2026-11-22T16:45:00Z');
  const s = slateParagraphs(snap, prev);
  assert.equal(s.length, 5);
  assert.match(s[2], /spread -5\.5 to -6\.5/);
  assert.match(s[2], /Jamal Murray Probable to Questionable/);
  assert.match(s[2], /11:45 AM ET/);
});

test('slate with empty trend lists reports registry size and pending backfill', () => {
  const s = slateParagraphs({ ...snap, trends: { validated: [], exploratory: [], narrative: [], registrySize: 37 } }, null);
  assert.match(s[3], /37/);
  assert.match(s[3], /backfill/);
});

test('two different games never share a paragraph', () => {
  const a = gameParagraphs(g1, snap);
  const b = gameParagraphs(g2, snap);
  const setA = new Set(a);
  for (const p of b) assert.ok(!setA.has(p), `shared paragraph: ${p}`);
  assert.match(b[0], /BOS/);
  assert.match(b[0], /disagree by 1\.9 SD/);
});

test('null-heavy game does not throw and says what is missing', () => {
  const bare = { id: 'x1', home: { abbr: 'UTA' }, away: { abbr: 'POR' }, analysis: null, injuries: null, officials: null };
  const paras = gameParagraphs(bare, null);
  assert.ok(paras.length >= 4);
  const all = paras.join(' ');
  assert.match(all, /no engine output/i);
  assert.match(all, /missing|not posted|no player projections/i);
  assert.doesNotMatch(all, /undefined|NaN/);
  assert.doesNotThrow(() => gameParagraphs(undefined, undefined));
  assert.doesNotThrow(() => gameParagraphs({ analysis: { wp: {}, ifPanels: [{}], players: [{ proj: {} }] } }, {}));
  assert.equal(slateParagraphs(null, null).length, 5);
  assert.equal(slateParagraphs({ games: [bare] }, null).length, 5);
});

test('reasoningEntry describes moves and returns null when unchanged', () => {
  assert.equal(reasoningEntry(g1, clone(g1)), null);
  assert.equal(reasoningEntry(null, g1), null);
  const next = clone(g1);
  next.injuries[0].status = 'Out';
  next.analysis.wp.headline = 0.634;
  next.odds.spreadHome = -4.5;
  const line = reasoningEntry(g1, next);
  assert.equal(typeof line, 'string');
  assert.match(line, /68% to 63%/);
  assert.match(line, /Jamal Murray Questionable to Out/);
  assert.match(line, /-6\.5 to -4\.5/);
});

test('polish keeps LLM text only when every number survives', async () => {
  const rules = gameParagraphs(g1, snap)[0];
  const good = await polish(rules, { provider: 'workers-ai', call: async () => `Rewritten. ${rules}` });
  assert.equal(good.source, 'workers-ai');
  const dropped = await polish(rules, { provider: 'gemini', call: async () => rules.replace(/68%/g, 'about two thirds') });
  assert.equal(dropped.source, 'rules');
  assert.equal(dropped.text, rules);
  const thrown = await polish(rules, { provider: 'groq', call: async () => { throw new Error('rate limited'); } });
  assert.deepEqual(thrown, { text: rules, source: 'rules' });
  const edgey = await polish(rules, { provider: 'groq', call: async () => `${rules} This is a clear edge.` });
  assert.equal(edgey.source, 'rules');
  const none = await polish(rules, {});
  assert.equal(none.source, 'rules');
  assert.equal(numbersPreserved('a 1.5 b 2', 'b 2 then 1.5'), true);
  assert.equal(numbersPreserved('a 1.5 b 2', 'a 1.6 b 2'), false);
});

test('stateHash is short, stable and sensitive to text-driving fields', () => {
  const h1 = stateHash(g1);
  assert.match(h1, /^[0-9a-f]{8}$/);
  assert.equal(stateHash(clone(g1)), h1);
  const c = clone(g1); c.analysis.wp.headline = 0.7;
  assert.notEqual(stateHash(c), h1);
  assert.notEqual(stateHash(g2), h1);
  assert.doesNotThrow(() => stateHash(null));
});
