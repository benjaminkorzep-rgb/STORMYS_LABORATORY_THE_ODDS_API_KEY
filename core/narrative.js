// core/narrative.js — rules-based narrative from computed fields (docs/contract.md).
// Plain ES module, zero dependencies; runs in Node 20, Deno, Cloudflare Workers and browsers.
//
// Every sentence below is assembled from Snapshot / Game / EngineOutput / Trend fields.
// When a field is missing the text says what is missing and which refresh or test fills it.
// Lines and prices are described as market context only; a model-vs-market gap is a
// "disagreement", never an "edge", and nothing here is betting advice.

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const get = (o, path, dflt = null) => {
  let cur = o;
  for (const k of path.split('.')) {
    if (cur == null) return dflt;
    cur = cur[k];
  }
  return cur == null ? dflt : cur;
};
const arr = (x) => (Array.isArray(x) ? x : []);

/** 0..1 -> "62%" (d decimals). Returns "n/a" for non-numbers. */
export function pct(x, d = 0) {
  return isNum(x) ? `${(x * 100).toFixed(d)}%` : 'n/a';
}
/** Signed number: +3.5 / -3.5 / 0.0 */
export function signed(x, d = 1) {
  if (!isNum(x)) return 'n/a';
  const v = Number(x.toFixed(d));
  if (v === 0) return (0).toFixed(d);
  return `${v > 0 ? '+' : '-'}${Math.abs(v).toFixed(d)}`;
}
/** Plain fixed number. */
export function num(x, d = 1) {
  return isNum(x) ? x.toFixed(d) : 'n/a';
}
/** Signed percentage points from a 0..1 delta: 0.042 -> "+4.2 pts". */
export function ppts(x, d = 1) {
  return isNum(x) ? `${signed(x * 100, d)} pts` : 'n/a';
}

const toDate = (x) => {
  if (x == null) return null;
  const d = x instanceof Date ? x : new Date(x);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Time in ET, e.g. "7:30 PM ET". */
export function etTime(x) {
  const d = toDate(x);
  if (!d) return 'time n/a';
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  return `${s} ET`;
}
/** Date + time in ET, e.g. "Sun Nov 22, 7:30 PM ET". */
export function etDateTime(x) {
  const d = toDate(x);
  if (!d) return 'time n/a';
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
  }).format(d);
  return `${day}, ${etTime(d)}`;
}
const etParts = (d) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute };
};

/** Next official injury-report slot (:00/:15/:30/:45) strictly after `now`. */
export function nextInjurySlot(now) {
  const d = toDate(now) || new Date();
  const q = 15 * 60 * 1000;
  return new Date(Math.floor(d.getTime() / q) * q + q);
}

const ageText = (sec) => {
  if (!isNum(sec)) return null;
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
};

const listJoin = (xs) => {
  const a = xs.filter(Boolean);
  if (a.length <= 1) return a.join('');
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
};

const abbrOf = (t, fallback) => (t && (t.abbr || t.name)) || fallback;
const teamLabel = (game, side) => abbrOf(game && game[side], side === 'home' ? 'home team' : 'away team');
const matchup = (game) => `${teamLabel(game, 'away')} at ${teamLabel(game, 'home')}`;
const lastName = (n) => (typeof n === 'string' && n.trim() ? n.trim().split(/\s+/).slice(-1)[0] : n);

const entropyBits = (probs) => {
  let h = 0;
  for (const p of probs) if (isNum(p) && p > 0) h -= p * Math.log2(p);
  return h;
};

const sideAbbr = (game, team) => {
  if (!team) return '';
  const h = game && game.home, a = game && game.away;
  if (h && (team === h.abbr || team === h.id || team === 'home')) return h.abbr || team;
  if (a && (team === a.abbr || team === a.id || team === 'away')) return a.abbr || team;
  return team;
};

// ---------------------------------------------------------------------------
// Game paragraphs
// ---------------------------------------------------------------------------

