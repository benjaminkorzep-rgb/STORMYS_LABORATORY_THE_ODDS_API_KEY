// APPENDIX B §4.1 (home court, altitude) and §6 (context priors). Static arena table + context terms.
import { haversineMiles } from './math.js';

// abbr (ESPN) -> arena lat/lon, elevation (ft), IANA tz. Static reference data (public arena locations).
export const ARENAS = {
  ATL: { lat: 33.757, lon: -84.396, alt: 1050, tz: 'America/New_York', arena: 'State Farm Arena' },
  BOS: { lat: 42.366, lon: -71.062, alt: 20, tz: 'America/New_York', arena: 'TD Garden' },
  BKN: { lat: 40.683, lon: -73.975, alt: 30, tz: 'America/New_York', arena: 'Barclays Center' },
  CHA: { lat: 35.225, lon: -80.839, alt: 750, tz: 'America/New_York', arena: 'Spectrum Center' },
  CHI: { lat: 41.881, lon: -87.674, alt: 595, tz: 'America/Chicago', arena: 'United Center' },
  CLE: { lat: 41.497, lon: -81.688, alt: 650, tz: 'America/New_York', arena: 'Rocket Arena' },
  DAL: { lat: 32.790, lon: -96.810, alt: 430, tz: 'America/Chicago', arena: 'American Airlines Center' },
  DEN: { lat: 39.749, lon: -105.008, alt: 5280, tz: 'America/Denver', arena: 'Ball Arena' },
  DET: { lat: 42.341, lon: -83.055, alt: 600, tz: 'America/Detroit', arena: 'Little Caesars Arena' },
  GS:  { lat: 37.768, lon: -122.388, alt: 10, tz: 'America/Los_Angeles', arena: 'Chase Center' },
  HOU: { lat: 29.751, lon: -95.362, alt: 50, tz: 'America/Chicago', arena: 'Toyota Center' },
  IND: { lat: 39.764, lon: -86.156, alt: 715, tz: 'America/Indiana/Indianapolis', arena: 'Gainbridge Fieldhouse' },
  LAC: { lat: 33.945, lon: -118.343, alt: 100, tz: 'America/Los_Angeles', arena: 'Intuit Dome' },
  LAL: { lat: 34.043, lon: -118.267, alt: 300, tz: 'America/Los_Angeles', arena: 'Crypto.com Arena' },
  MEM: { lat: 35.138, lon: -90.051, alt: 260, tz: 'America/Chicago', arena: 'FedExForum' },
  MIA: { lat: 25.781, lon: -80.188, alt: 10, tz: 'America/New_York', arena: 'Kaseya Center' },
  MIL: { lat: 43.045, lon: -87.917, alt: 600, tz: 'America/Chicago', arena: 'Fiserv Forum' },
  MIN: { lat: 44.980, lon: -93.276, alt: 830, tz: 'America/Chicago', arena: 'Target Center' },
  NO:  { lat: 29.949, lon: -90.082, alt: 5, tz: 'America/Chicago', arena: 'Smoothie King Center' },
  NY:  { lat: 40.751, lon: -73.993, alt: 30, tz: 'America/New_York', arena: 'Madison Square Garden' },
  OKC: { lat: 35.463, lon: -97.515, alt: 1200, tz: 'America/Chicago', arena: 'Paycom Center' },
  ORL: { lat: 28.539, lon: -81.384, alt: 100, tz: 'America/New_York', arena: 'Kia Center' },
  PHI: { lat: 39.901, lon: -75.172, alt: 40, tz: 'America/New_York', arena: 'Wells Fargo Center' },
  PHX: { lat: 33.446, lon: -112.071, alt: 1100, tz: 'America/Phoenix', arena: 'Footprint Center' },
  POR: { lat: 45.532, lon: -122.667, alt: 50, tz: 'America/Los_Angeles', arena: 'Moda Center' },
  SAC: { lat: 38.580, lon: -121.500, alt: 30, tz: 'America/Los_Angeles', arena: 'Golden 1 Center' },
  SA:  { lat: 29.427, lon: -98.437, alt: 650, tz: 'America/Chicago', arena: 'Frost Bank Center' },
  TOR: { lat: 43.643, lon: -79.379, alt: 250, tz: 'America/Toronto', arena: 'Scotiabank Arena' },
  UTAH:{ lat: 40.768, lon: -111.901, alt: 4300, tz: 'America/Denver', arena: 'Delta Center' },
  WSH: { lat: 38.898, lon: -77.021, alt: 30, tz: 'America/New_York', arena: 'Capital One Arena' },
};
ARENAS.UTA = ARENAS.UTAH; ARENAS.GSW = ARENAS.GS; ARENAS.NOP = ARENAS.NO; ARENAS.NYK = ARENAS.NY; ARENAS.SAS = ARENAS.SA; ARENAS.WAS = ARENAS.WSH; ARENAS.PHO = ARENAS.PHX; ARENAS.BRK = ARENAS.BKN;

export function utcOffsetHours(tz, when = new Date()) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(when).find(p => p.type === 'timeZoneName')?.value || 'GMT';
  const m = s.match(/GMT([+-]\d+)(?::(\d+))?/); return m ? Number(m[1]) + Math.sign(Number(m[1])) * (Number(m[2] || 0) / 60) : 0;
}
export const travelMiles = (fromAbbr, toAbbr) => (ARENAS[fromAbbr] && ARENAS[toAbbr] ? haversineMiles(ARENAS[fromAbbr], ARENAS[toAbbr]) : null);

