/**
 * pf1data/abilityScores.js — PF1 ability-score math (PURE; no game state).
 *
 * The single home for: the point-buy cost table, the ability modifier, the
 * 25-point allocator that turns a character's ability PRIORITY list into a
 * concrete score array (17/14/14/12, rest 10), build validation, the every-
 * 4-levels ability-score increase (ASI), and the PF1 bonus-spells table.
 *
 * Consumed by characterProfiles.js (seed arrays) and game/character.js
 * (deriveCharacter). Kept free of any DB / Dungeon dependency so it can be
 * unit-checked in isolation (see scripts/check-ability-scores.js).
 */

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

// PF1 point-buy cost by final score (before racial/ASI). 10 = free; below 10
// refunds points; 18 is the pre-race cap at character creation.
const POINT_BUY_COST = { 7: -4, 8: -2, 9: -1, 10: 0, 11: 1, 12: 2, 13: 3, 14: 5, 15: 7, 16: 10, 17: 13, 18: 17 };
const POINT_BUY_TOTAL = 25;

// The spread walked down a character's priority list. P1=17, P2=14, P3=14,
// P4=12, everything after = 10. Sums to exactly 25 points for any 4+ priority.
const DEFAULT_SPREAD = [17, 14, 14, 12];

/** PF1 ability modifier: floor((score - 10) / 2). Works for odd scores & <10. */
function mod(score) { return Math.floor(((score || 10) - 10) / 2); }

/** Total point-buy cost of a score array (for validation). Unknown scores cost 0. */
function pointBuyCost(scores) {
  let t = 0;
  for (const a of ABILITIES) t += (POINT_BUY_COST[scores[a]] || 0);
  return t;
}

/** Build a {str,dex,con,int,wis,cha} array from an ordered ability PRIORITY
 *  list by walking `spread` down it; every ability not named stays 10.
 *  e.g. pointBuyArray(['int','dex','con','wis']) -> int17 dex14 con14 wis12. */
function pointBuyArray(priority, spread = DEFAULT_SPREAD) {
  const out = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
  (priority || []).forEach((ab, i) => {
    if (out[ab] === undefined) return;          // ignore unknown ability keys
    if (i < spread.length) out[ab] = spread[i]; // beyond the spread → stays 10
  });
  return out;
}

/** Validate a base build. Returns { ok, cost, errors:[...] }.
 *  Rules: cost must not exceed 25; a caster's casting ability must sit in the
 *  top two of its priority (P1 or P2); scores within the 7–18 point-buy range. */
function validateBuild(scores, { priority = [], castingAbility = null } = {}) {
  const errors = [];
  const cost = pointBuyCost(scores);
  if (cost > POINT_BUY_TOTAL) errors.push(`point-buy cost ${cost} exceeds ${POINT_BUY_TOTAL}`);
  for (const a of ABILITIES) {
    const s = scores[a];
    if (s < 7 || s > 18) errors.push(`${a} ${s} out of point-buy range 7–18`);
  }
  if (castingAbility) {
    const idx = priority.indexOf(castingAbility);
    if (idx === -1 || idx > 1) errors.push(`casting ability ${castingAbility} must be priority 1 or 2 (got ${idx === -1 ? 'unlisted' : 'priority ' + (idx + 1)})`);
  }
  return { ok: errors.length === 0, cost, errors };
}

/** Number of ability-score increases earned by `level` (PF1: one at 4/8/12/16/20). */
function asiCount(level) { return Math.max(0, Math.floor((level || 1) / 4)); }

/** Apply ASIs to a base score array. `pattern` is an ordered list of ability
 *  keys cycled once per ASI (e.g. ['str','cha'] alternates; ['int'] always int).
 *  Returns a NEW array; never mutates the base. */
function applyASI(base, level, pattern) {
  const out = { ...base };
  const pat = (pattern && pattern.length) ? pattern : null;
  const n = asiCount(level);
  for (let i = 0; i < n; i++) {
    const ab = pat ? pat[i % pat.length] : null;
    if (ab && out[ab] !== undefined) out[ab] += 1;
  }
  return out;
}

/** Apply a race's flat ability modifiers ({str:+2,int:-2,...}). NEW array. */
function applyRace(scores, raceMods) {
  const out = { ...scores };
  if (raceMods) for (const a of ABILITIES) if (raceMods[a]) out[a] = (out[a] || 10) + raceMods[a];
  return out;
}

/** PF1 bonus spells/day for a casting-ability MODIFIER at a given spell level.
 *  You get bonus spells of level L when mod >= L: count = floor((mod-L)/4)+1.
 *  e.g. mod +4 (18) → 1 bonus spell at each of levels 1–4. */
function bonusSpellSlots(abilityMod, spellLevel) {
  if (spellLevel < 1 || abilityMod < spellLevel) return 0;
  return Math.floor((abilityMod - spellLevel) / 4) + 1;
}

module.exports = {
  ABILITIES, POINT_BUY_COST, POINT_BUY_TOTAL, DEFAULT_SPREAD,
  mod, pointBuyCost, pointBuyArray, validateBuild,
  asiCount, applyASI, applyRace, bonusSpellSlots,
};
