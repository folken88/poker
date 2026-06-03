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

// Only the SORCERER draws from a shared per-room spell pool now. Wizards AND
// clerics are prepared casters (per-spell 'room' uses, 1× each per room). All
// three are CASTERS, so the UI groups their spells under the Spellbook ▾.
const POOL_CLASSES   = new Set(['sorcerer']);
const CASTER_CLASSES = new Set(['wizard', 'sorcerer', 'cleric', 'druid']);

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
  aciddart:      { key: 'aciddart',      name: 'Acid Arrow',     icon: '🟢', cost: 'pool', effect: 'touch', target: 'enemy', die: 6, dice: 'halflevel', dcap: 5, minLevel: 3, dtype: 'acid', slvl: 2, sound: S.acid, desc: 'A bolt of acid — ranged touch for ½level d6 (sizzling acid).' },
  dispelmagic:   { key: 'dispelmagic',   name: 'Dispel Magic',   icon: '🌀', cost: 'pool', effect: 'cleanse', target: 'ally', minLevel: 5, slvl: 3, sound: S.dispel, desc: 'Strip a debuff off an afflicted ally (paralysis / stun / sickness) — or a buff off a foe, if any.' },
  holdperson:    { key: 'holdperson',    name: 'Hold Person',    icon: '🖐️', cost: 'pool', effect: 'save_debuff', target: 'enemy', save: 'will', debuff: 'paralyzed', slvl: 3, sound: S.anchor, desc: 'A foe must save or be HELD (helpless). Each of its turns it may re-save to break free — but the attempt costs its turn either way.' },
  grease:        { key: 'grease',        name: 'Grease',         icon: '🛢️', cost: 'pool', effect: 'grease', target: 'aoe', maxTargets: 2, save: 'reflex', minLevel: 1, slvl: 1, sound: S.grease, desc: 'Slick the floor — 2 foes Reflex or fall prone (splat!).' },
  sleep:         { key: 'sleep',         name: 'Sleep',          icon: '💤', cost: 'pool', effect: 'sleep',  target: 'aoe', maxTargets: 3, save: 'will',   minLevel: 1, slvl: 1, sound: S.sleep, desc: 'Up to 3 weaker foes must save or fall asleep — helpless, losing turns until struck.' },
  magicmissile:  { key: 'magicmissile',  name: 'Magic Missile',  icon: '🔮', cost: 'pool', effect: 'missile', target: 'enemy', minLevel: 1, slvl: 1, sound: S.missile, desc: 'Unerring darts of force — 1 dart +1 per 2 levels (max 5), 1d4+1 each, auto-hit.' },
  slow:          { key: 'slow',          name: 'Slow',           icon: '🐌', cost: 'pool', effect: 'slow',   target: 'aoe', randN: 2, randDie: 4, maxTargets: 8, save: 'will', minLevel: 5, slvl: 3, sound: S.slow, desc: 'Time drags for a RANDOM 2d4 foes — Will save or be SLOWED: sluggish (acts only every other turn) and easier to hit.' },
  gustofwind:    { key: 'gustofwind',    name: 'Gust of Wind',   icon: '🌪️', cost: 'pool', effect: 'grease', target: 'aoe', randFoes: 3, save: 'fort', minLevel: 4, slvl: 2, sound: S.gust, desc: 'A roaring gale blasts a RANDOM 1d3 foes — Fort save or be knocked prone.' },
  invisibility:  { key: 'invisibility',  name: 'Invisibility',   icon: '👻', cost: 'pool', effect: 'invisible', target: 'self', minLevel: 3, slvl: 2, sound: S.invis, desc: "Vanish from sight — enemies can't target you until you attack." },
  coneofcold:    { key: 'coneofcold',    name: 'Cone of Cold',   icon: '🥶', cost: 'pool', effect: 'aoe', target: 'aoe', randBase: 2, randDie: 3, save: 'reflex', die: 6, dice: 'level', dcap: 15, minLevel: 9, dtype: 'cold', slvl: 5, sound: S.coldcone, desc: 'A blast of frost engulfs 2+1d3 foes — Reflex for half (level d6).' },
  disintegrate:  { key: 'disintegrate',  name: 'Disintegrate',   icon: '☢️', cost: 'pool', effect: 'disintegrate', target: 'enemy', maxTargets: 1, save: 'fort', die: 6, dice: 'level', dcap: 20, minLevel: 11, dtype: 'force', slvl: 6, sound: S.disintegrate, desc: 'A thin green ray — ranged touch attack, then 2d6 per caster level (max 40d6). Fort partial: a made save still takes 5d6. Reduced to 0 HP → disintegrated to dust.' },
};
const ATTACK = (icon) => ({ key: 'attack', name: 'Attack', icon: icon || '⚔️', effect: 'attack', target: 'enemy' });
// A WIZARD's prepared spell: one casting per room (own 'room' use of 1).
const preparedSpell   = (spell, minLevel) => ({ ...spell, cost: 'room', uses: 1, minLevel });
// A SORCERER's known spell: spontaneous — drawn from the shared per-room cast
// pool ('pool'), so any of his few known spells can be cast until slots run out.
const spontaneousSpell = (spell, minLevel) => ({ ...spell, cost: 'pool', minLevel });
// Wizard/Sorcerer at-will is NOT a weapon swing — it's an Elemental Ray: an
// unlimited ranged touch attack for 1d6+4 (cold). Used in the dungeon AND for
// poker-table harassment. (Ice-punch sound.)
const RAY_OF_FROST = { key: 'rayoffrost', name: 'Ray of Frost', icon: '❄️', effect: 'bolt', target: 'enemy', die: 6, dice: 1, flat: 4, dtype: 'cold', sound: S.frost, desc: 'Elemental Ray — a ranged touch attack for 1d6+4 cold (unlimited).' };

