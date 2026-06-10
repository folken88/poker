/**
 * pf1data/characterProfiles.js — per-character ability PRIORITY derivation.
 *
 * A character's build = class default priority, adjusted so the wielded weapon's
 * attack stat leads (a finesse/ranged weapon ⇒ DEX; a STR weapon ⇒ STR), then
 * fed to the 25-pt allocator. Full ARCANE casters fight with cantrips off their
 * casting stat, so their weapon never reorders the build. A small OVERRIDES map
 * holds hand-tuned exceptions. The seed table is "derive → you approve": every
 * result is listed for review (scripts/roster-ability-table.js).
 */

const { pointBuyArray } = require('./abilityScores');
const { abilityPriorityFor, asiPatternFor, castingAbilityFor } = require('./classes');

const FINESSE_KEYS = new Set(['rapier', 'whip']);
// Full arcane casters: their weapon is irrelevant to the build (they fight with
// cantrips off the casting stat), so we never reorder str/dex for them.
const FULL_ARCANE = new Set(['wizard', 'sorcerer', 'bard', 'witch', 'arcanist', 'summoner', 'psychic']);

// Hand-tuned exceptions (priority and/or asi). Kept small — most characters
// derive correctly from class + weapon below.
const OVERRIDES = {
  // Dismas: a holy GUNSLINGER-paladin — DEX/CHA, no STR at all (his leftover
  // points go to WIS for a Will save, not the unused STR).
  'Dismas': { priority: ['dex', 'cha', 'con', 'wis'] },
};

/** 'str' | 'dex' — the attack ability implied by a resolved weapon object. */
function weaponAttackStat(weapon) {
  if (!weapon) return 'str';
  const cat = weapon.cat;
  const ranged = !!weapon.ranged || cat === 'ranged';
  const natural = weapon.group === 'natural';   // claws/bite/slams use STR, not finesse
  const finesse = (cat === 'light' && !natural) || FINESSE_KEYS.has(weapon.key) || !!weapon.finesse2h;   // finesse2h: the elven curved blade is a DEX two-hander
  return (ranged || finesse) ? 'dex' : 'str';
}

/** Ensure ability `a` sits before ability `b` in the priority (swap if needed). */
function ensureBefore(priority, a, b) {
  const arr = priority.slice();
  const ia = arr.indexOf(a), ib = arr.indexOf(b);
  if (ia > -1 && ib > -1 && ib < ia) { arr[ia] = b; arr[ib] = a; }
  return arr;
}

/** The character's { priority, asiPattern }. */
function profileFor(name, cls, weapon) {
  const ov = OVERRIDES[name];
  if (ov) return { priority: ov.priority || abilityPriorityFor(cls), asiPattern: ov.asi || asiPatternFor(cls) };
  let priority = abilityPriorityFor(cls).slice();
  if (!FULL_ARCANE.has(cls)) {
    const atk = weaponAttackStat(weapon);
    priority = (atk === 'dex') ? ensureBefore(priority, 'dex', 'str')
                               : ensureBefore(priority, 'str', 'dex');
  }
  return { priority, asiPattern: asiPatternFor(cls) };
}

// Allocation spreads. SINGLE-STAT (SAD) classes pump one ability + CON, so they
// take an 18 in their primary (DEX a token 12 — heavy armor caps Dex-to-AC anyway).
// TWO-STAT (MAD) classes need both key stats, so they keep the flatter 17/14/14/12.
const SAD_SPREAD = [18, 14, 12];      // primary 18 / CON 14 / DEX 12, rest 10 (24 pts)
const MAD_SPREAD = [17, 14, 14, 12];  // primary 17 / second 14 / CON 14 / fourth 12 (25 pts)
const DUAL16_SPREAD = [16, 16, 14];   // two equal primaries + CON (capable at both), rest 10 (25 pts)
// Classes that want TWO equal 16s: the weapon's attack stat + a fixed second stat.
// Bard is a gish — 16 in its weapon's attack stat (DEX rapier / STR greatsword) AND
// 16 CHA, so it both casts and fights well.
const DUAL16 = { bard: 'cha' };

/** A class is SAD when its ASI pattern pumps a single ability. */
function isSAD(cls) { return asiPatternFor(cls).length <= 1; }
/** The point-buy spread for a class (DUAL16 16/16/14 · SAD 18/14/12 · MAD 17/14/14/12). */
function spreadFor(cls) { return DUAL16[cls] ? DUAL16_SPREAD : (isSAD(cls) ? SAD_SPREAD : MAD_SPREAD); }

/** Priority fed to the allocator. DUAL16 → [attackStat, second, con]; SAD → CON to
 *  slot 2 (primary 18 / CON 14 / DEX 12); MAD → the profile order as-is. */
function seedPriority(name, cls, weapon) {
  if (DUAL16[cls]) {
    const atk = weaponAttackStat(weapon), second = DUAL16[cls];
    const rest = ['str', 'dex', 'int', 'wis', 'cha'].filter(s => s !== atk && s !== second);
    return [atk, second, 'con', ...rest];
  }
  const { priority } = profileFor(name, cls, weapon);
  if (!isSAD(cls)) return priority;
  const primary = priority[0];
  return [primary, 'con', ...priority.filter(s => s !== primary && s !== 'con')];
}

/** The seeded 25-pt base ability array for a character. */
function seedScores(name, cls, weapon) {
  return pointBuyArray(seedPriority(name, cls, weapon), spreadFor(cls));
}

module.exports = { profileFor, seedScores, seedPriority, isSAD, spreadFor, weaponAttackStat, OVERRIDES, FULL_ARCANE };
