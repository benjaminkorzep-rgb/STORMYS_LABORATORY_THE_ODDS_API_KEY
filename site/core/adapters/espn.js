// ESPN adapters (APPENDIX A §1). Every adapter: async (fetchImpl, params) -> {ok,status,bytes,ms,host,url,data,error}.
// site/v2 calls try site.api.espn.com first, then site.web.api.espn.com (hosting.md §2.6 host fallback).
import { getJSON, UA_IPHONE } from './http.js';

const SITE_HOSTS = ['https://site.api.espn.com', 'https://site.web.api.espn.com'];
const CORE = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba';
const WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba';
const H = { 'User-Agent': UA_IPHONE, Accept: 'application/json' };
const ymd = d => String(d).replace(/-/g, '');

async function siteV2(f, path, opts = {}) {
  let last = null;
  for (const host of SITE_HOSTS) {
    const r = await getJSON(f, `${host}/apis/site/v2/sports/basketball/nba/${path}`, { headers: H, timeoutMs: opts.timeoutMs || 8000 });
    r.attempts = (last?.attempts || []).concat([{ host: r.host, status: r.status, ok: r.ok, ms: r.ms }]);
    if (r.ok) return r;
    last = r;
    if (r.status && r.status < 500 && r.status !== 403 && r.status !== 429) return r; // only fail over on block/5xx/network
  }
  return last;
}

export const espnScoreboard = (f, { date } = {}) => siteV2(f, `scoreboard${date ? `?dates=${ymd(date)}` : ''}`);
export const espnSummary = (f, { eventId }) => siteV2(f, `summary?event=${eventId}`, { timeoutMs: 10000 });
export const espnInjuries = f => siteV2(f, 'injuries', { timeoutMs: 12000 });
export const espnNews = f => siteV2(f, 'news');
export const espnRoster = (f, { team }) => siteV2(f, `teams/${team}/roster`);
export const espnSchedule = (f, { team, season }) => siteV2(f, `teams/${team}/schedule${season ? `?season=${season}` : ''}`, { timeoutMs: 15000 });
export const espnTeamStats = (f, { teamId }) => siteV2(f, `teams/${teamId}/statistics`);
// /teams has no ACAO: server-only, shipped as static site/data/teams.json
export const espnTeams = f => siteV2(f, 'teams');
export const espnStandings = f => getJSON(f, 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings', { headers: H, timeoutMs: 12000 });
export const espnGamelog = (f, { athleteId, season }) => getJSON(f, `${WEB}/athletes/${athleteId}/gamelog${season ? `?season=${season}` : ''}`, { headers: H, timeoutMs: 12000 });
export const espnSplits = (f, { athleteId }) => getJSON(f, `${WEB}/athletes/${athleteId}/splits`, { headers: H });
export const espnAthlete = (f, { athleteId }) => getJSON(f, `${WEB}/athletes/${athleteId}/overview`, { headers: H });
export const espnCoreOdds = (f, { eventId }) => getJSON(f, `${CORE}/events/${eventId}/competitions/${eventId}/odds`, { headers: H });
export const espnPropBets = (f, { eventId }) => getJSON(f, `${CORE}/events/${eventId}/competitions/${eventId}/odds/100/propBets?limit=1000`, { headers: H, timeoutMs: 12000 });
export const espnOfficials = (f, { eventId }) => getJSON(f, `${CORE}/events/${eventId}/competitions/${eventId}/officials`, { headers: H });
export const espnPredictor = (f, { eventId }) => getJSON(f, `${CORE}/events/${eventId}/competitions/${eventId}/predictor`, { headers: H });
export const espnProbabilities = (f, { eventId }) => getJSON(f, `${CORE}/events/${eventId}/competitions/${eventId}/probabilities?limit=200`, { headers: H }); // 400 pre-game by design
export const espnDepthChart = (f, { teamId, season = 2027 }) => getJSON(f, `${CORE}/seasons/${season}/teams/${teamId}/depthcharts`, { headers: H });
export const espnPowerIndex = (f, { season = 2027 }) => getJSON(f, `${CORE}/seasons/${season}/powerindex`, { headers: H, timeoutMs: 12000 });
export const espnCdnScoreboard = f => getJSON(f, 'https://cdn.espn.com/core/nba/scoreboard?xhr=1', { headers: H, timeoutMs: 10000 });