function p1Thesis(game, snapshot) {
  const A = game.analysis || null;
  const home = teamLabel(game, 'home');
  const away = teamLabel(game, 'away');
  const s = [];
  if (!A) {
    s.push(`${matchup(game)} (${etDateTime(game.date)}) has no engine output in this snapshot: win probability, margin, total and ratings are all missing.`);
    const sp = get(game, 'odds.spreadHome'), tot = get(game, 'odds.total');
    if (isNum(sp) || isNum(tot)) {
      s.push(`Market context only: ${home} ${signed(sp, 1)} with a total of ${num(tot, 1)}.`);
    } else {
      s.push('No market line is attached either; the next odds refresh fills spread, total and no-vig prices.');
    }
    s.push('The next refresh reruns analyzeGame once team logs and rosters load; until then no thesis is written.');
    return s.join(' ');
  }
  const wp = A.wp || {};
  const conf = A.confidence || {};
  const favHome = isNum(wp.headline) ? wp.headline >= 0.5 : null;
  if (isNum(wp.headline)) {
    const fav = favHome ? home : away;
    const favWp = favHome ? wp.headline : 1 - wp.headline;
    const r = arr(wp.range);
    const rangeTxt = r.length === 2 && isNum(r[0]) && isNum(r[1])
      ? ` (range ${pct(favHome ? r[0] : 1 - r[1])}–${pct(favHome ? r[1] : 1 - r[0])})`
      : ' (no range computed)';
    const gradeTxt = conf.grade ? `, confidence grade ${conf.grade}${isNum(conf.score) ? ` (${num(conf.score, 0)}/100)` : ''}` : ', confidence not graded';
    s.push(`${fav} is the market-anchored pick at ${pct(favWp)} to win${rangeTxt}${gradeTxt}.`);
  } else {
    s.push(`${matchup(game)} has no headline win probability; the market feed or the engine blend did not produce one.`);
  }
  if (isNum(wp.model)) {
    const mk = isNum(wp.market) ? `the no-vig market has ${home} at ${pct(wp.market)}` : 'no no-vig market price was available to compare';
    const lam = isNum(wp.lambda) ? ` with the headline weighting the model at lambda ${num(wp.lambda, 2)}` : '';
    let dis;
    if (wp.disagree) dis = ` Model and market disagree by ${num(wp.disagreeSD, 1)} SD, which is flagged and widens the range; treat it as a reason to check inputs, not a signal.`;
    else if (isNum(wp.disagreeSD)) dis = ` The gap is ${num(wp.disagreeSD, 1)} SD, inside the disagreement threshold.`;
    else dis = '';
    s.push(`The independent model has ${home} at ${pct(wp.model)} while ${mk}${lam}.${dis}`);
  } else {
    s.push('The independent model value is missing, so the headline is market-only until the ratings layer runs.');
  }
  const m = A.margin || {}, t = A.total || {};
  if (isNum(m.mean)) {
    const lead = m.mean >= 0 ? home : away;
    const mq = m.q || {};
    const band = isNum(mq.p10) && isNum(mq.p90) ? ` (10–90: ${signed(mq.p10, 1)} to ${signed(mq.p90, 1)} ${home})` : '';
    const tq = t.q || {};
    const tband = isNum(tq.p10) && isNum(tq.p90) ? ` (10–90: ${num(tq.p10, 0)}–${num(tq.p90, 0)})` : '';
    const pts = A.pts ? `; projected score ${home} ${num(A.pts.home, 1)}, ${away} ${num(A.pts.away, 1)}` : '';
    s.push(`Expected margin is ${lead} by ${num(Math.abs(m.mean), 1)}${band} and the expected total is ${num(t.mean, 1)}${tband}${pts}.`);
  } else {
    s.push('Margin and total distributions are missing from the engine output.');
  }
  const leaguePace = get(snapshot, 'league.pace');
  if (isNum(A.poss)) {
    const vs = isNum(leaguePace) ? `, ${signed(A.poss - leaguePace, 1)} vs the league pace of ${num(leaguePace, 1)}` : '';
    const ot = isNum(A.pOT) ? `; overtime probability ${pct(A.pOT, 1)}` : '';
    s.push(`Pace projects ${num(A.poss, 1)} possessions${vs}${ot}.`);
  }
  const rh = get(A, 'ratings.home'), ra = get(A, 'ratings.away');
  if (rh && ra && isNum(rh.net) && isNum(ra.net)) {
    const gap = rh.net - ra.net;
    const pg = isNum(rh.player) && isNum(ra.player) ? rh.player - ra.player : null;
    const rg = isNum(rh.results) && isNum(ra.results) ? rh.results - ra.results : null;
    let src = '';
    if (isNum(pg) && isNum(rg)) {
      const driver = Math.abs(pg) >= Math.abs(rg) ? 'player layer' : 'results layer';
      const agree = Math.sign(pg) === Math.sign(rg) ? 'the layers agree on direction' : 'the layers point in opposite directions';
      src = ` (player layer ${signed(pg, 1)}, results layer ${signed(rg, 1)}; the ${driver} carries more of it and ${agree})`;
    }
    s.push(`The blended net-rating gap is ${signed(gap, 1)} per 100 for ${home}${src}.`);
  } else {
    s.push('Team ratings are missing, so the rating-gap source cannot be stated.');
  }
  const ctx = arr(A.context).filter((c) => c && c.label);
  const pick = ctx.filter((c) => /hca|home|alt|rest|b2b|travel|tz/i.test(`${c.key} ${c.label}`));
  const use = (pick.length ? pick : ctx).slice(0, 4);
  const ctxTxt = use.map((c) => {
    const val = c.value == null || (isNum(c.value) && isNum(c.effect) && c.value === c.effect) ? '' : ` ${typeof c.value === 'number' ? num(c.value, 1) : c.value}`;
    const eff = isNum(c.effect) ? ` ${signed(c.effect, 1)} pts` : '';
    return `${c.label}${val}${eff}${c.inModel === false ? ' (shown, not in model)' : ''}`;
  });
  const alt = get(game, 'venue.altFt');
  const rest = [];
  for (const side of ['home', 'away']) {
    const tm = game[side];
    if (tm && isNum(tm.restDays)) rest.push(`${abbrOf(tm, side)} ${tm.restDays} rest day${tm.restDays === 1 ? '' : 's'}${tm.b2b ? ' (back-to-back)' : ''}`);
  }
  const tail = [];
  if (game.neutral) tail.push('neutral site, so no home-court term');
  if (isNum(alt) && alt >= 3000 && !ctx.some((c) => /alt/i.test(`${c.key} ${c.label}`))) tail.push(`${get(game, 'venue.name', 'venue')} sits at ${num(alt, 0)} ft`);
  if (rest.length) tail.push(listJoin(rest));
  if (ctxTxt.length || tail.length) {
    s.push(`Context: ${[...ctxTxt, ...tail].join('; ')}.`);
  } else {
    s.push('No home-court, altitude or rest context was computed for this game.');
  }
  return s.join(' ');
}

