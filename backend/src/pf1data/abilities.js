/**
 * Per-class dungeon ABILITY KITS — our lightweight PF1 "spellbook".
 *
 * Every class has ONE at-will attack (a weapon swing, or a cantrip for full
 * casters) plus a list of special abilities. Three cost models:
 *
 *   cost: 'free'  → MARTIAL maneuvers (fighter trip/cleave, rogue feint, bard
 *                   performances). Usable whenever it's your turn; no hard cap.
 *   cost: 'room'  → an ability with its OWN per-room use count (paladin smite,
 *                   channels, and every WIZARD spell). Refreshes each room. A
 *                   wizard is a PREPARED caster: ONE casting of each spell he
 *                   knows per room (uses:1), so his volume grows as he unlocks
 *                   more spells with level.
 *   cost: 'pool'  → a SPELL drawn from the class's shared per-room spell pool
 *                   (SORCERER / CLERIC). Each cast spends one slot; the pool
 *                   refreshes each room and grows with level. A SORCERER is a
 *                   spontaneous caster: he knows FEW spells but has limited
 *                   casts/day — and we treat one room as one day, so the pool IS
 *                   his casts-per-room, freely split across his known spells.
 *                   Spells may be level-gated via `minLevel`.
 *
 * Effects are interpreted by Dungeon._useAbility(). Only the CORE classes are
 * wired; others keep stats/proficiency but are hidden from the dropdown.
 */

// Shared per-room cast pool = a PF1 sorcerer's 1st-level spell slots/day
// (3/4/5/6, capped 6) PLUS 1 bonus slot for an 18 casting stat. So L1:4 L2:5
// L3:6 L4+:7. (We treat one adventuring "day" as one room.)
function spellSlots(level) { return Math.min(6, 2 + Math.max(1, level)) + 1; }
// Per-room count for a self-counted ability (paladin channel etc.).
function channelUses(level) { return Math.max(1, Math.floor(Math.max(1, level) / 2)); }   // L2:1 L4:2 …
function smiteUses(level)   { return Math.max(1, Math.floor(Math.max(1, level) / 5)); }    // 1 per 5 levels (min 1)

// SPONTANEOUS casters (sorcerer, bard, oracle) get SPELL SLOTS PER SPELL LEVEL,
// following the PF1 sorcerer spells/day table (no ability-bonus slots). A spell
// of level N spends a slot of level N. (We treat one adventuring "day" as one
// room — slots refresh each room.)
const SPONTANEOUS_CLASSES = new Set(['sorcerer', 'bard', 'oracle', 'inquisitor']);
const SORC_SLOTS_BY_LEVEL = {
  1: [3], 2: [4], 3: [5], 4: [6, 3], 5: [6, 4], 6: [6, 5, 3], 7: [6, 6, 4], 8: [6, 6, 5, 3],
  9: [6, 6, 6, 4], 10: [6, 6, 6, 5, 3], 11: [6, 6, 6, 6, 4], 12: [6, 6, 6, 6, 5, 3],
  13: [6, 6, 6, 6, 6, 4], 14: [6, 6, 6, 6, 6, 5, 3], 15: [6, 6, 6, 6, 6, 6, 4], 16: [6, 6, 6, 6, 6, 6, 5, 3],
  17: [6, 6, 6, 6, 6, 6, 6, 4], 18: [6, 6, 6, 6, 6, 6, 6, 5, 3], 19: [6, 6, 6, 6, 6, 6, 6, 6, 4], 20: [6, 6, 6, 6, 6, 6, 6, 6, 6],
};
// PF1 CLERIC base spells/day (prepared divine). Clerics prepare a number of
// spells of each level; spare slots get filled with more cures.
const CLERIC_SLOTS_BY_LEVEL = {
  1: [2], 2: [3], 3: [3, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 4, 3], 7: [5, 4, 3, 2], 8: [5, 4, 4, 3],
  9: [5, 5, 4, 3, 2], 10: [5, 5, 4, 4, 3], 11: [5, 5, 5, 4, 3, 2], 12: [5, 5, 5, 4, 4, 3],
  13: [5, 5, 5, 5, 4, 3, 2], 14: [5, 5, 5, 5, 4, 4, 3], 15: [5, 5, 5, 5, 5, 4, 3, 2], 16: [5, 5, 5, 5, 5, 4, 4, 3],
  17: [5, 5, 5, 5, 5, 5, 4, 3, 2], 18: [5, 5, 5, 5, 5, 5, 4, 4, 3], 19: [5, 5, 5, 5, 5, 5, 5, 4, 4], 20: [5, 5, 5, 5, 5, 5, 5, 5, 5],
};
// PF1 INQUISITOR spells/day — a 6-level SPONTANEOUS divine caster (Wisdom). He
// draws from the cleric list but progresses SLOWER than a cleric: he only ever
// reaches 6th-level spells, and gains each spell level later (2nd at L4, 3rd at
// L7, 4th at L10…). Base table (no ability-bonus slots), one room = one "day".
const INQ_SLOTS_BY_LEVEL = {
  1: [2], 2: [3], 3: [4], 4: [4, 2], 5: [4, 3], 6: [5, 3], 7: [5, 4, 2], 8: [5, 4, 3],
  9: [5, 5, 3], 10: [5, 5, 4, 2], 11: [6, 5, 4, 3], 12: [6, 6, 5, 3],
  13: [6, 6, 5, 4, 2], 14: [6, 6, 6, 4, 3], 15: [6, 6, 6, 5, 3], 16: [6, 6, 6, 5, 4, 2],
  17: [6, 6, 6, 6, 4, 3], 18: [6, 6, 6, 6, 5, 3], 19: [6, 6, 6, 6, 5, 4], 20: [6, 6, 6, 6, 6, 5],
};
function _tableSlots(table, level) {
  const arr = table[Math.max(1, Math.min(20, level || 1))] || table[1];
  const out = {};
  // An 18 CASTING STAT (Int/Wis/Cha) — assumed for every caster, mirroring the
  // 18 STR/DEX behind attacks — grants PF1 BONUS SPELLS: +1 per day to spell
  // levels 1–4. The base tables don't include it, so fold it in here.
  arr.forEach((n, i) => { const sl = i + 1; out[sl] = n + (sl <= 4 ? 1 : 0); });
  return out;   // { 1: n, 2: n, … } slots per spell level (incl. the 18-stat bonus)
}
function spontaneousSlots(level) { return _tableSlots(SORC_SLOTS_BY_LEVEL, level); }
// Slot table for any per-level slot caster (null = not a slot caster).
function slotsFor(cls, level) {
  if (cls === 'cleric') return _tableSlots(CLERIC_SLOTS_BY_LEVEL, level);
  if (cls === 'inquisitor') return _tableSlots(INQ_SLOTS_BY_LEVEL, level);   // slower 6-level divine progression
  if (SPONTANEOUS_CLASSES.has(cls)) return _tableSlots(SORC_SLOTS_BY_LEVEL, level);
  return null;
}

const POOL_CLASSES   = new Set([]);   // (sorcerer is spontaneous-per-level now)
const CASTER_CLASSES = new Set(['wizard', 'sorcerer', 'cleric', 'druid', 'bard', 'inquisitor']);
const isSpontaneous = (cls) => SPONTANEOUS_CLASSES.has(cls);

// Spell-damage dice count from a level scale.
function diceCount(ab, level) {
  const lvl = Math.max(1, level || 1);
  if (ab.dice === 'level')     return Math.min(ab.dcap || 10, lvl);
  if (ab.dice === 'halflevel') return Math.min(ab.dcap || 5, Math.max(1, Math.floor(lvl / 2)));
  return ab.dice || 1;
}
// How many own-pool uses a 'room' ability gets at a level.
function roomUses(ability, level) {
  if (!ability || ability.cost !== 'room') return 0;
  if (typeof ability.uses === 'function') return ability.uses(level);
  if (typeof ability.uses === 'number') return ability.uses;
  return channelUses(level);
}

