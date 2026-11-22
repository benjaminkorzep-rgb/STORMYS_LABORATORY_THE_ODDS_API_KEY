// In-browser simulator (Web Worker). Re-runs the bivariate game sim (APPENDIX B §5) on the latest line
// when the line moved since the server snapshot, then market-anchors it exactly like the engine (§1).
import { simulate } from './core/engine/sim.js';
import { noVig, spreadToWp, blend } from './core/engine/market.js';

self.onmessage = ev => {
  const j = ev.data || {};
  if (j.type !== 'simulate') return;
  try {
    const n = 10000;
    const s = simulate({ ptsH: j.ptsH, ptsA: j.ptsA, poss: j.poss || 99, n, seed: 7, marginSd: j.marginSd || undefined, spreadLine: j.spreadLine, totalLine: j.totalLine });
    const pMkt = noVig(j.mlHome, j.mlAway) ?? spreadToWp(j.spreadLine);
    const wpHome = pMkt == null ? s.wpHome : blend(pMkt, s.wpHome, j.lambda ?? 0.10);
    self.postMessage({ type: 'result', id: j.id, result: { wpHome: typeof wpHome === 'object' ? wpHome.p ?? wpHome.value : wpHome, wpModel: s.wpHome, pMarket: pMkt, pOT: s.pOT, pCoverHome: s.pCoverHome, pOver: s.pOver, margin: s.margin, total: s.total, n, spreadLine: j.spreadLine, totalLine: j.totalLine } });
  } catch (e) { self.postMessage({ type: 'error', id: j.id, error: String(e.message || e) }); }
};