function p2Injuries(game, snapshot) {
  const A = game.analysis || {};
  const home = teamLabel(game, 'home');
  const panels = arr(A.ifPanels);
  const inj = arr(game.injuries);
  const s = [];
  const outs = inj.filter((i) => /^out$/i.test(i.status || ''));
  if (outs.length) {
    s.push(`${matchup(game)} already rules out ${listJoin(outs.map((i) => `${i.name} (${sideAbbr(game, i.team)})`))}, which is baked into every scenario.`);
  }
  if (!panels.length) {
    const unresolved = inj.filter((i) => /questionable|doubtful|day-to-day|gtd/i.test(i.status || ''));
    if (unresolved.length) {
      s.push(`${unresolved.length} player${unresolved.length === 1 ? ' is' : 's are'} listed ${listJoin(unresolved.map((i) => `${i.name} ${i.status}`))}, but the engine produced no if-plays/if-sits panels; the next refresh with player logs fills those deltas.`);
    } else if (!Array.isArray(game.injuries)) {
      s.push(`The injury feed for ${matchup(game)} is not loaded, so play probabilities and if-plays/if-sits deltas are missing; the next injury-report refresh fills them.`);
    } else {
      s.push(`No Questionable or Doubtful players are listed for ${matchup(game)}${inj.length ? ` (${inj.length} injury entr${inj.length === 1 ? 'y' : 'ies'} total)` : ''}, so the minutes picture is a single branch.`);
    }
  }
  for (const pnl of panels.slice(0, 4)) {
    const tm = sideAbbr(game, pnl.team);
    const mi = isNum(pnl.marketImpliedPlay) ? ` (market-implied ${pct(pnl.marketImpliedPlay)})` : '';
    const d = pnl.delta || {};
    const playsWp = get(pnl, 'plays.wpHome'), sitsWp = get(pnl, 'sits.wpHome');
    const wpTxt = isNum(playsWp) && isNum(sitsWp)
      ? `${home} win probability goes from ${pct(playsWp)} if he plays to ${pct(sitsWp)} if he sits (${ppts(d.wp)})`
      : `win-probability delta ${ppts(d.wp)}`;
    const mates = arr(pnl.teammates).slice().sort((a, b) => (b.dMin || 0) - (a.dMin || 0)).slice(0, 2)
      .map((t) => `${t.name} ${signed(t.dMin, 1)} min${isNum(t.dUsg) ? `, ${signed(t.dUsg, 1)} usage pts` : ''}${isNum(t.dPts) ? `, ${signed(t.dPts, 1)} pts` : ''}`);
    s.push(`${pnl.player} (${tm}) has a ${pct(pnl.pPlay)} play probability${mi}; ${wpTxt}, the spread moves ${signed(d.spread, 1)} and the total ${signed(d.total, 1)}${mates.length ? `, with ${listJoin(mates)} absorbing the minutes if he sits` : ''}.`);
  }
  for (const b of arr(A.bothSit).slice(0, 2)) {
    const names = arr(b.players).map(lastName);
    s.push(`If ${listJoin(names)} both sit (${pct(b.prob, 1)} joint probability) ${home} is at ${pct(b.wpHome)} with a margin of ${signed(b.margin, 1)} and a total of ${num(b.total, 1)}.`);
  }
  const sc = arr(A.scenarios);
  if (sc.length) {
    const h = entropyBits(sc.map((x) => x.prob));
    const top = sc.slice().sort((a, b) => (b.prob || 0) - (a.prob || 0))[0];
    const topTxt = top ? `; the most likely branch (${pct(top.prob)}) is ${arr(top.out).length ? `${listJoin(arr(top.out))} out` : 'everyone available'}` : '';
    s.push(`Across ${sc.length} lineup scenarios the entropy is ${num(h, 2)} bits${topTxt}.`);
  } else if (panels.length) {
    s.push('The scenario tree was not computed, so lineup entropy is unavailable until the next engine run.');
  }
  const now = get(snapshot, 'generatedAt');
  const tip = toDate(game.date);
  const slot = nextInjurySlot(now);
  const tail = [];
  if (panels.length || inj.length) tail.push(`the next official injury report slot is ${etTime(slot)}`);
  if (tip) tail.push(`lineups are typically confirmed around ${etTime(new Date(tip.getTime() - 30 * 60000))} (T-30m before the ${etTime(tip)} tip)`);
  if (tail.length) s.push(`Statuses resolve on the clock: ${tail.join(' and ')}.`);
  return s.join(' ');
}

function propFor(game, p, stat) {
  const direct = get(p, `props.${stat}`);
  if (isNum(direct)) return direct;
  if (direct && isNum(direct.line)) return direct.line;
  for (const pr of arr(game.props)) {
    if ((pr.playerId === p.id || pr.player === p.name || pr.name === p.name) && (pr.market === stat || pr.stat === stat) && isNum(pr.line)) return pr.line;
  }
  return null;
}