// sound shorthands (files live in public/audio/)
const S = {
  fire: '/audio/spell_fireball.mp3', light: '/audio/spell_lightning.mp3', shock: '/audio/spell_shock.mp3',
  frost: '/audio/spell_frost_ray.mp3', scorch: '/audio/spell_dragonslave.mp3', umbral: '/audio/spell_umbral_bolt.mp3',
  holy: '/audio/spell_holy_smite.mp3', cure: '/audio/spell_cure.mp3', anchor: '/audio/spell_dimensional_anchor.mp3',
  laugh: '/audio/spell_laughter.mp3', inspire: '/audio/spell_inspire.mp3', rage: '/audio/spell_rage_roar.mp3',
  grease: '/audio/spell_grease.mp3', fascinate: '/audio/spell_fascinate.mp3', missile: '/audio/spell_magicmissile.mp3',
  // Scorching Ray now incants Lina Inverse's "Dragon Slave"; Sleep gets a short
  // "shh" instead of the long fascinate cue (which the bard still uses).
  sleep: '/audio/spell_sleep.mp3',
  bow: '/audio/bow_shot.mp3', bowmulti: '/audio/bow_multishot.mp3',
  charge: '/audio/spell_channel_charge.mp3',   // Channel Positive — holy charge-up
  revive: '/audio/spell_revive.mp3',           // Breath of Life / Raise Dead / Resurrection
  boneshatter: '/audio/spell_boneshatter.mp3', // Boneshatter (cleric / undead caster)
  gust: '/audio/spell_gustofwind.mp3',         // Gust of Wind (sorcerer knockdown)
  scorchsplit: '/audio/spell_scorchray_split.mp3', // Scorching Ray when it splits (CL7+)
  haste: '/audio/spell_haste.mp3',             // Haste (party extra attack)
  invis: '/audio/spell_invisibility.mp3',      // Invisibility
  coldcone: '/audio/spell_coneofcold.mp3',     // Cone of Cold
  disintegrate: '/audio/spell_disintegrate.mp3',
  prayer: '/audio/spell_prayer.mp3',           // cleric Prayer (drums)
  invoke: '/audio/spell_buff_invoke.mp3',      // misc self-buffs (Divine Favor, Shield of Faith…)
  sunstrike: '/audio/spell_holysmite.mp3',     // cleric Holy Smite (Invoker sun strike)
  searing: '/audio/spell_searinglight.mp3',    // Searing Light
  judgment: '/audio/spell_judgement.mp3',      // inquisitor Judgement toggle
  bardsong: '/audio/spell_bardsong.mp3',       // bard Inspire Courage (plays once)
  hideous: '/audio/spell_hideouslaughter.mp3', // bard Hideous Laughter
  frostbite: '/audio/spellstrike_frigid.mp3',  // magus Frigid Touch spellstrike
  dispel: '/audio/spell_dispel.mp3',           // Dispel Magic
  acid: '/audio/spell_acidarrow.mp3',          // Acid Arrow
  entangle: '/audio/spell_entangle.mp3',       // druid Entangle
  slow: '/audio/spell_slow.mp3',               // Slow (the Evil Morty theme)
};
// Sound POOLS — abilities with `sounds: [...]` pick one at random per cast, so a
// repeated spell doesn't drone the same clip (Fireball / Lightning Bolt / Haste).
const FIREBALL_SFX = ['/audio/fireball_1.mp3', '/audio/fireball_2.mp3', '/audio/fireball_3.mp3', '/audio/fireball_4.mp3'];
const THUNDER_SFX  = ['/audio/thunder_1.mp3', '/audio/thunder_2.mp3', '/audio/thunder_3.mp3', '/audio/thunder_4.mp3', '/audio/thunder_5.mp3'];
const HASTE_SFX    = ['/audio/spell_haste.mp3', '/audio/spell_haste2.mp3'];
// Blessing of Fervor incants ABBA's "Gimme! Gimme! Gimme!" — one of three clips.
const FERVOR_SFX   = ['/audio/abba_gimme_intro.mp3', '/audio/abba_gimme_chorus.mp3', '/audio/abba_gimme_chorus2.mp3'];

// Reusable spell defs (shared by wizard + sorcerer). `slvl` = the PF1e SPELL
// level (1st–9th), used to organise the spellbook; `minLevel` is the CHARACTER
// level at which this kit unlocks it (they differ — e.g. Cone of Cold is a 5th-
// level spell a wizard can't cast until character level 9).
const SPELL = {
  burninghands:  { key: 'burninghands',  name: 'Burning Hands',  icon: '🔥', cost: 'pool', effect: 'aoe', target: 'aoe', maxTargets: 2, save: 'reflex', die: 4, dice: 'level', dcap: 5, dtype: 'fire', slvl: 1, sound: S.fire, desc: 'A cone of flame — 2 foes, Reflex for half (level d4, cap 5d4).' },
  shockinggrasp: { key: 'shockinggrasp', name: 'Shocking Grasp', icon: '⚡', cost: 'pool', effect: 'touch', target: 'enemy', die: 6, dice: 'level', dcap: 5, dtype: 'electricity', slvl: 1, sound: S.shock, desc: 'A charged touch — ranged touch attack (level d6, cap 5d6).' },
  scorchingray:  { key: 'scorchingray',  name: 'Scorching Ray',  icon: '☄️', cost: 'pool', effect: 'rays', target: 'enemy', die: 6, dice: 4, minLevel: 4, dtype: 'fire', slvl: 2, sound: S.scorch, splitSound: S.scorchsplit, desc: 'A searing ray (4d6 fire) — SPLITS into 2 rays at caster level 7, 3 at 11; each rolls to hit.' },
  lightningbolt: { key: 'lightningbolt', name: 'Lightning Bolt',  icon: '⚡', cost: 'pool', effect: 'aoe', target: 'aoe', maxTargets: 2, save: 'reflex', die: 6, dice: 'level', dcap: 10, minLevel: 7, dtype: 'electricity', slvl: 3, sounds: THUNDER_SFX, desc: 'A bolt skewering 2 foes — Reflex for half (level d6).' },
  fireball:      { key: 'fireball',      name: 'Fireball',       icon: '💥', cost: 'pool', effect: 'aoe', target: 'aoe', maxTargets: 6, randFoes: 6, save: 'reflex', die: 6, dice: 'level', dcap: 10, minLevel: 7, dtype: 'fire', slvl: 3, sounds: FIREBALL_SFX, desc: 'A roaring blast that engulfs a RANDOM 1d6 enemies — Reflex for half (level d6).' },
  aciddart:      { key: 'aciddart',      name: 'Acid Arrow',     icon: '🟢', cost: 'pool', effect: 'touch', target: 'enemy', die: 6, dice: 'halflevel', dcap: 5, minLevel: 3, dtype: 'acid', slvl: 2, dot: true, sound: S.acid, desc: 'A bolt of acid — ranged touch for ½level d6, and it KEEPS BURNING for ½level d6 more each of the foe\'s turns (1 round per 3 caster levels).' },
  dispelmagic:   { key: 'dispelmagic',   name: 'Dispel Magic',   icon: '🌀', cost: 'pool', effect: 'cleanse', target: 'ally', minLevel: 5, slvl: 3, sound: S.dispel, desc: 'Strip a debuff off an afflicted ally (paralysis / stun / sickness) — or a buff off a foe, if any.' },
  holdperson:    { key: 'holdperson',    name: 'Hold Person',    icon: '🖐️', cost: 'pool', effect: 'save_debuff', target: 'enemy', save: 'will', debuff: 'paralyzed', slvl: 3, sound: S.anchor, desc: 'A foe must save or be HELD (helpless). Each of its turns it may re-save to break free — but the attempt costs its turn either way.' },
  grease:        { key: 'grease',        name: 'Grease',         icon: '🛢️', cost: 'pool', effect: 'grease', target: 'aoe', maxTargets: 2, save: 'reflex', minLevel: 1, slvl: 1, sound: S.grease, desc: 'Slick the floor — 2 foes Reflex or fall prone (splat!).' },
  sleep:         { key: 'sleep',         name: 'Sleep',          icon: '💤', cost: 'pool', effect: 'sleep',  target: 'aoe', maxTargets: 3, save: 'will',   minLevel: 1, slvl: 1, sound: S.sleep, desc: 'Up to 3 weaker foes must save or fall asleep — helpless, losing turns until struck.' },
  magicmissile:  { key: 'magicmissile',  name: 'Magic Missile',  icon: '🔮', cost: 'pool', effect: 'missile', target: 'enemy', minLevel: 1, slvl: 1, sound: S.missile, desc: 'Unerring darts of force — 1 dart +1 per 2 levels (max 5), 1d4+1 each, auto-hit.' },
  slow:          { key: 'slow',          name: 'Slow',           icon: '🐌', cost: 'pool', effect: 'slow',   target: 'aoe', randN: 2, randDie: 4, maxTargets: 8, save: 'will', minLevel: 5, slvl: 3, sound: S.slow, desc: 'Time drags for a RANDOM 2d4 foes — Will save or be SLOWED: sluggish (acts only every other turn) and easier to hit.' },
  gustofwind:    { key: 'gustofwind',    name: 'Gust of Wind',   icon: '🌪️', cost: 'pool', effect: 'grease', target: 'aoe', randFoes: 3, save: 'fort', minLevel: 4, slvl: 2, sound: S.gust, desc: 'A roaring gale blasts a RANDOM 1d3 foes — Fort save or be knocked prone.' },
  invisibility:  { key: 'invisibility',  name: 'Invisibility',   icon: '👻', cost: 'pool', effect: 'invisible', target: 'self', minLevel: 3, slvl: 2, sound: S.invis, desc: "Vanish from sight — enemies can't target you until you attack." },
  shield:        { key: 'shield',        name: 'Shield',         icon: '🛡️', cost: 'pool', effect: 'buff', target: 'self', buff: { ac: 4 }, slvl: 1, sticky: true, sound: S.invoke, desc: 'A wall of force — +4 shield AC for the rest of the room.' },
  catsgrace:     { key: 'catsgrace',     name: "Cat's Grace",    icon: '🐈', cost: 'pool', effect: 'buff', target: 'ally', buff: { ac: 2, toHit: 1 }, slvl: 2, sticky: true, sound: S.invoke, desc: 'Feline-quick — one ally gets +2 AC and +1 ranged to-hit (Dex) for the rest of the room.' },
  fly:           { key: 'fly',           name: 'Fly',            icon: '🪽', cost: 'pool', effect: 'buff', target: 'self', fly: true, slvl: 3, sticky: true, sound: S.invis, desc: 'Take to the air — grounded foes CANNOT reach you (immune to non-ranged attacks) for the rest of the room.' },
  coneofcold:    { key: 'coneofcold',    name: 'Cone of Cold',   icon: '🥶', cost: 'pool', effect: 'aoe', target: 'aoe', randBase: 2, randDie: 3, save: 'reflex', die: 6, dice: 'level', dcap: 15, minLevel: 9, dtype: 'cold', slvl: 5, sound: S.coldcone, desc: 'A blast of frost engulfs 2+1d3 foes — Reflex for half (level d6).' },
  disintegrate:  { key: 'disintegrate',  name: 'Disintegrate',   icon: '☢️', cost: 'pool', effect: 'disintegrate', target: 'enemy', maxTargets: 1, save: 'fort', die: 6, dice: 'level', dcap: 20, minLevel: 11, dtype: 'force', slvl: 6, sound: S.disintegrate, desc: 'A thin green ray — ranged touch attack, then 2d6 per caster level (max 40d6). Fort partial: a made save still takes 5d6. Reduced to 0 HP → disintegrated to dust.' },
  firesnake:     { key: 'firesnake',     name: 'Fire Snake',     icon: '🐍', cost: 'pool', effect: 'aoe', target: 'aoe', maxTargets: 4, save: 'reflex', die: 6, dice: 'level', dcap: 15, minLevel: 7, dtype: 'fire', slvl: 4, sounds: FIREBALL_SFX, desc: 'A serpent of flame weaves through up to 4 foes — 1d6 fire per caster level (max 15d6), Reflex for half.' },
  stoneskin:     { key: 'stoneskin',     name: 'Stoneskin',      icon: '🪨', cost: 'pool', effect: 'buff', target: 'ally', buff: {}, dr: 10, slvl: 4, minLevel: 7, sticky: true, sound: S.invoke, desc: 'An ally\'s skin turns to stone — DR 10 against physical blows (melee/claws/chains) for the rest of the room.' },
  // Protection from Evil (Communal) — a 2nd-level party ward. No cost key here;
  // each kit sets it (wizard prepared 'room', sorcerer/cleric/inquisitor 'slot').
  protevil:      { key: 'protevil',      name: 'Protection from Evil (Communal)', icon: '🛡️', img: '/dungeon/buffs/protevil.webp', effect: 'buff', target: 'self', party: true, sticky: true, buff: { ac: 2, save: 2 }, slvl: 2, sound: S.invoke, desc: 'Ward the whole party — +2 AC and +2 to all saves for EVERY ally, for the rest of the room.' },
  darkness:      { key: 'darkness',      name: 'Darkness',       icon: '🌑', effect: 'darkness', target: 'aoe', randBase: 1, randDie: 4, slvl: 2, sound: S.umbral, desc: 'Shroud a RANDOM 1d4+1 foes in magical darkness — they CANNOT attack and CANNOT be attacked for 2 rounds.' },
};
// Mage Armor — a free-action, run-long +4 armor AC (cast once per dungeon). Shared
// by wizard + sorcerer. Its own 'magearmor' effect (see Dungeon._abMageArmor).
const MAGE_ARMOR = { key: 'magearmor', name: 'Mage Armor', img: '/dungeon/buffs/magearmor.webp', icon: '🛡️', cost: 'run', uses: 1, freeAction: true, slvl: 1, effect: 'magearmor', target: 'self', sound: S.invoke, desc: '+4 armor AC for the ENTIRE dungeon — a FREE action (no turn cost), cast once.' };
const ATTACK = (icon) => ({ key: 'attack', name: 'Attack', icon: icon || '⚔️', effect: 'attack', target: 'enemy' });
// A WIZARD's prepared spell: one casting per room (own 'room' use of 1).
const preparedSpell   = (spell, minLevel) => ({ ...spell, cost: 'room', uses: 1, minLevel });
// A SORCERER's known spell: spontaneous — drawn from the shared per-room cast
// pool ('pool'), so any of his few known spells can be cast until slots run out.
const spontaneousSpell = (spell, minLevel) => ({ ...spell, cost: 'slot', minLevel });
// Wizard/Sorcerer at-will is NOT a weapon swing — it's an Elemental Ray: an
// unlimited ranged touch attack for 1d6+4 (cold). Used in the dungeon AND for
// poker-table harassment. (Ice-punch sound.)
const RAY_OF_FROST = { key: 'rayoffrost', name: 'Ray of Frost', icon: '❄️', effect: 'bolt', target: 'enemy', die: 6, dice: 1, flat: 4, dtype: 'cold', sound: S.frost, desc: 'Elemental Ray — a ranged touch attack for 1d6+4 cold (unlimited).' };
// Flame-oracle at-will — the fiery counterpart to Ray of Frost (Produce Flame).
const PRODUCE_FLAME = { key: 'produceflame', name: 'Produce Flame', icon: '🔥', effect: 'bolt', target: 'enemy', die: 6, dice: 1, flat: 4, dtype: 'fire', sound: S.fire, desc: 'Produce Flame — a flickering flame hurled at a foe for 1d6+4 fire (ranged touch, unlimited).' };

