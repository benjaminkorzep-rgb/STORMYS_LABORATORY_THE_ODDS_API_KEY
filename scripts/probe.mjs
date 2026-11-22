// Day-1 tests T1/T2/T4: reachability of ESPN hosts and cdn.nba.com / stats.nba.com js/data from this egress.
import { CHROME_HEADERS, UA_IPHONE } from '../core/adapters/http.js';
const urls = [
  ['espn site.api scoreboard', 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard', { 'User-Agent': UA_IPHONE }],
  ['espn site.web.api scoreboard', 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard', { 'User-Agent': UA_IPHONE }],
  ['espn cdn scoreboard', 'https://cdn.espn.com/core/nba/scoreboard?xhr=1', { 'User-Agent': UA_IPHONE }],
  ['espn injuries', 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries', { 'User-Agent': UA_IPHONE }],
  ['cdn.nba.com todaysScoreboard (chrome)', 'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json', CHROME_HEADERS],
  ['cdn.nba.com odds (chrome)', 'https://cdn.nba.com/static/json/liveData/odds/odds_todaysGames.json', CHROME_HEADERS],
  ['stats.nba.com daily lineups (chrome)', `https://stats.nba.com/js/data/leaders/00_daily_lineups_${new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')}.json`, CHROME_HEADERS],
  ['official injury report index', 'https://official.nba.com/nba-injury-report-2026-27-season/', { 'User-Agent': CHROME_HEADERS['User-Agent'] }],
  ['actionnetwork scoreboard', 'https://api.actionnetwork.com/web/v2/scoreboard/nba?bookIds=15,30,68,69&periods=event', { 'User-Agent': UA_IPHONE }],
];
console.log(`probe at ${new Date().toISOString()} from ${process.env.GITHUB_ACTIONS ? 'GitHub Actions runner' : 'local'}`);
for (const [name, url, headers] of urls) {
  const t = Date.now();
  try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(12000) }); const b = await r.arrayBuffer(); console.log(`${r.status}\t${b.byteLength}B\t${Date.now() - t}ms\t${name}`); }
  catch (e) { console.log(`ERR\t-\t${Date.now() - t}ms\t${name}\t${e.message}`); }
}