function p3Players(game) {
  const A = game.analysis || {};
  const players = arr(A.players).filter((p) => p && p.proj);
  const s = [];
  if (!players.length) {
    return `${matchup(game)} has no player projections in this snapshot; the box-score log refresh (player logs) is required before minutes and stat bands can be shown.`;
  }
  const band = (o, d = 1) => (o && isNum(o.mean) ? `${num(o.mean, d)} [${num(o.p10, 0)}–${num(o.p90, 0)}]` : 'n/a');
  for (const side of ['home', 'away']) {
    const tm = teamLabel(game, side);
    const tp = players.filter((p) => sideAbbr(game, p.team) === tm && (p.pPlay == null || p.pPlay >= 0.5))
      .sort((a, b) => (get(b, 'proj.pts.mean', 0)) - (get(a, 'proj.pts.mean', 0))).slice(0, 2);
    if (!tp.length) { s.push(`No ${tm} players have projections.`); continue; }
    const lines = tp.map((p) => `${p.name} ${band(p.min, 1)} MIN, ${band(get(p, 'proj.pts'))} PTS, ${band(get(p, 'proj.reb'))} REB, ${band(get(p, 'proj.ast'))} AST, ${band(get(p, 'proj.fg3m'))} 3PM`);
    s.push(`Top ${tm} projections (mean [10–90]): ${lines.join('; ')}.`);
  }
  const moves = players.filter((p) => isNum(get(p, 'min.mean')) && isNum(get(p, 'min.base')))
    .map((p) => ({ p, d: p.min.mean - p.min.base }))
    .filter((x) => Math.abs(x.d) >= 1)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 3);
  if (moves.length) {
    s.push(`Biggest minute changes vs baseline: ${listJoin(moves.map(({ p, d }) => `${p.name} ${signed(d, 1)} (${num(p.min.base, 1)} to ${num(p.min.mean, 1)})`))}.`);
  } else {
    s.push(`No ${matchup(game)} player moves 1 or more minutes off baseline.`);
  }
  const caps = [];
  for (const p of players) {
    const fr = get(p, 'min.foulRisk'), rc = get(p, 'min.returnCap'), bo = get(p, 'min.blowoutAdj');
    if (isNum(rc)) caps.push(`${p.name} is capped at ${num(rc, 0)} min returning from ${isNum(p.gamesMissed) ? `${p.gamesMissed} missed games` : 'an absence'}`);
    if (isNum(fr) && fr >= 0.15) caps.push(`${p.name} carries a ${pct(fr)} foul-trouble risk`);
    if (isNum(bo) && Math.abs(bo) >= 1) caps.push(`${p.name} loses ${num(Math.abs(bo), 1)} min to blowout risk`);
  }
  if (caps.length) s.push(`Caps applied: ${caps.slice(0, 4).join('; ')}.`);
  const props = [];
  for (const p of players) {
    for (const stat of ['pts', 'reb', 'ast', 'fg3m', 'pra']) {
      const line = propFor(game, p, stat);
      const proj = get(p, `proj.${stat}.mean`);
      if (isNum(line) && isNum(proj)) props.push({ p, stat, line, proj, gap: proj - line });
    }
  }
  if (props.length) {
    props.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
    s.push(`Prop lines as market context: ${props.slice(0, 3).map((x) => `${x.p.name} ${x.stat.toUpperCase()} line ${num(x.line, 1)} vs projection ${num(x.proj, 1)} (${signed(x.gap, 1)})`).join('; ')}.`);
  } else {
    s.push(`No player prop lines are attached for ${matchup(game)}; a player-markets odds pull would add them as market context.`);
  }
  return s.join(' ');
}

function trendTouches(t, game) {
  if (!t) return false;
  if (arr(t.gameIds).includes(game.id) || t.gameId === game.id) return true;
  const keys = new Set();
  for (const side of ['home', 'away']) {
    const tm = game[side];
    if (tm) for (const k of [tm.abbr, tm.id, tm.name]) if (k != null) keys.add(String(k));
  }
  for (const p of arr(get(game, 'analysis.players'))) { if (p.name) keys.add(p.name); if (p.id != null) keys.add(String(p.id)); }
  const subj = t.subject == null ? [] : (Array.isArray(t.subject) ? t.subject : [t.subject]);
  return subj.some((x) => keys.has(String(x)));
}

const noiseWhy = (t) => {
  const why = [];
  if (isNum(t.n)) why.push(`n=${t.n}`);
  if (isNum(t.rawEffect) && isNum(t.shrunkEffect)) {
    const kept = t.rawEffect !== 0 ? Math.abs(t.shrunkEffect / t.rawEffect) : 0;
    why.push(`raw ${signed(t.rawEffect, 1)} shrinks to ${signed(t.shrunkEffect, 1)} (${pct(kept)} survives)`);
  }
  if (isNum(t.qBH)) why.push(`q=${num(t.qBH, 2)}`);
  if (t.alreadyPriced) why.push(`already priced${isNum(t.residualVsClose) ? ` (residual vs close ${signed(t.residualVsClose, 1)})` : ''}`);
  if (t.stableSeasons) why.push(`stable in ${t.stableSeasons} seasons`);
  return why.join(', ');
};

function p4Trends(game, snapshot) {
  const tr = get(snapshot, 'trends') || {};
  const s = [];
  const val = arr(tr.validated).filter((t) => trendTouches(t, game));
  const noise = [...arr(tr.narrative), ...arr(tr.exploratory)].filter((t) => trendTouches(t, game))
    .sort((a, b) => Math.abs(b.rawEffect || 0) - Math.abs(a.rawEffect || 0));
  if (val.length) {
    s.push(`Validated trends touching ${matchup(game)}: ${val.slice(0, 2).map((t) => `${t.label} (n=${t.n}, q=${num(t.qBH, 3)}, shrunk effect ${signed(t.shrunkEffect, 1)}${arr(t.ci80).length === 2 ? `, 80% CI ${signed(t.ci80[0], 1)} to ${signed(t.ci80[1], 1)}` : ''}${t.alreadyPriced ? ', already priced' : ''})`).join('; ')}.`);
  } else {
    const reg = isNum(tr.registrySize) ? `${tr.registrySize} registered trends` : 'the trend registry';
    s.push(`No validated trend touches ${matchup(game)} out of ${reg}${tr.lastRetest ? ` (last retest ${etDateTime(tr.lastRetest)})` : '; the backfill/backtest that would validate them is pending'}.`);
  }
  if (noise.length) {
    s.push(`Loudest noise to ignore: ${noise.slice(0, 2).map((t) => `"${t.label}" [${t.tier || 'Narrative only'}] — ${noiseWhy(t)}${t.noiseNote ? `; ${t.noiseNote}` : ''}`).join('; ')}.`);
  } else {
    s.push(`No narrative-only or exploratory trend in the registry mentions ${teamLabel(game, 'home')} or ${teamLabel(game, 'away')}.`);
  }
  const off = arr(game.officials);
  const refCtx = arr(get(game, 'analysis.context')).find((c) => /ref|official|crew/i.test(`${c.key} ${c.label}`));
  if (off.length) {
    s.push(`Referee crew posted (${off.length}): ${off.join(', ')}${refCtx && isNum(refCtx.effect) ? `, crew total effect ${signed(refCtx.effect, 1)} pts${refCtx.inModel === false ? ' (shown, not in model)' : ''}` : ''}.`);
  } else {
    s.push(`Referee crew for ${matchup(game)} is not posted; the NBA lists crews around 9:00 AM ET and the first refresh after that fills it.`);
  }
  const age = ageText(game.dataAgeSec);
  const gen = get(snapshot, 'generatedAt');
  const status = get(snapshot, 'source.status');
  s.push(`Data age ${age || 'unknown (dataAgeSec missing)'}${gen ? ` as of the ${etTime(gen)} snapshot` : ''}${status && status !== 'ok' ? `; source status is ${status}` : ''}.`);
  return s.join(' ');
}

