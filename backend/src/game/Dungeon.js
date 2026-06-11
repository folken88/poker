/**
 * "Hit the Dungeon" — a push-your-luck co-op side-game.
 *
 * Players leave their poker seat and descend into the basement beneath the poker
 * hall to fight PF1e-flavored monsters, hauling gold back up to the felt. ONE
 * shared run per table — players can dungeon TOGETHER as a party. The poker table
 * keeps playing without them. This NEVER affects poker mechanics except to ADD
 * gold to a player's stack on a successful bail (gold = chips = gp, 1:1).
 *
 * Everyone (human or bot) takes one turn per round in initiative order. A human
 * who idles on their turn auto-PASSES after 10s (the party plays on). Each member
 * bails individually for an even share of the current pool; a downed member is
 * out with nothing. The run ends when no one's left fighting.
 *
 * See docs/DUNGEON_DESIGN.md.
 */

const db = require('../persistence/db');
const { weaponOf, acOf, totalMagicBonus, SND, dRoll, dRollN, pick } = require('./combat');
const { CLASSES, babFor, saveFor, weaponProficient, NON_PROFICIENT_PENALTY } = require('../pf1data/classes');
const { kitFor, roomUses, isPoolClass, isCaster, isSpontaneous, spellSlots, spontaneousSlots, slotsFor, diceCount, CANTRIPS, CANTRIP_BY_KEY } = require('../pf1data/abilities');
const { levelFromXp, xpFloorForLevel, xpForCR, rawXpForCR, xpProgress } = require('../pf1data/xp');
const { logDungeon, recordSound } = require('../persistence/logger');
const banter = require('../bot/banter');
const { deriveCharacter, attackProfile } = require('./character');

// ── Tuning knobs ────────────────────────────────────────────────────────────
// LEVEL = 1 + sum of all gear bonuses (min 1). Level drives HP, to-hit, and
// saves — for humans AND AI allies.
const HP_PER_LEVEL   = 10;   // legacy fallback (used only if a class has no Hit Die)
// HP per level is the class's Hit Die, MAX roll assumed (barbarian d12, fighter
// d10, rogue/cleric/bard d8, wizard/sorcerer d6 …). So a level-6 fighter has 60
// HP, a level-6 wizard 36.
function hdFor(cls) { return (CLASSES[cls] && CLASSES[cls].hd) || HP_PER_LEVEL; }
// PF1 FIGHTER bonus feats, earned as the fighter levels — folded into the game's
// unified hit / damage / AC / HP / save / initiative numbers (the game has no
// per-weapon-group or per-save granularity, so the three save feats collapse to
// one all-saves bonus and Weapon Focus/Spec apply to every weapon).
const FF_NONE = { hit: 0, dmg: 0, ac: 0, hp: 0, save: 0, init: 0, impCrit: false, critFocus: false, impCleave: false, twf: false, twDef: false, itwf: false, inw: false,
  // Caster feat-tree bonuses (wizard/sorcerer/witch — see casterFeats):
  spellDC: 0, spellPen: 0, combatCasting: false, intensify: false, empower: false, maximize: false, quicken: false,
  // Ranged feat-tree bonuses (any feat-class wielding a bow/crossbow — see rangedFeats):
  pbs: 0, rapidShot: false, bullseye: false,
  // Rogue / cleric tree bonuses (see rogueFeats / clericFeats):
  offDef: false, quickChannel: false,
  // High-level fighter ladder (see featLadder / rangedFeats):
  prStrike: 0, critMastery: false, supremacy: false, manyshot: false };
// PF1 weapon-damage-by-size table (Enlarge Person / Improved Natural Attack), one
// step UP per entry. Used to grow a druid's natural-attack dice when they enlarge
// into a bigger form and/or take Improved Natural Weapon.
const DMG_STEP = {
  '1d2': [1, 3], '1d3': [1, 4], '1d4': [1, 6], '1d6': [1, 8], '1d8': [2, 6], '1d10': [2, 8], '1d12': [3, 6],
  '2d6': [3, 6], '2d8': [3, 8], '2d10': [4, 8], '3d6': [4, 6], '3d8': [4, 8], '4d6': [6, 6], '4d8': [6, 8],
  '6d6': [8, 6], '6d8': [8, 8], '8d6': [12, 6],
};
function stepDamage(count, die, steps) {
  let c = count || 1, d = die || 4;
  for (let i = 0; i < (steps || 0); i++) { const nx = DMG_STEP[`${c}d${d}`]; if (!nx) break; c = nx[0]; d = nx[1]; }
  return { count: c, die: d };
}
// The fighter bonus-feat ladder, evaluated at a GATING level `g` (which feats are
// earned so far) with the Toughness HP bonus scaling on actual Hit Dice `hd`.
function featLadder(g, hd) {
  return {
    // FULL 20-feat MELEE ladder — fighters take one feat per level (g = level), so
    // theirs runs the whole length; half-rate classes only ever see the front half.
    hit:  g >= 20 ? 4 : g >= 16 ? 3 : g >= 10 ? 2 : 1,   // Weapon Focus → Greater WF (10) → Weapon Mastery (16) → Weapon Supremacy (20)
    ac:   g >= 14 ? 2 : g >= 2 ? 1 : 0,   // Dodge (2) → Mobility (14)
    hp:   g >= 3 ? Math.max(3, hd) : 0,   // Toughness — +1 HP per Hit Die (min 3)
    dmg:  g >= 16 ? 5 : g >= 12 ? 4 : g >= 4 ? 2 : 0,    // Weapon Spec (4) → Greater (12) → Weapon Mastery (16)
    init: g >= 5 ? 4 : 0,                 // Improved Initiative
    save: g >= 17 ? 4 : g >= 13 ? 3 : g >= 7 ? 2 : g >= 6 ? 1 : 0,   // the save-feat ladder: +1 (6), +2 (7), Great Fortitude (13), Improved Iron Will (17)
    impCrit:   g >= 8,                    // Improved Critical — doubled threat range
    critFocus: g >= 9,                    // Critical Focus — +4 to confirm crits
    critMastery: g >= 19,                 // Critical Mastery — +4 MORE to confirm (+8 total)
    impCleave: g >= 11,                   // Improved Cleave — auto-cleave like the barbarian
    prStrike: g >= 18 ? 10 : g >= 15 ? 5 : 0,   // Penetrating Strike (15) / Greater (18) — ignore 5/10 of a foe's DR
    supremacy: g >= 20,                   // Weapon Supremacy — never caught flat-footed
    // Two-weapon feats (only matter to dual-wielders — harmless on a single weapon):
    twf:   g >= 2,                        // Two-Weapon Fighting — dual penalty −6 → −2
    twDef: g >= 4,                        // Two-Weapon Defense — +1 AC while two-weapon fighting
    itwf:  g >= 6,                        // Improved Two-Weapon Fighting — a 2nd off-hand swing (−5)
  };
}
// FIGHTER takes one bonus feat per level (g = level). The INQUISITOR earns the
// SAME ladder at HALF rate — a feat every ODD level (g = floor((level+1)/2)) — so
// L1 Weapon Focus, L3 Dodge, L5 Toughness, L7 Weapon Spec, L9 Improved Init,
// L11/13 the save feats (incl. Iron Will), L15 Improved Crit, L17 Critical Focus.
// PALADIN home-rule bonus-feat tree — one fighter feat every ODD level, in a
// paladin-flavored order: 1 Toughness, 3 Power Attack (a toggle ability granted
// via the kit, not a passive bonus here), then the rest of the fighter ladder.
// `n` = feats earned so far = ceil(level/2) (L1→1, L3→2, L5→3, L7→4 …).
function paladinFeats(level) {
  const L = Math.max(1, level || 1);
  const n = Math.ceil(L / 2);
  const f = { ...FF_NONE };
  if (n >= 1) f.hp = Math.max(3, L);   // Toughness
  // n >= 2 → Power Attack (kit toggle, minLevel 3) — no passive bonus here
  if (n >= 3) f.hit = 1;               // Weapon Focus
  if (n >= 4) f.ac = 1;                // Dodge
  if (n >= 5) f.dmg = 2;               // Weapon Specialization
  if (n >= 6) f.init = 4;              // Improved Initiative
  if (n >= 7) f.save = 2;              // a save feat (+2)
  if (n >= 8) f.impCrit = true;        // Improved Critical
  if (n >= 9) f.critFocus = true;      // Critical Focus
  if (n >= 10) f.impCleave = true;     // Improved Cleave
  return f;
}
// DRUID bonus-feat tree — one feat every ODD level (n = ceil(level/2)): 1 Toughness,
// 3 Weapon Focus (all), 5 Improved Initiative, 7 Dodge, 9 Improved Natural Weapon
// (steps the dice of their form's claws/bite up one size — see stepDamage).
function druidFeats(level) {
  const L = Math.max(1, level || 1);
  const n = Math.ceil(L / 2);
  const f = { ...FF_NONE };
  if (n >= 1) f.hp  = Math.max(3, L);   // Toughness
  if (n >= 2) f.hit = 1;                // Weapon Focus (all weapons)
  if (n >= 3) f.init = 4;               // Improved Initiative
  if (n >= 4) f.ac  = 1;                // Dodge
  if (n >= 5) f.inw = true;             // Improved Natural Weapon (+1 die step on natural attacks)
  return f;
}
// CASTER (wizard / sorcerer / witch) bonus-feat tree — a feat every ODD level
// (n = ceil(level/2)), in the user's order: Toughness, Improved Initiative, Combat
// Casting, Spell Focus (+2 DC), Spell Penetration, Intensify, Empower, Greater
// Spell Focus (+2 more → +4 DC total), Maximize, Quicken. The metamagic DAMAGE
// effects (intensify/empower/maximize/quicken), Combat Casting and Spell
// Penetration are flagged here and consumed by the spell-damage / SR paths.
function casterFeats(level) {
  const L = Math.max(1, level || 1);
  const n = Math.ceil(L / 2);
  const f = { ...FF_NONE };
  if (n >= 1) f.hp = Math.max(3, L);     // Toughness — +1 HP per Hit Die (min 3)
  if (n >= 2) f.init = 4;                // Improved Initiative
  if (n >= 3) f.combatCasting = true;    // Combat Casting — cast defensively / while threatened
  if (n >= 4) f.spellDC = 2;             // Spell Focus — +2 to all spell save DCs
  if (n >= 5) f.spellPen = 2;            // Spell Penetration — +2 on caster checks vs SR
  if (n >= 6) f.intensify = true;        // Intensified Spell — raise the damage cap
  if (n >= 7) f.empower = true;          // Empower Spell — ×1.5 spell damage
  if (n >= 8) f.spellDC = 4;             // Greater Spell Focus — +2 more (→ +4 DC total)
  if (n >= 9) f.maximize = true;         // Maximize Spell — max damage dice
  if (n >= 10) f.quicken = true;         // Quicken Spell — a 2nd (swift) cast each turn
  return f;
}
// ── Class feat trees (user-approved 2026-06-10) — one feat every ODD level
// (n = ceil(level/2)) for each. Weapon Finesse / Slashing Grace / Power Attack /
// Deadly Aim are house-rule FREEBIES for everyone, so no tree spends a slot on them.
// ROGUE — TWF from LEVEL 1 (dagger/kukri dual-wield drops −6/−6 → −2/−2), then
// initiative (act first → sneak the flat-footed), defense, crits.
function rogueFeats(level) {
  const L = Math.max(1, level || 1), n = Math.ceil(L / 2), f = { ...FF_NONE };
  if (n >= 1) f.twf = true;             // Two-Weapon Fighting — dual penalty −6 → −2
  if (n >= 2) f.hit = 1;                // Weapon Focus
  if (n >= 3) f.init = 4;               // Improved Initiative
  if (n >= 4) f.ac = 1;                 // Dodge
  if (n >= 5) f.hp = Math.max(3, L);    // Toughness
  if (n >= 6) f.save = 1;               // Lightning Reflexes
  if (n >= 7) f.impCrit = true;         // Improved Critical
  if (n >= 8) f.offDef = true;          // Offensive Defense — +2 AC after landing a sneak attack
  if (n >= 9) f.save = 2;               // Iron Will
  if (n >= 10) f.critFocus = true;      // Critical Focus
  if (n >= 5) f.itwf = true;            // Improved TWF rides along at L9+ (2nd off-hand at −5)
  return f;
}
// MONK — Improved Unarmed Strike + Stunning Fist are FREE class features (the kit
// + unarmed dice scaling in _swingVsAC); Flurry of Blows = always two strikes at
// −2/−2 (twf, via _isDualWielding). The tree fills in the fighter staples.
function monkFeats(level) {
  const L = Math.max(1, level || 1), n = Math.ceil(L / 2), f = { ...FF_NONE };
  f.twf = true;                         // Flurry of Blows — free from level 1
  if (L >= 8) f.itwf = true;            // Flurry's 2nd extra blow at L8+ (BAB 6)
  if (n >= 1) f.hit = 1;                // Weapon Focus
  if (n >= 2) f.ac = 1;                 // Dodge
  if (n >= 3) f.hp = Math.max(3, L);    // Toughness
  if (n >= 4) f.init = 4;               // Improved Initiative
  if (n >= 5) f.dmg = 2;                // Weapon Specialization
  if (n >= 6) f.save = 1;               // Lightning Reflexes
  if (n >= 7) f.impCrit = true;         // Improved Critical
  if (n >= 8) f.save = 2;               // Iron Will
  if (n >= 9) f.save = 3;               // Great Fortitude
  if (n >= 10) f.critFocus = true;      // Critical Focus
  return f;
}
// MAGUS — gish: steel early, then the METAMAGIC core (Intensify L7 / Empower L9 /
// Maximize L11 — all three by L12, per the user), then back to steel.
function magusFeats(level) {
  const L = Math.max(1, level || 1), n = Math.ceil(L / 2), f = { ...FF_NONE };
  if (n >= 1) f.hit = 1;                // Weapon Focus
  if (n >= 2) f.hp = Math.max(3, L);    // Toughness
  if (n >= 3) f.spellDC = 2;            // Spell Focus
  if (n >= 4) f.intensify = true;       // Intensified Spell — +5 to the damage-dice cap
  if (n >= 5) f.empower = true;         // Empower Spell — ×1.5 spell damage
  if (n >= 6) f.maximize = true;        // Maximize Spell — max damage dice
  if (n >= 7) f.impCrit = true;         // Improved Critical
  if (n >= 8) f.spellDC = 4;            // Greater Spell Focus
  if (n >= 9) f.dmg = 2;                // Weapon Specialization
  if (n >= 10) f.critFocus = true;      // Critical Focus
  return f;
}
// CLERIC — battle-priest: hardy, fights, juices spell DCs, then QUICKEN CHANNEL
// (first party-heal channel each room is a swift action — see _useAbility).
function clericFeats(level) {
  const L = Math.max(1, level || 1), n = Math.ceil(L / 2), f = { ...FF_NONE };
  if (n >= 1) f.hp = Math.max(3, L);    // Toughness
  if (n >= 2) f.hit = 1;                // Weapon Focus
  if (n >= 3) f.combatCasting = true;   // Combat Casting
  if (n >= 4) f.spellDC = 2;            // Spell Focus
  if (n >= 5) f.init = 4;               // Improved Initiative
  if (n >= 6) f.ac = 1;                 // Heavy Armor Mastery (+1 AC)
  if (n >= 7) f.spellDC = 4;            // Greater Spell Focus
  if (n >= 8) f.quickChannel = true;    // Quicken Channel — 1st channel/room is swift
  if (n >= 9) f.save = 2;               // Iron Will
  if (n >= 10) f.impCrit = true;        // Improved Critical
  return f;
}
// ORACLE — CHA divine caster: mirrors the cleric but leans caster.
function oracleFeats(level) {
  const L = Math.max(1, level || 1), n = Math.ceil(L / 2), f = { ...FF_NONE };
  if (n >= 1) f.hp = Math.max(3, L);    // Toughness
  if (n >= 2) f.combatCasting = true;   // Combat Casting
  if (n >= 3) f.spellDC = 2;            // Spell Focus
  if (n >= 4) f.init = 4;               // Improved Initiative
  if (n >= 5) f.spellPen = 2;           // Spell Penetration
  if (n >= 6) f.spellDC = 4;            // Greater Spell Focus
  if (n >= 7) f.save = 1;               // Lightning Reflexes
  if (n >= 8) f.save = 2;               // Iron Will
  if (n >= 9) f.quicken = true;         // Quicken Spell (flagged; wiring later, same as wizard)
  if (n >= 10) f.save = 3;              // Great Fortitude
  return f;
}
// BARD — support gish (Lingering Performance dropped per the user).
function bardFeats(level) {
  const L = Math.max(1, level || 1), n = Math.ceil(L / 2), f = { ...FF_NONE };
  if (n >= 1) f.hit = 1;                // Weapon Focus
  if (n >= 2) f.hp = Math.max(3, L);    // Toughness
  if (n >= 3) f.spellDC = 2;            // Spell Focus (juices Fascinate/control DCs)
  if (n >= 4) f.ac = 1;                 // Dodge
  if (n >= 5) f.init = 4;               // Improved Initiative
  if (n >= 6) f.impCrit = true;         // Improved Critical
  if (n >= 7) f.spellDC = 4;            // Greater Spell Focus
  if (n >= 8) f.save = 1;               // Lightning Reflexes
  if (n >= 9) f.save = 2;               // Iron Will
  if (n >= 10) f.dmg = 2;               // Weapon Specialization
  return f;
}
// SWASHBUCKLER — Weapon Focus/Spec, Precise Strike and Improved Critical (L5) are
// FREE class passives with a finesse blade (see the swashFin block in _swingVsAC);
// this tree layers mostly-fighter feats that DON'T duplicate them. Greater Weapon
// Focus/Spec stack legitimately on the passives (real PF1 feats).
function swashFeats(level) {
  const L = Math.max(1, level || 1), n = Math.ceil(L / 2), f = { ...FF_NONE };
  if (n >= 1) f.ac = 1;                 // Dodge
  if (n >= 2) f.hp = Math.max(3, L);    // Toughness
  if (n >= 3) f.init = 4;               // Improved Initiative
  if (n >= 4) f.save = 1;               // Lightning Reflexes
  if (n >= 5) f.save = 2;               // Iron Will
  if (n >= 6) f.critFocus = true;       // Critical Focus
  if (n >= 7) f.save = 3;               // Great Fortitude
  if (n >= 8) f.hit = 1;                // Greater Weapon Focus (stacks with the passive)
  if (n >= 9) f.dmg = 2;                // Greater Weapon Specialization (stacks with the passive)
  return f;
}
// GUNSLINGER feat tree — one feat every ODD level (n = ceil(level/2)), front-loaded
// with the user's four: Weapon Focus, Rapid Shot, Bullseye, Weapon Specialization
// (all four by L7). Gun Training (DEX to hit & damage with firearms) is the house
// baseline already; Deadly Aim is a universal freebie.
function gunslingerFeats(level) {
  const L = Math.max(1, level || 1), n = Math.ceil(L / 2), f = { ...FF_NONE };
  if (n >= 1) f.hit = 1;                // Weapon Focus
  if (n >= 2) f.rapidShot = true;       // Rapid Shot — extra shot each full attack, −2 to all (repeating firearms)
  if (n >= 3) f.bullseye = true;        // Bullseye Shot (the kit ability carries the +4 shot)
  if (n >= 4) f.dmg = 2;                // Weapon Specialization
  if (n >= 5) f.pbs = 1;                // Point Blank Shot
  if (n >= 6) f.hp = Math.max(3, L);    // Toughness
  if (n >= 7) f.impCrit = true;         // Improved Critical
  if (n >= 8) f.hit = 2;                // Greater Weapon Focus
  if (n >= 9) f.dmg = 4;                // Greater Weapon Specialization
  if (n >= 10) f.critFocus = true;      // Critical Focus
  return f;
}
// RANGED feat tree — used by any feat-class (fighter / ranger / barbarian /
// inquisitor) wielding a BOW or CROSSBOW, in the user's order: Weapon Focus,
// Point Blank Shot, Rapid Shot, Bullseye Shot, Toughness, Improved Critical,
// Lightning Reflexes, Iron Will, Great Fortitude. (Rapid Shot / Bullseye extra
// SHOTS are flagged here; their extra-attack effects wire with the attack loop.)
function rangedFeats(g, hd) {
  return {
    ...FF_NONE,
    // FULL 20-feat RANGED ladder — a bow fighter explores the whole thing.
    hit:  g >= 20 ? 4 : g >= 13 ? 3 : g >= 11 ? 2 : 1,   // Weapon Focus → Greater WF (11) → Improved Precise Shot (13) → Weapon Supremacy (20)
    pbs:  g >= 2 ? 1 : 0,                 // Point Blank Shot — +1 to hit & damage with ranged
    rapidShot: g >= 3,                    // Rapid Shot — an extra shot every full attack, −2 to ALL shots (wired in _attackOffsets)
    bullseye:  g >= 4,                    // Bullseye Shot — a focused, accurate shot
    hp:   g >= 5 ? Math.max(3, hd) : 0,   // Toughness — +1 HP per Hit Die (min 3)
    impCrit:   g >= 6,                    // Improved Critical — doubled threat range
    save: g >= 9 ? 3 : g >= 8 ? 2 : g >= 7 ? 1 : 0,   // Lightning Reflexes / Iron Will / Great Fortitude
    dmg:  g >= 14 ? 4 : g >= 10 ? 2 : 0,  // Weapon Specialization (10) → Greater (14)
    manyshot: g >= 12,                    // Manyshot — a 2nd arrow at FULL BAB each full attack (BOWS only)
    critFocus: g >= 16,                   // Critical Focus — +4 to confirm
    ac:   g >= 17 ? 1 : 0,                // Dodge
    prStrike: g >= 18 ? 10 : g >= 15 ? 5 : 0,   // Penetrating Strike (15) / Greater (18) — ignore 5/10 DR
    init: g >= 19 ? 4 : 0,                // Improved Initiative
    supremacy: g >= 20,                   // Weapon Supremacy — never caught flat-footed
  };
}
// `ranged` true → the martial classes use the RANGED ladder instead of melee.
function fighterFeats(cls, level, ranged) {
  const L = Math.max(1, level || 1);
  if (cls === 'wizard' || cls === 'sorcerer' || cls === 'witch') return casterFeats(L);
  if (cls === 'druid')      return druidFeats(L);
  if (cls === 'paladin' || cls === 'antipaladin') return paladinFeats(L);   // antipaladin uses the paladin feat tree
  if (cls === 'gunslinger')   return gunslingerFeats(L);
  if (cls === 'rogue')        return rogueFeats(L);
  if (cls === 'monk')         return monkFeats(L);
  if (cls === 'magus')        return magusFeats(L);
  if (cls === 'cleric')       return clericFeats(L);
  if (cls === 'oracle')       return oracleFeats(L);
  if (cls === 'bard')         return bardFeats(L);
  if (cls === 'swashbuckler') return swashFeats(L);
  const ladder = ranged ? rangedFeats : featLadder;
  if (cls === 'fighter')    return ladder(L, L);
  if (cls === 'inquisitor' || cls === 'barbarian' || cls === 'ranger') return ladder(Math.floor((L + 1) / 2), L);
  return FF_NONE;
}
// Bane's flat bonuses (the +2d6 rides on top, not crit-multiplied). See _abBane.
const BANE_TOHIT = 2, BANE_DMG = 2, BANE_DICE = 2;
// Title-case a creature type for display ("magical beast" → "Magical Beast").
function titleCase(s) { return String(s || '').replace(/\b\w/g, c => c.toUpperCase()); }
// Undead & constructs are immune to mind-affecting magic — sleep, fascinate, hold
// person, hideous laughter (PF1: no mind to affect / no Con).
const MIND_IMMUNE_TYPES = new Set(['undead', 'construct']);
function mindImmune(e) { return !!e && MIND_IMMUNE_TYPES.has(e.type); }
// "Already taken out of the fight" by crowd control — don't waste fresh CC on them
// (asleep / fascinated / held / prone / stunned). Used to target CC intelligently.
function ccd(o) { return !!o && (o.asleep || o.fascinated || (o.paralyzed > 0) || o.prone || (o.stunned > 0)); }
// A "finessable" melee weapon (light, or a one-handed fencing blade) — what a
// swashbuckler's Precise Strike, Weapon Focus/Specialization and Improved
// Critical key off of.
const FINESSE_KEYS = new Set(['rapier', 'scimitar', 'shortsword', 'dagger', 'kukri', 'cutlass', 'estoc', 'sword_cane', 'starknife', 'sap', 'radiance', 'curator']);
function isFinesseWeapon(w) { return !!w && !w.ranged && (w.cat === 'light' || FINESSE_KEYS.has(w.key)); }
function maxHpFor(cls, level) { return hdFor(cls) * Math.max(1, level || 1) + fighterFeats(cls, level).hp; }
// Level now comes from XP (see pf1data/xp.js), NOT from gear. The gating level at
// which fighter/inquisitor earn each bonus feat (fighter: every level; inquisitor:
// every odd level) — used to NAME the feat gained on a level-up announcement.
const ODD_FEAT_CLASSES = new Set(['paladin', 'antipaladin', 'druid', 'wizard', 'sorcerer', 'witch', 'rogue', 'monk', 'magus', 'cleric', 'oracle', 'bard', 'swashbuckler', 'gunslinger']);
function gatingLevel(cls, L) { return cls === 'fighter' ? L : (cls === 'inquisitor' || cls === 'barbarian' || cls === 'ranger') ? Math.floor((L + 1) / 2) : ODD_FEAT_CLASSES.has(cls) ? Math.ceil(L / 2) : 0; }
const FEAT_AT = {
  1: 'Weapon Focus (+1 to hit)', 2: 'Dodge (+1 AC)', 3: 'Toughness (+HP)', 4: 'Weapon Specialization (+2 dmg)',
  5: 'Improved Initiative', 6: 'a save feat (+1 saves)', 7: 'a save feat (+2 saves)',
  8: 'Improved Critical', 9: 'Critical Focus', 10: 'Greater Weapon Focus (+2 to hit total)', 11: 'Improved Cleave',
  12: 'Greater Weapon Specialization (+4 dmg total)', 13: 'Great Fortitude (+3 saves)', 14: 'Mobility (+2 AC total)',
  15: 'Penetrating Strike (ignore 5 DR)', 16: 'Weapon Mastery (+1 hit & +1 dmg)', 17: 'Improved Iron Will (+4 saves)',
  18: 'Greater Penetrating Strike (ignore 10 DR)', 19: 'Critical Mastery (+8 to confirm)', 20: 'Weapon Supremacy (never flat-footed, +1 hit)',
};
// Paladin's reordered tree (by feat index n). Index 2 (Power Attack) is omitted
// here — it's a kit toggle (minLevel 3) and gets announced via the ability path.
const PALADIN_FEAT_AT = {
  1: 'Toughness (+HP)', 3: 'Weapon Focus (+1 to hit)', 4: 'Dodge (+1 AC)',
  5: 'Weapon Specialization (+2 dmg)', 6: 'Improved Initiative', 7: 'a save feat (+2 saves)',
  8: 'Improved Critical', 9: 'Critical Focus', 10: 'Improved Cleave',
};
// Druid's feat tree (by feat index n = ceil(level/2)): Toughness, Weapon Focus,
// Improved Initiative, Dodge, Improved Natural Weapon.
const DRUID_FEAT_AT = {
  1: 'Toughness (+HP)', 2: 'Weapon Focus (+1 to hit)', 3: 'Improved Initiative',
  4: 'Dodge (+1 AC)', 5: 'Improved Natural Weapon (bigger claws)',
};
// Caster tree (wizard/sorcerer/witch), by feat index n = ceil(level/2).
const CASTER_FEAT_AT = {
  1: 'Toughness (+HP)', 2: 'Improved Initiative', 3: 'Combat Casting', 4: 'Spell Focus (+2 spell DC)',
  5: 'Spell Penetration', 6: 'Intensified Spell (raise damage cap)', 7: 'Empower Spell (×1.5 damage)',
  8: 'Greater Spell Focus (+4 spell DC total)', 9: 'Maximize Spell (max dice)', 10: 'Quicken Spell (2nd cast)',
};
// Ranged tree (any feat-class with a bow/crossbow), by feat index.
const RANGED_FEAT_AT = {
  1: 'Weapon Focus (+1 to hit)', 2: 'Point Blank Shot (+1 hit & dmg)', 3: 'Rapid Shot (extra shot each turn, −2 to all)',
  4: 'Bullseye Shot', 5: 'Toughness (+HP)', 6: 'Improved Critical', 7: 'Lightning Reflexes (+1 saves)',
  8: 'Iron Will (+2 saves)', 9: 'Great Fortitude (+3 saves)', 10: 'Weapon Specialization (+2 dmg)',
  11: 'Greater Weapon Focus (+2 to hit total)', 12: 'Manyshot (2nd arrow at full BAB — bows)',
  13: 'Improved Precise Shot (+1 to hit)', 14: 'Greater Weapon Specialization (+4 dmg total)',
  15: 'Penetrating Strike (ignore 5 DR)', 16: 'Critical Focus (+4 to confirm)', 17: 'Dodge (+1 AC)',
  18: 'Greater Penetrating Strike (ignore 10 DR)', 19: 'Improved Initiative', 20: 'Weapon Supremacy (never flat-footed, +1 hit)',
};
// Level-up announce tables for the class trees (by feat index n = ceil(level/2)).
const ROGUE_FEAT_AT = {
  1: 'Two-Weapon Fighting (dual −2/−2)', 2: 'Weapon Focus (+1 to hit)', 3: 'Improved Initiative',
  4: 'Dodge (+1 AC)', 5: 'Toughness (+HP) & Improved TWF (2nd off-hand swing)', 6: 'Lightning Reflexes (+1 saves)',
  7: 'Improved Critical', 8: 'Offensive Defense (+2 AC after a sneak attack)', 9: 'Iron Will (+2 saves)', 10: 'Critical Focus',
};
const MONK_FEAT_AT = {
  1: 'Weapon Focus (+1 to hit)', 2: 'Dodge (+1 AC)', 3: 'Toughness (+HP)', 4: 'Improved Initiative',
  5: 'Weapon Specialization (+2 dmg)', 6: 'Lightning Reflexes (+1 saves)', 7: 'Improved Critical',
  8: 'Iron Will (+2 saves)', 9: 'Great Fortitude (+3 saves)', 10: 'Critical Focus',
};
const MAGUS_FEAT_AT = {
  1: 'Weapon Focus (+1 to hit)', 2: 'Toughness (+HP)', 3: 'Spell Focus (+2 spell DC)',
  4: 'Intensified Spell (raise damage cap)', 5: 'Empower Spell (×1.5 spell damage)', 6: 'Maximize Spell (max dice)',
  7: 'Improved Critical', 8: 'Greater Spell Focus (+4 spell DC total)', 9: 'Weapon Specialization (+2 dmg)', 10: 'Critical Focus',
};
const CLERIC_FEAT_AT = {
  1: 'Toughness (+HP)', 2: 'Weapon Focus (+1 to hit)', 3: 'Combat Casting', 4: 'Spell Focus (+2 spell DC)',
  5: 'Improved Initiative', 6: 'Heavy Armor Mastery (+1 AC)', 7: 'Greater Spell Focus (+4 spell DC total)',
  8: 'Quicken Channel (1st channel is swift)', 9: 'Iron Will (+2 saves)', 10: 'Improved Critical',
};
const ORACLE_FEAT_AT = {
  1: 'Toughness (+HP)', 2: 'Combat Casting', 3: 'Spell Focus (+2 spell DC)', 4: 'Improved Initiative',
  5: 'Spell Penetration', 6: 'Greater Spell Focus (+4 spell DC total)', 7: 'Lightning Reflexes (+1 saves)',
  8: 'Iron Will (+2 saves)', 9: 'Quicken Spell (2nd cast)', 10: 'Great Fortitude (+3 saves)',
};
const BARD_FEAT_AT = {
  1: 'Weapon Focus (+1 to hit)', 2: 'Toughness (+HP)', 3: 'Spell Focus (+2 spell DC)', 4: 'Dodge (+1 AC)',
  5: 'Improved Initiative', 6: 'Improved Critical', 7: 'Greater Spell Focus (+4 spell DC total)',
  8: 'Lightning Reflexes (+1 saves)', 9: 'Iron Will (+2 saves)', 10: 'Weapon Specialization (+2 dmg)',
};
const SWASH_FEAT_AT = {
  1: 'Dodge (+1 AC)', 2: 'Toughness (+HP)', 3: 'Improved Initiative', 4: 'Lightning Reflexes (+1 saves)',
  5: 'Iron Will (+2 saves)', 6: 'Critical Focus', 7: 'Great Fortitude (+3 saves)',
  8: 'Greater Weapon Focus (+1 more to hit)', 9: 'Greater Weapon Specialization (+2 more dmg)',
};
const GUNSLINGER_FEAT_AT = {
  1: 'Weapon Focus (+1 to hit)', 2: 'Rapid Shot (extra shot each turn, −2 to all)', 3: 'Bullseye Shot (+4 aimed shot)',
  4: 'Weapon Specialization (+2 dmg)', 5: 'Point Blank Shot (+1 hit & dmg)', 6: 'Toughness (+HP)',
  7: 'Improved Critical', 8: 'Greater Weapon Focus (+2 to hit total)', 9: 'Greater Weapon Specialization (+4 dmg total)', 10: 'Critical Focus',
};
const CLASS_FEAT_AT = { rogue: ROGUE_FEAT_AT, monk: MONK_FEAT_AT, magus: MAGUS_FEAT_AT, cleric: CLERIC_FEAT_AT, oracle: ORACLE_FEAT_AT, bard: BARD_FEAT_AT, swashbuckler: SWASH_FEAT_AT, gunslinger: GUNSLINGER_FEAT_AT };
const RANGED_FEAT_CLASSES = new Set(['fighter', 'ranger', 'barbarian', 'inquisitor']);
const LIGHTNING_MAX_TARGETS = 2;
const SICKENED_ROUNDS = 3;
const SICKENED_PENALTY = 2;
const BLIND_ROUNDS = 3;           // Glitterdust — how long a blinded foe stays blind
const PARALYZE_DC = 14;
// A flying creature holds the "high ground" over grounded foes: +1 to hit them,
// +2 AC against their attacks. (Heroes are always grounded.)
const HIGH_GROUND_HIT = 1;
const HIGH_GROUND_AC  = 2;
// We don't roll ability scores — instead every character is assumed to have an 18
// in their attack stat, granting the standard +4 ability modifier to hit AND to
// damage (the latter doubles on a crit, like any static damage mod in PF1e). This
// is the missing "STR/DEX" piece on top of level (BAB-ish) and gear.
const ABILITY_MOD = 4;
// Casting-stat modifier — an 18 Int/Wis/Cha, mirroring the 18 STR/DEX behind
// attacks (ABILITY_MOD). Drives hero spell save DCs; the matching PF1 bonus
// spells live in abilities._tableSlots. Kept separate from ABILITY_MOD so the
// spell stat can diverge from the attack stat later as we approach full PF1.
const CAST_MOD = 4;
// Class conditionals (powered by the alignment / flat-footed tracking).
const SNEAK_CLASSES = new Set(['rogue', 'ninja', 'slayer']);  // gain Sneak Attack
const SNEAK_DICE_CAP = 5;     // cap precision dice so it stays flavorful, not silly
const SMITE_TOHIT    = 2;     // paladin Smite Evil: to-hit bump vs an evil foe (+level dmg)
const AFK_PASS_MS    = 60_000; // idle on your turn → auto-ATTACK after 60s (extra time for screen-reader play)
// AI "decision time" scales with THREAT: 1s + 0.1s per CR for enemies (so a CR-1
// rat snaps in ~1.1s and a CR-10 horror broods ~2s), or per LEVEL for AI allies
// (who have no CR). Clamped to [1s, 5s]. crToNum (hoisted below) parses "1/2" etc.
const aiStepMs = (actor) => {
  let n = 0;
  if (actor) { if (actor.cr != null) n = crToNum(actor.cr); else if (actor.level != null) n = actor.level; }
  return Math.round(Math.max(1000, Math.min(5000, 1000 + n * 100)));
};
const CHAIN_SFX_GAP_MS = 320;  // audible gap between staggered cleave/chain swing sounds
// Signature Spell Strike sounds per magus (keyed by dungeon nickname). Human
// magi (and any unlisted magus) fall back to the spell's default electric zap.
const MAGUS_SPELLSTRIKE_SFX = {
  Kate:    '/audio/spellstrike_boudicca.mp3',     // Kate Blackwood — "boudicca" battle cry
  Vaughan: '/audio/spellstrike_vaughan.mp3',      // Vaughan — Genji-style sword ult
  Toni:    '/audio/spellstrike_toni.mp3',         // Toni — arcane sword-lightning yell
};
const BOSS_EVERY     = 5;
const LOOT_ROLL_MS   = 20_000; // window to roll/pass on a dropped magic item

// Every applied spell/feat buff that should show an icon on a hero's buff strip,
// keyed by the ability key recorded in m.buffApplied / m.runBuffApplied. Each
// needs a matching /dungeon/buffs/<key>.webp. _buffList walks the applied keys,
// so adding a new buff spell is just: give it a kit entry + an icon + a line here.
const BUFF_META = {
  rage:          { label: 'Rage',            desc: '+2 hit & damage, −2 AC (this room)' },
  bane:          { label: 'Bane',            desc: '+2 hit, +2d6+2 vs foes (this room)' },
  divinefavor:   { label: 'Divine Favor',    desc: '+3 hit & damage (this room)' },
  prayer:        { label: 'Prayer',          desc: 'allies +1 hit, damage & saves (this room)' },
  shield:        { label: 'Shield',          desc: '+4 AC (this room)' },
  shieldoffaith: { label: 'Shield of Faith', desc: '+2 deflection AC (this room)' },
  protevil:      { label: 'Protection from Evil', desc: '+2 AC & +2 saves (this room)' },
  magearmor:     { label: 'Mage Armor',      desc: '+4 armor AC (this dungeon)' },
  stoneskin:     { label: 'Stoneskin',       desc: 'DR 10 vs physical blows (this room)' },
  stoneskincomm: { label: 'Stoneskin (Communal)', desc: 'DR 10 vs physical blows — whole party (this room)', icon: '/dungeon/buffs/stoneskin.webp' },
  ironskin:      { label: 'Iron Skin',       desc: 'DR 10 vs physical blows (this room)', icon: '/dungeon/buffs/stoneskin.webp' },
  barkskin:      { label: 'Barkskin',        desc: '+3 natural-armor AC (this room)', icon: '/dungeon/buffs/stoneskin.webp' },
  magicfang:     { label: 'Magic Fang',      desc: '+1 to hit & damage — natural weapons (this room)', icon: '/dungeon/buffs/bullsstrength.webp' },
  catsgrace:     { label: "Cat's Grace",     desc: '+2 AC & +1 to hit — Dexterity (this room)' },
  bullsstrength: { label: "Bull's Strength", desc: '+2 hit & damage — Strength (this room)' },
  bearsendurance:{ label: "Bear's Endurance",desc: '+temporary HP — Constitution (this room)' },
  heroism:       { label: 'Heroism',         desc: '+2 to hit & +2 on saves (this room)' },
  goodhope:      { label: 'Good Hope',       desc: 'allies +2 hit, damage & saves (this room)' },
  deadlyaim:     { label: 'Deadly Aim',      desc: 'trading aim for power — −hit, +damage' },
  powerattack:   { label: 'Power Attack',    desc: 'trading accuracy for power — −hit, +damage' },
  fly:           { label: 'Flying',          desc: 'airborne — grounded foes cannot reach you' },
  protectfire:   { label: 'Fire Ward',       desc: 'fire damage halved (Protection from Fire)' },
  bless:         { label: 'Bless',           desc: '+1 to hit — whole dungeon' },
  inspire:       { label: 'Inspire Courage', desc: 'allies +1 hit & damage — whole dungeon' },
  // ── Magus buffs (icons fall back to fitting existing art) ──
  displacement:  { label: 'Displacement',    desc: '50% of incoming attacks miss (this room)', icon: '/dungeon/buffs/fly.webp' },
  fireshield:    { label: 'Fire Shield',     desc: 'melee attackers scorched for 1d6+level fire (this room)', icon: '/dungeon/buffs/protevil.webp' },
  elementalbody: { label: 'Elemental Body',  desc: 'immune to crits, paralysis, stun, sicken & blind (this room)', icon: '/dungeon/buffs/stoneskin.webp' },
  trueseeing:    { label: 'True Seeing',     desc: 'see through darkness, illusions & invisibility (this room)', icon: '/dungeon/buffs/magearmor.webp' },
  mirrorimage:   { label: 'Mirror Image',    desc: 'shimmering decoys soak incoming attacks', icon: '/dungeon/buffs/fly.webp' },
};

// Bruce-Lee-style martial-arts SFX for enemy Monks — kiai screams, flurries and
// smacks. Picked at random per swing (a different shout every punch); hilarious
// when overheard muffled from up at the poker table.
// Only short kiai (<4s) — longer bruce clips (juggling_fools 4.7s, jumpkick_laugh
// 7.7s, smack_boop 5.4s) dragged on past a single monk strike and were dropped.
const BRUCE_SFX = [
  '/audio/bruce_punch_multi_flurry_rapid_fire.mp3', '/audio/bruce_punch_multi_flurry_thum2p.mp3',
  '/audio/bruce_punch_multi_flurry_thump.mp3', '/audio/bruce_punch_multi_punishing.mp3',
  '/audio/bruce_punch_single_quick.mp3', '/audio/bruce_scream_hoo_hoo_hooo.mp3',
  '/audio/bruce_scream_roar_kick_aftermath.mp3', '/audio/bruce_smack_scream_crash.mp3',
];
// Monk tokens span many races + ages — a random face per spawn so a room of Monks
// is a motley dojo (human/dwarf/orc/half-orc/tiefling/goblin/hobgoblin + cameos).
const MONK_TOKENS = [
  'monk_human_m', 'monk_acolyte', 'monk_tian', 'monk_shaolin_f', 'monk_shaolin_m', 'monk_bald',
  'monk_dwarf', 'monk_tiefling', 'monk_orc', 'monk_halforc_f', 'monk_goblin', 'monk_hobgoblin', 'monk_jackie',
].map(n => `/dungeon/monsters/${n}.webp`).concat(['/dungeon/monsters/monk_bruce.webp']);

// ── Monster bestiary (placeholder art = emoji glyphs) ───────────────────────
// PF1e stat blocks (CR in comment). NO depth scaling — difficulty comes from
// which creatures a depth's BAND can spawn and from designated bosses, not from
// buffing mooks. Our combat model uses one representative attack:
//   damage = dmgCount × d(dmgDie) + dmgBonus   (dmgCount defaults to 1)
//   attacks = number of separate swings per turn (default 1)
const MON = {
  dire_rat:          { name: 'Dire Rat',          glyph: '🐀', cr: '1/3', hp: 5,   ac: 14, toHit: 1,  dmgDie: 4,  dmgBonus: 0, fort: 3,  reflex: 3,  gold: [3, 10], atkSound: '/audio/enemy_badger.mp3' },
  badger:            { name: 'Badger',            glyph: '🦡', cr: '1/2', hp: 6,   ac: 14, toHit: 2,  dmgDie: 3,  dmgBonus: 1, fort: 3,  reflex: 3,  gold: [3, 9], atkSound: '/audio/enemy_badger.mp3' },   // small animal — snarling bite/claw
  giant_centipede:   { name: 'Giant Centipede',   glyph: '🐛', cr: '1/2', hp: 5,   ac: 14, toHit: 2,  dmgDie: 6,  dmgBonus: 0, fort: 1,  reflex: 3,  gold: [3, 10] },
  goblin:            { name: 'Goblin',            glyph: '👺', cr: '1/3', hp: 6,   ac: 16, toHit: 2,  dmgDie: 4,  dmgBonus: 0, fort: 3,  reflex: 2,  gold: [6, 16] },
  kobold:            { name: 'Kobold',            glyph: '🦎', cr: '1/4', hp: 5,   ac: 15, toHit: 1,  dmgDie: 6,  dmgBonus: 0, fort: 2,  reflex: 1,  gold: [6, 14] },
  kobold_spearman:   { name: 'Kobold Spearman',   glyph: '🦎', cr: '1/3', hp: 6,   ac: 15, toHit: 2,  dmgDie: 6,  dmgBonus: 0, fort: 2,  reflex: 1,  gold: [6, 16] },                                            // 1d6 spear
  kobold_shaman:     { name: 'Kobold Shaman',     glyph: '🦎', cr: '1',   hp: 7,   ac: 13, toHit: 0,  dmgDie: 4,  dmgBonus: 0, fort: 2,  reflex: 1,  gold: [12, 26], caster: 'holdperson', spellDC: 13 },          // Hold Person (Will DC 13)
  kobold_rogue:      { name: 'Kobold Rogue',      glyph: '🦎', cr: '1',   hp: 6,   ac: 16, toHit: 2,  dmgDie: 3,  dmgBonus: 0, fort: 1,  reflex: 4,  gold: [10, 24], attacks: 2, sneakDice: 2, evasion: true, atkSound: '/audio/fight_riki.mp3' }, // two 1d3 daggers + sneak attack; Evasion
  goblin_rogue:      { name: 'Goblin Rogue',      glyph: '👺', cr: '1/2', hp: 7,   ac: 15, toHit: 3,  dmgDie: 4,  dmgBonus: 1, fort: 1,  reflex: 5,  gold: [8, 20],  attacks: 1, sneakDice: 2, evasion: true, atkSound: '/audio/fight_riki.mp3' }, // dogslicer + Sneak Attack; Evasion
  goblin_shaman:     { name: 'Goblin Shaman',     glyph: '👺', cr: '1',   hp: 8,   ac: 13, toHit: 1,  dmgDie: 4,  dmgBonus: 0, fort: 2,  reflex: 2,  gold: [12, 26], caster: 'holdperson', spellDC: 13 },          // Hold Person (Will DC 13) — sets up the rogues
  goblin_barbarian:  { name: 'Goblin Barbarian',  glyph: '👺', cr: '1',   hp: 17,  ac: 14, toHit: 4,  dmgDie: 8,  dmgBonus: 4, fort: 4,  reflex: 2,  gold: [12, 28], taunt: { dc: 13, sound: '/audio/taunt_predator_goblin.mp3' } },   // raging goblin — roars a Taunt that pulls AI allies onto it
  skeleton:          { name: 'Skeleton',          glyph: '💀', cr: '1/3', hp: 5,   ac: 16, toHit: 2,  dmgDie: 6,  dmgBonus: 2, fort: 0,  reflex: 1,  gold: [8, 20], dr: { amount: 5, bypass: 'B' } },   // PF1 skeleton — DR 5/bludgeoning (slashing & piercing glance off; a mace crushes)
  giant_spider:      { name: 'Giant Spider',      glyph: '🕷️', cr: '1',   hp: 16,  ac: 14, toHit: 4,  dmgDie: 6,  dmgBonus: 0, fort: 4,  reflex: 4,  gold: [10, 26] },
  zombie:            { name: 'Zombie',            glyph: '🧟', cr: '1/2', hp: 12,  ac: 12, toHit: 4,  dmgDie: 6,  dmgBonus: 4, fort: 0,  reflex: 0,  gold: [10, 26], dr: { amount: 5, bypass: 'S' } },   // PF1 zombie — DR 5/slashing (hack it apart; blunt & piercing barely dent it)
  ghoul:             { name: 'Ghoul',             glyph: '🧛', cr: '1',   hp: 13,  ac: 14, toHit: 3,  dmgDie: 6,  dmgBonus: 1, fort: 1,  reflex: 3,  gold: [14, 32], paralyze: true, paralyzeDC: 13 },
  cultist:           { name: 'Whispering Cultist',glyph: '🕯️', cr: '1',   hp: 14,  ac: 14, toHit: 3,  dmgDie: 8,  dmgBonus: 1, fort: 3,  reflex: 1,  gold: [16, 38] },
  ghast:             { name: 'Ghast',             glyph: '🧟‍♂️', cr: '2', hp: 17,  ac: 17, toHit: 6,  dmgDie: 8,  dmgBonus: 3, fort: 2,  reflex: 5,  gold: [28, 60], paralyze: true, paralyzeDC: 15 },
  monk:              { name: 'Monk',              glyph: '🥋', cr: '2',   hp: 22,  ac: 16, toHit: 4,  dmgDie: 6,  dmgBonus: 2, fort: 4,  reflex: 5,  gold: [18, 42], attacks: 2, evasion: true, tokenPool: MONK_TOKENS, atkSounds: BRUCE_SFX },  // flurry of unarmed strikes; random face + kiai; Evasion
  skeletal_champion: { name: 'Skeletal Champion', glyph: '☠️', cr: '2',   hp: 19,  ac: 17, toHit: 5,  dmgDie: 8,  dmgBonus: 3, fort: 3,  reflex: 2,  gold: [26, 55], dr: { amount: 5, bypass: 'B' }, shout: { dc: 14, sound: '/audio/enemy_draugr_shout.mp3' } },   // DR 5/bludgeoning; bone-rattling shout: 1d8 + Fort or stunned 1
  shadow:            { name: 'Shadow',            glyph: '🌑', cr: '3',   hp: 19,  ac: 13, toHit: 4,  dmgDie: 6,  dmgBonus: 0, fort: 1,  reflex: 3,  gold: [30, 65] },
  fire_skeleton:     { name: 'Fire Skeleton',     glyph: '🔥', cr: '3',   hp: 22,  ac: 16, toHit: 5,  dmgDie: 6,  dmgBonus: 2, fort: 1,  reflex: 2,  gold: [24, 52], dr: { amount: 5, bypass: 'B' }, resist: { fire: 0, cold: 1.5 }, detonate: { count: 2, die: 6, sound: '/audio/enemy_fireskeleton_boom.mp3' } },   // skeleton: DR 5/bludgeoning, fire-immune, VULNERABLE to cold (×1.5); suicide bomber: on its TURN it rushes in and detonates — 1d6 fire/level to 1d2 heroes, destroying itself (kill it first to defuse)
  wight:             { name: 'Wight',             glyph: '👻', cr: '3',   hp: 26,  ac: 15, toHit: 4,  dmgDie: 4,  dmgBonus: 1, fort: 3,  reflex: 1,  gold: [34, 72] },
  ogre:              { name: 'Ogre',              glyph: '👹', cr: '3',   hp: 30,  ac: 17, toHit: 8,  dmgDie: 8,  dmgCount: 2, dmgBonus: 7, fort: 6, reflex: 0, gold: [40, 90] },                                  // greatclub 2d8+7
  gray_ooze:         { name: 'Gray Ooze',         glyph: '🟢', cr: '4',   hp: 50,  ac: 6,  toHit: 5,  dmgDie: 6,  dmgBonus: 4, fort: 6,  reflex: 0,  gold: [38, 80] },
  gibbering_mouther: { name: 'Gibbering Mouther', glyph: '👄', cr: '5',   hp: 60,  ac: 19, toHit: 5,  dmgDie: 4,  dmgBonus: 0, fort: 8,  reflex: 6,  gold: [55, 120], attacks: 2 },                              // many small bites
  ettin:             { name: 'Ettin',             glyph: '👹', cr: '6',   hp: 65,  ac: 18, toHit: 12, dmgDie: 6,  dmgCount: 2, dmgBonus: 6, fort: 9, reflex: 3, attacks: 2, gold: [70, 150] },                    // two morningstars
  // ── Diversity pack: animals, aberrations & other beasts (fills CR 3-8) ──
  dire_ape:          { name: 'Dire Ape',          glyph: '🦍', cr: '3',   hp: 30,  ac: 15, toHit: 7,  dmgDie: 6,  dmgBonus: 5,  fort: 7,  reflex: 5,  attacks: 2, gold: [22, 48] },
  ettercap:          { name: 'Ettercap',          glyph: '🕸️', cr: '3',   hp: 30,  ac: 16, toHit: 5,  dmgDie: 8,  dmgBonus: 3,  fort: 5,  reflex: 5,  attacks: 2, gold: [24, 52] },
  dire_boar:         { name: 'Dire Boar',         glyph: '🐗', cr: '4',   hp: 51,  ac: 15, toHit: 12, dmgDie: 8,  dmgBonus: 12, fort: 9,  reflex: 5,  gold: [34, 72] },                                 // gore 1d8+12
  harpy:             { name: 'Harpy',             glyph: '🦅', cr: '4',   hp: 38,  ac: 15, toHit: 9,  dmgDie: 8,  dmgBonus: 1,  fort: 2,  reflex: 7,  attacks: 2, gold: [34, 72], flying: true },
  gargoyle:          { name: 'Gargoyle',          glyph: '🪨', cr: '4',   hp: 42,  ac: 16, toHit: 9,  dmgDie: 6,  dmgBonus: 4,  fort: 5,  reflex: 6,  attacks: 2, gold: [36, 78], flying: true, dr: { amount: 10, bypass: 'magic' } },   // PF1 gargoyle — DR 10/magic (needs a +1 or signature weapon)
  minotaur:          { name: 'Minotaur',          glyph: '🐂', cr: '4',   hp: 45,  ac: 14, toHit: 9,  dmgDie: 6,  dmgCount: 3, dmgBonus: 6, fort: 6, reflex: 5, gold: [38, 80], atkSound: '/audio/enemy_yak.mp3' },   // greataxe 3d6+6 — angry bovine bellow
  basilisk:          { name: 'Basilisk',          glyph: '🐍', cr: '5',   hp: 52,  ac: 16, toHit: 9,  dmgDie: 8,  dmgBonus: 4,  fort: 7,  reflex: 4,  paralyze: true, paralyzeDC: 13, gold: [42, 90] },  // petrifying gaze → "turned to stone, lose a turn"
  winter_wolf:       { name: 'Winter Wolf',       glyph: '🐺', cr: '5',   hp: 57,  ac: 18, toHit: 11, dmgDie: 8,  dmgBonus: 7,  fort: 9,  reflex: 7,  gold: [44, 95], resist: { cold: 0, fire: 1.5 } },   // PF1: cold-immune, VULNERABLE to fire (×1.5)
  blood_caimon:      { name: 'Blood Caimon',      glyph: '🐊', cr: '5',   hp: 60,  ac: 16, toHit: 11, dmgDie: 10, dmgBonus: 9,  fort: 8,  reflex: 5,  gold: [48, 105], atkSound: '/audio/enemy_caimon_bite.mp3' },   // giant red alligator — savage bite
  wood_golem:        { name: 'Wood Golem',        glyph: '🪵', cr: '6',   hp: 58,  ac: 21, toHit: 10, dmgDie: 8,  dmgCount: 2, dmgBonus: 5, fort: 2, reflex: 2, attacks: 2, gold: [55, 115], dr: { amount: 5, bypass: 'S' }, resist: { fire: 1.5 } },         // two 2d8+5 slams; DR 5/slashing (axes bite the timber); PF1 VULNERABLE to fire (×1.5); golem-poor saves
  bog_brute:         { name: 'Bog Brute',         glyph: '🌿', cr: '6',   hp: 65,  ac: 17, toHit: 12, dmgDie: 8,  dmgBonus: 7,  fort: 9,  reflex: 4,  attacks: 2, gold: [55, 115] },
  dire_bear:         { name: 'Dire Bear',         glyph: '🐻', cr: '7',   hp: 84,  ac: 17, toHit: 16, dmgDie: 8,  dmgBonus: 10, fort: 13, reflex: 9, attacks: 2, gold: [70, 150], art: '/dungeon/monsters/dire_bear.webp' },
  chimera:           { name: 'Chimera',           glyph: '🦁', cr: '7',   hp: 76,  ac: 19, toHit: 11, dmgDie: 8,  dmgBonus: 4,  fort: 10, reflex: 6, attacks: 2, gold: [75, 160], flying: true },
  hill_giant:        { name: 'Hill Giant',        glyph: '🪓', cr: '7',   hp: 85,  ac: 21, toHit: 16, dmgDie: 8,  dmgCount: 2, dmgBonus: 10, fort: 12, reflex: 3, gold: [80, 165] },                   // greatclub 2d8+10
  medusa:            { name: 'Medusa',            glyph: '🐍', cr: '7',   hp: 76,  ac: 15, toHit: 9,  dmgDie: 4,  dmgBonus: 2,  fort: 6,  reflex: 8,  attacks: 2, paralyze: true, paralyzeDC: 15, gold: [80, 165] },  // petrifying gaze
  stone_giant:       { name: 'Stone Giant',       glyph: '🗿', cr: '8',   hp: 102, ac: 24, toHit: 17, dmgDie: 8,  dmgCount: 2, dmgBonus: 12, fort: 12, reflex: 5, gold: [95, 190] },                  // greatclub 2d8+12
  abyssal_horror:    { name: 'Abyssal Horror',    glyph: '🐙', cr: '8',   hp: 95,  ac: 19, toHit: 14, dmgDie: 8,  dmgBonus: 6,  fort: 9,  reflex: 6,  attacks: 2, gold: [95, 190] },                  // eldritch chaos beast
  brass_golem:       { name: 'Brass Golem',       glyph: '🗿', cr: '9',   hp: 92,  ac: 24, toHit: 14, dmgDie: 10, dmgCount: 2, dmgBonus: 9, fort: 3, reflex: 3, attacks: 2, gold: [180, 320], dr: { amount: 10, bypass: '—' } },                  // 8-HD construct, two 2d10+9 slams; DR 10/— (forged metal — only adamantine would bite, which no one carries)
  barbed_devil:      { name: 'Barbed Devil',      glyph: '😈', cr: '11',  hp: 138, ac: 26, toHit: 18, dmgDie: 8,  dmgCount: 2, dmgBonus: 7, fort: 12, reflex: 9, attacks: 2, gold: [260, 460],
                       dr: { amount: 10, bypass: 'magic' }, resist: { fire: 0, cold: 10, acid: 10 },   // PF1 barbed devil — DR 10/good (modelled as /magic, no alignment weapons here); immune fire, resist cold/acid
                       atkSounds: ['/audio/slorr_sever.mp3', '/audio/slorr_crush.mp3', '/audio/slorr_fury.mp3'],   // Slorr voicelines on its barbed claws
                       hook: { dmgDie: 8, dmgCount: 2, dmgBonus: 7, constrict: 14, sound: '/audio/slorr_grapple.mp3' },   // chain hook → grapple the weakest hero, then constrict each turn
                       hellfire: { count: 3, dice: 5, die: 6, dc: 19, sound: '/audio/spell_hellfire.mp3' } },           // Hellfire Blast — fire AoE, Reflex for half

  vampire:           { name: 'Vampire',           glyph: '🧛', cr: '8',   hp: 95,  ac: 22, toHit: 14, dmgDie: 6,  dmgBonus: 8, fort: 8,  reflex: 11, attacks: 2, gold: [100, 200], dr: { amount: 10, bypass: 'magic' }, evil: true, shout: { fear: true, dc: 18, sound: '/audio/enemy_lich_gaze.mp3' }, spellstrike: { dice: 4, die: 6, dtype: 'negative', lifesteal: true, sound: '/audio/spell_umbral_bolt.mp3' } },   // magus of its level: dominating gaze + Vampiric Touch spellstrike (drains life)
  lich:              { name: 'Lich',              glyph: '💀', cr: '12',  hp: 138, ac: 25, toHit: 16, dmgDie: 8,  dmgBonus: 5, fort: 10, reflex: 9,  gold: [300, 520], dr: { amount: 15, bypass: 'B' }, evil: true, shout: { fear: true, dc: 20, sound: '/audio/enemy_lich_gaze.mp3' }, arcane: true },                 // a full wizard of its level: Hold Monster, Fireball/Cone/Chain Lightning, Disintegrate, Finger of Death, Magic Missile (see _lichCast)

  // ── THE VAMPIRE COURT — classed vampires (PF1 vampire template: DR 10/magic,
  //    undead = mind-immune). CR ≈ class level + 1 for the template. ──
  vampire_spawn:     { name: 'Vampire Spawn',     glyph: '🧛', cr: '4',   hp: 26,  ac: 15, toHit: 7,  dmgDie: 6,  dmgBonus: 4,  fort: 3,  reflex: 5,  gold: [36, 78],   type: 'undead', evil: true, dr: { amount: 5,  bypass: 'magic' } },
  vamp_knight:       { name: 'Vampire Knight',    glyph: '🧛', cr: '9',   hp: 100, ac: 23, toHit: 15, dmgDie: 8,  dmgBonus: 8,  fort: 9,  reflex: 7,  attacks: 2, gold: [110, 220], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' } },   // F8 + vampire
  vamp_inquisitor:   { name: 'Vampire Inquisitor',glyph: '🧛', cr: '10',  hp: 105, ac: 22, toHit: 15, dmgDie: 8,  dmgBonus: 7,  fort: 9,  reflex: 7,  attacks: 2, gold: [120, 240], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' }, shout: { fear: true, dc: 17, sound: '/audio/enemy_lich_gaze.mp3' } },   // I9 + vampire — dread judgment
  vamp_rogue:        { name: 'Vampire Rogue',     glyph: '🧛', cr: '10',  hp: 95,  ac: 23, toHit: 15, dmgDie: 6,  dmgBonus: 6,  fort: 6,  reflex: 11, attacks: 2, sneakDice: 5, evasion: true, gold: [120, 240], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' } },   // R9 + vampire
  vamp_scout:        { name: 'Vampire Scout',     glyph: '🧛', cr: '11',  hp: 105, ac: 24, toHit: 16, dmgDie: 6,  dmgBonus: 6,  fort: 6,  reflex: 12, attacks: 2, sneakDice: 5, evasion: true, gold: [130, 260], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' } },   // R10 + vampire
  vamp_warrior:      { name: 'Vampire Warrior',   glyph: '🧛', cr: '11',  hp: 120, ac: 24, toHit: 17, dmgDie: 8,  dmgBonus: 9,  fort: 10, reflex: 8,  attacks: 2, gold: [130, 260], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' } },   // F10 + vampire
  vamp_bodyguard:    { name: 'Vampire Bodyguard', glyph: '🧛', cr: '13',  hp: 140, ac: 26, toHit: 19, dmgDie: 8,  dmgBonus: 10, fort: 11, reflex: 9,  attacks: 2, gold: [170, 320], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' } },   // F12 + vampire
  vamp_priest:       { name: 'Vampire Priest',    glyph: '🧛', cr: '13',  hp: 130, ac: 25, toHit: 17, dmgDie: 8,  dmgBonus: 8,  fort: 11, reflex: 8,  attacks: 2, gold: [170, 320], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' }, shout: { fear: true, dc: 19, sound: '/audio/enemy_lich_gaze.mp3' } },   // C12 + vampire — profane litany
  vamp_assassin:     { name: 'Vampire Assassin',  glyph: '🧛', cr: '14',  hp: 140, ac: 27, toHit: 19, dmgDie: 6,  dmgBonus: 8,  fort: 8,  reflex: 13, attacks: 2, sneakDice: 7, evasion: true, gold: [190, 360], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' } },   // R13 + vampire
  vamp_nightguard:   { name: 'Vampire Nightguard',glyph: '🧛', cr: '14',  hp: 160, ac: 27, toHit: 21, dmgDie: 6,  dmgCount: 2, dmgBonus: 10, fort: 12, reflex: 9, attacks: 2, gold: [190, 360], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' } },   // F14 + vampire — polearm sweeps (2d6+10)
  vamp_noble:        { name: 'Vampire Noble',     glyph: '🧛', cr: '15',  hp: 160, ac: 27, toHit: 20, dmgDie: 8,  dmgBonus: 9,  fort: 11, reflex: 11, attacks: 2, gold: [220, 420], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' }, shout: { fear: true, dc: 21, sound: '/audio/enemy_lich_gaze.mp3' }, spellstrike: { dice: 5, die: 6, dtype: 'negative', lifesteal: true, sound: '/audio/spell_umbral_bolt.mp3' } },   // Mag14 + vampire — Vampiric Touch spellstrikes
  vamp_techwitch:    { name: 'Vampire Tech Witch',glyph: '🧛', cr: '12',  hp: 110, ac: 22, toHit: 12, dmgDie: 6,  dmgBonus: 4,  fort: 8,  reflex: 8,  gold: [150, 300], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' }, arcane: true },   // W11 + vampire — Technic League arcanist, full wizard casting
  // ── TECHNIC LEAGUE & THRUNE — named villains ──
  zernibeth:         { name: 'Zernibeth',         glyph: '🤖', cr: '13',  hp: 120, ac: 24, toHit: 12, dmgDie: 6,  dmgBonus: 4,  fort: 9,  reflex: 9,  gold: [280, 480], evil: true, arcane: true },   // android W14 of the Technic League (LE) — full wizard casting
  barzillai:         { name: 'Barzillai Thrune',  glyph: '😈', cr: '15',  hp: 220, ac: 28, toHit: 22, dmgDie: 6,  dmgCount: 2, dmgBonus: 12, fort: 14, reflex: 9, attacks: 2, gold: [340, 580], evil: true, shout: { fear: true, dc: 22, sound: '/audio/enemy_lich_gaze.mp3' } },   // I16 inquisitor of Asmodeus — greathammer (2d6+12), a deep-room villain
  abrogail:          { name: 'Abrogail Thrune II',glyph: '👑', cr: '16',  hp: 200, ac: 27, toHit: 14, dmgDie: 4,  dmgBonus: 4,  fort: 11, reflex: 12, gold: [400, 700], evil: true, arcane: true, shout: { fear: true, dc: 23, sound: '/audio/enemy_lich_gaze.mp3' }, art: '/dungeon/monsters/abrogail.png' },   // S17 — Queen of Cheliax, full arcane barrage
  // ── THE INFERNAL COURT — classed devils (devil template: DR 10/magic, fire-immune,
  //    resist cold & acid). ──
  devil_swordsman:   { name: 'Devil Swordsman',   glyph: '😈', cr: '11',  hp: 125, ac: 25, toHit: 17, dmgDie: 8,  dmgBonus: 9,  fort: 11, reflex: 9,  attacks: 2, gold: [130, 260], evil: true, dr: { amount: 10, bypass: 'magic' }, resist: { fire: 0, cold: 0.5, acid: 0.5 } },   // F10 + devil — katana
  devil_samurai:     { name: 'Devil Samurai',     glyph: '😈', cr: '13',  hp: 145, ac: 26, toHit: 19, dmgDie: 6,  dmgCount: 2, dmgBonus: 9, fort: 12, reflex: 10, attacks: 2, gold: [170, 320], evil: true, dr: { amount: 10, bypass: 'magic' }, resist: { fire: 0, cold: 0.5, acid: 0.5 } },   // F12 + devil — naginata (2d6+9)
  devil_rogue:       { name: '???',               glyph: '😈', cr: '16',  hp: 175, ac: 29, toHit: 22, dmgDie: 6,  dmgBonus: 9,  fort: 10, reflex: 15, attacks: 3, sneakDice: 8, evasion: true, gold: [380, 640], evil: true, dr: { amount: 10, bypass: 'magic' }, resist: { fire: 0, cold: 0.5, acid: 0.5 } },   // R15 + devil (Mangvhune) — a dual-wielding horror; its name is not spoken
  bomb_devil:        { name: 'Bomb Devil',        glyph: '💣', cr: '11',  hp: 115, ac: 24, toHit: 16, dmgDie: 6,  dmgBonus: 6,  fort: 10, reflex: 11, gold: [130, 260], evil: true, dr: { amount: 10, bypass: 'magic' }, resist: { fire: 0, cold: 0.5, acid: 0.5 },
                       hellfire: { count: 3, dice: 6, die: 6, dc: 20, verb: 'lobs a sputtering FIRE BOMB into the party', sound: '/audio/spell_fireball.mp3' } },   // alchemist-devil — bombs, burning hands, fireball flavor
  // ── DRAGONS — winged terrors with breath weapons (reuse the hellfire AoE with a
  //    breath verb + element). ──
  black_dragon:      { name: 'Black Dragon',      glyph: '🐉', cr: '11',  hp: 150, ac: 26, toHit: 20, dmgDie: 6,  dmgCount: 2, dmgBonus: 9, fort: 12, reflex: 9, attacks: 2, flying: true, gold: [200, 400], evil: true, dr: { amount: 5, bypass: 'magic' }, resist: { acid: 0 }, shout: { fear: true, dc: 19, sound: '/audio/enemy_lich_gaze.mp3' },
                       hellfire: { count: 3, dice: 8, die: 6, dc: 20, dtype: 'acid', verb: 'breathes a hissing LINE OF ACID across the party', sound: '/audio/spell_acidsplash.mp3' } },   // adult black dragon — acid breath, frightful presence
  void_dragon:       { name: 'Void Dragon',       glyph: '🐉', cr: '13',  hp: 175, ac: 27, toHit: 21, dmgDie: 8,  dmgCount: 2, dmgBonus: 9, fort: 13, reflex: 10, attacks: 2, flying: true, gold: [260, 480], evil: true, dr: { amount: 5, bypass: 'magic' }, resist: { cold: 0 }, shout: { fear: true, dc: 21, sound: '/audio/enemy_lich_gaze.mp3' },
                       hellfire: { count: 3, dice: 10, die: 6, dc: 21, dtype: 'cold', verb: 'exhales a freezing GULF OF THE VOID over the party', sound: '/audio/spell_coneofcold.mp3' } },   // void dragon — entropic cold breath
  // ── HARPY SORCERER — harpy stats + 9 sorcerer levels (full arcane barrage on the wing). ──
  harpy_sorcerer:    { name: 'Harpy Sorcerer',    glyph: '🦅', cr: '10',  hp: 95,  ac: 21, toHit: 13, dmgDie: 6,  dmgBonus: 4,  fort: 6,  reflex: 10, attacks: 2, flying: true, gold: [120, 240], evil: true, arcane: true },
};
// PF1 BODY PLANS — size category + leg count per monster (used by the trip rules:
// +4 to trip defense per leg beyond two; you can't trip a foe more than ONE size
// larger than you; legs:0 = can't be tripped at all — oozes, shadows, amorphous
// things). Anything not listed defaults to Medium biped. Merged onto MON below.
const SIZE_RANK = { F: -4, D: -3, T: -2, S: -1, M: 0, L: 1, H: 2, G: 3, C: 4 };
const SIZE_NAME = { F: 'Fine', D: 'Diminutive', T: 'Tiny', S: 'Small', M: 'Medium', L: 'Large', H: 'Huge', G: 'Gargantuan', C: 'Colossal' };
const MON_BODY = {
  dire_rat: { size: 'S', legs: 4 }, badger: { size: 'S', legs: 4 }, giant_centipede: { size: 'M', legs: 8 },
  goblin: { size: 'S' }, kobold: { size: 'S' }, kobold_spearman: { size: 'S' }, kobold_shaman: { size: 'S' },
  kobold_rogue: { size: 'S' }, goblin_rogue: { size: 'S' }, goblin_shaman: { size: 'S' }, goblin_barbarian: { size: 'S' },
  giant_spider: { size: 'M', legs: 8 }, shadow: { legs: 0 },                       // incorporeal — nothing to sweep
  gray_ooze: { legs: 0 }, gibbering_mouther: { legs: 0 },                          // amorphous
  ogre: { size: 'L' }, ettin: { size: 'L' }, dire_ape: { size: 'L' },
  dire_boar: { size: 'L', legs: 4 }, winter_wolf: { size: 'L', legs: 4 }, blood_caimon: { size: 'L', legs: 4 },
  dire_bear: { size: 'L', legs: 4 }, chimera: { size: 'L', legs: 4 }, basilisk: { size: 'M', legs: 8 },
  ettercap: { size: 'M' }, harpy: { size: 'M' }, gargoyle: { size: 'M' }, minotaur: { size: 'L' },
  wood_golem: { size: 'L' }, bog_brute: { size: 'L' }, hill_giant: { size: 'L' }, stone_giant: { size: 'L' },
  brass_golem: { size: 'L' }, barbed_devil: { size: 'L' }, abyssal_horror: { size: 'L', legs: 0 },   // a roil of tentacles
  medusa: { size: 'M' }, vampire: { size: 'M' }, lich: { size: 'M' },
  // The vampire court / infernal court are classed humanoid shapes (Medium bipeds —
  // the default — so no entries needed); the dragons are Large quadrupeds.
  black_dragon: { size: 'L', legs: 4 }, void_dragon: { size: 'L', legs: 4 },
};
for (const [k, b] of Object.entries(MON_BODY)) if (MON[k]) Object.assign(MON[k], b);
// Real token art from the Foundry library (public/dungeon/monsters/). dire_rat
// has no token in the library, so it falls back to its emoji glyph.
const MON_ART = {
  dire_rat: 'dire_rat',
  kobold_spearman: 'kobold_spearman', kobold_shaman: 'kobold_shaman', kobold_rogue: 'kobold_rogue',
  giant_centipede: 'centipede', goblin: 'goblin', goblin_barbarian: 'goblin', kobold: 'kobold', skeleton: 'skeleton',
  giant_spider: 'spider', zombie: 'zombie', ghoul: 'ghoul', cultist: 'cultist',
  // Undead with fresh Foundry token art (were emoji-only): a burning skull,
  // a fanged vampire lord, and a skeletal lich in his mitre.
  fire_skeleton: 'fire_skeleton', vampire: 'vampire', lich: 'lich',
  gray_ooze: 'ooze', skeletal_champion: 'skeletal_champion', shadow: 'shadow', wight: 'wight',
  ghast: 'ghast', gibbering_mouther: 'gibbering_mouther', ogre: 'ogre', ettin: 'ettin',
  brass_golem: 'brass_golem', barbed_devil: 'barbed_devil',
  // diversity pack (dire_bear sets its .webp art inline, so it's not listed here)
  dire_ape: 'dire_ape', ettercap: 'ettercap', dire_boar: 'dire_boar', harpy: 'harpy',
  gargoyle: 'gargoyle', minotaur: 'minotaur', basilisk: 'basilisk', winter_wolf: 'winter_wolf',
  wood_golem: 'wood_golem', bog_brute: 'swamp_horror', chimera: 'chimera', hill_giant: 'hill_giant',
  medusa: 'medusa', stone_giant: 'stone_giant', abyssal_horror: 'abyssal_horror',
  // The vampire court, Technic League & Thrune villains, the infernal court, and
  // dragons (Abrogail is a .png — her art is set inline on the MON entry).
  vampire_spawn: 'vampire_spawn', vamp_knight: 'vamp_knight', vamp_inquisitor: 'vamp_inquisitor',
  vamp_rogue: 'vamp_rogue', vamp_scout: 'vamp_scout', vamp_warrior: 'vamp_warrior',
  vamp_bodyguard: 'vamp_bodyguard', vamp_priest: 'vamp_priest', vamp_assassin: 'vamp_assassin',
  vamp_nightguard: 'vamp_nightguard', vamp_noble: 'vamp_noble', vamp_techwitch: 'vamp_techwitch',
  zernibeth: 'zernibeth', barzillai: 'barzillai',
  devil_swordsman: 'devil_swordsman', devil_samurai: 'devil_samurai', devil_rogue: 'devil_rogue',
  bomb_devil: 'bomb_devil', black_dragon: 'black_dragon', void_dragon: 'void_dragon',
  harpy_sorcerer: 'harpy_sorcerer',
  blood_caimon: 'blood_caimon',
};
for (const [k, name] of Object.entries(MON_ART)) if (MON[k]) MON[k].art = `/dungeon/monsters/${name}.webp`;

// PF1 creature TYPE per monster — drives the Inquisitor's BANE (declared against
// ONE type; the bane bonus applies only to foes of that type). Every MON key
// should be covered; anything missed defaults to 'humanoid' below.
const MON_TYPE = {
  dire_rat: 'animal', badger: 'animal', dire_ape: 'animal', dire_boar: 'animal', blood_caimon: 'animal', dire_bear: 'animal',
  giant_centipede: 'vermin', giant_spider: 'vermin',
  goblin: 'humanoid', goblin_rogue: 'humanoid', goblin_shaman: 'humanoid', goblin_barbarian: 'humanoid',
  kobold: 'humanoid', kobold_spearman: 'humanoid', kobold_shaman: 'humanoid', kobold_rogue: 'humanoid',
  cultist: 'humanoid', monk: 'humanoid',
  skeleton: 'undead', zombie: 'undead', ghoul: 'undead', ghast: 'undead', skeletal_champion: 'undead',
  shadow: 'undead', fire_skeleton: 'undead', wight: 'undead', vampire: 'undead', lich: 'undead',
  ogre: 'giant', ettin: 'giant', hill_giant: 'giant', stone_giant: 'giant',
  harpy: 'monstrous humanoid', gargoyle: 'monstrous humanoid', minotaur: 'monstrous humanoid', medusa: 'monstrous humanoid',
  basilisk: 'magical beast', winter_wolf: 'magical beast', chimera: 'magical beast',
  ettercap: 'aberration', gibbering_mouther: 'aberration', bog_brute: 'aberration', abyssal_horror: 'aberration',
  wood_golem: 'construct', brass_golem: 'construct',
  gray_ooze: 'ooze',
  barbed_devil: 'outsider',
};
for (const [k, t] of Object.entries(MON_TYPE)) if (MON[k]) MON[k].type = t;
for (const k of Object.keys(MON)) if (!MON[k].type) MON[k].type = 'humanoid';   // default → Bane always has a target

// ── Energy resistances / vulnerabilities ────────────────────────────────────
// A damage MULTIPLIER per energy type: 0 = immune, 0.5 = resistant (half),
// 1.5 = vulnerable (takes 50% more). Physical (B/S/P) and untyped damage are
// never modified here. Most undead shrug off cold (PF1e) — a Fire Skeleton is
// the exception (made of fire: immune to its own element, vulnerable to cold).
const UNDEAD_KEYS = ['skeleton', 'skeletal_champion', 'zombie', 'ghoul', 'ghast', 'wight', 'shadow', 'fire_skeleton', 'vampire', 'lich'];
const RESIST_BY_KEY = {
  fire_skeleton: { fire: 0, cold: 1.5 },          // burning bones: fireproof, but cold shatters them
  wood_golem:    { fire: 1.5 },                    // dry timber: catches fire easily
  winter_wolf:   { cold: 0, fire: 1.5 },           // creature of ice: immune cold, vuln fire
  vampire:       { cold: 0, electricity: 0.5 },  // user rule: vampires are IMMUNE to cold (electricity still half)
  fire_elemental: { fire: 0, cold: 1.5 },
};
for (const k of UNDEAD_KEYS) {                      // undead are immune to cold unless told otherwise
  if (!MON[k]) continue;
  const r = RESIST_BY_KEY[k] || (RESIST_BY_KEY[k] = {});
  if (r.cold == null) r.cold = 0;
}
for (const [k, r] of Object.entries(RESIST_BY_KEY)) if (MON[k]) MON[k].resist = r;

// ── Alignment (drives Smite Evil & future alignment-keyed effects) ──────────
// Two-letter PF1e alignment per monster. Animals/vermin/oozes/constructs are
// true-neutral (NOT smite-able); most dungeon denizens are some flavor of
// evil. Anything unlisted defaults to NE. `evil` is the derived smite flag.
const ALIGN_BY_KEY = {
  // unaligned: animals, vermin, oozes, mindless/neutral constructs & beasts
  dire_rat: 'N', giant_centipede: 'N', giant_spider: 'N', dire_ape: 'N', dire_boar: 'N',
  dire_bear: 'N', gray_ooze: 'N', gibbering_mouther: 'N', basilisk: 'N', stone_giant: 'N',
  brass_golem: 'N', wood_golem: 'N',
  // lawful evil
  kobold: 'LE', kobold_spearman: 'LE', kobold_shaman: 'LE', kobold_rogue: 'LE',
  wight: 'LE', medusa: 'LE', barbed_devil: 'LE',
  // neutral evil
  goblin: 'NE', skeleton: 'NE', skeletal_champion: 'NE', zombie: 'NE', cultist: 'NE', ettercap: 'NE', winter_wolf: 'NE',
  goblin_barbarian: 'CE',
  // chaotic evil
  ghoul: 'CE', ghast: 'CE', shadow: 'CE', ogre: 'CE', ettin: 'CE', minotaur: 'CE',
  hill_giant: 'CE', harpy: 'CE', gargoyle: 'CE', chimera: 'CE', abyssal_horror: 'CE',
  // lawful neutral (a disciplined martial foe — not smite-able)
  monk: 'LN',
};
for (const [k, base] of Object.entries(MON)) {
  base.align = ALIGN_BY_KEY[k] || 'NE';
  base.evil  = base.align.includes('E');
}

// ── Difficulty curve: Pathfinder CR creeps ~0.25 per room ───────────────────
// Parse a CR string ("1/4", "3") to a number, and tag every monster with it.
function crToNum(cr) {
  if (typeof cr === 'number') return cr;
  if (!cr) return 0;
  if (String(cr).includes('/')) { const [a, b] = String(cr).split('/').map(Number); return b ? a / b : a; }
  return Number(cr) || 0;
}
const BOSS_KEYS = new Set(['brass_golem', 'barbed_devil']);   // boss-only, never regular spawns
for (const k of Object.keys(MON)) MON[k].crNum = crToNum(MON[k].cr);
const SPAWNABLE = Object.keys(MON).filter(k => !BOSS_KEYS.has(k));

// PF1e XP value by CR — the currency for building balanced encounters. The
// total XP of a room's monsters ≈ the XP of a single creature at the target
// encounter CR (that's how PF1 turns "2× CR n = CR n+2" into simple addition).
// XP-per-CR for character progression (xpForCR, × multiplier) and encounter
// budgeting (rawXpForCR, un-multiplied) both live in pf1data/xp.js now.
// Legacy gentle-creep target (kept as a fallback for the budget builder).
function targetCR(depth) { return 0.25 * depth; }
function pickByCR(depth) {
  const target = targetCR(depth);
  let cand = SPAWNABLE.filter(k => MON[k].crNum >= target - 0.75 && MON[k].crNum <= target + 0.25);
  if (!cand.length) cand = [SPAWNABLE.reduce((best, k) =>
    Math.abs(MON[k].crNum - target) < Math.abs(MON[best].crNum - target) ? k : best, SPAWNABLE[0])];
  return pick(cand);
}
// Designated bosses by depth — real high-CR PF1e creatures, used as-is (no buff).
function bossKeyFor(depth) {
  if (depth >= 8 && depth <= 12) return 'brass_golem';   // golden (brass) golem, CR 9
  if (depth >= 13)               return 'barbed_devil';  // hamatula, CR 11
  return depth >= 4 ? 'ogre' : 'skeletal_champion';      // early milestone bosses (rooms 5)
}
function rint(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

// ── Loot odds from Pathfinder treasure-by-CR ────────────────────────────────
// PF1e ties treasure to encounter CR. A +1 item (~1-2k gp of enhancement) is the
// magic share of a ~CR 4-6 fight; +2 ≈ CR 7-9; +3 ≈ CR 10-12; +4 ≈ CR 13-15;
// +5 ≈ CR 16+. Below CR 3 magic is rare (mostly coin). The defeated room's
// toughest creature (its CR) drives both the drop chance and the best tier.
function lootForCR(cr) {
  const chance = cr < 3 ? 0.04 : Math.min(0.55, 0.10 + 0.045 * (cr - 3));
  const maxTier = cr >= 16 ? 5 : cr >= 13 ? 4 : cr >= 10 ? 3 : cr >= 7 ? 2 : 1;
  return { chance, maxTier };
}
// A drop CENTERS on the encounter's ceiling so treasure actually scales with CR:
// it's either the max tier or one below (50/50). A CR-9 boss (max +2) gives +1/+2,
// a CR-11 (max +3) gives +2/+3, a CR-16 (max +5) gives +4/+5 — instead of the old
// behaviour that buried everything at +1 regardless of how nasty the fight was.
function rollLootTier(maxTier) {
  if (maxTier <= 1) return 1;
  const floor = Math.max(1, maxTier - 1);
  return floor + (Math.random() < 0.5 ? 1 : 0);
}
// Cure potions also drop (CR-scaled), auto-quaffed by the most-hurt ally.
function potionForCR(cr) {
  if (cr >= 10) return { name: 'Cure Serious Wounds',  count: 3, die: 8, bonus: 5, gp: 750 };
  if (cr >= 5)  return { name: 'Cure Moderate Wounds', count: 2, die: 8, bonus: 3, gp: 300 };
  return          { name: 'Cure Light Wounds',    count: 1, die: 8, bonus: 1, gp: 50 };
}

let _uidSeq = 0;

class Dungeon {
  constructor({ tableId, io, onMemberExit, onEmpty }) {
    this.id = tableId;           // one shared run per table
    this.tableId = tableId;
    this.io = io;
    this._onMemberExit = onMemberExit;   // (playerId, nickname, exit) — chat + roster
    this._onEmpty = onEmpty;             // () — run fully over, drop the instance
    this.depth = 0;
    this.round = 0;
    this.runGold = 0;
    this.pendingLoot = [];       // [{ slot, tier, owner }]
    this.lootRoll = null;        // active roll-off for a dropped item (see _startLootRoll)
    this._lootTimer = null;
    this.enemies = [];
    this.party = [];             // members (see addMember)
    this.turnOrder = [];
    this.turnIdx = 0;
    this.status = 'exploring';   // exploring | combat | over
    this.log = [];
    this._logSeq = 0;
    this._noteSide = null;   // set to 'enemy' while a monster is taking its turn (see _withSide)
    this._turnTimer = null;
    this._stepTimer = null;
    this._bantRound = -1;        // last combat round an AI ally reacted (1 per round)
  }

  // ── AI ally trash-talk ────────────────────────────────────────────────────
  // At most ONE AI reaction per combat round (a chance each round); loot
  // reactions (between rooms) get their own occasional chance.
  _tryBanter(member, eventType, ctx) {
    if (!member || !member.isBot) return;
    if (!banter.CHARACTER_FLAVOR[member.trueNick || member.nickname]) return;
    if (this.status === 'combat') {
      if (this.round === this._bantRound) return;   // round already used its one chance
      this._bantRound = this.round;
      if (Math.random() > 0.36) return;
    } else if (Math.random() > 0.40) return;
    this._emitBanter(member, eventType, ctx);
  }
  _emitBanter(member, eventType, ctx) {
    const flavorNick = member.trueNick || member.nickname;   // Vorkstag keeps his own creepy voice…
    const label = member.nickname;                           // …but is shown + voiced as whoever he wears
    Promise.resolve(banter.dungeonLine(flavorNick, eventType, { ...ctx, voiceNick: label })).then(res => {
      if (!res || !res.line) return;
      // voiced: the 11labs clip carries this line out loud — the blind narrator
      // must NOT read it again (Josh: "the blind voice is doing double duty").
      this._note(`💬 ${label}: ${res.line}`, null, { kind: 'banter', voiced: !!res.audio });
      if (this.io && res.audio) {
        // Clear for the dungeon party; the poker table overhears it MUFFLED
        // (same "through the floor" treatment as the combat echo).
        this.io.to(this.roomName()).emit('dungeon:say', { nick: label, audio: res.audio, audioMime: res.audioMime });
        if (this.tableId) this.io.to(`table:${this.tableId}`).emit('dungeon:voiceecho', { audio: res.audio, audioMime: res.audioMime });
      }
      this._broadcast();
    }).catch(() => {});
  }

  roomName() { return `dungeon:${this.id}`; }
  _note(text, sound, meta = {}) {
    // Each entry carries `side` (which column it belongs in) and `kind` (its
    // colour tint) so the client can split the log hero-left / enemy-right and
    // gently colour heals (gold), deaths (red), buffs (blue), debuffs (purple).
    const side = meta.side || this._noteSide || this._inferSide(text);
    const kind = meta.kind || this._inferKind(text);
    this.log.push({ t: ++this._logSeq, text, sound: sound || null, side, kind, voiced: !!meta.voiced });
    if (this.log.length > 150) this.log.shift();
    if (sound) { try { recordSound('dungeon', sound, text); } catch (_) {} }
  }
  // Run `fn` with every _note inside it attributed to one side (used to tag a
  // monster's whole turn 'enemy' in one place). Synchronous; restores on exit.
  _withSide(side, fn) { const prev = this._noteSide; this._noteSide = side; try { return fn(); } finally { this._noteSide = prev; } }
  // Party chatter and run-level admin (doors, loot, gold, interest) live in the
  // centre channel; everything else defaults to the hero side unless _noteSide
  // (an enemy turn) or an explicit meta.side says otherwise.
  _inferSide(text) { return /^(💬|🚪|✨|💎|🎲|🚫|🏆|💰|🛡️|🏛️|💀|🧪|🪜|🏃)/.test(text) ? 'system' : 'hero'; }
  // Colour tint by event kind. Order matters: death wins over heal/buff/debuff.
  _inferKind(text) {
    if (/☠️|💀|🩸|hero_death|[Ss]lain|bleeds out|bleeds —|collapses|DOWN and dying|battered while down|drops past|claims them|dragged out/.test(text)) return 'death';
    if (/💗|💚|🧪|heals|mends|is revived|quaffs|breathes life|[Bb]reath of [Ll]ife|restored to the run|channels positive|back on their feet|back up at/.test(text)) return 'heal';
    if (/💨|[Hh]aste|emboldened|Inspire|Bless|Rage|fades from view|unseen until|Invisib|Divine Favor|righteous fury|calls a Smite|Prayer|blurs with|pronounces Judgement|Judgement —|Judgment —/.test(text)) return 'buff';
    if (/paralyz|fascinat|sickened|retches|prone|clambers|feint|TRIPS|tries to trip|HELD|Hold Person|Hideous|off-balance|flat-footed|dispel|stunned|held —|is held/.test(text)) return 'debuff';
    return 'normal';
  }
  _log(type, extra) {
    try { logDungeon({ type, run: this.id, depth: this.depth, round: this.round, ...(extra || {}) }); } catch (_) {}
  }

  // ── Party membership ──────────────────────────────────────────────────────
  member(playerId) { return this.party.find(m => m.playerId === playerId); }
  present() { return this.party.filter(m => !m.left); }                 // still in the run (alive or downed-this-tick)
  alivePresent() { return this.party.filter(m => !m.left && m.hp > 0); }
  livingParty() { return this.alivePresent(); }
  // Heroes the enemy can actually target — invisible ones are unseen (until they
  // attack). If EVERY living hero is invisible, fall back so combat can resolve.
  _targetableParty() { const live = this.alivePresent(); const seen = live.filter(m => !m.invisible && !m.untargetable); return seen.length ? seen : live; }
  livingEnemies() { return this.enemies.filter(e => e.hp > 0); }
  // Foes a hero can actually hit — excludes those shrouded in DARKNESS (can't be
  // attacked for 2 rounds). They're still "alive" (room stays active until it lifts).
  _targetableEnemies() { return this.enemies.filter(e => e.hp > 0 && !(e.darkened > 0)); }

  hasMember(playerId) { const m = this.member(playerId); return !!(m && !m.left && m.hp > 0); }
  botCount() { return this.party.filter(m => m.isBot && !m.left && m.hp > 0).length; }
  // Orc / half-orc FEROCITY: these characters keep fighting at 0 HP and below
  // (until slain at −10) instead of dropping when downed. Keyed by name/playerId.
  _hasFerocity(m) {
    const id = String((m && (m.trueNick || m.nickname || m.playerId)) || '').toLowerCase();
    return id === 'tokala' || id === 'kai ginn' || id === 'kai gin';
  }

  // True if this member wields a ranged weapon (bow/crossbow/firearm) — selects the
  // RANGED feat tree (Weapon Focus, Point Blank, Rapid Shot, …) over the melee one.
  _isRanged(m) { try { return !!weaponOf(m.gear, m.weaponKey).ranged; } catch (_) { return false; } }
  // Compute + cache a member's PF1 derived stats (ability mods, CON-adjusted max
  // HP, casting mod, iterative-attack offsets) from their base 25-pt ability array.
  // Called at join and on every level change so the numbers track level/ASI.
  _setDerived(m) {
    const featHp = (fighterFeats(m.cls, m.level, this._isRanged(m)).hp) || 0;
    const d = deriveCharacter({ cls: m.cls, level: m.level, baseScores: m.abilityScores, featHp });
    m.mods = d.mods;
    m.castingMod = d.castingMod;
    m.iteratives = d.iteratives;
    m.maxHpDerived = d.hp;
    return d;
  }
  addMember(player, isBot = false) {
    const playerId = player.player_id;
    const idx = this.party.findIndex(m => m.playerId === playerId);
    if (idx >= 0 && !this.party[idx].left && this.party[idx].hp > 0) return this.party[idx];  // already active
    if (idx >= 0) this.party.splice(idx, 1);   // drop a stale (downed/bailed) entry → rejoin fresh
    const gear = db.getGear(playerId);
    const xp = db.getXp(playerId);
    const level = levelFromXp(xp);             // level now comes from XP (not gear)
    const cls = player.class || 'fighter';
    const abilityScores = db.getAbilityScores(playerId, cls);   // PF1 base 25-pt array
    const _ranged = !!weaponOf(gear, player.weapon || 'dagger').ranged;
    const featHp = (fighterFeats(cls, level, _ranged).hp) || 0;
    const maxHp = deriveCharacter({ cls, level, baseScores: abilityScores, featHp }).hp;   // Hit Die×level + CON mod/level + feat HP
    const m = {
      playerId,
      nickname: player.nickname || playerId,
      avatarId: player.avatar_id || null,
      isBot: !!isBot,
      abilityScores,
      gear, level, xp,
      crowned: !!(db.getPlayer(playerId)?.crowned),   // permanent Loot Lord crown
      cls,                                     // PF1e class → drives BAB + Hit Die
      weaponKey: player.weapon || 'dagger',    // chosen base weapon (dropdown)
      hp: maxHp, maxHp,
      sickened: 0, paralyzed: 0, flatFooted: true,
      abilityUses: {}, buffs: null, smiteActive: false, acPenRound: -1, acPenAmt: 0,
      // Per-RUN state (persists across rooms, NOT refreshed by _resetAbilities):
      //   runAbilityUses — 'run'-cost abilities (Bless: once per whole dungeon)
      //   runBuffs       — run-long buffs (Bless's +1 to-hit) that never fade
      runAbilityUses: {}, runBuffs: { toHit: 0, dmg: 0 }, runBuffApplied: {},
      left: false, dead: false,
    };
    for (const ab of kitFor(cls).abilities) {
      if (ab.cost === 'run') m.runAbilityUses[ab.key] = (typeof ab.uses === 'function' ? ab.uses(level) : (ab.uses || 1));
    }
    this._resetAbilities(m);   // stock the per-room spell/channel pool by level
    this._setDerived(m);       // cache PF1 ability mods / CON-HP / iteratives on the member
    // Vorkstag the skinwalker wears a partymate's face + name (true identity
    // hidden) — same as his poker-seat disguise. He keeps his own creepy
    // personality but is shown/voiced as whoever he's impersonating.
    if (playerId === 'vorkstag') {
      const victims = this.party.filter(x => !x.left && x.hp > 0);
      if (victims.length) { const v = pick(victims); m.trueNick = m.nickname; m.nickname = v.nickname; m.avatarId = v.avatarId; }
    }
    this.party.push(m);
    this._note(`🚪 ${m.nickname} joins the delve. (Lv ${level} · ${maxHp} HP)`);
    this._log('join', { who: playerId, level, maxHp, party: this.present().length });
    // Mid-combat join → add to the current turn order so they act this round.
    if (this.status === 'combat') this.turnOrder.push({ kind: 'party', id: playerId, init: dRoll(20) + 2 + Math.floor((m.level || 1) / 2) });
    this._maintainBardSongs();   // a bard's Inspire aura covers the newcomer (or the newcomer IS the bard)
    this._broadcast();
    return m;
  }

  // Active debuffs on a hero or monster, as PF1-system condition icons for the
  // dungeon UI. Members carry sickened/paralyzed; enemies add asleep/prone.
  // (Same flag names on both, so one helper serves heroes and monsters.)
  _condList(o) {
    const I = '/dungeon/conditions/', c = [];
    if (o.sickened > 0)  c.push({ key: 'sickened',  label: 'Sickened',  desc: '−2 to attacks & damage', icon: `${I}sickened.webp` });
    if (o.blinded > 0)   c.push({ key: 'blinded',   label: 'Blinded',   desc: '−4 to hit, denied Dex (easier to hit, Sneak-Attackable)', icon: `${I}sickened.webp` });
    if (o.paralyzed > 0) c.push(o.heldDC
      ? { key: 'held',      label: 'Held',      desc: 'helpless — re-saves each turn (the attempt costs the turn)', icon: `${I}paralyzed.webp` }
      : { key: 'paralyzed', label: 'Paralyzed', desc: 'frozen — loses turns; easy to hit', icon: `${I}paralyzed.webp` });
    if (o.slowed > 0)    c.push({ key: 'slowed',    label: 'Slowed',    desc: 'sluggish — acts only every other turn; −1 AC', icon: `${I}slowed.webp` });
    if (o.grappled)      c.push({ key: 'grappled',  label: 'Grappled',  desc: 'chained — −2 to hit, easier to strike; crushed each turn (Dispel or Grease frees you)', icon: `${I}grappled.webp` });
    if (o.prayed > 0)    c.push({ key: 'prayed',     label: 'Prayer',    desc: `−${o.prayed} to hit, damage & saves (cleric Prayer covers the battlefield)`, icon: `${I}shaken.webp` });
    if (o.stunned > 0)   c.push({ key: 'stunned',   label: 'Stunned',   desc: 'loses a turn', icon: `${I}stunned.webp` });
    if (o.asleep)        c.push({ key: 'asleep',     label: 'Asleep',     desc: 'helpless — loses turns until struck', icon: `${I}sleep.webp` });
    else if (o.fascinated) c.push({ key: 'fascinated', label: 'Fascinated', desc: 'enthralled — loses turns; the first hit snaps it out', icon: `${I}fascinated.webp` });
    if (o.darkened > 0)  c.push({ key: 'darkened',  label: 'Darkness',  desc: 'shrouded in darkness — cannot act or be attacked (2 rounds)', icon: `${I}darkened.webp` });
    if (o.prone)         c.push({ key: 'prone',     label: 'Prone',     desc: 'knocked down — +4 for all to hit it', icon: `${I}prone.webp` });
    if (o.markedEvil)    c.push({ key: 'markedevil', label: 'Marked',   desc: 'revealed by Detect Evil — smite-able', icon: `${I}markedevil.webp` });
    return c;
  }

  // Active BUFFS on a hero, as Foundry-art icons for the dungeon UI. Sticky room
  // buffs (rage/bane/divine favor/prayer/shield) come from buffApplied; run-long
  // ones (bless/inspire) from runBuffApplied; smite/haste/invisible/judgement are
  // their own flags.
  _buffList(m) {
    const I = '/dungeon/buffs/', c = [], pushed = new Set();
    const push = (k, label, desc, icon) => { if (pushed.has(k)) return; pushed.add(k); c.push({ key: k, label, desc, icon: icon || `${I}${k}.webp` }); };
    // Every applied spell/feat buff carries its own icon via BUFF_META — walk the
    // recorded keys so any buff (new ones included) lights up automatically.
    for (const key of [...Object.keys(m.buffApplied || {}), ...Object.keys(m.runBuffApplied || {})]) {
      const meta = BUFF_META[key];
      if (meta) push(key, meta.label, meta.desc, meta.icon);
    }
    // Transient states tracked by their own flags, not in buffApplied:
    if (m.smiteActive)  push('smite', 'Smite', '+hit & +2×level damage vs evil');
    if (m.hasted > 0)   push('haste', 'Haste', `an extra attack each turn (${m.hasted} left)`);
    if (m.invisible)    push('invisible', 'Invisible', 'unseen — until you attack');
    if (m.flying)       push('fly', 'Flying', 'airborne — grounded foes cannot reach you');
    if (m.images > 0)   push('mirrorimage', 'Mirror Image', `${m.images} decoy${m.images > 1 ? 's' : ''} soaking incoming attacks`);
    if (m.untargetable) push('blur', 'Blurred', 'untargetable until your next turn (Bladed Dash)', '/dungeon/buffs/fly.webp');
    if (m.touchStrike > 0) push('dimblade', 'Dimensional Blade', 'your strikes hit on TOUCH this round', '/dungeon/buffs/magearmor.webp');
    if (m.protectFire)  push('protectfire', 'Fire Ward', 'fire damage halved (Protection from Fire)');
    if (m.judgment === 'destruction') push('judg_destruction', 'Judgement: Destruction', '+damage on your strikes');
    if (m.judgment === 'protection')  push('judg_protection', 'Judgement: Protection', '+AC');
    if (m.judgment === 'healing')     push('judg_healing', 'Judgement: Healing', 'regenerate HP each turn');
    if (m.bane)                       push('bane', `Bane: ${titleCase(m.bane.type)}`, `+2 hit, +2d6+2 vs ${titleCase(m.bane.type)} (this room)`);
    if (m.mageArmor)                  push('magearmor', 'Mage Armor', '+4 armor AC (this dungeon)');
    // Wild Shape — show the form's token as a buff badge (hawk has no token, but its
    // Flying badge already covers it above).
    if (m.form && m.form.art && !pushed.has('form_' + m.form.key)) { pushed.add('form_' + m.form.key); c.push({ key: 'form_' + m.form.key, label: m.form.label, desc: `Wild Shape: ${m.form.label}`, icon: m.form.art }); }
    return c;
  }

  // Active BOONS on an enemy (green-ringed buff icons), so players can see a foe
  // that's been hasted or pumped with combat buffs. Debuffs ride _condList.
  _enemyBuffList(e) {
    const I = '/dungeon/buffs/', c = [];
    if (e.hasted > 0) c.push({ key: 'haste', label: 'Hasted', desc: 'an extra attack each turn', icon: `${I}haste.webp` });
    if (e.buffs && ((e.buffs.toHit || 0) > 0 || (e.buffs.dmg || 0) > 0 || (e.buffs.ac || 0) > 0)) c.push({ key: 'buffed', label: 'Strengthened', desc: 'combat buffs active (+hit / +damage / +AC)', icon: `${I}bullsstrength.webp` });
    return c;
  }

  // ── Broadcasting ──────────────────────────────────────────────────────────
  publicState() {
    return {
      id: this.id,
      depth: this.depth,
      round: this.round,
      status: this.status,
      runGold: this.runGold,
      party: this.party.map(m => ({
        playerId: m.playerId, nickname: m.nickname, avatarId: m.avatarId, isBot: m.isBot, crowned: !!m.crowned,
        cls: m.cls || 'fighter', weapon: m.weaponKey || 'dagger',
        form: m.form ? { key: m.form.key, label: m.form.label, glyph: m.form.glyph, art: m.form.art } : null,   // active Wild Shape (drives the token swap on the hero card)
        level: m.level, ...this._xpInfo(m), ...this._heroACs(m), hp: Math.max(0, m.hp), maxHp: m.maxHp,
        abilityScores: m.abilityScores || null, abilityMods: m.mods || null, cantrip: this._cantripState(m),
        dead: !!m.dead, downed: !m.dead && !m.left && m.hp <= 0 && !this._hasFerocity(m),
        dyingHp: (!m.dead && !m.left && m.hp <= 0 && !this._hasFerocity(m)) ? m.hp : null,
        ferocious: !m.dead && !m.left && m.hp <= 0 && this._hasFerocity(m),   // orc fighting on at/below 0 HP
        left: !!m.left,
        sickened: m.sickened > 0, paralyzed: m.paralyzed > 0,
        // Auto-skip countdown — only for the human whose turn it currently is.
        afkAt: (this.status === 'combat' && !m.isBot && this._currentActorId() === m.playerId && m.afkDeadline) ? m.afkDeadline : null,
        conditions: (!m.dead && !m.left && m.hp > 0) ? this._condList(m) : [],
        buffs: (!m.dead && !m.left && m.hp > 0) ? this._buffList(m) : [],
        smiteActive: !!m.smiteActive, buffed: !!(m.buffs && (m.buffs.toHit || m.buffs.dmg || m.buffs.bonusDice || m.buffs.ac)),
        kit: this._kitState(m),    // at-will + 2 abilities (+ remaining uses) for the action UI
      })),
      enemies: this.enemies.map(e => ({
        uid: e.uid, name: e.name, glyph: e.glyph, art: e.art || null, boss: !!e.boss, cr: e.cr || null,
        flying: !!e.flying,
        hp: Math.max(0, e.hp), maxHp: e.maxHp, alive: e.hp > 0, sickened: e.sickened > 0,
        align: e.align || 'NE', evil: !!e.evil, type: e.type || null,
        ac: e.ac, touchAC: (e.touchAC != null ? e.touchAC : Math.max(10, e.ac - 5)), ffAC: Math.max(10, e.ac - 2),
        flatFooted: !!e.flatFooted, prone: !!e.prone, fascinated: !!e.fascinated, asleep: !!e.asleep, darkened: (e.darkened > 0),
        conditions: e.hp > 0 ? this._condList(e) : [],
        buffs: e.hp > 0 ? this._enemyBuffList(e) : [],
      })),
      turn: this._currentTurn(),
      botCount: this.botCount(),
      recruitable: this._recruitableFn ? this._recruitableFn() : [],   // unseated bots, set by the socket layer
      lootRoll: this.lootRoll ? {
        slot: this.lootRoll.slot, tier: this.lootRoll.tier,
        label: db.GEAR_BY_KEY[this.lootRoll.slot]?.label || this.lootRoll.slot,
        hockValue: db.gearHockValue(this.lootRoll.slot, this.lootRoll.tier),
        decided: this.lootRoll.decided,
        pending: this.lootRoll.eligible.filter(id => !(id in this.lootRoll.decided)),
        eligible: this.lootRoll.eligible,
      } : null,
      pendingLoot: this.pendingLoot.map((l, i) => ({
        idx: i, slot: l.slot, tier: l.tier, owner: l.owner,
        label: (db.GEAR_BY_KEY[l.slot]?.label || l.slot),
        hockValue: db.gearHockValue(l.slot, l.tier),
      })),
      log: this.log.slice(-60),
    };
  }
  _broadcast() {
    if (!this.io) return;
    this.io.to(this.roomName()).emit('dungeon:state', this.publicState());
    // Tell everyone still at the poker table that a run is live, so they can
    // pop in to spectate / heckle from the money menu.
    if (this.tableId) this.io.to(`table:${this.tableId}`).emit('dungeon:active', this._summary());
  }
  _summary() {
    return { active: this.status !== 'over', depth: this.depth, status: this.status, party: this.present().map(m => m.nickname) };
  }
  _echoToTable(sound) {
    if (sound && this.io && this.tableId) this.io.to(`table:${this.tableId}`).emit('dungeon:echo', { sound });
  }

  // ── Turn helpers ──────────────────────────────────────────────────────────
  _currentTurn() {
    if (this.status !== 'combat') return null;
    const ent = this.turnOrder[this.turnIdx];
    return ent ? { kind: ent.kind, id: ent.id } : null;
  }
  _currentActorId() { const t = this._currentTurn(); return t && t.kind === 'party' ? t.id : null; }

  // ── Exploration: open the next door → roll an encounter ──────────────────
  openDoor() {
    if (this.status !== 'exploring') return { ok: false, error: 'not exploring' };
    if (this.lootRoll) return { ok: false, error: 'finish the loot roll first' };
    this.depth += 1;
    this._spawnRoom();
    this.blackTentacles = null;   // the tentacle field doesn't carry between rooms
    for (const m of this.present()) { this._resetAbilities(m); m.flatFooted = !fighterFeats(m.cls, m.level, this._isRanged(m)).supremacy; }  // refresh per-room spells/channels + flat-footed until they act (Weapon Supremacy: never caught flat-footed)
    if (Math.random() < 0.05) { try { this._reskinVorkstag(); } catch (_) {} }   // skinwalker drifts to a new face between rooms (rare)
    this._maintainBardSongs();   // Inspire Courage is a passive aura — always up, no action spent
    this.status = 'combat';
    this.round = 1;
    this._rollInitiative();
    this._note(`🚪 Door creaks open — room ${this.depth}. ${this._enemySummary()}`);
    this._log('room', { boss: this.enemies.some(e => e.boss), party: this.present().length, enemies: this.enemies.map(e => ({ name: e.name, cr: e.cr, hp: e.maxHp, ac: e.ac, toHit: e.toHit })) });
    this._beginTurnCycle();
    return { ok: true };
  }
  // Average Party Level (PF1e): mean of the heroes' levels (1 + gear), rounded.
  _apl() {
    const party = this.alivePresent();
    if (!party.length) return 1;
    return Math.max(1, Math.round(party.reduce((s, m) => s + (m.level || 1), 0) / party.length));
  }
  // The LOWEST level in the party — the dungeon starts geared to its weakest
  // member so nobody gets one-shot in room 1, then ramps up as they descend.
  _minLevel() {
    const party = this.alivePresent();
    if (!party.length) return 1;
    return Math.max(1, Math.min(...party.map(m => m.level || 1)));
  }
  // The per-enemy CR for this room: geared to the LOWEST party member's level
  // (so the weakest isn't one-shot), ramping ~+1 every 4 rooms as they descend,
  // +2 on boss rooms. Party SIZE is handled by the XP budget (more heroes → more
  // enemies), not by inflating each foe's CR. Capped to the bestiary.
  _encounterCR(boss) {
    let cr = this._minLevel() + Math.floor(this.depth / 4);
    if (boss) cr += 2;
    return Math.max(1, Math.min(13, cr));
  }
  // Strongest thematic foe (incl. boss-only creatures) the party can handle.
  _pickBoss(capCR) {
    const cand = Object.keys(MON).filter(k => MON[k].crNum <= capCR);
    if (!cand.length) return bossKeyFor(this.depth);
    const top = cand.sort((a, b) => MON[b].crNum - MON[a].crNum).slice(0, 3);
    return pick(top);
  }
  // A spawnable creature that fits the remaining XP budget. Biased HARD toward
  // CHEAP foes (weight ∝ 1/xp) so a room fills up with lots of shitty mooks —
  // goblins, kobolds, their sneaky rogues and Hold-Person shamans — instead of a
  // few tough ones. Falls back to anything affordable.
  _pickForBudget(budget, floorCR, capCR) {
    let cand = SPAWNABLE.filter(k => MON[k].crNum >= floorCR && MON[k].crNum <= capCR && rawXpForCR(MON[k].crNum) <= budget);
    if (!cand.length) cand = SPAWNABLE.filter(k => MON[k].crNum <= capCR && rawXpForCR(MON[k].crNum) <= budget);
    if (!cand.length) return null;
    const weights = cand.map(k => 1 / Math.max(1, rawXpForCR(MON[k].crNum)));
    const tot = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * tot;
    for (let i = 0; i < cand.length; i++) { r -= weights[i]; if (r <= 0) return cand[i]; }
    return cand[cand.length - 1];
  }
  _makeEnemy(base, boss) {
    return {
      uid: `e${++_uidSeq}`,
      name: boss ? `Boss: ${base.name}` : base.name,
      glyph: base.glyph, art: base.tokenPool ? pick(base.tokenPool) : (base.art || null), boss, cr: base.cr || null,
      hp: base.hp, maxHp: base.hp,
      ac: base.ac,
      // PF1 AC types. touchAC: spells/firearms ignore armor & natural armor (an
      // optional per-monster `touch` overrides the heuristic). Flat-footed AC is
      // derived (−2, denied Dex) in _enemyAC. Refine per-monster touch values later.
      touchAC: (base.touch != null ? base.touch : Math.max(10, base.ac - 5)),
      toHit: base.toHit,
      dmgDie: base.dmgDie, dmgCount: base.dmgCount || 1, dmgBonus: base.dmgBonus,
      fort: base.fort, reflex: base.reflex,
      align: base.align || 'NE', evil: !!base.evil, markedEvil: false, type: base.type || 'humanoid',
      flatFooted: true, prone: false, fascinated: false, asleep: false, loseTurn: false,
      paralyze: !!base.paralyze, paralyzeDC: base.paralyzeDC || PARALYZE_DC, sickened: 0,
      attacks: base.attacks || 1,
      atkSound: base.atkSound || null,
      atkSounds: base.atkSounds || null,
      caster: base.caster || null,
      spellDC: base.spellDC || 13,
      castsLeft: base.caster ? 2 : 0,
      shout: base.shout || null,           // special shout attack (e.g. Skeletal Champion)
      shoutsLeft: base.shout ? 2 : 0,
      taunt: base.taunt || null,           // goblin barbarian: roars a taunt that pulls AI allies onto it
      tauntsLeft: base.taunt ? 1 : 0,
      hook: base.hook || null,             // barbed devil: chain hook → grapple + constrict
      hellfire: base.hellfire || null,     // barbed devil: hellfire blast (fire AoE)
      hellfireLeft: base.hellfire ? 2 : 0,
      arcane: base.arcane || null,         // lich (wizard of its level): Fireball-style AoE blasts
      arcaneLeft: base.arcane ? 3 : 0,
      spellstrike: base.spellstrike || null, // vampire (magus of its level): Vampiric Touch on its strike
      prayed: 0,                           // cleric Prayer: −1 to this enemy's attacks/damage/saves
      acid: null,                          // Acid Arrow lingering burn: { rounds, dice, die }
      resist: base.resist || null,         // energy resistances / vulnerabilities (see RESIST_BY_KEY)
      dr: base.dr || 0,                     // physical DAMAGE REDUCTION — number (DR/—) or { amount, bypass:'S'|'P'|'B'|'magic'|'—' } (see _physDR)
      size: base.size || 'M',               // PF1 size category (S/M/L/H…) — trip & flavor (see MON_BODY)
      legs: (base.legs != null ? base.legs : 2),   // leg count — 0 = untrippable; >2 = +4 trip defense per extra leg
      flying: !!base.flying,               // airborne: immune to prone + "high ground" vs grounded foes
      evasion: !!base.evasion,             // rogues/monks: a made Reflex save vs an area effect = NO damage
      detonate: base.detonate || null,     // fire skeleton: rushes in and blows itself up on its turn
      taunted: null,                       // barbarian Taunt: playerId it's compelled to attack next turn
      slowed: 0, _slowTick: 0,             // Slow spell: sluggish for N rounds, acts every other turn
      gold: rint(base.gold[0], base.gold[1]),
    };
  }
  // Build a room of foes. The per-enemy CR is geared to the weakest hero; the
  // NUMBER of foes scales with party SIZE — each hero past the first adds roughly
  // a full standard encounter's worth of monsters, so a packed party gets mobbed.
  _spawnRoom() {
    this.enemies = [];
    const boss = this.depth % BOSS_EVERY === 0;
    const encCR = this._encounterCR(boss);
    const partyN = Math.max(1, this.alivePresent().length);
    const sizeMult = Math.max(1, partyN - 1);   // 1→×1, 2→×1, 3→×2, 4→×3, 6→×5
    const keys = [];
    // Fill an XP budget with creatures CR ≤ cap (and not trivially weak).
    const fill = (budget, floorCR, capCR, maxCount) => {
      let g = 0;
      while (keys.length < maxCount && budget > 100 && g++ < 80) {
        const key = this._pickForBudget(budget, floorCR, capCR);
        if (!key) break;
        keys.push(key);
        budget -= rawXpForCR(MON[key].crNum);
      }
    };
    if (boss) {
      keys.push(this._pickBoss(encCR));   // one strong foe
      // Boss rooms also mob a big party — minions at a notch below the room CR.
      const baseCR = this._minLevel() + Math.floor(this.depth / 4);
      fill(Math.round(rawXpForCR(baseCR) * Math.max(0, partyN - 1) * 0.6),
           Math.max(0.25, encCR - 6), Math.max(1, encCR - 2), 1 + partyN);
    } else {
      fill(Math.round(rawXpForCR(encCR) * sizeMult),
           Math.max(0.25, encCR - 4), encCR, Math.min(14, 4 + partyN * 2));
    }
    if (!keys.length) keys.push(pickByCR(this.depth));
    keys.forEach((k, i) => this.enemies.push(this._makeEnemy(MON[k], boss && i === 0)));
    this._log('encounter', { depth: this.depth, minLevel: this._minLevel(), encCR, partyN, count: keys.length });
  }
  _enemySummary() {
    const counts = {};
    for (const e of this.enemies) counts[e.name] = (counts[e.name] || 0) + 1;
    return Object.entries(counts).map(([n, c]) => (c > 1 ? `${c}× ${n}` : n)).join(', ') + '.';
  }
  _rollInitiative() {
    const order = [];
    // Characters add ½ their level (rounded down) to initiative, on top of the base +2.
    for (const m of this.alivePresent()) order.push({ kind: 'party', id: m.playerId, init: dRoll(20) + 2 + Math.floor((m.level || 1) / 2) + fighterFeats(m.cls, m.level, this._isRanged(m)).init });   // + fighter Improved Initiative
    for (const e of this.livingEnemies()) order.push({ kind: 'enemy', id: e.uid, init: dRoll(20) + 1 });
    order.sort((a, b) => b.init - a.init);
    this.turnOrder = order;
    this.turnIdx = 0;
  }

  // ── Turn loop ─────────────────────────────────────────────────────────────
  _beginTurnCycle() { clearTimeout(this._stepTimer); this._advanceToActor(); }
  _advanceToActor() {
    if (this._endIfResolved()) return;
    const t = this._currentTurn();
    if (!t) return;
    if (t.kind === 'enemy') {
      const e = this.enemies.find(x => x.uid === t.id);
      if (!e || e.hp <= 0) return this._nextTurn();
      // Darkness (wizard/sorcerer): shrouded foes can't act (and can't be hit) for
      // 2 of their turns. Tick it down here; the shroud lifts at 0.
      if (e.darkened > 0) { e.darkened -= 1; this._note(`🌑 ${e.name} is lost in magical darkness — does nothing${e.darkened <= 0 ? ' (the shroud lifts!)' : ''}.`, null, { side: 'enemy' }); this._broadcast(); return this._nextTurn(); }
      // Acid Arrow keeps eating away at the start of the foe's turn (whatever it
      // then does). If the acid finishes it off, its turn just ends.
      if (e.acid && e.acid.rounds > 0) {
        e.acid.rounds -= 1;
        const dealt = this._dmgE(e, Math.max(1, dRollN(e.acid.dice || 1, e.acid.die || 6)), 'acid');
        if (e.acid.rounds <= 0) e.acid = null;
        this._note(`🟢 Acid keeps sizzling on ${e.name} — ${dealt} acid${this._resistTag(e, 'acid')}.${this._afterEnemyHit(e)}`, null, { side: 'enemy' });
        if (e.hp <= 0) { this._broadcast(); return this._nextTurn(); }
      }
      if (e.blinded > 0) e.blinded -= 1;   // Glitterdust wears off (doesn't cost the turn — just −4 to hit / denied Dex while it lasts)
      if (e.fascinated) { this._note(`${e.glyph} ${e.name} ${e.asleep ? 'sleeps soundly' : 'stands fascinated'} — does nothing.`, null, { side: 'enemy' }); this._broadcast(); return this._nextTurn(); }
      if (e.paralyzed > 0) {
        if (e.heldDC) {   // Hold Person / Hideous Laughter: a NEW Will save each turn — costs the turn either way (PF1e).
          e.paralyzed -= 1; const hdc = e.heldDC;
          const sv = this._saveVs(this._enemySave(e, 'will'), hdc);
          if (sv.saved || e.paralyzed <= 0) { e.paralyzed = 0; e.heldDC = null; this._note(`🖐️ ${e.name} ${sv.saved ? 'wrenches free of the hold' : 'the hold finally fades'}! [Will ${sv.total} vs ${hdc}]${sv.saved ? ' — but the struggle cost its turn.' : ''}`, null, { side: 'enemy' }); }
          else this._note(`🖐️ ${e.name} stays HELD — struggles in vain and loses its turn. [Will ${sv.total} vs ${hdc}]`, null, { side: 'enemy' });
        } else { e.paralyzed -= 1; this._note(`🖐️ ${e.name} is paralyzed — loses its turn.`, null, { side: 'enemy' }); }
        this._broadcast(); return this._nextTurn();
      }
      // GRAPPLED (by a Promethean OR by Black Tentacles): helpless, loses its turn.
      // Each turn it may struggle free (its attack bonus vs the grappler's CMD); the
      // grip drops if the source is gone (grappler left/dead/un-shifted, or the
      // tentacle field has lapsed).
      if (e.grappled) {
        let cmd, srcGlyph = '🐙', stillHeld;
        if (e.grappledBy === 'tentacles') {
          const bt = this.blackTentacles; srcGlyph = '🦑';
          stillHeld = !!bt; cmd = bt ? 10 + bt.cmb : 0;
        } else {
          const grappler = this.member(e.grappledBy);
          stillHeld = !!(grappler && !grappler.left && grappler.hp > 0 && grappler.form && grappler.form.key === 'promethean');
          cmd = stillHeld ? 12 + (grappler.level || 1) : 0;
        }
        if (!stillHeld) { e.grappled = false; e.grappledBy = null; e.grappleRounds = 0; this._note(`${srcGlyph} ${e.name} wrenches loose — the grip releases it.`, null, { side: 'enemy' }); }
        else {
          e.grappleRounds = (e.grappleRounds || 1) - 1;
          const roll = dRoll(20), tot = roll + (e.toHit || 0);
          const broke = roll === 20 || tot >= cmd;
          if (broke || e.grappleRounds <= 0) { e.grappled = false; e.grappledBy = null; this._note(`${srcGlyph} ${e.name} ${broke ? 'tears free' : 'finally slips'} of the grapple! [Str ${tot} vs ${cmd}] — but the struggle cost its turn.`, null, { side: 'enemy' }); }
          else this._note(`${srcGlyph} ${e.name} is held fast — helpless, loses its turn. [Str ${tot} vs ${cmd}]`, null, { side: 'enemy' });
          this._broadcast(); return this._nextTurn();
        }
      }
      if (e.loseTurn) { e.loseTurn = false; this._note(`${e.glyph} ${e.name} is off-balance — loses its turn.`, null, { side: 'enemy' }); this._broadcast(); return this._nextTurn(); }
      if (e.sickened > 0) { e.sickened -= 1; this._note(`${e.glyph} ${e.name} retches in the cloud — loses its turn.`, null, { side: 'enemy' }); this._broadcast(); return this._nextTurn(); }
      if (e.slowed > 0) {   // Slow: sluggish — acts only every other turn.
        e.slowed -= 1; e._slowTick = (e._slowTick || 0) + 1;
        if (e._slowTick % 2 === 1) { this._note(`🐌 ${e.name} is slowed — too sluggish to act this turn.`, null, { side: 'enemy' }); this._broadcast(); return this._nextTurn(); }
      }
      this._stepTimer = setTimeout(() => { this._withSide('enemy', () => this._enemyAct(e)); this._nextTurn(); }, aiStepMs(e));
      this._broadcast();
      return;
    }
    // party member
    const m = this.member(t.id);
    if (!m || m.left) return this._nextTurn();
    m._curatorBuffUsed = false;   // Curator: the once-per-turn swift buff resets each turn
    if (m.untargetable) m.untargetable = false;   // Bladed Dash blur ends at the start of the magus's next turn
    if (m.touchStrike > 0) m.touchStrike -= 1;     // Dimensional Blade touch-strikes lapse after the round
    if (m.blinded > 0) m.blinded -= 1;             // (heroes can be blinded by future foes too)
    // Infernal Healing (Greater): fast healing at the START of the turn — BEFORE the
    // down/skip check, so it can knit a dying ally (below 0 HP) back onto their feet.
    if (m.infernalHeal > 0 && !m.dead && m.hp < m.maxHp) {
      const before = m.hp; m.hp = Math.min(m.maxHp, m.hp + m.infernalHeal);
      const gained = m.hp - before;
      if (before <= 0 && m.hp > 0) { m.downed = false; this._note(`🩸 ${m.nickname}'s infernal ichor knits ${gained} HP — back on their feet!`); }
      else this._note(`🩸 ${m.nickname}'s infernal ichor knits ${gained} HP.`);
    }
    if (m.hp <= 0) {
      // Orc / half-orc FEROCITY: keep fighting at 0 HP and below (until slain at
      // −10) — take the turn normally instead of dropping.
      if (this._hasFerocity(m) && !m.dead && m.hp > -10) {
        this._note(`💢 ${m.nickname} fights on through the wounds — Ferocity! (${m.hp} HP)`);
        this._broadcast();
      }
      // A DOWNED (but not dead) paladin refuses to fall: on their turn, Hero's
      // Defiance auto-fires — a lay-on-hands heal that brings them back to their
      // feet, after which they take their turn normally (it's an immediate action
      // in PF1). If it's unavailable/used or fails, the turn is skipped as usual.
      else if (m.dead || !this._tryHeroesDefiance(m)) return this._nextTurn();
      else this._broadcast();   // back up — fall through and act this turn
    }
    // Spiritual Weapon fights independently — it strikes at the start of the
    // cleric's turn (even if they're held), then the cleric does their own thing.
    if (m.spiritWeapon && m.spiritWeapon.rounds > 0) { this._spiritWeaponStrike(m); if (this._endIfResolved()) return; }
    if (m.paralyzed > 0) {
      if (m.heldDC) {   // Hold Person on a hero: re-save each turn, costs the turn either way (PF1e).
        m.paralyzed -= 1; const hdc = m.heldDC;
        const sm = this._partySaveMod(m), sroll = dRoll(20), stot = sroll + sm;
        const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= hdc;
        if (saved || m.paralyzed <= 0) { m.paralyzed = 0; m.heldDC = null; this._note(`🖐️ ${m.nickname} ${saved ? 'breaks free of the hold' : 'the hold finally fades'}! [Will d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs ${hdc}]${saved ? ' — but the struggle cost the turn.' : ''}`); }
        else this._note(`🖐️ ${m.nickname} stays HELD — can't break free and loses the turn. [Will d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs ${hdc}]`);
      } else { m.paralyzed -= 1; this._note(`🥶 ${m.nickname} is paralyzed — loses the turn.`); }
      this._broadcast(); return this._nextTurn();
    }
    if (m.stunned > 0) { m.stunned -= 1; this._note(`😵 ${m.nickname} is stunned — loses the turn.`); this._broadcast(); return this._nextTurn(); }
    if (m.sickened > 0) m.sickened -= 1;
    if (m.judgment === 'healing' && m.hp > 0 && m.hp < m.maxHp) {   // Judgement: Healing regen each turn
      const h = Math.max(1, Math.floor((m.level || 1) / 3)); m.hp = Math.min(m.maxHp, m.hp + h);
      this._note(`💗 ${m.nickname}'s Judgement of Healing mends ${h} HP.`);
    }
    if (m.isBot) { this._stepTimer = setTimeout(() => { this._allyAct(m); this._nextTurn(); }, aiStepMs(m)); this._broadcast(); }
    else { this._armAfkTimer(m); this._broadcast(); }   // human — wait for input
  }
  _nextTurn() {
    if (this._endIfResolved()) return;
    this.turnIdx += 1;
    // Initiative is rolled ONCE per combat (per room, in openDoor) — Pathfinder
    // keeps the same order each round; we just wrap back to the top.
    if (this.turnIdx >= this.turnOrder.length) { this.turnIdx = 0; this.round += 1; if (this.blackTentacles) this._blackTentaclesTick(); }   // tentacles re-grab at the top of each round
    this._advanceToActor();
  }
  _armAfkTimer(m) {
    clearTimeout(this._turnTimer);
    // Stamp when this human auto-acts, so their card can show a live countdown.
    m.afkDeadline = Date.now() + AFK_PASS_MS;
    this._turnTimer = setTimeout(() => {
      m.afkDeadline = null;
      // Time's up → swing rather than waste the turn. (Class-aware target pick.)
      const foes = this.livingEnemies();
      if (foes.length) {
        this._note(`⏱️ ${m.nickname} hesitates too long — auto-attacks!`);
        const tgt = this._preferredFoe(m, foes);
        if (tgt) this._basicAttack(m, tgt.uid);
        this._hasteBonus(m);
      } else {
        this._note(`💤 ${m.nickname} is idle — passes.`);
      }
      this._broadcast();
      this._nextTurn();
    }, AFK_PASS_MS);
  }

  // ── Resolution / run-over ────────────────────────────────────────────────
  _anyUp() { return this.party.some(m => !m.left && !m.dead && m.hp > 0); }           // someone able to fight
  _humansInRun() { return this.party.some(m => !m.isBot && !m.left && !m.dead); }     // includes the downed/dying
  _endIfResolved() {
    if (this.status !== 'combat') return true;
    // Clear FIRST — clearing a room can drop a Cure potion that revives a downed ally.
    if (this.livingEnemies().length === 0) { this._clearRoom(); return true; }
    // Nobody left standing (all downed or dead) while foes remain → party wipe.
    if (!this._anyUp()) { this._wipe(); return true; }
    // NOTE: when no humans remain mid-fight we deliberately do NOT cash the AI out
    // here — they FINISH the current room first. The wrap-up happens on the room
    // clear (_clearRoom) or a wipe (above), so the AI leave at the end of the room.
    return false;
  }
  // Pay remaining AI allies (standing OR dying — the downed get their cut too) an
  // even share of what's left, announce it, then end.
  _wrapUp() {
    if (this.status === 'over') return;
    if (this.status === 'combat') this._runFailed = true;   // last human fell mid-fight (room unwon) → gear loss
    const allies = this.party.filter(m => m.isBot && !m.left && !m.dead);
    const share = allies.length ? Math.floor(this.runGold / allies.length) : 0;
    for (const m of allies) {
      if (share > 0) { const p = db.getPlayer(m.playerId); if (p) db.setChips(m.playerId, p.chips + share); this.runGold -= share; }
      m.left = true;
      this._note(`${m.downed ? '🩸' : '🤖'} ${m.nickname} ${m.downed ? 'is dragged out of' : 'returns from'} the dungeon with ${share} gp.`);
      this._log('ally_payout', { who: m.playerId, share, downed: !!m.downed });
      this._emitMemberExit(m, { reason: 'bailed', goldBanked: share, ai: true });
    }
    this._runOver();
  }
  // The last conscious member bailed → any allies still down are hauled out too,
  // each banking an even share. (A voluntary retreat, NOT a combat wipe.)
  _groupExtract() {
    if (this.status === 'over') return;
    if (this.status === 'combat') this._runFailed = true;   // fled an uncleared room with no one left to win it → gear loss
    const members = this.party.filter(m => !m.left && !m.dead);
    if (!members.length) return this._runOver();
    const share = Math.floor(this.runGold / members.length);
    for (const m of members) {
      if (share > 0) { const p = db.getPlayer(m.playerId); if (p) db.setChips(m.playerId, p.chips + share); this.runGold -= share; }
      m.left = true;
      this._note(`🩸 ${m.nickname} is dragged out of the dungeon with ${share} gp.`);
      this._log('extract', { who: m.playerId, share });
      this._emitMemberExit(m, { reason: 'bailed', goldBanked: share, ai: m.isBot });
    }
    this._runOver();
  }
  // Downed allies bleed 1 HP each room — heal or extract them before they hit −10.
  _bleedDowned() {
    for (const m of this.party.filter(x => !x.left && !x.dead && x.hp <= 0)) {
      m.hp -= 1;
      if (m.hp <= -10) { this._note(`🩸 ${m.nickname} bleeds out…`); this._memberDown(m); }
      else this._note(`🩸 ${m.nickname} bleeds — ${m.hp} HP (slain at −10).`);
    }
  }
  // Between rooms (out of combat): a present cleric or oracle brings back the SLAIN.
  // Resurrection (full HP, level restored) is preferred over Raise Dead (1 HP, the lost
  // level stays lost). Each cast spends a slot; we loop until no corpse remains or nobody
  // can cast. (Auto-cast — the party always saves a fallen comrade if able.)
  _endOfRoomRaise() {
    let guard = 16;
    while (guard-- > 0 && this.party.some(c => c.dead && !c.left)) {
      const caster = this.party.find(c => !c.left && !c.dead && c.hp > 0 && this._raiseSlotFor(c) != null);
      if (!caster) break;
      const idx = this._raiseSlotFor(caster);
      const r = this._useAbility(caster, idx, {});
      if (!r || r.ok === false) break;   // couldn't cast — stop (avoid a spin)
    }
  }
  // Index of the best available Raise-Dead-type prayer a member can cast right now
  // (prefers Resurrection / full over Raise Dead), or null if they have none ready.
  _raiseSlotFor(m) {
    const kit = kitFor(m.cls);
    if (!kit || !kit.abilities) return null;
    const lvl = m.level || 1;
    const ready = (ab) => ab && ab.effect === 'revive' && ab.raiseDead
      && lvl >= (ab.minLevel || 1)
      && (ab.cost !== 'slot' || ((m.slots && m.slots[ab.slvl]) || 0) > 0)
      && (ab.cost !== 'room' || ((m.abilityUses && m.abilityUses[ab.key]) || 0) > 0)
      && (ab.cost !== 'pool' || (m.spellPool || 0) > 0);
    let bestIdx = null, bestFull = -1;
    kit.abilities.forEach((ab, i) => {
      if (!ready(ab)) return;
      const f = ab.full ? 1 : 0;
      if (f > bestFull) { bestFull = f; bestIdx = i; }
    });
    return bestIdx;
  }
  _clearRoom() {
    clearTimeout(this._turnTimer); clearTimeout(this._stepTimer);
    this.status = 'exploring';
    const gold = this.enemies.reduce((s, e) => s + (e.gold || 0), 0);
    this.runGold += gold;
    this._note(`✨ Room cleared! +${gold} gp (pool ${this.runGold} gp).`);
    this._log('clear', { gold, runGold: this.runGold });
    this._awardRoomXp();         // PF1 XP for the vanquished foes → split among the survivors
    this._maybeDropLoot();
    this._maybeDropPotion();     // can revive a downed ally before they bleed
    this._bleedDowned();         // the still-dying lose 1 HP this room (toward −10)
    this._endOfRoomRaise();      // a cleric/oracle raises the SLAIN now the fight is over
    if (!this._humansInRun()) { this._wrapUp(); return; }   // last human bled out → AI allies cash out
    this._broadcast();
  }
  // Grant standard PF1 XP for the foes cleared this room, split EQUALLY among every
  // ally still in the dungeon — alive, downed, or DEAD-awaiting-revival (they fought
  // for this room too; PF1 practice gives dead PCs the encounter's XP). The killing
  // blow never matters: there is no per-kill XP anywhere, only this even room split.
  // Persisted per player (humans AND bots level the same way).
  _awardRoomXp() {
    const roomXp = this.enemies.reduce((s, e) => s + xpForCR(crToNum(e.cr)), 0);
    if (roomXp <= 0) return;
    const recips = this.party.filter(m => !m.left);   // alive + downed + dead-but-revivable; only bailers miss out
    if (!recips.length) return;
    const per = Math.floor(roomXp / recips.length);
    if (per <= 0) return;
    const ups = [];
    for (const m of recips) {
      const from = m.level || 1;
      const newXp = db.addXp(m.playerId, per);
      if (this._applyLevelFromXp(m, newXp) > 0) ups.push({ m, from, to: m.level });
    }
    this._note(`✨ Foes vanquished — the party earns ${roomXp} XP (${per} each).`);
    for (const u of ups) this._announceLevelUp(u.m, u.from, u.to);
  }
  // Announce a level-up with a short summary of what the hero gained.
  _announceLevelUp(m, from, to) {
    const cls = m.cls;
    const parts = [`BAB +${babFor(cls, to) - babFor(cls, from)}`, `+${maxHpFor(cls, to) - maxHpFor(cls, from)} HP`];
    const sv = ['fort', 'ref', 'will'].reduce((a, w) => a + (saveFor(cls, w, to) - saveFor(cls, w, from)), 0);
    if (sv > 0) parts.push(`saves +${sv}`);
    const feats = [];
    const featNames = (RANGED_FEAT_CLASSES.has(cls) && this._isRanged(m)) ? RANGED_FEAT_AT
                    : (cls === 'paladin' || cls === 'antipaladin') ? PALADIN_FEAT_AT : cls === 'druid' ? DRUID_FEAT_AT
                    : (cls === 'wizard' || cls === 'sorcerer' || cls === 'witch') ? CASTER_FEAT_AT
                    : CLASS_FEAT_AT[cls] || FEAT_AT;
    for (let g = gatingLevel(cls, from) + 1; g <= gatingLevel(cls, to); g++) if (featNames[g]) feats.push(featNames[g]);
    if (feats.length) parts.push(`feat: ${feats.join(', ')}`);
    const kit = kitFor(cls), spells = [];
    if (kit && kit.abilities) for (const ab of kit.abilities) if (ab.minLevel && ab.minLevel > from && ab.minLevel <= to) spells.push(ab.name);
    const s0 = slotsFor(cls, from) || {}, s1 = slotsFor(cls, to) || {};
    const newSlot = Object.keys(s1).filter(L => !s0[L]).map(L => `${L}${({ 1: 'st', 2: 'nd', 3: 'rd' })[L] || 'th'}-level`);
    if (newSlot.length) parts.push(`new ${newSlot.join(' & ')} spell slots`);
    if (spells.length) parts.push(`spells: ${spells.slice(0, 4).join(', ')}`);
    this._note(`⭐ LEVEL UP! ${m.nickname} reaches level ${to} (${cls})! ${parts.join(' · ')}`, '/audio/spell_channel_charge.mp3');
    this._echoToTable('/audio/spell_channel_charge.mp3');
    this._log('levelup', { who: m.playerId, from, to });
  }
  _runOver() {
    clearTimeout(this._turnTimer); clearTimeout(this._stepTimer); clearTimeout(this._lootTimer);
    this.lootRoll = null;
    if (this._runFailed) this._loseAllGear();   // no-win wipe / full retreat → the party loses all gear
    // Any hero still DEAD when the run ends never got revived: lock in the death penalty
    // and surface them back to the table (they were spectating the run until now).
    for (const m of this.party) {
      if (m.left || !m.dead) continue;
      this._applyDeathPenalty(m);
      this._emitMemberExit(m, { reason: 'dead', goldBanked: 0 });
      m.left = true;
    }
    this.status = 'over';
    this._broadcast();
    if (this._onEmpty) try { this._onEmpty(); } catch (_) {}
  }
  // No-win wipe / full retreat from an UNCLEARED room: every participant loses ALL
  // gear (had even one hero cleared the room, they'd have hauled the loot upstairs
  // — but nobody did). Gear no longer drives level, so this costs equipment power
  // (to-hit / AC / damage), not levels.
  _loseAllGear() {
    let any = false;
    for (const m of this.party) {
      // Only members who DIED in the dungeon (dead, still in the run) forfeit gear.
      // Anyone who got OUT — bailed, fled, or disconnected/reloaded (m.left) — keeps
      // everything. A browser reload must NEVER wipe a player's gear (see Josh's bug).
      if (m._gearLost || m.left || !m.dead) continue;
      m._gearLost = true; any = true;
      try { db.setGear(m.playerId, {}); } catch (_) {}
      m.gear = {};
    }
    this.pendingLoot = [];
    if (any) this._note('💀 No one survived to win the room — the fallen LOSE THEIR GEAR to the dungeon.');
  }
  _maybeDropLoot() {
    const eligible = this.party.filter(m => !m.left && !m.dead);   // up OR dying — the downed can still roll/win loot
    if (!eligible.length || !this.enemies.length) return;
    // Pathfinder-style: the encounter's toughest creature (its CR) sets both the
    // odds of a magic item and its best enhancement; a crowd nudges the CR up;
    // bosses are loot milestones (a big chance bump, but tier still from CR).
    const topCR = Math.max(0, ...this.enemies.map(e => crToNum(e.cr)));
    const effCR = topCR + (this.enemies.length >= 4 ? 1 : 0);
    let { chance, maxTier } = lootForCR(effCR);
    const isBoss = this.enemies.some(e => e.boss);
    if (isBoss) chance = 1;   // bosses ALWAYS drop ≥1 item, and it's at least +1 (rollLootTier floors at 1)
    this._log('loot_check', { topCR, effCR, boss: isBoss, chance: +chance.toFixed(2), maxTier });
    if (Math.random() >= chance) return;
    const tier = rollLootTier(maxTier);
    const slot = pick(db.GEAR_SLOT_KEYS);
    this._startLootRoll(slot, tier, eligible.map(m => m.playerId));
  }
  // Cure potions drop separately from gear (so the boss gear guarantee stands) and
  // are auto-rolled + quaffed by the most-hurt living ally. Strength scales with CR.
  _maybeDropPotion() {
    if (!this.enemies.length) return;
    const topCR = Math.max(0, ...this.enemies.map(e => crToNum(e.cr)));
    const effCR = topCR + (this.enemies.length >= 4 ? 1 : 0);
    let chance = Math.min(0.35, 0.12 + 0.02 * effCR);
    if (this.enemies.some(e => e.boss)) chance = Math.min(0.55, chance + 0.2);
    if (Math.random() >= chance) return;
    const p = potionForCR(effCR);
    let heal = p.bonus; for (let i = 0; i < p.count; i++) heal += dRoll(p.die);   // auto-roll e.g. 2d8+3
    // Most-hurt member drinks it — DOWNED (dying) allies count too and sort first
    // (negative HP fraction), so a Cure potion can haul them back up.
    const hurt = this.party
      .filter(m => !m.left && !m.dead && m.hp < m.maxHp)
      .sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp));
    if (hurt.length) {
      const m = hurt[0], before = m.hp;
      m.hp = Math.min(m.maxHp, m.hp + heal);
      const gained = m.hp - before;
      const revived = before <= 0 && m.hp > 0;
      if (m.hp > 0) m.downed = false;
      this._note(`🧪 A Potion of ${p.name} drops — ${m.nickname} ${revived ? 'is revived' : 'quaffs it'} (rolled ${p.count}d${p.die}+${p.bonus}): +${gained} HP (now ${m.hp}/${m.maxHp})${revived ? ' — back on their feet!' : ''}.`, '/audio/spell_cure.mp3');
      this._log('potion', { name: p.name, who: m.playerId, rolled: heal, gained, revived });
    } else {
      const sell = Math.floor(p.gp / 2); this.runGold += sell;
      this._note(`🧪 A Potion of ${p.name} drops, but everyone's hale — hocked for ${sell} gp (pool ${this.runGold} gp).`);
      this._log('potion_sold', { name: p.name, sell });
    }
  }
  // Everyone present rolls 1d20 or passes; highest roll claims the item. AI only
  // rolls when it's an UPGRADE for them (better than what they have in that slot);
  // otherwise they pass. If nobody rolls, the item is hocked into the pool.
  _startLootRoll(slot, tier, eligibleIds) {
    this.lootRoll = { slot, tier, eligible: eligibleIds, decided: {} };
    const label = db.GEAR_BY_KEY[slot]?.label || slot;
    this._note(`💎 A +${tier} ${label} drops! Roll a d20 for it, or pass.`);
    this._log('lootdrop', { slot, tier, eligible: eligibleIds.length });
    // Decide immediately for anyone who can't benefit, and for bots:
    //   • ANY delver (human or bot) already wearing an equal-or-better item in this
    //     slot AUTO-PASSES — no point rolling to keep gear you'd never equip.
    //   • A bot that WOULD upgrade rolls right away.
    //   • A human who'd upgrade is left undecided → they get the roll/pass prompt.
    for (const id of eligibleIds) {
      const m = this.member(id);
      const cur = Number((m?.gear || db.getGear(id))[slot]) || 0;
      if (cur >= tier) { this._lootDecide(id, false); continue; }   // already have ≥ → auto-pass
      if (m && m.isBot) this._lootDecide(id, true);                 // bot upgrade → roll
    }
    // Idle humans auto-pass after the window.
    clearTimeout(this._lootTimer);
    this._lootTimer = setTimeout(() => {
      if (!this.lootRoll) return;
      for (const id of this.lootRoll.eligible) if (!(id in this.lootRoll.decided)) this._lootDecide(id, false, true);
    }, LOOT_ROLL_MS);
    this._broadcast();
  }
  _lootDecide(playerId, roll, byTimeout) {
    if (!this.lootRoll) return { ok: false, error: 'no loot roll' };
    if (!this.lootRoll.eligible.includes(playerId)) return { ok: false, error: 'not eligible for this loot' };
    if (playerId in this.lootRoll.decided) return { ok: false, error: 'already decided' };
    const m = this.member(playerId);
    if (roll) { const r = dRoll(20); this.lootRoll.decided[playerId] = r; this._note(`🎲 ${m?.nickname || playerId} rolls ${r} for the loot.`); }
    else { this.lootRoll.decided[playerId] = 'pass'; this._note(`🚫 ${m?.nickname || playerId} passes on the loot${byTimeout ? ' (idle)' : ''}.`); }
    if (this.lootRoll.eligible.every(id => id in this.lootRoll.decided)) this._resolveLootRoll();
    else this._broadcast();
    return { ok: true };
  }
  _resolveLootRoll() {
    clearTimeout(this._lootTimer);
    const lr = this.lootRoll; this.lootRoll = null;
    if (!lr) return;
    const rollers = lr.eligible.filter(id => typeof lr.decided[id] === 'number');
    if (!rollers.length) {
      // Nobody wanted it → hock it into the shared pool (split evenly on bail).
      const v = db.gearHockValue(lr.slot, lr.tier);
      this.runGold += v;
      this._note(`🚫 Everyone passed — the +${lr.tier} ${db.GEAR_BY_KEY[lr.slot]?.label || lr.slot} is hocked for ${v} gp into the pool.`);
      this._log('lootpass', { slot: lr.slot, tier: lr.tier, hocked: v });
      this._broadcast(); return;
    }
    let bestRoll = -1; for (const id of rollers) if (lr.decided[id] > bestRoll) bestRoll = lr.decided[id];
    const tied = rollers.filter(id => lr.decided[id] === bestRoll);
    const winnerId = tied.length > 1 ? pick(tied) : tied[0];
    const winner = this.member(winnerId);
    this._note(`🏆 ${winner?.nickname || winnerId} wins the +${lr.tier} ${db.GEAR_BY_KEY[lr.slot]?.label || lr.slot} with a ${bestRoll}${tied.length > 1 ? ' (tie-break)' : ''}.`);
    this._log('lootwin', { slot: lr.slot, tier: lr.tier, who: winnerId, roll: bestRoll });
    this._awardLoot(winnerId, lr.slot, lr.tier);
    // An AI who lost the roll might gripe about it.
    const aiLosers = rollers.filter(id => id !== winnerId).map(id => this.member(id)).filter(x => x && x.isBot);
    if (aiLosers.length) this._tryBanter(pick(aiLosers), 'loot_lose', { tier: lr.tier, item: db.GEAR_BY_KEY[lr.slot]?.label || lr.slot, winner: winner?.nickname });
    this._broadcast();
  }
  _awardLoot(playerId, slot, tier) {
    const m = this.member(playerId);
    const gear = db.getGear(playerId);
    const cur = Number(gear[slot]) || 0;
    if (m && m.isBot) {
      // AI: equip if it's a real upgrade (needs it), else hock for the pool.
      if (cur < tier) {
        gear[slot] = tier; db.setGear(playerId, gear); m.gear = gear;
        // (gear no longer changes level — level is from XP; gear only adds to-hit/AC/dmg)
        let extra = '';
        if (cur >= 1) { const v = db.gearHockValue(slot, cur); this.runGold += v; extra = ` (old +${cur} hocked for ${v} gp)`; }
        this._note(`🛡️ ${m.nickname} equips the +${tier} ${db.GEAR_BY_KEY[slot]?.label || slot}.${extra} (Lv ${m.level})`);
      } else {
        const v = db.gearHockValue(slot, tier); this.runGold += v;
        this._note(`💰 ${m.nickname} doesn't need it — hocks it for ${v} gp (into the pool).`);
      }
      this._tryBanter(m, 'loot_win', { tier, item: db.GEAR_BY_KEY[slot]?.label || slot });
      return;
    }
    // Human: lands in their pending loot to equip or hock as they choose.
    this.pendingLoot.push({ slot, tier, owner: playerId });
  }

  // ── Combat math (rolls shown in the log) ─────────────────────────────────
  _fmtBonus(n) { return (n >= 0 ? '+' : '') + n; }
  // Recompute a member's level + HP from current gear (level = 1 + gear bonuses).
  // XP progress fields for the client (current band into/span + XP to next level).
  _xpInfo(m) { const p = xpProgress(m.xp || 0); return { xp: p.xp, xpInto: p.into, xpSpan: p.span, xpToNext: p.toNext, maxLevel: p.next == null }; }
  // Apply a hero's level + HP from their XP total — handles level UP (room-clear
  // awards) and the death-penalty level DOWN. Returns the signed level delta.
  _applyLevelFromXp(m, xp) {
    m.xp = xp;
    const nl = levelFromXp(xp);
    const old = m.level || 1;
    if (nl === old) return 0;
    const _featHp = (fighterFeats(m.cls, nl, this._isRanged(m)).hp) || 0;
    const nmax = deriveCharacter({ cls: m.cls, level: nl, baseScores: m.abilityScores, featHp: _featHp }).hp;
    const gain = nmax - m.maxHp;
    m.level = nl; m.maxHp = nmax;
    this._setDerived(m);                    // refresh ability mods / iteratives at the new level
    if (gain > 0) m.hp += gain;             // level up heals the new HP
    else if (m.hp > nmax) m.hp = nmax;      // level down caps current HP to the new max
    return nl - old;
  }
  // HASTE's secondary bonuses (PF1): +1 to attack rolls, +1 dodge AC, +1 Reflex —
  // active ONLY while the FULL Haste spell is up (m.hasteFull), NOT for Blessing of
  // Fervor's extra-attack-only choice. A flat +1 gated on `hasted` means it can't
  // stack with itself and ends exactly when Haste does. (Engine saves are generic,
  // so the Reflex bonus reads as +1 to all saves — a small, benign approximation.)
  _hasteMod(m) { return (m && m.hasted > 0 && m.hasteFull) ? 1 : 0; }
  _partySaveMod(m) { return (m.level || 1) + ((m.buffs && m.buffs.save) || 0) + fighterFeats(m.cls, m.level, this._isRanged(m)).save + this._hasteMod(m); }   // saves scale with level (+ rage's +Will, + fighter save feats, + Haste's +1 Reflex)
  // How much a hero's AC is lowered right now: sticky penalty (rage) + a
  // this-turn penalty (reckless / barbarian cleave drop their guard).
  _acPenalty(m) { return ((m.buffs && m.buffs.acPen) || 0) + (m.acPenRound === this.round ? (m.acPenAmt || 0) : 0) + (m.grappled ? 2 : 0); }
  // Is this hero fighting with two weapons (a double/dual weapon, or a rogue's
  // paired daggers)? Drives Two-Weapon Defense and the TWF attack sequence.
  _isDualWielding(m) {
    const w = m.weapon || weaponOf(m.gear, m.weaponKey);
    // Monk FLURRY OF BLOWS: any melee attack is a two-strike flurry (their free
    // TWF/ITWF flags in monkFeats keep the penalty at −2/−2 like real Flurry).
    if (m.cls === 'monk' && w && !w.ranged) return true;
    return !!(w && (w.dual || (m.cls === 'rogue' && (m.weaponKey === 'dagger' || m.weaponKey === 'kukri'))));
  }
  _acBonus(m) {   // magus Shield (+4) + inquisitor Judgement: Protection + fighter Dodge (+1) + Haste (+1 dodge)
    let b = ((m.buffs && m.buffs.ac) || 0) + (m.mageArmor ? 4 : 0) + (m.judgment === 'protection' ? Math.max(1, Math.floor((m.level || 1) / 3)) : 0) + fighterFeats(m.cls, m.level, this._isRanged(m)).ac + this._hasteMod(m) + (m._offDef ? 2 : 0);   // rogue Offensive Defense: +2 AC after landing a sneak attack (until they next act)
    if (fighterFeats(m.cls, m.level, this._isRanged(m)).twDef && this._isDualWielding(m)) b += 1;   // Two-Weapon Defense
    return b;
  }
  // A hero's three PF1 AC values (base, no situational mods) — for display + touch
  // resolution. touch drops armor/shield/mage-armor; flat-footed drops Dodge.
  // acOf for a hero, weapon-aware: a RANGED weapon (bow/crossbow/gun) or a
  // dual-wield/no-shield weapon grants no shield AC (they can still own the shield
  // for its treasure value). Centralizes the shield-AC exclusion in one place.
  _acOf(m) {
    const w = m.weapon || weaponOf(m.gear, m.weaponKey);
    return acOf(m.gear, m.cls, { noShield: !!(w && (w.noShield || w.ranged)) });
  }
  _heroACs(m) {
    const a = this._acOf(m);
    const ac = a.ac + this._acBonus(m);
    return {
      ac,
      touchAC: Math.max(10, ac - a.physical - (m.mageArmor ? 4 : 0)),
      ffAC:    Math.max(10, ac - fighterFeats(m.cls, m.level, this._isRanged(m)).ac),
    };
  }
  _atkStr(r) { return `[d20 ${r.roll} ${this._fmtBonus(r.toHit)} = ${r.total} vs AC ${r.ac}]`; }
  _swingVsAC(attacker, ac, target, extraToHit = 0, offHand = false) {
    const weapon = attacker.weapon;
    const sick = attacker.sickened > 0 ? SICKENED_PENALTY : 0;
    const lvl = attacker.level || 1;
    const cls = attacker.cls || 'fighter';
    // MAGUS Arcane Pool — an automatic, level-scaled weapon enhancement (the magus
    // is always treated as wielding at least this grade): +1@1, +2@5, keen@6,
    // flaming@8, +3@9, flaming burst@11, +4@13, +5@17. The real weapon's enchant
    // wins if it's higher; keen/flaming layer on top.
    let arcEnhDelta = 0, arcKeen = false, arcFlame = 0, arcFlameBurst = false, arcHoly = 0, arcUnholy = 0;
    if (cls === 'magus') {
      const arcEnh = lvl >= 17 ? 5 : lvl >= 13 ? 4 : lvl >= 9 ? 3 : lvl >= 5 ? 2 : 1;
      arcEnhDelta = Math.max(0, arcEnh - (weapon.dmgBonus || 0));   // only the part above the real enchant
      arcKeen = lvl >= 6;
      arcFlame = lvl >= 8 ? 1 : 0;        // +1d6 fire on each hit
      arcFlameBurst = lvl >= 11;          // flaming burst: extra fire dice on a crit
    } else if ((cls === 'paladin' || cls === 'antipaladin') && lvl >= 5) {
      // DIVINE BOND (paladin) / FIENDISH BOON (antipaladin) — a celestial/fiendish
      // spirit pours into the weapon: an automatic enhancement of +1@5, +2@8, +3@11,
      // +4@14, +5@17, +6@20 (PF1). The real weapon's enchant wins if it's higher.
      // From 8th the blade turns HOLY/UNHOLY: +2d6 vs EVIL (paladin) / vs GOOD
      // (antipaladin), granted free on top — the way the magus gets flaming.
      const bond = lvl >= 20 ? 6 : lvl >= 17 ? 5 : lvl >= 14 ? 4 : lvl >= 11 ? 3 : lvl >= 8 ? 2 : 1;
      arcEnhDelta = Math.max(0, bond - (weapon.dmgBonus || 0));
      if (lvl >= 8) { if (cls === 'paladin') arcHoly = 2; else arcUnholy = 2; }
    }
    // Dimensional Blade — for 1 round the magus's strikes resolve as TOUCH attacks.
    if (attacker.touchStrike > 0 && target) ac = this._enemyAC(target, { touch: true });
    // Fly / Overland Flight (magus) — a flyer can melee airborne foes (no high-ground gap).
    if (attacker.canHitFlyers && attacker.flying && target && target.flying) ac -= HIGH_GROUND_AC;
    // Point Blank Shot: +1 to hit & damage with a bow/crossbow, but ONLY against a
    // foe that has closed to melee — i.e. one that has struck an ally this room
    // (_engagedAlly). A distant/untouched foe is out of point-blank range.
    const pbs = (weapon && weapon.ranged && target && target._engagedAlly) ? (fighterFeats(cls, lvl, true).pbs || 0) : 0;
    // Smite Evil: an ACTIVATED smite (paladin's ability) vs an evil foe adds a
    // to-hit bump + bonus (un-multiplied) damage equal to level.
    const smite = !!(attacker.smiteActive && target && (target.evil || target.markedEvil));   // Detect Evil marks neutral foes smite-able
    // Sneak Attack: rogue-likes add precision dice vs a target that's denied its
    // defenses — flat-footed, prone, sickened, or paralyzed (PF1e). NOT crit-multiplied.
    // A target is denied its Dex vs an UNSEEN attacker too — Greater Invisibility
    // keeps a rogue striking from concealment, so every hit is a Sneak Attack.
    const denied = !!(target && (target.flatFooted || target.prone || target.sickened > 0 || target.paralyzed > 0 || target.fascinated || target.blinded > 0)) || !!attacker.greaterInvis;
    const sneakOk = SNEAK_CLASSES.has(cls) && denied;
    const sneakDice = sneakOk ? Math.min(SNEAK_DICE_CAP, Math.max(1, Math.ceil(lvl / 2))) : 0;
    // Sticky room buffs (Rage / Judgment / Bane / Inspire Courage / Prayer)
    // PLUS run-long buffs (Bless's +1 to-hit) that persist across rooms.
    const rb = attacker.runBuffs || {};
    const rbuff = attacker.buffs || {};
    const buff = {
      toHit: (rbuff.toHit || 0) + (rb.toHit || 0),
      dmg: (rbuff.dmg || 0) + (rb.dmg || 0),
      bonusDice: rbuff.bonusDice || 0,
    };
    // Inquisitor BANE — declared against ONE creature type (see _abBane). Its
    // +2 hit / +2d6+2 damage applies ONLY when THIS target is that type.
    const baneOn = !!(attacker.bane && target && target.type && target.type === attacker.bane.type);
    const baneHit = baneOn ? BANE_TOHIT : 0;
    // PF1e to-hit = class BAB (level-scaled) + ability mod + weapon bonus
    // (masterwork +1 / +N enhancement, carried on weapon.toHit) + smite + buffs,
    // minus a non-proficiency penalty if the class can't use this weapon.
    const bab = babFor(cls, lvl);
    const smiteHit = smite ? SMITE_TOHIT : 0;
    // NPCs are hand-assigned their signature weapons, so they're always
    // proficient; the −4 penalty only guides human weapon choices.
    const notProf = (attacker.isBot || weaponProficient(cls, weapon)) ? 0 : NON_PROFICIENT_PENALTY;
    const ff = fighterFeats(cls, lvl, !!(weapon && weapon.ranged));   // bonus feats — RANGED ladder with a bow/crossbow, else melee
    // Swashbuckler — only with a finessable weapon: Weapon Focus, Weapon
    // Specialization, Precise Strike (+level, NOT crit-multiplied), Improved Critical.
    const swashFin = cls === 'swashbuckler' && isFinesseWeapon(weapon);
    const swashWF = swashFin ? 1 : 0;
    const swashSpec = (swashFin && lvl >= 4) ? 2 : 0;
    const preciseDmg = (swashFin && lvl >= 3) ? lvl : 0;   // Precise Strike: +swashbuckler level
    // Real PF1 ability mods: to-hit from STR (or DEX for a finesse/ranged weapon),
    // damage from STR ×1 / ×1.5 two-handed / ×0.5 off-hand (or DEX). Falls back to
    // the legacy +4 if a member has no derived mods yet. Replaces the ABILITY_MOD
    // placeholder, and the level-scaled damage ramp is dropped (iteratives + feats
    // now carry high-level scaling — see the iterative loop in _playerAttack).
    const _ap = attacker.mods ? attackProfile({ mods: attacker.mods }, weapon, { offHand }) : { toHitMod: ABILITY_MOD, dmgBonus: ABILITY_MOD };   // off-hand swing → ½ ability mod to DAMAGE (PF1 two-weapon fighting)
    const toHit = bab + _ap.toHitMod + (weapon.toHit || 0) + arcEnhDelta + smiteHit + baneHit + (buff.toHit || 0) + pbs + extraToHit + notProf - sick - (attacker.grappled ? 2 : 0) + ff.hit + swashWF;
    const roll = dRoll(20), total = roll + toHit;
    if (roll === 1) return { hit: false, fumble: true, roll, toHit, total, ac, sound: SND.fumble };
    const hit = roll === 20 || total >= ac;
    if (!hit) return { hit: false, roll, toHit, total, ac, sound: weapon.isDagger ? SND.whiffDagger : pick(SND.whiffSword) };
    // Damage = weapon dice (NdX) + enhancement + ½ level + ability mod + buff dmg (+ Point Blank).
    const judgDmg = attacker.judgment === 'destruction' ? Math.max(1, Math.floor(lvl / 3)) : 0;   // inquisitor Judgement: Destruction
    const flatDmg = _ap.dmgBonus + (buff.dmg || 0) + (baneOn ? BANE_DMG : 0) + pbs + judgDmg + ff.dmg + swashSpec + arcEnhDelta;
    // Natural attacks (a druid's claws/bite) grow their DICE with the wielder's SIZE
    // (the bigger combat forms enlarge them) and with Improved Natural Weapon — both
    // step the dice up the PF1 size table (1d6→1d8→2d6→…), stacking.
    let dmgCount = weapon.dmgCount, dmgDie = weapon.dmgDie;
    // MONK Improved Unarmed Strike (free class feature): fists follow the PF1 monk
    // ladder — 1d6, 1d8@L4, 1d10@L8, 2d6@L12, 2d8@L16, 2d10@L20 (replaces the 1d3).
    if (attacker.cls === 'monk' && weapon.key === 'unarmed') {
      const MONK_FIST = [[1, 6], [1, 8], [1, 10], [2, 6], [2, 8], [2, 10]];
      const t = MONK_FIST[Math.min(5, Math.floor(lvl / 4))];
      dmgCount = t[0]; dmgDie = t[1];
    }
    if (weapon.group === 'natural') {
      const steps = ((attacker.form && attacker.form.sizeSteps) || 0) + (ff.inw ? 1 : 0);
      if (steps > 0) { const st = stepDamage(dmgCount, dmgDie, steps); dmgCount = st.count; dmgDie = st.die; }
    }
    const rollDmg = () => dRollN(dmgCount, dmgDie) + weapon.dmgBonus + flatDmg;
    let dmg = rollDmg() - sick, crit = false;
    // Improved Critical doubles the weapon's threat range (fighter L8; swashbuckler
    // L5 with a finesse blade). Critical Focus (fighter L9) adds +4 to confirm.
    const impCrit = ff.impCrit || (swashFin && lvl >= 5) || arcKeen;   // fighter / swashbuckler / magus arcane-pool keen (don't stack)
    const effCritRange = impCrit ? (2 * weapon.critRange - 21) : weapon.critRange;
    const critFocus = (ff.critFocus ? 4 : 0) + (ff.critMastery ? 4 : 0);   // Critical Focus +4, Critical Mastery +4 more (+8 confirm)
    if (roll >= effCritRange) { const conf = dRoll(20) + bab + _ap.toHitMod + (weapon.toHit || 0) + smiteHit + baneHit + (buff.toHit || 0) + pbs + extraToHit + notProf + ff.hit + swashWF + critFocus; if (conf === 20 || conf >= ac) { crit = true; for (let i = 1; i < weapon.critMult; i++) dmg += rollDmg(); } }
    // Precision (sneak / swashbuckler Precise Strike), smite, and bane dice ride on
    // top — NOT multiplied by a crit.
    let sneakDmg = 0;
    if (preciseDmg) dmg += preciseDmg;   // swashbuckler Precise Strike
    if (sneakDice) { sneakDmg = dRollN(sneakDice, 6); dmg += sneakDmg; }
    if (buff.bonusDice) dmg += dRollN(buff.bonusDice, 6);   // misc bonus dice
    if (baneOn) dmg += dRollN(BANE_DICE, 6);                // Inquisitor Bane — +2d6 vs the declared type
    if (smite) dmg += 2 * lvl;   // Smite Evil: +double level damage
    // PHYSICAL DR: the foe soaks the weapon's physical damage (dice + static + crit +
    // precision/sneak/bane/smite) unless this weapon's TYPE (S/P/B) or its magic
    // bypasses the foe's DR. A clean hit is ≥1 before DR; DR can soak it to 0 (a sword
    // glancing off a skeleton). Elemental riders (flaming) ride on top, unsoaked.
    dmg = Math.max(1, dmg);
    let drTag = '';
    [dmg, drTag] = this._physDR(target, dmg, weapon, ff.prStrike || 0);   // Penetrating Strike pierces 5/10 of the DR
    // First time the party lands a blow on a creature with DR, announce what it has
    // (once per creature TYPE per run) so they can switch to the weapon that bites.
    const _drAmt = target.dr ? (typeof target.dr === 'object' ? target.dr.amount : target.dr) : 0;
    if (_drAmt > 0) { this._drSeen = this._drSeen || new Set(); if (!this._drSeen.has(target.name)) { this._drSeen.add(target.name); this._note(`🛡️ ${target.name}: ${this._drDesc(target.dr)}.`); } }
    // Magus arcane-pool FLAMING: +1d6 FIRE each hit (elemental — not soaked by physical
    // DR, not crit-multiplied); FLAMING BURST adds extra fire dice on a confirmed crit.
    // Routed through the target's FIRE resistance/immunity/vulnerability (Phase 4) —
    // a flaming blade does nothing extra to a devil and ×1.5 to a wood golem.
    if (arcFlame) dmg += this._resisted(target, dRollN(arcFlame, 6), 'fire');
    if (crit && arcFlameBurst) dmg += this._resisted(target, dRollN(Math.max(1, (weapon.critMult || 2) - 1), 10), 'fire');
    // Divine Bond HOLY (paladin) / Fiendish Boon UNHOLY (antipaladin): +2d6 of aligned
    // energy that only bites the opposed alignment — vs EVIL foes (holy) / GOOD foes
    // (unholy). Rides on top: not soaked by physical DR, not crit-multiplied.
    if (arcHoly && (target.evil || target.markedEvil)) dmg += dRollN(arcHoly, 6);
    if (arcUnholy && target.good) dmg += dRollN(arcUnholy, 6);
    return { hit: true, crit, smite, sneakDice, sneakDmg, damage: Math.max(0, dmg), drTag, roll, toHit, total, ac, sound: pick(SND.flesh) };
  }
  _monsterSwing(e, targetAC) {
    const sick = e.sickened > 0 ? SICKENED_PENALTY : 0;
    const pray = e.prayed || 0;   // Prayer: −1 to the enemy's attacks & damage
    // High ground: a flyer swooping on grounded heroes gets a to-hit edge.
    const toHit = e.toHit - sick - pray - (e.blinded > 0 ? 4 : 0) + (e.flying ? HIGH_GROUND_HIT : 0);
    const roll = dRoll(20), total = roll + toHit;
    if (roll === 1) return { hit: false, roll, toHit, total, ac: targetAC, sound: SND.fumble };
    const hit = roll === 20 || total >= targetAC;
    if (!hit) return { hit: false, roll, toHit, total, ac: targetAC, sound: pick(SND.whiffSword) };
    let dmg = e.dmgBonus - sick - pray;
    for (let i = 0; i < (e.dmgCount || 1); i++) dmg += dRoll(e.dmgDie);   // e.g. golem slam = 2d10+9
    return { hit: true, damage: Math.max(1, dmg), roll, toHit, total, ac: targetAC, sound: pick(SND.flesh) };
  }
  _enemyAct(e) {
    e.flatFooted = false;   // acting ends flat-footed
    if (e.prone) { e.prone = false; this._note(`${e.glyph} ${e.name} clambers back to its feet.`); }
    if (!this.livingParty().length) return;
    // Taunted: compelled to go straight at the barbarian who taunted it — this
    // overrides its specials and target choice. The pull lasts only this (its
    // next) turn, so consume it now.
    let forced = null;
    if (e.taunted) {
      forced = this._targetableParty().find(p => p.playerId === e.taunted && p.hp > 0 && !p.left) || null;
      e.taunted = null;
      if (forced) this._note(`📢 ${e.glyph} ${e.name}, taunted, charges ${forced.nickname}!`, null, { side: 'enemy' });
    }
    if (!forced) {
      // Fire Skeleton: its whole purpose is to rush in and blow up. If it survives
      // to its turn, it detonates (and dies) instead of making a normal attack.
      if (e.detonate && !e._exploded) return this._detonate(e);
      // Kobold shaman: cast Hold Person on an unheld target before resorting to melee.
      if (e.caster === 'holdperson' && e.castsLeft > 0) {
        const free = this._targetableParty().filter(m => !(m.paralyzed > 0));
        if (free.length) return this._enemyCastHold(e, pick(free));
      }
      // Lich — a full WIZARD of its level. It casts every turn; its spellbook and
      // save DCs scale with the dungeon depth. _lichCast plays the controller:
      // lock a bruiser (Hold Monster), blast a cluster (Fireball/Cone/Chain),
      // delete the toughest (Disintegrate/Finger of Death), finish the wounded
      // (Magic Missile), or freeze one with its dread gaze.
      if (e.arcane && this._targetableParty().length) return this._lichCast(e);
      // Skeletal Champion: a bone-rattling shout — 1d8 + save-or-stunned.
      if (e.shout && e.shoutsLeft > 0 && dRoll(2) === 1) {
        const awake = this._targetableParty().filter(m => !(m.stunned > 0) && !(m.paralyzed > 0));
        if (awake.length) return this._enemyShout(e, pick(awake));
      }
      // Vampire (magus of its level): a Vampiric Touch spellstrike — a draining
      // melee blow that heals it. (Needs a grounded hero to touch.)
      if (e.spellstrike && dRoll(2) === 1) {
        const reach = this._targetableParty().filter(m => !m.flying);
        if (reach.length) return this._enemySpellstrike(e, pick(reach.filter(m => m.paralyzed > 0).length ? reach.filter(m => m.paralyzed > 0) : reach));
      }
      // Goblin Barbarian: roar a taunt (once) to pull the party's AI onto it.
      if (e.taunt && e.tauntsLeft > 0 && this.livingParty().some(m => m.isBot)) return this._enemyTaunt(e);
      // Barbed Devil: occasionally a Hellfire Blast; otherwise chain-hook the
      // weakest hero and CRUSH whoever it's already grappling.
      if (e.hellfire && e.hellfireLeft > 0 && this._targetableParty().length >= 2 && dRoll(3) === 1) return this._enemyHellfire(e);
      if (e.hook) {
        const victim = this._targetableParty().find(p => p.grappled && p.grappledBy === e.uid);
        if (victim) return this._enemyConstrict(e, victim);
        const weakest = this._targetableParty().slice().sort((a, b) => a.hp - b.hp)[0];
        if (weakest) return this._enemyHook(e, weakest);
      }
    }
    // Melee — the kobold rogue stabs twice (1d3 each); everyone else swings once.
    // A taunted foe hammers the barbarian; otherwise re-pick a living, TARGETABLE
    // (non-invisible), preferably-helpless target. FLYING heroes are out of reach
    // of a GROUNDED foe (Fly = immune to non-ranged attacks); a flyer can hit them.
    let noReach = false;
    for (let i = 0; i < Math.max(1, e.attacks || 1); i++) {
      const seen = this._targetableParty();
      const living = e.flying ? seen : seen.filter(m => !m.flying);
      if (!living.length) { noReach = seen.length > 0; break; }
      if (forced && forced.hp > 0 && !forced.left && (e.flying || !forced.flying)) { this._enemyMelee(e, forced); continue; }
      const helpless = living.filter(m => m.paralyzed > 0);
      this._enemyMelee(e, pick(helpless.length ? helpless : living));
    }
    if (noReach) this._note(`${e.glyph} ${e.name} claws at the air — its prey is on the wing, out of reach!`, null, { side: 'enemy' });
  }
  // One enemy swing at a chosen target (handles the paralysis rider + signature sound).
  _enemyMelee(e, target) {
    // _acOf strips shield AC for dual-wielders AND ranged-weapon wielders.
    const effAC = this._acOf(target).ac + this._acBonus(target) - (target.paralyzed > 0 ? 4 : 0) - this._acPenalty(target);   // helpless / rage / reckless / cleave: easier to hit
    const r = this._monsterSwing(e, effAC);
    if (e.atkSounds && e.atkSounds.length) r.sound = pick(e.atkSounds);   // monk's randomized "bruce" kiai (hit or miss)
    else if (r.hit && e.atkSound) r.sound = e.atkSound;                    // rogue's "riki" stab (hit only)
    if (r.hit) {
      // Swashbuckler PARRY — the first melee attack against them each round can be
      // turned aside (parry roll vs the foe's attack total). On success: NO damage
      // and a free RIPOSTE. The attempt is spent for the round either way.
      if (target.cls === 'swashbuckler' && target._parryRound !== this.round && target.hp > 0 && !(target.paralyzed > 0) && !(target.stunned > 0)) {
        target._parryRound = this.round;
        const pRoll = dRoll(20) + babFor('swashbuckler', target.level || 1) + ABILITY_MOD + ((target.buffs && target.buffs.toHit) || 0) + this._hasteMod(target);
        if (pRoll >= r.total) {
          this._note(`🤺 ${target.nickname} PARRIES ${e.glyph} ${e.name}'s strike [${pRoll} vs ${r.total}] — no damage, and RIPOSTES!`, '/audio/sneak_riki.mp3');
          target.weapon = weaponOf(target.gear, target.weaponKey);
          const rr = this._swingVsAC(target, this._enemyAC(e), e);
          if (rr.hit) { this._dmgE(e, rr.damage); this._note(`🗡️ ${target.nickname}'s riposte hits ${e.name} for ${rr.damage}.${this._afterEnemyHit(e)}`, rr.sound); if (e.hp <= 0) this._tryBanter(target, 'down', { enemy: e.name }); }
          else this._note(`🗡️ ${target.nickname}'s riposte misses ${e.name}. ${this._atkStr(rr)}`, rr.sound);
          this._echoToTable(rr.sound);
          return;   // the incoming attack is fully negated
        }
        this._note(`🤺 ${target.nickname} tries to parry, but ${e.name}'s blow beats the blade. [${pRoll} vs ${r.total}]`, null);
      }
      // Mirror Image / Displacement — a decoy soaks, or the blurred form is missed.
      if (this._evadeIncoming(target, e)) { this._echoToTable(r.sound); return; }
      e._engagedAlly = true;   // a melee foe that has struck an ally → within Point Blank Shot range this room
      let dmg = r.damage, sneakTag = '';
      // Enemy Sneak Attack (goblin/kobold rogues): +Xd6 vs a hero who's denied
      // their defenses — flat-footed (hasn't acted yet) or HELD by a shaman.
      if (e.sneakDice && (target.paralyzed > 0 || target.flatFooted)) {
        const sn = dRollN(e.sneakDice, 6); dmg += sn; sneakTag = ` 🗡️+${sn} sneak!`;
      }
      let drTag = ''; [dmg, drTag] = this._physDR(target, dmg);   // Stoneskin soaks physical blows
      target.hp -= dmg;
      this._note(`${e.glyph} ${e.name} hits ${target.nickname} for ${dmg}.${sneakTag}${drTag} ${this._atkStr(r)} (${Math.max(0, target.hp)}/${target.maxHp} HP)`, r.sound);
      this._fireShieldRetaliate(target, e);   // Fire Shield scorches a melee attacker
      if (target.hp <= -10) { this._memberDown(target); this._echoToTable(r.sound); return; }   // dead at −10
      if (target.hp <= 0)   { this._downMember(target); this._echoToTable(r.sound); return; }    // 0..−9 = down/dying
      if (e.paralyze && target.elemBody) { this._note(`🌪️ ${target.nickname}'s Elemental Body shrugs off the paralysis.`); }
      else if (e.paralyze) {
        const pdc = e.paralyzeDC || PARALYZE_DC;
        const sm = this._partySaveMod(target), sroll = dRoll(20), stot = sroll + sm;
        const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= pdc;
        if (!saved) { target.paralyzed = 1; this._note(`🥶 ${target.nickname} fails the paralysis save [d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs DC ${pdc}] — paralyzed!`); }
        else this._note(`${target.nickname} resists paralysis [d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs DC ${pdc}].`);
      }
      if (target.hp > 0 && target.isBot) this._tryBanter(target, 'damage', { enemy: e.name, dmg: r.damage });
    } else {
      this._note(`${e.glyph} ${e.name} misses ${target.nickname}. ${this._atkStr(r)}`, r.sound);
    }
    this._echoToTable(r.sound);
  }
  // Kobold shaman's Hold Person: fail a Will save (DC 10 + ½ caster level) → lose a turn.
  _enemyCastHold(e, target) {
    e.castsLeft -= 1;
    const dc = e.spellDC || 13;
    const sm = this._partySaveMod(target), sroll = dRoll(20), stot = sroll + sm;
    const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= dc;
    const roll = `[Will d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs DC ${dc}]`;
    if (!saved) {
      // HELD: multiple rounds, but the hero re-saves each of their turns (and the
      // attempt costs the turn either way) — see heldDC handling in _advanceToActor.
      target.paralyzed = Math.max(target.paralyzed || 0, 3); target.heldDC = dc;
      this._note(`🪄 ${e.glyph} ${e.name} casts Hold Person on ${target.nickname} — HELD! ${roll} (re-save each turn to break free)`, null, { side: 'enemy' });
    } else {
      this._note(`🪄 ${e.glyph} ${e.name} casts Hold Person on ${target.nickname}, who breaks free. ${roll}`, null, { side: 'enemy' });
    }
    this._broadcast();
  }
  // Skeletal Champion's shout: 1d8 sonic damage, Fort save or STUNNED 1 round.
  _enemyShout(e, target) {
    e.shoutsLeft -= 1;
    const cfg = e.shout || {};
    const fear = !!cfg.fear;   // Lich/Vampire sinister gaze: no damage, Will save or frozen in terror
    const dmg = fear ? 0 : dRollN(1, 8);
    if (dmg) this._dmgToMember(target, dmg);
    const dc = cfg.dc || e.spellDC || 14;
    const sm = this._partySaveMod(target), sroll = dRoll(20), stot = sroll + sm;
    const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= dc;
    const roll = `[${fear ? 'Will' : 'Fort'} d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs DC ${dc}]`;
    const snd = cfg.sound || null;
    if (!saved && target.hp > 0 && target.elemBody) {
      this._note(`🌪️ ${target.nickname}'s Elemental Body shrugs off the ${fear ? 'terror' : 'stun'}. ${roll}`, snd);
    } else if (!saved && target.hp > 0) {
      target.stunned = Math.max(target.stunned || 0, 1);
      this._note(fear
        ? `👁️ ${e.glyph} ${e.name}'s sinister gaze freezes ${target.nickname} in TERROR — loses a turn! ${roll}`
        : `📢 ${e.glyph} ${e.name} looses a bone-rattling shout — ${target.nickname} takes ${dmg} and is STUNNED! ${roll}`, snd);
    } else {
      this._note(fear
        ? `👁️ ${e.glyph} ${e.name} glares at ${target.nickname}, who steels their nerve. ${roll}`
        : `📢 ${e.glyph} ${e.name} shouts at ${target.nickname} for ${dmg}${target.hp > 0 ? ', who shrugs off the daze' : ''}. ${roll}`, snd);
    }
    this._echoToTable(snd);
    this._broadcast();
  }
  // Goblin Barbarian's Taunt: a Predator-roar challenge. EVERY hero (human or AI)
  // must make a Will save or be COMPELLED — its next attack (incl. a free Haste/
  // Cleave swing) is forced onto the goblin, no matter what it tried to target.
  // Once per encounter.
  _enemyTaunt(e) {
    e.tauntsLeft -= 1;
    const cfg = e.taunt || {};
    const dc = cfg.dc || 13;
    const snd = cfg.sound || null;
    const parts = [];
    for (const m of this.livingParty()) {
      const sm = this._partySaveMod(m), sroll = dRoll(20), stot = sroll + sm;
      const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= dc;
      if (!saved) m.tauntedBy = e.uid;
      parts.push(`${m.nickname}: ${saved ? 'unmoved' : `📢 must strike ${e.name}`} [${stot} vs ${dc}]`);
    }
    this._note(`📢 ${e.glyph} ${e.name} roars a furious challenge — ${parts.join('; ')}!`, snd, { side: 'enemy' });
    this._echoToTable(snd);
    this._broadcast();
  }
  // Barbed Devil's chain HOOK — hurled at the weakest hero; on a hit it bites for
  // damage and GRAPPLES them (cleared by Dispel Magic or Grease — see _abCleanse
  // / _abGrease). While grappled the hero takes −2 to hit and is easier to strike.
  _enemyHook(e, target) {
    const cfg = e.hook || {};
    const snd = cfg.sound || null;
    const effAC = this._acOf(target).ac + this._acBonus(target) - (target.paralyzed > 0 ? 4 : 0) - this._acPenalty(target);
    const r = this._monsterSwing(e, effAC);
    if (!r.hit) {
      this._note(`⛓️ ${e.glyph} ${e.name} hurls its barbed chain at ${target.nickname} — the hook scrapes past. ${this._atkStr(r)}`, snd, { side: 'enemy' });
      this._echoToTable(snd); this._broadcast(); return;
    }
    const [hookDmg, hookDR] = this._physDR(target, r.damage);   // Stoneskin soaks the bite
    this._dmgToMember(target, hookDmg);
    if (!target.dead && target.hp > -10) { target.grappled = true; target.grappledBy = e.uid; }
    this._note(`⛓️ ${e.glyph} ${e.name}'s hook BITES ${target.nickname} for ${hookDmg}${hookDR} and drags them into a GRAPPLE! ${this._atkStr(r)} (Dispel or Grease to break free)`, snd, { side: 'enemy' });
    this._echoToTable(snd); this._broadcast();
  }
  // Crush a hero the devil is already grappling — automatic chain damage.
  _enemyConstrict(e, target) {
    const cfg = e.hook || {};
    const [dmg, drTag] = this._physDR(target, dRollN(2, 8) + 4);   // Stoneskin soaks the crush
    this._dmgToMember(target, dmg);
    this._note(`⛓️ ${e.glyph} ${e.name}'s chains CRUSH the grappled ${target.nickname} for ${dmg}${drTag}! (Dispel or Grease to break free)`, cfg.sound, { side: 'enemy' });
    this._echoToTable(cfg.sound); this._broadcast();
  }
  // Barbed Devil's Hellfire Blast — fire AoE on a random handful of heroes,
  // Reflex for half. Rolls its damage once for the whole burst.
  _enemyHellfire(e) {
    e.hellfireLeft -= 1;
    const cfg = e.hellfire || {};
    const live = this._targetableParty().slice();
    for (let i = live.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [live[i], live[j]] = [live[j], live[i]]; }
    const hit = live.slice(0, dRoll(cfg.count || 3));
    const dc = cfg.dc || 18, full = dRollN(cfg.dice || 5, cfg.die || 6), parts = [];
    for (const t of hit) {
      const sm = this._partySaveMod(t), sroll = dRoll(20), stot = sroll + sm;
      const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= dc;
      let dmg = saved ? Math.floor(full / 2) : full;
      const fireWarded = t.protectFire && (cfg.dtype || 'fire') === 'fire';   // the fire ward only blunts FIRE (not a dragon's acid/cold breath)
      if (fireWarded) dmg = Math.max(1, Math.floor(dmg / 2));
      this._dmgToMember(t, dmg);
      parts.push(`${t.nickname} ${saved ? 'half ' : ''}−${dmg}${fireWarded ? ' 🔥½' : ''}`);
    }
    // cfg.verb lets a dragon BREATHE and a bomb devil LOB instead of "hellfire".
    this._note(`🔥 ${e.glyph} ${e.name} ${cfg.verb || 'unleashes a HELLFIRE BLAST'} (${cfg.dice || 5}d${cfg.die || 6} → ${full}) — ${parts.join(', ')}! [Ref DC ${dc}]`, cfg.sound, { side: 'enemy' });
    this._echoToTable(cfg.sound); this._broadcast();
  }
  // Lich's Fireball (it casts as a wizard of its level): a roaring blast on a
  // random handful of heroes — Reflex for half, rolled once. Area damage, so it
  // reaches flyers too; Evasion negates a made save; Fire Ward halves it.
  // ── Lich: a full wizard of its level ───────────────────────────────────────
  // Its caster level scales with depth; save DCs = 10 + spell level + Int mod.
  // Each turn it reads the board and picks the strongest play. Spells unlock with
  // level, just like a real wizard climbing through the spell tiers.
  _lichCast(e) {
    const heroes = this._targetableParty();
    if (!heroes.length) return;
    const cl = Math.min(30, Math.max(12, this.depth || 12));   // caster level by depth
    const im = 4 + Math.floor(cl / 4);                          // Intelligence modifier
    const dc = (slvl) => 10 + slvl + im;                        // PF1 spell save DC
    const MART = new Set(['fighter', 'barbarian', 'paladin', 'antipaladin', 'ranger', 'rogue', 'monk', 'magus', 'cavalier', 'inquisitor', 'slayer', 'bloodrager']);
    const byHp = heroes.slice().sort((a, b) => b.hp - a.hp);
    const strongest = byHp[0], weakest = byHp[byHp.length - 1];

    // ~1-in-6: freeze a hero with the dread gaze (its limited fear attack).
    if (e.shout && e.shoutsLeft > 0 && dRoll(6) === 1) {
      const awake = heroes.filter(m => !(m.stunned > 0) && !(m.paralyzed > 0));
      if (awake.length) return this._enemyShout(e, pick(awake));
    }
    // 1) Lock down a dangerous, un-held melee bruiser with Hold Monster (5th) —
    //    only if nobody's already held (don't waste it).
    const bruiser = heroes.find(m => !(m.paralyzed > 0) && MART.has(m.cls) && m.hp > m.maxHp * 0.4);
    if (cl >= 9 && bruiser && !heroes.some(m => m.paralyzed > 0)) return this._enemyHoldHero(e, bruiser, dc(5), 'Hold Monster');
    // 2) Finish a badly-wounded hero with auto-hitting Magic Missile (1st).
    if (weakest.hp <= weakest.maxHp * 0.28) return this._enemyMissiles(e, weakest, Math.min(5, Math.floor((cl + 1) / 2)));
    // 3) A cluster of foes → a rotating elemental blast (mostly), else a nuke.
    if (heroes.length >= 2 && dRoll(5) <= 3) {
      const blasts = [{ verb: 'hurls a FIREBALL', icon: '🔥', dtype: 'fire', dice: Math.min(10, cl), slvl: 3, count: () => dRoll(3) + 1, sound: '/audio/spell_fireball.mp3' }];
      if (cl >= 9)  blasts.push({ verb: 'breathes a CONE OF COLD', icon: '❄️', dtype: 'cold', dice: Math.min(15, cl), slvl: 5, count: () => dRoll(3) + 1, sound: '/audio/spell_coneofcold.mp3' });
      if (cl >= 11) blasts.push({ verb: 'looses CHAIN LIGHTNING', icon: '⚡', dtype: 'electricity', dice: Math.min(20, cl), slvl: 6, count: () => dRoll(4), sound: '/audio/spell_lightning.mp3' });
      const b = pick(blasts);
      return this._enemyBlast(e, { ...b, die: 6, dc: dc(b.slvl) });
    }
    // 4) Delete the toughest hero with a big single-target nuke — Finger of Death
    //    (7th, negative) at high level, else a Disintegrate ray (6th, force).
    if (cl >= 13 && dRoll(2) === 1) {
      return this._enemyNuke(e, strongest, { verb: 'speaks a FINGER OF DEATH at', icon: '💀', dtype: 'negative', dice: Math.min(25, cl), die: 8, dc: dc(7), saveLbl: 'Fort', partialDice: Math.floor(cl / 2), sound: '/audio/spell_umbral_bolt.mp3' });
    }
    return this._enemyNuke(e, strongest, { verb: 'fires a DISINTEGRATE ray at', icon: '☢️', dtype: 'force', dice: Math.min(40, cl * 2), die: 6, dc: dc(6), saveLbl: 'Fort', partialDice: 5, dust: true, sound: '/audio/spell_disintegrate.mp3' });
  }
  // A lich AoE blast on a random handful of heroes — save for half (Evasion = none
  // on a made save; Fire Ward halves fire). Damage rolled once for the whole burst.
  _enemyBlast(e, cfg) {
    const live = this._targetableParty().slice();
    for (let i = live.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [live[i], live[j]] = [live[j], live[i]]; }
    const hit = live.slice(0, Math.max(1, cfg.count ? cfg.count() : dRoll(3) + 1));
    const full = dRollN(cfg.dice, cfg.die || 6), parts = [];
    for (const t of hit) {
      const sm = this._partySaveMod(t), sroll = dRoll(20), stot = sroll + sm;
      const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= cfg.dc;
      let dmg = (saved && t.evasion) ? 0 : saved ? Math.floor(full / 2) : full;   // Evasion: no damage on a made save
      if (cfg.dtype === 'fire' && t.protectFire) dmg = Math.max(saved && t.evasion ? 0 : 1, Math.floor(dmg / 2));
      this._dmgToMember(t, dmg);
      parts.push(`${t.nickname} ${saved ? (t.evasion ? 'evades ' : 'half ') : ''}−${dmg}${cfg.dtype === 'fire' && t.protectFire ? ' 🔥½' : ''}`);
    }
    this._note(`${cfg.icon} ${e.glyph} ${e.name} ${cfg.verb} (${cfg.dice}d${cfg.die || 6} ${cfg.dtype} → ${full}) — ${parts.join(', ')}! [Ref DC ${cfg.dc}]`, cfg.sound, { side: 'enemy' });
    this._echoToTable(cfg.sound); this._broadcast();
  }
  // A lich single-target nuke — optional save for partial (Disintegrate / Finger
  // of Death). A foe reduced past −10 by Disintegrate crumbles to dust.
  _enemyNuke(e, target, cfg) {
    const full = dRollN(cfg.dice, cfg.die || 6);
    let dmg = full, tag = '';
    const sm = this._partySaveMod(target), sroll = dRoll(20), stot = sroll + sm;
    const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= cfg.dc;
    if (saved) { dmg = (saved && target.evasion) ? 0 : dRollN(cfg.partialDice || 5, cfg.die || 6); tag = ` [${cfg.saveLbl || 'Fort'} ${stot} vs ${cfg.dc}: ${target.evasion ? 'evaded' : 'partial'}]`; }
    else tag = ` [${cfg.saveLbl || 'Fort'} ${stot} vs ${cfg.dc}: fail]`;
    this._dmgToMember(target, dmg);
    const dust = cfg.dust && target.hp <= -10;
    this._note(`${cfg.icon} ${e.glyph} ${e.name} ${cfg.verb} ${target.nickname} for ${dmg} ${cfg.dtype || ''}${tag}!${target.hp <= 0 ? (dust ? ` ☠️ ${target.nickname} crumbles to DUST!` : ' ☠️') : ` (${Math.max(0, target.hp)}/${target.maxHp})`}`, cfg.sound, { side: 'enemy' });
    this._echoToTable(cfg.sound); this._broadcast();
  }
  // Lich Hold Monster — a hero fails a Will save or is HELD (re-saves each turn,
  // the attempt costing the turn). Same mechanic as the shaman's Hold Person.
  _enemyHoldHero(e, target, dc, label) {
    const sm = this._partySaveMod(target), sroll = dRoll(20), stot = sroll + sm;
    const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= dc;
    const roll = `[Will d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs DC ${dc}]`;
    if (!saved) { target.paralyzed = Math.max(target.paralyzed || 0, 3); target.heldDC = dc; this._note(`🪄 ${e.glyph} ${e.name} casts ${label} on ${target.nickname} — HELD! ${roll} (re-save each turn to break free)`, '/audio/spell_dimensional_anchor.mp3', { side: 'enemy' }); }
    else this._note(`🪄 ${e.glyph} ${e.name} casts ${label} on ${target.nickname}, who resists. ${roll}`, null, { side: 'enemy' });
    this._broadcast();
  }
  // Lich Magic Missile — N unerring bolts (no save, no attack roll), 1d4+1 each.
  _enemyMissiles(e, target, n) {
    const dmg = dRollN(n, 4) + n;
    this._dmgToMember(target, dmg);
    this._note(`✨ ${e.glyph} ${e.name} looses ${n} Magic Missile${n > 1 ? 's' : ''} at ${target.nickname} — ${dmg} force, unerring.${target.hp <= 0 ? ' ☠️' : ` (${Math.max(0, target.hp)}/${target.maxHp})`}`, '/audio/spell_magicmissile.mp3', { side: 'enemy' });
    this._echoToTable('/audio/spell_magicmissile.mp3'); this._broadcast();
  }
  // Vampire's Vampiric Touch spellstrike (it fights as a magus of its level): a
  // draining blow — weapon damage (DR applies) plus negative energy (it doesn't),
  // and the vampire HEALS the energy it drains.
  _enemySpellstrike(e, target) {
    const cfg = e.spellstrike || {};
    const effAC = this._acOf(target).ac + this._acBonus(target) - (target.paralyzed > 0 ? 4 : 0) - this._acPenalty(target);
    const r = this._monsterSwing(e, effAC);
    const snd = cfg.sound || null;
    if (!r.hit) { this._note(`🩸 ${e.glyph} ${e.name}'s draining touch misses ${target.nickname}. ${this._atkStr(r)}`, snd, { side: 'enemy' }); this._echoToTable(snd); this._broadcast(); return; }
    const [phys, drTag] = this._physDR(target, r.damage);   // Stoneskin soaks the weapon part only
    const bonus = dRollN(cfg.dice || 4, cfg.die || 6);       // negative energy ignores DR
    const total = phys + bonus;
    this._dmgToMember(target, total);
    let lifeTag = '';
    if (cfg.lifesteal && e.hp > 0) { const healed = Math.min(bonus, e.maxHp - e.hp); if (healed > 0) { e.hp += healed; lifeTag = ` and drinks ${healed} life (${e.hp}/${e.maxHp})`; } }
    this._note(`🩸 ${e.glyph} ${e.name}'s VAMPIRIC TOUCH rips ${target.nickname} for ${phys}${drTag}+${bonus} = ${total}${lifeTag}! ${this._atkStr(r)} (${Math.max(0, target.hp)}/${target.maxHp} HP)`, snd, { side: 'enemy' });
    this._echoToTable(snd); this._broadcast();
  }
  // A living foe this member is compelled (taunted) to attack, or null.
  _forcedFoe(m) {
    if (!m || !m.tauntedBy) return null;
    return this.enemies.find(x => x.uid === m.tauntedBy && x.hp > 0) || null;
  }
  _allyAct(m) {
    const foes = this._targetableEnemies();   // can't target Darkness-shrouded foes
    if (!foes.length) return;
    // Taunted by a goblin barbarian → drop the clever play and just go hit it.
    if (m.tauntedBy && foes.some(e => e.uid === m.tauntedBy)) {
      const tgt = this._preferredFoe(m, foes);   // returns + consumes the taunter
      if (tgt) this._basicAttack(m, tgt.uid);
      this._hasteBonus(m);
      return;
    }
    // An INVISIBLE ally stays hidden: it takes a NON-offensive support action
    // (heal/buff) if it has one, else it holds — it will NOT attack (attacking
    // would break invisibility).
    if (m.invisible) {
      const c = this._botAbility(m);
      if (c) {
        const ab = kitFor(m.cls).abilities[c.slot];
        if (ab && ab.target !== 'enemy' && ab.target !== 'aoe' && ab.effect !== 'attack') {
          const r = this._useAbility(m, c.slot, c.payload);
          if (r && r.ok && ab) m._lastAbilityKey = ab.key;
          if (r && r.ok && !r.freeAction) { this._hasteBonus(m); return; }
        }
      }
      this._note(`👻 ${m.nickname} stays hidden, holding for the right moment.`);
      this._broadcast();
      return;
    }
    // Set the Power Attack / Deadly Aim stance for this turn FIRST (free toggle):
    // kept on for the damage, eased off against a target too well-armored to power
    // through. Done here so the swing that follows uses the right stance.
    this._botStance(m, foes);
    // Then see if a class ability is the smart play this turn (heal, buff,
    // blast, spell). If so, use it; otherwise fall back to a basic attack.
    const choice = this._botAbility(m);
    if (choice) {
      const ab = kitFor(m.cls).abilities[choice.slot];
      m._botMM = this._botPickMetamagic(m, ab);   // spontaneous bot may empower/maximize a damage spell when flush on high slots
      const r = this._useAbility(m, choice.slot, choice.payload);
      m._botMM = null;                            // one-shot — never leaks past the cast
      if (r && r.ok && ab) m._lastAbilityKey = ab.key;
      if (r && r.ok && !r.freeAction) { this._hasteBonus(m); return; }   // free action (judgement) → keep acting
      // Curator: after a quickened (swift) buff, immediately try ONE more support
      // action — a second buff — before falling through to a melee strike.
      if (r && r.ok && r.freeAction && this._wieldsCurator(m)) {
        const c2 = this._botAbility(m);
        if (c2) {
          const ab2 = kitFor(m.cls).abilities[c2.slot];
          const r2 = this._useAbility(m, c2.slot, c2.payload);
          if (r2 && r2.ok && ab2) m._lastAbilityKey = ab2.key;
          if (r2 && r2.ok && !r2.freeAction) { this._hasteBonus(m); return; }
        }
      }
    }
    // Basic attack — class-aware target pick (see _preferredFoe).
    const tgt = this._preferredFoe(m, foes);
    if (tgt) this._basicAttack(m, tgt.uid);
    this._hasteBonus(m);   // Haste: spend a pending extra attack after the action
  }
  // A bot's Power Attack / Deadly Aim STANCE for this turn. Default is ON (free
  // damage, kept on across rooms). It EASES OFF against a target whose AC it can't
  // reliably beat while powering — and powers back up once a hittable foe is up.
  // Decision = the d20 it would need to land WHILE powering: needs 16+ (≤25%) → drop
  // for accuracy; needs 14- (≥35%) → keep the damage; 15 is a hysteresis dead-band so
  // it doesn't flip-flop turn to turn. Pure casters take no stance (at-will isn't a
  // weapon), and the stance only flips when it actually changes (so no spam).
  _botStance(m, foes) {
    const kit = kitFor(m.cls);
    if (((kit.atwill || {}).effect) !== 'attack') return;     // pure caster — no weapon stance
    const ranged = this._isRanged(m);
    const idx = kit.abilities.findIndex(a => ranged ? a.deadlyaim : a.powerattack);
    if (idx < 0) return;
    const on = ranged ? !!(m.buffApplied && m.buffApplied.deadlyaim)
                      : !!(m.buffApplied && m.buffApplied.powerattack);
    const tgt = this._preferredFoe(m, foes);
    if (!tgt) return;
    const weapon = m.weapon || weaponOf(m.gear, m.weaponKey);
    const abilityMod = m.mods ? attackProfile({ mods: m.mods }, weapon).toHitMod : ABILITY_MOD;
    const bab = babFor(m.cls || 'fighter', m.level || 1);
    const ffHit = (fighterFeats(m.cls, m.level || 1, ranged).hit) || 0;   // Weapon Focus etc., as folded into the real swing
    const curHit = bab + abilityMod + (weapon.toHit || 0) + ffHit + ((m.buffs && m.buffs.toHit) || 0);
    const pen = ranged ? 2 : (m._paPen || (1 + Math.floor(bab / 4)));
    const hitWhilePowering = on ? curHit : curHit - pen;      // m.buffs.toHit already holds −pen when the stance is on
    const ac = (tgt.ac != null ? tgt.ac : 10);
    const neededOn = ac - hitWhilePowering;                   // d20 needed to land while powered
    let want = on;
    if (neededOn >= 16) want = false;                         // too tough to power through → accuracy
    else if (neededOn <= 14) want = true;                     // comfortably hits → take the damage
    if (want !== on) this._useAbility(m, idx, {});            // free toggle (announces the change)
  }
  // Which foe a bot should strike. ROGUES hunt the HELPLESS (flat-footed / prone
  // / sickened / paralyzed / ASLEEP) for Sneak Attack — they'll happily stab a
  // sleeper. BARBARIANS pick the lowest-HP foe to fish for a kill → Cleave chain.
  // Everyone else AVOIDS asleep/fascinated foes (a hit wakes them and wastes the
  // crowd-control), only hitting one if all living foes are out.
  // Does a creature's physical DR blunt THIS member's weapon? (true = its hits are
  // reduced — the bot should rather strike a foe it can hurt.) Mirrors _physDR's bypass
  // test: a matching S/P/B type, or a magic weapon vs DR/magic, gets through; DR/— and
  // a plain numeric DR (Stoneskin) block every weapon. Used only as a SOFT preference
  // — never to refuse combat (see _preferredFoe's fallback).
  _drBlocksWeapon(m, e) {
    const dr = e && e.dr;
    const amount = dr ? (typeof dr === 'object' ? dr.amount : dr) : 0;
    if (!(amount > 0)) return false;
    const w = m.weapon || weaponOf(m.gear, m.weaponKey);
    const bypass = (typeof dr === 'object') ? dr.bypass : null;
    if (bypass === 'magic') return !(w && (w.dmgBonus > 0 || w.custom));
    if (bypass && bypass !== '—') return !(w && w.dtype === bypass);
    return true;   // DR/— or numeric (Stoneskin) — nothing physical bypasses
  }
  _preferredFoe(m, foes) {
    if (!foes || !foes.length) return null;
    // Taunted → compelled to go straight for the taunter (cleared at turn's end).
    const forced = this._forcedFoe(m);
    if (forced) return forced;
    // Melee fighters can't reach flyers — prefer grounded foes (fall back to flyers
    // only if that's all that's left, so the wasted-swing message still fires).
    const _w = m.weapon || weaponOf(m.gear, m.weaponKey);
    if (_w && !_w.ranged && !_w.reachFly) { const grounded = foes.filter(e => !e.flying); if (grounded.length) foes = grounded; }
    // DR awareness: go for a foe this weapon can actually bite into. But if EVERY foe
    // is warded by DR we can't pierce (an enemy Stoneskin, a room full of skeletons for
    // a swordsman), DON'T give up — keep the whole list and swing anyway; a crit can
    // still punch through. (Casters keep bypassing physical DR with energy spells.)
    const hittable = foes.filter(e => !this._drBlocksWeapon(m, e));
    if (hittable.length) foes = hittable;
    if (m.cls === 'rogue') {
      const helpless = foes.filter(e => e.flatFooted || e.prone || e.sickened > 0 || e.paralyzed > 0 || e.fascinated);
      return (helpless.length ? helpless : foes).slice().sort((a, b) => a.hp - b.hp)[0];   // weakest sneakable foe
    }
    const awake = foes.filter(e => !e.fascinated);
    if (m.cls === 'barbarian') return (awake.length ? awake : foes).slice().sort((a, b) => a.hp - b.hp)[0];   // weakest first → drop it → Cleave carries on
    return (awake.length ? awake : foes)[0];
  }
  // Bot ability AI: pick a class ability for this turn, or null to basic-attack.
  // Priority: heal the hurt → raise buffs (smite/rage/shield/inspire/bane) →
  // blast/control a group → fire a spell or maneuver at the best target. Only
  // ever returns an ability that's actually usable right now (level + uses/pool).
  _botAbility(m) {
    const kit = kitFor(m.cls);
    if (!kit.abilities || !kit.abilities.length) return null;
    const lvl = m.level || 1;
    const foes = this._targetableEnemies();   // can't target Darkness-shrouded foes
    if (!foes.length) return null;
    // Rogue: if a foe is already HELPLESS (flat-footed at the open, prone, asleep,
    // held…) it's a free Sneak target — skip Feint and just stab it (basic attack).
    // Feint only when there's no opening to set one up.
    if (m.cls === 'rogue' && foes.some(e => e.flatFooted || e.prone || e.sickened > 0 || e.paralyzed > 0 || e.fascinated)) return null;
    const awake = foes.filter(e => !e.fascinated);
    const targets = awake.length ? awake : foes;          // don't wake sleepers
    const usable = (ab) => {
      if (!ab || lvl < (ab.minLevel || 1)) return false;
      if (!this._charAllows(ab, m)) return false;   // char-gated forms (Rissa vs generic druids)
      if (ab.effect === 'form' && m.form && m.form.key === (ab.form && ab.form.key)) return false;   // already in this form
      if (ab.cost === 'pool') return (m.spellPool || 0) > 0;
      if (ab.cost === 'slot') return ((m.slots && m.slots[ab.slvl]) || 0) > 0;   // spontaneous: a slot of that level
      if (ab.cost === 'room') return ((m.abilityUses && m.abilityUses[ab.key]) || 0) > 0;
      if (ab.cost === 'run')  return ((m.runAbilityUses && m.runAbilityUses[ab.key]) || 0) > 0;   // don't re-pick a spent run cast (e.g. auto-Inspire/Bless)
      return true;                                         // 'free'
    };
    const slot = (ab) => kit.abilities.indexOf(ab);
    const avail = kit.abilities.filter(usable);
    if (!avail.length) return null;
    const allies = this.livingParty();
    const someoneHurt = allies.some(a => a.hp < a.maxHp * 0.55);
    const weakestFoe = targets.slice().sort((a, b) => a.hp - b.hp)[0];
    const anyDowned = this.party.some(a => !a.dead && !a.left && a.downed);
    const anyDead = this.party.some(a => a.dead);

    // 0) Revive a fallen ally if we have the prayer for it (Raise Dead/Resurrection
    //    for the slain; Breath of Life for the dying).
    // In combat, only Breath of Life (NOT Raise Dead / Resurrection — those are cast
    // between rooms) revives, and it can now snatch back the DYING or the freshly DEAD.
    const revive = avail.find(a => a.effect === 'revive' && !a.raiseDead && (anyDowned || anyDead));
    if (revive) return { slot: slot(revive), payload: {} };
    // 0b) Inquisitor: declare a Judgement if none is up (free action, then attack).
    const judg = avail.find(a => a.effect === 'judgment');
    if (judg && !m.judgment) return { slot: slot(judg), payload: {} };
    // 0c) Inquisitor: declare BANE (free action) vs the most common foe type when we
    //     have a use and our current declaration isn't aimed at a type that's present.
    const baneAb = avail.find(a => a.effect === 'bane');
    if (baneAb) {
      const present = new Set(foes.map(e => e.type).filter(Boolean));
      if (present.size && (!m.bane || !present.has(m.bane.type))) {
        return { slot: slot(baneAb), payload: { baneType: this._autoBaneType() } };
      }
    }
    // 1) Healing. CHANNEL (party heal) is the better call when MULTIPLE allies are
    //    hurt or anyone's DOWNED (it revives the dying); a single big CURE is better
    //    when exactly ONE ally is badly hurt (more HP on one target). If nobody's
    //    hurt but UNDEAD are present, CHANNEL anyway — _abHeal sears them (PF1).
    const channelHeal = avail.find(a => a.effect === 'heal' && a.heal === 'party');
    const bigCure = avail.filter(a => a.effect === 'heal' && a.heal === 'single')
                         .sort((x, y) => (y.healDice || 0) - (x.healDice || 0))[0];   // largest castable cure (e.g. Cure Serious)
    const hurtCount = allies.filter(a => a.hp < a.maxHp * 0.6).length + (anyDowned ? 1 : 0);
    if (channelHeal && (anyDowned || hurtCount >= 2)) return { slot: slot(channelHeal), payload: {} };   // many hurt / dying → channel
    if (bigCure && hurtCount === 1) {
      const worst = allies.slice().sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0];
      if (worst && worst.hp < worst.maxHp * 0.5) return { slot: slot(bigCure), payload: {} };   // one badly hurt → big single cure
    }
    if ((channelHeal || bigCure) && someoneHurt) return { slot: slot(channelHeal || bigCure), payload: {} };
    // Nobody hurt, but undead on the field → channel to HARM them (PF1 cleric).
    if (channelHeal && !someoneHurt && targets.some(e => e.type === 'undead')) return { slot: slot(channelHeal), payload: {} };
    // 1b) Dispel Magic — cleanse a debuffed ally (paralysis / stun / sickness).
    const cleanse = avail.find(a => a.effect === 'cleanse');
    if (cleanse) {
      const allyDebuffed = allies.some(a => a.paralyzed > 0 || a.stunned > 0 || a.slowed > 0 || a.sickened > 0 || a.grappled);
      const foeBuffed = this._targetableEnemies().some(e => e.hasted > 0 || (e.buffs && ((e.buffs.toHit || 0) > 0 || (e.buffs.dmg || 0) > 0 || (e.buffs.ac || 0) > 0)));
      if (allyDebuffed || foeBuffed) return { slot: slot(cleanse), payload: {} };
    }
    // 1c) Druid WILD SHAPE — most druids fight shapeshifted. If not already in a
    //     form, shift into a combat shape: prefer a reach form when every foe is
    //     airborne, else the strongest melee form (Beast > Promethean > Bear > Tiger).
    //     Hawk is a defensive/flight form, so the AI doesn't auto-pick it for combat.
    if (m.cls === 'druid' && !m.form) {
      const forms = avail.filter(a => a.effect === 'form' && a.form && a.form.key !== 'hawk');
      if (forms.length) {
        const allAirborne = targets.length && targets.every(e => e.flying);
        let chosen = null;
        if (allAirborne) chosen = forms.find(a => a.form.weapon === 'form_promethean' || a.form.weapon === 'form_beast');
        if (!chosen) chosen = ['beast', 'promethean', 'bear', 'tiger'].map(k => forms.find(a => a.form.key === k)).find(Boolean) || forms[0];
        if (chosen) return { slot: slot(chosen), payload: {} };
      }
    }
    // 2) Put up buffs once — Smite, then sticky self/party buffs (rage, shield,
    //    bane, divine favor, inspire). Sticky guard stops re-casting.
    const smite = avail.find(a => a.effect === 'smite' && !m.smiteActive);
    if (smite) return { slot: slot(smite), payload: {} };
    // Paladin: Detect Evil reveals NON-evil foes (animals/constructs) so Smite
    // bites them — a standard action, worth it when not every foe is already evil.
    const detectEvil = avail.find(a => a.effect === 'detectevil');
    if (detectEvil && this.livingEnemies().some(e => !e.evil && !e.markedEvil)) return { slot: slot(detectEvil), payload: {} };
    // Mage Armor — a free, run-long +4 AC; put it up once if not already on.
    const mageArmor = avail.find(a => a.effect === 'magearmor');
    if (mageArmor && !m.mageArmor) return { slot: slot(mageArmor), payload: {} };
    // Don't waste a turn re-casting a NON-STACKING buff that's already up. A buff
    // is "fully up" when every recipient already has it: the whole party for a
    // party buff (Inspire/Prayer/Bless), or the caster for a self buff (Rage/
    // Shield). Single-ally buffs (Bull's/Cat's/Bear's) are gated by their once-
    // per-room use instead, so they fall through to the find naturally.
    const buffFullyUp = (a) => {
      const flag = a.persist ? 'runBuffApplied' : 'buffApplied';
      // party buff → everyone; single-ally buff → the one ally it would land on
      // (so it's "done" once that ally has it, instead of re-casting forever);
      // self buff → me.
      const recips = a.party ? this.livingParty()
                   : a.target === 'ally' ? [this._buffTarget(m, a)]
                   : [m];
      return recips.length > 0 && recips.every(w => w && w[flag] && w[flag][a.key]);
    };
    // Protection from Fire — only worth a slot when fiery foes are on the field.
    const fireFoes = foes.some(e => e.detonate || e.hellfire || /fire|flame|magma|salamander|phoenix/i.test(e.name));
    const protect = avail.find(a => a.protectFire);
    if (protect && fireFoes && this.livingParty().some(p => !p.protectFire)) return { slot: slot(protect), payload: {} };
    // Buff priority (PF1 support play): a multi-target PARTY buff is almost always the
    // best use of a turn, so take those FIRST — Stoneskin (Communal), Prayer, Protection
    // from Evil, Bless reach every ally at once. Then cheap SELF buffs (Divine Favor,
    // Shield, Displacement). SINGLE-ALLY buffs (Shield of Faith, Bull's Strength, single
    // Stoneskin) land on ONE ally per cast; spreading them down the line is fine early but
    // a poor use of a turn at mid-late levels — past L6 the bot stops babysitting each ally
    // and would rather drop a party buff or just attack. (Power Attack / Deadly Aim are
    // toggles handled by _botStance, never auto-picked here.)
    const stickyBuffs = avail.filter(a => a.effect === 'buff' && a.sticky && !a.protectFire
      && !a.powerattack && !a.deadlyaim && !buffFullyUp(a));
    const partyBuff = stickyBuffs.find(a => a.party);
    if (partyBuff) return { slot: slot(partyBuff), payload: {} };
    const selfBuff = stickyBuffs.find(a => a.target === 'self');
    if (selfBuff) return { slot: slot(selfBuff), payload: {} };
    const allyBuff = stickyBuffs.find(a => a.target === 'ally');
    if (allyBuff && (m.level || 1) < 7) return { slot: slot(allyBuff), payload: {} };
    // Invisibility — shields the most-hurt ally (it lands on the lowest-HP ally in
    // _abInvisible). Cast when an ally is badly hurt and nobody's hidden yet.
    const invis = avail.find(a => a.effect === 'invisible');
    if (invis && !this.livingParty().some(p => p.invisible)) {
      const hurt = allies.slice().sort((a, b) => a.hp - b.hp)[0];
      if (hurt && hurt.hp < hurt.maxHp * 0.5) return { slot: slot(invis), payload: {} };
    }
    // 2a) Taunt — a barbarian roars to pull a pack's fire onto themselves (once
    //     per room, only worth it against 2+ foes). With multiple barbarians,
    //     DON'T pile on if a team-mate's taunt already gripped most foes — but if
    //     MOST of the pack RESISTED, a second taunt (re-rolling their saves) is
    //     worth it. Heuristic: only taunt while fewer than half the foes are
    //     currently under a taunt-compulsion.
    const taunt = avail.find(a => a.effect === 'taunt');
    if (taunt && foes.length >= 2 && foes.filter(e => e.taunted).length * 2 < foes.length) {
      return { slot: slot(taunt), payload: {} };
    }
    // 2b) Haste — a powerful party buff (bards & wizards love it). Cast it once
    //     while there are foes to fight and the party isn't already hasted.
    const haste = avail.find(a => a.effect === 'haste');
    if (haste && !(m.hasted > 0)) return { slot: slot(haste), payload: {} };
    // 2b2) Bards LOCK DOWN a boss so it misses its turns. Hideous Laughter (Held)
    //      is ideal — unlike Fascinate it survives being hit, so the party can
    //      keep focus-firing while the boss wastes turns trying to re-save. Once
    //      the party buffs are up the bard pins the boss; it only re-casts if the
    //      boss shrugs free. A crowd with no boss falls through to group offense.
    if (m.cls === 'bard') {
      const heaviest = targets.slice().sort((a, b) => b.maxHp - a.maxHp);
      const boss = targets.find(e => e.boss) || (heaviest.length >= 2 && heaviest[0].maxHp >= 1.6 * heaviest[1].maxHp ? heaviest[0] : null);
      if (boss && !(boss.paralyzed > 0)) {
        const laugh = avail.find(a => a.effect === 'save_debuff');   // Hideous Laughter → Held
        if (laugh) return { slot: slot(laugh), payload: { targetUid: boss.uid } };
      }
    }
    // 2b3) Black Tentacles — drop a control field when 2+ foes and none is up yet.
    const tentacles = avail.find(a => a.effect === 'blacktentacles');
    if (tentacles && !this.blackTentacles && foes.length >= 2) return { slot: slot(tentacles), payload: {} };
    // 2b4) Suffocation — try to outright kill a dangerous non-undead foe (boss/elite,
    //      or a lone target). A made save still deals heavy damage, so it's never wasted.
    const suffocate = avail.find(a => a.effect === 'savedie');
    if (suffocate) {
      const prey = targets.filter(e => e.type !== 'undead' && e.type !== 'construct').slice().sort((a, b) => b.maxHp - a.maxHp)[0];
      if (prey && (prey.boss || targets.length <= 2)) return { slot: slot(suffocate), payload: { targetUid: prey.uid } };
    }
    // 2b5) Infernal Healing (Greater) — fast-heal a badly-hurt ally not already under it.
    const infheal = avail.find(a => a.effect === 'infernalheal');
    if (infheal) {
      const hurt = allies.filter(a => !a.infernalHeal).slice().sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0];
      if (hurt && hurt.hp < hurt.maxHp * 0.55) return { slot: slot(infheal), payload: { targetUid: hurt.playerId } };
    }
    // 2b6) Overland Flight — rise above grounded foes (defensive), once, if not flying.
    const overland = avail.find(a => a.effect === 'overlandflight');
    if (overland && !m.flying) return { slot: slot(overland), payload: {} };
    // 2c) Arcane controllers (wizard, sorcerer) play the battlefield: by default
    //     they pick the spell that AFFECTS THE MOST foes — a wide blast (Fireball,
    //     Lightning Bolt, Burning Hands) or a mass lockdown (Sleep, Grease). But
    //     when a lone outsized foe ("boss") looms, they spike it with their
    //     hardest single-target nuke (Disintegrate / Cone of Cold) or pin it with
    //     a save-or-suck debuff (Hold Person). NOTE: some 'aoe'-tagged spells only
    //     hit one target (maxTargets 1), so coverage = min(foes, maxTargets).
    if (m.cls === 'wizard' || m.cls === 'sorcerer' || m.cls === 'oracle') {
      const SPELLISH = ['aoe', 'disintegrate', 'grease', 'sleep', 'slow', 'fascinate', 'bolt', 'missile', 'touch', 'rays', 'save_debuff'];
      const weakFirst = targets.slice().sort((a, b) => a.hp - b.hp);
      const cand = [];
      for (const a of avail) {
        if (!SPELLISH.includes(a.effect)) continue;
        const cap = a.maxTargets || 1;
        const affects = Math.max(1, Math.min(targets.length, cap));
        const single = cap < 2;
        const isDebuff = a.effect === 'save_debuff' || ['grease', 'sleep', 'fascinate'].includes(a.effect);
        // Rough damage rank for boss focus: 'level'/'halflevel' dice scale with
        // caster level; a numeric dice count is taken as-is. Debuffs rank 0.
        const power = isDebuff ? 0 : (typeof a.dice === 'number' ? a.dice : lvl) * (a.die || 6);
        const payload = single ? { targetUid: weakFirst[0].uid } : { targetUids: weakFirst.slice(0, cap).map(e => e.uid) };
        cand.push({ ab: a, payload, affects, single, isDebuff, power });
      }
      if (cand.length) {
        const byHp = targets.slice().sort((a, b) => b.maxHp - a.maxHp);
        const boss = (byHp.length >= 2 && byHp[0].maxHp >= 1.6 * byHp[1].maxHp) ? byHp[0]
                   : (byHp.length === 1 ? byHp[0] : null);
        let chosen = null;
        if (boss) {
          // Hardest single-target nuke on the boss (Disintegrate first), else a
          // single-target debuff (Hold Person) to take it out of the fight.
          const nuke = cand.filter(c => c.single && !c.isDebuff)
                           .sort((x, y) => (y.power - x.power) || ((y.ab.minLevel || 1) - (x.ab.minLevel || 1)))[0];
          const dbf = cand.find(c => c.single && c.ab.effect === 'save_debuff');
          const c = nuke || dbf;
          if (c) chosen = { ab: c.ab, payload: { targetUid: boss.uid } };
        }
        if (!chosen) {
          // No boss → control the crowd: most-foes-affected wins, with a nudge
          // away from last turn's spell so they vary their blasts.
          const best = Math.max(...cand.map(c => c.affects));
          const top = cand.filter(c => c.affects === best);
          const c = top.find(o => o.ab.key !== m._lastAbilityKey) || top[0];
          chosen = { ab: c.ab, payload: c.payload };
        }
        return { slot: slot(chosen.ab), payload: chosen.payload };
      }
    }
    // 3+4) Offense — gather usable options in priority order (group blast →
    //      single-target spell → maneuver), then prefer one we did NOT use last
    //      turn. That variety stops a bot from spamming ONE ability — and its one
    //      sound (e.g. a cleric's Holy Smite) — every single turn; the cleric
    //      now alternates Holy Smite / Hold Person instead.
    const offense = [];
    if (targets.length >= 2) {
      for (const a of avail) if (['aoe', 'grease', 'sleep', 'slow', 'fascinate'].includes(a.effect)) {
        offense.push({ ab: a, payload: { targetUids: targets.slice(0, a.maxTargets || 3).map(e => e.uid) } });
      }
    }
    if (weakestFoe) {
      for (const a of avail) if (['bolt', 'missile', 'touch', 'rays', 'spellstrike', 'save_debuff'].includes(a.effect)) {
        offense.push({ ab: a, payload: { targetUid: weakestFoe.uid } });
      }
      // Spiritual Weapon — conjure it onto the TOUGHEST foe (sustained damage) and
      // never re-cast while one is already fighting; the cleric then does other things.
      if (!(m.spiritWeapon && m.spiritWeapon.rounds > 0)) {
        const sw = avail.find(a => a.effect === 'spiritweapon');
        if (sw) { const tough = targets.slice().sort((a, b) => b.maxHp - a.maxHp)[0] || weakestFoe; offense.push({ ab: sw, payload: { targetUid: tough.uid } }); }
      }
      const boltAction = !!weaponOf(m.gear, m.weaponKey).boltAction;   // can't Rapid Shot a bolt-action rifle
      for (const a of avail) if (['rapidshot', 'bullseye', 'cleave', 'trip', 'reckless', 'feint', 'disarm', 'stunfist'].includes(a.effect)) {
        if (a.needsRepeating && boltAction) continue;
        // Stunning Fist (monk, 1/room): a strike + Fort-or-stun. Spend it on the
        // BIGGEST threat that actually HAS a mind/body to stun (undead & constructs
        // are immune) — robbing a boss of a turn is its highest-value use.
        if (a.effect === 'stunfist') {
          const prey = targets.filter(t => !mindImmune(t)).sort((x, y) => y.maxHp - x.maxHp)[0];
          if (!prey) continue;                       // everything here is immune — save the strike
          offense.push({ ab: a, payload: { targetUid: prey.uid } });
          continue;
        }
        // Trip smarts (PF1): never try to trip the untrippable (oozes, flyers, Huge
        // things); pick a TRIPPABLE foe — preferring two-legged ones (quadrupeds and
        // many-legged foes get +4 stability per extra leg, so they're poor targets).
        if (a.effect === 'trip') {
          const trippable = targets.filter(t => !this._tripBlocked(t));
          if (!trippable.length) continue;                       // nobody worth sweeping — skip trip
          const best = trippable.slice().sort((x, y) => this._tripDefBonus(x) - this._tripDefBonus(y))[0];
          offense.push({ ab: a, payload: { targetUid: best.uid } });
          continue;
        }
        offense.push({ ab: a, payload: { targetUid: weakestFoe.uid } });
      }
    }
    if (offense.length) {
      const choice = offense.find(o => o.ab.key !== m._lastAbilityKey) || offense[0];
      return { slot: slot(choice.ab), payload: choice.payload };
    }
    return null;   // nothing fit → basic attack
  }
  // 0 to −9 HP: down and dying — can't act (the turn loop skips hp<=0), but a Cure
  // potion can still bring them back. Dead only once they pass −10.
  // Apply non-melee damage to a member (shouts, hazards) with the same down/dead
  // thresholds as a weapon hit.
  _dmgToMember(m, dmg) {
    m.hp -= dmg;
    if (m.hp <= -10) return this._memberDown(m);
    if (m.hp <= 0) return this._downMember(m);
  }
  // Mirror Image + Displacement (magus defenses): does an incoming attack on this
  // hero get soaked by a decoy or slip through their blurred form? Returns true
  // (and logs) when the attack is fully negated.
  _evadeIncoming(target, attacker) {
    if (target.images > 0) {
      target.images -= 1;
      this._note(`🪞 the blow strikes a mirror image of ${target.nickname} — it pops! (${target.images} left)`, null);
      return true;
    }
    if (target.displaced && dRoll(2) === 1) {
      this._note(`🌫️ ${target.nickname} is displaced — the attack passes through empty air!`, null);
      return true;
    }
    return false;
  }
  // Fire Shield — a foe that lands a MELEE hit on the warded hero is scorched.
  _fireShieldRetaliate(target, e) {
    if (!target.fireShield || !(e && e.hp > 0)) return;
    const fs = target.fireShield;
    const dealt = this._dmgE(e, dRollN(1, fs.die || 6) + (fs.bonus || 1), 'fire');
    this._note(`🔥 ${e.name} is scorched by ${target.nickname}'s Fire Shield for ${dealt} fire!${this._afterEnemyHit(e)}`, null, { side: 'enemy' });
  }
  // Stoneskin DR vs PHYSICAL blows (melee swings, claws, chains — NOT energy/spells).
  // Returns [reducedDamage, tag] where tag annotates how much the stone soaked.
  // PF1 DAMAGE REDUCTION. target.dr is either a NUMBER (DR X/— — nothing physical
  // bypasses; used by Stoneskin / wild-shape forms) OR { amount, bypass } where bypass
  // is what IGNORES the DR: a weapon type 'S'/'P'/'B' (slash/pierce/blunt), 'magic' (a
  // +N or signature weapon), or '—'/null (nothing bypasses). `weapon` is the attacker's
  // weapon — its .dtype is the physical type, .dmgBonus>0 or .custom marks it magic.
  // Elemental damage is NOT physical and never routes through here (it uses resist).
  // `pierce` — the attacker's Penetrating Strike (high fighter ladder): ignore that
  // many points of the foe's DR.
  _physDR(target, dmg, weapon, pierce = 0) {
    const raw = target.dr;
    if (!raw) return [dmg, ''];
    const amount = Math.max(0, ((typeof raw === 'object') ? (raw.amount || 0) : raw) - (pierce || 0));
    if (amount <= 0) return [dmg, ''];
    const bypass = (typeof raw === 'object') ? raw.bypass : null;   // bare number ⇒ DR/—
    let bypassed = false;
    if (bypass === 'magic') bypassed = !!(weapon && (weapon.dmgBonus > 0 || weapon.custom));
    else if (bypass && bypass !== '—') bypassed = !!(weapon && weapon.dtype === bypass);   // matching S/P/B
    if (bypassed) return [dmg, ''];
    const soaked = Math.min(dmg, amount);
    return [Math.max(0, dmg - amount), soaked > 0 ? ` 🛡️−${soaked} DR` : ''];
  }
  // A readable description of a creature's DR — for the once-per-fight reveal so the
  // party knows to switch weapons (and so Josh hears it in the log).
  _drDesc(dr) {
    if (!dr) return '';
    const amount = (typeof dr === 'object') ? dr.amount : dr;
    const bypass = (typeof dr === 'object') ? dr.bypass : null;
    const TYPE = { S: 'slashing', P: 'piercing', B: 'bludgeoning' };
    if (bypass === 'magic') return `DR ${amount}/magic — only an enchanted weapon (a +1 or a signature weapon) bites through`;
    if (TYPE[bypass]) {
      const weak = Object.keys(TYPE).filter(k => k !== bypass).map(k => TYPE[k]).join(' & ');
      return `DR ${amount}/${TYPE[bypass]} — ${weak} glance off; only ${TYPE[bypass]} cuts deep`;
    }
    return `DR ${amount}/— — almost nothing physical gets through; lean on spells and energy`;
  }
  _downMember(m) {
    if (m.dead) return;
    if (!m.downed) {
      m.downed = true;
      this._note(`🩸 ${m.nickname} collapses at ${m.hp} HP — DOWN and dying! (slain at −10; a Cure potion can still save them)`);
      this._log('downed', { who: m.playerId, hp: m.hp, depth: this.depth });
    } else {
      this._note(`🩸 ${m.nickname} is battered while down — ${m.hp} HP (slain at −10).`);
    }
    this._broadcast();
  }
  _memberDown(m) {   // −10 or worse, or a total-party wipe: SLAIN — but NOT yet kicked.
    if (m.dead) return;
    m.dead = true; m.downed = false;
    m._deathPending = true;   // the level-loss penalty is DEFERRED — a Breath of Life
                              // (in combat) or Resurrection (end of room) can undo it.
    this._note(`☠️ ${m.nickname} drops past −10 — SLAIN. They lie fallen, awaiting a Breath of Life or a rescue at the end of the room.`, '/audio/hero_death.mp3');
    this._echoToTable('/audio/hero_death.mp3');
    this._log('death', { who: m.playerId, hp: m.hp, depthReached: this.depth });
    // The fallen hero STAYS in the run as a corpse (their turn is skipped) so a cleric
    // or oracle can still revive them, and so the player can keep spectating. The death
    // penalty and the surfacing-back-to-the-table happen ONLY once death is locked in
    // (no revive) — see _applyDeathPenalty / _runOver / bail / _abRevive.
    this._broadcast();
  }
  // The death penalty: lose a level — back to the START of the previous level. Applied
  // ONLY when death is final: stayed dead to the run's end, left the run while dead, or
  // was brought back by Raise Dead (which does NOT restore the lost level). Breath of
  // Life and Resurrection clear the pending flag instead, so this never fires for them.
  // Guarded so it applies at most once per death.
  _applyDeathPenalty(m) {
    if (!m || !m._deathPending) return;
    m._deathPending = false;
    const lvl = m.level || 1;
    if (lvl > 1) {
      const newXp = xpFloorForLevel(lvl - 1);
      db.setXp(m.playerId, newXp);
      this._applyLevelFromXp(m, newXp);
      this._note(`📉 ${m.nickname} loses a level — dragged back to the start of level ${m.level}.`);
    }
  }
  // Total party incapacitation — everyone still in the run is down/dying, so they
  // all bleed out and the run ends.
  _wipe() {
    if (this.status === 'over') return;
    this._runFailed = true;   // total wipe in an uncleared room → gear loss (see _runOver)
    this._note('💀 The whole party is down — the dungeon claims them. The run ends.');
    for (const m of this.party.filter(x => !x.left && !x.dead)) this._memberDown(m);
    this._runOver();
  }

  // ── Human chat in the dungeon (from dungeon:say) ─────────────────────────
  // Mirrors the poker table chat: a 💬-prefixed line in the shared dungeon log,
  // visible to everyone in the run. Combatants only (you must be in the party).
  say(playerId, text) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!clean) return { ok: false, error: 'empty message' };
    this._note(`💬 ${m.nickname}: ${clean}`);
    this._broadcast();
    try { this._maybeVorkstagReskinOnChat(clean); } catch (_) {}
    // Let a bot party-mate clap back if the player named one of them.
    try { this._maybeChatBanter(m, clean); } catch (_) { /* flavor only */ }
    return { ok: true };
  }
  // A spectator up at the table heckling the delvers. Not a combatant — their
  // line is tagged "(watching)" but lands in the same shared log.
  spectatorSay(player, text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!clean) return { ok: false, error: 'empty message' };
    const nick = player.nickname || player.player_id;
    this._note(`💬 ${nick} (watching): ${clean}`);
    this._broadcast();
    try { this._maybeVorkstagReskinOnChat(clean); } catch (_) {}
    // A heckler can still draw a clap-back if they name a bot in the party.
    try { this._maybeChatBanter({ playerId: player.player_id, nickname: nick }, clean); } catch (_) {}
    return { ok: true };
  }
  // If the human's line names a bot currently in the party, that bot may answer
  // in character (dungeon voice). Best-effort and rate-limited by banter itself.
  _maybeChatBanter(speaker, text) {
    const lower = text.toLowerCase();
    const botMates = this.present().filter(x => x.isBot && x.hp > 0 && x.playerId !== speaker.playerId);
    if (!botMates.length) return;
    const named = botMates.find(b => {
      const nick = (b.trueNick || b.nickname || '').toLowerCase();
      const first = nick.split(/\s+/)[0];
      return nick && (lower.includes(nick) || (first.length >= 4 && lower.includes(first)));
    });
    if (!named) return;
    // Explicit mention → reply (near-)always, like the poker chat's name call-out.
    // Bypasses the combat once-per-round banter gate since the player addressed them.
    if (!banter.CHARACTER_FLAVOR[named.trueNick || named.nickname]) return;
    this._emitBanter(named, 'chat', { from: speaker.nickname, said: text });
  }
  // Vorkstag the skinwalker swaps which delver he's wearing — a fresh face + name
  // from another living party-mate (never himself, never his current disguise).
  _reskinVorkstag() {
    const vork = this.party.find(x => x.playerId === 'vorkstag' && !x.left && x.hp > 0);
    if (!vork) return false;
    vork.trueNick = vork.trueNick || vork.nickname;   // remember his real identity if not already
    const victims = this.party.filter(x => x.playerId !== 'vorkstag' && !x.left && x.hp > 0 && x.nickname !== vork.nickname);
    if (!victims.length) return false;
    const v = pick(victims);
    vork.nickname = v.nickname; vork.avatarId = v.avatarId;
    this._note(`🎭 Something is wrong with one of the delvers…`);
    this._broadcast();
    return true;
  }
  // Addressing Vorkstag's current (fake) name in dungeon chat unsettles him — 25%
  // of the time he sheds that face for another.
  _maybeVorkstagReskinOnChat(text) {
    const vork = this.present().find(x => x.playerId === 'vorkstag' && x.hp > 0);
    if (!vork) return;
    const nick = (vork.nickname || '').toLowerCase(), first = nick.split(/\s+/)[0], lower = String(text).toLowerCase();
    const addressed = nick && (lower.includes(nick) || (first.length >= 4 && lower.includes(first)));
    if (addressed && Math.random() < 0.25) { try { this._reskinVorkstag(); } catch (_) {} }
  }

  // ── Player actions (from dungeon:action) ─────────────────────────────────
  action(playerId, kind, payload = {}) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };

    // Bail, loot rolls, and loot management are allowed any time (not on-turn).
    if (kind === 'bail') return this.bail(playerId);
    if (kind === 'lootroll') return this._lootDecide(playerId, !!payload.roll);
    if (kind === 'equip') { const r = this.equipLoot(playerId, payload.idx); this._broadcast(); return r; }
    if (kind === 'hock')  { const r = this.hockLoot(playerId, payload.idx); this._broadcast(); return r; }
    if (kind === 'cantrip') return this.setCantrip(playerId, payload.key);   // pick at-will element (free, any time)
    if (kind === 'metamagic') return this.setMetamagic(playerId, payload.key);   // spontaneous caster toggles a metamagic on/off

    if (this.status === 'exploring') {
      if (kind === 'door') return this.openDoor();
      return { ok: false, error: 'invalid while exploring' };
    }
    if (this.status !== 'combat') return { ok: false, error: 'run is over' };
    if (this._currentActorId() !== playerId) return { ok: false, error: 'not your turn' };
    clearTimeout(this._turnTimer);
    this._log('action', { who: playerId, kind, hp: m.hp, enemiesAlive: this.livingEnemies().length });
    if (kind === 'attack') this._useAtwill(m, payload);
    else if (kind === 'ability') {
      // Taunted → a single-target offensive ability is dragged onto the taunter.
      const forced = this._forcedFoe(m);
      if (forced) {
        const ab = kitFor(m.cls).abilities[payload.slot | 0];
        if (ab && ab.target === 'enemy') payload.targetUid = forced.uid;
      }
      const r = this._useAbility(m, payload.slot | 0, payload);
      if (r && r.ok === false) { this._armAfkTimer(m); return r; }   // spent/invalid → don't burn the turn
      if (r && r.freeAction) { this._armAfkTimer(m); this._broadcast(); return { ok: true, freeAction: true }; }   // judgement switch — keep your turn
    }
    else { this._armAfkTimer(m); return { ok: false, error: 'unknown action' }; }
    this._hasteBonus(m);   // Haste: spend a pending extra attack after the action
    // NOTE: Abadar's interest no longer ticks per combat turn or per room — a
    // whole dungeon RUN counts as ONE tick (see _emitMemberExit), the same as
    // one poker hand.
    this._nextTurn();
    return { ok: true };
  }

  // ── Ability system ───────────────────────────────────────────────────────
  // At-will: a weapon swing (martials) or a cantrip (full casters), every turn.
  _useAtwill(m, payload) {
    if (!m.greaterInvis) m.invisible = false;   // attacking breaks Invisibility — but NOT Greater Invisibility
    return this._basicAttack(m, payload.targetUid);
  }
  // The basic attack for any combatant (human input, bot turn, or AFK auto-swing)
  // — a caster's cantrip ray, or a weapon swing. A barbarian's swing chain-cleaves
  // (drops a foe → carve into a random next one). Chosen foe is first; chains random.
  _basicAttack(m, targetUid) {
    const forced = this._forcedFoe(m);   // taunted → attack is dragged onto the taunter
    if (forced) targetUid = forced.uid;
    const at = kitFor(m.cls).atwill;
    if (at && at.effect === 'bolt') return this._abBolt(m, this._activeCantrip(m, targetUid, at), targetUid);
    // Barbarians, and fighters with Improved Cleave (level 9+), carve through —
    // every foe their swing FELLS grants another swing (chains on kills only).
    if (m.cls === 'barbarian' || fighterFeats(m.cls, m.level, this._isRanged(m)).impCleave) {
      const e = this.enemies.find(x => x.uid === targetUid && x.hp > 0) || this.livingEnemies()[0];
      if (e) return this._cleaveSweep(m, e, { followThrough: false });
      return;
    }
    return this._playerAttack(m, targetUid);
  }
  // One of the class's abilities (slot index). Gates on level + cost:
  //   'pool' → spend a shared spell slot; 'room' → spend its own use; 'free' → unlimited.
  _useAbility(m, slot, payload) {
    const kit = kitFor(m.cls);
    const ab = kit.abilities[slot];
    if (!ab) return { ok: false, error: 'no such ability' };
    if (!this._charAllows(ab, m)) return { ok: false, error: 'not your ability' };   // char-gated form (e.g. Rissa's Beast Mode)
    const lvl = m.level || 1;
    if (ab.minLevel && lvl < ab.minLevel) return { ok: false, error: `${ab.name} needs level ${ab.minLevel}` };
    // Raise Dead / Resurrection are powerful rituals — only between rooms (out of combat).
    if (ab.raiseDead && this.status === 'combat') return { ok: false, error: `${ab.name} can only be cast between rooms, not during combat.` };
    // Dropping a Wild Shape form you're already in is FREE (no use spent, always allowed).
    const formOff = ab.effect === 'form' && ab.form && m.form && m.form.key === ab.form.key;
    if (ab.cost === 'pool' && (m.spellPool || 0) <= 0) return { ok: false, error: 'out of spell casts this room' };
    if (ab.cost === 'slot' && ((m.slots && m.slots[ab.slvl]) || 0) <= 0) return { ok: false, error: `no level-${ab.slvl || '?'} spell slots left this room` };
    if (ab.cost === 'room' && !formOff && ((m.abilityUses && m.abilityUses[ab.key]) || 0) <= 0) return { ok: false, error: `${ab.name} is spent for this room` };
    if (ab.cost === 'run'  && ((m.runAbilityUses && m.runAbilityUses[ab.key]) || 0) <= 0) return { ok: false, error: `${ab.name} is already cast for this dungeon` };
    // Don't waste Sleep/Fascinate on a foe that's already asleep OR fascinated —
    // they share the same "out of the fight" state, so re-casting either one on
    // an already-entranced foe is wasted. Refuse the cast (the slot is kept) when
    // every chosen target is already down. Bots already pick un-CC'd foes; this
    // guards manual casts and the all-CC'd edge case.
    if (ab.effect === 'sleep' || ab.effect === 'fascinate') {
      const picked = this._enemyTargets(payload, ab.maxTargets || 3);
      if (picked.length && picked.every(e => e.fascinated)) return { ok: false, error: 'those foes are already asleep or fascinated' };
    }
    m.flatFooted = false;   // acting ends flat-footed
    const D = {
      trip:        () => this._abTrip(m, payload),
      disarm:      () => this._abDisarm(m, payload),
      spiritweapon: () => this._abSpiritWeapon(m, ab, payload),
      cleave:      () => this._abCleave(m, ab, payload),
      feint:       () => this._abFeint(m, payload),
      reckless:    () => this._abReckless(m, payload),
      buff:        () => this._abBuff(m, ab, payload),
      form:        () => this._abForm(m, ab),
      taunt:       () => this._abTaunt(m, ab),
      smite:       () => this._abSmite(m, ab),
      detectevil:  () => this._abDetectEvil(m, ab),
      heal:        () => this._abHeal(m, ab),
      revive:      () => this._abRevive(m, ab),
      haste:       () => this._abHaste(m, ab),
      invisible:   () => this._abInvisible(m, ab, payload),
      magearmor:   () => this._abMageArmor(m, ab),
      overlandflight: () => this._abOverlandFlight(m, ab),
      infernalheal: () => this._abInfernalHeal(m, ab, payload),
      blacktentacles: () => this._abBlackTentacles(m, ab),
      savedie:     () => this._abSaveDie(m, ab, payload),
      judgment:    () => this._abJudgment(m, ab),
      bane:        () => this._abBane(m, ab, payload),
      cleanse:     () => this._abCleanse(m, ab),
      aoe:         () => this._abAoe(m, ab, payload),
      disintegrate: () => this._abDisintegrate(m, ab, payload),
      bolt:        () => this._abBolt(m, ab, payload.targetUid),
      missile:     () => this._abMissile(m, ab, payload),
      touch:       () => this._abTouch(m, ab, payload),
      rays:        () => this._abRays(m, ab, payload),
      spellstrike: () => this._abSpellstrike(m, ab, payload),
      glitterdust: () => this._abGlitterdust(m, ab, payload),
      mirrorimage: () => this._abMirrorImage(m, ab),
      bladelash:   () => this._abBladeLash(m, ab, payload),
      bladeddash:  () => this._abBladedDash(m, ab, payload),
      dimensionalblade: () => this._abDimBlade(m, ab),
      save_debuff: () => this._abSaveDebuff(m, ab, payload),
      grease:      () => this._abGrease(m, ab, payload),
      fascinate:   () => this._abFascinate(m, ab, payload),
      sleep:       () => this._abSleep(m, ab, payload),
      slow:        () => this._abSlow(m, ab, payload),
      darkness:    () => this._abDarkness(m, ab),
      rapidshot:   () => this._abRapidShot(m, ab, payload),
      bullseye:    () => this._abBullseye(m, ab, payload),
      stunfist:    () => this._abStunningFist(m, ab, payload),
    }[ab.effect];
    if (!D) return { ok: false, error: 'unknown ability' };
    D();
    if (ab.cost === 'pool') m.spellPool = Math.max(0, (m.spellPool || 0) - 1);
    else if (ab.cost === 'slot') { m.slots = m.slots || {}; const _L = this._slotLevelFor(m, ab); m.slots[_L] = Math.max(0, (m.slots[_L] || 0) - 1); }   // metamagic draws from the HIGHER slot
    else if (ab.cost === 'room' && !formOff) m.abilityUses[ab.key] = Math.max(0, ((m.abilityUses && m.abilityUses[ab.key]) || 0) - 1);
    else if (ab.cost === 'run') m.runAbilityUses[ab.key] = Math.max(0, ((m.runAbilityUses && m.runAbilityUses[ab.key]) || 0) - 1);
    if ((ab.target === 'enemy' || ab.target === 'aoe') && !m.greaterInvis) m.invisible = false;   // attacking breaks Invisibility (Greater persists)
    // A blaster (Elfrip the flame oracle) sometimes whoops "BOOM!" when a big
    // fire spell lands. Throttled like all dungeon banter (≤1/round, a chance).
    if (m.isBot && (ab.key === 'fireball' || ab.key === 'firesnake')) {
      try { this._tryBanter(m, 'cast_fire', { spell: ab.name }); } catch (_) {}
    }
    // Curator (Gaspar's bastard sword): the FIRST buff SPELL each turn is quickened
    // to a SWIFT action — it's cast for free and the wielder keeps their turn for a
    // second buff or a strike. The second buff (or any other action) takes the turn
    // as normal. So a Curator-wielder can stack TWO buffs in a single turn.
    if (this._wieldsCurator(m) && this._isBuffSpell(ab) && !m._curatorBuffUsed) {
      m._curatorBuffUsed = true;
      this._note(`📖 ${m.nickname}'s Curator quickens the casting — a swift action! (cast again or strike this turn)`);
      return { ok: true, freeAction: true };
    }
    // Cleric QUICKEN CHANNEL (feat tree n8): the FIRST party-heal channel each room
    // is a SWIFT action — the cleric keeps their turn to strike or cast.
    if (ab.effect === 'heal' && ab.heal === 'party' && !m._qcUsed && fighterFeats(m.cls, m.level, this._isRanged(m)).quickChannel) {
      m._qcUsed = true;
      this._note(`✨ ${m.nickname} QUICKENS the channel — a swift action! (act again this turn)`);
      return { ok: true, freeAction: true };
    }
    // METAMAGIC QUICKEN: a quickened spell is a SWIFT action — the caster acts again
    // (cast a second spell, or strike). PF1: one swift action per turn, so it consumes
    // itself — the quicken toggle / bot one-shot clears after firing.
    if (ab.cost === 'slot' && this._mmForCast(m, ab).quicken) {
      if (m.metamagic) m.metamagic.quicken = false;
      if (m._botMM) m._botMM.quicken = false;
      this._note(`⚡ ${m.nickname} QUICKENS the casting — a swift action! (cast again or strike this turn)`);
      this._broadcast();
      return { ok: true, freeAction: true };
    }
    if (ab.effect === 'judgment' || ab.freeAction) return { ok: true, freeAction: true };   // judgement switch / barbarian Rage cost no action
    return { ok: true };
  }
  /** True if this member wields Gaspar's bastard sword "Curator". */
  _wieldsCurator(m) { return !!(m && m.weaponKey === 'curator'); }
  /** A real BUFF SPELL (not a free combat toggle like Power Attack / Rage / Deadly
   *  Aim, and not a 0-cost trick) — what Curator's swift-cast applies to. */
  _isBuffSpell(ab) {
    if (!ab || ab.freeAction || ab.cost === 'free') return false;
    return ab.effect === 'buff' || ab.effect === 'haste';
  }
  /** Per-character ability gating: `char` restricts an ability to one named hero
   *  (Rissa's Beast Mode / Promethean); `notChar` hides it from that hero (the
   *  generic Tiger/Bear forms she replaces). Matched by nickname or playerId. */
  _charAllows(ab, m) {
    if (!ab || (!ab.char && !ab.notChar)) return true;
    const who = (m.trueNick || m.nickname || '').toLowerCase();
    const pid = (m.playerId || '').toLowerCase();
    if (ab.char)    { const c = ab.char.toLowerCase();    if (who !== c && pid !== c) return false; }
    if (ab.notChar) { const c = ab.notChar.toLowerCase(); if (who === c || pid === c) return false; }
    return true;
  }
  /** Wild Shape: toggle a druid form on/off. Re-casting the active form reverts;
   *  casting a different form swaps. Forms override the weapon (natural attacks),
   *  add a stat package to m.buffs, and may grant flight / DR / temp HP. */
  _abForm(m, ab) {
    const f = ab.form; if (!f) return;
    const sound = f.sound || pick(SND.flesh);
    m.buffs = m.buffs || { toHit: 0, dmg: 0, bonusDice: 0, acPen: 0, save: 0, ac: 0 };
    if (m.form && m.form.key === f.key) {   // toggle OFF
      this._revertForm(m);
      this._note(`🔄 ${m.nickname} sheds ${f.label} and returns to their normal shape.`, sound);
      this._echoToTable(sound);
      return;
    }
    if (m.form) this._revertForm(m);        // switching forms — back the old one out first
    m._baseWeaponKey = m._baseWeaponKey || m.weaponKey;
    m.form = { key: f.key, label: f.label, glyph: f.glyph || '🐾', art: f.art || null, sizeSteps: f.sizeSteps || 0 };
    if (f.weapon) { m.weaponKey = f.weapon; m.weapon = weaponOf(m.gear, m.weaponKey); }
    const fb = { toHit: f.toHit || 0, dmg: f.dmg || 0, ac: f.ac || 0 };
    m.buffs.toHit += fb.toHit; m.buffs.dmg += fb.dmg; m.buffs.ac += fb.ac;
    m._formBuff = fb;
    if (f.dr)  { m._formDr = f.dr; m.dr = Math.max(m.dr || 0, f.dr); }
    if (f.fly) m.flying = true;
    const thp = (f.tempHpPerLevel || 0) * (m.level || 1) + (f.tempHp || 0);
    if (thp > 0) this._grantTempHp(m, thp);
    let atkStr = '';
    if (f.weapon) {
      const w = weaponOf(m.gear, m.weaponKey);
      const steps = (f.sizeSteps || 0) + (fighterFeats(m.cls, m.level, this._isRanged(m)).inw ? 1 : 0);
      const d = w.group === 'natural' && steps > 0 ? stepDamage(w.dmgCount, w.dmgDie, steps) : { count: w.dmgCount, die: w.dmgDie };
      atkStr = `${w.naturalAttacks} × ${d.count}d${d.die} attacks`;
    }
    const extra = [f.dr ? `DR ${f.dr}` : '', f.fly ? 'AIRBORNE' : '', atkStr].filter(Boolean).join(', ');
    this._note(`${ab.icon} ${m.nickname} shifts into ${f.label.toUpperCase()}!${extra ? ` (${extra})` : ''}`, sound);
    this._echoToTable(sound);
  }
  _revertForm(m) {
    if (!m.form) return;
    if (m._formBuff && m.buffs) { m.buffs.toHit -= m._formBuff.toHit; m.buffs.dmg -= m._formBuff.dmg; m.buffs.ac -= m._formBuff.ac; }
    m._formBuff = null;
    if (m._formDr) { m.dr = 0; m._formDr = 0; }   // form DR drops (re-cast Iron Skin if you want DR back)
    m.flying = false;                              // hawk-form flight ends
    m.weaponKey = m._baseWeaponKey || m.weaponKey; m._baseWeaponKey = null; m.weapon = null;
    m.form = null;
    // (any temp HP the form granted lingers until the room resets — same as Rage/Bear's Endurance)
  }
  // Per-room reset: refill the shared spell pool (full casters) + own-count
  // abilities, and clear sticky room buffs. Called each room and on join.
  _resetAbilities(m) {
    const kit = kitFor(m.cls);
    m.spellPool = isPoolClass(m.cls) ? spellSlots(m.level || 1) : 0;
    m.slots = slotsFor(m.cls, m.level || 1);   // per-spell-level slots (sorcerer/bard/oracle/cleric)
    m.abilityUses = {};
    for (const ab of kit.abilities) if (ab.cost === 'room') m.abilityUses[ab.key] = roomUses(ab, m.level || 1);
    // Hero's Defiance — a paladin's once-per-room clutch self-rescue (auto-fired
    // from the turn loop when downed). HOME-RULE: paladins (and antipaladins) get
    // their spellcasting from LEVEL 1, not 4 — still the slowest progression in the
    // game, just without the dead first three levels.
    m.heroDefiance = (m.cls === 'paladin' || m.cls === 'antipaladin') ? 1 : 0;
    if (m.tempHp) { m.maxHp -= m.tempHp; if (m.hp > m.maxHp) m.hp = m.maxHp; m.tempHp = 0; }   // rage / Bear's Endurance temp HP fades
    m.buffs = null;          // rage / divine favor / inspire clear
    m.bane = null;           // inquisitor Bane declaration clears between rooms
    m.buffApplied = {};      // which sticky buffs are already active (no stacking)
    m._qcUsed = false;       // cleric Quicken Channel — one swift channel per room
    m._offDef = false;       // rogue Offensive Defense AC wears off between rooms
    // Power Attack / Deadly Aim are STANCES, not per-room buffs — silently re-assert
    // whichever the hero left on (free, no re-announce). A bot may still ease it off
    // mid-fight against a high-AC foe via _botStance.
    if (m.paOn)  this._applyPowerAttack(m, true, { silent: true });
    if (m.aimOn) this._applyDeadlyAim(m, true, { silent: true });
    m.smiteActive = false;
    m.hasted = 0; m.hasteFull = false; m._justHasted = false; m.stunned = 0;   // transient round effects clear each room
    m._lastAtkTarget = null;   // full-attack (same-target iterative) chain resets each room
    m.paralyzed = 0; m.heldDC = null; m.slowed = 0; m._slowTick = 0;   // hold / slow wear off between rooms
    m.tauntedBy = null; m.grappled = false; m.grappledBy = null; m.protectFire = false; m.flying = false; m.dr = 0; m.spiritWeapon = null;   // taunt / grapple / fire ward / flight / stoneskin / spiritual weapon clear between rooms
    if (m.form) { m.weaponKey = m._baseWeaponKey || m.weaponKey; m._baseWeaponKey = null; m.form = null; m.weapon = null; }   // Wild Shape drops between rooms (re-cast next room)
    m.invisible = false; m.greaterInvis = false; m.judgment = null;   // invisibility (incl. Greater) ends; judgement re-declared per encounter
    m.infernalHeal = 0;   // Infernal Healing fast-healing ends between rooms
    // Magus per-room effects clear: mirror images, displacement, fire shield,
    // elemental body, true seeing, touch strikes, blur, blindness, melee-flight.
    m.images = 0; m.displaced = false; m.fireShield = null; m.elemBody = false; m.trueSeeing = false;
    m.touchStrike = 0; m.untargetable = false; m.blinded = 0; m.canHitFlyers = false;
    if (m.overlandFlight) { m.flying = true; m.canHitFlyers = true; }   // Overland Flight is RUN-long — re-assert flight + airborne reach
    m.acPenRound = -1; m.acPenAmt = 0;
  }
  // Inspire Courage is a passive bard AURA — it costs the bard NO action and is
  // simply ALWAYS up while a bard is in the party. Fold its run-long +1/+1 into
  // every ally that doesn't already have it (guarded per-ally so multiple bards
  // or repeated rooms never stack it). Announced + played once per run, when the
  // song first goes up. Called at every room start and on join.
  _maintainBardSongs() {
    const bard = this.present().find(m => m.cls === 'bard' && !m.dead);
    if (!bard) return;
    const ab = (kitFor('bard').abilities || []).find(a => a.key === 'inspire');
    if (!ab) return;
    let fresh = false;
    for (const a of this.present()) {
      if (a.dead) continue;
      a.runBuffApplied = a.runBuffApplied || {};
      if (a.runBuffApplied.inspire) continue;
      a.runBuffApplied.inspire = true;
      a.runBuffs = a.runBuffs || { toHit: 0, dmg: 0 };
      a.runBuffs.toHit += (ab.buff && ab.buff.toHit) || 0;
      a.runBuffs.dmg   += (ab.buff && ab.buff.dmg) || 0;
      fresh = true;
    }
    bard.runAbilityUses = bard.runAbilityUses || {};
    bard.runAbilityUses.inspire = 0;   // the song is up — no manual cast needed (won't be re-picked)
    if (fresh && !this._inspireAnnounced) {
      this._inspireAnnounced = true;
      this._note(`${ab.icon} ${bard.nickname} keeps ${ab.name} up — the whole party stays emboldened all delve!`, ab.sound);
    }
  }
  // The member's kit + remaining uses + level-availability, for the action UI.
  _kitState(m) {
    const kit = kitFor(m.cls);
    const lvl = m.level || 1;
    const boltAction = !!weaponOf(m.gear, m.weaponKey).boltAction;   // single-shot rifle → no Rapid Shot
    const maxSlots = slotsFor(m.cls, lvl);
    // Stance BUTTONS only show for the style that can use them: a MELEE wielder
    // sees Power Attack, a RANGED wielder sees Deadly Aim, and pure casters (whose
    // at-will is a cantrip, not a weapon swing) see NEITHER. The full kit keeps
    // both — the bot AI manages stances from it (_botStance) and a weapon swap
    // re-serializes the right button on the next broadcast.
    const _weaponFighter = (kit.atwill || {}).effect === 'attack';
    const _rangedNow = this._isRanged(m);
    const _showStance = (ab) => !(ab.powerattack || ab.deadlyaim)
      || (_weaponFighter && (ab.powerattack ? !_rangedNow : _rangedNow));
    // Metamagic — for SPONTANEOUS casters: the toggle buttons (one per feat owned)
    // and which are active. Slot spells re-level by the active toggles below.
    const ff = fighterFeats(m.cls, m.level, this._isRanged(m));
    const mmActive = this._spontMM(m) || {};
    const mmFeats = isSpontaneous(m.cls)
      ? [['intensify', 'Intensify', '+1'], ['empower', 'Empower', '+2'], ['maximize', 'Maximize', '+3'], ['quicken', 'Quicken', '+4']]
          .filter(([k]) => ff[k]).map(([key, name, adj]) => ({ key, name, adj, on: !!mmActive[key] }))
      : [];
    return {
      atwill: { key: kit.atwill.key, name: kit.atwill.name, icon: kit.atwill.icon, img: kit.atwill.img || null },
      caster: isCaster(m.cls),
      spellNote: kit.note || null,
      metamagic: mmFeats.length ? mmFeats : null,    // null → no buttons (prepared casters bake metamagic into spell entries)
      spellPool: isPoolClass(m.cls) ? { remaining: m.spellPool || 0, max: spellSlots(lvl) } : null,
      // Per-spell-level slots for spontaneous casters: { 1: {remaining,max}, … }.
      slots: maxSlots ? Object.fromEntries(Object.keys(maxSlots).map(L => [L, { remaining: (m.slots && m.slots[L]) || 0, max: maxSlots[L] }])) : null,
      abilities: kit.abilities.filter(ab => this._charAllows(ab, m) && _showStance(ab)).map(ab => {
        // Slot spells re-level by the active metamagic; the UI shows the effective
        // level, draws the right slot count, and greys out if there's no slot there
        // (or it pushes past 9th).
        const slvlEff = ab.cost === 'slot' ? this._slotLevelFor(m, ab) : ab.slvl;
        return {
        key: ab.key, name: ab.name, icon: ab.icon, img: ab.img || null, cost: ab.cost, target: ab.target, maxTargets: ab.maxTargets || 1,
        slot: kit.abilities.indexOf(ab),   // stable index into kit.abilities (the action payload `slot`) — survives the char filter
        active: ab.effect === 'form' ? !!(m.form && ab.form && m.form.key === ab.form.key) : undefined,   // form currently shifted-into
        minLevel: ab.minLevel || 1, slvl: ab.slvl || null, slvlEff: slvlEff || null,
        available: lvl >= (ab.minLevel || 1) && !(ab.needsRepeating && boltAction) && !(ab.cost === 'slot' && (slvlEff > 9 || !(maxSlots && maxSlots[slvlEff]))), desc: ab.desc || '',
        remaining: ab.cost === 'pool' ? (m.spellPool || 0) : ab.cost === 'slot' ? ((m.slots && m.slots[slvlEff]) || 0) : ab.cost === 'room' ? ((m.abilityUses && m.abilityUses[ab.key]) || 0) : ab.cost === 'run' ? ((m.runAbilityUses && m.runAbilityUses[ab.key]) || 0) : null,
        max: ab.cost === 'pool' ? spellSlots(lvl) : ab.cost === 'slot' ? ((maxSlots && maxSlots[slvlEff]) || 0) : ab.cost === 'room' ? roomUses(ab, lvl) : ab.cost === 'run' ? (typeof ab.uses === 'function' ? ab.uses(lvl) : (ab.uses || 1)) : null,
        };
      }),
    };
  }
  // Spell save DC + caster level for this member (level = 1 + gear).
  _spellDC(m) { return 10 + (m.level || 1) + (m.castingMod != null ? m.castingMod : CAST_MOD) + (fighterFeats(m.cls, m.level, this._isRanged(m)).spellDC || 0); }   // 10 + level + casting-stat mod + Spell Focus
  // Ranged-touch SPELL attack bonus. HOUSE RULE: casters aim their leveled touch
  // spells (Disintegrate, Scorching Ray, Shocking Grasp, elemental bolts) with their
  // SPELL stat, not Dex — so a wizard's ray lands as reliably as he casts. BAB +
  // casting-stat mod (NOT the legacy Dex-ish ABILITY_MOD). Cantrips already do this
  // (see _abCantrip); the magus's weapon-delivered Spellstrike keeps its weapon stat.
  _spellToHit(m) { return babFor(m.cls || 'fighter', m.level || 1) + (m.castingMod != null ? m.castingMod : CAST_MOD); }
  // ── METAMAGIC (PF1) ─────────────────────────────────────────────────────────
  // Two paths, mirroring the two spell systems:
  //   • SPONTANEOUS casters (sorcerer/bard/oracle/inquisitor) carry live TOGGLES in
  //     m.metamagic (set via the 'metamagic' action / UI). Toggling is gated on the
  //     caster owning the feat. A metamagic'd spontaneous spell is drawn from a slot
  //     +1/+2/+3/+4 HIGHER (Intensify/Empower/Maximize/Quicken) — see _slotLevelFor.
  //   • PREPARED casters (wizard/druid/magus) bake the flag onto a fixed spell entry
  //     (ab.empowered etc., like the magus); the higher slot cost is baked into the
  //     entry's minLevel, so prepared casts pay no runtime slot bump.
  //   • A bot may set a ONE-SHOT m._botMM for the cast it's about to make.
  // Stacking is allowed (PF1 RAW) — adjustments sum.
  _spontMM(m) {
    const t = (isSpontaneous(m.cls) && m.metamagic) ? m.metamagic : null;
    const b = m._botMM || null;
    if (!t && !b) return null;
    return { intensify: !!((t && t.intensify) || (b && b.intensify)), empower: !!((t && t.empower) || (b && b.empower)),
             maximize: !!((t && t.maximize) || (b && b.maximize)), quicken: !!((t && t.quicken) || (b && b.quicken)) };
  }
  // The metamagic that actually APPLIES to this cast = the spell's baked flags
  // (prepared) ∪ the spontaneous toggles / bot one-shot — but Empower/Maximize/
  // Intensify only do anything to a DICE (damage) spell, while Quicken applies to
  // any spell. So toggling Empower and then casting Haste wastes nothing (no boost,
  // no slot bump); Quicken + Haste still costs +4 and frees the action.
  _mmForCast(m, ab) {
    const s = this._spontMM(m) || {};
    const wantI = !!((ab && ab.intensified) || s.intensify), wantE = !!((ab && ab.empowered) || s.empower);
    const wantM = !!((ab && ab.maximized) || s.maximize), wantQ = !!((ab && ab.quickened) || s.quicken);
    const dice = !!(ab && ab.dice);
    return { intensify: wantI && dice && !!(ab && ab.dcap), empower: wantE && dice, maximize: wantM && dice, quicken: wantQ };
  }
  _mmAdjust(mm) { return mm ? ((mm.intensify ? 1 : 0) + (mm.empower ? 2 : 0) + (mm.maximize ? 3 : 0) + (mm.quicken ? 4 : 0)) : 0; }
  // Effective slot level for a SPONTANEOUS 'slot' cast = base spell level + the
  // adjustment for the toggles that actually APPLY to this spell (so a non-damage
  // spell isn't bumped by Empower). Prepared (room) casts never slot-bump.
  _slotLevelFor(m, ab) {
    if (ab.cost !== 'slot') return ab.slvl || 0;
    const s = this._spontMM(m); if (!s) return ab.slvl || 0;
    const dice = !!(ab && ab.dice);
    const adj = (s.intensify && dice && ab.dcap ? 1 : 0) + (s.empower && dice ? 2 : 0) + (s.maximize && dice ? 3 : 0) + (s.quicken ? 4 : 0);
    return (ab.slvl || 0) + adj;
  }
  // A spontaneous BOT may upgrade a damage spell with Empower/Maximize when it has the
  // feat AND a SURPLUS higher slot to spend (never cannibalises its single top slot).
  // Bots skip Quicken (action economy) and Intensify (marginal). Returns a one-shot
  // metamagic set for the cast, or null. Announces its choice.
  _botPickMetamagic(m, ab) {
    if (!ab || ab.cost !== 'slot' || !isSpontaneous(m.cls)) return null;
    if (!['bolt', 'aoe', 'touch', 'rays', 'disintegrate'].includes(ab.effect) || !ab.dice) return null;
    const ff = fighterFeats(m.cls, m.level, this._isRanged(m));
    const slots = m.slots || {}, base = ab.slvl || 1;
    const surplus = (adj) => { const L = base + adj; return L <= 9 && (slots[L] || 0) > 0 && ((slots[L] || 0) >= 2 || Object.keys(slots).some(k => +k > L && slots[k] > 0)); };
    let mm = null, word = '';
    if (ff.maximize && surplus(3))     { mm = { maximize: true }; word = 'MAXIMIZED'; }
    else if (ff.empower && surplus(2)) { mm = { empower: true };  word = 'EMPOWERED'; }
    if (mm) this._note(`✨ ${m.nickname} channels a ${word} ${ab.name}!`);
    return mm;
  }
  // Spell damage dice — INTENSIFIED SPELL raises a level-scaled spell's dice cap by +5
  // (PF1), so Shocking Grasp keeps growing past 5d6 and Fireball past 10d6.
  _spellDice(ab, m) {
    const mm = this._mmForCast(m, ab);
    const eab = (mm.intensify && ab.dcap && ab.dice) ? { ...ab, dcap: ab.dcap + 5 } : ab;
    return diceCount(eab, m.level || 1);
  }
  // Roll a spell's damage dice with METAMAGIC applied. PF1 RAW stacking: MAXIMIZE sets
  // every die to max; EMPOWER adds +50% — and the two STACK (max the dice, then add
  // half of a fresh roll). Metamagic only reaches here if it's a baked spell flag or
  // an active spontaneous toggle (both gated on the caster's feat).
  _rollSpell(m, dice, die, ab) {
    const mm = this._mmForCast(m, ab);
    let dmg = mm.maximize ? dice * die : dRollN(dice, die);
    if (mm.empower) dmg += Math.floor((mm.maximize ? dRollN(dice, die) : dmg) * 0.5);
    return dmg;
  }
  _enemyTargets(payload, max) {
    let chosen = ((payload && payload.targetUids) || []).map(u => this.enemies.find(e => e.uid === u && e.hp > 0 && !(e.darkened > 0))).filter(Boolean);
    if (!chosen.length) chosen = this._targetableEnemies();   // Darkness-shrouded foes can't be hit
    return max ? chosen.slice(0, max) : chosen;
  }
  _oneEnemy(payload) {
    const t = this.enemies.find(x => x.uid === (payload && payload.targetUid) && x.hp > 0 && !(x.darkened > 0));
    return t || this._targetableEnemies()[0] || null;
  }
  _saveVs(bonus, dc) { const r = dRoll(20); return { roll: r, total: r + bonus, saved: r === 20 ? true : r === 1 ? false : (r + bonus) >= dc }; }
  _afterEnemyHit(e) { if (e.hp <= 0) return ' ☠️'; return ` (${Math.max(0, e.hp)}/${e.maxHp})`; }
  // Effective melee AC of an enemy: sickened = +2 to be hit, prone = +4 to be hit.
  // A flying creature holds the HIGH GROUND over the grounded party: +2 AC (hard
  // to reach a flyer from the floor). All heroes are grounded, so it always applies.
  // Effective AC for an attack. opts.touch → TOUCH AC (spells & firearms ignore
  // armor / natural armor). A FLAT-FOOTED enemy (hasn't acted yet) loses its Dex
  // (≈ −2). Situational mods (prone/sickened/slowed/flying) apply to every type.
  _enemyAC(e, opts = {}) {
    let base = opts.touch ? (e.touchAC != null ? e.touchAC : Math.max(10, e.ac - 5)) : e.ac;
    if (e.flatFooted) base = Math.max(10, base - 2);   // flat-footed: denied Dex
    return base - (e.sickened > 0 ? 2 : 0) - (e.prone ? 4 : 0) - (e.slowed > 0 ? 1 : 0) - (e.blinded > 0 ? 2 : 0) + (e.flying ? HIGH_GROUND_AC : 0);
  }
  // Energy-resistance multiplier for a damage type (see RESIST_BY_KEY): 0 immune,
  // 0.5 resistant, 1.5 vulnerable, 1 (default) unchanged. Physical/untyped (no
  // dtype) is never modified.
  _resistMult(e, dtype) {
    if (!dtype || !e) return 1;
    if (e.resist && e.resist[dtype] != null) return e.resist[dtype];   // explicit entry wins (e.g. the fire-subtype Fire Skeleton is cold-VULNERABLE)
    // Standard PF1 undead immunities (user rule — vampires and ALL undead): cold
    // and poison simply bounce off, type-driven so every undead — including the
    // whole vampire court — is covered without per-monster bookkeeping.
    // Constructs share the poison immunity (no biology to poison).
    if (e.type === 'undead' && (dtype === 'cold' || dtype === 'poison')) return 0;
    if (e.type === 'construct' && dtype === 'poison') return 0;
    return 1;
  }
  // The damage actually dealt after resistance (vulnerable rounds up, resisted
  // keeps at least 1 unless fully immune).
  _resisted(e, dmg, dtype) {
    const mult = this._resistMult(e, dtype);
    if (mult === 1) return dmg;
    if (mult === 0) return 0;
    return Math.max(1, Math.round(dmg * mult));
  }
  // A short tag for the log when resistance changed the number.
  _resistTag(e, dtype) {
    const mult = this._resistMult(e, dtype);
    if (mult === 0) return ' ⛔immune';
    if (mult > 1) return ` 🔥×${mult}!`;
    if (mult < 1) return ' (resisted)';
    return '';
  }
  // Apply (resisted) damage of `dtype` to an enemy; any hit snaps a Fascinate.
  // Returns the damage actually dealt.
  _dmgE(e, dmg, dtype) {
    const dealt = this._resisted(e, dmg, dtype);
    e.hp -= dealt; if (e.fascinated) { e.fascinated = false; e.asleep = false; }   // a hit snaps Sleep/Fascinate
    // NOTE: a Fire Skeleton does NOT explode when slain — kill it first and it's
    // DEFUSED. It only blows up if it survives to its own turn (see _detonate).
    return dealt;
  }
  // Fire Skeleton suicide bomber: on its turn it rushes in and DETONATES — one
  // fire roll (1d6 per party level) lands on 1d2 random heroes (no save, point-
  // blank), and the skeleton is consumed in the blast.
  _detonate(e) {
    const ex = e.detonate || {};
    const lvl = Math.max(1, this._minLevel());
    const d = dRollN(lvl, ex.die || 6);   // ONE roll: 1d6 per level, shared by everyone caught in it
    const live = this._targetableParty().slice();
    for (let i = live.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [live[i], live[j]] = [live[j], live[i]]; }
    const hit = live.slice(0, dRoll(ex.count || 2));   // 1d2 heroes caught in the blast
    const parts = [];
    for (const t of hit) { const dd = t.protectFire ? Math.max(1, Math.floor(d / 2)) : d; this._dmgToMember(t, dd); parts.push(`${t.nickname} −${dd}${t.protectFire ? ' 🔥½' : ''}`); }
    e._exploded = true; e.hp = 0;   // it consumes itself
    this._note(`💥 ${e.name} hurls itself among the heroes and DETONATES (${lvl}d6 fire = ${d})${parts.length ? ' — ' + parts.join(', ') : ' — but catches no one'}! It is destroyed.`, ex.sound, { side: 'enemy' });
    this._echoToTable(ex.sound);
  }
  // Enemy save bonus. Monsters carry Fort + Reflex; Will is approximated.
  _enemySave(e, which) {
    const pray = e.prayed || 0;   // Prayer: −1 to all the enemy's saves
    if (which === 'fort') return (e.fort || 0) - pray;
    if (which === 'reflex') return (e.reflex || 0) - pray;
    return Math.floor(((e.fort || 0) + (e.reflex || 0)) / 2) - pray;   // will (approx)
  }
  // A bare attack roll (to-hit only, no damage) using the member's weapon.
  // `extraDef` raises the foe's effective defense for this one roll (e.g. the PF1
  // trip-stability bonus for extra legs / larger size).
  _attackRoll(m, e, extraDef = 0) {
    const w = m.weapon || weaponOf(m.gear, m.weaponKey);
    const lvl = m.level || 1, cls = m.cls || 'fighter';
    const notProf = (m.isBot || weaponProficient(cls, w)) ? 0 : NON_PROFICIENT_PENALTY;
    const toHit = babFor(cls, lvl) + ABILITY_MOD + (w.toHit || 0) + ((m.buffs && m.buffs.toHit) || 0) + this._hasteMod(m) + notProf - (m.sickened > 0 ? SICKENED_PENALTY : 0);
    const roll = dRoll(20), total = roll + toHit;
    return { hit: roll === 20 || (roll !== 1 && total >= this._enemyAC(e) + (extraDef || 0)), roll, total, toHit, weapon: w };
  }

  // ── Effects ──────────────────────────────────────────────────────────────
  // Ranged touch cantrip / single small bolt (Ray of Frost).
  // Public cantrip state for a caster (null for non-ray classes): the chosen
  // element + the choices, for the dungeon UI selector + blind announcement.
  _cantripState(m) {
    const at = kitFor(m.cls).atwill;
    if (!at || at.effect !== 'bolt') return null;
    const choices = this._cantripChoices(m, at);
    const current = choices.some(c => c.key === m.cantrip) ? m.cantrip : at.key;
    return { current, choices: choices.map(c => ({ key: c.key, name: c.name, icon: c.icon, dtype: c.dtype })) };
  }
  // The cantrips a caster may choose among: the universal three (cold/acid/elec)
  // + their class's own at-will if it's a different element (the flame oracle
  // keeps Produce Flame as a 4th).
  _cantripChoices(m, at) {
    at = at || (kitFor(m.cls).atwill);
    const base = CANTRIPS.slice();
    if (at && at.effect === 'bolt' && !base.some(c => c.key === at.key)) base.push(CANTRIP_BY_KEY[at.key] || at);
    return base;
  }
  // Which cantrip fires this swing. Humans use their chosen m.cantrip; bots
  // auto-pick the element the target is LEAST resistant to (prefers vulnerable,
  // never wastes it on an immune foe).
  _activeCantrip(m, targetUid, at) {
    at = at || kitFor(m.cls).atwill;
    const choices = this._cantripChoices(m, at);
    if (m.isBot) {
      const e = this.enemies.find(x => x.uid === targetUid && x.hp > 0) || this.livingEnemies()[0];
      if (e) {
        let best = choices[0], bestMult = -1;
        for (const c of choices) { const mult = this._resistMult(e, c.dtype); if (mult > bestMult) { bestMult = mult; best = c; } }
        return best;
      }
    }
    return CANTRIP_BY_KEY[m.cantrip] || at || choices[0];
  }
  // Set a human caster's chosen at-will cantrip (the dungeon action 'cantrip').
  setCantrip(playerId, key) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };
    const choices = this._cantripChoices(m);
    const pick2 = choices.find(c => c.key === key);
    if (!pick2) return { ok: false, error: 'not a cantrip you can cast' };
    m.cantrip = key;
    this._broadcast();
    return { ok: true, cantrip: key };
  }
  // Toggle a metamagic on/off for a SPONTANEOUS caster (stacking allowed). Only a
  // metamagic the caster has the FEAT for can be toggled. Active metamagic re-levels
  // the next damaging spell to a higher slot (see _slotLevelFor) and boosts it.
  setMetamagic(playerId, key) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };
    if (!isSpontaneous(m.cls)) return { ok: false, error: 'prepared casters bake metamagic into prepared spells, not on the fly' };
    const ff = fighterFeats(m.cls, m.level, this._isRanged(m));
    if (!ff[key] || !['intensify', 'empower', 'maximize', 'quicken'].includes(key)) return { ok: false, error: 'you don\'t have that metamagic feat' };
    m.metamagic = m.metamagic || { intensify: false, empower: false, maximize: false, quicken: false };
    m.metamagic[key] = !m.metamagic[key];
    this._broadcast();
    return { ok: true, metamagic: m.metamagic };
  }
  // Improved at-will: casting stat to-hit AND to-damage (1d6 + casting mod), with
  // BAB-based iteratives (2nd ray at BAB 6, 3rd at 11, 4th at 16). Each ray is a
  // separate ranged touch; if the target drops, later rays carry to the next foe.
  _abCantrip(m, ab, e0) {
    const cm = m.castingMod || 0;
    const offs = (m.iteratives && m.iteratives.length) ? m.iteratives : [0];
    const sound = ab.sound || pick(SND.lightning);
    let target = e0, played = false;
    for (const off of offs) {
      if (!target || target.hp <= 0) target = this.livingEnemies()[0];
      if (!target) break;
      const touchAC = this._enemyAC(target, { touch: true });
      const base = babFor(m.cls || 'fighter', m.level || 1) + cm + off;
      const roll = dRoll(20), total = roll + base;
      const snd = played ? null : sound; played = true;
      if (roll !== 20 && (roll === 1 || total < touchAC)) {
        this._note(`${ab.icon} ${m.nickname}'s ${ab.name} misses ${target.name}. [d20 ${roll} ${this._fmtBonus(base)} = ${total} vs touch ${touchAC}]`, snd);
        continue;
      }
      const raw = Math.max(1, dRollN(ab.dice || 1, ab.die || 6) + cm);
      const dmg = this._dmgE(target, raw, ab.dtype);
      this._note(`${ab.icon} ${m.nickname}'s ${ab.name} hits ${target.name} for ${dmg} ${ab.dtype || ''}${this._resistTag(target, ab.dtype)}.${this._afterEnemyHit(target)}`, snd);
      if (target.hp <= 0) this._tryBanter(m, 'down', { enemy: target.name });
    }
    this._echoToTable(sound);
  }
  _abBolt(m, ab, targetUid) {
    m.flatFooted = false;
    const e = this.enemies.find(x => x.uid === targetUid && x.hp > 0) || this.livingEnemies()[0];
    if (!e) return;
    if (ab.cantrip) return this._abCantrip(m, ab, e);   // improved model + iteratives
    const touchAC = this._enemyAC(e, { touch: true });   // ranged touch — ignores armor & natural armor
    const toHit = this._spellToHit(m);   // BAB + casting-stat mod (house rule: spell stat, not Dex)
    const roll = dRoll(20), total = roll + toHit;
    const sound = ab.sound || pick(SND.lightning);
    if (roll !== 20 && (roll === 1 || total < touchAC)) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} misses ${e.name}. [d20 ${roll} ${this._fmtBonus(toHit)} = ${total} vs touch ${touchAC}]`, sound); this._echoToTable(sound); return; }
    const raw = Math.max(1, this._rollSpell(m, this._spellDice(ab, m), ab.die || 3, ab) + (ab.flat || 0));
    const dmg = this._dmgE(e, raw, ab.dtype);
    this._note(`${ab.icon} ${m.nickname}'s ${ab.name} hits ${e.name} for ${dmg} ${ab.dtype || ''}${this._resistTag(e, ab.dtype)}.${this._afterEnemyHit(e)}`, sound);
    if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  }
  // Area damage with a save for half — Burning Hands / Holy Smite / Lightning
  // Bolt / Fireball. Hits up to ab.maxTargets foes (chosen or auto).
  _abAoe(m, ab, payload) {
    const dc = this._spellDC(m), dice = this._spellDice(ab, m);
    let chosen;
    if (ab.randFoes || ab.randBase || ab.randN) {
      // Fireball-style: a RANDOM 1dN of the living enemies. Cone of Cold uses
      // randBase+randDie → 2+1d3 foes; Cloudkill uses randN d randDie → 3d4 foes.
      const living = this._targetableEnemies().slice();
      for (let i = living.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [living[i], living[j]] = [living[j], living[i]]; }
      let n;
      if (ab.randN) { n = 0; for (let i = 0; i < ab.randN; i++) n += dRoll(ab.randDie || 4); }
      else if (ab.randBase) n = (ab.randBase || 0) + dRoll(ab.randDie || 1);
      else n = dRoll(ab.randFoes);
      chosen = living.slice(0, n);
    } else {
      chosen = this._enemyTargets(payload, ab.maxTargets || 2);
    }
    const sound = (ab.sounds ? pick(ab.sounds) : ab.sound) || pick(SND.lightning), parts = [];   // Fireball/Lightning alternate from a pool
    const saveStat = ab.save || 'reflex';
    const saveLbl = saveStat === 'fort' ? 'Fort' : saveStat === 'will' ? 'Will' : 'Ref';
    // PF1e: the burst rolls its damage ONCE; every target saves against that same
    // number. Fail = full, save = half — or NONE if they have Evasion (a Reflex-
    // save area effect only). Resistance/vulnerability still applies per target.
    // Metamagic (Empower ×1.5 / Maximize) applies to the one shared roll.
    const full = this._rollSpell(m, dice, ab.die || 6, ab);
    for (const e of chosen) {
      const sv = this._saveVs(this._enemySave(e, saveStat), dc);
      const evaded = sv.saved && saveStat === 'reflex' && e.evasion;
      const raw = sv.saved ? (evaded ? 0 : Math.floor(full / 2)) : full;
      const dmg = this._dmgE(e, raw, ab.dtype);
      const outcome = sv.saved ? (evaded ? '🤸 EVADES — 0' : `half ${dmg}`) : `fail ${dmg}`;
      parts.push(`${e.name}: ${saveLbl} ${sv.total} vs ${dc} ${outcome}${evaded ? '' : this._resistTag(e, ab.dtype)}${e.hp <= 0 ? ' ☠️' : ''}`);
    }
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} (${dice}d${ab.die || 6} → ${full} ${ab.dtype || ''}) — ${parts.join('; ')}.`, sound);
    this._echoToTable(sound);
  }
  // Disintegrate (PF1e): a ranged TOUCH ATTACK; on a hit, 2d6 per caster level
  // (cap 40d6 at CL20). Fortitude PARTIAL — a made save still takes 5d6 (NOT
  // half). Anything reduced to 0 HP is disintegrated into fine dust.
  _abDisintegrate(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    const sound = ab.sound || pick(SND.lightning);
    const touchAC = this._enemyAC(e, { touch: true });
    const toHit = this._spellToHit(m);   // BAB + casting-stat mod (house rule: spell stat, not Dex)
    const roll = dRoll(20), total = roll + toHit;
    if (roll !== 20 && (roll === 1 || total < touchAC)) {
      this._note(`${ab.icon} ${m.nickname}'s ${ab.name} ray streaks wide of ${e.name}. [touch d20 ${roll} ${this._fmtBonus(toHit)} = ${total} vs ${touchAC}]`, sound);
      this._echoToTable(sound); return;
    }
    const ndice = 2 * Math.min(20, m.level || 1);          // 2d6 / level, max 40d6
    const dc = this._spellDC(m);
    const sv = this._saveVs(this._enemySave(e, ab.save || 'fort'), dc);
    const raw = sv.saved ? dRollN(5, 6) : dRollN(ndice, 6);   // Fort partial → only 5d6 on a save
    const dmg = this._dmgE(e, raw, ab.dtype);
    const dust = e.hp <= 0;
    this._note(`${ab.icon} ${m.nickname}'s ${ab.name} ray hits ${e.name} — Fort ${sv.total} vs ${dc}: ${sv.saved ? `partial ${dmg}` : `${dmg} force`}${this._resistTag(e, ab.dtype)}.${dust ? ` ☠️ ${e.name} crumbles to DUST!` : ` (${Math.max(0, e.hp)}/${e.maxHp})`}`, sound);
    if (dust) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  }
  // Magic Missile — auto-hit force darts (PF1: 1 dart, +1 per 2 caster levels,
  // max 5; each 1d4+1). Darts split across selected foes if more than one.
  _abMissile(m, ab, payload) {
    const darts = Math.min(5, 1 + Math.floor(((m.level || 1) - 1) / 2));   // L1:1 L3:2 L5:3 L7:4 L9:5
    let targets = this._enemyTargets(payload, darts);
    if (!targets.length) { const e = this._oneEnemy(payload); if (!e) return; targets = [e]; }
    const sound = ab.sound || pick(SND.lightning), parts = [];
    for (let i = 0; i < darts; i++) {
      const e = targets[i % targets.length];
      if (!e || e.hp <= 0) continue;
      const d = dRoll(4) + 1;
      this._dmgE(e, d);
      parts.push(`${e.name} ${d}${e.hp <= 0 ? ' ☠️' : ''}`);
      if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    }
    this._note(`${ab.icon} ${m.nickname} looses ${darts} Magic Missile${darts > 1 ? 's' : ''} (auto-hit) — ${parts.join(', ')}.`, sound);
    this._echoToTable(sound);
  }
  // Ranged touch rays (Scorching Ray): 1+¼level rays of 4d6 each.
  _abRays(m, ab, payload) {
    let e = this._oneEnemy(payload); if (!e) return;
    // PF1e Scorching Ray: 1 ray, +1 per 4 caster levels past 3rd → 2 rays at CL7,
    // 3 at CL11. Each ray rolls to hit (4d6 fire) and is RESOLVED ONE AT A TIME — if
    // the target drops, the next ray redirects to another foe (you don't pre-commit
    // all rays to one target). When it SPLITS (2+), use the dramatic fire-combo sound.
    const rays = Math.max(1, Math.min(3, 1 + Math.floor(((m.level || 1) - 3) / 4)));
    const toHit = this._spellToHit(m);   // BAB + casting-stat mod (house rule: spell stat, not Dex)
    const sound = (rays >= 2 && ab.splitSound) ? ab.splitSound : (ab.sound || pick(SND.lightning));
    const tally = new Map();   // uid -> { name, dmg, hits }
    let anyHit = false;
    for (let i = 0; i < rays; i++) {
      if (!e || e.hp <= 0) e = this._targetableEnemies()[0];   // redirect to a fresh foe
      if (!e) break;                                            // nothing left to burn
      const rec = tally.get(e.uid) || { name: e.name, dmg: 0, hits: 0 };
      const roll = dRoll(20);
      if (roll === 20 || (roll !== 1 && roll + toHit >= this._enemyAC(e, { touch: true }))) {
        const d = this._dmgE(e, dRollN(ab.dice || 4, ab.die || 6), ab.dtype);
        rec.dmg += d; rec.hits++; anyHit = true;
        if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
      }
      tally.set(e.uid, rec);
    }
    if (!anyHit) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} (${rays} ray${rays > 1 ? 's' : ''}) all miss.`, sound); this._echoToTable(sound); return; }
    const parts = [...tally.values()].filter(r => r.hits).map(r => `${r.hits} ray${r.hits > 1 ? 's' : ''} → ${r.name} for ${r.dmg}`);
    this._note(`${ab.icon} ${m.nickname}'s ${ab.name} — ${parts.join('; ')} ${ab.dtype || 'fire'}.`, sound);
    this._echoToTable(sound);
  }
  // Spellstrike: a weapon hit carrying bonus elemental dice (+ optional debuff).
  _abSpellstrike(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    const sound = MAGUS_SPELLSTRIKE_SFX[m.nickname] || ab.sound || r.sound;
    if (!r.hit) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} misses ${e.name}. ${this._atkStr(r)}`, sound); this._echoToTable(sound); return; }
    const dn = this._spellDice(ab, m);
    // MAXIMIZED → every die is its max (no roll). EMPOWERED → ×1.5. CAN-CRIT → the
    // spell damage rides the weapon's crit multiplier too (Maximized Shocking Grasp).
    let bonus = this._rollSpell(m, dn, ab.die || 6, ab);   // per-ability maximized/empowered + the magus's metamagic feats (Intensify raises dn via _spellDice)
    if (r.crit) bonus *= (m.weapon.critMult || 2);       // the channelled spell rides the weapon's crit (×2 scimitar, ×3, …) — EVERY spellstrike, not just the Max one
    const sbonus = this._resisted(e, bonus, ab.dtype);    // spell rider vs the foe's ELEMENTAL resistance (shock, cold, fire…)
    const total = r.damage + sbonus;                      // r.damage already passed PHYSICAL DR (weapon type vs the foe's DR)
    this._dmgE(e, total);
    let extra = '';
    if (r.crit) extra += ' — CRIT!';
    if (ab.debuff === 'sickened' && e.hp > 0) { e.sickened = SICKENED_ROUNDS; extra += ' — staggered!'; }
    // Vampiric Touch: the negative energy heals the magus for what it drained.
    if (ab.lifesteal && bonus > 0) {
      const healed = Math.min(bonus, m.maxHp - m.hp);
      if (healed > 0) { m.hp += healed; extra += ` — drains ${healed} life (${m.hp}/${m.maxHp})!`; }
      else extra += ' — but is already at full vigor.';
    }
    // Forceful Strike — BULL RUSH: the foe is shoved, provoking a free attack from
    // one of the magus's melee allies (the closest stand-in for an attack of opportunity).
    if (ab.allyAOO && e.hp > 0) {
      const allies = this.livingParty().filter(a => a.playerId !== m.playerId && !a.flying);
      const ally = allies.length ? pick(allies) : null;
      if (ally) {
        ally.weapon = weaponOf(ally.gear, ally.weaponKey);
        const ra = this._swingVsAC(ally, this._enemyAC(e), e);
        if (ra.hit) { this._dmgE(e, ra.damage); extra += ` ${ally.nickname} seizes the opening — ${ra.damage}!`; if (e.hp <= 0) this._tryBanter(ally, 'down', { enemy: e.name }); }
        else extra += ` ${ally.nickname}'s free swing misses.`;
      }
    }
    this._note(`${ab.icon} ${m.nickname} ${ab.name}s ${e.name} for ${r.damage}${r.drTag || ''} weapon + ${sbonus}${this._resistTag(e, ab.dtype)} ${ab.dtype || ''} = ${total}.${extra}${this._afterEnemyHit(e)}`, sound);
    if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  }
  // MONK Stunning Fist (free class feature, 1/room): a precise strike — a normal
  // attack, and on a hit the foe makes a Fort save (DC 10 + ½ level + WIS mod) or
  // is STUNNED, losing its next turn (e.loseTurn — same plumbing as Trip).
  _abStunningFist(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    const sound = ab.sound || r.sound;
    if (!r.hit) { this._note(`${ab.icon} ${m.nickname}'s Stunning Fist misses ${e.name}. ${this._atkStr(r)}`, sound); this._echoToTable(sound); return; }
    this._dmgE(e, r.damage);
    const dc = 10 + Math.floor((m.level || 1) / 2) + ((m.mods && m.mods.wis) || 0);
    let extra = '';
    if (e.hp > 0) {
      if (mindImmune(e)) extra = ` — but ${e.name} is immune to stunning (no living body).`;   // PF1: undead & constructs ignore the stun (the strike still hurt)
      else {
        const sv = this._saveVs(this._enemySave(e, 'fort'), dc);
        if (!sv.saved) { e.loseTurn = true; extra = ` — STUNNED [${sv.total} vs DC ${dc}], it loses its turn!`; }
        else extra = ` — it shakes off the stun [${sv.total} vs DC ${dc}].`;
      }
    }
    this._note(`${ab.icon} ${m.nickname}'s Stunning Fist ${r.crit ? 'CRITS' : 'strikes'} ${e.name} for ${r.damage}${r.drTag || ''}.${extra}${this._afterEnemyHit(e)}`, sound);
    if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  }
  // ── MAGUS spell handlers ───────────────────────────────────────────────────
  // Glitterdust — a burst of clinging dust BLINDS a random 1d4 foes (Will negates).
  // Blinded = −4 to its own attacks, denied Dex (easier to hit, Sneak-Attackable).
  _abGlitterdust(m, ab, payload) {
    const sound = ab.sound;
    const dc = this._spellDC(m);
    const n = (ab.randBase || 1) + dRoll(ab.randDie || 4);
    const pool = this._targetableEnemies().slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const targets = pool.slice(0, n);
    if (!targets.length) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} settles on no one.`, sound); this._echoToTable(sound); return; }
    const parts = [];
    for (const e of targets) {
      const sv = this._saveVs(this._enemySave(e, ab.save || 'will'), dc);
      if (!sv.saved) { e.blinded = BLIND_ROUNDS; parts.push(`${e.name} BLINDED [${sv.total} vs ${dc}]`); }
      else parts.push(`${e.name} resists [${sv.total} vs ${dc}]`);
    }
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${parts.join('; ')}.`, sound);
    this._echoToTable(sound);
  }
  // Mirror Image — shimmering decoys soak incoming attacks (1d4 + 1 per 3 levels, max 8).
  _abMirrorImage(m, ab) {
    const lvl = m.level || 1;
    m.images = Math.min(8, dRoll(4) + Math.floor(lvl / 3));
    this._note(`${ab.icon} ${m.nickname} conjures ${m.images} mirror image${m.images > 1 ? 's' : ''} — decoys to soak incoming attacks!`, ab.sound);
    this._echoToTable(ab.sound);
  }
  // Blade Lash — strike one foe for weapon damage AND attempt to TRIP it (a combat-
  // maneuver check). On a success it is knocked prone and loses its turn.
  _abBladeLash(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    const sound = ab.sound || r.sound;
    if (!r.hit) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} cracks past ${e.name}. ${this._atkStr(r)}`, sound); this._echoToTable(sound); return; }
    this._dmgE(e, r.damage);
    let extra = '';
    if (e.hp > 0) {
      const blocked = this._tripBlocked(e);   // PF1: no legs / airborne / >1 size larger
      if (blocked) extra = ` — ${blocked}, cannot be tripped.`;
      else { const a = this._attackRoll(m, e, this._tripDefBonus(e)); if (a.hit) { e.prone = true; e.loseTurn = true; extra = ' — TRIPPED prone, it loses its turn!'; } else extra = ' — but it keeps its feet.'; }
    }
    this._note(`${ab.icon} ${m.nickname}'s ${ab.name} whips ${e.name} for ${r.damage}.${extra}${this._afterEnemyHit(e)}`, sound);
    if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  }
  // Bladed Dash — strike one foe, then the magus blurs out of reach: UNTARGETABLE
  // (by attacks, buffs, or heals) until the start of their next turn.
  _abBladedDash(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    const sound = ab.sound || r.sound;
    if (r.hit) { this._dmgE(e, r.damage); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    m.untargetable = true;   // cleared at the start of the magus's next turn (see _advanceToActor)
    this._note(r.hit
      ? `${ab.icon} ${m.nickname} DASHES through ${e.name} for ${r.damage} and blurs out of reach — untargetable until next turn!${this._afterEnemyHit(e)}`
      : `${ab.icon} ${m.nickname} dashes past ${e.name} (a miss) and blurs out of reach — untargetable until next turn. ${this._atkStr(r)}`, sound);
    this._echoToTable(sound);
  }
  // Dimensional Blade — a FREE action: the magus's strikes resolve as TOUCH attacks
  // (ignore armor & natural armor) for 1 round (see touchStrike in _swingVsAC).
  _abDimBlade(m, ab) {
    m.touchStrike = 1;   // active this turn; cleared at the start of the next turn (1 round)
    this._note(`${ab.icon} ${m.nickname} phases the blade half a step sideways — strikes hit on TOUCH this round!`, ab.sound);
    this._echoToTable(ab.sound);
  }
  // Haste — the whole party blurs with speed. Each ally gets ONE extra attack on
  // their turn (see _hasteBonus), consumed when they act.
  _abHaste(m, ab) {
    const sound = ab.sounds ? pick(ab.sounds) : ab.sound;
    // PF1 duration: 1 round per caster level (each hasted turn grants an extra
    // attack; _hasteBonus decrements the counter). It always clears at room end
    // with the other buffs, so a long-enough fight is the only thing that ends it
    // early — which almost never happens (rooms rarely run past ~10 rounds).
    const turns = Math.max(1, m.level || 1);
    // The real HASTE spell (key 'haste') grants the extra attack PLUS +1 to hit,
    // +1 dodge AC, +1 Reflex (via _hasteMod). Blessing of Fervor (key
    // 'blessingoffervor') grants ONLY the extra attack — its PF1 haste choice.
    const full = ab.key === 'haste';
    for (const a of this.livingParty()) { a.hasted = turns; a.hasteFull = full; }
    // The caster spent THIS turn casting — their own extra attack waits until
    // their next turn (so the cast plays the Haste sound, not an immediate swing).
    m._justHasted = true;
    const extra = full ? ' (extra attack, +1 to hit, +1 AC, +1 Reflex)' : ' (an extra attack each turn)';
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — the party blurs with speed for ${turns} turn${turns > 1 ? 's' : ''}!${extra}`, sound);
    this._echoToTable(sound);
  }
  // Dispel Magic — strip the worst debuff off an afflicted ally (or self).
  // Dispel Magic auto-targets: the WORST-afflicted ally (strip their debuffs); or
  // if no ally is debuffed, strip the strongest BUFF off a foe (haste / combat
  // bonuses), if any.
  // PF1 dispel check: 1d20 + caster level vs DC 11 + the effect's caster level.
  // (The +10 CL cap is folded into the CL itself; Greater Dispel adds +4 — its
  // superior unweaving.) Returns { ok, roll, total, dc }. NOT auto-success on a 20
  // (caster-level checks aren't, in PF1).
  _dispelCheck(m, effectCL, greater) {
    const cl = (m.level || 1) + (greater ? 4 : 0);
    const roll = dRoll(20), total = roll + cl, dc = 11 + Math.max(1, effectCL | 0);
    return { ok: total >= dc, roll, total, dc, cl };
  }
  _abCleanse(m, ab) {
    const sound = ab.sound;
    const FAIL_SOUND = '/audio/vine_boom.mp3';   // a FAILED dispel check (Foundry sting)
    const sev = (a) => (a.paralyzed > 0 ? 5 : 0) + (a.stunned > 0 ? 4 : 0) + (a.slowed > 0 ? 2 : 0) + (a.grappled ? 2 : 0) + (a.blinded > 0 ? 2 : 0) + (a.sickened > 0 ? 1 : 0);
    // 1) Worst debuff on an ally. The hostile magic's caster level ≈ the toughest
    //    foe present (the likely source), floored by the dungeon depth.
    const hurt = this.livingParty().filter(a => sev(a) > 0).sort((x, y) => sev(y) - sev(x))[0];
    if (hurt) {
      const enemyCL = Math.max(this.depth || 1, ...this._targetableEnemies().map(e => crToNum(e.cr) || 1), 1);
      const dc = this._dispelCheck(m, enemyCL, ab.greater);
      if (!dc.ok) {   // the weave HOLDS
        this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${hurt.nickname} — but the hostile magic HOLDS! [dispel d20 ${dc.roll} +${dc.cl} = ${dc.total} vs DC ${dc.dc}]`, FAIL_SOUND);
        this._echoToTable(FAIL_SOUND); return;
      }
      const cleared = [];
      if (hurt.paralyzed > 0) { hurt.paralyzed = 0; hurt.heldDC = null; cleared.push('paralysis'); }
      if (hurt.stunned > 0)   { hurt.stunned = 0;   cleared.push('stun'); }
      if (hurt.slowed > 0)    { hurt.slowed = 0; hurt._slowTick = 0; cleared.push('slow'); }
      if (hurt.grappled)      { hurt.grappled = false; hurt.grappledBy = null; cleared.push('grapple'); }
      if (hurt.blinded > 0)   { hurt.blinded = 0;   cleared.push('blindness'); }
      if (hurt.sickened > 0)  { hurt.sickened = 0;  cleared.push('sickness'); }
      this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${hurt.nickname} — clears ${cleared.join(', ')}! [dispel ${dc.total} vs DC ${dc.dc}]`, sound);
      this._echoToTable(sound); return;
    }
    // 2) No ally debuff → strip the strongest buff off a foe (dispel check vs ITS CL).
    const foeScore = (e) => (e.hasted > 0 ? 3 : 0) + (e.buffs ? ((e.buffs.toHit || 0) + (e.buffs.dmg || 0) + (e.buffs.ac || 0) + (e.buffs.bonusDice || 0)) : 0);
    const foe = this._targetableEnemies().filter(e => foeScore(e) > 0).sort((x, y) => foeScore(y) - foeScore(x))[0];
    if (foe) {
      const dc = this._dispelCheck(m, Math.max(this.depth || 1, crToNum(foe.cr) || 1), ab.greater);
      if (!dc.ok) {   // its enchantment HOLDS
        this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${foe.name} — but its enchantment HOLDS! [dispel d20 ${dc.roll} +${dc.cl} = ${dc.total} vs DC ${dc.dc}]`, FAIL_SOUND);
        this._echoToTable(FAIL_SOUND); return;
      }
      const stripped = [];
      if (foe.hasted > 0) { foe.hasted = 0; stripped.push('haste'); }
      if (foe.buffs) { foe.buffs = null; stripped.push('combat buffs'); }
      this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${foe.name} — strips its ${stripped.join(' & ')}! [dispel ${dc.total} vs DC ${dc.dc}]`, sound);
      this._echoToTable(sound); return;
    }
    // Nothing magical to dispel — NOT a failed check, so no fail sting.
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — but there's nothing to dispel.`, sound);
    this._echoToTable(sound);
  }
  // Invisibility — enemies can't target you until you attack (see _targetableParty
  // and the m.invisible=false clears in _playerAttack / offensive _useAbility).
  _abInvisible(m, ab, payload) {
    if (ab.greater) {
      // GREATER INVISIBILITY — stays up the whole fight, even when attacking. Best
      // on a ROGUE ally (constant Sneak Attack); else the caster, or a chosen ally.
      const party = this.livingParty();
      let target = null;
      if (payload && payload.targetUid) target = party.find(a => a.playerId === payload.targetUid || a.uid === payload.targetUid);
      if (!target) target = party.find(a => a.cls === 'rogue' && a.playerId !== m.playerId) || m;
      target.invisible = true; target.greaterInvis = true;
      const who = (target.playerId === m.playerId) ? 'themselves' : target.nickname;
      const bonus = (target.cls === 'rogue') ? ' — and every strike a Sneak Attack!' : '';
      this._note(`${ab.icon} ${m.nickname} wraps ${who} in GREATER INVISIBILITY — unseen for the whole fight${bonus}`, ab.sound);
      this._echoToTable(ab.sound);
      return;
    }
    // Cloak the MOST-HURT ally (least current HP) — not necessarily the caster.
    const target = this.livingParty().slice().sort((a, b) => a.hp - b.hp)[0] || m;
    target.invisible = true;
    const who = (target.playerId === m.playerId) ? 'themselves' : target.nickname;
    this._note(`${ab.icon} ${m.nickname} cloaks ${who} in INVISIBILITY — unseen until they strike.`, ab.sound);
    this._echoToTable(ab.sound);
  }
  // Mage Armor — a run-long +4 armor AC (see _acBonus). A free action; the flag is
  // NOT cleared on room reset, so it lasts the whole dungeon.
  _abMageArmor(m, ab) {
    m.mageArmor = true;
    this._note(`${ab.icon} ${m.nickname} weaves MAGE ARMOR — +4 armor AC for the rest of the dungeon.`, ab.sound);
    this._echoToTable(ab.sound);
  }
  // Overland Flight — a RUN-long flight (m.overlandFlight; re-asserted each room in
  // _resetAbilities). Grounded foes can't reach the caster; they can still cast.
  _abOverlandFlight(m, ab) {
    m.overlandFlight = true; m.flying = true;
    if (ab.canHitFlyers) m.canHitFlyers = true;   // magus version — can also melee airborne foes
    this._note(`${ab.icon} ${m.nickname} rises on OVERLAND FLIGHT — airborne for the rest of the dungeon (grounded foes can't reach them).`, ab.sound);
    this._echoToTable(ab.sound);
  }
  // Infernal Healing, Greater — fast healing 4 on the most-wounded ally (or a chosen
  // ally). Ticks at the start of that ally's turn (see _advanceToActor); lasts the room.
  _abInfernalHeal(m, ab) {
    // Always lands on the ally with the LEAST current HP right now — INCLUDING
    // downed/dying allies below 0 HP (the fast healing can knit them back up).
    // If everyone is at full HP, the caster takes it themselves.
    const wounded = this.party.filter(a => !a.left && !a.dead && a.hp < a.maxHp);
    const target = wounded.length ? wounded.slice().sort((a, b) => a.hp - b.hp)[0] : m;
    target.infernalHeal = ab.heal || 4;
    const who = (target.playerId === m.playerId) ? 'themselves' : target.nickname;
    this._note(`${ab.icon} ${m.nickname} anoints ${who} with infernal ichor — fast healing ${target.infernalHeal} HP/turn for the rest of the room.`, ab.sound);
    this._echoToTable(ab.sound);
  }
  // Black Tentacles — a room hazard: each round (and on the cast) it grapples a
  // random 1d4+1 ungrappled foes (PF1 grapple: CMB vs CMD). Grappled = helpless,
  // losing turns until they break free (see _enemyAct). Lasts the room.
  _abBlackTentacles(m, ab) {
    const cl = m.level || 1;
    this.blackTentacles = { cmb: cl + 5, caster: m.playerId, sound: ab.sound };   // CMB ≈ caster level + Str/size
    this._note(`${ab.icon} ${m.nickname} conjures BLACK TENTACLES — the floor erupts with grasping limbs!`, ab.sound);
    this._echoToTable(ab.sound);
    this._blackTentaclesTick();   // grab immediately on the cast
  }
  _blackTentaclesTick() {
    const bt = this.blackTentacles; if (!bt) return;
    const free = this._targetableEnemies().filter(e => !e.grappled && e.hp > 0);
    if (!free.length) return;
    for (let i = free.length - 1; i > 0; i--) { const j = dRoll(i + 1) - 1; [free[i], free[j]] = [free[j], free[i]]; }
    const grabbed = free.slice(0, dRoll(4) + 1), parts = [];   // 1d4+1 foes
    for (const e of grabbed) {
      const ecmd = 10 + (e.toHit || 0) + 2;                    // foe's CMD (rough)
      const roll = dRoll(20), tot = roll + bt.cmb;
      if (roll === 20 || tot >= ecmd) { e.grappled = true; e.grappledBy = 'tentacles'; e.grappleRounds = 99; parts.push(`${e.name} SEIZED [${tot} vs ${ecmd}]`); }
      else parts.push(`${e.name} resists [${tot} vs ${ecmd}]`);
    }
    if (parts.length) { this._note(`🦑 The black tentacles lash out — ${parts.join('; ')}.`, bt.sound); this._broadcast(); }
  }
  // Suffocation — single living target (not undead/constructs): Fort save or DIE.
  // A made save (or a boss too tough to fell outright) still takes heavy damage.
  _abSaveDie(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    const sound = ab.sound || pick(SND.lightning);
    // Only living, breathing creatures can be suffocated — undead, constructs,
    // oozes and elementals are immune (by type, with a name fallback).
    const immune = e.type === 'undead' || e.type === 'construct'
      || /golem|skelet|zombie|wraith|ghost|lich|vampire|wight|ghoul|ghast|shadow|ooze|elemental|construct|undead/i.test(e.name || '');
    if (immune) {
      this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${e.name} — but it doesn't breathe. No effect.`, sound);
      this._echoToTable(sound); return;
    }
    const dc = this._spellDC(m);
    const sv = this._saveVs(this._enemySave(e, ab.save || 'fort'), dc);
    if (!sv.saved && !e.boss) {
      this._dmgE(e, e.hp + 20, ab.dtype);   // lethal
      this._note(`${ab.icon} ${m.nickname} SUFFOCATES ${e.name}! [Fort ${sv.total} vs ${dc}] — it collapses, airless and lifeless. ☠️`, sound);
    } else {
      const frac = !sv.saved ? 0.5 : 0.25;   // boss-failed = half max HP; made save = a quarter
      const dmg = this._dmgE(e, Math.max(6, Math.floor((e.maxHp || 20) * frac)), ab.dtype);
      this._note(`${ab.icon} ${m.nickname}'s ${ab.name} chokes ${e.name} — ${!sv.saved ? 'too mighty to fell outright' : 'it claws in a breath'}: ${dmg} damage. [Fort ${sv.total} vs ${dc}]${e.hp <= 0 ? ' ☠️' : ''}`, sound);
    }
    this._echoToTable(sound);
  }
  // Judgement (inquisitor): set the one active judgement. Switching is a FREE
  // action (see _useAbility returning freeAction). destruction=+dmg, protection=
  // +AC, healing=regen each of your turns. Applied in combat math + _advanceToActor.
  _abJudgment(m, ab) {
    m.judgment = ab.judgmentType;
    const what = { destruction: '⚔️ Destruction (+damage)', protection: '🛡️ Protection (+AC)', healing: '💗 Healing (regen)' }[ab.judgmentType] || ab.judgmentType;
    this._note(`${ab.icon} ${m.nickname} pronounces Judgement — ${what}.`, ab.sound);
    this._echoToTable(ab.sound);
  }
  // Bane (inquisitor): declare a creature TYPE (a FREE action — see _useAbility
  // returning freeAction; 1 use per 5 levels per room). The bane bonus (+2 to hit,
  // +2d6+2 damage) then applies ONLY to foes of that type, until you re-declare.
  // The bonus math lives in _playerAttack (baneOn). A human picks by selecting a
  // foe (the client sends its type as payload.baneType); bots auto-pick.
  _abBane(m, ab, payload) {
    const type = (payload && payload.baneType) || this._autoBaneType();
    if (!type) { this._note(`🗡️ ${m.nickname} finds no foe worth naming for Bane.`); return; }
    m.bane = { type };
    this._note(`${ab.icon} ${m.nickname} pronounces BANE against ${titleCase(type)} — +2 to hit and +2d6+2 damage vs ${titleCase(type)} this room.`, ab.sound);
    this._echoToTable(ab.sound);
  }
  // Auto-pick a Bane type from the foes on the field: the most COMMON type present,
  // breaking ties toward the TOUGHEST foe's type.
  _autoBaneType() {
    const foes = this.livingEnemies();
    if (!foes.length) return null;
    const counts = new Map();
    for (const e of foes) if (e.type) counts.set(e.type, (counts.get(e.type) || 0) + 1);
    if (!counts.size) return null;
    let best = null, bestN = -1;
    for (const [t, n] of counts) if (n > bestN) { best = t; bestN = n; }
    const toughest = foes.slice().sort((a, b) => b.maxHp - a.maxHp)[0];   // tie-break → toughest foe's type
    if (toughest && toughest.type && counts.get(toughest.type) === bestN) best = toughest.type;
    return best;
  }
  // If `m` is hasted, spend it on one bonus attack against a living foe. Called
  // right after the member's normal action resolves (human + bot paths).
  _hasteBonus(m) {
    if (!m) return;
    // This runs at the very end of the member's turn, so it's also where the
    // taunt compulsion is spent — but the free Haste swing still honors it.
    const forced = this._forcedFoe(m);
    m.tauntedBy = null;
    if (!(m.hasted > 0) || m.hp <= 0 || m.left || m.dead) return;
    if (m._justHasted) { m._justHasted = false; return; }   // cast Haste this turn → bonus starts next turn
    m.hasted -= 1;   // spend one of the hasted turns
    const foes = this.livingEnemies();
    if (!foes.length) return;
    const tgt = (forced && foes.includes(forced)) ? forced : (this._preferredFoe(m, foes) || foes[0]);
    this._note(`💨 ${m.nickname} blurs with Haste — an extra strike!`);
    this._playerAttack(m, tgt.uid, true);   // quiet: don't clobber the turn's main-action sound
  }
  // Breath of Life (revive a DYING ally + big heal) / Raise Dead + Resurrection
  // (bring a SLAIN ally back into the run). High-level cleric prayers.
  _abRevive(m, ab) {
    const lvl = m.level || 1;
    const sound = ab.sound;
    const healBig = () => Math.max(1, dRollN(ab.reviveDice || 5, 8) + Math.min(ab.reviveCap || lvl, lvl));
    if (ab.raiseDead) {
      // Raise Dead / Resurrection — cast OUT of combat (end of room). Bring a SLAIN ally
      // back: Raise Dead at 1 HP (the lost level STAYS lost); Resurrection at FULL HP
      // (the lost level is RESTORED — we simply clear the still-pending penalty).
      const dead = this.party.find(a => a.dead && !a.left);
      if (dead) {
        dead.dead = false; dead.downed = false; dead.left = false;
        dead.flatFooted = true; dead.paralyzed = 0; dead.stunned = 0;
        if (ab.full) {
          dead.hp = dead.maxHp;
          dead._deathPending = false;   // Resurrection restores the lost level
          this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${dead.nickname} is RESURRECTED at full health, whole again (level restored)!`, sound);
        } else {
          dead.hp = 1;
          this._applyDeathPenalty(dead);   // Raise Dead does NOT restore the lost level
          this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${dead.nickname} is dragged back into the run at 1 HP.`, sound);
        }
        if (this.status === 'combat' && !this.turnOrder.some(t => t.kind === 'party' && t.id === dead.playerId)) {
          this.turnOrder.push({ kind: 'party', id: dead.playerId, init: dRoll(20) });
        }
        this._echoToTable(sound); this._broadcast(); return;
      }
      // No corpse to raise → fall through to a big heal.
    } else {
      // Breath of Life — snatch a DYING (downed) OR freshly-SLAIN ally back (castable IN
      // combat). Catching them in time PREVENTS the lost level. Prefer the dying (cheaper
      // to save) before the dead.
      const target = this.party.find(a => !a.left && !a.dead && a.downed)
                  || this.party.find(a => !a.left && a.dead);
      if (target) {
        const wasDead = target.dead;
        target.dead = false; target.downed = false;
        target.hp = Math.min(target.maxHp, Math.max(1, healBig()));
        target._deathPending = false;   // revived in time → no level lost
        if (wasDead) {
          target.flatFooted = true; target.paralyzed = 0; target.stunned = 0;
          if (this.status === 'combat' && !this.turnOrder.some(t => t.kind === 'party' && t.id === target.playerId)) {
            this.turnOrder.push({ kind: 'party', id: target.playerId, init: dRoll(20) });
          }
        }
        this._note(`${ab.icon} ${m.nickname} breathes life into ${target.nickname} — back ${wasDead ? 'from the brink of death ' : ''}up at ${target.hp}/${target.maxHp} HP!`, sound);
        this._echoToTable(sound); this._broadcast(); return;
      }
    }
    // Nobody to revive → a big heal on the most-hurt living ally.
    const allies = this.livingParty();
    const target = allies.slice().sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0] || m;
    const h = healBig(); target.hp = Math.min(target.maxHp, target.hp + h);
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${target.nickname} heals ${h} (${target.hp}/${target.maxHp}).`, sound);
    this._echoToTable(sound);
  }
  // Save-or-be-disabled (Hold Person): Will save or paralyzed.
  _abSaveDebuff(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    if (ab.debuff === 'paralyzed' && mindImmune(e)) { this._note(`${ab.icon} ${e.name} is immune to ${ab.name} — undead and constructs have no mind to seize.`); this._echoToTable(); return; }
    const dc = this._spellDC(m);
    const sv = this._saveVs(this._enemySave(e, ab.save || 'will'), dc);
    const sound = ab.sound || pick(SND.stink);
    // Hold Person / Hideous Laughter: HELD for up to 1 round per caster level,
    // but a NEW Will save each of the foe's turns can end it early (the re-save
    // costs its turn either way) — see the heldDC handling in _advanceToActor.
    if (!sv.saved && ab.debuff === 'paralyzed') { e.paralyzed = Math.max(2, Math.min(12, m.level || 1)); e.heldDC = dc; }
    else if (!sv.saved && ab.debuff === 'sickened') e.sickened = SICKENED_ROUNDS;
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${e.name} — save ${sv.total} vs DC ${dc}: ${sv.saved ? 'resists' : `${String(ab.debuff).toUpperCase()}!`}`, sound);
    this._echoToTable(sound);
  }
  // Touch spell (Shocking Grasp): a ranged touch attack for level d6.
  _abTouch(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    const touchAC = this._enemyAC(e, { touch: true });
    const toHit = this._spellToHit(m) + ((m.buffs && m.buffs.toHit) || 0);   // casting-stat mod (house rule), + any combat buffs (e.g. magus melee touch)
    const roll = dRoll(20), total = roll + toHit;
    const sound = ab.sound || pick(SND.lightning);
    if (roll !== 20 && (roll === 1 || total < touchAC)) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} misses ${e.name}. [touch d20 ${roll} ${this._fmtBonus(toHit)} = ${total} vs ${touchAC}]`, sound); this._echoToTable(sound); return; }
    const dice = this._spellDice(ab, m);
    const raw = Math.max(1, this._rollSpell(m, dice, ab.die || 6, ab));
    const dmg = this._dmgE(e, raw, ab.dtype);
    let dotNote = '';
    if (ab.dot && e.hp > 0) {   // Acid Arrow: it keeps eating away each of the foe's turns.
      const rounds = Math.min(5, Math.max(1, Math.floor((m.level || 1) / 3)));   // 1 round per 3 caster levels
      e.acid = { rounds, dice: Math.max(1, Math.floor(dice / 2)), die: ab.die || 6 };   // a fading burn (half the initial dice)
      dotNote = ` It clings and KEEPS BURNING (${rounds} more round${rounds > 1 ? 's' : ''}).`;
    }
    this._note(`${ab.icon} ${m.nickname}'s ${ab.name} hits ${e.name} for ${dmg} ${ab.dtype || ''}${this._resistTag(e, ab.dtype)}.${dotNote}${this._afterEnemyHit(e)}`, sound);
    if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  }
  // Grease: up to maxTargets foes Reflex-save or slip prone (and lose the turn).
  _abGrease(m, ab, payload) {
    const dc = this._spellDC(m);
    // Grease is slippery enough to let a GRAPPLED ally slither out of the chains.
    if (ab.effect === 'grease') for (const a of this.livingParty()) {
      if (a.grappled) { a.grappled = false; a.grappledBy = null; this._note(`🛢️ ${a.nickname} slips free of the grapple in the grease!`); }
    }
    // Gust of Wind hits a RANDOM 1d3 foes (randFoes); Grease targets the picked
    // ones. Save type is configurable (Grease=Reflex, Gust=Fort).
    let chosen;
    if (ab.randN || ab.randFoes) {
      const living = this._targetableEnemies().slice();
      for (let i = living.length - 1; i > 0; i--) { const j = dRoll(i + 1) - 1; [living[i], living[j]] = [living[j], living[i]]; }
      // randN d randDie (e.g. Entangle = 2d4) OR a single 1dN (randFoes).
      let count = 0;
      if (ab.randN) { for (let i = 0; i < ab.randN; i++) count += dRoll(ab.randDie || 4); }
      else count = dRoll(ab.randFoes);
      chosen = living.slice(0, count);
    } else {
      chosen = this._enemyTargets(payload, ab.maxTargets || 2);
    }
    const saveType = ab.save || 'reflex';
    const lbl = saveType === 'fort' ? 'Fort' : saveType === 'will' ? 'Will' : 'Ref';
    const sound = ab.sound || pick(SND.flesh), parts = [];
    for (const e of chosen) {
      if (e.flying) { parts.push(`${e.name}: airborne — can't be tripped (immune to prone)`); continue; }
      const sv = this._saveVs(this._enemySave(e, saveType), dc);
      if (!sv.saved) { e.prone = true; e.loseTurn = true; }
      parts.push(`${e.name}: ${lbl} ${sv.total} vs ${dc} ${sv.saved ? 'stays up' : 'KNOCKED prone'}`);
    }
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${parts.join('; ')}.`, sound);
    this._echoToTable(sound);
  }
  // Sleep: the weakest foes (lowest HP) must make a Will save or fall asleep —
  // helpless (flat-footed) and losing turns until something strikes them.
  _abSleep(m, ab, payload) {
    const dc = this._spellDC(m);
    const chosen = this._enemyTargets(payload, ab.maxTargets || 3).filter(e => !ccd(e) && !mindImmune(e)).slice().sort((a, b) => a.hp - b.hp);   // skip already-CC'd foes + mind-immune (undead/construct)
    if (!chosen.length) { this._note(`${ab.icon} ${m.nickname} casts ${ab.name}, but those foes are immune or already entranced.`); this._echoToTable(); return; }
    const sound = ab.sound || pick(SND.flesh), parts = [];
    for (const e of chosen) {
      const sv = this._saveVs(this._enemySave(e, 'will'), dc);
      if (!sv.saved) { e.fascinated = true; e.asleep = true; e.flatFooted = true; }   // asleep: skip turns (woken by a hit) + helpless
      parts.push(`${e.name}: Will ${sv.total} vs ${dc} ${sv.saved ? 'shrugs it off' : '💤 ASLEEP'}`);
    }
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${parts.join('; ')}.`, sound);
    this._echoToTable(sound);
  }
  // Slow: a RANDOM 2d4 foes must make a Will save or be SLOWED for ~1 round per
  // caster level — sluggish (acts only every other turn) and a touch easier to
  // hit (−1 AC). Plays the Evil Morty theme.
  _abSlow(m, ab, payload) {
    const dc = this._spellDC(m);
    const living = this._targetableEnemies().slice();
    for (let i = living.length - 1; i > 0; i--) { const j = dRoll(i + 1) - 1; [living[i], living[j]] = [living[j], living[i]]; }
    const n = dRollN(ab.randN || 2, ab.randDie || 4);   // 2d4 targets
    const chosen = living.slice(0, n);
    const dur = Math.max(3, Math.min(10, m.level || 1));
    const sound = ab.sound || pick(SND.flesh), parts = [];
    for (const e of chosen) {
      const sv = this._saveVs(this._enemySave(e, ab.save || 'will'), dc);
      if (!sv.saved) { e.slowed = Math.max(e.slowed || 0, dur); e._slowTick = 0; }
      parts.push(`${e.name}: Will ${sv.total} vs ${dc} ${sv.saved ? 'resists' : '🐌 SLOWED'}`);
    }
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${chosen.length} foe${chosen.length === 1 ? '' : 's'} — ${parts.join('; ')}.`, sound);
    this._echoToTable(sound);
  }
  // Fascinate: up to maxTargets foes stand enthralled, losing turns until struck.
  // Darkness (wizard/sorcerer): shroud a RANDOM 1d3 foes — they can't act AND can't
  // be targeted for 2 of their turns (see _advanceToActor decrement + _targetableEnemies).
  _abDarkness(m, ab) {
    const living = this._targetableEnemies().slice();   // don't re-darken already-shrouded foes
    for (let i = living.length - 1; i > 0; i--) { const j = dRoll(i + 1) - 1; [living[i], living[j]] = [living[j], living[i]]; }
    const n = (ab.randBase || 0) + dRoll(ab.randDie || ab.randFoes || 3);   // Darkness: 1d4+1 foes
    const chosen = living.slice(0, n);
    if (!chosen.length) { this._note(`${ab.icon} ${m.nickname} conjures ${ab.name}, but there's no one to shroud.`); this._echoToTable(); return; }
    for (const e of chosen) { e.darkened = 2; e.flatFooted = true; }
    const sound = ab.sound || pick(SND.stink);
    this._note(`${ab.icon} ${m.nickname} drowns ${chosen.map(e => e.name).join(', ')} in DARKNESS — gone for 2 rounds (can't act, can't be hit).`, sound);
    this._echoToTable(sound);
  }
  _abFascinate(m, ab, payload) {
    const chosen = this._enemyTargets(payload, ab.maxTargets || 3).filter(e => !ccd(e) && !mindImmune(e));   // skip already-CC'd foes + mind-immune (undead/construct)
    if (!chosen.length) { this._note(`${ab.icon} ${m.nickname} begins ${ab.name}, but those foes are immune or already entranced.`); return; }
    for (const e of chosen) e.fascinated = true;
    const sound = ab.sound || pick(SND.flesh);
    this._note(`${ab.icon} ${m.nickname} performs ${ab.name} — ${chosen.map(e => e.name).join(', ')} stand fascinated (until struck).`, sound);
    this._echoToTable(sound);
  }
  // Heal: 'party' (channel) heals all living allies; 'channel' (lay on hands)
  // heals the most-wounded ally (or self).
  // Hero's Defiance — a downed paladin's clutch self-rescue, auto-fired from the
  // turn loop when they're at 0 HP or below but NOT dead. PF1: they instantly
  // receive a lay-on-hands worth of healing (½ level d6, min 1d6). Once per room,
  // from LEVEL 1 (home-rule: paladin spellcasting starts at 1st). Guaranteed to
  // bring them to at least 1 HP so they return to functionality. Returns true if
  // it fired.
  _tryHeroesDefiance(m) {
    if (!m || (m.cls !== 'paladin' && m.cls !== 'antipaladin')) return false;
    if (!m.heroDefiance || m.heroDefiance <= 0) return false;
    m.heroDefiance -= 1;
    const lvl = m.level || 1;
    const heal = Math.max(1, dRollN(Math.max(1, Math.ceil(lvl / 2)), 6));   // lay-on-hands worth
    m.hp = Math.min(m.maxHp, Math.max(1, m.hp + heal));   // always back on their feet (>= 1 HP)
    m.downed = false;
    this._note(`✨ ${m.nickname} refuses to fall — HERO'S DEFIANCE! Heals ${heal} and rises (${m.hp}/${m.maxHp}).`, '/audio/spell_revive.mp3');
    this._echoToTable('/audio/spell_revive.mp3');
    return true;
  }
  _abHeal(m, ab) {
    const lvl = m.level || 1;
    const sound = ab.sound || pick(SND.flesh);
    // Channel Positive — PF1e positive-energy burst: ½ caster level d6 (1d6 at
    // L1, +1d6 every 2 levels → 6d6 at L11), to the whole party.
    const channelAmt = () => Math.max(1, dRollN(Math.max(1, Math.ceil(lvl / 2)), 6));
    // Cure X Wounds — healDice d8 + caster level (capped: +5 light, +10 moderate).
    const cureAmt = () => Math.max(1, dRollN(ab.healDice || 1, 8) + Math.min(ab.healCap || lvl, lvl));
    if (ab.heal === 'party') {
      // Offensive channel (PF1 cleric): if NOBODY needs healing but UNDEAD are on
      // the field, channeling positive energy SEARS them instead — ½ level d6, a
      // Will save (DC 10 + ½ level + casting mod) for half. Auto-decided so both
      // bots and humans channel sensibly: heal the living, else harm the undead.
      const woundedAllies = this.present().filter(a => !a.dead && a.hp < a.maxHp);
      const undead = this._targetableEnemies().filter(e => e.type === 'undead');
      if (!woundedAllies.length && undead.length) {
        const dmg = channelAmt(), dc = 10 + Math.floor(lvl / 2) + CAST_MOD, parts = [];
        for (const e of undead) {
          const sv = this._saveVs(this._enemySave(e, 'will'), dc);
          const taken = this._dmgE(e, sv.saved ? Math.floor(dmg / 2) : dmg, 'positive');
          parts.push(`${e.name} ${taken}${sv.saved ? ' (Will ' + sv.total + ' — half)' : ''}${e.hp <= 0 ? ' ☠️' : ''}`);
        }
        this._note(`${ab.icon} ${m.nickname} channels positive energy — it SEARS the undead for ${dmg} (${parts.join(', ')}).`, sound);
        this._echoToTable(sound);
        return;
      }
      // PF1e: a channel rolls its healing ONCE and heals EVERY hero in the burst.
      // That includes the DOWNED/dying (negative HP but not dead at −10) — a
      // channel is positive energy and can pull a dying ally back onto their feet.
      const allies = this.present().filter(a => !a.dead);
      const h = channelAmt();
      const parts = [];
      for (const a of allies) {
        const wasDown = a.hp <= 0;
        a.hp = Math.min(a.maxHp, a.hp + h);
        const up = wasDown && a.hp > 0;
        if (up) a.downed = false;   // revived — back on their feet
        parts.push(`${a.nickname} ${a.hp}/${a.maxHp}${up ? ' ⤴up!' : ''}`);
      }
      this._note(`${ab.icon} ${m.nickname} channels positive energy — +${h} to the party (${parts.join(', ')}).`, sound);
    } else {
      // Target the MOST-HURT ally who is NOT dead — INCLUDING a downed/dying ally
      // (hp <= 0 but not slain at -10). (Was livingParty() = hp>0, so a cure could
      // skip a bleeding-out ally and land on someone barely scratched.) A cure
      // that lifts a downed ally above 0 puts them back on their feet.
      const cands = this.present().filter(a => !a.dead);
      const target = cands.slice().sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0] || m;
      const wasDown = target.hp <= 0;
      const h = cureAmt(); target.hp = Math.min(target.maxHp, target.hp + h);
      const up = wasDown && target.hp > 0;
      if (up) target.downed = false;   // healed back to consciousness
      this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${target.nickname} heals ${h} (${target.hp}/${target.maxHp})${up ? ' ⤴up!' : ''}.`, sound);
    }
    this._echoToTable(sound);
  }
  // Sticky room buff (Rage / Judgment / Bane / Inspire). `party` spreads it.
  // Grant temporary HP (rage's / Bear's Endurance's Con bonus) — boosts current
  // AND max HP; reverted when the buff ends (room reset, see _resetAbilities).
  _grantTempHp(who, amount) {
    if (!amount) return;
    who.tempHp = (who.tempHp || 0) + amount;
    who.maxHp += amount; who.hp += amount;
  }
  // Pick the single ally a target:'ally' buff lands on — the player's chosen one,
  // else a bot picks by intent (most-hurt for Bear's, a martial for Bull's…).
  _buffTarget(m, ab, payload) {
    const allies = this.livingParty();
    if (payload && payload.targetUid) { const t = allies.find(a => a.playerId === payload.targetUid); if (t) return t; }
    const MARTIAL = ['fighter', 'barbarian', 'paladin', 'antipaladin', 'ranger', 'rogue', 'magus', 'cavalier', 'monk', 'inquisitor'];
    // A sticky buff WON'T stack — re-casting it on an ally who already has it is a
    // wasted slot/turn. So pick only from allies who DON'T have THIS buff yet; if
    // everyone already has it, fall back to the full list (the bot's buffFullyUp
    // gate, which calls this too, then sees the buff is up and skips the cast).
    const has = (a) => !!(a.buffApplied && a.buffApplied[ab.key]);
    const eligible = allies.filter(a => !has(a));
    const pool = eligible.length ? eligible : allies;
    const acScore = (a) => this._acOf(a).ac + this._acBonus(a) - this._acPenalty(a);
    if (ab.key === 'shieldoffaith') return pool.slice().sort((a, b) => acScore(a) - acScore(b))[0] || m;   // lowest-AC ally WITHOUT it
    if (ab.key === 'bearsendurance') return pool.slice().sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0] || m;
    if (ab.key === 'catsgrace')      return pool.find(a => a.cls === 'ranger' || a.cls === 'rogue') || pool.find(a => MARTIAL.includes(a.cls)) || m;
    if (ab.key === 'bullsstrength')  return pool.find(a => MARTIAL.includes(a.cls) && a.playerId !== m.playerId) || pool.find(a => MARTIAL.includes(a.cls)) || m;
    if (ab.key === 'stoneskin')      return pool.filter(a => !a.dr).slice().sort((a, b) => a.hp - b.hp)[0] || pool.slice().sort((a, b) => a.hp - b.hp)[0] || m;   // least-HP ally without it
    return m;
  }
  // ── STANCE TOGGLES (Power Attack / Deadly Aim) ──────────────────────────────
  // Both are FREE, no-cost stances that stay on until flipped off — including ACROSS
  // rooms (re-asserted silently by _resetAbilities). Shared helpers so the toggle,
  // the silent room re-apply, and the bot's high-AC "ease off" decision all run the
  // same math. on=true applies, on=false backs out exactly what was put on.
  _applyDeadlyAim(m, on, { silent, sound } = {}) {
    m.buffApplied = m.buffApplied || {};
    m.buffs = m.buffs || { toHit: 0, dmg: 0, bonusDice: 0, acPen: 0, save: 0, ac: 0 };
    if (!on) {
      if (!m.buffApplied.deadlyaim) return;
      m.buffApplied.deadlyaim = false; m.aimOn = false;
      m.buffs.toHit += 2; m.buffs.dmg -= (m._aimBonus || 0); m._aimBonus = 0;
      if (!silent) { this._note(`🎯 ${m.nickname} eases off Deadly Aim — steadier, lighter shots for a surer hit.`, sound); this._echoToTable(sound); }
      return;
    }
    if (m.buffApplied.deadlyaim) return;
    const dmg = 2 + 2 * Math.floor(((m.level || 1) - 1) / 4);   // +2 at 1-4, +4 at 5-8, +6 at 9-12…
    m.buffApplied.deadlyaim = true; m.aimOn = true; m._aimBonus = dmg;
    m.buffs.toHit -= 2; m.buffs.dmg += dmg;
    if (!silent) { this._note(`🎯 ${m.nickname} sets Deadly Aim — −2 to hit, +${dmg} damage on every shot.`, sound); this._echoToTable(sound); }
  }
  _applyPowerAttack(m, on, { silent, sound } = {}) {
    m.buffApplied = m.buffApplied || {};
    m.buffs = m.buffs || { toHit: 0, dmg: 0, bonusDice: 0, acPen: 0, save: 0, ac: 0 };
    if (!on) {   // back out exactly what we put on
      if (!m.buffApplied.powerattack) return;
      m.buffApplied.powerattack = false; m.paOn = false;
      m.buffs.toHit += (m._paPen || 0); m.buffs.dmg -= (m._paBonus || 0);
      m._paPen = 0; m._paBonus = 0;
      if (!silent) { this._note(`💥 ${m.nickname} eases off Power Attack — a measured guard for a surer hit.`, sound); this._echoToTable(sound); }
      return;
    }
    if (m.buffApplied.powerattack) return;
    const w = weaponOf(m.gear, m.weaponKey);
    const pen = 1 + Math.floor(babFor(m.cls || 'fighter', m.level || 1) / 4);   // −1 per +4 BAB
    const bonus = Math.floor(pen * 2 * (w.cat === '2h' ? 1.5 : 1));             // +2 per −1, ×1.5 two-handed
    m.buffApplied.powerattack = true; m.paOn = true; m._paPen = pen; m._paBonus = bonus;
    m.buffs.toHit -= pen; m.buffs.dmg += bonus;
    if (!silent) { this._note(`💥 ${m.nickname} hauls into Power Attack — −${pen} to hit, +${bonus} damage on every blow.`, sound); this._echoToTable(sound); }
  }
  _abBuff(m, ab, payload) {
    const sound = ab.sound || pick(SND.flesh);
    const lvl = m.level || 1;
    // Power Attack / Deadly Aim — stance toggles; flip via the shared helpers.
    if (ab.deadlyaim)   { this._applyDeadlyAim(m, !(m.buffApplied && m.buffApplied.deadlyaim), { sound }); return; }
    if (ab.powerattack) { this._applyPowerAttack(m, !(m.buffApplied && m.buffApplied.powerattack), { sound }); return; }
    // RAGE — scales like PF1e (Greater at 11, Mighty at 20) and pumps Con → HP.
    if (ab.key === 'rage') {
      m.buffApplied = m.buffApplied || {};
      if (m.buffApplied.rage) return;   // already raging this room
      m.buffApplied.rage = true;
      const mod = lvl >= 20 ? 4 : lvl >= 11 ? 3 : 2;   // +8/+6/+4 Str & Con → +4/+3/+2 mod
      m.buffs = m.buffs || { toHit: 0, dmg: 0, bonusDice: 0, acPen: 0, save: 0, ac: 0 };
      m.buffs.toHit += mod;          // Strength to hit
      m.buffs.dmg   += mod + 1;      // Strength to damage (+1 for a two-hander)
      m.buffs.save  += mod;          // morale bonus to Will
      m.buffs.acPen += 2;            // −2 AC while raging
      const hp = mod * lvl;          // +Con mod per Hit Die
      this._grantTempHp(m, hp);
      const tier = lvl >= 20 ? 'MIGHTY ' : lvl >= 11 ? 'GREATER ' : '';
      this._note(`😤 ${m.nickname} flies into a ${tier}RAGE — +${mod} hit, +${mod + 1} dmg, +${mod} Will, +${hp} HP (${m.hp}/${m.maxHp}), −2 AC!`, sound);
      this._echoToTable(sound);
      return;
    }
    // Inspire Courage scales with BARD level, PF1-style: +1, rising to +2/+3/+4
    // at caster level 5 / 11 / 17. (`lvl` is the caster's level.)
    const inspMod = lvl >= 17 ? 4 : lvl >= 11 ? 3 : lvl >= 5 ? 2 : 1;
    const apply = (who) => {
      who.buffApplied = who.buffApplied || {};
      if (ab.sticky && who.buffApplied[ab.key]) return;   // already active this room — don't stack
      if (ab.sticky) who.buffApplied[ab.key] = true;
      if (ab.persist) {   // Bless / Inspire: a run-long buff that survives room resets (never fades)
        const tH = ab.key === 'inspire' ? inspMod : ((ab.buff && ab.buff.toHit) || 0);
        const dG = ab.key === 'inspire' ? inspMod : ((ab.buff && ab.buff.dmg) || 0);
        who.runBuffs = who.runBuffs || { toHit: 0, dmg: 0 };
        who.runBuffs.toHit += tH;
        who.runBuffs.dmg   += dG;
        who.runBuffApplied = who.runBuffApplied || {};
        who.runBuffApplied[ab.key] = true;
        return;
      }
      who.buffs = who.buffs || { toHit: 0, dmg: 0, bonusDice: 0, acPen: 0, save: 0, ac: 0 };
      who.buffs.toHit += (ab.buff && ab.buff.toHit) || 0;
      who.buffs.dmg += (ab.buff && ab.buff.dmg) || 0;
      who.buffs.bonusDice += (ab.buff && ab.buff.bonusDice) || 0;
      who.buffs.acPen += (ab.buff && ab.buff.acPen) || 0;   // rage handled above; here magus Shield etc.
      who.buffs.ac += (ab.buff && ab.buff.ac) || 0;         // Shield / Cat's Grace: +AC (sticky)
      who.buffs.save += (ab.buff && ab.buff.save) || 0;
      if (ab.buff && ab.buff.conHp) this._grantTempHp(who, ab.buff.conHp * (who.level || 1));   // Bear's Endurance
      if (ab.dr) who.dr = Math.max(who.dr || 0, ab.dr);   // Stoneskin — DR vs physical blows
      if (ab.protectFire) who.protectFire = true;   // Protection from Fire — halves fire damage taken
      if (ab.fly) who.flying = true;                // Fly — grounded foes can't melee them
      if (ab.canHitFlyers) who.canHitFlyers = true; // Magus Fly/Overland Flight — can melee airborne foes
      if (ab.displace) who.displaced = true;        // Displacement — 50% incoming-miss (this room)
      if (ab.fireShield) who.fireShield = { die: 6, bonus: who.level || 1 };   // Fire Shield — retaliate on melee hit
      if (ab.elemBody) who.elemBody = true;         // Elemental Body — crit + CC immunity
      if (ab.trueSeeing) who.trueSeeing = true;     // True Seeing — pierce darkness/illusion/invisibility
    };
    if (ab.party) {
      for (const a of this.livingParty()) apply(a);
      // Prayer floods the WHOLE battlefield — allies up, enemies down (−1 to hit,
      // damage & saves for the room). See _monsterSwing / _enemySave.
      if (ab.enemyPenalty) for (const e of this.livingEnemies()) e.prayed = Math.max(e.prayed || 0, ab.enemyPenalty);
      const inspTag = ab.key === 'inspire' ? ` (+${inspMod} to hit & damage)` : '';
      this._note(`${ab.icon} ${m.nickname} ${ab.enemyPenalty ? `intones ${ab.name} — allies blessed, enemies cursed across the field` : `strikes up ${ab.name} — the party is emboldened`}${inspTag}!`, sound);
    }
    else if (ab.target === 'ally') { const t = this._buffTarget(m, ab, payload); apply(t); this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${t.nickname}.`, sound); }
    else { apply(m); this._note(`${ab.icon} ${m.nickname} uses ${ab.name}!`, sound); }
    this._echoToTable(sound);
  }
  // Taunt (barbarian): a roaring challenge — every enemy makes a Will save or is
  // COMPELLED to attack the barbarian on its next turn (see _enemyAct), pulling
  // fire off the rest of the party. Once per room.
  _abTaunt(m, ab) {
    const dc = 10 + Math.floor((m.level || 1) / 2) + ABILITY_MOD;   // martial intimidation DC
    const sound = ab.sounds ? pick(ab.sounds) : ab.sound;   // alternate between the taunt yells
    const parts = [];
    for (const e of this.livingEnemies()) {
      const sv = this._saveVs(this._enemySave(e, ab.save || 'will'), dc);
      if (!sv.saved) e.taunted = m.playerId;
      parts.push(`${e.name}: Will ${sv.total} vs ${dc} ${sv.saved ? 'shrugs it off' : `📢 must come for ${m.nickname}`}`);
    }
    this._note(`${ab.icon} ${m.nickname} bellows a furious challenge — ${parts.join('; ')}.`, sound);
    this._echoToTable(sound);
  }
  // Smite Evil — your strikes smite evil foes this room.
  _abSmite(m, ab) {
    m.smiteActive = true;
    const sound = ab.sound || pick(SND.flesh);
    this._note(`${ab.icon} ${m.nickname} calls a Smite — righteous fury against evil this room!`, sound);
    this._echoToTable(sound);
  }
  // Detect Evil (paladin): a standard action that MARKS every living foe as evil
  // (sets markedEvil), so Smite Evil applies to ALL of them this room — including
  // the true-neutral ones (animals, constructs). Plays the "into the light" cue.
  _abDetectEvil(m, ab) {
    const foes = this.livingEnemies();
    let n = 0;
    for (const e of foes) { if (!e.markedEvil) { e.markedEvil = true; n++; } }
    const sound = ab.sound || '/audio/into_the_light.mp3';
    this._note(`${ab.icon || '🎯'} ${m.nickname} calls DETECT EVIL — the room floods with revealing light; ${n || foes.length} foe(s) MARKED for Smite!`, sound);
    this._echoToTable(sound);
  }
  // Trip: an ATTACK ROLL (no damage). On a hit the foe is knocked prone, LOSES
  // its turn, and you get an immediate free attack (prone = +4 for all to hit).
  // PF1 trip restrictions for a (Medium) hero tripping `e`. Returns a reason string
  // when the trip is IMPOSSIBLE, else null. Separately, _tripDefBonus is the foe's
  // extra trip defense: +4 per leg beyond two (a quadruped wolf is harder to sweep;
  // an 8-legged spider nearly impossible) + the PF1 special size modifier (+1 Large,
  // +2 Huge) for foes bigger than the tripper.
  _tripBlocked(e) {
    if (e.noTrip || (e.legs != null && e.legs === 0)) return `${e.name} has no legs to sweep`;
    if (e.flying) return `${e.name} is airborne, immune to prone`;
    if ((SIZE_RANK[e.size] || 0) > 1) return `${e.name} is ${SIZE_NAME[e.size] || 'too large'} — more than one size bigger than you`;   // PF1: can trip up to ONE size larger
    return null;
  }
  _tripDefBonus(e) {
    const legs = (e.legs != null ? e.legs : 2);
    return Math.max(0, (legs - 2)) * 4 + Math.max(0, SIZE_RANK[e.size] || 0);
  }
  _abTrip(m, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    const blocked = this._tripBlocked(e);
    if (blocked) { this._note(`${m.nickname} can't trip ${e.name} — ${blocked}.`); return this._echoToTable(); }
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const tripDef = this._tripDefBonus(e);
    const a = this._attackRoll(m, e, tripDef);   // extra legs + size raise the bar (PF1 CMD vs trip)
    const defTag = tripDef > 0 ? ` (+${tripDef} ${e.legs > 2 ? `${e.legs}-legged ` : ''}${(SIZE_RANK[e.size] || 0) > 0 ? SIZE_NAME[e.size] + ' ' : ''}stability)` : '';
    if (!a.hit) { this._note(`🦵 ${m.nickname} tries to trip ${e.name} but it keeps its footing${defTag}. [d20 ${a.roll} ${this._fmtBonus(a.toHit)} = ${a.total} vs ${this._enemyAC(e) + tripDef}]`, a.weapon.isDagger ? SND.whiffDagger : pick(SND.whiffSword)); return this._echoToTable(); }
    e.prone = true; e.loseTurn = true;
    this._note(`🦵 ${m.nickname} TRIPS ${e.name} prone${defTag} — it loses its turn! Free attack!`);
    const r = this._swingVsAC(m, this._enemyAC(e), e);   // prone (−4 AC) folded into _enemyAC
    if (r.hit) { this._dmgE(e, r.damage); this._note(`⚔️ free hit on ${e.name} for ${r.damage}.${this._afterEnemyHit(e)}`, r.sound); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    else this._note(`⚔️ the free hit misses. ${this._atkStr(r)}`, r.sound);
    this._echoToTable(r.sound);
  }
  // Disarm (swashbuckler): an opposed maneuver (the duelist's combat roll vs the
  // foe's CMD). On a success the foe loses its next turn scrambling for its weapon
  // and the swashbuckler lands a free strike.
  _abDisarm(m, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const cmb = dRoll(20) + babFor(m.cls || 'swashbuckler', m.level || 1) + ABILITY_MOD + ((m.buffs && m.buffs.toHit) || 0) + this._hasteMod(m);
    const cmd = 10 + (e.toHit || 0);   // rough CMD from the foe's offense (scales with CR via toHit)
    if (cmb < cmd) { this._note(`🌀 ${m.nickname} lunges to disarm ${e.name}, but it keeps its grip. [${cmb} vs CMD ${cmd}]`, pick(SND.whiffSword)); return this._echoToTable(); }
    e.loseTurn = true;
    this._note(`🌀 ${m.nickname} DISARMS ${e.name}! [${cmb} vs CMD ${cmd}] — it scrambles for its weapon (loses its next turn) — free strike!`);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    if (r.hit) { this._dmgE(e, r.damage); this._note(`🗡️ ${m.nickname} skewers the off-balance ${e.name} for ${r.damage}.${this._afterEnemyHit(e)}`, r.sound); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    else this._note(`🗡️ the follow-up misses ${e.name}. ${this._atkStr(r)}`, r.sound);
    this._echoToTable(r.sound);
  }
  // Spiritual Weapon (cleric): conjure a force-blade over a chosen foe. It strikes
  // that foe on EACH of the cleric's turns — see _spiritWeaponStrike, fired from
  // _advanceToActor — so the cleric can do other things while it fights on. Lasts
  // 1 round per ½ caster level, and it swings the moment it's summoned.
  _abSpiritWeapon(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    const rounds = Math.max(1, Math.floor((m.level || 1) / 2));   // 1 round per 2 caster levels
    m.spiritWeapon = { targetUid: e.uid, rounds };
    this._note(`🗡️✨ ${m.nickname} conjures a SPIRITUAL WEAPON over ${e.name} — it will strike on every turn for ${rounds} rounds!`, ab.sound || '/audio/spell_holy_smite.mp3');
    this._echoToTable(ab.sound || '/audio/spell_holy_smite.mp3');
    this._spiritWeaponStrike(m);   // it lashes out the instant it appears
  }
  // One round of the spiritual weapon's attacks. It uses the cleric's weapon and
  // ALL their combat math (buffs, feats, Prayer/Bless/Divine Favor) via _swingVsAC,
  // and gets an extra swing while the cleric is Hasted. Re-targets if its foe dies,
  // so the blade keeps fighting until its duration runs out.
  _spiritWeaponStrike(m) {
    const sw = m.spiritWeapon; if (!sw) return;
    sw.rounds -= 1;
    let e = this.enemies.find(x => x.uid === sw.targetUid && x.hp > 0);
    if (!e) { e = this.livingEnemies().slice().sort((a, b) => a.hp - b.hp)[0]; if (e) sw.targetUid = e.uid; }
    if (e) {
      m.weapon = weaponOf(m.gear, m.weaponKey);
      const swings = 1 + (m.hasted > 0 ? 1 : 0);   // benefits from Haste — an extra strike
      const snd = '/audio/spell_holy_smite.mp3';    // its own ringing note
      const parts = [];
      for (let i = 0; i < swings && e.hp > 0; i++) {
        const r = this._swingVsAC(m, this._enemyAC(e), e);
        if (r.hit) { this._dmgE(e, r.damage); parts.push(`${r.crit ? 'CRIT ' : ''}${r.damage}`); }
        else parts.push('miss');
      }
      this._note(`🗡️✨ ${m.nickname}'s Spiritual Weapon strikes ${e.name} — ${parts.join(', ')}.${this._afterEnemyHit(e)} (${sw.rounds} rd left)`, snd);
      this._echoToTable(snd);
      if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    }
    if (sw.rounds <= 0) { m.spiritWeapon = null; this._note(`🗡️✨ ${m.nickname}'s Spiritual Weapon dissolves into motes of light.`); }
    this._broadcast();
  }
  // Cleave: hit the target; then swing at a second foe (−2). A barbarian's
  // cleave (ab.acPen) also drops their guard −2 AC until their next turn.
  _abCleave(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    this._cleaveSweep(m, e, { followThrough: true, acPen: ab && ab.acPen });
  }
  // A random living foe not already struck this sweep (chain cleaves jump around).
  _randomLivingFoe(exclude) {
    const pool = this.livingEnemies().filter(x => !exclude.has(x.uid));
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }
  // Play ONE report for the whole cleave sweep — a chain shouldn't machine-gun a
  // sound per swing (too noisy). The notes carry no log sound, so this is the
  // single sound the dungeon (clear) and the table (muffled echo) hear.
  _emitChainSfx(sounds) {
    const snd = sounds.find(Boolean);
    if (!snd || !this.io) return;
    try {
      this.io.to(this.roomName()).emit('dungeon:sfx', { sound: snd });
      this.io.to(`table:${this.tableId}`).emit('dungeon:echo', { sound: snd });
    } catch (_) {}
  }
  // Cleave / Great Cleave sweep — shared by the Cleave ability AND any barbarian
  // attack. Swings at firstTarget (the player-chosen foe); with `followThrough`
  // the Cleave ability always gets one extra swing after a connecting hit; ANY
  // swing that DROPS a foe chains onto a RANDOM fresh enemy, continuing while it
  // keeps felling them. Each swing's attack sound is queued (staggered) so the
  // chain is audible; the notes themselves carry no sound to avoid a double-play.
  _cleaveSweep(m, firstTarget, opts = {}) {
    const forced = this._forcedFoe(m);   // taunted → the FIRST cleave is dragged onto the taunter (chains stay random)
    if (forced) firstTarget = forced;
    m.flatFooted = false; m.invisible = false;
    if (opts.acPen) { m.acPenRound = this.round; m.acPenAmt = opts.acPen; }
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const baseSound = m.weapon.atkSound || (m.weapon.dtype === 'B' ? '/audio/weapon_blunt.mp3' : null);
    const struck = new Set();
    const sounds = [];
    let target = firstTarget, bonus = false, kills = 0;
    const MAX = 24;   // safety cap so a freak run can't loop forever
    for (let swings = 0; target && swings < MAX; swings++) {
      struck.add(target.uid);
      const r = this._swingVsAC(m, this._enemyAC(target) + (bonus ? 2 : 0), target);
      sounds.push(baseSound || r.sound || null);
      let downed = false;
      if (r.fumble) {
        this._note(`🪓 ${m.nickname}${bonus ? '’s follow-through' : ''} fumbles at ${target.name}! ${this._atkStr(r)}`, null);
      } else if (r.hit) {
        this._dmgE(target, r.damage); downed = target.hp <= 0;
        this._note(`🪓 ${m.nickname} ${bonus ? '…cleaves on into' : 'cleaves'} ${target.name} for ${r.damage}.${this._afterEnemyHit(target)}`, null);
        if (downed) { kills++; this._tryBanter(m, 'down', { enemy: target.name }); }
      } else {
        this._note(`🪓 ${m.nickname}'s ${bonus ? 'follow-through' : 'swing'} misses ${target.name}. ${this._atkStr(r)}`, null);
      }
      // Continue if this swing FELLED a foe (Great Cleave chain), or — once — to
      // grant the Cleave ability's standard follow-through after a connecting hit.
      const keepGoing = downed || (opts.followThrough && r.hit && !bonus);
      bonus = true;
      if (!keepGoing) break;
      target = this._randomLivingFoe(struck);   // 2nd + chain targets are RANDOM
    }
    if (kills >= 3) this._note(`🪓 ${m.nickname} carves clean through the line — ${kills} foes felled in one furious sweep!`);
    this._emitChainSfx(sounds);
  }
  // Feint: an opposed roll. On success the foe is flat-footed → a free
  // Sneak-Attack strike (the rogue's Sneak Attack rides on the denied defense).
  _abFeint(m, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    const bluff = dRoll(20) + (m.level || 1) + ABILITY_MOD;
    const sense = dRoll(20) + (e.toHit || 0);
    if (bluff < sense) { this._note(`🎭 ${m.nickname} feints ${e.name}, but it doesn't bite. [${bluff} vs ${sense}]`, pick(SND.whiffSword)); return this._echoToTable(); }
    e.flatFooted = true;
    this._note(`🎭 ${m.nickname} feints ${e.name} flat-footed! [${bluff} vs ${sense}] — free strike!`);
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    const tag = r.sneakDice ? ` 🗡️Sneak +${r.sneakDmg}(${r.sneakDice}d6)` : '';
    if (r.hit) { this._dmgE(e, r.damage); this._note(`🗡️ ${m.nickname} strikes ${e.name} for ${r.damage}.${tag}${this._afterEnemyHit(e)}`, r.sound); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    else this._note(`🗡️ the strike misses ${e.name}. ${this._atkStr(r)}`, r.sound);
    this._echoToTable(r.sound);
  }
  // Reckless Blow: +4 damage this swing, but −4 AC until your next turn.
  _abReckless(m, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.acPenRound = this.round; m.acPenAmt = 4;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    if (r.hit) { const dmg = r.damage + 4; this._dmgE(e, dmg); this._note(`💥 ${m.nickname} swings recklessly at ${e.name} for ${dmg}! (guard dropped)${this._afterEnemyHit(e)}`, r.sound); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    else this._note(`💥 ${m.nickname}'s reckless swing misses ${e.name}. ${this._atkStr(r)}`, r.sound);
    this._echoToTable(r.sound);
  }

  // One ranged shot at a to-hit modifier (rangers). The WEAPON's signature report
  // wins (so a rifle cracks like a rifle — e.g. Duristan's bolt-action Lapua);
  // the ability's generic bow sound is only the fallback for a plain bow.
  _bowShot(m, ab, payload, hitMod, label) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e, { touch: m.weapon.group === 'firearms' }), e, hitMod);   // firearms hit vs touch AC
    if (m.weapon.atkSound) r.sound = m.weapon.atkSound; else if (ab.sound) r.sound = ab.sound;
    if (r.hit) { this._dmgE(e, r.damage); this._note(`${ab.icon} ${m.nickname}${label} ${r.crit ? 'CRITS' : 'hits'} ${e.name} for ${r.damage}. ${this._atkStr(r)}${this._afterEnemyHit(e)}`, r.sound); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    else this._note(`${ab.icon} ${m.nickname}${label} misses ${e.name}. ${this._atkStr(r)}`, r.sound);
    this._echoToTable(r.sound);
  }
  // Rapid Shot: two arrows this turn, each at −2.
  _abRapidShot(m, ab, payload) {
    // A bolt-action sniper rifle can't fire twice — fall back to a single shot.
    if (weaponOf(m.gear, m.weaponKey).boltAction) { this._bowShot(m, ab, payload, 0, ''); return; }
    this._bowShot(m, ab, payload, -2, ' (rapid 1)');
    this._bowShot(m, ab, payload, -2, ' (rapid 2)');
  }
  // Bullseye Shot: one carefully-aimed arrow at +4.
  _abBullseye(m, ab, payload) {
    this._bowShot(m, ab, payload, 4, ' takes aim and');
  }

  // At-will attack. Rogues with daggers strike TWICE (two-weapon style); a rogue
  // with any other weapon strikes once. Sneak Attack applies via _swingVsAC.
  // Per-swing to-hit OFFSETS for a hero's basic attack. A standard attack on a
  // NEW target is a single swing (a dual-wielder still gets their off-hand). On a
  // FULL attack — staying on the SAME target as last turn — every martial adds PF1
  // iteratives (−5/−10/−15 as BAB reaches 6/11/16), and a dual-wielder adds their
  // Two-Weapon Fighting / Improved Two-Weapon Fighting off-hand swing. The TWF
  // penalty (−6, or −2 with the Two-Weapon Fighting feat) rides on every swing.
  _attackOffsets(m, e) {
    const bab = babFor(m.cls || 'fighter', m.level || 1);
    const ff = fighterFeats(m.cls, m.level, this._isRanged(m));
    // Natural multi-attackers (Crisp the deinonychus: bite + 2 talons) make their
    // FULL natural routine every turn — Pounce-style, even on a fresh target — all
    // at full BAB. No iteratives/TWF on top.
    if (m.weapon && m.weapon.naturalAttacks > 1) return Array(m.weapon.naturalAttacks).fill(0).map(off => ({ off, oh: false }));
    const dual = this._isDualWielding(m);
    // RANGED attackers (bows, crossbows, guns) can ALWAYS full-attack — they don't
    // move to reach a foe. MELEE only get their iteratives when they stay on the SAME
    // target as last turn (a proxy for not having to charge/move to a new one).
    const isRanged = !!(m.weapon && m.weapon.ranged);
    const fullAttack = isRanged || (m._lastAtkTarget === e.uid);
    // RAPID SHOT (feat, ranged ladder g3): one extra shot on a full attack, at −2 to
    // ALL shots this turn (PF1). Bolt-action rifles can't cycle that fast. Manyshot
    // (g12, BOWS only) nocks a 2nd arrow on the first shot — an extra arrow at FULL BAB.
    const rapidOn = isRanged && fullAttack && ff.rapidShot && !(m.weapon && m.weapon.boltAction);
    const twfPen = (dual ? (ff.twf ? -2 : -6) : 0) + (rapidOn ? -2 : 0);
    // Each swing carries `oh` (off-hand) → ½ ability mod to damage (PF1). Only the
    // SECOND weapon's swings are off-hand; main-hand iteratives and ranged extras
    // are full-mod.
    const off = [{ off: twfPen, oh: false }];                  // primary / main-hand swing
    if (dual) off.push({ off: twfPen, oh: true });             // base off-hand swing (the 2nd weapon)
    if (rapidOn) off.push({ off: twfPen, oh: false });         // Rapid Shot's extra shot (full BAB, −2 like the rest)
    if (isRanged && fullAttack && ff.manyshot && m.weapon && m.weapon.group === 'bows') off.push({ off: twfPen, oh: false });   // Manyshot's 2nd arrow
    if (fullAttack) {
      if (bab >= 6)  off.push({ off: twfPen - 5,  oh: false });   // main-hand iterative
      if (bab >= 11) off.push({ off: twfPen - 10, oh: false });
      if (bab >= 16) off.push({ off: twfPen - 15, oh: false });
      if (dual && ff.itwf && bab >= 6) off.push({ off: twfPen - 5, oh: true });   // Improved Two-Weapon Fighting (2nd off-hand swing)
    }
    return off;
  }
  _playerAttack(m, targetUid, quiet = false) {
    m.flatFooted = false;   // acting ends flat-footed
    if (!quiet) m._offDef = false;   // Offensive Defense lasts until the rogue next acts
    if (!m.greaterInvis) m.invisible = false;    // attacking breaks Invisibility (Greater persists)
    const e = this.enemies.find(x => x.uid === targetUid && x.hp > 0) || this.livingEnemies()[0];
    if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    if (e.darkened > 0) { this._note(`🌑 ${m.nickname} can't find ${e.name} in the magical darkness!`); this._broadcast(); return; }
    // Melee can't reach a flyer. Rather than waste the turn, a melee character draws a
    // BACKUP light crossbow and shoots — masterwork (no enchant), so worse than their
    // real weapon, but it reaches, and it still rides their full iteratives and buffs
    // (Divine Favor, Bless, Haste…). A flyer-reaching hero (Overland Flight magus) just
    // melees as normal. The bot only targets a flyer when EVERY foe is airborne, so for
    // bots this fires strictly as a last resort.
    const _realWeapon = m.weapon;
    if (e.flying && !m.weapon.ranged && !m.weapon.reachFly && !(m.canHitFlyers && m.flying)) {
      m.weapon = weaponOf({}, 'lightcrossbow');
      if (!quiet) this._note(`🏹 ${m.nickname} can't reach the airborne ${e.name} in melee — draws a light crossbow!`);
    }
    // Build the swing sequence as a list of to-hit OFFSETS (see _attackOffsets):
    // dual-wielders attack twice; staying on the same target adds PF1 iteratives.
    // A Haste bonus swing (quiet) is always a single strike at full to-hit.
    const offsets = quiet ? [{ off: 0, oh: false }] : this._attackOffsets(m, e);
    if (!quiet) m._lastAtkTarget = e.uid;   // remember the target → next turn's full-attack check
    const swings = offsets.length;
    // Sound: signature atkSound > a blunt "bap" for B-type weapons (quarterstaff,
    // warhammer…) > the swing's own hit/whiff. Plays ONCE for the whole flurry.
    let baseSound = m.weapon.atkSound || (m.weapon.dtype === 'B' ? '/audio/weapon_blunt.mp3' : null);
    if (m.smiteActive && m.weaponKey === 'warhammer') baseSound = '/audio/weapon_warhammer_smite.mp3';   // holy hammer-ring on a smite
    for (let i = 0; i < swings; i++) {
      // Resolve swings ONE AT A TIME: if the target has dropped, the next swing
      // redirects to another foe (PF1 — you don't pre-commit a full attack).
      const tgt = (e.hp > 0) ? e : this._targetableEnemies()[0];
      if (!tgt) break;
      const r = this._swingVsAC(m, this._enemyAC(tgt, { touch: m.weapon.group === 'firearms' }), tgt, offsets[i].off, offsets[i].oh);   // firearms hit vs touch AC; offset = iterative/TWF penalty; oh = off-hand (½ mod)
      if (i > 0 || quiet) r.sound = null;            // one report for the whole flurry; haste swing silent
      else if (baseSound) r.sound = baseSound;       // signature / blunt report on the first swing
      // Rogue Sneak Attack with a light blade (dagger/kukri/shortsword) → Riki.
      if (r.sneakDice && m.cls === 'rogue' && ['dagger', 'kukri', 'shortsword'].includes(m.weaponKey) && i === 0) r.sound = '/audio/sneak_riki.mp3';
      const tag = (r.smite ? ' ⚔️Smite!' : '') + (r.sneakDice ? ` 🗡️Sneak +${r.sneakDmg}(${r.sneakDice}d6)` : '');
      const lead = swings > 1 ? `${m.nickname} (hit ${i + 1})` : m.nickname;
      if (r.fumble) this._note(`${lead} fumbles the attack! ${this._atkStr(r)}`, r.sound);
      else if (r.hit) { this._dmgE(tgt, r.damage); this._note(`${lead} ${r.crit ? 'CRITS' : 'hits'} ${tgt.name} for ${r.damage}${r.drTag || ''}.${tag} ${this._atkStr(r)}${tgt.hp <= 0 ? ' ☠️ Slain!' : ` (${Math.max(0, tgt.hp)}/${tgt.maxHp})`}`, r.sound);
        // Rogue Offensive Defense (feat tree n8): landing a sneak attack grants +2 AC
        // until they next act — the strike leaves the foe off-balance.
        if (r.sneakDice && fighterFeats(m.cls, m.level, this._isRanged(m)).offDef && !m._offDef) { m._offDef = true; this._note(`🤸 ${m.nickname}'s strike leaves them covered — +2 AC until their next move (Offensive Defense).`); }
        // Promethean tentacles GRAB on a hit — the foe is grappled & helpless until it breaks free.
        if (m.weapon.grapple && tgt.hp > 0 && !tgt.grappled) { tgt.grappled = true; tgt.grappledBy = m.playerId; tgt.grappleRounds = 2; this._note(`🐙 ${tgt.name} is SEIZED in ${m.nickname}'s tentacles — grappled and helpless!`); }
      }
      else this._note(`${lead} misses ${tgt.name}. ${this._atkStr(r)}`, r.sound);
      if (r.hit && tgt.hp <= 0) this._tryBanter(m, 'down', { enemy: tgt.name });
      this._echoToTable(r.sound);
    }
    m.weapon = _realWeapon;   // drop any backup crossbow — restore the real weapon for later reads (e.g. next turn's target pick)
  }
  // ── Loot (per owner) ──────────────────────────────────────────────────────
  equipLoot(playerId, idx) {
    const loot = this.pendingLoot[idx];
    if (!loot || loot.owner !== playerId) return { ok: false, error: 'not your loot' };
    const m = this.member(playerId); if (!m) return { ok: false, error: 'gone' };
    const gear = db.getGear(playerId);
    const oldTier = Number(gear[loot.slot]) || 0;
    const lbl0 = db.GEAR_BY_KEY[loot.slot]?.label || loot.slot;
    // Already have an equal/better one → HOCK the won item into the pool rather than
    // silently discarding it (which used to lose the loot — see Josh's report).
    if (oldTier >= loot.tier) {
      const v = db.gearHockValue(loot.slot, loot.tier); this.runGold += v;
      this.pendingLoot.splice(idx, 1);
      this._note(`💰 ${m.nickname} already has a better ${lbl0} — hocks the +${loot.tier} for ${v} gp into the pool.`);
      return { ok: true, hocked: true };
    }
    gear[loot.slot] = loot.tier;
    db.setGear(playerId, gear);
    m.gear = gear;
    // (gear no longer changes level — level is from XP; gear only adds to-hit/AC/dmg)
    this.pendingLoot.splice(idx, 1);
    const lbl = db.GEAR_BY_KEY[loot.slot]?.label || loot.slot;
    // Auto-hock the item this one replaces — its value goes into the run pool.
    let extra = '';
    if (oldTier >= 1) { const v = db.gearHockValue(loot.slot, oldTier); this.runGold += v; extra = ` Old +${oldTier} ${lbl} auto-hocked for ${v} gp into the pool.`; }
    this._note(`🛡️ ${m.nickname} equipped the +${loot.tier} ${lbl}.${extra} (Lv ${m.level})`);
    return { ok: true };
  }
  hockLoot(playerId, idx) {
    const loot = this.pendingLoot[idx];
    if (!loot || loot.owner !== playerId) return { ok: false, error: 'not your loot' };
    const v = db.gearHockValue(loot.slot, loot.tier);
    this.runGold += v;
    this.pendingLoot.splice(idx, 1);
    this._note(`💰 ${this.member(playerId)?.nickname || playerId} hocked a +${loot.tier} ${db.GEAR_BY_KEY[loot.slot]?.label || loot.slot} for ${v} gp (into the pool).`);
    return { ok: true };
  }

  // ── Exits ─────────────────────────────────────────────────────────────────
  // One member climbs out with an even share of the current pool.
  bail(playerId) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };
    const wasActor = this._currentActorId() === playerId;
    const fled = this.status === 'combat';   // bailing mid-fight = running away
    const denom = Math.max(1, this.party.filter(x => !x.left && !x.dead).length);   // split among everyone in the run, incl. the dying
    // A SLAIN hero (dead, not merely downed) forfeits their cut — they get no
    // gold when carried out. The living/dying split the pool among themselves.
    const share = m.dead ? 0 : Math.floor(this.runGold / denom);
    if (share > 0) {
      this.runGold -= share;
      const p = db.getPlayer(playerId);
      if (p) db.setChips(playerId, p.chips + share);
    }
    m.left = true;   // turn loop skips left members; entry stays for index integrity
    const how = m.dead ? 'is carried out, slain — no share of the gold'
              : m.downed ? `is dragged out of the dungeon with ${share} gp`
              : fled ? `flees the fight and climbs out with ${share} gp`
              : `climbed out with ${share} gp`;
    this._note(`${m.dead ? '☠️' : m.downed ? '🩸' : fled ? '🏃' : '🪜'} ${m.nickname} ${how}.`);
    this._log('bail', { who: playerId, share, poolLeft: this.runGold, fled, downed: !!m.downed });
    if (m.dead) this._applyDeathPenalty(m);   // a slain hero leaving the run locks in the level loss
    this._emitMemberExit(m, { reason: 'bailed', goldBanked: share, fled });
    // Last conscious member out → drag any remaining dying allies out with their
    // share (voluntary retreat). Otherwise, if only AI remain, cash them out.
    if (!this._anyUp()) { this._groupExtract(); return { ok: true, goldBanked: share }; }
    // Last human out (left OR went to spectator): if we're BETWEEN rooms, the AI
    // cash out now (nothing to finish). If a fight is in progress, let the AI
    // FINISH the current room — _clearRoom wraps them up on the clear.
    if (!this._humansInRun()) {
      if (this.status !== 'combat') { this._wrapUp(); return { ok: true, goldBanked: share }; }
      if (wasActor) { clearTimeout(this._turnTimer); this._nextTurn(); } else this._broadcast();   // keep the bots fighting
      return { ok: true, goldBanked: share };
    }
    // Only nudge the turn cycle if the bailer was the one we were waiting on.
    if (this.status === 'combat' && wasActor) { clearTimeout(this._turnTimer); this._nextTurn(); }
    else this._broadcast();
    return { ok: true, goldBanked: share };
  }
  // A human delver dismisses an AI ally from the party (the dungeon's answer to
  // the poker table's "× kick"). Routes through bail() so turn order, the gold
  // split, and group-extract edge cases are all handled. Only human sockets call
  // this; any member in the run may dismiss an AI ally.
  kickBot(requesterId, botId) {
    const r = this.member(requesterId);
    if (!r || r.left) return { ok: false, error: 'not in this run' };
    const b = this.member(botId);
    if (!b || b.left) return { ok: false, error: 'not in the party' };
    if (!b.isBot) return { ok: false, error: 'you can only dismiss AI allies' };
    if (b.playerId === requesterId) return { ok: false, error: 'cannot dismiss yourself' };
    this._note(`👋 ${r.nickname} dismissed ${b.nickname} from the party.`);
    return this.bail(botId);
  }
  /** Hard-cancel the ENTIRE run — the "Cancel Dungeon" escape hatch for a stuck
   *  or broken run. Bails out every remaining member (each banks their split
   *  share and is surfaced back to the table via dungeon:exit), then ends the
   *  run. NOT a wipe: no gear is lost — this is a clean group retreat. */
  cancelRun() {
    if (this.status === 'over') return { ok: true };
    this._note('🛑 The run was cancelled — the party retreats upstairs.');
    this._runFailed = false;   // a cancel is a clean retreat, never a gear-loss wipe
    // Snapshot ids first: bail() mutates party entries and may end the run.
    for (const id of this.present().map(m => m.playerId)) {
      const m = this.member(id);
      if (m && !m.left) { try { this.bail(id); } catch (_) {} }
    }
    if (this.status !== 'over') { try { this._runOver(); } catch (_) {} }
    return { ok: true };
  }
  // Tell THIS player's client to surface back to the table; notify the table.
  _emitMemberExit(m, exit) {
    // Abadar's interest: ONE dungeon RUN = ONE tick of the compound-interest
    // clock for a human delver (the same as one poker hand) — NOT per room or
    // per combat turn. Guarded so the various exit paths tick at most once.
    if (!m.isBot && !m._debtTicked) {
      m._debtTicked = true;
      try {
        const intr = db.tickDebtTurn(m.playerId);
        if (intr) this._note(`🏛️ Abadar's interest — ${m.nickname}'s tab compounds ${intr.before.toLocaleString()} → ${intr.after.toLocaleString()} gp (+${intr.interest.toLocaleString()}).`);
      } catch (_) {}
    }
    if (this.io) this.io.to(this.roomName()).emit('dungeon:exit', { playerId: m.playerId, ...exit });
    if (this._onMemberExit) try { this._onMemberExit(m.playerId, m.nickname, exit); } catch (_) {}
  }
  destroy() { clearTimeout(this._turnTimer); clearTimeout(this._stepTimer); clearTimeout(this._lootTimer); }
}

module.exports = { Dungeon, MON, BOSS_KEYS };
