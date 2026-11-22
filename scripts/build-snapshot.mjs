// Writer B (GitHub Actions, cron 7,27,47): full engine snapshot → site/data/latest.json (+ dated copy, history log).
// Carries state forward from the newest published snapshot (Pages, Worker, Supabase) so line history survives
// artifact-only Pages deploys. Run: node scripts/build-snapshot.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { buildSnapshot } from '../core/snapshot.js';

const SOURCES = (process.env.SNAPSHOT_SOURCES || [
  'https://nba-matchup.nbalab.workers.dev/api/snapshot.json',
  'https://benjaminkorzep-rgb.github.io/STORMYS_LABORATORY_THE_ODDS_API_KEY/data/latest.json',
  'https://doojcjhztpxacnuyqitm.supabase.co/storage/v1/object/public/snapshots/latest.json',
].join(',')).split(',');
const getJSON = async url => { try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return r.ok ? await r.json() : null; } catch { return null; } };
const readLocal = async p => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };

const prevs = (await Promise.all(SOURCES.map(getJSON))).filter(s => s && s.schemaVersion === 2);
const prev = prevs.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))[0] || null;
const daily = (await readLocal('site/data/daily.json')) || (await getJSON(SOURCES[1].replace('latest.json', 'daily.json')));
const trends = (await readLocal('site/data/trends.json')) || (await getJSON(SOURCES[1].replace('latest.json', 'trends.json')));

const t0 = Date.now();
const snap = await buildSnapshot({ writer: 'actions', prev, daily, trends: trends?.validated ? trends : null, maxSummaries: 10 });
snap.source.buildMs = Date.now() - t0;
await mkdir('site/data/history', { recursive: true });
await writeFile('site/data/latest.json', JSON.stringify(snap));
await writeFile(`site/data/${snap.slateDate}.json`, JSON.stringify(snap));
// rolling run log (generatedAt of this and recent writer runs, used for the D2 cadence proof on the Health tab)
const runs = ((await readLocal('site/data/runs.json')) || (await getJSON(SOURCES[1].replace('latest.json', 'runs.json'))) || []).concat([{ writer: 'actions', generatedAt: snap.generatedAt, status: snap.source.status, games: snap.games.length, buildMs: snap.source.buildMs }]).slice(-500);
await writeFile('site/data/runs.json', JSON.stringify(runs));
console.log(JSON.stringify({ generatedAt: snap.generatedAt, slate: snap.slateDate, games: snap.games.length, status: snap.source.status, calls: snap.source.calls.map(c => `${c.name}:${c.status}`), buildMs: snap.source.buildMs, engineErrors: snap.games.filter(g => g.engineError).map(g => g.engineError) }, null, 1));