function p5Swing(game) {
  const sw = arr(get(game, 'analysis.swing')).slice(0, 3);
  if (!sw.length) return null;
  const home = teamLabel(game, 'home');
  const parts = sw.map((x) => `${x.variable} moves ${home} win probability ${ppts(x.dWp)} and the total ${signed(x.dTotal, 1)}${x.note ? ` (${x.note})` : ''}`);
  return `What changes if: ${parts.join('; ')}.`;
}

/** ≥4 paragraphs for one game, every sentence driven by computed fields. */
export function gameParagraphs(game, snapshot = null) {
  const g = game || {};
  const out = [];
  const safe = (fn, label) => {
    try { return fn(g, snapshot); } catch (e) { return `${label} for ${matchup(g)} could not be written (${e && e.message ? e.message : 'error'}); the next refresh retries.`; }
  };
  out.push(safe(p1Thesis, 'Matchup thesis'));
  out.push(safe(p2Injuries, 'Injury scenarios'));
  out.push(safe(p3Players, 'Player angles'));
  out.push(safe(p4Trends, 'Trends and context'));
  const p5 = (() => { try { return p5Swing(g); } catch { return null; } })();
  if (p5) out.push(p5);
  return out;
}

// ---------------------------------------------------------------------------
// Slate paragraphs
// ---------------------------------------------------------------------------

const gameWp = (g) => get(g, 'analysis.wp.headline');
const gameTotal = (g) => {
  const m = get(g, 'odds.total');
  return isNum(m) ? m : get(g, 'analysis.total.mean');
};
const noVig = (g) => {
  const b = arr(get(g, 'odds.books')).map((x) => x.noVigHome).filter(isNum);
  if (b.length) return b.reduce((a, c) => a + c, 0) / b.length;
  return get(g, 'analysis.wp.market');
};
const parseRecord = (r) => {
  const m = typeof r === 'string' && r.match(/(\d+)\s*-\s*(\d+)/);
  return m ? +m[1] + +m[2] : null;
};

function seasonPhase(slateDate, games) {
  const gp = [];
  for (const g of games) for (const side of ['home', 'away']) { const n = parseRecord(get(g, `${side}.record`)); if (isNum(n)) gp.push(n); }
  const avgGp = gp.length ? gp.reduce((a, c) => a + c, 0) / gp.length : null;
  const m = typeof slateDate === 'string' ? +slateDate.slice(5, 7) : null;
  let phase;
  if (isNum(avgGp)) phase = avgGp < 20 ? 'early regular season' : avgGp < 60 ? 'mid regular season' : avgGp <= 82 ? 'late regular season' : 'postseason';
  else if (m) phase = [10, 11].includes(m) ? 'early regular season' : [12, 1, 2].includes(m) ? 'mid regular season' : [3, 4].includes(m) ? 'late regular season' : [5, 6].includes(m) ? 'postseason' : 'offseason';
  else phase = 'unknown phase';
  return { phase, avgGp };
}

function s1Shape(snap) {
  const games = arr(snap.games);
  const date = snap.slateDate || 'this slate';
  if (!games.length) return `The ${date} slate has 0 games in this snapshot; the scoreboard refresh fills it once the schedule loads.`;
  const s = [];
  const favs = games.map((g) => ({ g, wp: gameWp(g) })).filter((x) => isNum(x.wp))
    .map((x) => ({ ...x, fav: x.wp >= 0.5 ? teamLabel(x.g, 'home') : teamLabel(x.g, 'away'), fwp: Math.max(x.wp, 1 - x.wp) }))
    .sort((a, b) => b.fwp - a.fwp);
  const pre = games.filter((g) => !g.state || g.state === 'pre').length;
  s.push(`The ${date} slate has ${games.length} game${games.length === 1 ? '' : 's'} (${pre} not yet started).`);
  if (favs.length) {
    const hi = favs[0], lo = favs[favs.length - 1];
    const rangeTxt = favs.length === 1 ? `The only market-anchored favorite is ${hi.fav} at ${pct(hi.fwp)}` : `Market-anchored favorites range from ${lo.fav} at ${pct(lo.fwp)} to ${hi.fav} at ${pct(hi.fwp)}`;
    s.push(`${rangeTxt}${favs.length < games.length ? ` (${games.length - favs.length} game${games.length - favs.length === 1 ? '' : 's'} without a headline yet)` : ''}.`);
  } else {
    s.push('No game has a headline win probability yet; the odds and engine refresh fills them.');
  }
  const tots = games.map((g) => ({ g, t: gameTotal(g) })).filter((x) => isNum(x.t)).sort((a, b) => b.t - a.t);
  if (tots.length) {
    const avg = tots.reduce((a, c) => a + c.t, 0) / tots.length;
    if (tots.length === 1) s.push(`The only total is ${num(tots[0].t, 1)} (${matchup(tots[0].g)}).`);
    else s.push(`Totals average ${num(avg, 1)}, highest ${num(tots[0].t, 1)} (${matchup(tots[0].g)}) and lowest ${num(tots[tots.length - 1].t, 1)} (${matchup(tots[tots.length - 1].g)}).`);
  } else {
    s.push('No totals are available yet.');
  }
  const poss = games.map((g) => get(g, 'analysis.poss')).filter(isNum);
  const lp = get(snap, 'league.pace') ?? get(snap, 'method.leaguePace');
  const lo = get(snap, 'league.ortg') ?? get(snap, 'method.leagueOrtg');
  if (poss.length) {
    const ap = poss.reduce((a, c) => a + c, 0) / poss.length;
    s.push(`Projected pace averages ${num(ap, 1)} possessions${isNum(lp) ? ` against a league pace of ${num(lp, 1)} (${signed(ap - lp, 1)})` : ''}.`);
  }
  const { phase, avgGp } = seasonPhase(snap.slateDate, games);
  s.push(`League scoring environment: ${isNum(lo) ? `${num(lo, 1)} points per 100` : 'offensive rating missing'}${isNum(lp) ? ` at ${num(lp, 1)} pace` : ''}, ${phase}${isNum(avgGp) ? ` (teams average ${num(avgGp, 1)} games played)` : ''}.`);
  return s.join(' ');
}

