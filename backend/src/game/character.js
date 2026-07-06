/**
 * game/character.js — the single source of truth for a hero's DERIVED stats.
 *
 * deriveCharacter() takes a character's class, level, race, BASE ability array
 * (the 25-pt buy) and gear/weapon, and returns every number combat & the UI
 * need: final ability scores (base + race + ASI), modifiers, HP (with CON),
 * saves (with ability mods), BAB, spell DC / casting mod / bonus slots, and the
 * iterative-attack offsets. attackProfile() then resolves to-hit/damage for a
 * specific swing (weapon vs. caster cantrip, main vs. off-hand) per the house
 * combat rules. This REPLACES the hardcoded ABILITY_MOD / CAST_MOD constants and
 * centralizes math that used to be scattered through Dungeon.js.
 */

const AS = require('../pf1data/abilityScores');
const { CLASSES, DEFAULT_CLASS, babFor, saveFor, castingAbilityFor, asiPatternFor } = require('../pf1data/classes');

// 1h finesse melee weapons (light weapons are finesse by category; these are the
// non-light weapons that are still finesse-capable in this game).
const FINESSE_KEYS = new Set(['rapier', 'whip', 'bastardsblade']);   // Bastard's Blade: Kai Ginn's fauchard rides his DEX for hit AND damage (Tobias 2026-07-04)

/** Number of attacks from iteratives at a BAB (PF1: +1 at 6/11/16), and their
 *  to-hit offsets. bab 1–5 → [0]; 6–10 → [0,-5]; 11–15 → [0,-5,-10]; 16+ → […,-15]. */
function iterativeOffsets(bab) {
  const n = bab >= 16 ? 4 : bab >= 11 ? 3 : bab >= 6 ? 2 : 1;
  return [0, -5, -10, -15].slice(0, n);
}

/** Classify a resolved weapon object (from combat.weaponOf) for the attack rules. */
function weaponClass(weapon) {
  const cat = weapon && weapon.cat;
  const ranged = !!(weapon && weapon.ranged) || cat === 'ranged';
  const twoHanded = cat === '2h';
  const light = cat === 'light';
  const natural = weapon && weapon.group === 'natural';   // claws/bite/slams use STR, not finesse
  const finesse = (light && !natural) || FINESSE_KEYS.has(weapon && weapon.key);
  return { ranged, twoHanded, light, finesse };
}

/** Floor toward zero is wrong for PF1 multipliers; PF1 rounds DOWN (toward -inf)
 *  for x1.5/x0.5 on a positive mod and keeps full penalty on negatives. We use
 *  Math.floor for the common positive case; penalties (negative) apply at x1. */
function scaleMod(m, mult) {
  if (m <= 0) return m;            // penalties aren't reduced/amplified here
  return Math.floor(m * mult);
}

/** Derive the full stat bundle for a character. `weapon` (optional) is a resolved
 *  combat.weaponOf object; pass it so attack numbers are precomputed for the UI. */
function deriveCharacter({ cls, level, baseScores, race, raceMods, featHp = 0, weapon } = {}) {
  cls = CLASSES[cls] ? cls : DEFAULT_CLASS;
  const lvl = Math.max(1, level | 0);
  const hd = CLASSES[cls].hd;
  const base = baseScores || { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };

  // base -> + race -> + ASI (every 4 levels, per the class/character pattern)
  const withRace = AS.applyRace(base, raceMods);
  const scores = AS.applyASI(withRace, lvl, asiPatternFor(cls));
  const mods = {};
  for (const a of AS.ABILITIES) mods[a] = AS.mod(scores[a]);

  const bab = babFor(cls, lvl);
  const saves = {
    fort: saveFor(cls, 'fort', lvl) + mods.con,
    ref:  saveFor(cls, 'ref', lvl) + mods.dex,
    will: saveFor(cls, 'will', lvl) + mods.wis,
  };
  // HP: max-roll Hit Die per level + CON mod per level (min 1 HP/level) + feat HP.
  const hp = Math.max(lvl, lvl * (hd + mods.con)) + (featHp || 0);

  const castAbility = castingAbilityFor(cls);
  const castingMod = castAbility ? mods[castAbility] : 0;
  const iteratives = iterativeOffsets(bab);

  const out = {
    cls, level: lvl, scores, mods, bab, saves, hp,
    castingAbility: castAbility, castingMod, iteratives,
    spellDC: (spellLevel) => 10 + (spellLevel || 0) + castingMod,
    bonusSlots: (spellLevel) => AS.bonusSpellSlots(castingMod, spellLevel),
  };
  if (weapon) out.weapon = attackProfile(out, weapon);
  return out;
}

