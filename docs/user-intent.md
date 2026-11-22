# What the user actually wants (multi-lens read of the whole chat)

Sources in the chat: (1) a long pre-game report template ending "exhaust resources … exceed expectations";
(2) "i want the day of games not tmr all of todays games updates each Moment each day lock in";
(3) the PART 0–9 spec demanding a deployed, self-running app; (4) a note that the Cloudflare token was fixed.

| Lens | What the chat says | How the app answers it |
|---|---|---|
| Decision psychology (lineup lock) | Wants to act before lock; message 2 stresses *today*, *every moment*, *lock in*. | Board rolls to the next slate at 06:00 ET; lock alert ≤60 min; every game carries an A–D grade + 0–100 score, a range (quantiles) and a "what changes if" top-5 swing list. |
| Cognitive load | Dense but layered. | Card order is fixed: verdict line → key numbers → why → what changes if → deep dive (tap), same order in every game. |
| Trust and calibration | Burned by apps that need Claude and by noisy trends. | Runtime calls only ESPN and our own snapshot writers. No window.claude, Firecrawl or LLM API at runtime (the Worker's optional Workers-AI polish of one paragraph falls back to the rules text). Every screen shows source and data age. Every trend carries q-value, tier and a "why it may be noise" note. The Method tab shows the verbatim status line; nothing is called an "edge". |
| Novelty | Trends nobody shows plus a "new this refresh" feed. | 241-hypothesis registry (night, tip time, month, weekday, rest, travel, crew, altitude, density …) gated by BH/BY FDR; Changes tab diffs each refresh. |
| Autonomy | "It must run with nothing from me." | Worker cron every 20 min, Actions cron at :07/:27/:47, client fetches ESPN direct, plus IndexedDB and service-worker fallbacks. |
| Loss aversion | Late scratches, confirmations, line moves. | Alerts: spread ±2, total ±3, ML ±5 pp, Q/D/DTD tags, lock ≤60 min; Web Push for critical ones. |

Corrections from the chat: message 2 replaces the "tomorrow" game from request 1 with *today's whole slate*.
The user is a fantasy manager (stated in request 1), so player minutes and PRA projections weigh as much as side and total.