const KITS = {
  // ── Martials (conditional maneuvers) ──
  // FIGHTER — earns PF1 bonus feats as it levels (Weapon Focus/Specialization,
  // Dodge, Toughness, the save feats, Improved Initiative, Improved Cleave) folded
  // into its combat numbers automatically. Power Attack is a toggle it can throw on.
  fighter: { atwill: ATTACK('⚔️'), abilities: [
    { key: 'powerattack', name: 'Power Attack', icon: '💥', cost: 'free', freeAction: true, effect: 'buff', target: 'self', powerattack: true, sticky: true, sound: S.rage, desc: 'Throw your weight into every blow — trade accuracy for power (−1 to hit per +4 BAB, +2 damage each, ×1.5 with a two-handed weapon). A FREE toggle: flip it on or off without spending your turn.' },
    { key: 'trip',   name: 'Trip',   icon: '🦵', cost: 'free', effect: 'trip',   target: 'enemy', desc: 'Attack to trip (no damage). On a hit the foe is knocked prone, loses its turn, and you get a free attack. Prone = +4 for everyone to hit it.' },
    { key: 'cleave', name: 'Cleave', icon: '🪓', cost: 'free', effect: 'cleave', target: 'enemy', desc: 'Swing through — hit your target, then a second foe (−2). Great Cleave: every foe you DROP grants another swing, chaining until you stop felling them.' },
  ] },
  // SWASHBUCKLER — a finesse duelist. Passively (with a finessable blade): Weapon
  // Focus/Specialization, Precise Strike (+level damage after L3), and Improved
  // Critical at L5. It auto-PARRIES the first attack on it each round (success →
  // no damage + a free riposte). Disarm is its active deed.
  swashbuckler: { atwill: ATTACK('🤺'), abilities: [
    { key: 'disarm', name: 'Disarm', icon: '🌀', cost: 'free', effect: 'disarm', target: 'enemy', desc: 'A flick of the blade — an opposed roll to DISARM a foe. On a success it scrambles for its weapon (loses its next turn) and you land a free strike. (You also auto-parry the first attack on you each round → riposte, and Precise Strike adds your level to damage with a finesse blade.)' },
  ] },
  barbarian: { atwill: ATTACK('⚔️'), abilities: [
    { key: 'cleave', name: 'Cleave', icon: '🪓', cost: 'free', effect: 'cleave', target: 'enemy', acPen: 2, desc: 'Hit your target and a second foe (−2) — every foe you DROP grants another swing, chaining until you stop felling them — but you drop your guard (−2 AC) this turn.' },
    { key: 'rage',   name: 'Rage',   icon: '😤', cost: 'free', freeAction: true, effect: 'buff', target: 'self', buff: { toHit: 2, dmg: 2, acPen: 2, save: 1 }, sticky: true, sound: S.rage, desc: 'Fly into a rage for the rest of the room (FREE action — still attack this turn): +2 to hit & damage and +1 Will, but −2 AC.' },
    { key: 'taunt',  name: 'Taunt',  icon: '📢', cost: 'room', uses: 1, effect: 'taunt', target: 'aoe', save: 'will', sound: '/audio/taunt_predator.mp3', desc: 'A furious challenge — EVERY enemy must make a Will save or be forced to attack YOU on its next turn (drawing fire off your allies). Once per room.' },
  ] },
  ranger: { atwill: ATTACK('🏹'), abilities: [
    { key: 'rapidshot', name: 'Rapid Shot',    icon: '🏹', cost: 'free', effect: 'rapidshot', target: 'enemy', needsRepeating: true, sound: S.bowmulti, desc: 'Loose 2 shots this turn — each at −2 to hit. (Needs a weapon that can fire repeatedly — NOT a bolt-action sniper rifle.)' },
    { key: 'bullseye',  name: 'Bullseye Shot',  icon: '🎯', cost: 'free', effect: 'bullseye',  target: 'enemy', sound: S.bow,      desc: 'A carefully aimed shot at +4 to hit.' },
    { key: 'deadlyaim', name: 'Deadly Aim',     icon: '🎯', cost: 'free', freeAction: true, effect: 'buff', target: 'self', deadlyaim: true, sticky: true, sound: S.bow, desc: 'A feat (toggle): trade −2 to hit for heavy bonus damage on every shot this room (scales with level).' },
  ] },
  rogue: { atwill: ATTACK('🗡️'), abilities: [
    { key: 'feint', name: 'Feint', icon: '🎭', cost: 'free', effect: 'feint', target: 'enemy', desc: 'Bluff a foe flat-footed; on success, a free Sneak-Attack strike. (You also Sneak Attack any prone/sickened/paralyzed/flat-footed foe, and strike twice with daggers.)' },
  ] },
  // ── Divine (channels) ──
  paladin: { atwill: ATTACK('⚔️'), abilities: [
    { key: 'powerattack', name: 'Power Attack', icon: '💥', cost: 'free', freeAction: true, effect: 'buff', target: 'self', powerattack: true, sticky: true, minLevel: 3, sound: S.rage, desc: 'Throw your weight into every blow — trade accuracy for power (−1 to hit per +4 BAB, +2 damage each, ×1.5 two-handed). A FREE toggle, flip it on or off without spending your turn. (Paladin bonus feat, gained at level 3.)' },
    { key: 'smite',   name: 'Smite Evil',     icon: '⚜️', cost: 'room', uses: smiteUses, freeAction: true, effect: 'smite', target: 'self', sound: S.holy, desc: 'A FREE action (no action cost): your strikes smite EVIL foes this room — +to-hit and +double your level to damage, but ONLY vs creatures of evil alignment. Use Detect Evil first to mark neutral foes (animals, constructs). Once per 5 levels per room.' },
    { key: 'detectevil', name: 'Detect Evil', img: '/dungeon/conditions/markedevil.webp', icon: '🎯', cost: 'free', freeAction: true, effect: 'detectevil', target: 'aoe', sound: '/audio/into_the_light.mp3', desc: 'Bathe the room in revealing light (a FREE action — no action cost) — MARK every enemy as evil, so your Smite strikes ALL of them, even animals and constructs. Lasts the room.' },
    { key: 'channel', name: 'Channel Positive', icon: '💖', cost: 'room', uses: channelUses, effect: 'heal', heal: 'party', target: 'ally', sound: S.charge, desc: 'Channel positive energy — heal the whole party (scales with level).' },
    // ── Paladin spells (home-rule: spellcasting from level 1, the slowest pace —
    //    a new spell level every 3 character levels). One casting each per room. ──
    { key: 'shieldoffaith',    name: 'Shield of Faith',     icon: '🛡️', cost: 'room', uses: 1, minLevel: 1,  slvl: 1, effect: 'buff', target: 'ally', buff: { ac: 2 }, sticky: true, sound: S.invoke, desc: '+2 deflection AC to the ally with the LOWEST AC (who doesn\'t already have it) for the rest of the room. (1st-level paladin spell.)' },
    { key: 'bullsstrength',    name: "Bull's Strength",     icon: '💪', cost: 'room', uses: 1, minLevel: 4,  slvl: 2, effect: 'buff', target: 'ally', buff: { toHit: 2, dmg: 2 }, sticky: true, sound: S.invoke, desc: 'One martial ally gets +2 to hit and +2 melee damage for the rest of the room. (2nd-level paladin spell, level 4.)' },
    { key: 'prayer',           name: 'Prayer',              icon: '📿', cost: 'room', uses: 1, minLevel: 7,  slvl: 3, effect: 'buff', target: 'self', party: true, buff: { toHit: 1, dmg: 1, save: 1 }, enemyPenalty: 1, sticky: true, sound: S.prayer, desc: 'ALL allies +1 to hit, damage & saves; ALL enemies −1, for the rest of the room. (3rd-level paladin spell, level 7.)' },
    { key: 'blessingoffervor', name: 'Blessing of Fervor',  icon: '💨', cost: 'room', uses: 1, minLevel: 10, slvl: 4, effect: 'haste', target: 'self', party: true, sounds: FERVOR_SFX, desc: 'The party surges with fervor — an EXTRA attack each turn for 1 turn per 5 levels (the haste choice). (4th-level paladin spell, level 10.)' },
  ] },
  // CLERIC — prepared divine caster with SPELL SLOTS PER LEVEL (PF1 progression).
  // Each spell spends a slot of its level; with extra slots the AI prepares more
  // cures. CHANNEL is a class feature (own count); BLESS is run-long (cast once).
  cleric: { atwill: ATTACK('🔨'), abilities: [
    { key: 'channel',      name: 'Channel Positive',     icon: '💖', cost: 'room', uses: smiteUses, effect: 'heal', heal: 'party', target: 'ally', sound: S.charge, desc: 'Channel positive energy — heal the whole party for ½level d6 (PF1e). Once per 5 levels per room.' },
    // ── 1st-level prayers ──
    { key: 'curelight',    name: 'Cure Light Wounds',    icon: '💚', cost: 'slot', slvl: 1, effect: 'heal', heal: 'single', healDice: 1, healCap: 5,  target: 'ally', sound: S.cure,    desc: 'Heal the most-hurt ally — 1d8 + caster level (max +5).' },
    { key: 'shieldoffaith',name: 'Shield of Faith',      icon: '🛡️', cost: 'slot', slvl: 1, effect: 'buff', target: 'ally', buff: { ac: 2 }, sticky: true, sound: S.invoke, desc: '+2 deflection AC to an ally (the one with the LOWEST AC) for the rest of the room.' },
    { key: 'divinefavor',  name: 'Divine Favor',         icon: '🙏', cost: 'slot', slvl: 1, effect: 'buff', target: 'self', buff: { toHit: 3, dmg: 3 }, sticky: true, sound: S.invoke,   desc: '+3 to hit and +3 damage to yourself for the rest of the room.' },
    { key: 'bless',        name: 'Bless',                icon: '✨', cost: 'run',  uses: 1, slvl: 1, effect: 'buff', target: 'self', party: true, persist: true, buff: { toHit: 1 }, sticky: true, sound: S.cure, desc: 'All allies gain +1 to hit for the ENTIRE dungeon — cast once; it never fades between rooms.' },
    // ── 2nd-level prayers ──
    { ...SPELL.protevil, cost: 'slot', minLevel: 3 },
    { key: 'curemoderate', name: 'Cure Moderate Wounds', icon: '💚', cost: 'slot', slvl: 2, minLevel: 3, effect: 'heal', heal: 'single', healDice: 2, healCap: 10, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 2d8 + caster level (max +10).' },
    { key: 'holdperson',   name: 'Hold Person',          icon: '🖐️', cost: 'slot', slvl: 2, minLevel: 3, effect: 'save_debuff', target: 'enemy', save: 'will', debuff: 'paralyzed', sound: S.anchor, desc: 'A foe must save or be HELD (helpless). Each turn it may re-save to break free — the attempt costs its turn.' },
    { key: 'bullsstrength', name: "Bull's Strength",     icon: '💪', cost: 'slot', slvl: 2, minLevel: 3, effect: 'buff', target: 'ally', buff: { toHit: 2, dmg: 2 }, sticky: true, sound: S.invoke, desc: 'Bull-strong — one ally gets +2 to hit and +2 melee damage for the rest of the room.' },
    { key: 'bearsendurance', name: "Bear's Endurance",   icon: '🐻', cost: 'slot', slvl: 2, minLevel: 3, effect: 'buff', target: 'ally', buff: { conHp: 2 }, sticky: true, sound: S.invoke, desc: 'Bear-hardy — one ally gains temporary HP (+2 per level) for the rest of the room.' },
    { key: 'spiritweapon', name: 'Spiritual Weapon',     icon: '🗡️', cost: 'slot', slvl: 2, minLevel: 3, effect: 'spiritweapon', target: 'enemy', sound: S.holy, desc: 'Conjure a force-weapon shaped like your own over a foe — it strikes that foe on EACH of your turns (with your buffs, feats & Haste) for 1 round per 2 caster levels, while you do other things.' },
    // ── 3rd-level prayers ──
    { key: 'prayer',       name: 'Prayer',               icon: '📿', cost: 'slot', slvl: 3, minLevel: 5, effect: 'buff', target: 'self', party: true, buff: { toHit: 1, dmg: 1, save: 1 }, enemyPenalty: 1, sticky: true, sound: S.prayer, desc: 'Fills the whole battlefield: ALL allies +1 to hit, damage & saves; ALL enemies −1, for the rest of the room. (Only one is ever needed.)' },
    { key: 'searinglight', name: 'Searing Light',        icon: '🔆', cost: 'slot', slvl: 3, minLevel: 5, effect: 'touch', target: 'enemy', die: 8, dice: 'halflevel', dcap: 5, dtype: 'holy', sound: S.searing, desc: 'A ray of divine light — ranged touch for ½level d8 (extra vs undead).' },
    { key: 'cureserious',  name: 'Cure Serious Wounds',  icon: '💚', cost: 'slot', slvl: 3, minLevel: 5, effect: 'heal', heal: 'single', healDice: 3, healCap: 15, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 3d8 + caster level (max +15).' },
    { key: 'dispelmagic',  name: 'Dispel Magic',         icon: '🌀', cost: 'slot', slvl: 3, minLevel: 5, effect: 'cleanse', target: 'ally', sound: S.dispel, desc: 'Strip a debuff off an afflicted ally (paralysis / hold / grapple / stun / sickness).' },
    // ── 4th-level prayers ──
    { key: 'curecritical', name: 'Cure Critical Wounds', icon: '💚', cost: 'slot', slvl: 4, minLevel: 7, effect: 'heal', heal: 'single', healDice: 4, healCap: 20, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 4d8 + caster level (max +20).' },
    { key: 'protectfire',  name: 'Protection from Fire',  icon: '🔥', cost: 'slot', slvl: 4, minLevel: 7, effect: 'buff', target: 'self', party: true, protectFire: true, sticky: true, sound: S.invoke, desc: 'Ward the whole party against FIRE — fire damage they take is HALVED for the rest of the room. (Cast it when fiery foes loom.)' },
    { key: 'blessingoffervor', name: 'Blessing of Fervor', icon: '💨', cost: 'slot', slvl: 4, minLevel: 7, effect: 'haste', target: 'self', party: true, sounds: FERVOR_SFX, desc: 'The party surges with fervor — an EXTRA attack each turn for 1 turn per 5 levels (like Haste).' },
    { key: 'holysmite',    name: 'Holy Smite',           icon: '🌟', cost: 'slot', slvl: 4, minLevel: 7, effect: 'aoe', target: 'aoe', maxTargets: 2, save: 'will', die: 8, dice: 'halflevel', dcap: 5, dtype: 'holy', sound: S.sunstrike, desc: 'Searing light scourges 2 foes — Will for half (½level d8).' },
    // ── High-level prayers (revives), gated by level + slot availability ──
    { key: 'breathoflife', name: 'Breath of Life',       icon: '🌬️', cost: 'slot', slvl: 5, minLevel: 9,  effect: 'revive', reviveDice: 5, reviveCap: 25, target: 'ally', sound: S.revive, desc: 'Snatch a DYING ally back — revive & heal them 5d8 + caster level (max +25).' },
    { key: 'raisedead',    name: 'Raise Dead',           icon: '⚰️', cost: 'slot', slvl: 5, minLevel: 9,  effect: 'revive', raiseDead: true, target: 'ally', sound: S.revive, desc: 'Call a SLAIN ally back into the run, restored to half health.' },
    { key: 'resurrection', name: 'Resurrection',         icon: '✨', cost: 'slot', slvl: 7, minLevel: 13, effect: 'revive', raiseDead: true, full: true, target: 'ally', sound: S.revive, desc: 'Fully resurrect a SLAIN ally — back in the run at FULL health.' },
  ] },
  // ── Full arcane casters ──
  // WIZARD — prepared caster: a BROAD spellbook, but ONE casting of each spell
  // per room (cost:'room', uses:1). Wired via a helper so every spell is single-
  // shot per room without repeating the override on each line.
  wizard: { atwill: { ...RAY_OF_FROST }, note: 'One casting of each spell, per room.', abilities: [
    preparedSpell(SPELL.shockinggrasp, 1),
    preparedSpell(SPELL.grease,        1),
    preparedSpell(SPELL.sleep,         1),
    preparedSpell(SPELL.shield,        1),
    { ...MAGE_ARMOR },
    preparedSpell(SPELL.protevil,      3),
    preparedSpell(SPELL.darkness,      3),
    preparedSpell(SPELL.invisibility,  3),
    preparedSpell(SPELL.aciddart,      3),
    preparedSpell(SPELL.scorchingray,  3),
    preparedSpell(SPELL.holdperson,    3),
    preparedSpell(SPELL.fly,           5),
    preparedSpell(SPELL.dispelmagic,   5),
    { key: 'haste', name: 'Haste', icon: '💨', cost: 'room', uses: 1, minLevel: 5, slvl: 3, effect: 'haste', target: 'self', party: true, sounds: HASTE_SFX, desc: 'The whole party blurs with speed — every ally gets an EXTRA attack each turn for 1 turn per 5 caster levels (on top of their action).' },
    preparedSpell(SPELL.slow,          5),
    preparedSpell(SPELL.fireball,      5),
    preparedSpell(SPELL.lightningbolt, 5),
    preparedSpell(SPELL.firesnake,     7),
    preparedSpell(SPELL.stoneskin,     7),
    preparedSpell(SPELL.coneofcold,    9),
    preparedSpell(SPELL.disintegrate,  11),
  ] },
  // SORCERER — spontaneous caster: knows FEWER spells, drawn from a shared
  // per-room cast pool (his limited casts/day = casts/room). A focused blaster's
  // signature repertoire he can recast freely until the pool empties.
  sorcerer: { atwill: { ...RAY_OF_FROST }, abilities: [
    spontaneousSpell(SPELL.magicmissile, 1),
    spontaneousSpell(SPELL.burninghands, 1),
    spontaneousSpell(SPELL.shield,       1),
    { ...MAGE_ARMOR },
    spontaneousSpell(SPELL.protevil,     4),
    spontaneousSpell(SPELL.darkness,     4),
    spontaneousSpell(SPELL.sleep,        1),
    spontaneousSpell(SPELL.aciddart,     4),
    spontaneousSpell(SPELL.gustofwind,   4),
    spontaneousSpell(SPELL.scorchingray, 4),
    spontaneousSpell(SPELL.catsgrace,    4),
    spontaneousSpell(SPELL.dispelmagic,  6),
    spontaneousSpell(SPELL.fly,          6),
    spontaneousSpell(SPELL.slow,         6),
    spontaneousSpell(SPELL.fireball,     6),
    { key: 'haste', name: 'Haste', icon: '💨', cost: 'slot', slvl: 3, minLevel: 6, effect: 'haste', target: 'self', party: true, sounds: HASTE_SFX, desc: 'The whole party blurs with speed — an EXTRA attack each turn for 1 turn per 5 caster levels.' },
    spontaneousSpell(SPELL.firesnake,    8),
    spontaneousSpell(SPELL.stoneskin,    8),
    spontaneousSpell(SPELL.coneofcold,   10),
    spontaneousSpell(SPELL.disintegrate, 12),
  ] },
  // ORACLE — spontaneous DIVINE caster on the CLERIC spell list, at oracle (full
  // spontaneous caster) progression: per-spell-level slots from the SORC table via
  // slotsFor(). Its repertoire is built right after this KITS literal (a clone of
  // the cleric list + Channel Positive + Flame-mystery fire spells + Haste/Slow),
  // so cleric and oracle stay in sync. Elfrip (Flame) leans on the fire blasts;
  // Rhyarca & Casandalee play the full divine toolkit. At-will: Produce Flame.
  oracle: { atwill: { ...PRODUCE_FLAME }, abilities: [] },
  // ── Hybrids ──
  // MAGUS — basic attack with the player's chosen weapon (martial proficiency).
  // Spell Strike = that same attack PLUS Shocking Grasp (+level d6 electricity,
  // cap 5d6), usable once per room per 5 levels (like Smite). Shield = a sticky
  // +4 AC ward for the rest of the room. (Per-magus Spell Strike SFX — Kate's
  // "boudicca", Vaughan's anime sword, Toni's axe — are wired in Dungeon.js.)
  // SPELL STRIKE = channel a touch spell through the weapon hit. The magus picks
  // which spell to fire each strike; the buttons use short "SS …" labels to fit:
  //   SS Shock (Shocking Grasp, 1st) · SS Frigid (Frigid Touch, 2nd) ·
  //   SS Max SG (Intensified Shocking Grasp, 3rd) · SS Vamp (Vampiric Touch, 4th).
  magus: { atwill: ATTACK('⚔️'), abilities: [
    { key: 'spellstrike',  name: 'SS Shock',  icon: '⚡',  cost: 'room', uses: smiteUses, minLevel: 1, effect: 'spellstrike', target: 'enemy', die: 6, dice: 'level',     dcap: 5,  dtype: 'electricity', sound: S.shock,     desc: 'Spell Strike — Shocking Grasp (1st): your weapon hit PLUS level d6 electricity (cap 5d6).' },
    { key: 'frigidtouch',  name: 'SS Frigid', icon: '🧊', cost: 'room', uses: smiteUses, minLevel: 3, effect: 'spellstrike', target: 'enemy', die: 6, dice: 4,            dtype: 'cold', debuff: 'sickened', sound: S.frostbite, desc: 'Spell Strike — Frigid Touch (2nd): your weapon hit +4d6 cold; the foe is staggered (sickened).' },
    { key: 'intenseshock', name: 'SS Max SG', icon: '🌩️', cost: 'room', uses: smiteUses, minLevel: 5, effect: 'spellstrike', target: 'enemy', die: 6, dice: 'level',     dcap: 10, dtype: 'electricity', sound: S.shock,     desc: 'Spell Strike — Intensified Shocking Grasp (3rd): your weapon hit PLUS level d6 electricity, cap raised to 10d6.' },
    { key: 'vampirictouch',name: 'SS Vamp',   icon: '🩸', cost: 'room', uses: smiteUses, minLevel: 7, effect: 'spellstrike', target: 'enemy', die: 6, dice: 'halflevel', dcap: 10, dtype: 'negative', lifesteal: true, sound: S.umbral, desc: 'Spell Strike — Vampiric Touch (4th): your weapon hit +½level d6 negative energy (cap 10d6); you HEAL the energy damage dealt.' },
    { key: 'shield',       name: 'Shield',    icon: '🛡️', cost: 'free', effect: 'buff', target: 'self', buff: { ac: 4 }, sticky: true, sound: S.inspire, desc: 'Raise an arcane Shield — +4 AC for the rest of the room.' },
  ] },
  // INQUISITOR — a SPONTANEOUS divine caster (cleric-list spellbook, slower 6-level
  // progression — see INQ_SLOTS_BY_LEVEL) who fights with steel and zeal. His class
  // FEATURES sit beside the spellbook: BANE (declare a creature TYPE — a free action,
  // 1 use per 5 levels/room — then +2 hit / +2d6+2 vs THAT type only) and three
  // JUDGEMENTS (free-action toggle, only one active, lasts the whole room). He also
  // earns fighter bonus feats at HALF rate (see fighterFeats in Dungeon.js).
  inquisitor: { atwill: ATTACK('⚔️'), note: 'Spontaneous divine caster — cleric-list spells at a slower 6-level progression.', abilities: [
    // ── Class features (no spell level → inline buttons) ──
    { key: 'bane', name: 'Bane', icon: '🗡️', cost: 'room', uses: smiteUses, freeAction: true, effect: 'bane', target: 'self', sound: S.umbral, desc: 'Declare a foe TYPE: SELECT an enemy, then click Bane (a FREE action — 1 use per 5 levels per room). Your weapon turns bane against THAT creature type only — +2 to hit and +2d6+2 damage vs it for the rest of the room. Re-declare (spends another use) to switch types.' },
    { key: 'judg_destruction', name: 'Judgement: Destruction', icon: '⚔️', cost: 'free', effect: 'judgment', judgmentType: 'destruction', sound: S.judgment, desc: 'JUDGEMENT (free to choose, only one active, lasts the whole room): +damage on your strikes.' },
    { key: 'judg_protection',  name: 'Judgement: Protection',  icon: '🛡️', cost: 'free', effect: 'judgment', judgmentType: 'protection',  sound: S.judgment, desc: 'JUDGEMENT (free to choose, only one active, lasts the room): +AC against your foes.' },
    { key: 'judg_healing',     name: 'Judgement: Healing',     icon: '💗', cost: 'free', effect: 'judgment', judgmentType: 'healing',     sound: S.judgment, desc: 'JUDGEMENT (free to choose, only one active, lasts the room): regenerate HP each of your turns.' },
    // ── Spellbook: curated cleric-list repertoire, spontaneous, gated to his slower slot progression ──
    // 1st level (slots from L1)
    { key: 'curelight',     name: 'Cure Light Wounds',    icon: '💚', cost: 'slot', slvl: 1, effect: 'heal', heal: 'single', healDice: 1, healCap: 5,  target: 'ally', sound: S.cure,   desc: 'Heal the most-hurt ally — 1d8 + caster level (max +5).' },
    { key: 'shieldoffaith', name: 'Shield of Faith',      icon: '🛡️', cost: 'slot', slvl: 1, effect: 'buff', target: 'ally', buff: { ac: 2 }, sticky: true, sound: S.invoke, desc: '+2 deflection AC to the lowest-AC ally for the rest of the room.' },
    { key: 'divinefavor',   name: 'Divine Favor',         icon: '🙏', cost: 'slot', slvl: 1, effect: 'buff', target: 'self', buff: { toHit: 3, dmg: 3 }, sticky: true, sound: S.invoke, desc: '+3 to hit and +3 damage to yourself for the rest of the room.' },
    { key: 'bless',         name: 'Bless',                icon: '✨', cost: 'run',  uses: 1, slvl: 1, effect: 'buff', target: 'self', party: true, persist: true, buff: { toHit: 1 }, sticky: true, sound: S.cure, desc: 'All allies gain +1 to hit for the ENTIRE dungeon — cast once; it never fades between rooms.' },
    // 2nd level (slots from L4)
    { ...SPELL.protevil, cost: 'slot', minLevel: 4 },
    { key: 'curemoderate',  name: 'Cure Moderate Wounds', icon: '💚', cost: 'slot', slvl: 2, minLevel: 4, effect: 'heal', heal: 'single', healDice: 2, healCap: 10, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 2d8 + caster level (max +10).' },
    { key: 'holdperson',    name: 'Hold Person',          icon: '🖐️', cost: 'slot', slvl: 2, minLevel: 4, effect: 'save_debuff', target: 'enemy', save: 'will', debuff: 'paralyzed', sound: S.anchor, desc: 'A foe must save or be HELD (helpless). Each turn it may re-save to break free — the attempt costs its turn.' },
    { key: 'bullsstrength', name: "Bull's Strength",       icon: '💪', cost: 'slot', slvl: 2, minLevel: 4, effect: 'buff', target: 'ally', buff: { toHit: 2, dmg: 2 }, sticky: true, sound: S.invoke, desc: 'Bull-strong — one ally gets +2 to hit and +2 melee damage for the rest of the room.' },
    { key: 'spiritweapon',  name: 'Spiritual Weapon',     icon: '🗡️', cost: 'slot', slvl: 2, minLevel: 4, effect: 'spiritweapon', target: 'enemy', sound: S.holy, desc: 'Conjure a force-weapon that strikes a foe on EACH of your turns (with your buffs & feats) for 1 round per 2 caster levels, while you do other things.' },
    // 3rd level (slots from L7)
    { key: 'cureserious',   name: 'Cure Serious Wounds',  icon: '💚', cost: 'slot', slvl: 3, minLevel: 7, effect: 'heal', heal: 'single', healDice: 3, healCap: 15, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 3d8 + caster level (max +15).' },
    { key: 'dispelmagic',   name: 'Dispel Magic',         icon: '🌀', cost: 'slot', slvl: 3, minLevel: 7, effect: 'cleanse', target: 'ally', sound: S.dispel, desc: 'Strip a debuff off an afflicted ally (paralysis / hold / stun / sickness).' },
    { key: 'prayer',        name: 'Prayer',               icon: '📿', cost: 'slot', slvl: 3, minLevel: 7, effect: 'buff', target: 'self', party: true, buff: { toHit: 1, dmg: 1, save: 1 }, enemyPenalty: 1, sticky: true, sound: S.prayer, desc: 'ALL allies +1 to hit, damage & saves; ALL enemies −1, for the rest of the room.' },
    { key: 'searinglight',  name: 'Searing Light',        icon: '🔆', cost: 'slot', slvl: 3, minLevel: 7, effect: 'touch', target: 'enemy', die: 8, dice: 'halflevel', dcap: 5, dtype: 'holy', sound: S.searing, desc: 'A ray of divine light — ranged touch for ½level d8 (extra vs undead).' },
    // 4th level (slots from L10)
    { key: 'curecritical',  name: 'Cure Critical Wounds', icon: '💚', cost: 'slot', slvl: 4, minLevel: 10, effect: 'heal', heal: 'single', healDice: 4, healCap: 20, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 4d8 + caster level (max +20).' },
    { key: 'holysmite',     name: 'Holy Smite',           icon: '🌟', cost: 'slot', slvl: 4, minLevel: 10, effect: 'aoe', target: 'aoe', maxTargets: 2, save: 'will', die: 8, dice: 'halflevel', dcap: 5, dtype: 'holy', sound: S.sunstrike, desc: 'Searing light scourges 2 foes — Will for half (½level d8).' },
    { key: 'blessingoffervor', name: 'Blessing of Fervor', icon: '💨', cost: 'slot', slvl: 4, minLevel: 10, effect: 'haste', target: 'self', party: true, sounds: FERVOR_SFX, desc: 'The party surges with fervor — an EXTRA attack each turn for 1 turn per 5 levels (the haste choice).' },
  ] },
  // BARD — spontaneous caster (spell SLOTS per level). The bardic-performance
  // CLASS FEATURES (Inspire Courage, Fascinate) are NOT spells and sit beside the
  // spellbook; everything with a spell level (slvl) is a spell that spends a slot.
  bard: { atwill: ATTACK('🗡️'), abilities: [
    // ── Bardic performance (class features) ──
    { key: 'inspire',   name: 'Inspire Courage', icon: '🎶', cost: 'run', uses: 1, effect: 'buff', target: 'self', party: true, persist: true, buff: { toHit: 1, dmg: 1 }, sticky: true, sound: S.bardsong, desc: 'Strike up a song — you and all allies get +1 to hit and damage for the ENTIRE dungeon (struck up once).' },
    { key: 'fascinate', name: 'Fascinate',       icon: '🎵', cost: 'free', effect: 'fascinate', target: 'aoe', maxTargets: 3, sound: S.fascinate, desc: 'Up to 3 foes stand fascinated and lose their turns — until something hits them.' },
    // ── 1st-level spells ──
    { key: 'curelight',    name: 'Cure Light Wounds',    icon: '💚', cost: 'slot', slvl: 1, minLevel: 1, effect: 'heal', heal: 'single', healDice: 1, healCap: 5,  target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 1d8 + caster level (max +5).' },
    // ── 2nd-level spells ──
    { key: 'hideouslaughter', name: 'Hideous Laughter', icon: '😂', cost: 'slot', slvl: 2, minLevel: 4, effect: 'save_debuff', target: 'enemy', save: 'will', debuff: 'paralyzed', sound: S.hideous, desc: 'A foe collapses in helpless laughter — Will save or HELD (helpless, Sneak-Attackable). Each turn it may re-save to recover, but the attempt costs its turn.' },
    { key: 'curemoderate', name: 'Cure Moderate Wounds', icon: '💚', cost: 'slot', slvl: 2, minLevel: 4, effect: 'heal', heal: 'single', healDice: 2, healCap: 10, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 2d8 + caster level (max +10).' },
    { key: 'soundburst',   name: 'Sound Burst',          icon: '🔊', cost: 'slot', slvl: 2, minLevel: 4, effect: 'aoe', target: 'aoe', maxTargets: 3, save: 'fort', die: 8, dice: 1, dtype: 'sonic', sounds: THUNDER_SFX, desc: 'A concussive blast of sound — 1d8 sonic to up to 3 foes, Fort for half.' },
    { key: 'bullsstrength', name: "Bull's Strength",     icon: '💪', cost: 'slot', slvl: 2, minLevel: 4, effect: 'buff', target: 'ally', buff: { toHit: 2, dmg: 2 }, sticky: true, sound: S.invoke, desc: 'Bull-strong — one ally gets +2 to hit and +2 melee damage for the rest of the room.' },
    { key: 'catsgrace',     name: "Cat's Grace",         icon: '🐈', cost: 'slot', slvl: 2, minLevel: 4, effect: 'buff', target: 'ally', buff: { ac: 2, toHit: 1 }, sticky: true, sound: S.invoke, desc: 'Feline-quick — one ally gets +2 AC and +1 ranged to-hit (Dex) for the rest of the room.' },
    { key: 'bearsendurance', name: "Bear's Endurance",   icon: '🐻', cost: 'slot', slvl: 2, minLevel: 4, effect: 'buff', target: 'ally', buff: { conHp: 2 }, sticky: true, sound: S.invoke, desc: 'Bear-hardy — one ally gains temporary HP (+2 per level, from +4 Con) for the rest of the room.' },
    // ── 3rd-level spells ──
    { key: 'haste',     name: 'Haste',           icon: '💨', cost: 'slot', slvl: 3, minLevel: 7, effect: 'haste', target: 'self', party: true, sounds: HASTE_SFX, desc: 'The whole party blurs with speed — an EXTRA attack each turn for 1 turn per 5 caster levels.' },
    { key: 'slow',      name: 'Slow',            icon: '🐌', cost: 'slot', slvl: 3, minLevel: 7, effect: 'slow', target: 'aoe', randN: 2, randDie: 4, maxTargets: 8, save: 'will', sound: S.slow, desc: 'Time drags for a RANDOM 2d4 foes — Will save or be SLOWED (acts only every other turn, easier to hit).' },
    { key: 'goodhope',  name: 'Good Hope',       icon: '🌟', cost: 'slot', slvl: 3, minLevel: 7, effect: 'buff', target: 'self', party: true, buff: { toHit: 2, dmg: 2, save: 2 }, sticky: true, sound: S.bardsong, desc: 'Fill the party with hope — all allies get +2 to hit, damage, and saves for the rest of the room.' },
    { key: 'heroism',   name: 'Heroism',         icon: '🦸', cost: 'slot', slvl: 3, minLevel: 7, effect: 'buff', target: 'ally', buff: { toHit: 2, save: 2 }, sticky: true, sound: S.invoke, desc: 'One ally becomes heroic — +2 to hit and +2 to saves for the rest of the room.' },
    { key: 'dispelmagic', name: 'Dispel Magic',  icon: '🌀', cost: 'slot', slvl: 3, minLevel: 7, effect: 'cleanse', target: 'ally', sound: S.dispel, desc: 'Strip a debuff off an afflicted ally (paralysis / hold / grapple / stun / sickness) — or tear a buff off a foe.' },
  ] },
  // DRUID — prepared nature caster: one casting of each spell per room.
  druid: { atwill: ATTACK('🌿'), note: 'One casting of each spell, per room. WILD SHAPE forms last until you drop them (each usable once per room).', abilities: [
    // ── WILD SHAPE forms (effect:'form'; see Dungeon._abForm). Toggle on/off; each
    // form is usable once per room. Generic druids get Tiger/Bear/Hawk; Rissa gets
    // her own Beast Mode + Promethean in place of Tiger/Bear (Hawk is shared). ──
    { key: 'tigerform', name: 'Tiger Form', icon: '🐯', cost: 'room', uses: 1, effect: 'form', target: 'self', notChar: 'Rissa',
      form: { key: 'tiger', label: 'Tiger Form', glyph: '🐯', art: '/tokens/form_tiger.png', weapon: 'form_tiger', ac: 1, toHit: 2, dmg: 4, sound: '/audio/enemy_yak.mp3' },
      desc: 'Become a DIRE TIGER — pounce on prey with claws + bite (3 attacks at full strength), +2 to hit, +4 damage, +1 AC. Lasts until you change back.' },
    { key: 'bearform', name: 'Bear Form', icon: '🐻', cost: 'room', uses: 1, effect: 'form', target: 'self', notChar: 'Rissa',
      form: { key: 'bear', label: 'Bear Form', glyph: '🐻', art: '/tokens/token-animal-great-spirit-bear-dd-monster-resembles-griz.webp', weapon: 'form_bear', ac: 3, toHit: 2, dmg: 4, tempHpPerLevel: 2, sound: '/audio/enemy_yak.mp3' },
      desc: 'Become a DIRE BEAR — a wall of muscle: claws + bite (3 attacks), +2 to hit, +4 damage, +3 natural-armor AC, and +2 HP per level. Lasts until you change back.' },
    { key: 'hawkform', name: 'Hawk Form', icon: '🦅', cost: 'room', uses: 1, effect: 'form', target: 'self',
      form: { key: 'hawk', label: 'Hawk Form', glyph: '🦅', fly: true, ac: 1, toHit: 1, sound: S.invis },
      desc: 'Take to the sky — FLY out of reach of grounded foes (they cannot hit you), with +1 to hit & AC. You can STILL cast your spells from the air. Lasts until you change back.' },
    { key: 'beastmode', name: 'Beast Mode', icon: '🐲', cost: 'room', uses: 1, effect: 'form', target: 'self', char: 'Rissa',
      form: { key: 'beast', label: 'Beast Mode', glyph: '🐲', art: '/tokens/beast-of-lepidstadt.webp', weapon: 'form_beast', ac: 2, toHit: 3, dmg: 6, tempHpPerLevel: 2, dr: 10, sound: '/audio/rissa_beast.mp3' },
      desc: 'Rissa becomes the BEAST OF LEPIDSTADT — LARGE and monstrously strong: +3 to hit, +6 damage, +2 AC, +2 HP/level, DR 10/adamantine (like Stoneskin), and she can SWAT airborne foes out of the sky. Lasts until she changes back.' },
    { key: 'promethean', name: 'Promethean', icon: '🐙', cost: 'room', uses: 1, effect: 'form', target: 'self', char: 'Rissa',
      form: { key: 'promethean', label: 'Promethean', glyph: '🐙', art: '/tokens/form_promethean.webp', weapon: 'form_promethean', ac: 1, toHit: 2, dmg: 4, sound: '/audio/dragon_roar_rivozair.mp3' },
      desc: 'Rissa unfurls into a MULTI-TENTACLED HORROR — 15-ft reach (strikes flyers too), FOUR tentacle attacks, and every hit GRAPPLES the foe: helpless until it breaks free. Lasts until she changes back.' },
    // ── Buff prayers (sticky room buffs) ──
    { key: 'barkskin',     name: 'Barkskin',         icon: '🌳', cost: 'room', uses: 1, minLevel: 1, effect: 'buff', target: 'ally', buff: { ac: 3 }, sticky: true, sound: S.invoke, desc: 'Bark-tough hide — +3 natural-armor AC to an ally for the rest of the room.' },
    { key: 'magicfang',    name: 'Magic Fang',       icon: '🐾', cost: 'room', uses: 1, minLevel: 1, effect: 'buff', target: 'self', buff: { toHit: 1, dmg: 1 }, sticky: true, sound: S.invoke, desc: 'Bless your natural weapons — +1 to hit and +1 damage for the rest of the room.' },
    { key: 'bullsstrength',name: "Bull's Strength",  icon: '💪', cost: 'room', uses: 1, minLevel: 3, effect: 'buff', target: 'ally', buff: { toHit: 2, dmg: 2 }, sticky: true, sound: S.invoke, desc: 'One ally gets +2 to hit and +2 melee damage for the rest of the room.' },
    { key: 'bearsendurance',name: "Bear's Endurance",icon: '🐻', cost: 'room', uses: 1, minLevel: 3, effect: 'buff', target: 'ally', buff: { conHp: 2 }, sticky: true, sound: S.invoke, desc: 'Bear-hardy — one ally gains temporary HP (+2 per level) for the rest of the room.' },
    { key: 'catsgrace',    name: "Cat's Grace",      icon: '🐈', cost: 'room', uses: 1, minLevel: 3, effect: 'buff', target: 'ally', buff: { ac: 2, toHit: 1 }, sticky: true, sound: S.invoke, desc: 'Feline-quick — one ally gets +2 AC and +1 to hit for the rest of the room.' },
    { key: 'ironskin',     name: 'Iron Skin',        icon: '🪨', cost: 'room', uses: 1, minLevel: 7, effect: 'buff', target: 'ally', buff: {}, dr: 10, sticky: true, sound: S.invoke, desc: "An ally's skin turns to iron — DR 10 against physical blows for the rest of the room." },
    // ── Offensive nature magic ──
    { key: 'entangle',   name: 'Entangle',          icon: '🌿', cost: 'room', uses: 1, effect: 'grease', target: 'aoe', randN: 2, randDie: 4, save: 'reflex', sound: S.entangle, desc: 'Grasping vines erupt — a RANDOM 2d4 foes must make a Reflex save or be ROOTED (rendered prone, losing the turn).' },
    { key: 'shockinggrasp', name: 'Shocking Grasp', icon: '⚡', cost: 'room', uses: 1, minLevel: 1, effect: 'touch', target: 'enemy', die: 6, dice: 'level', dcap: 5, dtype: 'electricity', slvl: 1, sound: S.shock, desc: 'A charged touch — ranged touch attack (level d6, cap 5d6 electricity).' },
    { key: 'lightningbolt', name: 'Lightning Bolt', icon: '⚡', cost: 'room', uses: 1, minLevel: 5, effect: 'aoe', target: 'aoe', maxTargets: 2, save: 'reflex', die: 6, dice: 'level', dcap: 10, dtype: 'electricity', sounds: THUNDER_SFX, desc: 'A bolt skewering 2 foes — Reflex for half (level d6).' },
    { key: 'calllightning', name: 'Call Lightning', icon: '🌩️', cost: 'room', uses: 1, minLevel: 5, effect: 'aoe', target: 'aoe', maxTargets: 2, save: 'reflex', die: 6, dice: 'halflevel', dcap: 5, dtype: 'electricity', sounds: THUNDER_SFX, desc: 'A bolt from the storm strikes 2 foes — Reflex for half (½level d6).' },
    // ── Healing & restoration ──
    { key: 'curelight',  name: 'Cure Light Wounds', icon: '💚', cost: 'room', uses: 1, effect: 'heal', heal: 'single', healDice: 1, healCap: 5, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 1d8 + caster level (max +5).' },
    { key: 'curemoderate',name: 'Cure Moderate Wounds', icon: '💚', cost: 'room', uses: 1, minLevel: 4, effect: 'heal', heal: 'single', healDice: 2, healCap: 10, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 2d8 + caster level (max +10).' },
    { key: 'removeparalysis', name: 'Remove Paralysis', icon: '🩹', cost: 'room', uses: 1, minLevel: 3, effect: 'cleanse', target: 'ally', sound: S.cure, desc: 'Free an ally from paralysis / hold / stun (and other debuffs).' },
    { key: 'dispelmagic', name: 'Dispel Magic',     icon: '🌀', cost: 'room', uses: 1, minLevel: 5, effect: 'cleanse', target: 'ally', sound: S.dispel, desc: 'Strip a debuff off an afflicted ally — or a buff off a foe, if any.' },
  ] },
};

// ── ORACLE repertoire = the CLERIC spell list (cloned so the two stay in sync)
// PLUS the Flame-mystery fire spells and Haste/Slow. Channel Positive rides along
// with the cleric list, so oracles channel exactly like a cleric of their level.
// Oracle is a full SPONTANEOUS caster: cost:'slot' + slotsFor('oracle') already
// gives the oracle (SORC-table) slot progression. Built here, before the img/slvl
// post-processing loop below, so the new abilities are processed too. Oracles KEEP
// Blessing of Fervor from the cleric list (its haste-choice extra attack) AND get
// the full Haste spell below — two distinct options.
KITS.oracle.abilities = [
  ...KITS.cleric.abilities.map(a => ({ ...a })),
  spontaneousSpell(SPELL.burninghands, 1),
  spontaneousSpell(SPELL.scorchingray, 3),
  { key: 'haste', name: 'Haste', icon: '💨', cost: 'slot', slvl: 3, minLevel: 5, effect: 'haste', target: 'self', party: true, sounds: HASTE_SFX, desc: 'The whole party blurs with speed — an EXTRA attack each turn for 1 round per caster level.' },
  spontaneousSpell(SPELL.slow,      5),
  spontaneousSpell(SPELL.fireball,  5),
  spontaneousSpell(SPELL.firesnake, 7),
];

// Spell/ability art (PF1 stock icons copied into public/icons/spells/). Keyed
// by ability key; anything not listed falls back to its emoji glyph.
const ICON_KEYS = new Set([
  'rayoffrost', 'burninghands', 'shockinggrasp', 'grease', 'sleep', 'magicmissile', 'scorchingray', 'holdperson',
  'lightningbolt', 'fireball', 'holysmite', 'channel', 'smite', 'frigidtouch',
  'judgment', 'bane', 'inspire', 'fascinate',
]);
const imgFor = (key) => (ICON_KEYS.has(key) ? `/icons/spells/${key}.jpg` : null);
// PF1e SPELL level (1st–9th) for the divine prayers / nature spells defined
// inline (the shared arcane SPELL defs already carry their own `slvl`). Drives
// the spellbook's level grouping. Class features with no spell level (Channel)
// are intentionally omitted → they bucket under "Other".
const SLVL_BY_KEY = {
  curelight: 1, curemoderate: 2, divinefavor: 1, bless: 1, prayer: 3, searinglight: 3,
  holysmite: 4, boneshatter: 4, breathoflife: 5, raisedead: 5, resurrection: 7,
  entangle: 1, calllightning: 3,
  barkskin: 2, magicfang: 1, bullsstrength: 2, bearsendurance: 2, catsgrace: 2, ironskin: 6,
  shockinggrasp: 1, lightningbolt: 3, curemoderate: 2, removeparalysis: 2, dispelmagic: 3,
};
// Attach an `img` (and a divine `slvl` fallback) to every ability + at-will.
for (const kit of Object.values(KITS)) {
  if (kit.atwill) kit.atwill.img = imgFor(kit.atwill.key);
  for (const ab of kit.abilities) {
    ab.img = ab.img || imgFor(ab.key);   // keep an explicitly-set img (e.g. Detect Evil's bullseye)
    if (ab.slvl == null && SLVL_BY_KEY[ab.key] != null) ab.slvl = SLVL_BY_KEY[ab.key];
  }
}

const DEFAULT_KIT = KITS.fighter;
// Classes a human may pick in the dropdown. Ranger has a kit (Danger uses it)
// but isn't offered — its bow isn't in the staple weapon list.
const SELECTABLE_CLASSES = ['fighter', 'barbarian', 'rogue', 'paladin', 'cleric', 'wizard', 'sorcerer', 'magus', 'inquisitor', 'bard', 'druid', 'oracle'];
function kitFor(classKey) { return KITS[classKey] || DEFAULT_KIT; }
const isPoolClass = (cls) => POOL_CLASSES.has(cls);
const isCaster    = (cls) => CASTER_CLASSES.has(cls);

module.exports = {
  KITS, SPELL, DEFAULT_KIT, SELECTABLE_CLASSES, CASTER_CLASSES, SPONTANEOUS_CLASSES, SLVL_BY_KEY,
  kitFor, isPoolClass, isCaster, isSpontaneous, imgFor,
  spellSlots, spontaneousSlots, slotsFor, roomUses, diceCount, channelUses, smiteUses,
};
