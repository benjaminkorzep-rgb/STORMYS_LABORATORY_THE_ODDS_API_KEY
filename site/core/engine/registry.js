// Pre-registered trend hypotheses (APPENDIX B §10).
//
// Every testable trend is one row. Every grid point is its own hypothesis and
// counts toward m forever: rows are never deleted, only added (with a new
// registeredAt). Thresholds may only come from the FIXED grid below; asking for
// any other threshold throws. Outcomes are residuals (vs the base model and vs
// the closing no-vig line), never raw W/L.
//
// Plain ES module, no dependencies, no platform APIs.

export const REGISTRY_VERSION = 1;
export const REGISTERED_AT = '2026-11-22T00:00:00.000Z';

export const FAMILIES = Object.freeze([
  'Schedule', 'Travel/Clock', 'Calendar', 'Officials', 'Exposure',
  'Motivation', 'Style', 'Player', 'Market',
]);

// ---------------------------------------------------------------- outcomes
// field = residual vs base model, closeField = residual vs closing no-vig line.
export const OUTCOMES = Object.freeze({
  margin_resid_model: { field: 'residModel', closeField: 'residClose', unit: 'pts' },
  margin_resid_close: { field: 'residClose', closeField: null, unit: 'pts' },
  total_resid_model: { field: 'totalResidModel', closeField: 'totalResidClose', unit: 'pts' },
  total_resid_close: { field: 'totalResidClose', closeField: null, unit: 'pts' },
  player_pts_resid: { field: 'ptsResid', closeField: 'ptsResidClose', unit: 'pts' },
  player_reb_resid: { field: 'rebResid', closeField: 'rebResidClose', unit: 'pts' },
  player_ast_resid: { field: 'astResid', closeField: 'astResidClose', unit: 'pts' },
});

const RAW_WL = /(^|[_\-\s])(w|l|wl|w\/l|win|wins|won|winpct|loss|losses|lost|result|results|record|su|ats|cover|covers|covered|hit|hits|over_under|ou)([_\-\s]|$)/i;

export function assertOutcome(outcome) {
  if (typeof outcome !== 'string' || !outcome) throw new Error('Trend outcome is required');
  if (OUTCOMES[outcome]) return OUTCOMES[outcome];
  if (RAW_WL.test(outcome)) {
    throw new Error(`Refusing raw W/L outcome "${outcome}": trends are tested on residuals vs the base model and vs the closing no-vig line, never on raw wins/losses/covers`);
  }
  throw new Error(`Unknown trend outcome "${outcome}" (allowed: ${Object.keys(OUTCOMES).join(', ')})`);
}