// BRUTE two-handed weapon groups that stay pure STR even under the free-finesse house
// rule (Tobias: "2h hammer and axe should be strength based only"). Every OTHER 2h
// weapon (blades, polearms, spears, staves) may finesse. A weapon can override with
// `finesse2h:true` (force finesse) or `str2h:true` (force STR).
const STR_ONLY_2H_GROUPS = new Set(['axes', 'hammers', 'flails']);   // brute chop/smash/whirl weapons (Tobias: hammers, axes, and flails are STR)

/** Resolve to-hit ability mod and damage bonus for a specific attack.
 *  opts.offHand → 0.5x STR/DEX (two-weapon off-hand); opts.cantrip → caster
 *  at-will ray uses the casting stat for BOTH to-hit and damage. */
function attackProfile(derived, weapon, opts = {}) {
  const mods = derived.mods;
  if (opts.cantrip) {
    return { attackStat: derived.castingAbility, toHitMod: derived.castingMod, dmgBonus: derived.castingMod, twoHanded: false, ranged: true, finesse: false, cantrip: true };
  }
  const wc = weaponClass(weapon);
  // HOUSE RULE (Tobias 2026-07-06): every class has Weapon Finesse + Slashing/Fencing
  // Grace for FREE, so almost any melee weapon may swing off the BETTER of STR or DEX
  // — for BOTH to-hit and damage. We take the higher mod so this never nerfs a STR
  // build, only lets a DEX build hit & hurt. This now extends to MOST two-handed
  // weapons too (estoc, glaive, fauchard, quarterstaff, greatsword, spears, polearms…),
  // which keep their ×1.5. The ONLY exceptions are BRUTE 2H weapons — heavy AXES and
  // HAMMERS — where momentum, not finesse, does the work: those stay pure STR. (A
  // per-weapon `finesse2h:true` forces finesse; `str2h:true` forces STR.) Ranged = DEX.
  const s = mods.str || 0, d = mods.dex || 0;
  let attackStat, m, dexMelee = false;
  const brute2h = wc.twoHanded && weapon && !weapon.finesse2h && (weapon.str2h || STR_ONLY_2H_GROUPS.has(weapon.group));
  if (wc.ranged)   { attackStat = 'dex'; m = d; }
  else if (brute2h) { attackStat = 'str'; m = s; }   // 2h axe/hammer — brute STR only
  else             { dexMelee = d >= s; attackStat = dexMelee ? 'dex' : 'str'; m = dexMelee ? d : s; }   // 1h/light/natural OR a graceful 2h weapon: better of STR/DEX, ×1.5 still applies below for 2h
  let mult = wc.twoHanded ? 1.5 : 1.0;
  if (opts.offHand) mult = 0.5;            // off-hand swing of a two-weapon fighter
  // Ranged weapons here get the house-rule DEX-to-damage at x1 (no 1.5/0.5).
  const dmgBonus = wc.ranged ? m : scaleMod(m, mult);
  return { attackStat, toHitMod: m, dmgBonus, twoHanded: wc.twoHanded, ranged: wc.ranged, finesse: dexMelee };
}

module.exports = { deriveCharacter, attackProfile, weaponClass, iterativeOffsets };