function s2Uncertainty(snap) {
  const games = arr(snap.games);
  const rows = [];
  for (const g of games) {
    for (const p of arr(get(g, 'analysis.ifPanels'))) {
      if (!isNum(p.pPlay)) continue;
      const dwp = Math.abs(get(p, 'delta.wp', 0) || 0);
      rows.push({ g, p, lev: dwp * p.pPlay * (1 - p.pPlay), dwp });
    }
  }
  const qCount = games.reduce((a, g) => a + arr(g.injuries).filter((i) => /questionable|doubtful|day-to-day/i.test(i.status || '')).length, 0);
  const outCount = games.reduce((a, g) => a + arr(g.injuries).filter((i) => /^out$/i.test(i.status || '')).length, 0);
  if (!rows.length) {
    return `Lineup uncertainty across ${games.length} games: ${qCount} Questionable/Doubtful and ${outCount} Out listings, but no if-plays/if-sits panels were computed; the player-log refresh fills leverage rankings.`;
  }
  rows.sort((a, b) => b.lev - a.lev);
  const top = rows.slice(0, 4).map(({ g, p, lev, dwp }) => `${p.player} (${sideAbbr(g, p.team)}, ${matchup(g)}): ${pct(p.pPlay)} to play, ${num(dwp * 100, 1)}-pt win-probability swing, leverage ${num(lev * 100, 2)}`);
  return `Ranked by leverage (|win-probability delta| × p(1-p)), the lineup questions that matter most are ${top.join('; ')}. Slate-wide there are ${qCount} Questionable/Doubtful and ${outCount} Out listings across ${games.length} game${games.length === 1 ? '' : 's'}.`;
}

function s3Moves(snap, prev) {
  if (!prev || !arr(prev.games).length) {
    const ch = arr(snap.changes);
    return `This is the first snapshot of the ${snap.slateDate ? `${snap.slateDate} slate` : 'day'}${snap.generatedAt ? ` (${etTime(snap.generatedAt)})` : ''}, so there is no prior refresh to diff against${ch.length ? `; ${ch.length} change log entr${ch.length === 1 ? 'y was' : 'ies were'} recorded during the build` : ''}. Line, status and projection moves will be listed from the next refresh on.`;
  }
  const prevById = new Map(arr(prev.games).map((g) => [g.id, g]));
  const moves = [];
  for (const g of arr(snap.games)) {
    const pg = prevById.get(g.id);
    if (!pg) { moves.push({ w: 99, t: `${matchup(g)} is new to the slate` }); continue; }
    const items = [];
    let w = 0;
    const sp0 = get(pg, 'odds.spreadHome'), sp1 = get(g, 'odds.spreadHome');
    if (isNum(sp0) && isNum(sp1) && sp0 !== sp1) { items.push(`spread ${signed(sp0, 1)} to ${signed(sp1, 1)}`); w += Math.abs(sp1 - sp0); }
    const t0 = get(pg, 'odds.total'), t1 = get(g, 'odds.total');
    if (isNum(t0) && isNum(t1) && t0 !== t1) { items.push(`total ${num(t0, 1)} to ${num(t1, 1)}`); w += Math.abs(t1 - t0) / 2; }
    const nv0 = noVig(pg), nv1 = noVig(g);
    if (isNum(nv0) && isNum(nv1) && Math.abs(nv1 - nv0) >= 0.005) { items.push(`no-vig ${teamLabel(g, 'home')} ${pct(nv0)} to ${pct(nv1)}`); w += Math.abs(nv1 - nv0) * 20; }
    const st0 = new Map(arr(pg.injuries).map((i) => [i.name, i.status]));
    for (const i of arr(g.injuries)) {
      const was = st0.get(i.name);
      if (was !== i.status) { items.push(`${i.name} ${was || 'unlisted'} to ${i.status}`); w += 2; }
    }
    const wp0 = gameWp(pg), wp1 = gameWp(g);
    if (isNum(wp0) && isNum(wp1) && Math.abs(wp1 - wp0) >= 0.01) items.push(`${teamLabel(g, 'home')} win probability ${pct(wp0)} to ${pct(wp1)}`);
    const pp0 = new Map(arr(get(pg, 'analysis.players')).map((p) => [p.id ?? p.name, get(p, 'proj.pts.mean')]));
    const pm = arr(get(g, 'analysis.players')).map((p) => ({ p, d: (get(p, 'proj.pts.mean') ?? NaN) - (pp0.get(p.id ?? p.name) ?? NaN) }))
      .filter((x) => isNum(x.d) && Math.abs(x.d) >= 1.5).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
    if (pm) items.push(`${pm.p.name} projection ${signed(pm.d, 1)} pts`);
    const why = arr(snap.changes).filter((c) => c.gameId === g.id && c.why).map((c) => c.why);
    if (items.length) moves.push({ w, t: `${matchup(g)}: ${items.join(', ')}${why.length ? ` (why: ${[...new Set(why)].slice(0, 2).join('; ')})` : ''}` });
  }
  const since = prev.generatedAt ? ` since the ${etTime(prev.generatedAt)} refresh` : ' since the last refresh';
  if (!moves.length) return `Nothing material moved${since}: spreads, totals, no-vig prices, statuses and projections for all ${arr(snap.games).length} games are unchanged.`;
  moves.sort((a, b) => b.w - a.w);
  return `What moved${since}: ${moves.slice(0, 4).map((m) => m.t).join('; ')}.${moves.length > 4 ? ` ${moves.length - 4} more game${moves.length - 4 === 1 ? '' : 's'} had smaller moves.` : ''}`;
}