// ---------------------------------------------------------------- threshold grid
export const TEAMS = Object.freeze([
  'ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NOP', 'NYK', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS',
]);
const ABBR_ALIASES = { GS: 'GSW', NY: 'NYK', NO: 'NOP', NOR: 'NOP', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS', BRK: 'BKN', BK: 'BKN', PHO: 'PHX', CHO: 'CHA' };
export function normAbbr(a) {
  if (a == null) return a;
  const u = String(a).toUpperCase();
  return ABBR_ALIASES[u] || u;
}

export const CREW_CHIEFS = Object.freeze([
  'Scott Foster', 'Tony Brothers', 'Marc Davis', 'Zach Zarba', 'James Capers', 'Ed Malloy',
  'Bill Kennedy', 'Kane Fitzgerald', 'Sean Wright', 'John Goble', 'Josh Tiven', 'David Guthrie',
]);

export const GRID = Object.freeze({
  flag: [true],
  restDays: [0, 1, 2, 3],            // 3 means 3+
  oppRestDays: [0],
  restAdv: [1, 2],
  gameNumber: [1, 2, 3, 4, 5, 6],
  tzShift: [-3, -2, -1, 0, 1, 2, 3],
  tzDirection: ['east', 'west'],
  altitudeVenue: ['DEN', 'UTA'],
  dayGameBefore: [17],
  tipHour: [[12, 15], [15, 18], [18, 19], [19, 20], [20, 21], [21, 22], [22, 24]],
  bodyClock: [[0, 17], [17, 22], [22, 30]],
  month: [10, 11, 12, 1, 2, 3, 4],
  dow: [0, 1, 2, 3, 4, 5, 6],
  allStar: ['pre', 'post'],
  seasonWindow: ['first10', 'last10'],
  holiday: ['thanksgiving_eve', 'new_years_eve', 'new_years_day', 'mlk_day', 'presidents_day'],
  crewChief: CREW_CHIEFS,
  crewTotalDelta: [-4, -2, 2, 4],
  crewFtRateZ: [-1, 1],
  revengeMargin: [10, 15, 20],
  rematchDays: [7, 14],
  playoffRace: ['in', 'eliminated'],
  h2hStreak: [3, 5],
  paceMismatch: [2, 4, 6],           // possessions
  threePaRateMismatch: [3, 5, 7],    // percentage points of FGA
  rebMismatch: [2, 4, 6],            // OREB% points
  foulMismatch: [3, 5, 7],           // FT-rate points
  opponent: TEAMS,
  playerTip: [[12, 19], [19, 21], [21, 24]],
  lineMove: [-3.5, -2.5, -1.5, 1.5, 2.5, 3.5],
  totalMove: [-3.5, -2.5, -1.5, 1.5, 2.5, 3.5],
  favSize: [[0, 3], [3, 6], [6, 9], [9, 12], [12, 99]],
  dogSize: [[0.5, 3], [3, 6], [6, 9], [9, 12], [12, 99]],
});

const sameVal = (a, b) => (Array.isArray(a) || Array.isArray(b)) ? JSON.stringify(a) === JSON.stringify(b) : a === b;

export function isGridThreshold(key, value) {
  const g = GRID[key];
  return !!g && g.some((v) => sameVal(v, value));
}

export function assertGridThreshold(key, value) {
  if (!GRID[key]) throw new Error(`Unknown threshold key "${key}" (not on the fixed grid)`);
  if (!isGridThreshold(key, value)) {
    throw new Error(`Threshold ${JSON.stringify(value)} for "${key}" is not on the fixed grid ${JSON.stringify(GRID[key])}; thresholds may not be tuned after looking at data`);
  }
  return true;
}

// ---------------------------------------------------------------- predicates
// A subgroup is machine-readable: a leaf [field, op, value] or {all:[...]}, {any:[...]}, {not: p}.
// ops: == != >= <= > < in between([lo,hi)) truthy falsy
export const DERIVED = Object.freeze({
  restAdv: (r) => num(r.restDays) - num(r.oppRestDays),
  bodyClockHour: (r) => (r.bodyClockHour != null ? r.bodyClockHour : num(r.tipHourLocal) - (Number(r.tzShift) || 0)),
  absPaceMismatch: (r) => Math.abs(num(r.paceMismatch)),
  absThreePaRateMismatch: (r) => Math.abs(num(r.threePaRateMismatch)),
  absFoulMismatch: (r) => Math.abs(num(r.foulMismatch)),
  dogSize: (r) => -num(r.favSize),
});
function num(v) { return v == null || v === '' ? NaN : Number(v); }

function fieldValue(rec, field) {
  if (Object.prototype.hasOwnProperty.call(DERIVED, field) && rec[field] == null) return DERIVED[field](rec);
  const v = rec[field];
  return field === 'teamAbbr' || field === 'oppAbbr' ? normAbbr(v) : v;
}

function evalLeaf(leaf, rec) {
  const [field, op, value] = leaf;
  const v = fieldValue(rec, field);
  if (op === 'truthy') return !!v;
  if (op === 'falsy') return !v;
  if (v == null || (typeof v === 'number' && Number.isNaN(v))) return false;
  switch (op) {
    case '==': return v === value;
    case '!=': return v !== value;
    case '>=': return v >= value;
    case '<=': return v <= value;
    case '>': return v > value;
    case '<': return v < value;
    case 'in': return value.includes(v);
    case 'between': return v >= value[0] && v < value[1];
    default: throw new Error(`Unknown predicate op "${op}"`);
  }
}

export function evalPredicate(p, rec) {
  if (Array.isArray(p)) return evalLeaf(p, rec);
  if (p && p.all) return p.all.every((q) => evalPredicate(q, rec));
  if (p && p.any) return p.any.some((q) => evalPredicate(q, rec));
  if (p && p.not) return !evalPredicate(p.not, rec);
  throw new Error('Malformed subgroup predicate');
}

// Is this record (a team-game or player-game row) in the row's subgroup?
export function subgroupOf(row, record) {
  if (!row || !record) return false;
  const isPlayer = record.playerId != null;
  if ((row.scope === 'player') !== isPlayer) return false;
  return evalPredicate(row.subgroup, record);
}

// ---------------------------------------------------------------- row factory
const SHORT = { margin_resid_model: 'margin', total_resid_model: 'total', player_pts_resid: 'pts', player_reb_resid: 'reb', player_ast_resid: 'ast', margin_resid_close: 'marginClose', total_resid_close: 'totalClose' };

// Validates outcome and threshold; use this for any ad-hoc hypothesis too.
export function defineHypothesis(spec) {
  const { id, family, label, scope = 'team', subgroup, outcome = 'margin_resid_model', direction = 'either', threshold, mechanism = 'none', narrativeOnly = false, noisyInput = null, registeredAt = REGISTERED_AT } = spec || {};
  assertOutcome(outcome);
  if (!FAMILIES.includes(family)) throw new Error(`Unknown family "${family}"`);
  if (!threshold || !threshold.key) throw new Error('Every hypothesis needs a grid threshold {key, value}');
  assertGridThreshold(threshold.key, threshold.value);
  if (!['team', 'player', 'game'].includes(scope)) throw new Error(`Bad scope "${scope}"`);
  if (outcome.startsWith('player_') !== (scope === 'player')) throw new Error(`Outcome ${outcome} does not match scope ${scope}`);
  if (!subgroup) throw new Error('Every hypothesis needs a machine-readable subgroup predicate');
  // game-scope rows are one per game: use the home team row to avoid double counting.
  const sg = scope === 'game' ? { all: [['home', '==', true], subgroup] } : subgroup;
  return Object.freeze({ id, family, label, scope, subgroup: sg, outcome, direction, threshold: Object.freeze({ ...threshold }), mechanism, narrativeOnly, noisyInput, registeredAt });
}

const rows = [];
function add(fam, key, label, sub, th, opts = {}) {
  const outs = opts.outcomes || ['margin_resid_model'];
  for (const outcome of outs) {
    const isTotal = outcome.startsWith('total');
    const scope = opts.scope || (isTotal ? 'game' : 'team');
    rows.push(defineHypothesis({
      id: `${fam.toLowerCase().replace(/[^a-z]+/g, '')}.${key}.${SHORT[outcome]}`,
      family: fam,
      label: `${label}${outs.length > 1 ? (isTotal ? ' (total)' : ' (margin)') : ''}`,
      scope, subgroup: sub, outcome,
      direction: (isTotal ? opts.dirTotal : opts.dir) || 'either',
      threshold: { key: th[0], value: th[1] },
      mechanism: opts.mech || 'none',
      narrativeOnly: !!opts.narrative,
      noisyInput: opts.noisy || null,
    }));
  }
}
const MT = ['margin_resid_model', 'total_resid_model'];
const MONTHS = { 10: 'Oct', 11: 'Nov', 12: 'Dec', 1: 'Jan', 2: 'Feb', 3: 'Mar', 4: 'Apr' };
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ord = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

// Schedule (29)
for (const d of GRID.restDays) {
  add('Schedule', `rest${d}${d === 3 ? 'plus' : ''}`, `Team on ${d === 3 ? '3+' : d} days rest`, d === 3 ? ['restDays', '>=', 3] : ['restDays', '==', d], ['restDays', d], { outcomes: MT, scope: 'team', mech: 'fatigue', dir: d === 0 ? 'neg' : 'either' });
}
add('Schedule', 'b2b', 'Team on second night of a back-to-back', ['b2b', '==', true], ['flag', true], { outcomes: MT, scope: 'team', mech: 'fatigue', dir: 'neg' });
add('Schedule', 'oppb2b', 'Opponent on a back-to-back', ['oppRestDays', '==', 0], ['oppRestDays', 0], { mech: 'fatigue', dir: 'pos' });
for (const a of GRID.restAdv) add('Schedule', `restadv${a}`, `Rest advantage of ${a}+ days`, ['restAdv', '>=', a], ['restAdv', a], { mech: 'fatigue', dir: 'pos' });
add('Schedule', '3in4', 'Third game in four nights', ['threeInFour', '==', true], ['flag', true], { outcomes: MT, scope: 'team', mech: 'fatigue', dir: 'neg' });
add('Schedule', '4in6', 'Fourth game in six nights', ['fourInSix', '==', true], ['flag', true], { outcomes: MT, scope: 'team', mech: 'fatigue', dir: 'neg' });
for (const g of GRID.gameNumber) add('Schedule', `roadtrip${g}`, `${ord(g)} game of a road trip`, ['roadTripGame', '==', g], ['gameNumber', g], { mech: 'travel' });
for (const g of GRID.gameNumber) add('Schedule', `homestand${g}`, `${ord(g)} game of a homestand`, ['homestandGame', '==', g], ['gameNumber', g], { mech: 'travel' });

// Travel/Clock (32)
for (const s of GRID.tzShift) add('Travel/Clock', `tz${s < 0 ? 'm' : 'p'}${Math.abs(s)}`, `Time-zone shift ${s > 0 ? '+' : ''}${s}h vs home`, ['tzShift', '==', s], ['tzShift', s], { outcomes: MT, scope: 'team', mech: 'circadian' });
add('Travel/Clock', 'east', 'Traveled east (lost hours)', ['tzShift', '>', 0], ['tzDirection', 'east'], { mech: 'circadian', dir: 'neg' });
add('Travel/Clock', 'west', 'Traveled west (gained hours)', ['tzShift', '<', 0], ['tzDirection', 'west'], { mech: 'circadian' });
for (const v of GRID.altitudeVenue) {
  add('Travel/Clock', `alt${v.toLowerCase()}`, `Visiting team at altitude (${v})`, { all: [['home', '==', false], ['oppAbbr', '==', v]] }, ['altitudeVenue', v], { mech: 'altitude', dir: 'neg' });
  add('Travel/Clock', `alt${v.toLowerCase()}`, `Game at altitude (${v})`, ['teamAbbr', '==', v], ['altitudeVenue', v], { outcomes: ['total_resid_model'], mech: 'altitude' });
}
add('Travel/Clock', 'daygame', 'Day game (local tip before 5pm)', ['tipHourLocal', '<', 17], ['dayGameBefore', 17], { outcomes: MT, scope: 'team', mech: 'circadian' });
for (const b of GRID.tipHour) add('Travel/Clock', `tip${b[0]}`, `Local tip ${b[0]}:00-${b[1]}:00`, ['tipHourLocal', 'between', b], ['tipHour', b], { mech: 'circadian' });
for (const b of GRID.bodyClock) add('Travel/Clock', `body${b[0]}`, `Body-clock tip ${b[0] === 0 ? 'before 5pm' : b[0] === 17 ? '5pm-10pm' : '10pm or later'}`, ['bodyClockHour', 'between', b], ['bodyClock', b], { mech: 'circadian' });

// Calendar (32)
for (const m of GRID.month) add('Calendar', `month${m}`, `Games in ${MONTHS[m]}`, ['month', '==', m], ['month', m], { outcomes: MT, mech: 'seasonality' });
for (const d of GRID.dow) add('Calendar', `dow${d}`, `${DOWS[d]} games`, ['dow', '==', d], ['dow', d], { mech: 'none' });
add('Calendar', 'preallstar', 'Before the All-Star break', ['postAllStar', '==', false], ['allStar', 'pre'], { mech: 'seasonality' });
add('Calendar', 'postallstar', 'After the All-Star break', ['postAllStar', '==', true], ['allStar', 'post'], { mech: 'seasonality' });
add('Calendar', 'first10', 'First 10 games of the season', ['gameOfSeason', '<=', 10], ['seasonWindow', 'first10'], { outcomes: MT, mech: 'seasonality' });
add('Calendar', 'last10', 'Last 10 games of the season', ['gameOfSeason', '>=', 73], ['seasonWindow', 'last10'], { outcomes: MT, mech: 'motivation' });
for (const h of GRID.holiday) add('Calendar', `hol_${h}`, `Holiday: ${h.replace(/_/g, ' ')}`, ['holiday', '==', h], ['holiday', h], { mech: 'none' });

// Officials (32) — margin rows are from the home team's perspective (game scope).
const crewNote = 'Crew assignments post the morning of the game and crew-level samples are small, so crew effects are noisy inputs.';
for (const c of GRID.crewChief) {
  const key = `crew_${c.toLowerCase().replace(/[^a-z]+/g, '')}`;
  add('Officials', key, `Crew chief ${c}`, ['crewChief', '==', c], ['crewChief', c], { outcomes: ['total_resid_model'], mech: 'officiating', noisy: crewNote });
  add('Officials', key, `Crew chief ${c} (home margin)`, ['crewChief', '==', c], ['crewChief', c], { scope: 'game', mech: 'officiating', noisy: crewNote });
}
for (const d of GRID.crewTotalDelta) add('Officials', `crewdelta${d < 0 ? 'm' : 'p'}${Math.abs(d)}`, `Crew total delta ${d > 0 ? '>= +' : '<= '}${d}`, ['crewTotalDelta', d > 0 ? '>=' : '<=', d], ['crewTotalDelta', d], { outcomes: ['total_resid_model'], mech: 'officiating', noisy: crewNote });
for (const z of GRID.crewFtRateZ) {
  const key = `crewftr${z < 0 ? 'low' : 'high'}`;
  const sub = ['crewFtRateZ', z > 0 ? '>=' : '<=', z];
  add('Officials', key, `${z > 0 ? 'High' : 'Low'} FT-rate crew`, sub, ['crewFtRateZ', z], { outcomes: ['total_resid_model'], mech: 'officiating', noisy: crewNote });
  add('Officials', key, `${z > 0 ? 'High' : 'Low'} FT-rate crew (home margin)`, sub, ['crewFtRateZ', z], { scope: 'game', mech: 'officiating', noisy: crewNote });
}

// Exposure (6)
add('Exposure', 'nationaltv', 'National TV game', ['nationalTV', '==', true], ['flag', true], { outcomes: MT, mech: 'attention' });
add('Exposure', 'christmas', 'Christmas Day game', ['christmas', '==', true], ['flag', true], { outcomes: MT, mech: 'attention' });
add('Exposure', 'nbacup', 'NBA Cup game', ['nbaCup', '==', true], ['flag', true], { outcomes: MT, mech: 'motivation' });

// Motivation (13)
for (const t of GRID.revengeMargin) add('Motivation', `revenge${t}`, `Revenge: lost last meeting by ${t}+`, ['prevMarginVsOpp', '<=', -t], ['revengeMargin', t], { mech: 'motivation', narrative: true });
for (const d of GRID.rematchDays) add('Motivation', `rematch${d}`, `Rematch within ${d} days`, ['rematchDays', '<=', d], ['rematchDays', d], { mech: 'motivation' });
add('Motivation', 'race_in', 'In the playoff/play-in race (within 2 games)', ['playoffRace', '==', 'in'], ['playoffRace', 'in'], { mech: 'motivation' });
add('Motivation', 'race_out', 'Eliminated from playoff contention', ['playoffRace', '==', 'eliminated'], ['playoffRace', 'eliminated'], { mech: 'motivation' });
add('Motivation', 'tank', 'Team in tank mode', ['tanking', '==', true], ['flag', true], { mech: 'motivation', dir: 'neg' });
for (const s of GRID.h2hStreak) add('Motivation', `owns${s}`, `"Owns this team": won last ${s}+ meetings`, ['h2hStreak', '>=', s], ['h2hStreak', s], { mech: 'none', narrative: true });
add('Motivation', 'formerteam', 'Player vs former team', ['vsFormerTeam', '==', true], ['flag', true], { outcomes: ['player_pts_resid'], scope: 'player', mech: 'motivation' });
add('Motivation', 'contractyear', 'Player in a contract year', ['contractYear', '==', true], ['flag', true], { outcomes: ['player_pts_resid'], scope: 'player', mech: 'motivation' });
add('Motivation', 'birthday', 'Player birthday game', ['birthday', '==', true], ['flag', true], { outcomes: ['player_pts_resid'], scope: 'player', mech: 'none', narrative: true });

// Style (21)
const threeNote = 'Inputs include opponent 3P%, which is mostly noise over samples this size.';
for (const t of GRID.paceMismatch) {
  add('Style', `pace${t}`, `Team ${t}+ possessions faster than opponent`, ['paceMismatch', '>=', t], ['paceMismatch', t], { mech: 'style' });
  add('Style', `pace${t}`, `Pace mismatch ${t}+ possessions`, ['absPaceMismatch', '>=', t], ['paceMismatch', t], { outcomes: ['total_resid_model'], mech: 'style' });
}
for (const t of GRID.threePaRateMismatch) {
  add('Style', `3par${t}`, `Team 3PA rate ${t}+ pp above opponent`, ['threePaRateMismatch', '>=', t], ['threePaRateMismatch', t], { mech: 'style', noisy: threeNote });
  add('Style', `3par${t}`, `3PA-rate mismatch ${t}+ pp`, ['absThreePaRateMismatch', '>=', t], ['threePaRateMismatch', t], { outcomes: ['total_resid_model'], mech: 'style', noisy: threeNote });
}
for (const t of GRID.rebMismatch) add('Style', `reb${t}`, `Offensive rebounding edge ${t}+ OREB% pts`, ['rebMismatch', '>=', t], ['rebMismatch', t], { mech: 'style' });
for (const t of GRID.foulMismatch) {
  add('Style', `foul${t}`, `Foul-drawing team vs foul-prone opponent (${t}+ FTr pts)`, ['foulMismatch', '>=', t], ['foulMismatch', t], { mech: 'style' });
  add('Style', `foul${t}`, `Foul-rate mismatch ${t}+ FTr pts`, ['absFoulMismatch', '>=', t], ['foulMismatch', t], { outcomes: ['total_resid_model'], mech: 'style' });
}

// Player population (54) — outcome is player points residual vs projection.
const P = { outcomes: ['player_pts_resid'], scope: 'player' };
add('Player', 'home', 'Players at home', ['home', '==', true], ['flag', true], { ...P, mech: 'usage' });
add('Player', 'away', 'Players on the road', ['home', '==', false], ['flag', true], { ...P, mech: 'usage' });
for (const d of GRID.restDays) add('Player', `rest${d}${d === 3 ? 'plus' : ''}`, `Players on ${d === 3 ? '3+' : d} days rest`, d === 3 ? ['restDays', '>=', 3] : ['restDays', '==', d], ['restDays', d], { ...P, mech: 'fatigue' });
add('Player', 'b2b', 'Players on a back-to-back', ['b2b', '==', true], ['flag', true], { ...P, mech: 'fatigue', dir: 'neg' });
for (const t of TEAMS) add('Player', `vs_${t.toLowerCase()}`, `Players vs ${t}`, ['oppAbbr', '==', t], ['opponent', t], { ...P, mech: 'matchup' });
for (const m of GRID.month) add('Player', `month${m}`, `Player games in ${MONTHS[m]}`, ['month', '==', m], ['month', m], { ...P, mech: 'seasonality' });
for (const d of GRID.dow) add('Player', `dow${d}`, `Player games on ${DOWS[d]}`, ['dow', '==', d], ['dow', d], { ...P, mech: 'none' });
for (const b of GRID.playerTip) add('Player', `tip${b[0]}`, `Player games tipping ${b[0]}:00-${b[1]}:00 local`, ['tipHourLocal', 'between', b], ['playerTip', b], { ...P, mech: 'circadian' });

// Market (22)
for (const t of GRID.lineMove) add('Market', `move${t < 0 ? 'm' : 'p'}${String(Math.abs(t)).replace('.', '')}`, t > 0 ? `Line moved ${t}+ toward team` : `Line moved ${-t}+ against team`, ['lineMove', t > 0 ? '>=' : '<=', t], ['lineMove', t], { mech: 'market' });
for (const t of GRID.totalMove) add('Market', `tmove${t < 0 ? 'm' : 'p'}${String(Math.abs(t)).replace('.', '')}`, t > 0 ? `Total moved up ${t}+` : `Total moved down ${-t}+`, ['totalMove', t > 0 ? '>=' : '<=', t], ['totalMove', t], { outcomes: ['total_resid_model'], mech: 'market' });
for (const b of GRID.favSize) add('Market', `fav${b[0]}`, `Favorite by ${b[0]}-${b[1] > 50 ? '+' : b[1]}`, ['favSize', 'between', b], ['favSize', b], { mech: 'market' });
for (const b of GRID.dogSize) add('Market', `dog${Math.floor(b[0])}`, `Underdog by ${b[0] < 1 ? 0 : b[0]}-${b[1] > 50 ? '+' : b[1]}`, ['dogSize', 'between', b], ['dogSize', b], { mech: 'market' });

const seen = new Set();
for (const r of rows) {
  if (seen.has(r.id)) throw new Error(`Duplicate registry id ${r.id}`);
  seen.add(r.id);
}

export const REGISTRY = Object.freeze(rows);

export function registryByFamily(registry = REGISTRY) {
  const out = {};
  for (const f of FAMILIES) out[f] = [];
  for (const r of registry) (out[r.family] ||= []).push(r);
  return out;
}

export function getRow(id) {
  return REGISTRY.find((r) => r.id === id) || null;
}
