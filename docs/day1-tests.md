# Day-1 tests T1–T9 (raw results)

Run 2026-11-22. Raw values pasted as returned.

## T1: does ESPN block Cloudflare egress?
Worker `probe()` runs hourly from cron and writes KV `probe` (served at `/api/probe`). Raw KV value:
```json
{
 "at": "2026-11-22T22:00:47.525Z",
 "colo": null,
 "results": [
  {
   "name": "espn site.api scoreboard",
   "url": "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
   "status": 200,
   "bytes": 134022,
   "ms": 45,
   "cfRay": "a5eb35811c378e3f-AMS",
   "server": "cloudflare"
  },
  {
   "name": "espn site.web.api scoreboard",
   "url": "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
   "status": 403,
   "bytes": 118,
   "ms": 353,
   "cfRay": "a5eb35816c5c8e3f-AMS",
   "server": "cloudflare"
  },
  {
   "name": "espn cdn scoreboard",
   "url": "https://cdn.espn.com/core/nba/scoreboard?xhr=1",
   "status": 200,
   "bytes": 302738,
   "ms": 51,
   "cfRay": "a5eb3583adb58e3f-AMS",
   "server": "cloudflare"
  },
  {
   "name": "espn site.api summary",
   "url": "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401910029",
   "status": 200,
   "bytes": 316914,
   "ms": 63,
   "cfRay": "a5eb3583fdf98e3f-AMS",
   "server": "cloudflare"
  },
  {
   "name": "cdn.nba.com todaysScoreboard",
   "url": "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json",
   "status": 403,
   "bytes": 445,
   "ms": 32,
   "cfRay": "a5eb35846e2d8e3f-AMS",
   "server": "cloudflare"
  }
 ]
}
```
**Result:** `site.api.espn.com` 200 (scoreboard + summary) and `cdn.espn.com` 200; `site.web.api.espn.com` **403**. Architecture change made: the Worker reads site.api first (`core/adapters/espn.js` siteV2 order), so site.web.api is only a fallback. ESPN is not fully blocked, so the Worker stays a data writer.

## T2: does ESPN block GitHub Actions egress?
`scripts/probe.mjs` in run https://github.com/benjaminkorzep-rgb/STORMYS_LABORATORY_THE_ODDS_API_KEY/actions/runs/45073065466 (also published at `snapshot-data/probe-actions.txt`):
```
probe at 2026-11-22T21:36:44.973Z from GitHub Actions runner
200	127600B	126ms	espn site.api scoreboard
200	127600B	203ms	espn site.web.api scoreboard
200	302633B	89ms	espn cdn scoreboard
200	1193998B	32ms	espn injuries
200	21928B	159ms	cdn.nba.com todaysScoreboard (chrome)
200	78369B	79ms	cdn.nba.com odds (chrome)
200	21762B	128ms	stats.nba.com daily lineups (chrome)
200	232484B	325ms	official injury report index
200	144514B	434ms	actionnetwork scoreboard
```
The daily build in run 45044478520 logged `daily.json written: 30 teams, 620/620 calls ok`. **Result: not blocked.**

## T3: can the Cloudflare Developer Platform connector deploy Worker code?
Its tool list has KV/R2/D1 create and `workers_get_worker`/`workers_get_worker_code`, but no upload tool. **Result: no.** Instead I deployed with `wrangler@4 deploy` from the build machine using the API token saved as a proxy credential. Wrangler's static-assets upload returned `401 Unauthorized` through the proxy (`POST /accounts/.../workers/assets/upload`), so the PWA is embedded in the Worker bundle (`scripts/gen-static.mjs` → `worker/src/static.js`). Separately, KV created through the connector landed in a different account than the token's, so KV `SNAP` was created through the API. R2 returned code 10042 ("enable R2 through the Dashboard"), so `HIST` is not bound.

## T4: does cdn.nba.com answer from Cloudflare and GitHub?
From Cloudflare (T1 probe): `cdn.nba.com todaysScoreboard` **403**. From GitHub Actions (T2 probe): **200** for todaysScoreboard, odds and stats.nba.com daily lineups, with Chrome headers. **Change made:** cdn.nba.com and stats.nba.com are used only in Writer B.

