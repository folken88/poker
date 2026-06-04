/**
 * Pathfinder 1e experience & leveling — MEDIUM track. This is the dungeon's
 * character progression, replacing the old gear-derived level (which was
 * `1 + total magic bonus of equipped gear`). Level now comes from persisted XP;
 * gear only affects to-hit / damage / AC.
 *
 *   levelFromXp(xp)      → 1..20
 *   xpFloorForLevel(L)   → total XP at the START of level L (for the death penalty)
 *   xpForCR(cr)          → XP award for defeating a CR-`cr` foe (× XP_AWARD_MULT)
 *   rawXpForCR(cr)       → the same, WITHOUT the multiplier (encounter budgeting)
 *   xpProgress(xp)       → { level, xp, floor, next, into, span, toNext } for the UI
 *
 * One adventuring "day" = one room (as elsewhere in the game). XP is granted at
 * room-clear, split among the heroes still in the run (alive OR downed — not the
 * slain or those who left). XP_AWARD_MULT scales the grant (default 1.0 = true
 * PF1 pace); bump it if leveling feels too slow for a session.
 */
const MULT = (() => { const n = parseFloat(process.env.XP_AWARD_MULT || '1'); return (isNaN(n) || n < 0) ? 1 : n; })();
const MAX_LEVEL = 20;

// Total XP required to BE at each level — PF1 Medium track.
const XP_TO_LEVEL = {
  1: 0,        2: 2000,     3: 5000,     4: 9000,     5: 15000,
  6: 23000,    7: 35000,    8: 51000,    9: 75000,    10: 105000,
  11: 145000,  12: 210000,  13: 295000,  14: 425000,  15: 600000,
  16: 850000,  17: 1200000, 18: 1700000, 19: 2400000, 20: 3600000,
};

// Standard PF1 XP award per CR — Medium track. Fractions handled in rawXpForCR.
const XP_BY_CR = {
  1: 400,      2: 600,      3: 800,      4: 1200,     5: 1600,
  6: 2400,     7: 3200,     8: 4800,     9: 6400,     10: 9600,
  11: 12800,   12: 19200,   13: 25600,   14: 38400,   15: 51200,
  16: 76800,   17: 102400,  18: 153600,  19: 204800,  20: 307200,
  21: 409600,  22: 614400,  23: 819200,  24: 1228800, 25: 1638400,
};

function levelFromXp(xp) {
  xp = Math.max(0, Number(xp) || 0);
  let lvl = 1;
  for (let L = 2; L <= MAX_LEVEL; L++) { if (xp >= XP_TO_LEVEL[L]) lvl = L; else break; }
  return lvl;
}
function xpFloorForLevel(L) {
  L = Math.max(1, Math.min(MAX_LEVEL, L | 0));
  return XP_TO_LEVEL[L];
}
// Raw standard PF1 award for one CR-`cr` foe (no session multiplier).
function rawXpForCR(cr) {
  cr = Number(cr) || 0;
  if (cr <= 0) return 50;
  if (cr < 1) return cr <= 0.25 ? 100 : cr < 0.5 ? 135 : 200;   // CR 1/4, 1/3, 1/2
  return XP_BY_CR[Math.min(25, Math.round(cr))] || 400;
}
// Award after the session multiplier (used for granting AND budgeting-by-award).
function xpForCR(cr) { return Math.round(rawXpForCR(cr) * MULT); }

// Progress within the current level — drives the UI bar / "x to next".
function xpProgress(xp) {
  xp = Math.max(0, Number(xp) || 0);
  const level = levelFromXp(xp);
  const floor = XP_TO_LEVEL[level];
  const next = level >= MAX_LEVEL ? null : XP_TO_LEVEL[level + 1];
  return {
    level, xp, floor, next,
    into:   xp - floor,
    span:   next == null ? 0 : next - floor,
    toNext: next == null ? 0 : next - xp,
  };
}

module.exports = { MULT, MAX_LEVEL, XP_TO_LEVEL, XP_BY_CR, levelFromXp, xpFloorForLevel, xpForCR, rawXpForCR, xpProgress };
