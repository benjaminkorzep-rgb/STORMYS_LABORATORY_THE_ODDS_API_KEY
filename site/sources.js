// Snapshot writers, raced in parallel by app.js (newest generatedAt wins). Relative URLs work both on
// GitHub Pages (served at a subpath) and on the Cloudflare Worker (served at root).
export const WORKER_PLACEHOLDER = 'https://nba-matchup.<subdomain>.workers.dev/api/snapshot.json';

export const SNAPSHOT_URLS = [
  './api/snapshot.json',                                                                          // Worker (same origin)
  './data/latest.json',                                                                           // Pages (same origin)
  'https://doojcjhztpxacnuyqitm.supabase.co/storage/v1/object/public/snapshots/latest.json',      // Supabase Storage
  'https://benjaminkorzep-rgb.github.io/STORMYS_LABORATORY_THE_ODDS_API_KEY/data/latest.json',     // Pages (absolute)
  'https://raw.githubusercontent.com/benjaminkorzep-rgb/STORMYS_LABORATORY_THE_ODDS_API_KEY/snapshot-data/latest.json',   // Actions (data branch)
  WORKER_PLACEHOLDER,                                                                             // Worker (absolute, from config.json)
];

// Which writer a URL belongs to, for the data-source badge and the Health tab.
export function labelFor(url) {
  if (/fixture-snapshot/.test(url)) return 'Fixture';
  if (/\/api\/snapshot\.json/.test(url)) return 'Worker';
  if (/supabase\.co/.test(url)) return 'Supabase';
  if (/raw\.githubusercontent/.test(url)) return 'Actions';
  if (/latest\.json/.test(url)) return 'Pages';
  return 'Snapshot';
}

// Resolve the placeholder from config.json {workerUrl, pagesUrl, supabaseUrl}; drop anything unresolved; dedupe.
export function resolveSources(config = {}) {
  const w = (config.workerUrl || '').replace(/\/+$/, '');
  const list = SNAPSHOT_URLS.map(u => (u === WORKER_PLACEHOLDER ? (w && !w.includes('<') ? `${w}/api/snapshot.json` : null) : u));
  if (config.pagesUrl) list.push(config.pagesUrl);
  if (config.supabaseUrl) list.push(config.supabaseUrl);
  const seen = new Set();
  return list.filter(u => u && !u.includes('<') && !seen.has(u) && seen.add(u)).map(url => ({ url, label: labelFor(url) }));
}
