/**
 * Hand strength estimation, 0..1.
 *  - Preflop: Bill Chen formula (well-known poker pre-flop scoring),
 *             normalized so AA ≈ 1.0 and 7-2o ≈ 0.
 *  - Postflop: a MADE-HAND-aware scale (category + the key card's rank), so the
 *    bot's bet/raise thresholds in Bot.js actually fire on real value:
 *      one pair  ≈ 0.30–0.55 (deuces → aces / overpair)
 *      two pair  ≈ 0.58–0.68
 *      trips/set ≈ 0.72–0.79
 *      straight  ≈ 0.80+   flush ≈ 0.85+   full house ≈ 0.90+   quads+ ≈ 0.96+
 *    Draw equity (flush / open-ended) lifts weak holdings into "playable" but a
 *    draw is never a monster (capped ~0.62). The OLD version returned solver.rank/10
 *    (a pair = 0.20), which sat below every raise threshold — so "aggressive" bots
 *    could never value-bet a made hand and turned into calling stations.
 */

const { Hand: SolverHand } = require('pokersolver');

const ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const rankIdx = (r) => ORDER.indexOf(r);
// pokersolver Card.value is a rank string ('A','K','T','9'…); some builds emit '10'.
function valToRank(v) {
  v = String(v).toUpperCase();
  if (v.startsWith('10')) return ORDER.indexOf('T');
  return ORDER.indexOf(v[0]);
}

function chenValue(r) {
  switch (r) {
    case 'A': return 10;
    case 'K': return 8;
    case 'Q': return 7;
    case 'J': return 6;
    case 'T': return 5;
    default: return parseInt(r, 10) / 2;
  }
}

/** Pre-flop strength via Bill Chen formula, mapped to 0..1. */
function preFlopStrength(hole) {
  if (!hole || hole.length !== 2) return 0;
  const r0 = hole[0][0], r1 = hole[1][0];
  const s0 = hole[0][1], s1 = hole[1][1];

  let score = Math.max(chenValue(r0), chenValue(r1));
  if (r0 === r1) score = Math.max(score * 2, 5);   // pocket pair: double, min 5
  if (s0 === s1) score += 2;                        // suited bonus

  if (r0 !== r1) {
    const gap = Math.abs(rankIdx(r0) - rankIdx(r1)) - 1;
    if (gap === 0) score += 1;
    else if (gap === 1) score -= 1;
    else if (gap === 2) score -= 2;
    else if (gap === 3) score -= 4;
    else if (gap >= 4) score -= 5;
    if (gap <= 2 && rankIdx(r0) < rankIdx('Q') && rankIdx(r1) < rankIdx('Q')) score += 1;
  }
  return Math.max(0, Math.min(1, score / 20));
}

/** Post-flop strength: made-hand category + key-card rank, plus a draw bonus. */
function postFlopStrength(hole, board) {
  if (!board || board.length === 0) return preFlopStrength(hole);
  const cards = [...hole, ...board];
  const h = SolverHand.solve(cards);
  const rank = h.rank || 1;                                   // 1 high card … 10 royal
  const top = (h.cards && h.cards[0]) ? valToRank(h.cards[0].value) : 0;   // 0..12
  const f = Math.max(0, top) / 12;                            // intra-category, by key card
  let base;
  switch (rank) {
    case 1:  base = 0.06 + 0.16 * f; break;   // high card   .06–.22
    case 2:  base = 0.30 + 0.25 * f; break;   // one pair    .30–.55
    case 3:  base = 0.58 + 0.10 * f; break;   // two pair    .58–.68
    case 4:  base = 0.72 + 0.07 * f; break;   // trips/set   .72–.79
    case 5:  base = 0.80 + 0.03 * f; break;   // straight
    case 6:  base = 0.85 + 0.03 * f; break;   // flush
    case 7:  base = 0.90 + 0.04 * f; break;   // full house
    case 8:  base = 0.96; break;              // quads
    case 9:  base = 0.99; break;              // straight flush
    case 10: base = 1.00; break;              // royal flush
    default: base = 0.10;
  }
  // Draw equity (flop/turn only). Lifts weak holdings to "playable", but a draw is
  // never a monster — capped ~0.62 when the made hand is just air/one pair.
  if (board.length < 5) {
    const suitCount = {}, ranksPresent = new Set();
    for (const c of cards) { suitCount[c[1]] = (suitCount[c[1]] || 0) + 1; ranksPresent.add(rankIdx(c[0])); }
    const maxSuit = Math.max(0, ...Object.values(suitCount));
    let draw = 0;
    if (maxSuit === 4) draw += 0.14;   // flush draw
    const sr = [...ranksPresent].sort((a, b) => a - b);
    for (let i = 0; i + 3 < sr.length; i++) { if (sr[i + 3] - sr[i] <= 4) { draw += 0.10; break; } }   // straight draw
    if (draw > 0) base = rank <= 2 ? Math.min(0.62, base + draw) : Math.min(0.90, base + draw * 0.5);
  }
  return Math.max(0, Math.min(1, base));
}

function strengthOf(hole, board) {
  return !board || board.length === 0
    ? preFlopStrength(hole)
    : postFlopStrength(hole, board);
}

module.exports = { preFlopStrength, postFlopStrength, strengthOf };