## T5: is 10 ms CPU enough?
Cloudflare GraphQL `workersInvocationsAdaptive` for script `nba-matchup`, cpuTime in µs:
```
16:00Z  requests 5  errors 0  cpuP50 1504  cpuP99/max 213662  (first run: full team-level build)
17:00Z  requests 6  errors 0  cpuP50 5370  cpuP99/max 27738
18:00Z  requests 6  errors 0  cpuP50 5376  cpuP99/max 58751
19:00Z  requests 6  errors 0  cpuP50 4559  cpuP99/max 58502
```
**Result:** the snapshot run exceeds 10 ms. The max was 214 ms on the first full build and 28–59 ms on light refreshes; the median is under 10 ms (the push cron and HTTP requests). Cloudflare reported usage model `standard` and **0 errors** across every run, so all of today's cron runs completed (see `runs` below). Already split: snapshot on `*/20`, push on `5-59/20`, and the heavy engine runs in Writer B. This is not a pass against a strict 10 ms budget.

## T6: injury PDF cadence
official.nba.com injury-report page, scraped 2026-11-22 ~16:40 ET: 75 PDFs named `Injury-Report_2026-11-22_12_00AM.pdf` … `Injury-Report_2026-11-22_04_30PM.pdf`, every :00/:15/:30/:45. **Actual interval: 15 minutes.**

## T7: keyed APIs
The Odds API: `GET https://api.the-odds-api.com/v4/sports/` (key injected by the session proxy) → `401 {"error_code":"INVALID_KEY"}`. No `x-requests-remaining` header is returned on 401, so **no limit could be recorded**. Gemini/Groq: no key was added, so not tested. Workers AI ran (model `@cf/meta/llama-3.1-8b-instruct-fast`), but its polish invented a game that wasn't on the slate, so it was removed.

## T8: does pg_cron traffic count as Supabase activity for the 7-day pause?
pg_cron job `nba-snapshot` (`13,33,53 * * * *`) was created 2026-11-22; first `net.http_post` returned 200 (`{"ok":true,"upload":200,...}`). **Result: pending.** It can only be answered after 8 days (check on or after 2026-11-30).

## T9: is api.cloudflare.com in the session's default allowlist?
No. Before a credential was saved, requests were refused by the session proxy. They succeeded only after the Cloudflare token was saved as a network credential for `api.cloudflare.com` (which also allows the host). Note: the same proxy refuses `*.workers.dev` from this build machine (`403 agent proxy: no rule ... allows this host`), so the live URL was verified from outside with Firecrawl.

## Worker cron runs (KV `runs`, raw)
```
2026-11-22T16:40:47.741Z  cron:*/20 * * * *  ok  games=7
2026-11-22T17:00:47.878Z  cron:*/20 * * * *  ok  games=7
2026-11-22T17:20:47.946Z  cron:*/20 * * * *  ok  games=7
2026-11-22T17:40:47.714Z  cron:*/20 * * * *  ok  games=7
2026-11-22T18:00:47.593Z  cron:*/20 * * * *  ok  games=7
2026-11-22T18:20:47.796Z  cron:*/20 * * * *  ok  games=7
2026-11-22T18:40:47.624Z  cron:*/20 * * * *  ok  games=7
2026-11-22T19:00:47.670Z  cron:*/20 * * * *  ok  games=7
2026-11-22T19:20:47.786Z  cron:*/20 * * * *  ok  games=7
2026-11-22T19:40:47.851Z  cron:*/20 * * * *  ok  games=7
2026-11-22T20:00:47.567Z  cron:*/20 * * * *  ok  games=7
2026-11-22T20:20:47.726Z  cron:*/20 * * * *  ok  games=7
2026-11-22T20:40:47.853Z  cron:*/20 * * * *  ok  games=7
2026-11-22T21:00:47.633Z  cron:*/20 * * * *  ok  games=7
2026-11-22T21:20:47.797Z  cron:*/20 * * * *  ok  games=7
2026-11-22T21:40:47.558Z  cron:*/20 * * * *  ok  games=7
2026-11-22T22:00:47.525Z  cron:*/20 * * * *  ok  games=7
```
