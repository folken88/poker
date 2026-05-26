/**
 * Hand strength estimation, 0..1.
 *  - Preflop: Bill Chen formula (well-known poker pre-flop scoring),
 *             normalized so AA ≈ 1.0 and 7-2o ≈ 0.
 *  - Postflop: pokersolver's hand rank / 10  (1=high-card, 10=royal flush).
 */

const { Hand: SolverHand } = require('pokersolver');

const ORDER = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const rankIdx = (r) => ORDER.indexOf(r);

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

  if (r0 === r1) {
    // Pocket pair: double the value, minimum 5
    score = Math.max(score * 2, 5);
  }

  if (s0 === s1) score += 2; // suited bonus

  // Gap penalty (only when not a pair)
  if (r0 !== r1) {
    const gap = Math.abs(rankIdx(r0) - rankIdx(r1)) - 1;
    if (gap === 0) score += 1;        // connected
    else if (gap === 1) score -= 1;
    else if (gap === 2) score -= 2;
    else if (gap === 3) score -= 4;
    else if (gap >= 4) score -= 5;

    // Both cards under Q and gap ≤ 2 → +1 (straight potential)
    if (gap <= 2 && rankIdx(r0) < rankIdx('Q') && rankIdx(r1) < rankIdx('Q')) {
      score += 1;
    }
  }

  // Chen range is roughly -1..22. Clamp + normalize.
  return Math.max(0, Math.min(1, score / 20));
}

/** Post-flop strength: solver rank scaled to 0..1, plus a small "draw" bonus. */
function postFlopStrength(hole, board) {
  if (!board || board.length === 0) return preFlopStrength(hole);
  const cards = [...hole, ...board];
  const h = SolverHand.solve(cards);
  // pokersolver rank: 1 (high card) → 10 (royal flush)
  let base = (h.rank || 1) / 10;

  // Flush / straight draw bonus when on flop/turn (not river)
  if (board.length < 5) {
    const suitCount = {};
    const ranksPresent = new Set();
    for (const c of cards) {
      suitCount[c[1]] = (suitCount[c[1]] || 0) + 1;
      ranksPresent.add(rankIdx(c[0]));
    }
    const maxSuit = Math.max(...Object.values(suitCount));
    if (maxSuit === 4) base = Math.min(1, base + 0.12); // flush draw
    // Straight draw: any 4 ranks within a 5-window
    const sortedRanks = [...ranksPresent].sort((a, b) => a - b);
    for (let i = 0; i + 3 < sortedRanks.length; i++) {
      if (sortedRanks[i + 3] - sortedRanks[i] <= 4) {
        base = Math.min(1, base + 0.08);
        break;
      }
    }
  }
  return base;
}

function strengthOf(hole, board) {
  return !board || board.length === 0
    ? preFlopStrength(hole)
    : postFlopStrength(hole, board);
}

module.exports = { preFlopStrength, postFlopStrength, strengthOf };