// §4.1 / §6 priors. inModel=true terms move the projection at their prior mean; the rest are display-only
// until the weekly hierarchical fit shows an 80% interval excluding 0 AND a walk-forward log-loss gain (§6 rule).
export const PRIORS = {
  hca: { mean: 2.0, sd: 0.6, inModel: true, label: 'League home-court advantage', basis: 'Vertize 2021–26 home margin 1.96' },
  altDEN: { mean: 1.0, sd: 0.7, inModel: true, label: 'Denver altitude (extra HCA)', basis: 'Forbes study summary' },
  altUTA: { mean: 0.3, sd: 0.5, inModel: true, label: 'Utah altitude (extra HCA)', basis: 'prior' },
  restDiff: { mean: 0.9, sd: 0.6, inModel: true, label: 'Rest-day differential (per day, cap 3)', basis: 'Rest Ledger; Steenland & Deddens' },
  b2b: { mean: -1.5, sd: 1.0, inModel: true, label: '2nd night of back-to-back', basis: 'Esteves et al.' },
  threeInFour: { mean: -0.5, sd: 0.7, inModel: false, label: '3-in-4 nights', basis: 'Hoops Menu' },
  excessRest: { mean: -0.3, sd: 0.8, inModel: false, label: 'Excess rest ≥4 days', basis: 'Rest or rust' },
  eastJetLagHome: { mean: -0.7, sd: 0.6, inModel: false, label: 'Eastward jet lag (per hour)', basis: 'Leota et al. 2022' },
  westAdvantage: { mean: 0.4, sd: 0.6, inModel: false, label: 'Westward circadian advantage', basis: 'Chronobiology Intl 2024' },
  travel72: { mean: -0.3, sd: 0.4, inModel: false, label: 'Travel miles last 72h (per 1,000)', basis: 'PMC8636381' },
  refTotal: { mean: 0, sd: 1.0, inModel: false, label: 'Referee crew total delta', basis: 'Ref Watch' },
  refHome: { mean: 0, sd: 0.3, inModel: false, label: 'Referee crew home lean', basis: 'Price & Wolfers' },
  revenge: { mean: 0, sd: 0.7, inModel: false, label: 'Revenge spot', basis: 'NBAAnalytic (+21 raw → ~+1 shrunk)' },
  dayGame: { mean: 0, sd: 0.8, inModel: false, label: 'Day / early tip', basis: 'BEJEAP 2025' },
};

// Returns home-perspective margin adjustment and the itemised table shown in the factor table.
export function contextTerms({ home, away, venueTeam, neutral, tipLocalHour, hca = null }) {
  const rows = [];
  const add = (key, value, effect) => { const p = PRIORS[key]; rows.push({ key, label: p.label, value, effect: Math.round(effect * 100) / 100, inModel: p.inModel, prior: `${p.mean} ± ${p.sd}`, basis: p.basis }); };
  // league.hca (30-day rolling, when supplied) replaces the 2.0 prior mean; previously it was silently ignored.
  add('hca', neutral ? 'neutral' : 'home', neutral ? 0 : (hca != null && isFinite(hca) ? hca : PRIORS.hca.mean));
  if (!neutral && (venueTeam === 'DEN')) add('altDEN', 'Denver 5,280 ft', PRIORS.altDEN.mean);
  if (!neutral && (venueTeam === 'UTAH' || venueTeam === 'UTA')) add('altUTA', 'Salt Lake 4,300 ft', PRIORS.altUTA.mean);
  if (home.restDays != null && away.restDays != null) { const d = Math.max(-3, Math.min(3, home.restDays - away.restDays)); add('restDiff', `${home.restDays} vs ${away.restDays} days`, d * PRIORS.restDiff.mean); }
  if (home.b2b) add('b2b', `${home.abbr} 2nd night`, PRIORS.b2b.mean);
  if (away.b2b) add('b2b', `${away.abbr} 2nd night`, -PRIORS.b2b.mean);
  if (home.threeInFour) add('threeInFour', home.abbr, PRIORS.threeInFour.mean);
  if (away.threeInFour) add('threeInFour', away.abbr, -PRIORS.threeInFour.mean);
  if (home.restDays >= 4) add('excessRest', home.abbr, PRIORS.excessRest.mean);
  if (away.restDays >= 4) add('excessRest', away.abbr, -PRIORS.excessRest.mean);
  if (away.tzShift) add(away.tzShift > 0 ? 'eastJetLagHome' : 'westAdvantage', `${away.abbr} ${away.tzShift > 0 ? '+' : ''}${away.tzShift} h`, away.tzShift > 0 ? -PRIORS.eastJetLagHome.mean * away.tzShift : PRIORS.westAdvantage.mean);
  if (away.milesLast72 != null) add('travel72', `${away.abbr} ${Math.round(away.milesLast72)} mi`, -PRIORS.travel72.mean * away.milesLast72 / 1000);
  if (tipLocalHour != null && tipLocalHour < 17) add('dayGame', `${tipLocalHour}:00 local`, 0);
  const marginAdj = rows.filter(r => r.inModel).reduce((s, r) => s + r.effect, 0);
  return { marginAdj, rows };
}
