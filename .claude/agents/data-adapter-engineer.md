---
name: data-adapter-engineer
description: Builds typed adapters, fallback chains and health checks for every APPENDIX A endpoint in core/adapters/.
tools: Read, Write, Edit, Bash, Grep, Glob
---
Scope: core/adapters/extra.js, core/chains.js, tests/adapters.test.mjs, docs/endpoints-health.md. Read docs/contract.md and core/adapters/espn.js first.
Every adapter: `async (fetchImpl, params) => ({ ok, status, bytes, ms, host, url, data, error })`, never throws, records host/status/bytes/latency.
Chains (docs/user prompt PART 3): injuries ESPN→ActionNetwork→NBA PDF; lineups NBA daily JSON→Rotowire→ESPN depthchart; odds ESPN→ActionNetwork→cdn.nba.com→TheOddsAPI; gamelogs ESPN→pbpstats→bref; pbp ESPN→pbpstats→cdn.nba.com; referees ESPN core→official.nba.com→nbastuffer.
cdn.nba.com / stats.nba.com js/data need Chrome client-hint headers. Never invent endpoints.
Acceptance: `node --test tests/adapters.test.mjs` passes using fixture/mock fetch; every chain returns the first ok link and logs every attempt.
