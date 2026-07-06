/**
 * pf1data/feats.js — the PF1 FEAT system (concept split, 2026-07-04).
 * PF1CORE: pure rules — no app imports, shared by the poker dungeon and the
 * future PGM app. Exports:
 *   fighterFeats(cls, level, ranged) → the class's folded feat-tree bonuses
 *     ({hit,dmg,ac,hp,save,init, spellDC/spellPen, metamagic flags, …});
 *   gatingLevel(cls, L) → how many bonus feats a class has earned by L;
 *   the *_FEAT_AT display tables (feat NAMES per gate — level-up announce +
 *     the class-progression reference) + CLASS_FEAT_AT / RANGED_FEAT_CLASSES.
 * Design note: feats fold into unified numbers (no per-weapon-group or
 * per-save granularity) — see the FF_NONE shape.
 */

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
  if (n >= 8) f.spellDC = 4;             // Greater Spell Focus — +2 more (→ +4 DC total)
  // METAMAGIC — pulled onto an EARLIER, PF1-appropriate track (2026-07-01). A real
  // sorcerer's bloodline bonus feats + feat picks give a blaster the full metamagic
  // suite well before the old L11/13/17/19 pacing. These are keyed on character LEVEL
  // (not the odd-level feat counter) so a mid-high caster like L17 Olbryn has ALL FOUR.
  if (L >= 5)  f.intensify = true;       // Intensified Spell — raise the damage cap
  if (L >= 9)  f.empower = true;         // Empower Spell — ×1.5 spell damage
  if (L >= 13) f.maximize = true;        // Maximize Spell — max damage dice
  if (L >= 15) f.quicken = true;         // Quicken Spell — a 2nd (swift) cast each turn
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
  if (n >= 10) f.save = 3;              // Great Fortitude
  // METAMAGIC — same LEVEL-keyed track as casterFeats (2026-07-02 audit): the
  // oracle is a spontaneous blaster (Elfrip, Flame mystery) and toggles these
  // like a sorcerer. The old lone quicken@n9 was flagged "wiring later" — wired.
  if (L >= 5)  f.intensify = true;      // Intensified Spell
  if (L >= 9)  f.empower = true;        // Empower Spell
  if (L >= 13) f.maximize = true;       // Maximize Spell
  if (L >= 15) f.quicken = true;        // Quicken Spell
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
  if (cls === 'magus') {
    const mf = magusFeats(L);
    if (!ranged) return mf;
    // A BOW magus (Reese — an Eldritch Archer who "always shoots") keeps his magus
    // METAMAGIC core (Intensify/Empower/Maximize drive his Imbued Shots) but ALSO
    // climbs the ranger ARCHERY ladder: Point Blank Shot, Rapid Shot, Bullseye,
    // Manyshot. Ranger-style gating (half level, rounded up).
    const rf = rangedFeats(Math.floor((L + 1) / 2), L);
    return { ...mf, pbs: rf.pbs, rapidShot: rf.rapidShot, bullseye: rf.bullseye, manyshot: rf.manyshot };
  }
  if (cls === 'cleric')       return clericFeats(L);
  if (cls === 'oracle')       return oracleFeats(L);
  if (cls === 'bard')         return bardFeats(L);
  if (cls === 'swashbuckler') return swashFeats(L);
  const ladder = ranged ? rangedFeats : featLadder;
  if (cls === 'fighter')    return ladder(L, L);
  if (cls === 'inquisitor' || cls === 'barbarian' || cls === 'ranger') return ladder(Math.floor((L + 1) / 2), L);
  return FF_NONE;
}
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
// SELECTIVE CHANNELING (Tobias 2026-07-03): every channel-capable class takes it
// EARLY — the feat slot pays for channels (offensive AND healing, positive AND
// negative) affecting ONLY whom the channeler intends. This is why hero sears
// never singe undead comrades, party heals never mend foes, Channel Negative
// mends the undead without draining the living, and the undead court's priests
// can burst-mend their dead without searing their living allies.
const CLERIC_FEAT_AT = {
  1: 'Toughness (+HP)', 2: 'Selective Channeling (channels touch only whom you intend) & Weapon Focus (+1 to hit)', 3: 'Combat Casting', 4: 'Spell Focus (+2 spell DC)',
  5: 'Improved Initiative', 6: 'Heavy Armor Mastery (+1 AC)', 7: 'Greater Spell Focus (+4 spell DC total)',
  8: 'Quicken Channel (1st channel is swift)', 9: 'Iron Will (+2 saves)', 10: 'Improved Critical',
};
const ORACLE_FEAT_AT = {
  1: 'Toughness (+HP)', 2: 'Selective Channeling (channels touch only whom you intend) & Combat Casting', 3: 'Spell Focus (+2 spell DC)', 4: 'Improved Initiative',
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

module.exports = {
  FF_NONE, fighterFeats, gatingLevel, ODD_FEAT_CLASSES,
  FEAT_AT, PALADIN_FEAT_AT, DRUID_FEAT_AT, CASTER_FEAT_AT, RANGED_FEAT_AT,
  ROGUE_FEAT_AT, MONK_FEAT_AT, MAGUS_FEAT_AT, CLERIC_FEAT_AT, ORACLE_FEAT_AT,
  BARD_FEAT_AT, SWASH_FEAT_AT, GUNSLINGER_FEAT_AT,
  CLASS_FEAT_AT, RANGED_FEAT_CLASSES,
};