function s4Trends(snap) {
  const tr = snap.trends || {};
  const val = arr(tr.validated).slice().sort((a, b) => (a.qBH ?? 1) - (b.qBH ?? 1));
  const noise = [...arr(tr.narrative), ...arr(tr.exploratory)].sort((a, b) => Math.abs(b.rawEffect || 0) - Math.abs(a.rawEffect || 0));
  const reg = isNum(tr.registrySize) ? tr.registrySize : null;
  if (!val.length && !noise.length) {
    return `The trend registry holds ${reg ?? 0} candidate trends but none are validated or scored yet; the historical backfill and backtest are pending, so no trend is used in today's numbers.`;
  }
  const s = [];
  if (val.length) {
    s.push(`Strongest validated trends: ${val.slice(0, 3).map((t) => `${t.label} (${t.subject || t.scope}, n=${t.n}, q=${num(t.qBH, 3)}, shrunk ${signed(t.shrunkEffect, 1)}${t.alreadyPriced ? ', already priced' : ''})`).join('; ')}.`);
  } else {
    s.push(`No trend clears validation out of ${reg ?? 'the'} registered${tr.lastRetest ? ` as of the ${etDateTime(tr.lastRetest)} retest` : '; the backtest is pending'}.`);
  }
  if (noise.length) {
    s.push(`Loudest noise to ignore: ${noise.slice(0, 3).map((t) => `"${t.label}" — ${noiseWhy(t)}`).join('; ')}.`);
  }
  if (isNum(reg)) s.push(`${val.length} of ${reg} registered trends are validated.`);
  return s.join(' ');
}

function s5Watch(snap) {
  const now = toDate(snap.generatedAt) || new Date();
  const games = arr(snap.games).filter((g) => !g.state || g.state === 'pre');
  const s = [];
  s.push(`Next official injury report slot: ${etTime(nextInjurySlot(now))}.`);
  const tips = games.map((g) => ({ g, tip: toDate(g.date) })).filter((x) => x.tip).sort((a, b) => a.tip - b.tip);
  if (tips.length) {
    s.push(`Lineup confirmations (about T-30m): ${tips.slice(0, 6).map(({ g, tip }) => `${matchup(g)} ~${etTime(new Date(tip.getTime() - 30 * 60000))}`).join('; ')}${tips.length > 6 ? `; plus ${tips.length - 6} more` : ''}.`);
  } else {
    s.push('No pre-game tip times are on the board, so no lineup confirmations are pending.');
  }
  const { h } = etParts(now);
  const withRefs = arr(snap.games).filter((g) => arr(g.officials).length).length;
  if (h < 9) s.push(`Referee crews post around 9:00 AM ET; ${withRefs} of ${arr(snap.games).length} game${arr(snap.games).length === 1 ? '' : 's'} have crews so far.`);
  else s.push(`Referee crews were due around 9:00 AM ET; ${withRefs} of ${arr(snap.games).length} game${arr(snap.games).length === 1 ? '' : 's'} have them in this snapshot${withRefs < arr(snap.games).length ? ', the rest fill on the next refresh' : ''}.`);
  s.push(`Next refresh: ${etTime(new Date(now.getTime() + 20 * 60000))} (+20 min).`);
  return s.join(' ');
}

/** Exactly 5 slate paragraphs. */
export function slateParagraphs(snapshot, prevSnapshot = null) {
  const snap = snapshot || {};
  const fns = [s1Shape, s2Uncertainty, (x) => s3Moves(x, prevSnapshot), s4Trends, s5Watch];
  const labels = ['Slate shape', 'Lineup uncertainty', 'Refresh diff', 'Trends', 'Watch list'];
  return fns.map((fn, i) => {
    try { return fn(snap); } catch (e) { return `${labels[i]} for ${snap.slateDate || 'this slate'} could not be written (${e && e.message ? e.message : 'error'}); the next refresh retries.`; }
  });
}

// ---------------------------------------------------------------------------
// Reasoning log
// ---------------------------------------------------------------------------

