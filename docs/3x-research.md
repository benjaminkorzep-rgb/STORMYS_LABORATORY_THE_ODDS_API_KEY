# 3x research: per-game module and data-point counts on 5 free NBA pre-game pages

Date of research: 2026-11-22 (pages captured 2026-11-21/22, the day before or the day of the game).

## Method

- For each site I picked one real, current pre-game page and fetched it with Firecrawl `scrape` (markdown, main content only). Firecrawl gives static/server-rendered content. Widgets that render client-side, sit behind tabs, or are paywalled may be missing. I note where that happened.
- **Module** = a separately titled block holding data specific to this game: an odds table, an injury table, a trends list. Site-wide chrome, scoreboard tickers for other games, promos, related articles and sign-up upsells are excluded.
- **Data point** = one atomic, game-specific value shown on the page: one price, one line, one stat cell, one injury status, one trend bullet, one starter name. Team names and logos are counted once in the header. Values were counted by hand from the scraped markdown, so the numbers are estimates (about ±10%).
- **Visible** = what the default view of the scraped page shows. **Addressable** = an estimate that also counts values reachable on the same URL through tabs (prop markets, game periods, splits). Figures marked *est.* are extrapolated from the tab labels, not counted.
- I could not use the same game on all five sites. Dimers had no Thunder–Heat article: the URL I tried returned 404, so I used its Clippers–Mavericks article. Rotowire's lineups page showed only the Nov 21 slate, so I counted its Celtics–Kings card.

## Summary table

| # | Site / page type | Game | URL | Data modules | Data points (visible) | Data points (addressable, est.) | Confidence |
|---|---|---|---|---|---|---|---|
| 1 | ESPN Gamecast (pre-game) | OKC @ MIA, Nov 22 | https://www.espn.com/nba/game/_/gameId/401910030/thunder-heat | 6 (+1 failed) | ~97 | ~120 | Medium. One module showed "Data is currently unavailable" (likely odds/BPI matchup predictor). The preview article is on a separate URL. |
| 2 | Action Network game page | OKC @ MIA, Nov 22 | https://www.actionnetwork.com/nba-game/oklahoma-city-thunder-miami-heat/295482 | 16 | ~215 | ~700+ (11 prop tabs × ~6 players × 3 cols × 3 values; odds comparison × 7 periods × 3 markets) | Medium-high for visible. Low for addressable. The injury list looked lazily loaded: 1 row shown, but the search snippet listed more. Public money % is locked. |
| 3 | Covers matchup (Stats tab) + Picks + Odds tabs | DET @ ATL, Nov 22 | https://www.covers.com/sport/basketball/nba/matchup/388766 (+ /picks, /odds) | 13 on Stats tab; ~22 across 3 tabs | ~590 (Stats tab alone) | ~650 (+ Picks tab trends/consensus, Odds tab cards) | High for the Stats tab, which is mostly static tables. The Picks/Odds tabs were read from search snippets only (no picks/odds posted yet). |
| 4 | Rotowire NBA lineups (one game card) | BOS @ SAC, Nov 21 | https://www.rotowire.com/basketball/nba-lineups.php | 9 (2 are expanders) | ~55 | ~90 (projected-minutes and on/off expanders not captured) | Medium. Only one card on a slate page was counted. Expander content was not rendered. |
| 5 | Dimers prediction article | LAC @ DAL, Nov 21 | https://www.dimers.com/nba/news/los-angeles-clippers-vs-dallas-mavericks-prediction-11-21-2026-ac | 7 data modules (11 incl. non-data) | ~43 | ~55 (spread/total/ML widget tabs) | Medium-high. The linked full matchup page (dimers.com/nba/predictions/2026_33_dal_lac) was not opened and is mostly Pro-gated. |

**Benchmark for "3x":** the most data-dense free page was Covers (~13 modules / ~590 visible points on one tab, ~22 modules across its 3 tabs). Next was Action Network (16 modules / ~215 visible points, many more behind tabs). 3x the strongest competitor means **~40–66 per-game modules and ~1,800–2,000 per-game data points**. Against the median of the five pages (9 modules / ~97 points) it means **~27 modules / ~300 points**.

## Module lists

### 1. ESPN Gamecast, OKC @ MIA (opened)
1. Header: teams, records, home/away records, date/time, TV (~8 points)
2. SportsNation poll: 3 head-to-head questions (~6)
3. Season leaders: PTS/REB/AST leader per team, each with 2 sub-stats (~18)
4. Team stats comparison: 7 stats × 2 teams (14)
5. Injury report: 7 players × status/injury/est. return (~21)
6. Last 5 games per team: 10 rows × date/opp/result-score (~30)
7. (Failed) A module rendered "Data is currently unavailable", probably the odds or matchup predictor.