const KITS = {
  // ── Martials (conditional maneuvers) ──
  fighter: { atwill: ATTACK('⚔️'), abilities: [
    { key: 'trip',   name: 'Trip',   icon: '🦵', cost: 'free', effect: 'trip',   target: 'enemy', desc: 'Attack to trip (no damage). On a hit the foe is knocked prone, loses its turn, and you get a free attack. Prone = +4 for everyone to hit it.' },
    { key: 'cleave', name: 'Cleave', icon: '🪓', cost: 'free', effect: 'cleave', target: 'enemy', desc: 'Swing through — hit your target, then a second foe (−2). Great Cleave: every foe you DROP grants another swing, chaining until you stop felling them.' },
  ] },
  barbarian: { atwill: ATTACK('⚔️'), abilities: [
    { key: 'cleave', name: 'Cleave', icon: '🪓', cost: 'free', effect: 'cleave', target: 'enemy', acPen: 2, desc: 'Hit your target and a second foe (−2) — every foe you DROP grants another swing, chaining until you stop felling them — but you drop your guard (−2 AC) this turn.' },
    { key: 'rage',   name: 'Rage',   icon: '😤', cost: 'free', freeAction: true, effect: 'buff', target: 'self', buff: { toHit: 2, dmg: 2, acPen: 2, save: 1 }, sticky: true, sound: S.rage, desc: 'Fly into a rage for the rest of the room (FREE action — still attack this turn): +2 to hit & damage and +1 Will, but −2 AC.' },
  ] },
  ranger: { atwill: ATTACK('🏹'), abilities: [
    { key: 'rapidshot', name: 'Rapid Shot',    icon: '🏹', cost: 'free', effect: 'rapidshot', target: 'enemy', sound: S.bowmulti, desc: 'Loose 2 arrows this turn — each at −2 to hit.' },
    { key: 'bullseye',  name: 'Bullseye Shot',  icon: '🎯', cost: 'free', effect: 'bullseye',  target: 'enemy', sound: S.bow,      desc: 'A carefully aimed shot at +4 to hit.' },
  ] },
  rogue: { atwill: ATTACK('🗡️'), abilities: [
    { key: 'feint', name: 'Feint', icon: '🎭', cost: 'free', effect: 'feint', target: 'enemy', desc: 'Bluff a foe flat-footed; on success, a free Sneak-Attack strike. (You also Sneak Attack any prone/sickened/paralyzed/flat-footed foe, and strike twice with daggers.)' },
  ] },
  // ── Divine (channels) ──
  paladin: { atwill: ATTACK('⚔️'), abilities: [
    { key: 'smite',   name: 'Smite Evil',     icon: '⚜️', cost: 'room', uses: smiteUses, effect: 'smite', target: 'self', sound: S.holy, desc: 'Once per 5 levels per room: your strikes smite evil foes (+to-hit, +double your level to damage).' },
    { key: 'channel', name: 'Channel Positive', icon: '💖', cost: 'room', uses: channelUses, effect: 'heal', heal: 'party', target: 'ally', sound: S.charge, desc: 'Channel positive energy — heal the whole party (scales with level).' },
  ] },
  // CLERIC — prepared divine caster (like the wizard): ONE casting of each prayer
  // per room. Plus two specials: CHANNEL POSITIVE refreshes a small own-count each
  // room (one per 5 levels), and BLESS is cast ONCE for the WHOLE dungeon (cost
  // 'run') — a +1 to-hit that never fades between rooms.
  cleric: { atwill: ATTACK('🔨'), note: 'One casting of each prayer, per room.', abilities: [
    { key: 'curelight',    name: 'Cure Light Wounds',    icon: '💚', cost: 'room', uses: 1, effect: 'heal', heal: 'single', healDice: 1, healCap: 5,  target: 'ally', sound: S.cure,    desc: 'Heal the most-hurt ally — 1d8 + caster level (max +5).' },
    { key: 'curemoderate', name: 'Cure Moderate Wounds', icon: '💚', cost: 'room', uses: 1, effect: 'heal', heal: 'single', healDice: 2, healCap: 10, target: 'ally', sound: S.cure,    desc: 'Heal the most-hurt ally — 2d8 + caster level (max +10).' },
    { key: 'divinefavor',  name: 'Divine Favor',         icon: '🙏', cost: 'room', uses: 1, effect: 'buff', target: 'self', buff: { toHit: 3, dmg: 3 }, sticky: true, sound: S.invoke,   desc: '+3 to hit and +3 damage to yourself for the rest of the room.' },
    { key: 'holysmite',    name: 'Holy Smite',           icon: '🌟', cost: 'room', uses: 1, effect: 'aoe', target: 'aoe', maxTargets: 2, save: 'will', die: 8, dice: 'halflevel', dcap: 5, dtype: 'holy', sound: S.sunstrike, desc: 'Searing light scourges 2 foes — Will for half (½level d8).' },
    { key: 'searinglight', name: 'Searing Light',        icon: '🔆', cost: 'room', uses: 1, minLevel: 5, effect: 'touch', target: 'enemy', die: 8, dice: 'halflevel', dcap: 5, dtype: 'holy', sound: S.searing, desc: 'A ray of divine light — ranged touch for ½level d8 (extra vs undead).' },
    { key: 'prayer',       name: 'Prayer',               icon: '📿', cost: 'room', uses: 1, effect: 'buff', target: 'self', party: true, buff: { toHit: 1, dmg: 1 }, sticky: true, sound: S.prayer, desc: 'All allies gain +1 to hit and +1 damage for the rest of the room.' },
    { key: 'bless',        name: 'Bless',                icon: '✨', cost: 'run',  uses: 1, effect: 'buff', target: 'self', party: true, persist: true, buff: { toHit: 1 }, sticky: true, sound: S.cure, desc: 'All allies gain +1 to hit for the ENTIRE dungeon — cast once; it never fades between rooms.' },
    { key: 'channel',      name: 'Channel Positive',     icon: '💖', cost: 'room', uses: smiteUses, effect: 'heal', heal: 'party', target: 'ally', sound: S.charge, desc: 'Channel positive energy — heal the whole party for ½level d6 (PF1e). Once per 5 levels per room.' },
    { key: 'boneshatter',  name: 'Boneshatter',          icon: '🦴', cost: 'room', uses: 1, minLevel: 5,  effect: 'aoe', target: 'aoe', maxTargets: 1, save: 'fort', die: 6, dice: 'level', dcap: 8, dtype: 'negative', sound: S.boneshatter, desc: 'Splinter a foe\'s bones — ½level… up to level d6 negative energy, Fort for half.' },
    // High-level prayers, unlocked by caster level (PF1e progression):
    { key: 'breathoflife', name: 'Breath of Life',       icon: '🌬️', cost: 'room', uses: 1, minLevel: 7,  effect: 'revive', reviveDice: 5, reviveCap: 25, target: 'ally', sound: S.revive, desc: 'Snatch a DYING ally back — revive & heal them 5d8 + caster level (max +25). (CL 7+)' },
    { key: 'raisedead',    name: 'Raise Dead',           icon: '⚰️', cost: 'room', uses: 1, minLevel: 9,  effect: 'revive', raiseDead: true, target: 'ally', sound: S.revive, desc: 'Call a SLAIN ally back into the run, restored to half health. (CL 9+)' },
    { key: 'resurrection', name: 'Resurrection',         icon: '✨', cost: 'room', uses: 1, minLevel: 13, effect: 'revive', raiseDead: true, full: true, target: 'ally', sound: S.revive, desc: 'Fully resurrect a SLAIN ally — back in the run at FULL health. (CL 13+)' },
  ] },
  // ── Full arcane casters ──
  // WIZARD — prepared caster: a BROAD spellbook, but ONE casting of each spell
  // per room (cost:'room', uses:1). Wired via a helper so every spell is single-
  // shot per room without repeating the override on each line.
  wizard: { atwill: { ...RAY_OF_FROST }, note: 'One casting of each spell, per room.', abilities: [
    preparedSpell(SPELL.shockinggrasp, 1),
    preparedSpell(SPELL.grease,        1),
    preparedSpell(SPELL.sleep,         1),
    preparedSpell(SPELL.invisibility,  3),
    preparedSpell(SPELL.aciddart,      3),
    preparedSpell(SPELL.scorchingray,  3),
    preparedSpell(SPELL.holdperson,    3),
    preparedSpell(SPELL.dispelmagic,   5),
    { key: 'haste', name: 'Haste', icon: '💨', cost: 'room', uses: 1, minLevel: 5, slvl: 3, effect: 'haste', target: 'self', party: true, sounds: HASTE_SFX, desc: 'The whole party blurs with speed — every ally gets an EXTRA attack each turn for 1 turn per 5 caster levels (on top of their action).' },
    preparedSpell(SPELL.slow,          5),
    preparedSpell(SPELL.fireball,      5),
    preparedSpell(SPELL.lightningbolt, 5),
    preparedSpell(SPELL.coneofcold,    9),
    preparedSpell(SPELL.disintegrate,  11),
  ] },
  // SORCERER — spontaneous caster: knows FEWER spells, drawn from a shared
  // per-room cast pool (his limited casts/day = casts/room). A focused blaster's
  // signature repertoire he can recast freely until the pool empties.
  sorcerer: { atwill: { ...RAY_OF_FROST }, note: 'Few spells — limited casts each room.', abilities: [
    spontaneousSpell(SPELL.magicmissile, 1),
    spontaneousSpell(SPELL.burninghands, 1),
    spontaneousSpell(SPELL.aciddart,     3),
    spontaneousSpell(SPELL.gustofwind,   4),
    spontaneousSpell(SPELL.scorchingray, 4),
    spontaneousSpell(SPELL.slow,         6),
    spontaneousSpell(SPELL.fireball,     7),
    spontaneousSpell(SPELL.coneofcold,   9),
    spontaneousSpell(SPELL.disintegrate, 11),
  ] },
  // ── Hybrids ──
  // MAGUS — basic attack with the player's chosen weapon (martial proficiency).
  // Spell Strike = that same attack PLUS Shocking Grasp (+level d6 electricity,
  // cap 5d6), usable once per room per 5 levels (like Smite). Shield = a sticky
  // +4 AC ward for the rest of the room. (Per-magus Spell Strike SFX — Kate's
  // "boudicca", Vaughan's anime sword, Toni's axe — are wired in Dungeon.js.)
  magus: { atwill: ATTACK('⚔️'), abilities: [
    { key: 'spellstrike', name: 'Spell Strike', icon: '⚡', cost: 'room', uses: smiteUses, effect: 'spellstrike', target: 'enemy', die: 6, dice: 'level', dcap: 5, dtype: 'electricity', sound: S.shock, desc: 'Channel Shocking Grasp through your weapon — your normal attack PLUS up to +5d6 electricity (level d6, cap 5d6). Usable once per room per 5 levels.' },
    { key: 'frigidtouch', name: 'Frigid Touch', icon: '🧊', cost: 'room', uses: smiteUses, minLevel: 3, effect: 'spellstrike', target: 'enemy', die: 6, dice: 4, dtype: 'cold', debuff: 'sickened', sound: S.frostbite, desc: 'A freezing spellstrike — your attack +4d6 cold that staggers the foe (sickened).' },
    { key: 'shield',      name: 'Shield',       icon: '🛡️', cost: 'free', effect: 'buff', target: 'self', buff: { ac: 4 }, sticky: true, sound: S.inspire, desc: 'Raise an arcane Shield — +4 AC for the rest of the room.' },
  ] },
  // INQUISITOR — Bane + Searing Light, plus JUDGEMENTS: a free-action toggle (only
  // ONE active at a time, switchable on your turn at no action cost).
  inquisitor: { atwill: ATTACK('⚔️'), abilities: [
    { key: 'bane',        name: 'Bane',         icon: '🗡️', cost: 'room', uses: 1, effect: 'buff', target: 'self', buff: { toHit: 2, dmg: 2, bonusDice: 2 }, sticky: true, sound: S.umbral, desc: 'Your weapon turns bane against your foes — +2 to hit and +2d6+2 damage for the rest of the room.' },
    { key: 'searinglight', name: 'Searing Light', icon: '🔆', cost: 'room', uses: 1, minLevel: 5, effect: 'touch', target: 'enemy', die: 8, dice: 'halflevel', dcap: 5, dtype: 'holy', sound: S.searing, desc: 'A ray of divine light — ranged touch for ½level d8 (extra vs undead).' },
    { key: 'judg_destruction', name: 'Judgement: Destruction', icon: '⚔️', cost: 'free', effect: 'judgment', judgmentType: 'destruction', sound: S.judgment, desc: 'JUDGEMENT (only one active; switch free on your turn): +damage on your strikes.' },
    { key: 'judg_protection',  name: 'Judgement: Protection',  icon: '🛡️', cost: 'free', effect: 'judgment', judgmentType: 'protection',  sound: S.judgment, desc: 'JUDGEMENT (only one active; switch free): +AC against your foes.' },
    { key: 'judg_healing',     name: 'Judgement: Healing',     icon: '💗', cost: 'free', effect: 'judgment', judgmentType: 'healing',     sound: S.judgment, desc: 'JUDGEMENT (only one active; switch free): regenerate HP each of your turns.' },
  ] },
  bard: { atwill: ATTACK('🗡️'), abilities: [
    { key: 'inspire',   name: 'Inspire Courage', icon: '🎶', cost: 'run', uses: 1, effect: 'buff', target: 'self', party: true, persist: true, buff: { toHit: 1, dmg: 1 }, sticky: true, sound: S.bardsong, desc: 'Strike up a song — you and all allies get +1 to hit and damage for the ENTIRE dungeon (struck up once).' },
    { key: 'haste',     name: 'Haste',           icon: '💨', cost: 'room', uses: 1, minLevel: 7, slvl: 3, effect: 'haste', target: 'self', party: true, sounds: HASTE_SFX, desc: 'The whole party blurs with speed — an EXTRA attack each turn for 1 turn per 5 caster levels. (Bard 3rd-level spell.)' },
    { key: 'slow',      name: 'Slow',            icon: '🐌', cost: 'room', uses: 1, minLevel: 7, slvl: 3, effect: 'slow', target: 'aoe', randN: 2, randDie: 4, maxTargets: 8, save: 'will', sound: S.slow, desc: 'Time drags for a RANDOM 2d4 foes — Will save or be SLOWED: sluggish (acts only every other turn) and easier to hit. (Bard 3rd-level spell.)' },
    { key: 'hideouslaughter', name: 'Hideous Laughter', icon: '😂', cost: 'free', effect: 'save_debuff', target: 'enemy', save: 'will', debuff: 'paralyzed', slvl: 2, sound: S.hideous, desc: 'A foe collapses in helpless laughter — Will save or HELD (helpless, Sneak-Attackable). Each turn it may re-save to recover, but the attempt costs its turn.' },
    { key: 'fascinate', name: 'Fascinate',       icon: '🎵', cost: 'free', effect: 'fascinate', target: 'aoe', maxTargets: 3, sound: S.fascinate, desc: 'Up to 3 foes stand fascinated and lose their turns — until something hits them.' },
  ] },
  // DRUID — prepared nature caster: one casting of each spell per room.
  druid: { atwill: ATTACK('🌿'), note: 'One casting of each spell, per room.', abilities: [
    { key: 'entangle',   name: 'Entangle',          icon: '🌿', cost: 'room', uses: 1, effect: 'grease', target: 'aoe', randFoes: 4, save: 'reflex', sound: S.entangle, desc: 'Grasping vines erupt — a RANDOM 1d4 foes Reflex or are rooted (knocked prone).' },
    { key: 'curelight',  name: 'Cure Light Wounds', icon: '💚', cost: 'room', uses: 1, effect: 'heal', heal: 'single', healDice: 1, healCap: 5, target: 'ally', sound: S.cure, desc: 'Heal the most-hurt ally — 1d8 + caster level (max +5).' },
    { key: 'calllightning', name: 'Call Lightning', icon: '⚡', cost: 'room', uses: 1, minLevel: 5, effect: 'aoe', target: 'aoe', maxTargets: 2, save: 'reflex', die: 6, dice: 'halflevel', dcap: 5, dtype: 'electricity', sounds: THUNDER_SFX, desc: 'A bolt from the storm strikes 2 foes — Reflex for half (½level d6).' },
  ] },
};

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
};
// Attach an `img` (and a divine `slvl` fallback) to every ability + at-will.
for (const kit of Object.values(KITS)) {
  if (kit.atwill) kit.atwill.img = imgFor(kit.atwill.key);
  for (const ab of kit.abilities) {
    ab.img = imgFor(ab.key);
    if (ab.slvl == null && SLVL_BY_KEY[ab.key] != null) ab.slvl = SLVL_BY_KEY[ab.key];
  }
}

const DEFAULT_KIT = KITS.fighter;
// Classes a human may pick in the dropdown. Ranger has a kit (Danger uses it)
// but isn't offered — its bow isn't in the staple weapon list.
const SELECTABLE_CLASSES = ['fighter', 'barbarian', 'rogue', 'paladin', 'cleric', 'wizard', 'sorcerer', 'magus', 'inquisitor', 'bard', 'druid'];
function kitFor(classKey) { return KITS[classKey] || DEFAULT_KIT; }
const isPoolClass = (cls) => POOL_CLASSES.has(cls);
const isCaster    = (cls) => CASTER_CLASSES.has(cls);

module.exports = {
  KITS, DEFAULT_KIT, SELECTABLE_CLASSES, kitFor, isPoolClass, isCaster, imgFor,
  spellSlots, roomUses, diceCount, channelUses, smiteUses,
};
