# Endpoint catalog & health

Generated from `core/adapters/extra.js` `EXTRA_ADAPTERS` and the ESPN list in `core/chains.js` (`ESPN_HEALTH`). Every adapter returns `{ ok, status, bytes, ms, host, url, data, error }` and never throws. `healthCheckAll(fetchImpl, { date })` in `core/chains.js` probes one call per row and returns the rows the Health tab renders.

## Chains (first ok + non-empty link wins; every attempt is logged as `{ name, status, ok, ms, bytes, host, error }`)

| Chain | Order |
|---|---|
| injuries | espnInjuries → actionNetworkInjuries → nbaInjuryPdf (index page, then :00/:15/:30/:45 slot probing) |
| lineups | nbaDailyLineups → rotowireLineups → espnDepthChart |
| odds | espnCoreOdds → actionNetworkScoreboard → nbaOdds (cdn.nba.com) → theOddsApi |
| gamelogs | espnGamelog → pbpstatsGameLogs → brefGamelog |
| pbp | espnSummary → pbpstatsLive → nbaPlayByPlay (cdn.nba.com) |
| referees | espnOfficials → nbaRefAssignments (official.nba.com) → nbastufferRefStats |

A link whose required id (eventId, teamId, athleteId, nbaPlayerId, brefPlayerId, nbaGameId, oddsApiKey) is missing from ctx is recorded as a skipped attempt.

## Catalog

