// node --test tests/adapters.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import { getJSON, CHROME_HEADERS, UA_IPHONE } from '../core/adapters/http.js';
import * as X from '../core/adapters/extra.js';
import { extractPdfText, parseInjuryReportPdf, parseCMap } from '../core/adapters/pdf.js';
import { runChain, buildChains, runNamedChain, healthCheckAll, nonEmpty, CHAIN_NAMES } from '../core/chains.js';

// ------------------------------------------------------------ mock fetch
function res(body, { status = 200, headers = {} } = {}) {
  const isBin = body instanceof Uint8Array;
  const text = isBin ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    headers: { forEach: (cb) => h.forEach((v, k) => cb(v, k)) },
    text: async () => (isBin ? new TextDecoder('latin1').decode(body) : text),
    arrayBuffer: async () => (isBin ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new TextEncoder().encode(text).buffer),
  };
}
/** routes: [[substring|RegExp, response | (url, init) => response]] ; unmatched -> 404 */
function mockFetch(routes, log = []) {
  return async (url, init = {}) => {
    log.push({ url, headers: init.headers || {} });
    for (const [pat, r] of routes) {
      if (typeof pat === 'string' ? url.includes(pat) : pat.test(url)) {
        const out = typeof r === 'function' ? await r(url, init) : r;
        if (out instanceof Error) throw out;
        return out;
      }
    }
    return res('not found', { status: 404 });
  };
}
const CONTRACT = ['ok', 'status', 'bytes', 'ms', 'host', 'url', 'data', 'error'];
const assertContract = (r) => {
  for (const k of CONTRACT) assert.ok(k in r, `missing ${k}`);
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(typeof r.status, 'number');
  assert.equal(typeof r.bytes, 'number');
  assert.equal(typeof r.ms, 'number');
};

// ------------------------------------------------------------ http.js
test('getJSON: success contract, bytes from text length, host from URL', async () => {
  const body = { a: 1 };
  const r = await getJSON(mockFetch([['example.com', res(body)]]), 'https://api.example.com/x?y=1');
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.host, 'api.example.com');
  assert.equal(r.bytes, JSON.stringify(body).length);
  assert.deepEqual(r.data, body);
  assert.equal(r.error, null);
});

test('getJSON: HTTP error, invalid JSON, thrown fetch never throw', async () => {
  const f = mockFetch([
    ['/500', res('boom', { status: 500 })],
    ['/bad', res('{not json')],
    ['/throw', new Error('ECONNRESET')],
  ]);
  const a = await getJSON(f, 'https://h.test/500');
  assert.equal(a.ok, false);
  assert.equal(a.status, 500);
  assert.match(a.error, /HTTP 500/);
  const b = await getJSON(f, 'https://h.test/bad');
  assert.equal(b.ok, false);
  assert.match(b.error, /invalid JSON/);
  const c = await getJSON(f, 'https://h.test/throw');
  assertContract(c);
  assert.equal(c.ok, false);
  assert.match(c.error, /ECONNRESET/);
  const d = await getJSON(null, 'https://h.test/none');
  assert.equal(d.ok, false);
});

test('getJSON: timeout handling (hung fetch resolves as ok:false within budget)', async () => {
  const hung = () => new Promise(() => {});
  const t0 = Date.now();
  const r = await getJSON(hung, 'https://slow.test/x', { timeoutMs: 60 });
  assertContract(r);
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout/);
  assert.ok(Date.now() - t0 < 1000);
  // fetch that honours AbortSignal
  const abortable = (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const r2 = await getJSON(abortable, 'https://slow.test/y', { timeoutMs: 40 });
  assert.match(r2.error, /timeout/);
});

