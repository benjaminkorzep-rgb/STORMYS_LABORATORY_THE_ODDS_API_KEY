// Writer B daily job: rosters, depth charts, schedules and player game logs for every team on today's and tomorrow's slate.
// Output: site/data/daily.json (consumed by every snapshot writer as the engine's player inputs).
// Rate-limited to ~4 req/s (ESPN community guidance ≤5 req/s). Run: node scripts/build-daily.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { espnScoreboard, espnRoster, espnSchedule, espnGamelog, espnDepthChart } from '../core/adapters/espn.js';
import { slateDateET, shiftDate, parseGamelog } from '../core/normalize.js';

const SEASON = Number(process.env.SEASON || 2027);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0; const f = async (...a) => { const w = 250 - (Date.now() - last); if (w > 0) await sleep(w); last = Date.now(); return fetch(...a); };
const log = [];
const note = (name, r) => { log.push({ name, status: r.status, ok: r.ok, ms: r.ms, bytes: r.bytes, host: r.host }); return r; };

const today = slateDateET(new Date());
const teams = new Map();
for (const d of [today, shiftDate(today, 1)]) {
  const sb = note(`scoreboard ${d}`, await espnScoreboard(f, { date: d }));
  for (const ev of sb.data?.events || []) for (const c of ev.competitions?.[0]?.competitors || []) teams.set(c.team.abbreviation.toUpperCase(), { id: c.team.id, abbr: c.team.abbreviation.toUpperCase() });
}
const out = { date: today, generatedAt: new Date().toISOString(), season: SEASON, teams: {}, calls: log };
for (const t of teams.values()) {
  const ro = note(`roster ${t.abbr}`, await espnRoster(f, { team: t.abbr.toLowerCase() }));
  const sc = note(`schedule ${t.abbr}`, await espnSchedule(f, { team: t.abbr.toLowerCase(), season: SEASON }));
  const dc = note(`depth ${t.abbr}`, await espnDepthChart(f, { teamId: t.id, season: SEASON }));
  const starters = new Set();
  for (const item of dc.data?.items || []) for (const pos of Object.values(item.positions || {})) {
    const first = (pos.athletes || []).find(a => a.rank === 1) || (pos.athletes || [])[0];
    const id = String(first?.athlete?.$ref || '').match(/athletes\/(\d+)/)?.[1]; if (id) starters.add(id);
  }
  const schedule = (sc.data?.events || []).filter(e => e.competitions?.[0]?.status?.type?.completed).map(e => {
    const comp = e.competitions[0]; const home = comp.competitors.find(c => c.homeAway === 'home'); const me = comp.competitors.find(c => c.team?.abbreviation?.toUpperCase() === t.abbr);
    const opp = comp.competitors.find(c => c !== me);
    return { date: e.date.slice(0, 10), venueTeam: home?.team?.abbreviation?.toUpperCase(), home: me?.homeAway === 'home', oppAbbr: opp?.team?.abbreviation?.toUpperCase(), pts: Number(me?.score?.value ?? me?.score?.displayValue ?? me?.score), opp: Number(opp?.score?.value ?? opp?.score?.displayValue ?? opp?.score) };
  });
  const played = schedule.filter(g => isFinite(g.pts) && isFinite(g.opp));
  const athletes = (ro.data?.athletes || []).flatMap(a => (a.items ? a.items : [a]));
  const players = [];
  for (const a of athletes) {
    const gl = note(`gamelog ${a.id}`, await espnGamelog(f, { athleteId: a.id, season: SEASON }));
    const rows = parseGamelog(gl.data, t.abbr);
    players.push({ id: String(a.id), name: a.displayName || a.fullName, pos: a.position?.abbreviation || '', starter: starters.has(String(a.id)), jersey: a.jersey || null, age: a.age ?? null, log: rows.slice(0, 40) });
  }
  out.teams[t.abbr] = { id: t.id, abbr: t.abbr, players, schedule,
    ppg: played.length ? played.reduce((s, g) => s + g.pts, 0) / played.length : null, oppg: played.length ? played.reduce((s, g) => s + g.opp, 0) / played.length : null };
  console.log(`${t.abbr}: ${players.length} players, ${played.length} games, starters ${starters.size}`);
}
await mkdir('site/data', { recursive: true });
await writeFile('site/data/daily.json', JSON.stringify(out));
const okCount = log.filter(c => c.ok).length;
console.log(`daily.json written: ${Object.keys(out.teams).length} teams, ${okCount}/${log.length} calls ok`);