### 2. Action Network, OKC @ MIA (opened)
1. Header: time, TV, teams, records (~6)
2. Odds summary: open, spread+price, total+price, moneyline × 2 teams (~10)
3. Game info: date, venue, city (~3)
4. Prop odds comparison: points tab, 6 players × best/consensus/bet365 × line/over/under (~54). There are 11 market tabs.
5. Line movement tracker: 4 timestamped rows (~8)
6. Public betting %: bets % shown, money % locked (~2–4)
7. Betting trends: 5 bullets (5)
8. ATS history: 2 teams × 5 splits (10)
9. O/U history: 2 × 5 (10)
10. Straight-up history: 2 × 5 (10)
11. Last 5 matchups: 5 rows × 6 cols (~30)
12. Injury updates (1 row rendered, ~2)
13. Player stat leaders: 4 categories (~8)
14. Team stats: 10 stats × 2 (20)
15. Odds comparison by sportsbook: open + consensus + 5 books × 2 sides × line/price (~28). Tabs for 1H/2H/1Q–4Q and spread/ML/total.
16. Team totals: 2 teams × over/under line+price (8)

### 3. Covers matchup, DET @ ATL (Stats tab opened; Picks/Odds tabs from snippets)
Stats tab:
1. Header: teams, conference rank, records, tip time (~8)
2. Predicted score + best odds: spread/total/ML with price and book per side (~12; predicted score blank)
3. Record table: Record, ATS, O/U, Away, Home × 2 (10)
4. Head-to-head summary + last 10 H2H games (3 + 10×5 = ~53)
5. DET last 10 games + summary (~53)
6. DET next 3 games (~15)
7. ATL last 10 games + summary (~53)
8. ATL next 3 games (~15)
9. Injuries with dated notes: 11 players × 5 fields (~55)
10. Last game's starters: 2 × 5 players × 10 stat cols (~100)
11. Key stats, offense vs opposing defense with ranks + league avg: 9 stats × 5 values × 2 directions (~90)
12. More stats: 8 × 5 × 2 (~80)
13. Points by quarter: 5 × 5 × 2 (~50)
(also a referee placeholder: "released a few hours before game time", and a preview placeholder)

Picks tab (snippet): expert/computer picks, consensus picks, prop projections, 8 recent-form trend bullets, ROI trends, top user picks. That adds about 6 modules.
Odds tab (snippet): game odds, spread, total and moneyline cards with compare links. That adds about 4 modules.

### 4. Rotowire lineups card, BOS @ SAC (opened, slate page)
1. Header: teams, records, tip time, watch/tickets, alerts (~6)
2. Lineup status (Expected/Confirmed) × 2 (2)
3. Starting five with positions × 2 (20)
4. "May not play" list with status × 2 (~12)
5. Chance-to-play color bars (likelihood scale, per listed player)
6. Projected minutes (expander, not captured)
7. On/off court stats (expander, not captured)
8. Referees: 3 names (3)
9. Odds: LINE / SPREAD / O-U from 4 books (12)

### 5. Dimers article, LAC @ DAL (opened)
1. Meta: updated/published times (2)
2. Key predictions: predicted score, 2 win probs, spread cover prob, total prob (6)
3. Pregame probabilities widget: spread tab, 2 sides × prob/price/venue (6). Total and ML tabs are hidden.
4. Best odds list: 6 lines with venue (~12)
5. Pick and edge: pick, price, implied prob, model prob, edge, payout (~6)
6. Player projections: top-5 scorers plus the leader's reb/ast (~7)
7. Game details: matchup, date, time, venue (4)
(Non-data: Pro upsell, promo, methodology note, related articles)

## Observations useful for the design
- Every competitor leans on raw ATS/O/U "trend" bullets (Action, Covers, The Cover) with no multiple-testing correction. Benjamini-Hochberg/Benjamini-Yekutieli-filtered trends would set the design apart.
- No page showed a calibrated model probability next to the no-vig market probability and the CLV history together. Dimers comes closest: model prob vs implied, with an edge.
- Data the free pages lacked or locked: projected minutes (Rotowire, behind an expander), money % (Action, locked), referee crew impact (Covers placeholder; Rotowire names only), rest/travel/altitude context (none), and player-out usage redistribution (none).

## Failures / limits
- The Dimers Thunder–Heat URL I constructed returned 404, so I substituted a real Dimers article for a different game.
- I did not open a BettingPros or Oddstrader page. Dimers served as option 5.
- The ESPN odds/predictor module did not render in the scrape. The Action Network injury list appears lazily loaded.
- The Rotowire scrape was ~98k characters. I counted one card from it, and the expander content (projected minutes, on/off) was not present.
- All counts are manual estimates from scraped markdown. Treat them as ±10% for visible counts and order-of-magnitude for addressable counts.