test('CHROME_HEADERS: Chrome 140 client hints + nba.com origin; cdn adapters send them', async () => {
  assert.match(CHROME_HEADERS['sec-ch-ua'], /Chromium";v="140"/);
  assert.match(CHROME_HEADERS['User-Agent'], /Chrome\/140/);
  assert.equal(CHROME_HEADERS.Origin, 'https://www.nba.com');
  assert.equal(CHROME_HEADERS.Referer, 'https://www.nba.com/');
  assert.ok(CHROME_HEADERS['sec-ch-ua-platform'] && CHROME_HEADERS['sec-fetch-site']);
  assert.match(UA_IPHONE, /iPhone/);
  const log = [];
  await X.nbaOdds(mockFetch([], log));
  await X.nbaDailyLineups(mockFetch([], log), { date: '2026-11-22' });
  for (const l of log) assert.equal(l.headers['sec-ch-ua'], CHROME_HEADERS['sec-ch-ua']);
  assert.equal(log[1].url, 'https://stats.nba.com/js/data/leaders/00_daily_lineups_20261122.json');
});

// ------------------------------------------------------------ every adapter keeps the contract
test('every EXTRA_ADAPTERS entry: contract on 404, on thrown fetch, and has a descriptor', async () => {
  const ctx = { date: '2026-11-22', gameId: '0022600123', nbaPlayerId: 1628369, nbaTeamId: 1610612738, brefPlayerId: 'tatumja01', oddsApiKey: 'k' };
  const bucket = X.createTokenBucket({ capacity: 1000 });
  for (const [name, d] of Object.entries(X.EXTRA_ADAPTERS)) {
    assert.equal(typeof d.fn, 'function', name);
    assert.equal(typeof d.url, 'function', name);
    assert.ok(Array.isArray(d.chains), name);
    assert.equal(typeof d.serverOnly, 'boolean', name);
    assert.match(d.url(ctx), /^https:\/\//, name);
    for (const f of [mockFetch([]), mockFetch([[/./, new Error('net down')]])]) {
      const p = { ...d.params(ctx), bucket };
      const r = await d.fn(f, p);
      assertContract(r);
      assert.equal(r.ok, false, name);
    }
  }
});

// ------------------------------------------------------------ slot URL builder + index
test('injury report slot URL builder (:00/:15/:30/:45, 12h clock)', () => {
  const base = 'https://ak-static.cms.nba.com/referee/injury/Injury-Report_';
  assert.equal(X.injuryReportSlotUrl('2026-11-22', 17, 30), `${base}2026-11-22_05_30PM.pdf`);
  assert.equal(X.injuryReportSlotUrl('20261122', 0, 0), `${base}2026-11-22_12_00AM.pdf`);
  assert.equal(X.injuryReportSlotUrl('2026-11-22', 12, 15), `${base}2026-11-22_12_15PM.pdf`);
  assert.equal(X.injuryReportSlotUrl('2026-11-22', 9, 44), `${base}2026-11-22_09_30AM.pdf`);
  assert.equal(X.injuryReportSlotUrl('2026-11-22', 23, 45), `${base}2026-11-22_11_45PM.pdf`);
  const slots = X.injuryReportSlots({ date: '2026-11-22', hour: 17, minute: 47 }, 3);
  assert.deepEqual(slots.map((s) => s.slice(-11)), ['05_45PM.pdf', '05_30PM.pdf', '05_15PM.pdf']);
  assert.equal(X.injuryReportSlots({ date: '2026-11-22', hour: 0, minute: 10 }, 5).length, 1);
  const et = X.etParts(new Date('2026-11-22T22:31:00Z'));
  assert.deepEqual(et, { date: '2026-11-22', hour: 17, minute: 31 });
});

test('official.nba.com injury index: PDF links + timestamps, newest first, deduped', () => {
  const html = `<a href="https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-11-22_01_30PM.pdf">1:30</a>
    <a href="https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-11-22_05_00PM.pdf">5</a>
    <a href="/referee/injury/Injury-Report_2026-11-22_11_15AM.pdf">11:15</a>
    <a href="https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-11-22_05_00PM.pdf">dup</a>`;
  const r = X.parseInjuryIndex(html);
  assert.equal(r.length, 3);
  assert.equal(r[0].at, '2026-11-22T17:00:00-ET');
  assert.equal(r[2].at, '2026-11-22T11:15:00-ET');
  assert.match(r[2].url, /^https:\/\/ak-static\.cms\.nba\.com\/referee/);
});

// ------------------------------------------------------------ Action Network
const AN_GAME = {
  id: 251001,
  start_time: '2026-11-23T00:30:00.000Z',
  status: 'scheduled',
  home_team_id: 2,
  away_team_id: 1,
  teams: [
    { id: 1, full_name: 'Boston Celtics', abbr: 'BOS' },
    { id: 2, full_name: 'New York Knicks', abbr: 'NYK' },
  ],
  markets: {
    15: { event: { spread: [{ side: 'home', value: -2.5, odds: -110, bet_info: { tickets: { percent: 41 }, money: { percent: 55 } } }, { side: 'away', value: 2.5, odds: -110 }], total: [{ side: 'over', value: 224.5, odds: -108, bet_info: { tickets: { percent: 60 }, money: { percent: 48 } } }, { side: 'under', value: 224.5, odds: -112 }], moneyline: [{ side: 'home', odds: -140 }, { side: 'away', odds: 120 }] } },
    30: { event: { spread: [{ side: 'home', value: -1.5, odds: -110 }], total: [{ side: 'over', value: 222, odds: -110 }], moneyline: [{ side: 'home', odds: -125 }, { side: 'away', odds: 105 }] } },
    68: { event: { spread: [{ side: 'home', value: -2.5, odds: -112 }, { side: 'away', value: 2.5, odds: -108 }], total: [{ side: 'over', value: 225, odds: -110 }, { side: 'under', value: 225, odds: -110 }], moneyline: [{ side: 'home', odds: -142 }, { side: 'away', odds: 120 }] } },
    69: { event: { moneyline: [{ side: 'home', odds: -138 }, { side: 'away', odds: 118 }] } },
  },
};

test('Action Network scoreboard URL + normalization (books, open, consensus, no-vig, bet_info)', async () => {
  assert.equal(X.actionNetworkScoreboardUrl('2026-11-22'), 'https://api.actionnetwork.com/web/v2/scoreboard/nba?bookIds=15,30,68,69,75,123&date=20261122&periods=event');
  const r = await X.actionNetworkScoreboard(mockFetch([['actionnetwork.com/web/v2/scoreboard', res({ games: [AN_GAME] })]]), { date: '2026-11-22' });
  assert.equal(r.ok, true);
  const g = r.data.games[0];
  assert.equal(g.home.abbr, 'NYK');
  assert.equal(g.away.abbr, 'BOS');
  assert.deepEqual(g.books.map((b) => b.name), ['DraftKings', 'FanDuel']);
  const dk = g.books[0];
  assert.equal(dk.spreadHome, -2.5);
  assert.equal(dk.total, 225);
  assert.equal(dk.mlHome, -142);
  const p = 142 / 242;
  const q = 100 / 220;
  assert.ok(Math.abs(dk.noVigHome - p / (p + q)) < 1e-4);
  assert.equal(g.open.spreadHome, -1.5);
  assert.equal(g.open.mlHome, -125);
  assert.equal(g.consensus.betInfo.spreadHomeTicketsPct, 41);
  assert.equal(g.consensus.betInfo.spreadHomeMoneyPct, 55);
  assert.equal(g.consensus.betInfo.overTicketsPct, 60);
  assert.equal(g.books[1].spreadHome, null);
  assert.ok(g.books[1].noVigHome > 0.5);
});

test('Action Network injuries normalization (flat + team-grouped)', () => {
  const a = X.normalizeActionNetworkInjuries({ teams: [{ id: 1, abbr: 'BOS' }], injuries: [{ team_id: 1, status: 'out', description: 'Achilles', player: { full_name: 'Jayson Tatum', id: 9 } }] });
  assert.deepEqual(a[0], { team: 'BOS', name: 'Jayson Tatum', id: 9, status: 'out', detail: 'Achilles', returnDate: null, updated: null });
  const b = X.normalizeActionNetworkInjuries({ teams: [{ id: 2, abbr: 'NYK', injuries: [{ status: 'questionable', player: { first_name: 'Jalen', last_name: 'Brunson' } }] }] });
  assert.equal(b[0].name, 'Jalen Brunson');
  assert.equal(b[0].team, 'NYK');
});

test('cdn.nba.com odds normalization: decimal→american, opening_odds, odds_trend', async () => {
  const fx = { games: [{ gameId: '0022600123', homeTeamId: 1610612752, awayTeamId: 1610612738, markets: [
    { name: '2way', books: [{ id: 'sr:book:1', name: 'FanDuel', outcomes: [{ type: 'home', odds: '1.714', opening_odds: '1.80', odds_trend: 'down' }, { type: 'away', odds: '2.20', opening_odds: '2.05', odds_trend: 'up' }] }] },
    { name: 'spread', books: [{ id: 'sr:book:1', name: 'FanDuel', outcomes: [{ type: 'home', odds: '1.91', spread: '-2.5', opening_spread: '-1.5', odds_trend: 'neutral' }, { type: 'away', odds: '1.91', spread: '2.5' }] }] },
  ] }] };
  const r = await X.nbaOdds(mockFetch([['odds_todaysGames', res(fx)]]));
  const b = r.data.games[0].books[0];
  assert.equal(b.mlHome, -140);
  assert.equal(b.mlAway, 120);
  assert.equal(b.open.mlHome, -125);
  assert.equal(b.spreadHome, -2.5);
  assert.equal(b.open.spreadHome, -1.5);
  assert.equal(b.trend.mlHome, 'down');
  assert.ok(b.noVigHome > 0.55 && b.noVigHome < 0.58);
});

// ------------------------------------------------------------ lineups
test('stats.nba.com daily lineups parsing (position, lineupStatus, rosterStatus)', async () => {
  const fx = { date: '2026-11-22', games: [{ gameId: '0022600123', homeTeam: { teamId: 1610612752, teamAbbreviation: 'NYK', players: [
    { personId: 1628973, playerName: 'Jalen Brunson', position: 'PG', lineupStatus: 'Confirmed', rosterStatus: 'Active', timestamp: '2026-11-22T23:01:00' },
    { personId: 1, playerName: 'Bench Guy', position: '', lineupStatus: 'Confirmed', rosterStatus: 'Inactive' },
  ] }, awayTeam: { teamAbbreviation: 'BOS', players: [{ personId: 2, firstName: 'Derrick', lastName: 'White', position: 'SG', lineupStatus: 'Expected', rosterStatus: 'Active' }] } }] };
  const r = await X.nbaDailyLineups(mockFetch([['00_daily_lineups_20261122', res(fx)]]), { date: '2026-11-22' });
  assert.equal(r.ok, true);
  const g = r.data.games[0];
  assert.equal(g.home.abbr, 'NYK');
  assert.deepEqual(g.home.players[0], { id: 1628973, name: 'Jalen Brunson', position: 'PG', starter: true, lineupStatus: 'Confirmed', rosterStatus: 'Active', at: '2026-11-22T23:01:00' });
  assert.equal(g.home.players[1].starter, false);
  assert.equal(g.home.players[1].rosterStatus, 'Inactive');
  assert.equal(g.away.players[0].name, 'Derrick White');
  assert.equal(g.away.players[0].lineupStatus, 'Expected');
});

test('rotowire nba-lineups.php HTML parsing', () => {
  const li = (pos, n) => `<li class="lineup__player is-pct-play-100"><div class="lineup__pos">${pos}</div><a title="${n}" href="#">${n.split(' ')[1]}</a></li>`;
  const html = `<div class="lineup is-nba"><div class="lineup__abbr">BOS</div><div class="lineup__abbr">NYK</div>
    <ul class="lineup__list is-visit"><li class="lineup__status is-confirmed">Confirmed Lineup</li>${['PG Jrue Holiday', 'SG Derrick White', 'SF Jaylen Brown', 'PF Jayson Tatum', 'C Kristaps Porzingis'].map((s) => li(s.split(' ')[0], s.split(' ').slice(1).join(' '))).join('')}</ul>
    <ul class="lineup__list is-home"><li class="lineup__status is-expected">Expected Lineup</li>${li('PG', 'Jalen Brunson')}<li class="lineup__player"><div class="lineup__pos">C</div><a title="Mitchell Robinson">M. Robinson</a><span class="lineup__inj">GTD</span></li></ul></div>`;
  const g = X.parseRotowireLineups(html);
  assert.equal(g.length, 1);
  assert.equal(g[0].away.abbr, 'BOS');
  assert.equal(g[0].away.lineupStatus, 'Confirmed');
  assert.equal(g[0].away.starters.length, 5);
  assert.equal(g[0].away.starters[3].name, 'Jayson Tatum');
  assert.equal(g[0].home.lineupStatus, 'Expected');
  assert.equal(g[0].home.starters[1].injury, 'GTD');
});

// ------------------------------------------------------------ referees / bref / misc parsers
test('official.nba.com referee assignments parse', () => {
  const html = `<table><thead><tr><th>Game</th><th>Crew Chief</th><th>Referee</th><th>Umpire</th><th>Alternate</th></tr></thead><tbody>
    <tr><td>Boston @ New York</td><td><a>Scott Foster (#48)</a></td><td>Tony Brothers (#25)</td><td>Ben Taylor (#46)</td><td></td></tr></tbody></table>`;
  const g = X.parseRefAssignments(html);
  assert.equal(g.length, 1);
  assert.equal(g[0].crewChief, 'Scott Foster');
  assert.deepEqual(g[0].officials, ['Scott Foster', 'Tony Brothers', 'Ben Taylor']);
  assert.equal(g[0].alternate, null);
});

test('bref token bucket: 20/min, refills over time, rate-limit result keeps contract', async () => {
  let t = 0;
  const b = X.createTokenBucket({ capacity: 20, now: () => t, sleep: async (ms) => { t += ms; } });
  for (let i = 0; i < 20; i++) assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false);
  t += 3000; // 1 token per 3s
  assert.equal(b.tryTake(), true);
  assert.equal(await b.take(1000), false); // would need 3s
  assert.equal(await b.take(5000), true); // sleeps 3s
  const empty = X.createTokenBucket({ capacity: 1, now: () => 0, sleep: async () => {} });
  empty.tryTake();
  const r = await X.brefGamelog(mockFetch([]), { playerId: 'tatumja01', bucket: empty });
  assertContract(r);
  assert.equal(r.status, 429);
});

test('bref gamelog parse (commented table, newest first) and URL', async () => {
  assert.equal(X.brefUrls.gamelog({ playerId: 'tatumja01', season: '2026-27' }), 'https://www.basketball-reference.com/players/t/tatumja01/gamelog/2027');
  const tr = (d, pts) => `<tr><th data-stat="ranker">1</th><td data-stat="date_game">${d}</td><td data-stat="game_location">@</td><td data-stat="opp_id">NYK</td><td data-stat="mp">36:00</td><td data-stat="pts">${pts}</td><td data-stat="trb">8</td><td data-stat="ast">5</td></tr>`;
  const html = `<!-- <table id="pgl_basic"><thead><tr><th>Rk</th></tr></thead><tbody>${tr('2026-11-01', 30)}${tr('2026-11-03', 22)}<tr class="thead"><th>Rk</th></tr></tbody></table> -->`;
  const r = await X.brefGamelog(mockFetch([['basketball-reference.com', res(html)]]), { playerId: 'tatumja01', season: '2026-27', bucket: X.createTokenBucket({ capacity: 5 }) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.logs.map((l) => l.pts), [22, 30]);
  assert.equal(r.data.logs[0].home, false);
});

test('underdog filter keeps only NBA points/rebounds/assists', () => {
  const d = {
    players: [{ id: 'p1', first_name: 'Jalen', last_name: 'Brunson', sport_id: 'NBA' }, { id: 'p2', first_name: 'Pat', last_name: 'Mahomes', sport_id: 'NFL' }],
    appearances: [{ id: 'a1', player_id: 'p1', match_id: 9 }, { id: 'a2', player_id: 'p2', match_id: 8 }],
    over_under_lines: [
      { id: 'l1', stat_value: '26.5', over_under: { appearance_stat: { appearance_id: 'a1', stat: 'points' } } },
      { id: 'l2', stat_value: '1.5', over_under: { appearance_stat: { appearance_id: 'a1', stat: 'three_points_made' } } },
      { id: 'l3', stat_value: '250.5', over_under: { appearance_stat: { appearance_id: 'a2', stat: 'points' } } },
    ],
  };
  assert.deepEqual(X.filterUnderdogNba(d), [{ id: 'l1', player: 'Jalen Brunson', playerId: 'p1', team: null, matchId: 9, stat: 'points', line: 26.5, status: null }]);
});

test('The Odds API: quota headers recorded, apiKey redacted from url', async () => {
  const body = [{ id: 'e1', commence_time: 'x', home_team: 'New York Knicks', away_team: 'Boston Celtics', bookmakers: [{ key: 'dk', title: 'DraftKings', markets: [{ key: 'h2h', outcomes: [{ name: 'New York Knicks', price: -140 }, { name: 'Boston Celtics', price: 120 }] }, { key: 'spreads', outcomes: [{ name: 'New York Knicks', point: -2.5, price: -110 }] }, { key: 'totals', outcomes: [{ name: 'Over', point: 224.5 }] }] }] }];
  const log = [];
  const r = await X.theOddsApiOdds(mockFetch([['the-odds-api.com/v4/sports/basketball_nba/odds', res(body, { headers: { 'x-requests-remaining': '481', 'x-requests-used': '19' } })]], log), { apiKey: 'SECRET123' });
  assert.equal(r.ok, true);
  assert.match(log[0].url, /apiKey=SECRET123/);
  assert.doesNotMatch(r.url, /SECRET123/);
  assert.deepEqual(r.quota, { remaining: 481, used: 19 });
  assert.deepEqual(r.data.quota, { remaining: 481, used: 19 });
  assert.equal(r.data.games[0].books[0].spreadHome, -2.5);
  const noKey = await X.theOddsApiOdds(mockFetch([]), {});
  assert.equal(noKey.ok, false);
});

test('helpers: season, bref year, odds math', () => {
  assert.equal(X.seasonFor('2026-11-22'), '2026-27');
  assert.equal(X.seasonFor('2027-03-01'), '2026-27');
  assert.equal(X.brefYear('2026-27'), 2027);
  assert.equal(X.decimalToAmerican(2.5), 150);
  assert.equal(X.decimalToAmerican(1.5), -200);
  assert.equal(X.noVigHome(-110, -110), 0.5);
  assert.equal(X.nbastufferRefUrl('2026-27'), 'https://www.nbastuffer.com/2026-2027-nba-referee-stats/');
});

// ------------------------------------------------------------ PDF (synthetic; real NBA PDF unverified)
function buildPdf(content, { flate = false } = {}) {
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <20> <7E> <0020> endbfrange endcmap end end';
  const stream = flate ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    null, // content stream
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /ToUnicode 7 0 R >>',
    null, // cmap
  ];
  const parts = [Buffer.from('%PDF-1.7\n%\xE2\xE3\n', 'latin1')];
  objs.forEach((o, i) => {
    const n = i + 1;
    if (n === 4) parts.push(Buffer.from(`4 0 obj\n<< /Length ${stream.length}${flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream\nendobj\n', 'latin1'));
    else if (n === 7) parts.push(Buffer.from(`7 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj\n`, 'latin1'));
    else parts.push(Buffer.from(`${n} 0 obj\n${o}\nendobj\n`, 'latin1'));
  });
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}
const at = (x, y, s, font = 'F1') => `BT /${font} 8 Tf 1 0 0 1 ${x} ${y} Tm (${s}) Tj ET\n`;
const hex = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();
const CONTENT =
  at(20, 760, 'Injury Report: 11/22/26 05:00 PM') +
  ['Game Date', 'Game Time', 'Matchup', 'Team', 'Player Name', 'Current Status', 'Reason'].map((h, i) => at([20, 90, 150, 220, 350, 480, 560][i], 700, h, 'F2')).join('') +
  at(20, 680, '11/22/2026') + at(90, 680, '07:30 \\(ET\\)') + at(150, 680, 'BOS@NYK') + at(220, 680, 'Boston Celtics') + at(350, 680, 'Tatum, Jayson') + at(480, 680, 'Out') + at(560, 680, 'Injury/Illness - Right Achilles; Repair') +
  at(350, 668, 'Brown, Jaylen') + at(480, 668, 'Questionable') + at(560, 668, 'Injury/Illness - Left Knee;') +
  at(560, 656, 'Tendinopathy') +
  at(220, 644, 'New York Knicks') + 'BT /F1 8 Tf 1 0 0 1 350 644 Tm [(Brun) -20 (son, Jalen)] TJ ET\n' + `BT /F2 8 Tf 480 644 Td <${hex('Probable')}> Tj ET\n` + at(560, 644, 'Injury/Illness - Right Ankle; Sprain') +
  at(20, 620, 'Page 1 of 1');

test('pdf: CMap parse (bfrange + bfchar)', () => {
  const m = parseCMap('1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0003> <0041> endbfchar 1 beginbfrange <0010> <0012> <0061> endbfrange');
  assert.equal(m.codeLen, 2);
  assert.equal(m.map.get(3), 'A');
  assert.equal(m.map.get(0x11), 'b');
});

for (const flate of [false, true]) {
  test(`pdf: injury report rows from synthetic PDF (${flate ? 'FlateDecode' : 'uncompressed'})`, async () => {
    const pdf = buildPdf(CONTENT, { flate });
    const t = await extractPdfText(pdf);
    assert.equal(t.error, null);
    assert.ok(t.items.length > 10);
    const { rows, unverified } = await parseInjuryReportPdf(pdf);
    assert.equal(unverified, true);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { gameDate: '11/22/2026', gameTime: '07:30 (ET)', matchup: 'BOS@NYK', team: 'Boston Celtics', player: 'Tatum, Jayson', status: 'Out', reason: 'Injury/Illness - Right Achilles; Repair' });
    assert.equal(rows[1].reason, 'Injury/Illness - Left Knee; Tendinopathy');
    assert.equal(rows[1].team, 'Boston Celtics');
    assert.equal(rows[2].team, 'New York Knicks');
    assert.equal(rows[2].player, 'Brunson, Jalen');
    assert.equal(rows[2].status, 'Probable');
    assert.equal(rows[2].matchup, 'BOS@NYK');
  });
}

test('pdf: garbage input never throws; nbaInjuryPdf adapter end-to-end', async () => {
  const bad = await parseInjuryReportPdf(new Uint8Array([1, 2, 3]));
  assert.deepEqual(bad.rows, []);
  assert.ok(bad.error);
  const pdf = buildPdf(CONTENT, { flate: true });
  const r = await X.nbaInjuryPdf(mockFetch([['Injury-Report_2026-11-22_05_00PM.pdf', res(pdf)]]), { date: '2026-11-22', hour: 17, minute: 0 });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.rows.length, 3);
  assert.equal(r.bytes, pdf.length);
});

test('nbaInjuryReportLatest: index first, then slot probing', async () => {
  const pdf = buildPdf(CONTENT);
  const log = [];
  const f = mockFetch([
    ['official.nba.com/nba-injury-report', res('<a href="https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-11-22_04_30PM.pdf">x</a>')],
    ['Injury-Report_2026-11-22_05_15PM.pdf', res(pdf)],
  ], log);
  const r = await X.nbaInjuryReportLatest(f, { now: { date: '2026-11-22', hour: 17, minute: 20 } });
  assert.equal(r.ok, true);
  assert.deepEqual(log.map((l) => l.url.replace(/.*\//, '')), ['', 'Injury-Report_2026-11-22_04_30PM.pdf', 'Injury-Report_2026-11-22_05_15PM.pdf']);
});

// ------------------------------------------------------------ chains
const okR = (data, host = 'h.test') => ({ ok: true, status: 200, bytes: 10, ms: 1, host, url: `https://${host}/`, data, error: null });
const failR = (status = 503, host = 'site.api.espn.com') => ({ ok: false, status, bytes: 0, ms: 2, host, url: `https://${host}/`, data: null, error: `HTTP ${status}` });
function mockEspn(over = {}) {
  const names = ['espnScoreboard', 'espnSummary', 'espnInjuries', 'espnStandings', 'espnRoster', 'espnSchedule', 'espnGamelog', 'espnSplits', 'espnCoreOdds', 'espnPropBets', 'espnOfficials', 'espnDepthChart', 'espnPowerIndex'];
  const calls = [];
  const E = { calls };
  for (const n of names) E[n] = async (f, p) => { calls.push([n, p]); return over[n] ? over[n](p) : failR(); };
  return E;
}

test('runChain: tries in order, stops at first ok+non-empty, logs every attempt', async () => {
  const order = [];
  const links = [
    { name: 'a', run: async () => (order.push('a'), failR(500, 'a.test')) },
    { name: 'b', run: async () => (order.push('b'), okR([])) }, // ok but empty -> fallthrough
    { name: 'c', run: async () => { order.push('c'); throw new Error('kaboom'); } },
    { name: 'd', run: async () => (order.push('d'), okR({ rows: [1] }, 'd.test')) },
    { name: 'e', run: async () => (order.push('e'), okR([1])) },
  ];
  const r = await runChain('t', links, { fetchImpl: () => {} });
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
  assert.equal(r.ok, true);
  assert.equal(r.servedBy, 'd');
  assert.deepEqual(r.data, { rows: [1] });
  assert.deepEqual(r.attempts.map((a) => [a.name, a.ok]), [['a', false], ['b', false], ['c', false], ['d', true]]);
  for (const a of r.attempts) for (const k of ['name', 'status', 'ok', 'ms', 'bytes', 'host']) assert.ok(k in a);
  assert.equal(r.attempts[0].status, 500);
  assert.equal(r.attempts[0].host, 'a.test');
  assert.equal(r.attempts[1].error, 'empty');
  assert.match(r.attempts[2].error, /kaboom/);
  const none = await runChain('t', [links[0]], {});
  assert.equal(none.ok, false);
  assert.equal(none.servedBy, null);
  assert.equal(none.attempts.length, 1);
});

test('chain definitions: exact link order', () => {
  const C = buildChains(mockEspn());
  assert.deepEqual(CHAIN_NAMES, Object.keys(C));
  assert.deepEqual(C.injuries.map((l) => l.name), ['espnInjuries', 'actionNetworkInjuries', 'nbaInjuryPdf']);
  assert.deepEqual(C.lineups.map((l) => l.name), ['nbaDailyLineups', 'rotowireLineups', 'espnDepthChart']);
  assert.deepEqual(C.odds.map((l) => l.name), ['espnCoreOdds', 'actionNetworkScoreboard', 'nbaOdds', 'theOddsApi']);
  assert.deepEqual(C.gamelogs.map((l) => l.name), ['espnGamelog', 'pbpstatsGameLogs', 'brefGamelog']);
  assert.deepEqual(C.pbp.map((l) => l.name), ['espnSummary', 'pbpstatsLive', 'nbaPlayByPlay']);
  assert.deepEqual(C.referees.map((l) => l.name), ['espnOfficials', 'nbaRefAssignments', 'nbastufferRefStats']);
});

test('injuries chain: ESPN 503 → Action Network serves; PDF never fetched', async () => {
  const E = mockEspn();
  const log = [];
  const f = mockFetch([['leagues/4/injuries', res({ injuries: [{ status: 'out', player: { full_name: 'Jayson Tatum' } }] })]], log);
  const r = await runNamedChain('injuries', { fetchImpl: f }, E);
  assert.equal(r.ok, true);
  assert.equal(r.servedBy, 'actionNetworkInjuries');
  assert.deepEqual(r.attempts.map((a) => a.name), ['espnInjuries', 'actionNetworkInjuries']);
  assert.equal(r.attempts[0].status, 503);
  assert.equal(r.attempts[1].host, 'api.actionnetwork.com');
  assert.ok(!log.some((l) => /Injury-Report_/.test(l.url)));
  assert.equal(r.data[0].name, 'Jayson Tatum');
});

test('injuries chain: ESPN ok short-circuits (no network)', async () => {
  const E = mockEspn({ espnInjuries: () => okR([{ name: 'X' }], 'site.api.espn.com') });
  const log = [];
  const r = await runNamedChain('injuries', { fetchImpl: mockFetch([], log) }, E);
  assert.equal(r.servedBy, 'espnInjuries');
  assert.equal(r.attempts.length, 1);
  assert.equal(log.length, 0);
});

test('odds chain: espnCoreOdds skipped without eventId, AN empty, cdn odds serves', async () => {
  const E = mockEspn();
  const fx = { games: [{ gameId: '1', markets: [{ name: '2way', books: [{ name: 'FanDuel', outcomes: [{ type: 'home', odds: '1.8' }, { type: 'away', odds: '2.1' }] }] }] }] };
  const f = mockFetch([['actionnetwork.com', res({ games: [] })], ['odds_todaysGames', res(fx)]]);
  const r = await runNamedChain('odds', { fetchImpl: f, date: '2026-11-22' }, E);
  assert.equal(r.servedBy, 'nbaOdds');
  assert.deepEqual(r.attempts.map((a) => [a.name, a.ok]), [['espnCoreOdds', false], ['actionNetworkScoreboard', false], ['nbaOdds', true]]);
  assert.match(r.attempts[0].error, /eventId missing/);
  assert.equal(E.calls.length, 0);
});

test('odds chain: all fail → TheOddsAPI last, ok:false with 4 attempts', async () => {
  const r = await runNamedChain('odds', { fetchImpl: mockFetch([]), eventId: '401', oddsApiKey: 'k' }, mockEspn());
  assert.equal(r.ok, false);
  assert.deepEqual(r.attempts.map((a) => a.name), ['espnCoreOdds', 'actionNetworkScoreboard', 'nbaOdds', 'theOddsApi']);
  assert.equal(r.attempts[3].host, 'api.the-odds-api.com');
});

test('lineups chain: NBA daily JSON empty → rotowire serves', async () => {
  const html = '<div class="lineup is-nba"><div class="lineup__abbr">BOS</div><div class="lineup__abbr">NYK</div><ul class="lineup__list is-visit"><li class="lineup__player"><div class="lineup__pos">PG</div><a title="Jrue Holiday">J</a></li></ul><ul class="lineup__list is-home"></ul></div>';
  const f = mockFetch([['daily_lineups', res({ games: [] })], ['rotowire.com/basketball/nba-lineups.php', res(html)]]);
  const r = await runNamedChain('lineups', { fetchImpl: f, date: '2026-11-22' }, mockEspn());
  assert.equal(r.servedBy, 'rotowireLineups');
  assert.equal(r.attempts[0].ok, false);
});

test('gamelogs / pbp / referees chains fall through in order', async () => {
  const E = mockEspn({ espnDepthChart: () => okR({ items: [1] }) });
  const g = await runNamedChain('gamelogs', { fetchImpl: mockFetch([['api.pbpstats.com/get-game-logs', res({ multi_row_table_data: [{ Points: 30 }] })]]), athleteId: '4065648', nbaPlayerId: 1628369, season: '2026-27' }, E);
  assert.equal(g.servedBy, 'pbpstatsGameLogs');
  assert.deepEqual(E.calls[0], ['espnGamelog', { athleteId: '4065648', season: 2027 }]);
  const p = await runNamedChain('pbp', { fetchImpl: mockFetch([['playbyplay_0022600123', res({ game: { gameId: '0022600123', actions: [{ actionNumber: 1, period: 1, actionType: 'jumpball' }] } })]]), eventId: '401', nbaGameId: '0022600123' }, E);
  assert.equal(p.servedBy, 'nbaPlayByPlay');
  assert.deepEqual(p.attempts.map((a) => a.name), ['espnSummary', 'pbpstatsLive', 'nbaPlayByPlay']);
  const refHtml = '<table><tr><th>Rank</th><th>Referee</th></tr><tr><td>1</td><td>Scott Foster</td></tr></table>';
  const rf = await runNamedChain('referees', { fetchImpl: mockFetch([['nbastuffer.com', res(refHtml)]]), season: '2026-27' }, E);
  assert.equal(rf.servedBy, 'nbastufferRefStats');
  assert.equal(rf.data.referees[0].Referee, 'Scott Foster');
});

test('nonEmpty semantics', () => {
  assert.equal(nonEmpty(null), false);
  assert.equal(nonEmpty([]), false);
  assert.equal(nonEmpty({ games: [] }), false);
  assert.equal(nonEmpty({ games: [], x: [1] }), true);
  assert.equal(nonEmpty({ a: 1 }), true);
});

// ------------------------------------------------------------ health
test('healthCheckAll: one row per adapter with Health-tab fields; ids discovered', async () => {
  const E = mockEspn({ espnScoreboard: () => okR({ events: [{ id: '401', competitions: [{ competitors: [{ homeAway: 'home', id: '18' }] }] }] }) });
  const f = mockFetch([['todaysScoreboard_00', res({ scoreboard: { games: [{ gameId: '0022600123', homeTeam: {}, awayTeam: {} }] } })]]);
  const rows = await healthCheckAll(f, { date: '2026-11-22', E });
  assert.equal(rows.length, 13 + Object.keys(X.EXTRA_ADAPTERS).length);
  for (const r of rows) for (const k of ['adapter', 'source', 'chains', 'serverOnly', 'host', 'url', 'ok', 'status', 'ms', 'bytes', 'error', 'skipped']) assert.ok(k in r, `${r.adapter} ${k}`);
  const byName = Object.fromEntries(rows.map((r) => [r.adapter, r]));
  assert.equal(byName.espnScoreboard.ok, true);
  assert.equal(byName.nbaTodaysScoreboard.ok, true);
  assert.equal(byName.espnCoreOdds.skipped, false); // eventId discovered
  assert.deepEqual(E.calls.find((c) => c[0] === 'espnCoreOdds')[1], { eventId: '401' });
  assert.deepEqual(E.calls.find((c) => c[0] === 'espnDepthChart')[1], { teamId: '18', season: 2027 });
  assert.equal(byName.nbaBoxscore.url, 'https://cdn.nba.com/static/json/liveData/boxscore/boxscore_0022600123.json');
  assert.equal(byName.theOddsApiOdds.skipped, true);
  assert.equal(byName.brefGamelog.skipped, true);
  assert.equal(byName.nbaOdds.serverOnly, true);
  assert.equal(byName.polymarketNba.serverOnly, false);
});
