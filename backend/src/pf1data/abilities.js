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
// PF1 full-caster BASE spells/day (cleric/druid/wizard share it) — caps at 4 per spell
// level. This is the BASE only: the +1 domain/school and the casting-stat bonus spells
// are added in slotsFor (NOT baked in here), so a high-Wis cleric with a domain ends up
// at the real PF1 totals.
const CLERIC_SLOTS_BY_LEVEL = {
  1: [1], 2: [2], 3: [2, 1], 4: [3, 2], 5: [3, 2, 1], 6: [3, 3, 2], 7: [4, 3, 2, 1], 8: [4, 3, 3, 2],
  9: [4, 4, 3, 2, 1], 10: [4, 4, 3, 3, 2], 11: [4, 4, 4, 3, 2, 1], 12: [4, 4, 4, 3, 3, 2],
  13: [4, 4, 4, 4, 3, 2, 1], 14: [4, 4, 4, 4, 3, 3, 2], 15: [4, 4, 4, 4, 4, 3, 2, 1], 16: [4, 4, 4, 4, 4, 3, 3, 2],
  17: [4, 4, 4, 4, 4, 4, 3, 2, 1], 18: [4, 4, 4, 4, 4, 4, 3, 3, 2], 19: [4, 4, 4, 4, 4, 4, 4, 3, 3], 20: [4, 4, 4, 4, 4, 4, 4, 4, 4],
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
// PF1 PALADIN / RANGER / ANTIPALADIN spells per day — 4th-level prepared casters:
// no spells until L4, max 4th-level spells. Base values ('0' = a slot only the
// 18-stat bonus grants); _tableSlots folds in the +1/level (1-4) bonus. Empty
// arrays for L1-3 = cannot cast yet.
const PALADIN_SLOTS_BY_LEVEL = {
  1: [], 2: [], 3: [],
  4: [0], 5: [1], 6: [1], 7: [1, 0], 8: [1, 1], 9: [2, 1], 10: [2, 1, 0],
  11: [2, 1, 1], 12: [2, 2, 1], 13: [3, 2, 1, 0], 14: [3, 2, 2, 1], 15: [3, 3, 2, 1],
  16: [3, 3, 3, 2], 17: [4, 3, 3, 2], 18: [4, 4, 3, 3], 19: [4, 4, 4, 3], 20: [4, 4, 4, 4],
};
function _tableSlots(table, level) {
  const arr = table[Math.max(1, Math.min(20, level || 1))] || table[1];
  const out = {};
  arr.forEach((n, i) => { out[i + 1] = n; });   // PURE base spells/day; stat-bonus + domain added in slotsFor
  return out;   // { 1: n, 2: n, … } base slots per spell level
}
// PF1 BONUS SPELLS from a casting-ability MODIFIER (CRB Table 1-3): you gain a bonus
// spell of a given spell level only if your modifier is at least that spell level, plus
// one more for every +4 of modifier beyond it. e.g. a +5 mod → +2 at 1st, +1 at 2nd–5th,
// nothing at 6th+. A 0/'0'-base slot (paladin/ranger at-the-edge) only exists if the
// stat grants it — exactly PF1.
function bonusSpells(spellLevel, mod) {
  if (!mod || mod < spellLevel) return 0;
  return 1 + Math.floor((mod - spellLevel) / 4);
}
function spontaneousSlots(level) { return _tableSlots(SORC_SLOTS_BY_LEVEL, level); }
// Slot table for any per-level slot caster (null = not a slot caster).
const FULL_PREPARED   = new Set(['cleric', 'druid', 'wizard', 'theurge']);          // full 9-level prepared casters (share the cleric/druid/wizard progression)
const FOURTH_PREPARED = new Set(['paladin', 'ranger', 'antipaladin']);   // 4th-level prepared casters — no spells before L4
function slotsFor(cls, level, castMod = 0) {
  let base;
  if (FULL_PREPARED.has(cls))            base = _tableSlots(CLERIC_SLOTS_BY_LEVEL, level);
  else if (FOURTH_PREPARED.has(cls))     base = _tableSlots(PALADIN_SLOTS_BY_LEVEL, level);
  else if (cls === 'inquisitor')         base = _tableSlots(INQ_SLOTS_BY_LEVEL, level);   // 6-level SPONTANEOUS divine, slower
  else if (SPONTANEOUS_CLASSES.has(cls)) base = _tableSlots(SORC_SLOTS_BY_LEVEL, level);
  else return null;
  // ABILITY-SCORE BONUS SPELLS — the caster's Int/Wis/Cha modifier grants extra spells
  // per day (PF1 Table 1-3). castMod is the casting-stat modifier (m.castingMod).
  const mod = castMod | 0;
  if (mod > 0) for (const sl of Object.keys(base)) base[sl] += bonusSpells(+sl, mod);
  // DOMAIN (cleric) / arcane SCHOOL (wizard): +1 spell slot per spell level — we do
  // NOT model opposition schools (Tobias 2026-06-22).
  if (cls === 'cleric' || cls === 'wizard') for (const sl of Object.keys(base)) base[sl] += 1;
  return base;
}

const POOL_CLASSES   = new Set([]);   // (sorcerer is spontaneous-per-level now)
const CASTER_CLASSES = new Set(['wizard', 'sorcerer', 'cleric', 'druid', 'bard', 'inquisitor', 'magus', 'oracle', 'theurge']);   // oracle was missing → its spells rendered as flat buttons instead of the spellbook
const isSpontaneous = (cls) => SPONTANEOUS_CLASSES.has(cls);

// Spell-damage dice count from a level scale.
function diceCount(ab, level) {
  const lvl = Math.max(1, level || 1);
  if (ab.dice === 'level')     return Math.min(ab.dcap || 10, lvl);
  if (ab.dice === 'halflevel') return Math.min(ab.dcap || 5, Math.max(1, Math.floor(lvl / 2)));
  return ab.dice || 1;
}
// How many own-pool uses a 'room' ability gets at a level.
function roomUses(ability, level, m) {
  if (!ability || ability.cost !== 'room') return 0;
  if (typeof ability.uses === 'function') return ability.uses(level, m);   // uses fns may read the member's ability mods (e.g. Channel = 3 + WIS)
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
  glitter: '/audio/40mm_glitter_grenade_sound_effect.mp3',   // Glitterdust (blinding sparkle)
  chainlight: '/audio/wizard_lightningbolt_hetfield_metallica_james.mp3',   // Chain Lightning (Foundry SFX — Hetfield lightning bolt)
};
// Sound POOLS — abilities with `sounds: [...]` pick one at random per cast, so a
// repeated spell doesn't drone the same clip (Fireball / Lightning Bolt / Haste).
const FIREBALL_SFX = ['/audio/fireball_1.mp3', '/audio/fireball_2.mp3', '/audio/fireball_3.mp3', '/audio/fireball_4.mp3'];
const THUNDER_SFX  = ['/audio/thunder_1.mp3', '/audio/thunder_2.mp3', '/audio/thunder_3.mp3', '/audio/thunder_4.mp3', '/audio/thunder_5.mp3', '/audio/thunderclap_slow.mp3'];   // slow clap retired from Chain Lightning into the Lightning Bolt pool
const HASTE_SFX    = ['/audio/spell_haste.mp3', '/audio/spell_haste2.mp3', '/audio/ghosts_n_stuff_intro.mp3'];
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
  dispelmagic:   { key: 'dispelmagic',   name: 'Dispel Magic',   icon: '🌀', cost: 'pool', effect: 'cleanse', target: 'ally', minLevel: 5, slvl: 3, sound: S.dispel, desc: 'End hostile SPELL effects on an ally (hold, slow, magical blindness) — or strip a buff off a foe. Physical grapple/stun/sickness are beyond it (PF1).' },
  dimensiondoor: { key: 'dimensiondoor', name: 'Dimension Door', icon: '🌀', cost: 'pool', effect: 'tpstrike', target: 'ally', minLevel: 7, slvl: 4, sound: S.invoke, desc: 'Fold space around a melee ally: UNTOUCHABLE until your next turn, and their next strike reaches ANY foe (even flyers) with a FULL attack.' },
  teleport:      { key: 'teleport',      name: 'Teleport',       icon: '✨', cost: 'pool', effect: 'tpstrike', target: 'ally', minLevel: 9, slvl: 5, sound: S.invoke, desc: 'Blink a melee ally across the battlefield: UNTOUCHABLE until your next turn, and their next strike reaches ANY foe with a FULL attack.' },
  holdperson:    { key: 'holdperson',    name: 'Hold Person',    icon: '🖐️', cost: 'pool', effect: 'save_debuff', target: 'enemy', save: 'will', debuff: 'paralyzed', onlyHumanoids: true, slvl: 3, sound: S.anchor, desc: 'A HUMANOID foe must save or be HELD (helpless). Each of its turns it may re-save to break free — but the attempt costs its turn either way. Humanoids only (PF1).' },
  grease:        { key: 'grease',        name: 'Grease',         icon: '🛢️', cost: 'pool', effect: 'grease', target: 'aoe', maxTargets: 2, save: 'reflex', minLevel: 1, slvl: 1, sound: S.grease, desc: 'Slick the floor — 2 foes Reflex or fall prone (splat!).' },
  sleep:         { key: 'sleep',         name: 'Sleep',          icon: '💤', cost: 'pool', effect: 'sleep',  target: 'aoe', maxTargets: 3, save: 'will',   minLevel: 1, slvl: 1, sound: S.sleep, desc: 'Up to 3 weaker foes must save or fall asleep — helpless, losing turns until struck.' },
  magicmissile:  { key: 'magicmissile',  name: 'Magic Missile',  icon: '🔮', cost: 'pool', effect: 'missile', target: 'enemy', minLevel: 1, slvl: 1, sound: S.missile, desc: 'Unerring darts of force — 1 dart +1 per 2 levels (max 5), 1d4+1 each, auto-hit.' },
  slow:          { key: 'slow',          name: 'Slow',           icon: '🐌', cost: 'pool', effect: 'slow',   target: 'aoe', randN: 2, randDie: 4, maxTargets: 8, save: 'will', minLevel: 5, slvl: 3, sound: S.slow, desc: 'Time drags for a RANDOM 2d4 foes — Will save or be SLOWED (PF1 staggered): one single action a turn — move OR attack, never both, never a full attack — and −1 AC.' },
  gustofwind:    { key: 'gustofwind',    name: 'Gust of Wind',   icon: '🌪️', cost: 'pool', effect: 'grease', target: 'aoe', randFoes: 3, save: 'fort', minLevel: 4, slvl: 2, sound: S.gust, desc: 'A roaring gale blasts a RANDOM 1d3 foes — Fort save or be knocked prone.' },
  invisibility:  { key: 'invisibility',  name: 'Invisibility',   icon: '👻', img: '/dungeon/buffs/invisible.webp', cost: 'pool', effect: 'invisible', target: 'self', minLevel: 3, slvl: 2, sound: S.invis, desc: "Vanish from sight — enemies can't target you until you attack." },
  charmperson:   { key: 'charmperson',   name: 'Charm Person',    icon: '💞', cost: 'pool', effect: 'charm', target: 'enemy', save: 'will', minLevel: 1, slvl: 1, sound: S.fascinate, desc: 'A living foe, Will save or CHARMED — it regards your party as friends and WON\'T attack you (it only tends its own side). A hit from your party snaps it out. No effect on the mindless (undead / constructs).' },
  shield:        { key: 'shield',        name: 'Shield',         icon: '🛡️', cost: 'pool', effect: 'buff', target: 'self', buff: { ac: 4 }, slvl: 1, sticky: true, sound: S.invoke, desc: 'A wall of force — +4 shield AC for the rest of the room.' },
  catsgrace:     { key: 'catsgrace',     name: "Cat's Grace",    icon: '🐈', cost: 'pool', effect: 'buff', target: 'ally', buff: { ac: 2, toHit: 1, dexMod: 1 }, slvl: 2, sticky: true, sound: S.invoke, desc: 'Feline-quick — one ally gets +2 AC and +1 ranged to-hit (Dex) for the rest of the room.' },
  fly:           { key: 'fly',           name: 'Fly',            icon: '🪽', cost: 'pool', effect: 'buff', target: 'self', fly: true, slvl: 3, sticky: true, sound: S.invis, desc: 'Take to the air — grounded foes CANNOT reach you (immune to non-ranged attacks) for the rest of the room.' },
  coneofcold:    { key: 'coneofcold',    name: 'Cone of Cold',   icon: '🥶', cost: 'pool', effect: 'aoe', target: 'aoe', randBase: 2, randDie: 3, save: 'reflex', die: 6, dice: 'level', dcap: 15, minLevel: 9, dtype: 'cold', slvl: 5, sound: S.coldcone, desc: 'A blast of frost engulfs 2+1d3 foes — Reflex for half (level d6).' },
  disintegrate:  { key: 'disintegrate',  name: 'Disintegrate',   icon: '☢️', cost: 'pool', effect: 'disintegrate', target: 'enemy', maxTargets: 1, save: 'fort', die: 6, dice: 'level', dcap: 20, minLevel: 11, dtype: 'force', slvl: 6, sound: S.disintegrate, desc: 'A thin green ray — ranged touch attack, then 2d6 per caster level (max 40d6). Fort partial: a made save still takes 5d6. Reduced to 0 HP → disintegrated to dust.' },
  firesnake:     { key: 'firesnake',     name: 'Fire Snake',     icon: '🐍', cost: 'pool', effect: 'aoe', target: 'aoe', maxTargets: 4, save: 'reflex', die: 6, dice: 'level', dcap: 15, minLevel: 7, dtype: 'fire', slvl: 5, sounds: FIREBALL_SFX, desc: 'A serpent of flame weaves through up to 4 foes — 1d6 fire per caster level (max 15d6), Reflex for half.' },
  stoneskin:     { key: 'stoneskin',     name: 'Stoneskin',      icon: '🪨', cost: 'pool', effect: 'buff', target: 'ally', buff: {}, dr: 10, slvl: 4, minLevel: 7, sticky: true, sound: S.invoke, desc: 'An ally\'s skin turns to stone — DR 10 against physical blows (melee/claws/chains) for the rest of the room.' },
  // Protection from Evil (Communal) — a 2nd-level party ward. No cost key here;
  // each kit sets it (wizard prepared 'room', sorcerer/cleric/inquisitor 'slot').
  protevil:      { key: 'protevil',      name: 'Protection from Evil (Communal)', icon: '🛡️', img: '/dungeon/buffs/protevil.webp', effect: 'buff', target: 'self', party: true, sticky: true, buff: { ac: 2, save: 2 }, slvl: 2, sound: S.invoke, desc: 'Ward the whole party — +2 AC and +2 to all saves for EVERY ally, for the rest of the room.' },
  darkness:      { key: 'darkness',      name: 'Darkness',       icon: '🌑', effect: 'darkness', target: 'aoe', randBase: 1, randDie: 4, slvl: 2, sound: S.umbral, desc: 'Shroud a RANDOM 1d4+1 foes in magical darkness — they CANNOT attack and CANNOT be attacked for 2 rounds.' },
  // ── 4th-level ──
  blacktentacles: { key: 'blacktentacles', name: 'Black Tentacles', icon: '🦑', effect: 'blacktentacles', target: 'aoe', slvl: 4, sound: '/audio/kraken_crush.mp3', desc: 'Writhing tentacles erupt across the room — EACH ROUND they grapple a random 1d4+1 foes (CMB vs CMD); the grappled are helpless until they tear free. Lasts the room.' },
  infernalhealgreater: { key: 'infernalhealgreater', name: 'Infernal Healing, Greater', icon: '🩸', effect: 'infernalheal', target: 'ally', heal: 4, sticky: true, slvl: 4, sound: S.cure, desc: 'Diabolic ichor knits the ally with the LEAST HP (or the caster, if everyone is at full health) — fast healing 4 (heals 4 HP at the start of each of their turns) for the rest of the room.' },
  invisgreater:  { key: 'invisgreater',  name: 'Invisibility, Greater', icon: '🫥', img: '/dungeon/buffs/invisible.webp', effect: 'invisible', greater: true, target: 'ally', slvl: 4, sound: S.invis, desc: 'Total concealment for the whole fight — you STAY invisible even when you attack. Cast it on a rogue ally and they Sneak Attack every foe that cannot see them.' },
  riverofwind:   { key: 'riverofwind',   name: 'River of Wind',  icon: '🌬️', effect: 'grease', target: 'aoe', randN: 3, randDie: 4, save: 'fort', slvl: 4, sound: S.gust, desc: 'A roaring torrent of air bowls over a RANDOM 3d4 foes — Fortitude save or be knocked prone.' },
  // ── 5th-level ──
  stoneskincomm: { key: 'stoneskincomm', name: 'Stoneskin (Communal)', icon: '🪨', effect: 'buff', target: 'self', party: true, buff: {}, dr: 10, sticky: true, slvl: 5, sound: S.invoke, desc: 'The WHOLE party\'s skin turns to stone — DR 10 vs physical blows for every ally, for the rest of the room.' },
  // Greater Magic Weapon — the CRAFT priests' (Brigh/Casandalee) signature team buff: it
  // bumps the party's weapon potency. +1 enhancement per 4 caster levels (max +5), applied
  // as +N to hit & +N damage to EVERY ally for the room. The `gmw` flag drives the level
  // scaling in Dungeon._abBuff (like Inspire Courage).
  greatermagicweapon: { key: 'greatermagicweapon', name: 'Greater Magic Weapon', icon: '🗡️', img: '/dungeon/buffs/bullsstrength.webp', effect: 'buff', target: 'self', party: true, sticky: true, gmw: true, slvl: 3, sound: S.invoke, desc: 'Bless the party\'s weapons — +1 enhancement per 4 caster levels (max +5): +N to hit and +N damage for EVERY ally, for the rest of the room.' },
  cloudkill:     { key: 'cloudkill',     name: 'Cloudkill',      icon: '☠️', effect: 'aoe', target: 'aoe', randN: 3, randDie: 4, maxTargets: 8, save: 'fort', die: 4, dice: 'level', dcap: 10, dtype: 'poison', slvl: 5, sound: S.acid, desc: 'A roiling bank of poison gas engulfs a RANDOM 3d4 foes — Fortitude for half (level d4 poison).' },
  suffocation:   { key: 'suffocation',   name: 'Suffocation',    icon: '🫁', effect: 'savedie', target: 'enemy', save: 'fort', slvl: 5, sound: S.umbral, desc: 'Rip the air from one creature\'s lungs (no effect on undead/constructs) — Fortitude save or DIE; a made save still takes heavy damage.' },
  overlandflight:{ key: 'overlandflight',name: 'Overland Flight', icon: '🕊️', effect: 'overlandflight', target: 'self', slvl: 5, sound: S.invis, desc: 'Soar for the REST OF THE DUNGEON — grounded foes cannot reach you, and you can still cast on the wing. A FREE action, cast once per dungeon (like Mage Armor).' },
  // ── MAGUS spellbook additions (also reuse grease/shield/scorchingray/fly/haste/
  //    dispelmagic/stoneskin/disintegrate/overlandflight from above) ──
  vanish:        { key: 'vanish',        name: 'Vanish',         icon: '👻', effect: 'invisible', target: 'self', slvl: 1, sound: S.invis, desc: "Wink out of sight — enemies can't target you until you attack (a short-lived Invisibility)." },
  bladelash:     { key: 'bladelash',     name: 'Blade Lash',     icon: '🌀', effect: 'bladelash', target: 'enemy', slvl: 1, sound: S.shock, desc: 'Your blade lashes out like a whip — strike one foe and TRIP it (combat-maneuver check); on a success it is knocked prone and loses its turn.' },
  glitterdust:   { key: 'glitterdust',   name: 'Glitterdust',    icon: '✨', effect: 'glitterdust', target: 'aoe', randBase: 1, randDie: 4, save: 'will', slvl: 2, sound: S.glitter, desc: 'A burst of clinging gold dust — a RANDOM 1d4 foes must make a Will save or be BLINDED: −4 to hit and denied their Dex (easier to hit, Sneak-Attackable) for a few rounds.' },
  mirrorimage:   { key: 'mirrorimage',   name: 'Mirror Image',   icon: '🪞', effect: 'mirrorimage', target: 'self', slvl: 2, sound: S.invis, desc: 'Conjure shimmering duplicates (1d4 + 1 per 3 levels, max 8) — each enemy attack that would hit you instead destroys an image, until they are all gone. Lasts the room.' },
  bladeddash:    { key: 'bladeddash',    name: 'Bladed Dash',    icon: '💨', effect: 'bladeddash', target: 'enemy', slvl: 2, sound: S.haste, desc: 'Dash through the fray with a single deadly cut — strike one foe, then you become UNTARGETABLE (no attack, buff, or heal can reach you) until your next turn.' },
  displacement:  { key: 'displacement',  name: 'Displacement',   icon: '🌫️', effect: 'buff', target: 'self', displace: true, sticky: true, slvl: 3, sound: S.invis, desc: 'Your form blurs and slips aside — 50% of attacks that would hit you MISS instead, for the rest of the room.' },
  fireshield:    { key: 'fireshield',    name: 'Fire Shield',    icon: '🔥', effect: 'buff', target: 'self', fireShield: true, sticky: true, slvl: 4, sound: S.invoke, desc: 'Wreathe yourself in flame — any foe that hits you in melee is scorched for 1d6 + level fire. Lasts the room.' },
  elementalbody: { key: 'elementalbody', name: 'Elemental Body',  icon: '🌪️', effect: 'buff', target: 'self', elemBody: true, sticky: true, slvl: 4, sound: S.invoke, desc: 'Become a being of raw element — IMMUNE to critical hits and to paralysis, stun, sickening & blinding, for the rest of the room.' },
  dimensionalblade: { key: 'dimensionalblade', name: 'Dimensional Blade', icon: '🗡️', effect: 'dimensionalblade', target: 'self', freeAction: true, slvl: 5, sound: S.anchor, desc: 'Fold your weapon a half-step out of phase — a FREE action: your strikes resolve as TOUCH attacks (ignoring armor & natural armor) for 1 round.' },
  chainlightning:{ key: 'chainlightning',name: 'Chain Lightning', icon: '⚡', effect: 'aoe', target: 'aoe', maxTargets: 10, randBase: 4, randDie: 6, save: 'reflex', die: 6, dice: 'level', dcap: 15, dtype: 'electricity', slvl: 6, sound: null, desc: 'A bolt forks from foe to foe — 4 + 1d6 enemies (5–10), Reflex for half (level d6, cap 15d6).' },   // no fixed sound → rotates through the SND.lightning playlist like Lightning Bolt (Tobias 2026-07-03; the Hetfield one-off stays on Storm of Vengeance)
  dispelmagicgreater: { key: 'dispelmagicgreater', name: 'Dispel Magic, Greater', icon: '🌀', effect: 'cleanse', greater: true, target: 'ally', slvl: 6, sound: S.dispel, desc: 'A sweeping unweaving — end ALL hostile SPELL effects on an ally (hold, slow, magical blindness), or tear every buff off a foe. Physical conditions stay (PF1).' },
  trueseeing:    { key: 'trueseeing',    name: 'True Seeing',     icon: '👁️', effect: 'buff', target: 'self', trueSeeing: true, sticky: true, slvl: 6, sound: S.invoke, desc: 'Your eyes pierce all deception — see through darkness, ignore illusions, and strike the invisible. Lasts the room.' },
  // ── HIGH ARCANE (7th–9th) — without these, a sorcerer past L13 had the SLOTS
  //    but no spells to put in them (Josh: "L15, never got my 7th-level spells").
  delayedfireball: { key: 'delayedfireball', name: 'Delayed Blast Fireball', icon: '🔥', effect: 'aoe', target: 'aoe', maxTargets: 8, save: 'reflex', die: 6, dice: 'level', dcap: 20, dtype: 'fire', slvl: 7, sounds: FIREBALL_SFX, desc: 'A roiling fireball engulfs up to 8 foes — 1d6 fire per caster level (max 20d6), Reflex for half.' },
  fingerofdeath: { key: 'fingerofdeath', name: 'Finger of Death', icon: '💀', effect: 'savedie', target: 'enemy', save: 'fort', slvl: 7, sound: S.umbral, desc: 'A word of death stops one heart (no effect on undead/constructs) — Fortitude save or DIE; a made save still takes heavy negative damage.' },
  horridwilting: { key: 'horridwilting', name: 'Horrid Wilting', icon: '🥀', effect: 'aoe', target: 'aoe', maxTargets: 10, save: 'fort', die: 6, dice: 'level', dcap: 20, dtype: 'negative', slvl: 8, sound: S.umbral, desc: 'Moisture is ripped from up to 10 foes — 1d6 per caster level (max 20d6), Fortitude for half.' },
  polarray: { key: 'polarray', name: 'Polar Ray', icon: '❄️', effect: 'touch', target: 'enemy', die: 6, dice: 'level', dcap: 25, dtype: 'cold', slvl: 8, sound: S.coldcone, desc: 'A lance of utter cold — ranged touch, 1d6 per caster level (max 25d6).' },
  meteorswarm: { key: 'meteorswarm', name: 'Meteor Swarm', icon: '☄️', effect: 'aoe', target: 'aoe', maxTargets: 12, save: 'reflex', die: 6, dice: 'level', dcap: 24, dtype: 'fire', slvl: 9, sounds: FIREBALL_SFX, desc: 'Four blazing meteors scatter the room — up to 12 foes, 1d6 fire per caster level (max 24d6), Reflex for half.' },
  wailbanshee: { key: 'wailbanshee', name: 'Wail of the Banshee', icon: '😱', effect: 'savedie', target: 'enemy', save: 'fort', slvl: 9, sound: S.umbral, desc: 'A keening cry of death (no effect on undead/constructs) — Fortitude save or DIE; a made save still takes heavy damage.' },
  // ── HIGH-LEVEL LIST EXPANSION (Tobias approved 2026-07-02) — CRB staples riding
  // existing effects, filling the cliff above 5th (cleric had NO 6/8/9th spells).
  flamestrike:    { key: 'flamestrike',    name: 'Flame Strike',      icon: '🔥', effect: 'aoe', target: 'aoe', maxTargets: 4, save: 'reflex', die: 6, dice: 'level', dcap: 15, dtype: 'fire', slvl: 5, sounds: FIREBALL_SFX, desc: 'A column of divine fire scours up to 4 foes — 1d6 per caster level (max 15d6), Reflex for half.' },
  slayliving:     { key: 'slayliving',     name: 'Slay Living',       icon: '☠️', effect: 'savedie', target: 'enemy', save: 'fort', slvl: 5, sound: S.umbral, desc: 'A death-touch stops one living heart (no effect on undead/constructs) — Fortitude save or DIE; a made save still takes heavy damage.' },
  healspell:      { key: 'healspell',      name: 'Heal',              icon: '💖', effect: 'heal', heal: 'single', healDice: 15, healCap: 25, target: 'ally', slvl: 6, sound: '/audio/spell_cure.mp3', desc: 'A torrent of positive energy knits the most-hurt ally — 15d8 + caster level (max +25).' },
  bladebarrier:   { key: 'bladebarrier',   name: 'Blade Barrier',     icon: '🌪️', effect: 'aoe', target: 'aoe', maxTargets: 4, save: 'reflex', die: 6, dice: 'level', dcap: 15, slvl: 6, sound: '/audio/spell_holysmite.mp3', desc: 'A whirling wall of blades slices through up to 4 foes — 1d6 per caster level (max 15d6), Reflex for half.' },
  firestorm:      { key: 'firestorm',      name: 'Fire Storm',        icon: '🌋', effect: 'aoe', target: 'aoe', maxTargets: 6, save: 'reflex', die: 6, dice: 'level', dcap: 20, dtype: 'fire', slvl: 8, sounds: FIREBALL_SFX, desc: 'Sheets of divine flame roar over up to 6 foes — 1d6 per caster level (max 20d6), Reflex for half.' },
  massheal:       { key: 'massheal',       name: 'Mass Heal',         icon: '💗', effect: 'heal', heal: 'party', massHeal: true, healDice: 15, healCap: 25, target: 'ally', slvl: 9, sound: '/audio/spell_channel_charge.mp3', desc: 'A tidal wave of positive energy — the WHOLE party heals 15d8 + caster level (max +25).' },
  implosion:      { key: 'implosion',      name: 'Implosion',         icon: '🕳️', effect: 'savedie', target: 'enemy', save: 'fort', slvl: 9, sound: S.umbral, desc: 'A creature\'s body collapses in on itself (no effect on undead/constructs) — Fortitude save or DIE; a made save still takes heavy damage.' },
  freezingsphere: { key: 'freezingsphere', name: 'Freezing Sphere',   icon: '🧊', effect: 'aoe', target: 'aoe', maxTargets: 6, save: 'reflex', die: 6, dice: 'level', dcap: 15, dtype: 'cold', slvl: 6, sound: '/audio/spell_coneofcold.mp3', desc: 'A globe of absolute cold detonates among up to 6 foes — 1d6 per caster level (max 15d6), Reflex for half.' },
  stormofvengeance: { key: 'stormofvengeance', name: 'Storm of Vengeance', icon: '🌩️', effect: 'aoe', target: 'aoe', maxTargets: 6, save: 'reflex', die: 6, dice: 'level', dcap: 20, dtype: 'electricity', slvl: 9, sound: '/audio/wizard_lightningbolt_hetfield_metallica_james.mp3', desc: 'A black tempest of hail and lightning batters up to 6 foes — 1d6 per caster level (max 20d6), Reflex for half.' },
  dominateperson:  { key: 'dominateperson',  name: 'Dominate Person',  icon: '💫', effect: 'dominate', target: 'enemy', save: 'will', slvl: 5, sound: '/audio/spell_fascinate.mp3', desc: 'Seize a foe\'s mind — Will save or it FIGHTS FOR YOU, savaging its own allies each turn (it re-saves each turn; breaks if you fall). No effect on the mindless.' },
  dominatemonster: { key: 'dominatemonster', name: 'Dominate Monster', icon: '🌀', effect: 'dominate', target: 'enemy', save: 'will', slvl: 9, sound: '/audio/spell_fascinate.mp3', desc: 'Seize ANY creature\'s mind — Will save or it FIGHTS FOR YOU, savaging its own allies each turn (re-saves each turn; breaks if you fall). No effect on the mindless.' },
  // ── Wave-2 expansion (Tobias approved 2026-07-03) ──
  heroismgreater:  { key: 'heroismgreater',  name: 'Greater Heroism',     icon: '🦸', effect: 'buff', target: 'ally', buff: { toHit: 4, save: 4 }, sticky: true, slvl: 5, sound: '/audio/spell_buff_invoke.mp3', desc: 'One ally becomes a LEGEND — +4 to hit and +4 to saves for the rest of the room.' },
  masssuggestion:  { key: 'masssuggestion',  name: 'Mass Suggestion',     icon: '🗣️', effect: 'masscharm', target: 'aoe', maxTargets: 3, save: 'will', slvl: 6, sound: '/audio/spell_fascinate.mp3', desc: 'Up to 3 foes, Will save or CHARMED — they stop attacking the party; a hit snaps each out. No effect on the mindless.' },
  banishment:      { key: 'banishment',      name: 'Banishment',          icon: '🚪', effect: 'savedie', target: 'enemy', save: 'will', onlyOutsiders: true, slvl: 5, sound: '/audio/spell_dimensional_anchor.mp3', desc: 'Hurl an OUTSIDER back to its home plane — Will save or GONE; a made save still wracks it. Only works on outsiders (demons, devils, fiends).' },
  waveexhaustion:  { key: 'waveexhaustion',  name: 'Waves of Exhaustion', icon: '🌊', effect: 'exhaust', target: 'aoe', maxTargets: 6, slvl: 7, sound: '/audio/spell_umbral_bolt.mp3', desc: 'A wave of crushing fatigue — up to 6 LIVING foes are EXHAUSTED, NO save (one action a turn, −1 hit, −1 AC). Undead and constructs are untouched.' },
  prismaticspray:  { key: 'prismaticspray',  name: 'Prismatic Spray',     icon: '🌈', effect: 'prismatic', target: 'aoe', maxTargets: 6, die: 6, dice: 'level', dcap: 12, slvl: 7, sound: '/audio/spell_holysmite.mp3', desc: 'A fan of clashing rays — every foe struck takes a RANDOM element for level d6 (Reflex half, max 12d6), and a violet ray (1-in-8) UNMAKES the living outright on a failed Fortitude save.' },
  sunburst:        { key: 'sunburst',        name: 'Sunburst',            icon: '☀️', effect: 'aoe', target: 'aoe', maxTargets: 6, save: 'reflex', die: 6, dice: 'level', dcap: 12, blindRider: true, slvl: 8, sound: '/audio/spell_searinglight.mp3', desc: 'A globe of blazing daylight — up to 6 foes take level d6 (max 12d6, Reflex half); a failed save also BLINDS for 3 rounds.' },
  // ── NECROMANCY (Draymus's specialty; char-gated to him in the wizard kit) ──
  chilltouch:      { key: 'chilltouch',      name: 'Chill Touch',         icon: '🖐️', effect: 'touch', target: 'enemy', die: 6, dice: 'halflevel', dcap: 5, dtype: 'negative', slvl: 1, sound: S.umbral, desc: 'A ghostly touch of the grave — ranged touch for ½level d6 negative energy (max 5d6); the chill of undeath. No effect on undead.' },
  enervation:      { key: 'enervation',      name: 'Enervation',          icon: '🩸', effect: 'touch', target: 'enemy', die: 4, dice: 'halflevel', dcap: 8, dtype: 'negative', slvl: 4, sound: S.umbral, desc: 'A black ray of soul-draining negative energy — ranged touch, ½level d4 (max 8d4); the grave saps the living. No effect on undead.' },
  // ── SUMMON UNDEAD I–IX (Draymus) — the necromancer's Summon Monster line, but he
  //    raises UNDEAD. Each summons a CR-appropriate undead that fights FOR the party
  //    for ~rounds/level, does NOT block room-clear, and isn't targetable by the party.
  //    (Phase 1: foes don't yet turn on the summons — no soak.) `summon` = {key,count}.
  //   PF1 Summon Monster counts (the "most bodies" default — no player choice step):
  //   1 at 1st, 1d3 at 2nd, then 1d4+1 of an escalating undead tier. `pool` = the
  //   critters at that CR; ONE kind is picked at random per cast, then `count` rolled.
  summonundead1: { key: 'summonundead1', name: 'Summon Undead I',    icon: '☠️', effect: 'summon', target: 'self', slvl: 1, summon: { pool: ['skeleton', 'ghoul'], count: 1 },        sound: S.umbral, desc: 'Tear ONE lesser undead (CR ⅓–1) from the grave to fight for the party for a few rounds. (Doesn\'t block clearing the room; foes CAN turn on it — it soaks.)' },
  summonundead2: { key: 'summonundead2', name: 'Summon Undead II',   icon: '☠️', effect: 'summon', target: 'self', slvl: 2, summon: { pool: ['skeleton', 'ghoul'], count: '1d3' },     sound: S.umbral, desc: 'Raise 1d3 lesser undead (CR ⅓–1) to fight for the party for a few rounds.' },
  summonundead3: { key: 'summonundead3', name: 'Summon Undead III',  icon: '☠️', effect: 'summon', target: 'self', slvl: 3, summon: { pool: ['skeleton', 'ghoul'], count: '1d4+1' },   sound: S.umbral, desc: 'Raise 1d4+1 lesser undead (CR ⅓–1) — a shambling horde — to fight for the party for a few rounds.' },
  summonundead4: { key: 'summonundead4', name: 'Summon Undead IV',   icon: '☠️', effect: 'summon', target: 'self', slvl: 4, summon: { pool: ['skeletal_champion'], count: '1d4+1' },   sound: S.umbral, desc: 'Raise 1d4+1 SKELETAL CHAMPIONS (CR 2) to fight for the party for a few rounds.' },
  summonundead5: { key: 'summonundead5', name: 'Summon Undead V',    icon: '☠️', effect: 'summon', target: 'self', slvl: 5, summon: { pool: ['wight', 'shadow', 'fire_skeleton'], count: '1d4+1' }, sound: S.umbral, desc: 'Raise 1d4+1 CR-3 undead (wight / shadow / fire skeleton) to fight for the party for a few rounds.' },
  summonundead6: { key: 'summonundead6', name: 'Summon Undead VI',   icon: '☠️', effect: 'summon', target: 'self', slvl: 6, summon: { pool: ['vampire_spawn', 'fungal_pirate'], count: '1d4+1' }, sound: S.umbral, desc: 'Raise 1d4+1 CR-4/5 undead (vampire spawn / fungal dead) to fight for the party for a few rounds.' },
  summonundead7: { key: 'summonundead7', name: 'Summon Undead VII',  icon: '☠️', effect: 'summon', target: 'self', slvl: 7, summon: { pool: ['fungal_pirate', 'skeletal_ogre'], count: '1d4+1' }, sound: S.umbral, desc: 'Raise 1d4+1 CR-5/6 undead (fungal dead / skeletal ogre) to fight for the party for a few rounds.' },
  summonundead8: { key: 'summonundead8', name: 'Summon Undead VIII', icon: '☠️', effect: 'summon', target: 'self', slvl: 8, summon: { pool: ['fungal_oracle'], count: '1d4+1' },        sound: S.umbral, desc: 'Raise 1d4+1 FUNGAL ORACLES (CR 7) to fight for the party for a few rounds.' },
  summonundead9: { key: 'summonundead9', name: 'Summon Undead IX',   icon: '☠️', effect: 'summon', target: 'self', slvl: 9, summon: { pool: ['vampire', 'ghoul_crusader'], count: '1d4+1' }, sound: S.umbral, desc: 'Raise 1d4+1 CR-8/9 undead (vampires / ghoul crusaders) — an army of the dead — to fight for the party for a few rounds.' },
  // SUMMON DEVIL I–VII — Jason's Asmodean pact (flavor:'devil' → called up from Hell, LE).
  // Built on the same summon engine as Summon Undead; the devils bring their own SR / DR /
  // flight / resistances (from _makeEnemy) — tough allies that SOAK and fight for the party.
  summondevil1: { key: 'summondevil1', name: 'Summon Devil I',    icon: '😈', effect: 'summon', target: 'self', slvl: 3, summon: { flavor: 'devil', pool: ['imp'],                          count: '1d3' },   sound: S.invoke, desc: 'Seal an infernal pact — 1d3 IMPS (CR 2) march up from Hell to fight for the party for a few rounds. (They soak hits; foes CAN turn on them.)' },
  summondevil2: { key: 'summondevil2', name: 'Summon Devil II',   icon: '😈', effect: 'summon', target: 'self', slvl: 4, summon: { flavor: 'devil', pool: ['imp', 'accuser_devil'],         count: '1d4+1' }, sound: S.invoke, desc: 'Call up 1d4+1 lesser devils (imps / accusers, CR 2–3) to fight for the party for a few rounds.' },
  summondevil3: { key: 'summondevil3', name: 'Summon Devil III',  icon: '😈', effect: 'summon', target: 'self', slvl: 5, summon: { flavor: 'devil', pool: ['accuser_devil'],                count: '1d4+1' }, sound: S.invoke, desc: 'Call up 1d4+1 ACCUSER DEVILS (CR 3) — spying, hexing fiends — to fight for the party for a few rounds.' },
  summondevil4: { key: 'summondevil4', name: 'Summon Devil IV',   icon: '😈', effect: 'summon', target: 'self', slvl: 6, summon: { flavor: 'devil', pool: ['erinyes'],                      count: 1 },       sound: S.invoke, desc: 'Call up an ERINYES (CR 8) — a fallen-angel archer — to fight for the party for a few rounds.' },
  summondevil5: { key: 'summondevil5', name: 'Summon Devil V',    icon: '😈', effect: 'summon', target: 'self', slvl: 7, summon: { flavor: 'devil', pool: ['bone_devil'],                    count: 1 },       sound: S.invoke, desc: 'Call up a BONE DEVIL (CR 9) — a skeletal osyluth — to fight for the party for a few rounds.' },
  summondevil6: { key: 'summondevil6', name: 'Summon Devil VI',   icon: '😈', effect: 'summon', target: 'self', slvl: 8, summon: { flavor: 'devil', pool: ['barbed_devil', 'bomb_devil'],    count: '1d3' },   sound: S.invoke, desc: 'Call up 1d3 greater devils (barbed / bomb devils, CR 11) to fight for the party for a few rounds.' },
  summondevil7: { key: 'summondevil7', name: 'Summon Devil VII',  icon: '😈', effect: 'summon', target: 'self', slvl: 9, summon: { flavor: 'devil', pool: ['horned_devil'],                  count: 1 },       sound: S.invoke, desc: 'Seal the ultimate pact — a HORNED DEVIL (CR 16), a cornugon champion of Hell, marches up to fight for the party for a few rounds.' },
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
// At-will CANTRIPS — a caster's unlimited ranged-touch attack. The caster CHOOSES
// among them (cold / acid / electricity); each uses the improved model: casting
// stat to-hit AND to-damage (1d6 + casting mod), with BAB-based iterative attacks
// (see Dungeon._abCantrip). cantrip:true flags the improved path.
const RAY_OF_FROST = { key: 'rayoffrost', name: 'Ray of Frost', icon: '❄️', effect: 'bolt', target: 'enemy', die: 6, dice: 1, dtype: 'cold', sound: S.frost, cantrip: true, desc: 'At-will ranged touch — 1d6 + casting mod COLD (iterates with BAB).' };
const ACID_SPLASH  = { key: 'acidsplash', name: 'Acid Splash', icon: '🟢', effect: 'bolt', target: 'enemy', die: 6, dice: 1, dtype: 'acid', sound: '/audio/spell_acidsplash.mp3', cantrip: true, desc: 'At-will ranged touch — 1d6 + casting mod ACID (iterates with BAB).' };
const JOLT         = { key: 'jolt', name: 'Jolt', icon: '⚡', effect: 'bolt', target: 'enemy', die: 6, dice: 1, dtype: 'electricity', sound: '/audio/spell_jolt.mp3', cantrip: true, desc: 'At-will ranged touch — 1d6 + casting mod ELECTRICITY (iterates with BAB).' };
// Flame-oracle at-will — the fiery counterpart (Produce Flame); a 4th cantrip kept
// for flame casters (Elfrip) on top of the universal three.
const PRODUCE_FLAME = { key: 'produceflame', name: 'Produce Flame', icon: '🔥', effect: 'bolt', target: 'enemy', die: 6, dice: 1, dtype: 'fire', sound: S.fire, cantrip: true, desc: 'At-will ranged touch — 1d6 + casting mod FIRE (iterates with BAB).' };
// The universal cantrip choices every caster picks among (cold / acid / electricity).
const CANTRIPS = [RAY_OF_FROST, ACID_SPLASH, JOLT];
const CANTRIP_BY_KEY = { rayoffrost: RAY_OF_FROST, acidsplash: ACID_SPLASH, jolt: JOLT, produceflame: PRODUCE_FLAME };

let KITS = {   // 'let' so the DB-generated kits can override it below (Phase 3); hand-coded block is the FALLBACK
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
  // BLOODRAGER (ACG) — a raging arcane warrior: Rage + Cleave like a barbarian, and
  // SLOW spontaneous self-buff spells (a bloodline surge). Full BAB, d10; his spells
  // come late & few (PF1 bloodrager: 1st spell at L4), modeled here as a room-cost
  // personal Bloodline Surge that unlocks at L4.
  bloodrager: { atwill: ATTACK('⚔️'), abilities: [
    { key: 'cleave', name: 'Cleave', icon: '🪓', cost: 'free', effect: 'cleave', target: 'enemy', acPen: 2, desc: 'Hit your target and a second foe (−2) — every foe you DROP grants another swing, chaining until you stop felling them — but you drop your guard (−2 AC) this turn.' },
    { key: 'rage',   name: 'Bloodrage', icon: '🩸', cost: 'free', freeAction: true, effect: 'buff', target: 'self', buff: { toHit: 2, dmg: 2, acPen: 2, save: 1 }, sticky: true, sound: S.rage, desc: 'Fly into a BLOODRAGE for the rest of the room (FREE action — still attack this turn): +2 to hit & damage and +1 Will, but −2 AC.' },
    { key: 'bloodlinesurge', name: 'Bloodline Surge', icon: '💥', cost: 'room', uses: 1, minLevel: 4, effect: 'buff', target: 'self', buff: { toHit: 1, dmg: 3, ac: 2 }, sticky: true, sound: S.invoke, desc: 'A bloodrager\'s slow-won magic surges into his own frame — +1 to hit, +3 damage, +2 AC for the rest of the room (self only; unlocks at level 4). Once per room.' },
    { key: 'taunt',  name: 'Taunt',  icon: '📢', cost: 'room', uses: 1, effect: 'taunt', target: 'aoe', save: 'will', sound: '/audio/taunt_predator.mp3', desc: 'A furious challenge — EVERY enemy must make a Will save or be forced to attack YOU on its next turn. Once per room.' },
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
    { key: 'channel', name: 'Channel Positive', icon: '💖', cost: 'room', uses: channelUses, effect: 'heal', heal: 'party', target: 'ally', sound: S.charge, desc: 'Channel positive energy — heal the whole party (scales with level). Selective Channeling (feat, taken early): the burst touches only whom you intend.' },
    // ── Paladin spells (home-rule: spellcasting from level 1, the slowest pace —
    //    a new spell level every 3 character levels). One casting each per room. ──
    { key: 'shieldoffaith',    name: 'Shield of Faith',     icon: '🛡️', cost: 'room', uses: 1, minLevel: 1,  slvl: 1, effect: 'buff', target: 'ally', buff: { deflect: 2 }, sticky: true, sound: S.invoke, desc: '+2 DEFLECTION AC to the lowest-AC ally who\'d actually gain (deflection does NOT stack with a Ring of Protection) for the rest of the room. (1st-level paladin spell.)' },
    { key: 'bullsstrength',    name: "Bull's Strength",     icon: '💪', cost: 'room', uses: 1, minLevel: 4,  slvl: 2, effect: 'buff', target: 'ally', buff: { toHit: 2, dmg: 2 }, sticky: true, sound: S.invoke, desc: 'One martial ally gets +2 to hit and +2 melee damage for the rest of the room. (2nd-level paladin spell, level 4.)' },
    { key: 'prayer',           name: 'Prayer',              icon: '📿', cost: 'room', uses: 1, minLevel: 7,  slvl: 3, effect: 'buff', target: 'self', party: true, buff: { toHit: 1, dmg: 1, save: 1 }, enemyPenalty: 1, sticky: true, sound: S.prayer, desc: 'ALL allies +1 to hit, damage & saves; ALL enemies −1, for the rest of the room. (3rd-level paladin spell, level 7.)' },
    { key: 'blessingoffervor', name: 'Blessing of Fervor',  icon: '💨', cost: 'room', uses: 1, minLevel: 10, slvl: 4, effect: 'haste', target: 'self', party: true, sounds: FERVOR_SFX, desc: 'The party surges with fervor — an EXTRA attack each turn for 1 turn per 5 levels (the haste choice). (4th-level paladin spell, level 10.)' },
  ] },
  // CLERIC — PREPARED divine caster (Tobias): a WIDE prayer list, each spell
  // castable ONCE PER ROOM (cost:'room', uses:1) — like the wizard's spellbook,
  // NOT a shared spontaneous slot pool. CHANNEL is a class feature (3 + WIS uses);
  // BLESS is run-long (cast once). slvl drives the save DC + the buff-priority
  // ranking; minLevel gates when each prayer becomes available.
  cleric: { atwill: ATTACK('🔨'), abilities: [
    { key: 'channel',      name: 'Channel Positive',     icon: '💖', cost: 'room', uses: (level, m) => 3 + Math.max(0, (m && m.mods && m.mods.wis) || 0), effect: 'heal', heal: 'party', target: 'ally', sound: S.charge, desc: 'Channel positive energy — heal the whole party for ½level d6 (PF1e). 3 + WIS mod uses per room (PF1\'s 3 + CHA, keyed to Wisdom so clerics stay SAD). Selective Channeling (feat, taken early): the burst touches only whom you intend.' },
    // ── 1st-level prayers ──
    { key: 'curelight',    name: 'Cure Light Wounds',    icon: '💚', cost: 'room', uses: 1, slvl: 1, effect: 'heal', heal: 'single', healDice: 1, healCap: 5,  target: 'ally', sound: S.cure,    desc: 'Heal the most-hurt ally — 1d8 + caster level (max +5). Once per room.' },
    { key: 'shieldoffaith',name: 'Shield of Faith',      icon: '🛡️', cost: 'room', uses: 1, slvl: 1, effect: 'buff', target: 'ally', buff: { deflect: 2 }, sticky: true, sound: S.invoke, desc: '+2 DEFLECTION AC to the lowest-AC ally who\'d gain (no stack with a Ring of Protection) for the rest of the room.' },
    { key: 'divinefavor',  name: 'Divine Favor',         icon: '🙏', cost: 'room', uses: 1, slvl: 1, effect: 'buff', target: 'self', buff: { toHit: 3, dmg: 3 }, sticky: true, sound: S.invoke,   desc: '+3 to hit and +3 damage to yourself for the rest of the room.' },
    { key: 'bless',        name: 'Bless',                icon: '✨', cost: 'run',  uses: 1, slvl: 1, effect: 'buff', target: 'self', party: true, persist: true, buff: { toHit: 1 }, sticky: true, sound: S.cure, desc: 'All allies gain +1 to hit for the ENTIRE dungeon — cast once; it never fades between rooms.' },
    // ── 2nd-level prayers ──
    { ...SPELL.protevil, cost: 'room', uses: 1, minLevel: 3 },
    { key: 'curemoderate', name: 'Cure Moderate Wounds', icon: '💚', cost: 'room', uses: 1, slvl: 2, minLevel: 3, effect: 'heal', heal: 'single', healDice: 2, healCap: 10, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 2d8 + caster level (max +10). Once per room.' },
    { key: 'holdperson',   name: 'Hold Person',          icon: '🖐️', cost: 'room', uses: 1, slvl: 2, minLevel: 3, effect: 'save_debuff', target: 'enemy', save: 'will', debuff: 'paralyzed', sound: S.anchor, desc: 'A foe must save or be HELD (helpless). Each turn it may re-save to break free — the attempt costs its turn.' },
    { key: 'bullsstrength', name: "Bull's Strength",     icon: '💪', cost: 'room', uses: 1, slvl: 2, minLevel: 3, effect: 'buff', target: 'ally', buff: { toHit: 2, dmg: 2 }, sticky: true, sound: S.invoke, desc: 'Bull-strong — one ally gets +2 to hit and +2 melee damage for the rest of the room.' },
    { key: 'bearsendurance', name: "Bear's Endurance",   icon: '🐻', cost: 'room', uses: 1, slvl: 2, minLevel: 3, effect: 'buff', target: 'ally', buff: { conHp: 2 }, sticky: true, sound: S.invoke, desc: 'Bear-hardy — one ally gains temporary HP (+2 per level) for the rest of the room.' },
    { key: 'spiritweapon', name: 'Spiritual Weapon',     icon: '🗡️', cost: 'room', uses: 1, slvl: 2, minLevel: 3, effect: 'spiritweapon', target: 'enemy', sound: S.holy, desc: 'Conjure a force-weapon shaped like your own over a foe — it strikes that foe on EACH of your turns (with your buffs, feats & Haste) for 1 round per 2 caster levels, while you do other things.' },
    // ── 3rd-level prayers ──
    { key: 'prayer',       name: 'Prayer',               icon: '📿', cost: 'room', uses: 1, slvl: 3, minLevel: 5, effect: 'buff', target: 'self', party: true, buff: { toHit: 1, dmg: 1, save: 1 }, enemyPenalty: 1, sticky: true, sound: S.prayer, desc: 'Fills the whole battlefield: ALL allies +1 to hit, damage & saves; ALL enemies −1, for the rest of the room. (Only one is ever needed.)' },
    { key: 'searinglight', name: 'Searing Light',        icon: '🔆', cost: 'room', uses: 1, slvl: 3, minLevel: 5, effect: 'touch', target: 'enemy', die: 8, dice: 'halflevel', dcap: 5, searing: true, dtype: 'holy', sound: S.searing, desc: 'A ray of divine light — ranged touch. 1d8 per 2 levels (max 5d8); UNDEAD take 1d6 per level (max 10d6), and light-vulnerable undead (vampires) 1d8 per level (max 10d8); a construct/object takes only 1d6 per 2 levels (max 5d6). (PF1)' },
    { key: 'cureserious',  name: 'Cure Serious Wounds',  icon: '💚', cost: 'room', uses: 1, slvl: 3, minLevel: 5, effect: 'heal', heal: 'single', healDice: 3, healCap: 15, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 3d8 + caster level (max +15). Once per room.' },
    { key: 'dispelmagic',  name: 'Dispel Magic',         icon: '🌀', cost: 'room', uses: 1, slvl: 3, minLevel: 5, effect: 'cleanse', target: 'ally', sound: S.dispel, desc: 'End hostile SPELL effects on an ally (hold, slow, magical blindness) — or strip a buff off a foe. Physical grapple/stun/sickness are beyond it (PF1).' },
    { ...SPELL.greatermagicweapon, cost: 'room', uses: 1, minLevel: 5 },   // craft priests' team buff: party weapons +1/4 levels (max +5)
    // ── 4th-level prayers ──
    { key: 'curecritical', name: 'Cure Critical Wounds', icon: '💚', cost: 'room', uses: 1, slvl: 4, minLevel: 7, effect: 'heal', heal: 'single', healDice: 4, healCap: 20, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 4d8 + caster level (max +20). Once per room.' },
    { key: 'protectfire',  name: 'Protection from Fire',  icon: '🔥', cost: 'room', uses: 1, slvl: 4, minLevel: 7, effect: 'buff', target: 'self', party: true, protectFire: true, sticky: true, sound: S.invoke, desc: 'Ward the whole party against FIRE — each ally gains a ward that ABSORBS the next 12 fire damage per caster level (max 120), soaked before it burns, until spent. (PF1 Protection from Energy — cast it when fiery foes loom.)' },
    { key: 'blessingoffervor', name: 'Blessing of Fervor', icon: '💨', cost: 'room', uses: 1, slvl: 4, minLevel: 7, effect: 'haste', target: 'self', party: true, sounds: FERVOR_SFX, desc: 'The party surges with fervor — an EXTRA attack each turn for 1 turn per 5 levels (like Haste).' },
    { key: 'holysmite',    name: 'Holy Smite',           icon: '🌟', cost: 'room', uses: 1, slvl: 4, minLevel: 7, effect: 'aoe', target: 'aoe', maxTargets: 2, save: 'will', die: 8, dice: 'halflevel', dcap: 5, dtype: 'holy', sound: S.sunstrike, desc: 'Searing light scourges 2 foes — Will for half (½level d8).' },
    // ── High-level prayers (revives), gated by level ──
    { key: 'breathoflife', name: 'Breath of Life',       icon: '🌬️', cost: 'room', uses: 1, slvl: 5, minLevel: 9,  effect: 'revive', reviveDice: 5, reviveCap: 25, target: 'ally', sound: S.revive, desc: 'Snatch a DYING ally back — revive & heal them 5d8 + caster level (max +25).' },
    { key: 'raisedead',    name: 'Raise Dead',           icon: '⚰️', cost: 'room', uses: 1, slvl: 5, minLevel: 9,  effect: 'revive', raiseDead: true, target: 'ally', sound: S.revive, desc: 'Call a SLAIN ally back into the run, restored to half health.' },
    { key: 'resurrection', name: 'Resurrection',         icon: '✨', cost: 'room', uses: 1, slvl: 7, minLevel: 13, effect: 'revive', raiseDead: true, full: true, target: 'ally', sound: S.revive, desc: 'Fully resurrect a SLAIN ally — back in the run at FULL health.' },
    // High-level expansion (2026-07-02): the cleric finally has 5th–9th picks.
    preparedSpell(SPELL.flamestrike,  9),
    preparedSpell(SPELL.slayliving,   9),
    preparedSpell(SPELL.healspell,   11),
    preparedSpell(SPELL.bladebarrier, 11),
    preparedSpell(SPELL.firestorm,   15),
    preparedSpell(SPELL.massheal,    17),
    preparedSpell(SPELL.implosion,   17),
  ] },
  // ── Full arcane casters ──
  // WIZARD — prepared caster: a BROAD spellbook, but ONE casting of each spell
  // per room (cost:'room', uses:1). Wired via a helper so every spell is single-
  // shot per room without repeating the override on each line.
  wizard: { atwill: { ...RAY_OF_FROST }, note: 'One casting of each spell, per room.', abilities: [
    preparedSpell(SPELL.shockinggrasp, 1),
    preparedSpell(SPELL.magicmissile,  1),
    preparedSpell(SPELL.grease,        1),
    preparedSpell(SPELL.sleep,         1),
    preparedSpell(SPELL.shield,        1),
    { ...MAGE_ARMOR },
    preparedSpell(SPELL.protevil,      3),
    preparedSpell(SPELL.darkness,      3),
    preparedSpell(SPELL.invisibility,  3),
    preparedSpell(SPELL.glitterdust,   3),
    preparedSpell(SPELL.aciddart,      3),
    preparedSpell(SPELL.scorchingray,  3),
    preparedSpell(SPELL.holdperson,    5),   // arcane Hold Person is a 3RD-level spell (divine casters get it at 2nd) — 3rd-level slots arrive at wizard 5
    preparedSpell(SPELL.fly,           5),
    preparedSpell(SPELL.dispelmagic,   5),
    { key: 'haste', name: 'Haste', icon: '💨', cost: 'room', uses: 1, minLevel: 5, slvl: 3, effect: 'haste', target: 'self', party: true, sounds: HASTE_SFX, desc: 'The whole party blurs with speed — every ally gets an EXTRA attack each turn for 1 turn per 5 caster levels (on top of their action).' },
    preparedSpell(SPELL.slow,          5),
    preparedSpell(SPELL.fireball,      5),
    preparedSpell(SPELL.lightningbolt, 5),
    preparedSpell(SPELL.stoneskin,     7),
    // 4th-level additions
    preparedSpell(SPELL.blacktentacles,      7),
    preparedSpell(SPELL.infernalhealgreater, 7),
    preparedSpell(SPELL.invisgreater,        7),
    preparedSpell(SPELL.riverofwind,         7),
    // 5th-level additions (Fire Snake is now a 5th-level spell)
    preparedSpell(SPELL.firesnake,     9),
    preparedSpell(SPELL.stoneskincomm, 9),
    preparedSpell(SPELL.cloudkill,     9),
    preparedSpell(SPELL.suffocation,   9),
    { ...SPELL.overlandflight, cost: 'run', uses: 1, freeAction: true, minLevel: 9 },   // once per dungeon (run-long, like Mage Armor)
    preparedSpell(SPELL.coneofcold,    9),
    preparedSpell(SPELL.disintegrate,  11),
    preparedSpell(SPELL.chainlightning, 11),
    // 7th (wizard gains 7th-level spells at L13), 8th at L15, 9th at L17
    preparedSpell(SPELL.delayedfireball, 13),
    preparedSpell(SPELL.fingerofdeath,   13),
    preparedSpell(SPELL.horridwilting,   15),
    preparedSpell(SPELL.polarray,        15),
    preparedSpell(SPELL.meteorswarm,     17),
    preparedSpell(SPELL.wailbanshee,     17),
    preparedSpell(SPELL.freezingsphere,  11),   // high-level expansion (2026-07-02)
    preparedSpell(SPELL.dominatemonster, 17),   // Dominate Phase A (2026-07-03)
    preparedSpell(SPELL.waveexhaustion, 13),    // wave-2 expansion (2026-07-03)
    preparedSpell(SPELL.prismaticspray, 13),
    preparedSpell(SPELL.sunburst,       15),
    // ── METAMAGIC prepared spells (PF1: the wizard prepares the metamagic version
    //    in a HIGHER slot — modelled here as separate once-per-room entries gated to
    //    the level that slot opens up; each carries its boost flag). Gated on having
    //    both the spell and the metamagic feat (Intensify n6/L11, Empower n7/L13,
    //    Maximize n9/L17 in casterFeats). ──
    { ...SPELL.magicmissile,  key: 'magicmissile_quick', name: 'Quickened Magic Missile', icon: '⚡', cost: 'room', uses: 1, minLevel: 9, slvl: 5, freeAction: true, desc: 'Magic Missile crammed into a 5th-level slot — a SWIFT action: the darts fly unerringly and you STILL cast or act this turn. Once per room. (Needs 5th-level slots — wizard 9.)' },
    // Metamagic-baked variants carry their PF1 EFFECTIVE slot level (base + adjust)
    // — the spread inherits the BASE spell's slvl, which filed Empowered Fireball
    // as 3rd (Tobias, 2026-07-02). Explicit slvl overrides the spread.
    { ...SPELL.fireball,      key: 'fireball_int',  name: 'Intensified Fireball',  icon: '💥', cost: 'room', uses: 1, minLevel: 11, slvl: 4, intensified: true, desc: 'Fireball in a 4th-level slot — the damage cap climbs +5 dice (level d6 to 15, Reflex half).' },
    { ...SPELL.fireball,      key: 'fireball_emp',  name: 'Empowered Fireball',    icon: '🔥', cost: 'room', uses: 1, minLevel: 13, slvl: 5, empowered: true,   desc: 'Fireball in a 5th-level slot — ×1.5 damage (Reflex half).' },
    { ...SPELL.scorchingray,  key: 'scorch_emp',    name: 'Empowered Scorching Ray', icon: '🔥', cost: 'room', uses: 1, minLevel: 13, slvl: 4, empowered: true, desc: 'Scorching Ray in a 4th-level slot — ×1.5 fire on every ray.' },
    { ...SPELL.coneofcold,    key: 'cone_max',      name: 'Maximized Cone of Cold', icon: '🥶', cost: 'room', uses: 1, minLevel: 17, slvl: 8, maximized: true,  desc: 'Cone of Cold in an 8th-level slot — every die maxed (Reflex half).' },
    { ...SPELL.disintegrate,  key: 'disint_max',    name: 'Maximized Disintegrate', icon: '☢️', cost: 'room', uses: 1, minLevel: 17, slvl: 9, maximized: true,  desc: 'Disintegrate in a 9th-level slot — every die maxed on a hit.' },
    // (Draymus's char-gated NECROMANCY suite is injected AFTER the kits.generated.js
    //  override — see the Draymus block near Olbryn's storm spec below, so it survives
    //  regeneration.)
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
    spontaneousSpell(SPELL.glitterdust,  4),
    spontaneousSpell(SPELL.scorchingray, 4),
    spontaneousSpell(SPELL.catsgrace,    4),
    spontaneousSpell(SPELL.dispelmagic,  6),
    spontaneousSpell(SPELL.fly,          6),
    spontaneousSpell(SPELL.slow,         6),
    spontaneousSpell(SPELL.fireball,     6),
    spontaneousSpell(SPELL.holdperson,   6),   // 3rd-level for arcane casters (counterintuitive — divine get it at 2nd)
    { key: 'haste', name: 'Haste', icon: '💨', cost: 'slot', slvl: 3, minLevel: 6, effect: 'haste', target: 'self', party: true, sounds: HASTE_SFX, desc: 'The whole party blurs with speed — an EXTRA attack each turn for 1 turn per 5 caster levels.' },
    spontaneousSpell(SPELL.stoneskin,    8),
    // 4th-level additions
    spontaneousSpell(SPELL.blacktentacles,      8),
    spontaneousSpell(SPELL.infernalhealgreater, 8),
    spontaneousSpell(SPELL.invisgreater,        8),
    spontaneousSpell(SPELL.riverofwind,         8),
    // 5th-level additions (Fire Snake is now a 5th-level spell)
    spontaneousSpell(SPELL.firesnake,    10),
    spontaneousSpell(SPELL.stoneskincomm, 10),
    spontaneousSpell(SPELL.cloudkill,    10),
    spontaneousSpell(SPELL.suffocation,  10),
    { ...SPELL.overlandflight, cost: 'run', uses: 1, freeAction: true, minLevel: 10 },   // once per dungeon (run-long, like Mage Armor)
    spontaneousSpell(SPELL.coneofcold,   10),
    spontaneousSpell(SPELL.disintegrate, 12),
    spontaneousSpell(SPELL.chainlightning, 12),
    // 7th (sorcerer gains 7th-level spells at L14), 8th at L16, 9th at L18
    spontaneousSpell(SPELL.delayedfireball, 14),
    spontaneousSpell(SPELL.fingerofdeath,   14),
    spontaneousSpell(SPELL.horridwilting,   16),
    spontaneousSpell(SPELL.polarray,        16),
    spontaneousSpell(SPELL.meteorswarm,     18),
    spontaneousSpell(SPELL.wailbanshee,     18),
    spontaneousSpell(SPELL.freezingsphere,  12),   // high-level expansion (2026-07-02)
    spontaneousSpell(SPELL.dominatemonster, 18),   // Dominate Phase A (2026-07-03)
    spontaneousSpell(SPELL.waveexhaustion, 14),    // wave-2 expansion (2026-07-03)
    spontaneousSpell(SPELL.prismaticspray, 14),
    spontaneousSpell(SPELL.sunburst,       16),
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
  // MAGUS — a gish: martial weapon attacks fused with arcane magic. THREE layers:
  //   (1) SPELL STRIKES — channel a touch spell through a weapon hit (1 use per 5
  //       levels per room, like Smite). New metamagic strikes unlock with level.
  //   (2) SPELLBOOK — a prepared arcane repertoire (one casting of each per room),
  //       gaining a new spell LEVEL at character levels 1/4/7/10/13/16 (the PF1
  //       Magus advancement: 6th-level spells by 16th).
  //   (3) ARCANE POOL — an automatic, level-scaled weapon enhancement applied in
  //       _swingVsAC: +1@1, +2@5, keen@6, flaming@8, +3@9, flaming burst@11,
  //       +4@13, +5@17 (the player's real weapon enchant wins if it's higher).
  // (Per-magus Spell Strike SFX — Kate's "boudicca", Vaughan's anime sword, Toni's
  // axe — are wired in Dungeon.js via MAGUS_SPELLSTRIKE_SFX.)
  magus: { atwill: ATTACK('⚔️'), note: 'Channel a touch spell through your weapon (Spell Strike) — or, with a bow, through the shot (Imbued Shot). One clean entry per spell; each unlocks with level and auto-scales with your metamagic feats.', abilities: [
    // ── SPELL STRIKE / IMBUED SHOT (class feature; 1 use per 5 levels per room). ONE
    //    entry per touch spell, named "Spell Strike: X" (melee) or "Imbued Shot: X"
    //    (bow) in _abilitiesFor by weapon. NO metamagic clutter — the magus's Intensify/
    //    Empower/Maximize feats auto-apply via _mmForCast, so a single Shocking Grasp
    //    scales all the way up (Josh 2026-07-06: the old 8-shot "SS …" list was baffling).
    //    They unlock slowly, like real spellstrike: Shocking Grasp → Frigid → Vampiric →
    //    Forceful → Polar Ray. ──
    { key: 'spellstrike',    name: 'Shocking Grasp',  icon: '⚡',  cost: 'room', uses: smiteUses, minLevel: 1,  effect: 'spellstrike', target: 'enemy', die: 6, dice: 'level',     dcap: 5,  dtype: 'electricity', sound: S.shock,     desc: 'Channel SHOCKING GRASP through the hit — +level d6 electricity (cap 5d6; your Intensify/Empower/Maximize feats push it higher automatically).' },
    { key: 'frigidtouch',    name: 'Frigid Touch',    icon: '🧊', cost: 'room', uses: smiteUses, minLevel: 4,  effect: 'spellstrike', target: 'enemy', die: 6, dice: 4,            dtype: 'cold', debuff: 'sickened', sound: S.frostbite, desc: 'Channel FRIGID TOUCH — +4d6 cold, and the foe is staggered (sickened).' },
    { key: 'vampirictouch',  name: 'Vampiric Touch',  icon: '🩸', cost: 'room', uses: smiteUses, minLevel: 7,  effect: 'spellstrike', target: 'enemy', die: 6, dice: 'halflevel', dcap: 10, dtype: 'negative', lifesteal: true, sound: S.umbral, desc: 'Channel VAMPIRIC TOUCH — +½level d6 negative energy (cap 10d6); you HEAL the damage dealt.' },
    { key: 'forcefulstrike', name: 'Forceful Strike', icon: '💪', cost: 'room', uses: smiteUses, minLevel: 10, effect: 'spellstrike', target: 'enemy', die: 6, dice: 'halflevel', dcap: 5,  dtype: 'force', bullRush: true, allyAOO: true, sound: S.shock, desc: 'Channel FORCEFUL STRIKE — +½level d6 force and a BULL RUSH: the foe is shoved, provoking a free attack from one of your melee allies.' },
    { key: 'polarstrike',    name: 'Polar Ray',       icon: '❄️', cost: 'room', uses: smiteUses, minLevel: 13, effect: 'spellstrike', target: 'enemy', die: 6, dice: 'level',     dcap: 15, dtype: 'cold', sound: S.frostbite, desc: 'Channel POLAR RAY — a lance of utter cold: +level d6 cold (cap 15d6).' },
    // ── SPELLBOOK (prepared; one casting of each per room) ──
    // 1st level (character level 1)
    preparedSpell(SPELL.bladelash,    1),
    preparedSpell(SPELL.grease,       1),
    preparedSpell(SPELL.shield,       1),
    preparedSpell(SPELL.vanish,       1),
    // 2nd level (character level 4)
    preparedSpell(SPELL.bladeddash,   4),
    preparedSpell(SPELL.glitterdust,  4),
    preparedSpell(SPELL.mirrorimage,  4),
    preparedSpell(SPELL.scorchingray, 4),
    // 3rd level (character level 7)
    preparedSpell(SPELL.displacement, 7),
    { ...preparedSpell(SPELL.fly, 7), canHitFlyers: true },
    { key: 'haste', name: 'Haste', icon: '💨', cost: 'room', uses: 1, minLevel: 7, slvl: 3, effect: 'haste', target: 'self', party: true, sounds: HASTE_SFX, desc: 'The whole party blurs with speed — an EXTRA attack each turn for 1 turn per 5 caster levels.' },
    preparedSpell(SPELL.dispelmagic,  7),
    // 4th level (character level 10)
    preparedSpell(SPELL.elementalbody, 10),
    preparedSpell(SPELL.fireshield,    10),
    preparedSpell(SPELL.stoneskin,     10),
    // 5th level (character level 13)
    preparedSpell(SPELL.dimensionalblade, 13),
    { ...SPELL.overlandflight, cost: 'run', uses: 1, freeAction: true, minLevel: 13, canHitFlyers: true },
    // 6th level (character level 16)
    preparedSpell(SPELL.disintegrate,       16),
    preparedSpell(SPELL.chainlightning,     16),
    preparedSpell(SPELL.dispelmagicgreater, 16),
    preparedSpell(SPELL.trueseeing,         16),
  ] },
  // INQUISITOR — a SPONTANEOUS divine caster (cleric-list spellbook, slower 6-level
  // progression — see INQ_SLOTS_BY_LEVEL) who fights with steel and zeal. His class
  // FEATURES sit beside the spellbook: BANE (declare a creature TYPE — a free action,
  // 1 use per 5 levels/room — then +2 hit / +2d6+2 vs THAT type only) and three
  // JUDGEMENTS (free-action toggle, only one active, lasts the whole room). He also
  // earns fighter bonus feats at HALF rate (see fighterFeats in Dungeon.js).
  inquisitor: { atwill: ATTACK('⚔️'), note: 'Spontaneous divine caster — cleric-list spells at a slower 6-level progression.', abilities: [
    // ── Class features (no spell level → inline buttons) ──
    { key: 'bane', name: 'Bane', icon: '🗡️', cost: 'room', uses: smiteUses, freeAction: true, effect: 'bane', target: 'self', sound: '/audio/dredd_i_am_the_law.mp3', desc: 'Declare a foe TYPE: SELECT an enemy, then click Bane (a FREE action — 1 use per 5 levels per room). Your weapon turns bane against THAT creature type only — +2 to hit and +2d6+2 damage vs it for the rest of the room. Re-declare (spends another use) to switch types.' },
    { key: 'judg_destruction', name: 'Judgement: Destruction', icon: '⚔️', cost: 'free', effect: 'judgment', judgmentType: 'destruction', sound: S.judgment, desc: 'JUDGEMENT (free to choose, only one active, lasts the whole room): +damage on your strikes.' },
    { key: 'judg_protection',  name: 'Judgement: Protection',  icon: '🛡️', cost: 'free', effect: 'judgment', judgmentType: 'protection',  sound: S.judgment, desc: 'JUDGEMENT (free to choose, only one active, lasts the room): +AC against your foes.' },
    { key: 'judg_healing',     name: 'Judgement: Healing',     icon: '💗', cost: 'free', effect: 'judgment', judgmentType: 'healing',     sound: S.judgment, desc: 'JUDGEMENT (free to choose, only one active, lasts the room): regenerate HP each of your turns.' },
    // ── Spellbook: curated cleric-list repertoire, spontaneous, gated to his slower slot progression ──
    // 1st level (slots from L1)
    { key: 'curelight',     name: 'Cure Light Wounds',    icon: '💚', cost: 'slot', slvl: 1, effect: 'heal', heal: 'single', healDice: 1, healCap: 5,  target: 'ally', sound: S.cure,   desc: 'Heal the most-hurt ally — 1d8 + caster level (max +5).' },
    { key: 'shieldoffaith', name: 'Shield of Faith',      icon: '🛡️', cost: 'slot', slvl: 1, effect: 'buff', target: 'ally', buff: { deflect: 2 }, sticky: true, sound: S.invoke, desc: '+2 DEFLECTION AC to the lowest-AC ally who\'d gain (no stack with a Ring of Protection) for the rest of the room.' },
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
    { key: 'dispelmagic',   name: 'Dispel Magic',         icon: '🌀', cost: 'slot', slvl: 3, minLevel: 7, effect: 'cleanse', target: 'ally', sound: S.dispel, desc: 'End hostile SPELL effects on an ally (hold, slow, magical blindness) — or strip a buff off a foe. Physical grapple/stun/sickness are beyond it (PF1).' },
    { key: 'prayer',        name: 'Prayer',               icon: '📿', cost: 'slot', slvl: 3, minLevel: 7, effect: 'buff', target: 'self', party: true, buff: { toHit: 1, dmg: 1, save: 1 }, enemyPenalty: 1, sticky: true, sound: S.prayer, desc: 'ALL allies +1 to hit, damage & saves; ALL enemies −1, for the rest of the room.' },
    { key: 'searinglight',  name: 'Searing Light',        icon: '🔆', cost: 'slot', slvl: 3, minLevel: 7, effect: 'touch', target: 'enemy', die: 8, dice: 'halflevel', dcap: 5, dtype: 'holy', sound: S.searing, desc: 'A ray of divine light — ranged touch for ½level d8 (extra vs undead).' },
    // 4th level (slots from L10)
    { key: 'curecritical',  name: 'Cure Critical Wounds', icon: '💚', cost: 'slot', slvl: 4, minLevel: 10, effect: 'heal', heal: 'single', healDice: 4, healCap: 20, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 4d8 + caster level (max +20).' },
    { key: 'holysmite',     name: 'Holy Smite',           icon: '🌟', cost: 'slot', slvl: 4, minLevel: 10, effect: 'aoe', target: 'aoe', maxTargets: 2, save: 'will', die: 8, dice: 'halflevel', dcap: 5, dtype: 'holy', sound: S.sunstrike, desc: 'Searing light scourges 2 foes — Will for half (½level d8).' },
    { key: 'blessingoffervor', name: 'Blessing of Fervor', icon: '💨', cost: 'slot', slvl: 4, minLevel: 10, effect: 'haste', target: 'self', party: true, sounds: FERVOR_SFX, desc: 'The party surges with fervor — an EXTRA attack each turn for 1 turn per 5 levels (the haste choice).' },
    // ── AGU — assassin/spy of Norgorber: stealth + single-target disable (Hold Person
    //    is on the shared list above). char-gated to Agu via Dungeon._charAllows. ──
    { ...SPELL.sleep,        cost: 'slot', char: 'Agu' },
    { ...SPELL.displacement, cost: 'slot', minLevel: 7,  char: 'Agu' },
    { ...SPELL.invisgreater, cost: 'slot', minLevel: 10, char: 'Agu' },
    // ── Wave-2 expansion (2026-07-03): the inquisitor's 5th–6th finally exist ──
    spontaneousSpell(SPELL.banishment, 13),
    { key: 'dispelmagicgreater', name: 'Dispel Magic, Greater', icon: '🌀', effect: 'cleanse', greater: true, target: 'ally', slvl: 6, cost: 'slot', minLevel: 16, sound: S.dispel, desc: 'A sweeping unweaving — end ALL hostile SPELL effects on an ally (hold, slow, magical blindness), or tear every buff off a foe. Physical conditions stay (PF1).' },
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
    { ...SPELL.grease, cost: 'slot', minLevel: 1 },
    { ...SPELL.sleep,  cost: 'slot', minLevel: 1 },
    { key: 'vanish', name: 'Vanish', icon: '👻', cost: 'slot', slvl: 1, minLevel: 1, effect: 'invisible', target: 'ally', sound: S.invis, desc: 'A touched ally vanishes from sight — enemies can\'t target them until they attack (a brief bard\'s Vanish).' },
    { ...SPELL.charmperson, cost: 'slot', minLevel: 1 },
    // ── 2nd-level spells ──
    { key: 'hideouslaughter', name: 'Hideous Laughter', icon: '😂', cost: 'slot', slvl: 2, minLevel: 4, effect: 'save_debuff', target: 'enemy', save: 'will', debuff: 'paralyzed', sound: S.hideous, desc: 'A foe collapses in helpless laughter — Will save or HELD (helpless, Sneak-Attackable). Each turn it may re-save to recover, but the attempt costs its turn.' },
    { key: 'curemoderate', name: 'Cure Moderate Wounds', icon: '💚', cost: 'slot', slvl: 2, minLevel: 4, effect: 'heal', heal: 'single', healDice: 2, healCap: 10, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 2d8 + caster level (max +10).' },
    { key: 'soundburst',   name: 'Sound Burst',          icon: '🔊', cost: 'slot', slvl: 2, minLevel: 4, effect: 'aoe', target: 'aoe', maxTargets: 3, save: 'fort', die: 8, dice: 1, dtype: 'sonic', sounds: THUNDER_SFX, desc: 'A concussive blast of sound — 1d8 sonic to up to 3 foes, Fort for half.' },
    { ...SPELL.glitterdust, cost: 'slot', minLevel: 4 },
    { key: 'bullsstrength', name: "Bull's Strength",     icon: '💪', cost: 'slot', slvl: 2, minLevel: 4, effect: 'buff', target: 'ally', buff: { toHit: 2, dmg: 2 }, sticky: true, sound: S.invoke, desc: 'Bull-strong — one ally gets +2 to hit and +2 melee damage for the rest of the room.' },
    { key: 'catsgrace',     name: "Cat's Grace",         icon: '🐈', cost: 'slot', slvl: 2, minLevel: 4, effect: 'buff', target: 'ally', buff: { ac: 2, toHit: 1, dexMod: 1 }, sticky: true, sound: S.invoke, desc: 'Feline-quick — one ally gets +2 AC and +1 ranged to-hit (Dex) for the rest of the room.' },
    { key: 'bearsendurance', name: "Bear's Endurance",   icon: '🐻', cost: 'slot', slvl: 2, minLevel: 4, effect: 'buff', target: 'ally', buff: { conHp: 2 }, sticky: true, sound: S.invoke, desc: 'Bear-hardy — one ally gains temporary HP (+2 per level, from +4 Con) for the rest of the room.' },
    // ── 3rd-level spells ──
    { key: 'haste',     name: 'Haste',           icon: '💨', cost: 'slot', slvl: 3, minLevel: 7, effect: 'haste', target: 'self', party: true, sounds: HASTE_SFX, desc: 'The whole party blurs with speed — an EXTRA attack each turn for 1 turn per 5 caster levels.' },
    { key: 'slow',      name: 'Slow',            icon: '🐌', cost: 'slot', slvl: 3, minLevel: 7, effect: 'slow', target: 'aoe', randN: 2, randDie: 4, maxTargets: 8, save: 'will', sound: S.slow, desc: 'Time drags for a RANDOM 2d4 foes — Will save or be SLOWED (acts only every other turn, easier to hit).' },
    { key: 'goodhope',  name: 'Good Hope',       icon: '🌟', cost: 'slot', slvl: 3, minLevel: 7, effect: 'buff', target: 'self', party: true, buff: { toHit: 2, dmg: 2, save: 2 }, sticky: true, sound: S.bardsong, desc: 'Fill the party with hope — all allies get +2 to hit, damage, and saves for the rest of the room.' },
    { key: 'heroism',   name: 'Heroism',         icon: '🦸', cost: 'slot', slvl: 3, minLevel: 7, effect: 'buff', target: 'ally', buff: { toHit: 2, save: 2 }, sticky: true, sound: S.invoke, desc: 'One ally becomes heroic — +2 to hit and +2 to saves for the rest of the room.' },
    { key: 'dispelmagic', name: 'Dispel Magic',  icon: '🌀', cost: 'slot', slvl: 3, minLevel: 7, effect: 'cleanse', target: 'ally', sound: S.dispel, desc: 'End hostile SPELL effects on an ally (hold, slow, magical blindness) — or strip a buff off a foe. Physical grapple/stun/sickness are beyond it (PF1).' },
    spontaneousSpell(SPELL.dominateperson, 13),   // Dominate Phase A (2026-07-03): bard 5th, turns a foe against its own
    spontaneousSpell(SPELL.heroismgreater, 13),   // wave-2 expansion (2026-07-03)
    spontaneousSpell(SPELL.masssuggestion, 16),
  ] },
  // DRUID — prepared nature caster: one casting of each spell per room.
  druid: { atwill: ATTACK('🌿'), note: 'One casting of each spell, per room. WILD SHAPE forms last until you drop them (each usable once per room).', abilities: [
    // ── WILD SHAPE forms (effect:'form'; see Dungeon._abForm). Toggle on/off; each
    // form is usable once per room. Generic druids get Tiger/Bear/Hawk; Rissa gets
    // her own Beast Mode + Promethean in place of Tiger/Bear (Hawk is shared). ──
    { key: 'tigerform', name: 'Tiger Form', icon: '🐯', cost: 'room', uses: 1, effect: 'form', freeAction: true, target: 'self', notChar: 'Rissa',
      form: { key: 'tiger', label: 'Tiger Form', glyph: '🐯', art: '/tokens/form_tiger.webp', weapon: 'form_tiger', sizeSteps: 1, ac: 1, toHit: 2, dmg: 4, sound: '/audio/enemy_yak.mp3' },
      desc: 'Become a DIRE TIGER — pounce on prey with claws + bite (3 attacks at full strength), +2 to hit, +4 damage, +1 AC. Lasts until you change back.' },
    { key: 'bearform', name: 'Bear Form', icon: '🐻', cost: 'room', uses: 1, effect: 'form', freeAction: true, target: 'self', notChar: 'Rissa',
      form: { key: 'bear', label: 'Bear Form', glyph: '🐻', art: '/tokens/token-animal-great-spirit-bear-dd-monster-resembles-griz.webp', weapon: 'form_bear', sizeSteps: 1, ac: 3, toHit: 2, dmg: 4, tempHpPerLevel: 2, sound: '/audio/enemy_yak.mp3' },
      desc: 'Become a DIRE BEAR — a wall of muscle: claws + bite (3 attacks), +2 to hit, +4 damage, +3 natural-armor AC, and +2 HP per level. Lasts until you change back.' },
    { key: 'hawkform', name: 'Hawk Form', icon: '🦅', cost: 'room', uses: 1, effect: 'form', freeAction: true, target: 'self',
      form: { key: 'hawk', label: 'Hawk Form', glyph: '🦅', fly: true, ac: 1, toHit: 1, sound: S.invis },
      desc: 'Take to the sky — FLY out of reach of grounded foes (they cannot hit you), with +1 to hit & AC. You can STILL cast your spells from the air. Lasts until you change back.' },
    { key: 'beastmode', name: 'Beast Mode', icon: '🐲', cost: 'room', uses: 1, effect: 'form', freeAction: true, target: 'self', char: 'Rissa',
      form: { key: 'beast', label: 'Beast Mode', glyph: '🐲', art: '/tokens/beast-of-lepidstadt.webp', weapon: 'form_beast', sizeSteps: 1, ac: 2, toHit: 3, dmg: 6, tempHpPerLevel: 2, dr: 10, sound: '/audio/rissa_beast.mp3' },
      desc: 'Rissa becomes the BEAST OF LEPIDSTADT — LARGE and monstrously strong: +3 to hit, +6 damage, +2 AC, +2 HP/level, DR 10/adamantine (like Stoneskin), and she can SWAT airborne foes out of the sky. Lasts until she changes back.' },
    { key: 'promethean', name: 'Promethean', icon: '🐙', cost: 'room', uses: 1, effect: 'form', freeAction: true, target: 'self', char: 'Rissa',
      form: { key: 'promethean', label: 'Promethean', glyph: '🐙', art: '/tokens/form_promethean.webp', weapon: 'form_promethean', sizeSteps: 2, ac: 1, toHit: 2, dmg: 4, sound: '/audio/dragon_roar_rivozair.mp3' },
      desc: 'Rissa unfurls into a MULTI-TENTACLED HORROR — 15-ft reach (strikes flyers too), FOUR tentacle attacks, and every hit GRAPPLES the foe: helpless until it breaks free. Lasts until she changes back.' },
    // ── Buff prayers (sticky room buffs) ──
    { key: 'barkskin',     name: 'Barkskin',         icon: '🌳', cost: 'room', uses: 1, minLevel: 1, effect: 'buff', target: 'ally', buff: { ac: 3 }, sticky: true, sound: S.invoke, desc: 'Bark-tough hide — +3 natural-armor AC to an ally for the rest of the room.' },
    { key: 'magicfang',    name: 'Magic Fang',       icon: '🐾', cost: 'room', uses: 1, minLevel: 1, effect: 'buff', target: 'self', buff: { toHit: 1, dmg: 1 }, sticky: true, sound: S.invoke, desc: 'Bless your natural weapons — +1 to hit and +1 damage for the rest of the room.' },
    { key: 'bullsstrength',name: "Bull's Strength",  icon: '💪', cost: 'room', uses: 1, minLevel: 3, effect: 'buff', target: 'ally', buff: { toHit: 2, dmg: 2 }, sticky: true, sound: S.invoke, desc: 'One ally gets +2 to hit and +2 melee damage for the rest of the room.' },
    { key: 'bearsendurance',name: "Bear's Endurance",icon: '🐻', cost: 'room', uses: 1, minLevel: 3, effect: 'buff', target: 'ally', buff: { conHp: 2 }, sticky: true, sound: S.invoke, desc: 'Bear-hardy — one ally gains temporary HP (+2 per level) for the rest of the room.' },
    { key: 'catsgrace',    name: "Cat's Grace",      icon: '🐈', cost: 'room', uses: 1, minLevel: 3, effect: 'buff', target: 'ally', buff: { ac: 2, toHit: 1, dexMod: 1 }, sticky: true, sound: S.invoke, desc: 'Feline-quick — one ally gets +2 AC and +1 to hit for the rest of the room.' },
    { key: 'ironskin',     name: 'Iron Skin',        icon: '🪨', cost: 'room', uses: 1, minLevel: 7, effect: 'buff', target: 'ally', buff: {}, dr: 10, sticky: true, sound: S.invoke, desc: "An ally's skin turns to iron — DR 10 against physical blows for the rest of the room." },
    // ── Offensive nature magic ──
    { key: 'entangle',   name: 'Entangle',          icon: '🌿', cost: 'room', uses: 1, effect: 'grease', target: 'aoe', randN: 2, randDie: 4, save: 'reflex', sound: S.entangle, desc: 'Grasping vines erupt — a RANDOM 2d4 foes must make a Reflex save or be ROOTED (rendered prone, losing the turn).' },
    { key: 'shockinggrasp', name: 'Shocking Grasp', icon: '⚡', cost: 'room', uses: 1, minLevel: 1, effect: 'touch', target: 'enemy', die: 6, dice: 'level', dcap: 5, dtype: 'electricity', slvl: 1, sound: S.shock, desc: 'A charged touch — ranged touch attack (level d6, cap 5d6 electricity).' },
    { key: 'lightningbolt', name: 'Lightning Bolt', icon: '⚡', cost: 'room', uses: 1, minLevel: 5, effect: 'aoe', target: 'aoe', maxTargets: 2, save: 'reflex', die: 6, dice: 'level', dcap: 10, dtype: 'electricity', sounds: THUNDER_SFX, desc: 'A bolt skewering 2 foes — Reflex for half (level d6).' },
    { key: 'calllightning', name: 'Call Lightning', icon: '🌩️', cost: 'room', uses: 1, minLevel: 5, effect: 'aoe', target: 'aoe', maxTargets: 2, save: 'reflex', die: 6, dice: 'halflevel', dcap: 5, dtype: 'electricity', sounds: THUNDER_SFX, desc: 'A bolt from the storm strikes 2 foes — Reflex for half (½level d6).' },
    { key: 'riverofwind', name: 'River of Wind', icon: '🌬️', cost: 'room', uses: 1, minLevel: 5, effect: 'grease', target: 'aoe', randN: 3, randDie: 4, save: 'fort', slvl: 4, sound: S.gust, desc: 'A roaring torrent of air bowls over a RANDOM 3d4 foes — Fortitude save or be knocked prone.' },
    { key: 'firesnake', name: 'Fire Snake', icon: '🐍', cost: 'room', uses: 1, minLevel: 7, effect: 'aoe', target: 'aoe', maxTargets: 4, save: 'reflex', die: 6, dice: 'level', dcap: 15, dtype: 'fire', slvl: 5, sounds: FIREBALL_SFX, desc: 'A serpent of flame weaves through up to 4 foes — 1d6 fire per caster level (max 15d6), Reflex for half.' },
    { ...SPELL.chainlightning, cost: 'room', uses: 1, minLevel: 11 },
    // ── Healing & restoration ──
    { key: 'curelight',  name: 'Cure Light Wounds', icon: '💚', cost: 'room', uses: 1, effect: 'heal', heal: 'single', healDice: 1, healCap: 5, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 1d8 + caster level (max +5).' },
    { key: 'curemoderate',name: 'Cure Moderate Wounds', icon: '💚', cost: 'room', uses: 1, minLevel: 4, effect: 'heal', heal: 'single', healDice: 2, healCap: 10, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 2d8 + caster level (max +10).' },
    { key: 'removeparalysis', name: 'Remove Paralysis', icon: '🩹', cost: 'room', uses: 1, minLevel: 3, effect: 'cleanse', target: 'ally', sound: S.cure, desc: 'Free an ally from paralysis or slow — ANY source, even a ghoul’s touch (PF1).' },
    { key: 'dispelmagic', name: 'Dispel Magic',     icon: '🌀', cost: 'room', uses: 1, minLevel: 5, effect: 'cleanse', target: 'ally', sound: S.dispel, desc: 'End hostile SPELL effects on an ally (hold, slow, magical blindness) — or strip a buff off a foe. Physical grapple/stun/sickness are beyond it (PF1).' },
    // Reincarnate — the druid's raise-dead (PF1: druid 4th-level spell, level 7).
    // The soul returns, but in a NEW body: instead of PF1's random-race table,
    // the fallen hero is REPLACED by a random hero from the bench (one who is
    // not seated at the poker table and not already in the dungeon).
    { key: 'reincarnate', name: 'Reincarnate', icon: '🌱', cost: 'room', uses: 1, minLevel: 7, slvl: 4, effect: 'revive', raiseDead: true, reincarnate: true, target: 'ally', sound: S.revive, desc: 'Grow a SLAIN ally a new body — their soul returns as a DIFFERENT hero (random, from those not at the table or in the dungeon), at full health.' },
    // High-level expansion (2026-07-02): druid tops out with real 7th/9th picks.
    { ...preparedSpell(SPELL.firestorm, 13), slvl: 7 },   // PF1: Fire Storm is druid 7 (cleric 8)
    preparedSpell(SPELL.stormofvengeance, 17),
    preparedSpell(SPELL.sunburst, 15),   // wave-2 expansion (2026-07-03): druid 8th
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
  // ── FLAME mystery — Elfrip ONLY (most oracles never see fire spells; the
  //    char tag is enforced by Dungeon._charAllows in the UI, bot AI and casts).
  { ...spontaneousSpell(SPELL.burninghands, 1), char: 'Elfrip' },
  { ...spontaneousSpell(SPELL.scorchingray, 3), char: 'Elfrip' },
  { ...spontaneousSpell(SPELL.fireball,  5),    char: 'Elfrip' },
  { ...spontaneousSpell(SPELL.firesnake, 10),   char: 'Elfrip' },
  { ...spontaneousSpell(SPELL.fireshield, 7),   char: 'Elfrip' },   // Elfrip team buff (Protection from Fire communal already comes from the cleric list)
  // ── TIME mystery — Casandalee: she bends the battle's tempo (Haste/Slow) and
  //    her own timeline (Mirror Image's might-have-beens, Displacement's
  //    half-second sidestep). Other oracles keep the plain cleric list.
  { key: 'haste', name: 'Haste', icon: '💨', cost: 'slot', slvl: 3, minLevel: 5, effect: 'haste', target: 'self', party: true, sounds: HASTE_SFX, char: 'Casandalee', desc: 'The whole party blurs with speed — an EXTRA attack each turn for 1 round per caster level.' },
  { ...spontaneousSpell(SPELL.slow, 5),         char: 'Casandalee' },
  { ...spontaneousSpell(SPELL.mirrorimage, 4),  char: 'Casandalee' },
  { ...spontaneousSpell(SPELL.displacement, 6), char: 'Casandalee' },
  // ── TRICKERY (Deception) mystery — Rhyarca: the pirate-queen's bag of dirty
  //    tricks. Darkness shrouds foes; her Communal Darkvision lets the WHOLE
  //    party keep targeting them while they stumble blind (see
  //    Dungeon._targetableEnemies). Greater Invisibility loves a rogue ally.
  { ...spontaneousSpell(SPELL.invisibility, 4),  char: 'Rhyarca' },
  { ...spontaneousSpell(SPELL.darkness, 4),      char: 'Rhyarca' },
  { key: 'darkvisioncomm', name: 'Darkvision (Communal)', icon: '👁️', cost: 'slot', slvl: 3, minLevel: 6, effect: 'buff', target: 'self', party: true, sticky: true, darkvision: true, sound: S.invoke, char: 'Rhyarca', desc: 'The whole party sees through magical darkness — shrouded foes can be TARGETED again (they still stumble, losing their turns). Lasts the room.' },
  { ...spontaneousSpell(SPELL.invisgreater, 8),  char: 'Rhyarca' },
];

// GUNSLINGER (Taelys, Duristan) — a PF1 firearms specialist. Gun Training is the
// house baseline already (DEX to hit AND damage with ranged); the kit carries the
// shooting maneuvers, and the class gets its own ranged feat ladder (see
// gunslingerFeats in Dungeon.js: Weapon Focus → Rapid Shot → Bullseye → Weapon
// Specialization, per the user). Deadly Aim arrives via the universal loop below.
KITS.gunslinger = { atwill: ATTACK('🔫'), note: 'Gun Training: DEX to hit and damage with firearms. Feats: Weapon Focus, Rapid Shot, Bullseye Shot, Weapon Specialization.', abilities: [
  { key: 'rapidshot', name: 'Rapid Shot',   icon: '🔫', cost: 'free', effect: 'rapidshot', target: 'enemy', needsRepeating: true, sound: S.bowmulti, desc: 'Fire 2 shots this turn — each at −2 to hit. (Needs a repeating firearm — NOT a bolt-action rifle.)' },
  { key: 'bullseye',  name: 'Bullseye Shot', icon: '🎯', cost: 'free', effect: 'bullseye',  target: 'enemy', sound: S.bow, desc: 'A carefully aimed shot at +4 to hit.' },
] };

// MONK — its own kit at last (it used to borrow the fighter's wholesale). FREE class
// features: Improved Unarmed Strike (fists scale 1d6 → 1d8@4 → 1d10@8 → 2d6@12 →
// 2d8@16 → 2d10@20 — see the monk block in Dungeon._swingVsAC), Stunning Fist, and
// FLURRY OF BLOWS (every melee turn is two strikes at −2/−2 — see _isDualWielding +
// monkFeats). Evasion comes with the class. Trip kept from the fighter kit — very monk.
KITS.monk = { atwill: ATTACK('👊'), note: 'Free: Improved Unarmed Strike (scaling fists), Stunning Fist, Flurry of Blows (two strikes every turn).', abilities: [
  { key: 'stunningfist', name: 'Stunning Fist', icon: '🌀', cost: 'room', uses: 1, effect: 'stunfist', target: 'enemy', sound: '/audio/weapon_blunt.mp3', desc: 'Once per room: a precise strike — your normal attack, and on a hit the foe must save (Fort, DC 10 + ½ level + WIS) or be STUNNED and lose its next turn.' },
  { key: 'trip', name: 'Trip', icon: '🦵', cost: 'free', effect: 'trip', target: 'enemy', desc: 'Attack to trip (no damage). On a hit the foe is knocked prone, loses its turn, and you get a free attack. Prone = +4 for everyone to hit it.' },
] };

// ── ANTIPALADIN — the paladin's dark mirror (Adimarus). Was the last kit-less
// class (it fell back to the fighter kit). FIENDISH BOON already auto-enchants
// the weapon in Dungeon._swingVsAC (+1@5 … +6@20; UNHOLY +2d6 vs good from 8).
// Touch of Corruption is PF1 RAW (1d6 per 2 levels, melee touch); Bull's
// Strength (2nd) and Vampiric Touch (3rd) are on the antipaladin spell list.
KITS.antipaladin = { atwill: ATTACK('🗡️'), note: 'Unholy champion — your Fiendish Boon auto-enchants your weapon (+1 at 5 up to +6 at 20; UNHOLY vs good foes from 8). Antipaladin spells unlock at 4th.', abilities: [
  { key: 'channelneg', name: 'Channel Negative', icon: '🌑', cost: 'room', uses: channelUses, minLevel: 4, effect: 'channelneg', target: 'ally', sound: S.umbral, desc: 'Channel NEGATIVE energy — mends the party\'s UNDEAD comrades (Tar Baphon, Vrood, Vesorianna, Farrus) for ½ level d6. Selective Channeling: the living take nothing; positive energy can\'t help these four, but this can.' },
  { key: 'touchofcorruption', name: 'Touch of Corruption', icon: '🖤', cost: 'room', uses: smiteUses, minLevel: 2, effect: 'touch', target: 'enemy', die: 6, dice: 'halflevel', dcap: 10, dtype: 'negative', sound: S.umbral, desc: 'A melee touch crackling with profane energy — ½ level d6 negative damage (cap 10d6). Once per 5 levels per room.' },
  { key: 'bullsstrength', name: "Bull's Strength", icon: '💪', cost: 'room', uses: 1, minLevel: 7, slvl: 2, effect: 'buff', target: 'ally', buff: { toHit: 2, dmg: 2 }, sticky: true, sound: S.invoke, desc: 'One martial ally gets +2 to hit and +2 melee damage for the rest of the room. (2nd-level antipaladin spell, level 7.)' },
  { key: 'vampirictouch', name: 'Vampiric Touch', icon: '🩸', cost: 'room', uses: 1, minLevel: 10, slvl: 3, effect: 'touch', target: 'enemy', die: 6, dice: 'halflevel', dcap: 10, dtype: 'negative', lifesteal: true, sound: S.umbral, desc: 'A draining melee touch — ½ level d6 negative (cap 10d6); you HEAL the energy dealt. (3rd-level antipaladin spell, level 10.)' },
] };

// ── Power Attack (melee) + Deadly Aim (ranged) on EVERY class, free, from L1 ──
// House rule to empower martials & hybrids: both are FREE −hit/+damage toggles (see
// Dungeon._abBuff). A character uses whichever matches their weapon; the dungeon AI
// only auto-throws the matching one AND only for weapon-fighters (pure casters never
// auto-toggle — they'd waste the turn on a basic attack instead of a spell; see the
// weapon-aware buff pick in _botAbility). Granted to every kit; classes without their
// own kit (monk, antipaladin) pick them up via the fighter DEFAULT_KIT. Casters get
// them too (a human caster may toggle if they choose to swing a weapon).
const _POWER_ATTACK = { key: 'powerattack', name: 'Power Attack', icon: '💥', cost: 'free', freeAction: true, effect: 'buff', target: 'self', powerattack: true, sticky: true, minLevel: 1, sound: S.rage, desc: 'A FREE toggle — trade accuracy for power with a MELEE weapon: −1 to hit per +4 BAB, +2 damage each (×1.5 two-handed). Flip on or off without spending your turn.' };
const _DEADLY_AIM  = { key: 'deadlyaim',  name: 'Deadly Aim',  icon: '🎯', cost: 'free', freeAction: true, effect: 'buff', target: 'self', deadlyaim: true,  sticky: true, minLevel: 1, sound: S.bow,  desc: 'A FREE toggle — the ranged Power Attack: with a bow, crossbow or firearm, trade −2 to hit for heavy bonus damage every shot (scales with level).' };
for (const _kit of Object.values(KITS)) {
  if (!_kit || !_kit.abilities) continue;
  _kit.abilities = _kit.abilities.filter(a => a.key !== 'powerattack' && a.key !== 'deadlyaim');
  _kit.abilities.unshift({ ..._DEADLY_AIM }, { ..._POWER_ATTACK });   // both, available from level 1
}

// ── PF1 COMBAT MANEUVERS + FIGHT DEFENSIVELY on the STR front-liners ──────────
// The heavy melee get the full opposed-maneuver suite (CMB vs CMD; see the _ab*
// handlers + _heroCMB/_enemyCMD in Dungeon.js) plus a Fight Defensively stance.
// Each maneuver is its OWN button (Tobias's call). cavalier shares the fighter
// DEFAULT_KIT, so injecting into 'fighter' covers it too. We skip any a class
// already owns (fighter & monk keep their existing Trip).
const _TRIP_MV    = { key: 'trip',    name: 'Trip',     icon: '🦵', cost: 'free', effect: 'trip',    target: 'enemy', desc: 'Attack to trip (no damage). On a hit the foe is knocked prone, loses its turn, and you get a free attack. Prone = +4 for everyone to hit it.' };
const _DISARM_MV  = { key: 'disarm',  name: 'Disarm',   icon: '🌀', cost: 'free', effect: 'disarm',  target: 'enemy', desc: 'An opposed maneuver (your CMB vs its CMD) to knock a foe\'s weapon away. On a success it scrambles for its weapon (loses its next turn) and you land a free strike. (No effect on claws/fangs/fists — nothing to drop.)' };
const _BULLRUSH_MV= { key: 'bullrush',name: 'Bull Rush',icon: '💪', cost: 'free', effect: 'bullrush',target: 'enemy', desc: 'Shove a foe back — an opposed maneuver (your CMB vs its CMD). On a success it\'s driven out of reach and loses its turn closing again; a hard shove (5+ over its CMD) slams it prone. No free attack — you\'ve pushed it away.' };
const _GRAPPLE_MV = { key: 'grapple', name: 'Grapple',  icon: '🤼', cost: 'free', effect: 'grapple', target: 'enemy', desc: 'Seize a foe — an opposed maneuver (your CMB vs its CMD). On a success it\'s grappled and helpless, burning its turns struggling free (~2 rounds), and your grip crushes for a free strike. Can\'t grapple incorporeal foes.' };
const _FIGHT_DEF  = { key: 'fightdefensively', name: 'Fight Defensively', icon: '🛡️', cost: 'free', freeAction: true, effect: 'buff', target: 'self', fightdefensively: true, sticky: true, minLevel: 1, sound: S.invoke, desc: 'A FREE toggle — −4 to all your attacks (and combat maneuvers) for a +2 dodge AC (+3 if you\'re acrobatic, e.g. a monk). Flip on or off without spending your turn.' };
const _MANEUVER_CLASSES = ['fighter', 'barbarian', 'paladin', 'monk'];   // cavalier rides the fighter DEFAULT_KIT
for (const _ck of _MANEUVER_CLASSES) {
  const _k = KITS[_ck]; if (!_k || !_k.abilities) continue;
  const _have = new Set(_k.abilities.map(a => a.key));
  for (const _mv of [_TRIP_MV, _DISARM_MV, _BULLRUSH_MV, _GRAPPLE_MV, _FIGHT_DEF]) {
    if (!_have.has(_mv.key)) _k.abilities.push({ ..._mv });
  }
}
// Wizards & sorcerers get Scribe Scroll + Eschew Materials free (the caster "tax"
// feats), so their feat budget goes straight to Spell Focus / metamagic. Neither has
// a dungeon-combat effect (no component tracking here — spells already cast freely),
// so they're surfaced as flavor on the kit note rather than wired into combat math.
for (const _ck of ['wizard', 'sorcerer']) {
  const _k = KITS[_ck]; if (!_k) continue;
  _k.freeFeats = ['Scribe Scroll', 'Eschew Materials'];
  _k.note = (_k.note ? _k.note + ' ' : '') + 'Free feats: Scribe Scroll & Eschew Materials.';
}

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
    if (!ab.img && ab.key === 'haste') ab.img = '/dungeon/buffs/haste.webp';   // Haste spell reuses the green-boots buff icon for consistency
    if (ab.slvl == null && SLVL_BY_KEY[ab.key] != null) ab.slvl = SLVL_BY_KEY[ab.key];
  }
}

// ── DB-AS-SOURCE-OF-TRUTH (Phase 3) ──────────────────────────────────────────
// The kit DATA above is now codified in the content DB (kit_abilities) and
// codegen'd into kits.generated.js by scripts/gen-kits.js. At runtime the
// GENERATED file WINS — the hand-coded KITS above remains only as a fallback for
// if the generated file is ever missing. To change a spell/kit: edit the DB →
// regenerate kits.generated.js → commit it. (Don't hand-edit the block above.)
const _bloodragerKit = KITS.bloodrager;   // capture the (img-processed) hand-coded kit before the override swaps KITS
const _magusSpellstrikes = ((KITS.magus && KITS.magus.abilities) || []).filter(a => a.effect === 'spellstrike');   // v3.35.0: capture the CLEAN 5-strike list before the override (the generated kit still has the old 8)
try {
  const _gen = require('./kits.generated');
  if (_gen && Object.keys(_gen).length) KITS = _gen;
} catch (_) { /* no generated file — keep the hand-coded fallback */ }

// BLOODRAGER isn't in the content DB yet (kit_abilities), so the generated file
// omits it — re-attach the hand-coded kit AFTER the override (same pattern as
// Olbryn's storm spec below). TODO: migrate into kit_abilities on the next regen.
if (_bloodragerKit && !KITS.bloodrager) KITS.bloodrager = _bloodragerKit;

// MAGUS spellstrike rework (v3.35.0): the generated kit still carries the OLD 8-shot
// "SS …" list. Swap in the clean hand-coded 5 (Shocking Grasp / Frigid / Vampiric /
// Forceful / Polar Ray) — metamagic auto-applies via _mmForCast, and _abilitiesFor
// names them "Imbued Shot: …" (bow) / "Spell Strike: …" (melee). Post-override so it
// survives regeneration. TODO: migrate into kit_abilities on the next DB regen.
if (KITS.magus && Array.isArray(KITS.magus.abilities) && _magusSpellstrikes.length) {
  KITS.magus.abilities = KITS.magus.abilities.filter(a => a.effect !== 'spellstrike').concat(_magusSpellstrikes);
}

// ── SWASHBUCKLER + ROGUE round-to-round options (Tobias: "too few choices") ──
// Injected AFTER the generated-kit override (so it survives regeneration, like the magus/
// Olbryn re-attachments above). The two finesse skirmishers each had ONE active button
// (swashbuckler=Disarm, rogue=Feint). Both now also get FEINT (bluff a foe flat-footed → a
// free strike; the swashbuckler's Precise Strike / the rogue's Sneak Attack then lands on a
// Dex-denied target) and FIGHT DEFENSIVELY (a free −4-to-hit / +2-AC footwork toggle). Reuses
// existing effect handlers (feint, buff/fightdefensively) — no new mechanics. Skips anything a
// class already owns (rogue keeps its Feint). TODO: migrate into kit_abilities on the next regen.
const _FEINT_MV = { key: 'feint', name: 'Feint', icon: '🎭', cost: 'free', effect: 'feint', target: 'enemy', desc: 'Bluff a foe FLAT-FOOTED (an opposed check) — on a success it loses its Dex to AC and your next strike lands for FREE. A duelist opens a gap; a rogue turns it into a Sneak Attack.' };
for (const _ck of ['swashbuckler', 'rogue']) {
  const _k = KITS[_ck]; if (!_k || !Array.isArray(_k.abilities)) continue;
  const _have = new Set(_k.abilities.map(a => a.key));
  for (const _mv of [_FEINT_MV, _FIGHT_DEF]) {
    if (!_have.has(_mv.key)) _k.abilities.push({ ..._mv });
  }
}

// Olbryn's STORM specialization — injected AFTER the generated-kit override so it
// survives regeneration. Base sorcerers are fire/force themed; these char-tagged
// lightning spells (only Olbryn sees them, gated by Dungeon._charAllows) make him the
// Staff-of-Lightning storm-sorcerer. Chain Lightning he already shares with every
// sorcerer. TODO: migrate into kit_abilities (char='Olbryn') when the DB is next regen'd.
if (KITS.sorcerer && Array.isArray(KITS.sorcerer.abilities)) {
  KITS.sorcerer.abilities.push(
    { ...spontaneousSpell(SPELL.shockinggrasp, 1), char: 'Olbryn' },
    { ...spontaneousSpell(SPELL.lightningbolt, 6), char: 'Olbryn' },
  );
}

// Draymus's NECROMANCY specialization — injected AFTER the generated-kit override (so
// it survives regeneration, like Olbryn's storm spec) and BEFORE the prepared→slot
// conversion below (so these leveled spells spend a slot like the rest of his book).
// char-gated to Draymus via Dungeon._charAllows: a deeper death arsenal than a generic
// wizard — Chill Touch, Enervation, Slay Living, ON TOP of the wizard's own death spells
// (darkness, cloudkill, finger of death, horrid wilting, wail of the banshee…).
// TODO: migrate into kit_abilities (char='Draymus') when the DB is next regen'd.
if (KITS.wizard && Array.isArray(KITS.wizard.abilities)) {
  KITS.wizard.abilities.push(
    { ...preparedSpell(SPELL.chilltouch, 1),  char: 'Draymus' },
    { ...preparedSpell(SPELL.enervation, 7),  char: 'Draymus' },
    { ...preparedSpell(SPELL.slayliving, 9),  char: 'Draymus' },
    // SUMMON UNDEAD I–IX — at least one summon at every spell level (Tobias). The
    // minLevel is the wizard character level that unlocks that spell level (2N−1).
    { ...preparedSpell(SPELL.summonundead1, 1),  char: 'Draymus' },
    { ...preparedSpell(SPELL.summonundead2, 3),  char: 'Draymus' },
    { ...preparedSpell(SPELL.summonundead3, 5),  char: 'Draymus' },
    { ...preparedSpell(SPELL.summonundead4, 7),  char: 'Draymus' },
    { ...preparedSpell(SPELL.summonundead5, 9),  char: 'Draymus' },
    { ...preparedSpell(SPELL.summonundead6, 11), char: 'Draymus' },
    { ...preparedSpell(SPELL.summonundead7, 13), char: 'Draymus' },
    { ...preparedSpell(SPELL.summonundead8, 15), char: 'Draymus' },
    { ...preparedSpell(SPELL.summonundead9, 17), char: 'Draymus' },
  );
}

// Jason's FORCE PUSH — the Force Pike's Dota-Force-Staff trick, char-gated to Jason.
// Injected after the generated-kit override (like Olbryn/Draymus) so it survives
// regeneration. He forgoes his own strike to shove a foe and set up his melee allies
// for free attacks. No slvl → not a spell slot; a room-limited class-feature-style
// action (3×/room; tune `uses` to taste).
if (KITS.cleric && Array.isArray(KITS.cleric.abilities)) {
  KITS.cleric.abilities.push(
    { key: 'forcepush', name: 'Force Push', icon: '🌬️', cost: 'room', uses: 3, effect: 'forcepush', target: 'enemy', sound: S.gust, char: 'Jason',
      desc: 'Shove a foe with the Force Pike — every melee ally with their weapon OUT (they melee\'d within the last round) gets a FREE attack against it. You forgo your own strike. 3× per room.' },
    // JASON'S SUMMON DEVIL line (Cleric of Asmodeus) — the infernal mirror of Draymus's
    // Summon Undead. Char-gated; leveled spells, so the prepared→slot conversion below turns
    // them into proper cleric-slot casts. minLevel = 2N−1 (the char level a cleric first casts
    // that spell level). Bot-Jason opens a fight by calling up his biggest devil (see the
    // generic summoner check in Dungeon._botAbility).
    { ...preparedSpell(SPELL.summondevil1, 5),  char: 'Jason' },
    { ...preparedSpell(SPELL.summondevil2, 7),  char: 'Jason' },
    { ...preparedSpell(SPELL.summondevil3, 9),  char: 'Jason' },
    { ...preparedSpell(SPELL.summondevil4, 11), char: 'Jason' },
    { ...preparedSpell(SPELL.summondevil5, 13), char: 'Jason' },
    { ...preparedSpell(SPELL.summondevil6, 15), char: 'Jason' },
    { ...preparedSpell(SPELL.summondevil7, 17), char: 'Jason' },
  );
}

// PF1 CAST LIMITS (prepared casters): a leveled spell spends a SLOT of its level
// (budget from slotsFor), NOT a per-room "one of each". Convert the prepared casters'
// leveled spells (cost:'room' WITH an slvl) to cost:'slot'; class FEATURES (Channel,
// Wild Shape, Smite, Lay on Hands — no slvl) and run/free spells (Bless, Mage Armor)
// are left alone. Applied to the LIVE kits, so it works whether they came from the
// DB-generated set or the hand-coded fallback. (Tobias 2026-06-22 — "more choices,
// fewer casts.")
const _PREPARED_CASTERS = new Set(['cleric', 'druid', 'wizard', 'paladin', 'ranger', 'antipaladin']);
for (const _cls of _PREPARED_CASTERS) {
  const _k = KITS[_cls]; if (!_k || !_k.abilities) continue;
  for (const _ab of _k.abilities) {
    if (_ab.cost === 'room' && _ab.slvl != null) { _ab.cost = 'slot'; delete _ab.uses; }
  }
}

const DEFAULT_KIT = KITS.fighter;
// Classes a human may pick in the dropdown. Ranger has a kit (Danger uses it)
// but isn't offered — its bow isn't in the staple weapon list.
// Every class with a real kit + feat tree is pickable (Josh asked where ranger was).
const SELECTABLE_CLASSES = ['fighter', 'barbarian', 'ranger', 'rogue', 'paladin', 'antipaladin', 'cleric', 'wizard', 'sorcerer', 'magus', 'inquisitor', 'bard', 'druid', 'oracle', 'monk', 'swashbuckler', 'gunslinger', 'slayer', 'cavalier', 'bloodrager', 'theurge'];   // theurge = the dual arcane+divine prepared caster (Celeb's class); its kit is the cleric+wizard union, built in game/dungeon/abilities.js for any cls==='theurge'
function kitFor(classKey) { return KITS[classKey] || DEFAULT_KIT; }
const isPoolClass = (cls) => POOL_CLASSES.has(cls);
const isCaster    = (cls) => CASTER_CLASSES.has(cls);

module.exports = {
  KITS, SPELL, DEFAULT_KIT, SELECTABLE_CLASSES, CASTER_CLASSES, SPONTANEOUS_CLASSES, SLVL_BY_KEY,
  CANTRIPS, CANTRIP_BY_KEY,
  kitFor, isPoolClass, isCaster, isSpontaneous, imgFor,
  spellSlots, spontaneousSlots, slotsFor, roomUses, diceCount, channelUses, smiteUses,
};
