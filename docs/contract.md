# Module contract (all code = plain ES modules, no npm deps, runs in Node 20, Deno, Cloudflare Workers and browsers)

## Snapshot (`/api/snapshot.json`, `site/data/latest.json`, Supabase `snapshots/latest.json`)
```
{
  schemaVersion: 2,
  generatedAt: ISO string,
  slateDate: "YYYY-MM-DD" (ET slate, rolls at 06:00 ET),
  source: { writer: "worker"|"actions"|"supabase"|"browser", espnHost, status: "ok"|"partial"|"error",
            calls: [{ name, url, host, status, bytes, ms, ok }] },
  method: { status: "priors — backtest pending", statusLine, lambda, alphaPlayer, hca, leagueOrtg, leaguePace },
  league: { ortg, pace, hca },
  games: [Game],
  narrative: { slate: [string x5], source: "rules"|"workers-ai"|"gemini"|"groq" },
  alerts:  [{ id, gameId, type, severity: "crit"|"warn"|"info", text, at }],
  changes: [{ gameId|null, field, from, to, why, at }],
  trends:  { validated: [Trend], exploratory: [Trend], narrative: [Trend], registrySize, lastRetest }
}
```
### Game
```
{ id, date (ISO), state: "pre"|"in"|"post", detail, tv, neutral,
  venue: { name, city, team, altFt, tz, lat, lon },
  home: TeamOut, away: TeamOut,       // TeamOut = { id, abbr, name, record, homeRecord, awayRecord, score, last5: "WLWWL", restDays, b2b }
  odds: { provider, spreadHome, total, mlHome, mlAway, open: { spreadHome, total, mlHome, mlAway }, books: [{ name, mlHome, mlAway, spreadHome, total, noVigHome }] , history: [{ at, spreadHome, total, noVigHome }] },
  injuries: [{ team, name, id, status, detail, returnDate }],
  officials: [string],
  h2h: { games: [{ date, winner, score, n }], note },
  analysis: EngineOutput (see core/engine/index.js analyzeGame),
  narrative: { paras: [string x4+], source },
  reasoning: [{ at, text }],
  dataAgeSec }
```
### Trend (output of core/engine/trends.js)
```
{ id, family, label, scope: "team"|"player"|"game", subject, n, seasons, rawEffect, shrunkEffect, ci80: [lo, hi],
  residualVsModel, residualVsClose, p, qBH, qBY, tier: "Validated"|"Exploratory"|"Narrative only",
  mechanism, stableSeasons: "k/4", alreadyPriced: bool, noiseNote: string }
```
### Engine input (analyzeGame(input))
```
{ game: { id, date, neutral, venueTeam },
  home: TeamIn, away: TeamIn,
  market: { spreadHome, total, mlHome, mlAway, open: {...}, books: [...] } | null,
  bpiHome: 0..1 | null,
  officials: [names],
  league: { ortg, pace, hca },
  context: { minutesSinceStatusChange, lineMovedSinceStatusChange } }
TeamIn = { id, abbr, wins, losses, ppg, oppg, pace?, restDays, b2b, threeInFour, milesLast72, tzShift, last10Net?,
           players: [PlayerIn] }
PlayerIn = { id, name, pos, starter: bool, status: "Active"|"Probable"|"Questionable"|"Doubtful"|"Out"|"Day-To-Day",
             listedLate?: bool, gamesMissed: n,
             log: [{ date, min, pts, reb, oreb, dreb, ast, fg3m, fg3a, fgm, fga, ftm, fta, tov, pf, stl, blk, oppAbbr, home: bool, result: "W"|"L", teamPts, oppPts }] }  // newest first
```

### EngineOutput (returned by analyzeGame; written by engine-modeler/core owner)
```
{ wp: { headline, model, market, lambda, disagree: bool, disagreeSD, range: [lo, hi], inferredRange: [lo, hi] },   // home perspective, 0..1
  margin: { mean, sd, q: { p10, p25, p50, p75, p90 } },  // home minus away
  total:  { mean, sd, q: {...} },
  pts: { home, away }, poss, pOT,
  cover: { line, pHome }, over: { line, p },
  ratings: { home: { player, results, net, off, def, sd }, away: {...} },
  context: [{ key, label, value, effect, inModel: bool }],
  scenarios: [{ key, prob, out: [names], wpHome, margin, total }],
  ifPanels: [{ player, team, pPlay, marketImpliedPlay, plays: { wpHome, margin, total }, sits: {...},
               delta: { wp, spread, total }, teammates: [{ name, dMin, dPts, dReb, dAst, dUsg }] }],
  bothSit: [{ team, players: [a, b], prob, wpHome, margin, total }],
  players: [{ id, name, team, pos, starter, status, pPlay,
              min: { mean, p10, p90, base, blowoutAdj, foulRisk, returnCap },
              proj: { pts: { mean, p10, p90 }, reb: {...}, ast: {...}, fg3m: {...}, pra: {...} },
              rates: { usg, ts, fg3pct, fg3pctShrunk, ast36, reb36 },
              form: { season: { pts, reb, ast, min, n }, decayed: { pts, reb, ast, min } },
              splits: [{ key, label, n, raw, shrunk, inProjection: false, why }],
              confidence: { score, grade } }],
  confidence: { score, grade, terms: { param, inj, disagree, data, calib, role } },
  swing: [{ variable, dWp, dTotal, note }],     // top 5
  factors: [ ... 145 rows from factors.js ... ] }
```