/** One-line log of what changed between two versions of a game, or null. */
export function reasoningEntry(prevGame, game) {
  if (!prevGame || !game) return null;
  try {
    const home = teamLabel(game, 'home');
    const what = [];
    const why = [];
    const wp0 = gameWp(prevGame), wp1 = gameWp(game);
    if (isNum(wp0) && isNum(wp1) && Math.abs(wp1 - wp0) >= 0.005) what.push(`${home} WP ${pct(wp0)} to ${pct(wp1)} (${ppts(wp1 - wp0)})`);
    const m0 = get(prevGame, 'analysis.margin.mean'), m1 = get(game, 'analysis.margin.mean');
    if (isNum(m0) && isNum(m1) && Math.abs(m1 - m0) >= 0.3) what.push(`margin ${signed(m0, 1)} to ${signed(m1, 1)}`);
    const t0 = get(prevGame, 'analysis.total.mean'), t1 = get(game, 'analysis.total.mean');
    if (isNum(t0) && isNum(t1) && Math.abs(t1 - t0) >= 0.5) what.push(`total ${num(t0, 1)} to ${num(t1, 1)}`);
    const st0 = new Map(arr(prevGame.injuries).map((i) => [i.name, i.status]));
    for (const i of arr(game.injuries)) {
      const was = st0.get(i.name);
      if (was !== i.status) why.push(`${i.name} ${was || 'unlisted'} to ${i.status}`);
    }
    const pp0 = new Map(arr(get(prevGame, 'analysis.ifPanels')).map((p) => [p.player, p.pPlay]));
    for (const p of arr(get(game, 'analysis.ifPanels'))) {
      const was = pp0.get(p.player);
      if (isNum(was) && isNum(p.pPlay) && Math.abs(p.pPlay - was) >= 0.05) why.push(`${p.player} play probability ${pct(was)} to ${pct(p.pPlay)}`);
    }
    const sp0 = get(prevGame, 'odds.spreadHome'), sp1 = get(game, 'odds.spreadHome');
    if (isNum(sp0) && isNum(sp1) && sp0 !== sp1) why.push(`market spread ${signed(sp0, 1)} to ${signed(sp1, 1)}`);
    const o0 = get(prevGame, 'odds.total'), o1 = get(game, 'odds.total');
    if (isNum(o0) && isNum(o1) && o0 !== o1) why.push(`market total ${num(o0, 1)} to ${num(o1, 1)}`);
    const of0 = arr(prevGame.officials).length, of1 = arr(game.officials).length;
    if (of0 === 0 && of1 > 0) why.push(`referee crew posted (${of1})`);
    if (!what.length && !why.length) return null;
    const at = etTime(game.generatedAt || get(game, 'analysis.at') || Date.now());
    return `${at} ${matchup(game)}: ${what.length ? what.join(', ') : 'numbers unchanged'}${why.length ? ` because ${why.join('; ')}` : ' with no input change logged (model recalculation)'}.`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LLM polish wrapper
// ---------------------------------------------------------------------------

const NUM_RE = /\d+(?:[.:]\d+)*/g;
const BANNED_RE = /\b(edge|lock|bet (on|the)|take the|hammer|smash|value play|best bet)\b/i;

/** Every numeric token in `src` must survive in `out`. */
export function numbersPreserved(src, out) {
  const need = String(src).match(NUM_RE) || [];
  if (!need.length) return true;
  const have = new Map();
  for (const t of String(out).match(NUM_RE) || []) have.set(t, (have.get(t) || 0) + 1);
  const want = new Map();
  for (const t of need) want.set(t, (want.get(t) || 0) + 1);
  for (const [t, c] of want) if ((have.get(t) || 0) < c) return false;
  return true;
}

export function polishPrompt(text) {
  return [
    'Rewrite the following basketball pre-game notes for a fantasy-lineup decision maker.',
    'Rules: keep every number exactly as written (same digits, same decimals); do not add numbers;',
    'plain, specific, no hype; never call a model-market gap an "edge"; no betting advice;',
    'lines are market context only; keep the same facts and order. Return only the rewritten text.',
    '',
    text,
  ].join('\n');
}

/** Optional LLM polish. Never throws; falls back to the rules text. */
export async function polish(text, opts = {}) {
  const rules = typeof text === 'string' ? text : Array.isArray(text) ? text.join('\n\n') : String(text ?? '');
  const { provider = 'llm', call } = opts || {};
  if (typeof call !== 'function' || !rules.trim()) return { text: rules, source: 'rules' };
  try {
    const out = await call(polishPrompt(rules));
    const s = typeof out === 'string' ? out.trim() : (out && typeof out.text === 'string' ? out.text.trim() : '');
    if (s && numbersPreserved(rules, s) && !BANNED_RE.test(s)) return { text: s, source: provider };
  } catch { /* fall through */ }
  return { text: rules, source: 'rules' };
}

// ---------------------------------------------------------------------------
// State hash (cache key for polish)
// ---------------------------------------------------------------------------

const r = (x, d = 3) => (isNum(x) ? Number(x.toFixed(d)) : x ?? null);

/** Short hash of the fields that drive the narrative text. */
export function stateHash(game) {
  const g = game || {};
  const A = g.analysis || {};
  const key = {
    id: g.id ?? null, state: g.state ?? null, date: g.date ?? null,
    h: get(g, 'home.abbr'), a: get(g, 'away.abbr'),
    wp: [r(get(A, 'wp.headline')), r(get(A, 'wp.model')), r(get(A, 'wp.market')), !!get(A, 'wp.disagree')],
    m: [r(get(A, 'margin.mean'), 1), r(get(A, 'total.mean'), 1), r(A.poss, 1)],
    c: get(A, 'confidence.grade'),
    o: [get(g, 'odds.spreadHome'), get(g, 'odds.total')],
    inj: arr(g.injuries).map((i) => `${i.name}:${i.status}`).sort(),
    ip: arr(A.ifPanels).map((p) => [p.player, r(p.pPlay, 2), r(get(p, 'delta.wp'), 3)]),
    pl: arr(A.players).map((p) => [p.name, r(get(p, 'min.mean'), 1), r(get(p, 'proj.pts.mean'), 1)]),
    of: arr(g.officials),
    sw: arr(A.swing).map((x) => x.variable),
  };
  const s = JSON.stringify(key);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export default { gameParagraphs, slateParagraphs, reasoningEntry, polish, stateHash, pct, signed, num, etTime, etDateTime, nextInjurySlot };