| Adapter | URL | Chain(s) | Headers | Where it can run | Verified |
|---|---|---|---|---|---|
| `espnScoreboard` | `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={{date}}` | — | iPhone UA | browser OK (CORS-open JSON) | fixture-tested |
| `espnSummary` | `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={{eventId}}` | pbp | iPhone UA | browser OK (CORS-open JSON) | fixture-tested |
| `espnInjuries` | `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries` | injuries | iPhone UA | browser OK (CORS-open JSON) | fixture-tested |
| `espnStandings` | `https://site.api.espn.com/apis/v2/sports/basketball/nba/standings` | — | iPhone UA | browser OK (CORS-open JSON) | fixture-tested |
| `espnRoster` | `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{{teamId}}/roster` | — | iPhone UA | browser OK (CORS-open JSON) | fixture-tested |
| `espnSchedule` | `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{{teamId}}/schedule?season={{espnSeason}}` | — | iPhone UA | browser OK (CORS-open JSON) | fixture-tested |
| `espnGamelog` | `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{{athleteId}}/gamelog?season={{espnSeason}}` | gamelogs | iPhone UA | browser OK (CORS-open JSON) | fixture-tested |
| `espnSplits` | `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{{athleteId}}/splits` | — | iPhone UA | browser OK (CORS-open JSON) | fixture-tested |
| `espnCoreOdds` | `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/{{eventId}}/competitions/{{eventId}}/odds` | odds | iPhone UA | browser OK (CORS-open JSON) | fixture-tested |
| `espnPropBets` | `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/{{eventId}}/competitions/{{eventId}}/odds/100/propBets?limit=1000` | — | iPhone UA | browser OK (CORS-open JSON) | fixture-tested |
| `espnOfficials` | `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/{{eventId}}/competitions/{{eventId}}/officials` | referees | iPhone UA | browser OK (CORS-open JSON) | fixture-tested |
| `espnDepthChart` | `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/{{espnSeason}}/teams/{{teamId}}/depthcharts` | lineups | iPhone UA | browser OK (CORS-open JSON) | fixture-tested |
| `espnPowerIndex` | `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/{{espnSeason}}/powerindex` | — | iPhone UA | browser OK (CORS-open JSON) | fixture-tested |
| `actionNetworkScoreboard` | `https://api.actionnetwork.com/web/v2/scoreboard/nba?bookIds=15,30,68,69,75,123&date={{yyyymmdd}}&periods=event` | odds | Chrome UA | server-only: no CORS / HTML scrape | fixture-tested |
| `actionNetworkInjuries` | `https://api.actionnetwork.com/web/v1/leagues/4/injuries` | injuries | Chrome UA | server-only: no CORS / HTML scrape | fixture-tested |
| `nbaTodaysScoreboard` | `https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json` | — | CHROME_HEADERS | server-only: Chrome client hints, no CORS | fixture-tested |
| `nbaOdds` | `https://cdn.nba.com/static/json/liveData/odds/odds_todaysGames.json` | odds | CHROME_HEADERS | server-only: Chrome client hints, no CORS | fixture-tested |
| `nbaBoxscore` | `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_{{nbaGameId}}.json` | — | CHROME_HEADERS | server-only: Chrome client hints, no CORS | fixture-tested |
| `nbaPlayByPlay` | `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_{{nbaGameId}}.json` | pbp | CHROME_HEADERS | server-only: Chrome client hints, no CORS | fixture-tested |
| `nbaSchedule` | `https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json` | — | CHROME_HEADERS | server-only: Chrome client hints, no CORS | fixture-tested |
| `nbaPlayerIndex` | `https://cdn.nba.com/static/json/staticData/playerIndex.json` | — | CHROME_HEADERS | server-only: Chrome client hints, no CORS | **UNVERIFIED** |
| `nbaDailyLineups` | `https://stats.nba.com/js/data/leaders/00_daily_lineups_{{yyyymmdd}}.json` | lineups | CHROME_HEADERS | server-only: Chrome client hints, no CORS | fixture-tested |
| `nbaInjuryIndex` | `https://official.nba.com/nba-injury-report-2026-27-season/` | injuries | Chrome UA | server-only: no CORS / HTML scrape | fixture-tested |
| `nbaInjuryPdf` | `https://ak-static.cms.nba.com/referee/injury/Injury-Report_{{date}}_{{hh}}_{{mm}}{{ampm}}.pdf` | injuries | CHROME_HEADERS | server-only: Chrome client hints, no CORS | **UNVERIFIED** |
| `nbaRefAssignments` | `https://official.nba.com/referee-assignments/` | referees | Chrome UA | server-only: no CORS / HTML scrape | fixture-tested |
| `nbastufferRefStats` | `https://www.nbastuffer.com/2026-2027-nba-referee-stats/` | referees | Chrome UA | server-only: no CORS / HTML scrape | fixture-tested |
| `pbpstatsGames` | `https://api.pbpstats.com/get-games/nba?Season=2026-27&SeasonType=Regular%20Season` | — | Chrome UA | browser OK (CORS-open JSON) | fixture-tested |
| `pbpstatsTeamTotals` | `https://api.pbpstats.com/get-totals/nba?Season=2026-27&SeasonType=Regular%20Season&Type=Team` | — | Chrome UA | browser OK (CORS-open JSON) | fixture-tested |
| `pbpstatsLineupTotals` | `https://api.pbpstats.com/get-totals/nba?Season=2026-27&SeasonType=Regular%20Season&Type=Lineup` | — | Chrome UA | browser OK (CORS-open JSON) | fixture-tested |
| `pbpstatsPlayerGameLogs` | `https://api.pbpstats.com/get-game-logs/nba?Season=2026-27&SeasonType=Regular%20Season&EntityType=Player&EntityId={{nbaPlayerId}}` | gamelogs | Chrome UA | browser OK (CORS-open JSON) | fixture-tested |
| `pbpstatsShots` | `https://api.pbpstats.com/get-shots/nba?Season=2026-27&SeasonType=Regular%20Season&EntityType=Team&EntityId={{nbaTeamId}}` | — | Chrome UA | browser OK (CORS-open JSON) | fixture-tested |
| `pbpstatsWowy` | `https://api.pbpstats.com/get-wowy-stats/nba?Season=2026-27&SeasonType=Regular%20Season&TeamId={{nbaTeamId}}&Type=Player` | — | Chrome UA | browser OK (CORS-open JSON) | fixture-tested |
| `pbpstatsLiveGames` | `https://api.pbpstats.com/live/games/nba` | pbp | Chrome UA | browser OK (CORS-open JSON) | fixture-tested |
| `underdogLines` | `https://api.underdogfantasy.com/beta/v5/over_under_lines` | — | Chrome UA | server-only: no CORS / HTML scrape | fixture-tested |
| `polymarketNba` | `https://gamma-api.polymarket.com/events?tag_slug=nba&active=true&closed=false&limit=100` | — | Chrome UA | browser OK (CORS-open JSON) | fixture-tested |
| `theScoreEvents` | `https://api.thescore.com/nba/events` | — | iPhone UA | server-only: no CORS / HTML scrape | **UNVERIFIED** |
| `sleeperPlayers` | `https://api.sleeper.app/v1/players/nba` | — | Chrome UA | browser OK (CORS-open JSON) | fixture-tested |
| `sleeperState` | `https://api.sleeper.app/v1/state/nba` | — | Chrome UA | browser OK (CORS-open JSON) | fixture-tested |
| `rotowireLineups` | `https://www.rotowire.com/basketball/nba-lineups.php` | lineups | Chrome UA | server-only: no CORS / HTML scrape | fixture-tested |
| `rotowireInjuries` | `https://www.rotowire.com/basketball/tables/injury-report.php?team=ALL&pos=ALL` | — | Chrome UA | server-only: no CORS / HTML scrape | fixture-tested |
| `brefSchedule` | `https://www.basketball-reference.com/leagues/NBA_2027_games-november.html` | — | Chrome UA | server-only: HTML, 20 req/min bucket | fixture-tested |
| `brefGamelog` | `https://www.basketball-reference.com/players/{{brefInitial}}/{{brefPlayerId}}/gamelog/2027` | gamelogs | Chrome UA | server-only: HTML, 20 req/min bucket | fixture-tested |
| `brefReferees` | `https://www.basketball-reference.com/referees/2027_register.html` | — | Chrome UA | server-only: HTML, 20 req/min bucket | fixture-tested |
| `theOddsApiOdds` | `https://api.the-odds-api.com/v4/sports/basketball_nba/odds?apiKey={{oddsApiKey}}&regions=us&markets=h2h%2Cspreads%2Ctotals&oddsFormat=american` | odds | Chrome UA | server-only: secret apiKey | fixture-tested |
| `cbsInjuries` | `https://www.cbssports.com/nba/injuries/` | — | Chrome UA | server-only: no CORS / HTML scrape | fixture-tested |

## Verification status

Network was blocked in the build VM, so **no row has been live-probed**. All parsing is tested only against hand-built fixtures in `tests/adapters.test.mjs`. Rows marked UNVERIFIED have extra doubt about the URL or response shape:

- `nbaInjuryPdf` — `core/adapters/pdf.js` is a minimal extractor (FlateDecode via `DecompressionStream`, object streams, Tj/TJ/'/", ToUnicode CMaps). It passes on synthetic PDFs only. If a real report yields zero rows the adapter returns `ok:false` and the chain falls through.
- `nbaPlayerIndex` — the cdn `staticData/playerIndex.json` path was given in the brief but not confirmed.
- `theScoreEvents` — `api.thescore.com/nba/events` response shape is assumed.
- Action Network `leagues/4/injuries` — normalizer accepts both flat `injuries[]` and `teams[].injuries[]`.
- `pbpstatsLive` — uses the live games list (`/live/games/nba`). There is no per-game pbpstats live endpoint, so this link answers "is there live data" rather than returning play-by-play.

Secrets: The Odds API key is passed via `ctx.oddsApiKey` and is redacted (`apiKey=***`) in the returned `url`. `x-requests-remaining` and `x-requests-used` are surfaced as `quota`.
