# Method

**This engine has not yet been run or backtested. Every number in the spec is a starting prior to be re-estimated by the walk-forward backtest.**

Status label shown in the app: **priors — backtest pending**. Engine version `1.0.0-priors`.

## Layers (APPENDIX B, code in `core/engine/`)
| § | What | File |
|---|---|---|
| 1 | Market anchor: no-vig (multiplicative / power / Shin when a side is >75%), blend in logit space with λ = 0.10 (0.30 for <15 min after news without a line move) | `market.js` |
| 2 | Ratings: box-score SPM per player (padded), Kalman team ratings, α 0.75 → 0.55 by game 40, Elo for display | `ratings.js` |
| 4 | Context priors: HCA 2.0, Denver altitude +1.0, Utah +0.3, rest diff 0.9/day (cap 3), B2B −1.5 in-model; jet lag, travel, refs, revenge, day games display-only until fit | `context.js` |
| 5 | Bivariate game sim: margin σ 12.5, total σ 18 scaled by pace, OT loop, 10k seeded draws | `sim.js` |
| 6 | Minutes engine: status priors, Dirichlet(20) redistribution, IPF to 240×(1+0.104·pOT), blowout curve from 13 pts, foul-trouble Poisson, 26-min return cap | `minutes.js` |
| 7 | Player projections with negative-binomial-style p10/p90; personal splits displayed with n and shrinkage, never in projection unless they pass §10 | `players.js` |
| 8 | Scenario tree: 2^U enumeration for U ≤ 6, else 64 Monte Carlo draws; Gaussian copula for teammate pairs | `scenarios.js` |
| 9 | Confidence: weighted z-scores (parameter, disagreement, data, calibration, role) → A–D and 0–100 | `confidence.js` |
| 10 | Trends: 241 pre-registered hypotheses, residuals vs model and closing line, block permutation p, BH/BY FDR, shrinkage, stability tiers | `registry.js`, `trends.js` |
| 11 | Walk-forward backtest (not run yet) | `engine/backtest.mjs`, `engine/metrics.js` |
| 13 | 145-factor catalogue: A20 B10 C10 D16 E8 F14 G10 H18 I12 J5 K9 L8 M5 | `factors.js` |

## Data and refresh
Writer A (Cloudflare Worker, cron */20) and Writer B (GitHub Actions + Pages, :07/:27/:47) write the same snapshot schema (`docs/contract.md`).
The phone races all writers and keeps the newest `generatedAt`. ESPN is called at most ~10 times per writer run.
