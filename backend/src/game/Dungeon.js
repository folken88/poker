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
const { CLASSES, babFor, weaponProficient, NON_PROFICIENT_PENALTY } = require('../pf1data/classes');
const { kitFor, roomUses, isPoolClass, isCaster, spellSlots, diceCount } = require('../pf1data/abilities');
const { logDungeon, recordSound } = require('../persistence/logger');
const banter = require('../bot/banter');

// ── Tuning knobs ────────────────────────────────────────────────────────────
// LEVEL = 1 + sum of all gear bonuses (min 1). Level drives HP, to-hit, and
// saves — for humans AND AI allies.
const HP_PER_LEVEL   = 10;   // legacy fallback (used only if a class has no Hit Die)
// HP per level is the class's Hit Die, MAX roll assumed (barbarian d12, fighter
// d10, rogue/cleric/bard d8, wizard/sorcerer d6 …). So a level-6 fighter has 60
// HP, a level-6 wizard 36.
function hdFor(cls) { return (CLASSES[cls] && CLASSES[cls].hd) || HP_PER_LEVEL; }
function maxHpFor(cls, level) { return hdFor(cls) * Math.max(1, level || 1); }
function levelOf(gear) { return Math.max(1, 1 + totalMagicBonus(gear)); }
const LIGHTNING_MAX_TARGETS = 2;
const SICKENED_ROUNDS = 3;
const SICKENED_PENALTY = 2;
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
// Class conditionals (powered by the alignment / flat-footed tracking).
const SNEAK_CLASSES = new Set(['rogue', 'ninja', 'slayer']);  // gain Sneak Attack
const SNEAK_DICE_CAP = 5;     // cap precision dice so it stays flavorful, not silly
const SMITE_TOHIT    = 2;     // paladin Smite Evil: to-hit bump vs an evil foe (+level dmg)
const AFK_PASS_MS    = 30_000; // idle on your turn → auto-ATTACK after 30s
const ENEMY_STEP_MS  = 1000;   // ~1s pacing between auto-resolved enemy/ally turns (slowed slightly for readability)
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
  skeleton:          { name: 'Skeleton',          glyph: '💀', cr: '1/3', hp: 5,   ac: 16, toHit: 2,  dmgDie: 6,  dmgBonus: 2, fort: 0,  reflex: 1,  gold: [8, 20] },
  giant_spider:      { name: 'Giant Spider',      glyph: '🕷️', cr: '1',   hp: 16,  ac: 14, toHit: 4,  dmgDie: 6,  dmgBonus: 0, fort: 4,  reflex: 4,  gold: [10, 26] },
  zombie:            { name: 'Zombie',            glyph: '🧟', cr: '1/2', hp: 12,  ac: 12, toHit: 4,  dmgDie: 6,  dmgBonus: 4, fort: 0,  reflex: 0,  gold: [10, 26] },
  ghoul:             { name: 'Ghoul',             glyph: '🧛', cr: '1',   hp: 13,  ac: 14, toHit: 3,  dmgDie: 6,  dmgBonus: 1, fort: 1,  reflex: 3,  gold: [14, 32], paralyze: true, paralyzeDC: 13 },
  cultist:           { name: 'Whispering Cultist',glyph: '🕯️', cr: '1',   hp: 14,  ac: 14, toHit: 3,  dmgDie: 8,  dmgBonus: 1, fort: 3,  reflex: 1,  gold: [16, 38] },
  ghast:             { name: 'Ghast',             glyph: '🧟‍♂️', cr: '2', hp: 17,  ac: 17, toHit: 6,  dmgDie: 8,  dmgBonus: 3, fort: 2,  reflex: 5,  gold: [28, 60], paralyze: true, paralyzeDC: 15 },
  monk:              { name: 'Monk',              glyph: '🥋', cr: '2',   hp: 22,  ac: 16, toHit: 4,  dmgDie: 6,  dmgBonus: 2, fort: 4,  reflex: 5,  gold: [18, 42], attacks: 2, evasion: true, tokenPool: MONK_TOKENS, atkSounds: BRUCE_SFX },  // flurry of unarmed strikes; random face + kiai; Evasion
  skeletal_champion: { name: 'Skeletal Champion', glyph: '☠️', cr: '2',   hp: 19,  ac: 17, toHit: 5,  dmgDie: 8,  dmgBonus: 3, fort: 3,  reflex: 2,  gold: [26, 55], shout: { dc: 14, sound: '/audio/enemy_draugr_shout.mp3' } },   // bone-rattling shout: 1d8 + Fort or stunned 1
  shadow:            { name: 'Shadow',            glyph: '🌑', cr: '3',   hp: 19,  ac: 13, toHit: 4,  dmgDie: 6,  dmgBonus: 0, fort: 1,  reflex: 3,  gold: [30, 65] },
  fire_skeleton:     { name: 'Fire Skeleton',     glyph: '🔥', cr: '3',   hp: 22,  ac: 16, toHit: 5,  dmgDie: 6,  dmgBonus: 2, fort: 1,  reflex: 2,  gold: [24, 52], detonate: { count: 2, die: 6, sound: '/audio/enemy_fireskeleton_boom.mp3' } },   // suicide bomber: on its TURN it rushes in and detonates — 1d6 fire/level to 1d2 heroes, destroying itself (kill it first to defuse)
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
  gargoyle:          { name: 'Gargoyle',          glyph: '🪨', cr: '4',   hp: 42,  ac: 16, toHit: 9,  dmgDie: 6,  dmgBonus: 4,  fort: 5,  reflex: 6,  attacks: 2, gold: [36, 78], flying: true },
  minotaur:          { name: 'Minotaur',          glyph: '🐂', cr: '4',   hp: 45,  ac: 14, toHit: 9,  dmgDie: 6,  dmgCount: 3, dmgBonus: 6, fort: 6, reflex: 5, gold: [38, 80], atkSound: '/audio/enemy_yak.mp3' },   // greataxe 3d6+6 — angry bovine bellow
  basilisk:          { name: 'Basilisk',          glyph: '🐍', cr: '5',   hp: 52,  ac: 16, toHit: 9,  dmgDie: 8,  dmgBonus: 4,  fort: 7,  reflex: 4,  paralyze: true, paralyzeDC: 13, gold: [42, 90] },  // petrifying gaze → "turned to stone, lose a turn"
  winter_wolf:       { name: 'Winter Wolf',       glyph: '🐺', cr: '5',   hp: 57,  ac: 18, toHit: 11, dmgDie: 8,  dmgBonus: 7,  fort: 9,  reflex: 7,  gold: [44, 95] },
  blood_caimon:      { name: 'Blood Caimon',      glyph: '🐊', cr: '5',   hp: 60,  ac: 16, toHit: 11, dmgDie: 10, dmgBonus: 9,  fort: 8,  reflex: 5,  gold: [48, 105], atkSound: '/audio/enemy_caimon_bite.mp3' },   // giant red alligator — savage bite
  wood_golem:        { name: 'Wood Golem',        glyph: '🪵', cr: '6',   hp: 58,  ac: 21, toHit: 10, dmgDie: 8,  dmgCount: 2, dmgBonus: 5, fort: 2, reflex: 2, attacks: 2, gold: [55, 115] },         // two 2d8+5 slams; golem-poor saves
  bog_brute:         { name: 'Bog Brute',         glyph: '🌿', cr: '6',   hp: 65,  ac: 17, toHit: 12, dmgDie: 8,  dmgBonus: 7,  fort: 9,  reflex: 4,  attacks: 2, gold: [55, 115] },
  dire_bear:         { name: 'Dire Bear',         glyph: '🐻', cr: '7',   hp: 84,  ac: 17, toHit: 16, dmgDie: 8,  dmgBonus: 10, fort: 13, reflex: 9, attacks: 2, gold: [70, 150], art: '/dungeon/monsters/dire_bear.webp' },
  chimera:           { name: 'Chimera',           glyph: '🦁', cr: '7',   hp: 76,  ac: 19, toHit: 11, dmgDie: 8,  dmgBonus: 4,  fort: 10, reflex: 6, attacks: 2, gold: [75, 160], flying: true },
  hill_giant:        { name: 'Hill Giant',        glyph: '🪓', cr: '7',   hp: 85,  ac: 21, toHit: 16, dmgDie: 8,  dmgCount: 2, dmgBonus: 10, fort: 12, reflex: 3, gold: [80, 165] },                   // greatclub 2d8+10
  medusa:            { name: 'Medusa',            glyph: '🐍', cr: '7',   hp: 76,  ac: 15, toHit: 9,  dmgDie: 4,  dmgBonus: 2,  fort: 6,  reflex: 8,  attacks: 2, paralyze: true, paralyzeDC: 15, gold: [80, 165] },  // petrifying gaze
  stone_giant:       { name: 'Stone Giant',       glyph: '🗿', cr: '8',   hp: 102, ac: 24, toHit: 17, dmgDie: 8,  dmgCount: 2, dmgBonus: 12, fort: 12, reflex: 5, gold: [95, 190] },                  // greatclub 2d8+12
  abyssal_horror:    { name: 'Abyssal Horror',    glyph: '🐙', cr: '8',   hp: 95,  ac: 19, toHit: 14, dmgDie: 8,  dmgBonus: 6,  fort: 9,  reflex: 6,  attacks: 2, gold: [95, 190] },                  // eldritch chaos beast
  brass_golem:       { name: 'Brass Golem',       glyph: '🗿', cr: '9',   hp: 92,  ac: 24, toHit: 14, dmgDie: 10, dmgCount: 2, dmgBonus: 9, fort: 3, reflex: 3, attacks: 2, gold: [180, 320] },                  // 8-HD construct, two 2d10+9 slams
  barbed_devil:      { name: 'Barbed Devil',      glyph: '😈', cr: '11',  hp: 138, ac: 26, toHit: 18, dmgDie: 8,  dmgCount: 2, dmgBonus: 7, fort: 12, reflex: 9, attacks: 2, gold: [260, 460] },                 // hamatula, two 2d8+7 claws
  vampire:           { name: 'Vampire',           glyph: '🧛', cr: '8',   hp: 95,  ac: 22, toHit: 14, dmgDie: 6,  dmgBonus: 8, fort: 8,  reflex: 11, attacks: 2, gold: [100, 200], evil: true, shout: { fear: true, dc: 18, sound: '/audio/enemy_lich_gaze.mp3' } },   // dominating gaze → Will or frozen in terror
  lich:              { name: 'Lich',              glyph: '💀', cr: '12',  hp: 138, ac: 25, toHit: 16, dmgDie: 8,  dmgBonus: 5, fort: 10, reflex: 9,  gold: [300, 520], evil: true, shout: { fear: true, dc: 20, sound: '/audio/enemy_lich_gaze.mp3' } },                 // sinister gaze → fear
};
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
  blood_caimon: 'blood_caimon',
};
for (const [k, name] of Object.entries(MON_ART)) if (MON[k]) MON[k].art = `/dungeon/monsters/${name}.webp`;

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
  vampire:       { cold: 0.5, electricity: 0.5 },  // classic vampire energy resistance
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
const XP_BY_CR = { 1: 400, 2: 600, 3: 800, 4: 1200, 5: 1600, 6: 2400, 7: 3200, 8: 4800, 9: 6400, 10: 9600, 11: 12800, 12: 19200, 13: 25600, 14: 38400, 15: 51200 };
function xpForCR(cr) {
  if (cr <= 0) return 50;
  if (cr < 1) return cr <= 0.25 ? 100 : cr <= 0.34 ? 135 : 200;   // 1/4, 1/3, 1/2
  return XP_BY_CR[Math.min(15, Math.round(cr))] || 400;
}
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
      if (Math.random() > 0.45) return;
    } else if (Math.random() > 0.5) return;
    this._emitBanter(member, eventType, ctx);
  }
  _emitBanter(member, eventType, ctx) {
    const flavorNick = member.trueNick || member.nickname;   // Vorkstag keeps his own creepy voice…
    const label = member.nickname;                           // …but is shown + voiced as whoever he wears
    Promise.resolve(banter.dungeonLine(flavorNick, eventType, { ...ctx, voiceNick: label })).then(res => {
      if (!res || !res.line) return;
      this._note(`💬 ${label}: ${res.line}`);
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
    this.log.push({ t: ++this._logSeq, text, sound: sound || null, side, kind });
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
  _targetableParty() { const live = this.alivePresent(); const seen = live.filter(m => !m.invisible); return seen.length ? seen : live; }
  livingEnemies() { return this.enemies.filter(e => e.hp > 0); }

  hasMember(playerId) { const m = this.member(playerId); return !!(m && !m.left && m.hp > 0); }
  botCount() { return this.party.filter(m => m.isBot && !m.left && m.hp > 0).length; }

  addMember(player, isBot = false) {
    const playerId = player.player_id;
    const idx = this.party.findIndex(m => m.playerId === playerId);
    if (idx >= 0 && !this.party[idx].left && this.party[idx].hp > 0) return this.party[idx];  // already active
    if (idx >= 0) this.party.splice(idx, 1);   // drop a stale (downed/bailed) entry → rejoin fresh
    const gear = db.getGear(playerId);
    const level = levelOf(gear);
    const cls = player.class || 'fighter';
    const maxHp = maxHpFor(cls, level);        // HP = class Hit Die × level (max roll)
    const m = {
      playerId,
      nickname: player.nickname || playerId,
      avatarId: player.avatar_id || null,
      isBot: !!isBot,
      gear, level,
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
    if (o.paralyzed > 0) c.push(o.heldDC
      ? { key: 'held',      label: 'Held',      desc: 'helpless — re-saves each turn (the attempt costs the turn)', icon: `${I}paralyzed.webp` }
      : { key: 'paralyzed', label: 'Paralyzed', desc: 'frozen — loses turns; easy to hit', icon: `${I}paralyzed.webp` });
    if (o.slowed > 0)    c.push({ key: 'slowed',    label: 'Slowed',    desc: 'sluggish — acts only every other turn; −1 AC', icon: `${I}slowed.webp` });
    if (o.stunned > 0)   c.push({ key: 'stunned',   label: 'Stunned',   desc: 'loses a turn', icon: `${I}stunned.webp` });
    if (o.fascinated)    c.push({ key: 'asleep',    label: 'Asleep',    desc: 'helpless — loses turns until struck', icon: `${I}sleep.webp` });
    if (o.prone)         c.push({ key: 'prone',     label: 'Prone',     desc: 'knocked down — +4 for all to hit it', icon: `${I}prone.webp` });
    return c;
  }

  // Active BUFFS on a hero, as Foundry-art icons for the dungeon UI. Sticky room
  // buffs (rage/bane/divine favor/prayer/shield) come from buffApplied; run-long
  // ones (bless/inspire) from runBuffApplied; smite/haste/invisible/judgement are
  // their own flags.
  _buffList(m) {
    const I = '/dungeon/buffs/', c = [];
    const push = (k, label, desc) => c.push({ key: k, label, desc, icon: `${I}${k}.webp` });
    const ap = m.buffApplied || {}, run = m.runBuffApplied || {};
    if (ap.rage)        push('rage', 'Rage', '+2 hit & damage, −2 AC (this room)');
    if (ap.bane)        push('bane', 'Bane', '+2 hit, +2d6+2 vs foes (this room)');
    if (ap.divinefavor) push('divinefavor', 'Divine Favor', '+3 hit & damage (this room)');
    if (ap.prayer)      push('prayer', 'Prayer', 'allies +1 hit & damage (this room)');
    if (ap.shield || (m.buffs && m.buffs.ac > 0)) push('shield', 'Shield', '+4 AC (this room)');
    if (run.bless)      push('bless', 'Bless', '+1 to hit — whole dungeon');
    if (run.inspire)    push('inspire', 'Inspire Courage', 'allies +1 hit & damage — whole dungeon');
    if (m.smiteActive)  push('smite', 'Smite', '+hit & +2×level damage vs evil');
    if (m.hasted > 0)   push('haste', 'Haste', `an extra attack each turn (${m.hasted} left)`);
    if (m.invisible)    push('invisible', 'Invisible', 'unseen — until you attack');
    if (m.judgment === 'destruction') push('judg_destruction', 'Judgement: Destruction', '+damage on your strikes');
    if (m.judgment === 'protection')  push('judg_protection', 'Judgement: Protection', '+AC');
    if (m.judgment === 'healing')     push('judg_healing', 'Judgement: Healing', 'regenerate HP each turn');
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
        playerId: m.playerId, nickname: m.nickname, avatarId: m.avatarId, isBot: m.isBot,
        cls: m.cls || 'fighter', weapon: m.weaponKey || 'dagger',
        level: m.level, hp: Math.max(0, m.hp), maxHp: m.maxHp,
        dead: !!m.dead, downed: !m.dead && !m.left && m.hp <= 0,
        dyingHp: (!m.dead && !m.left && m.hp <= 0) ? m.hp : null,
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
        align: e.align || 'NE', evil: !!e.evil, flatFooted: !!e.flatFooted, prone: !!e.prone, fascinated: !!e.fascinated,
        conditions: e.hp > 0 ? this._condList(e) : [],
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
    for (const m of this.present()) { this._resetAbilities(m); m.flatFooted = true; }  // refresh per-room spells/channels + flat-footed until they act
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
    let cand = SPAWNABLE.filter(k => MON[k].crNum >= floorCR && MON[k].crNum <= capCR && xpForCR(MON[k].crNum) <= budget);
    if (!cand.length) cand = SPAWNABLE.filter(k => MON[k].crNum <= capCR && xpForCR(MON[k].crNum) <= budget);
    if (!cand.length) return null;
    const weights = cand.map(k => 1 / Math.max(1, xpForCR(MON[k].crNum)));
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
      ac: base.ac, toHit: base.toHit,
      dmgDie: base.dmgDie, dmgCount: base.dmgCount || 1, dmgBonus: base.dmgBonus,
      fort: base.fort, reflex: base.reflex,
      align: base.align || 'NE', evil: !!base.evil,
      flatFooted: true, prone: false, fascinated: false, loseTurn: false,
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
      resist: base.resist || null,         // energy resistances / vulnerabilities (see RESIST_BY_KEY)
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
        budget -= xpForCR(MON[key].crNum);
      }
    };
    if (boss) {
      keys.push(this._pickBoss(encCR));   // one strong foe
      // Boss rooms also mob a big party — minions at a notch below the room CR.
      const baseCR = this._minLevel() + Math.floor(this.depth / 4);
      fill(Math.round(xpForCR(baseCR) * Math.max(0, partyN - 1) * 0.6),
           Math.max(0.25, encCR - 6), Math.max(1, encCR - 2), 1 + partyN);
    } else {
      fill(Math.round(xpForCR(encCR) * sizeMult),
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
    for (const m of this.alivePresent()) order.push({ kind: 'party', id: m.playerId, init: dRoll(20) + 2 + Math.floor((m.level || 1) / 2) });
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
      if (e.fascinated) { this._note(`${e.glyph} ${e.name} stands fascinated — does nothing.`, null, { side: 'enemy' }); this._broadcast(); return this._nextTurn(); }
      if (e.paralyzed > 0) {
        if (e.heldDC) {   // Hold Person / Hideous Laughter: a NEW Will save each turn — costs the turn either way (PF1e).
          e.paralyzed -= 1; const hdc = e.heldDC;
          const sv = this._saveVs(this._enemySave(e, 'will'), hdc);
          if (sv.saved || e.paralyzed <= 0) { e.paralyzed = 0; e.heldDC = null; this._note(`🖐️ ${e.name} ${sv.saved ? 'wrenches free of the hold' : 'the hold finally fades'}! [Will ${sv.total} vs ${hdc}]${sv.saved ? ' — but the struggle cost its turn.' : ''}`, null, { side: 'enemy' }); }
          else this._note(`🖐️ ${e.name} stays HELD — struggles in vain and loses its turn. [Will ${sv.total} vs ${hdc}]`, null, { side: 'enemy' });
        } else { e.paralyzed -= 1; this._note(`🖐️ ${e.name} is paralyzed — loses its turn.`, null, { side: 'enemy' }); }
        this._broadcast(); return this._nextTurn();
      }
      if (e.loseTurn) { e.loseTurn = false; this._note(`${e.glyph} ${e.name} is off-balance — loses its turn.`, null, { side: 'enemy' }); this._broadcast(); return this._nextTurn(); }
      if (e.sickened > 0) { e.sickened -= 1; this._note(`${e.glyph} ${e.name} retches in the cloud — loses its turn.`, null, { side: 'enemy' }); this._broadcast(); return this._nextTurn(); }
      if (e.slowed > 0) {   // Slow: sluggish — acts only every other turn.
        e.slowed -= 1; e._slowTick = (e._slowTick || 0) + 1;
        if (e._slowTick % 2 === 1) { this._note(`🐌 ${e.name} is slowed — too sluggish to act this turn.`, null, { side: 'enemy' }); this._broadcast(); return this._nextTurn(); }
      }
      this._stepTimer = setTimeout(() => { this._withSide('enemy', () => this._enemyAct(e)); this._nextTurn(); }, ENEMY_STEP_MS);
      this._broadcast();
      return;
    }
    // party member
    const m = this.member(t.id);
    if (!m || m.left || m.hp <= 0) return this._nextTurn();
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
    if (m.isBot) { this._stepTimer = setTimeout(() => { this._allyAct(m); this._nextTurn(); }, ENEMY_STEP_MS); this._broadcast(); }
    else { this._armAfkTimer(m); this._broadcast(); }   // human — wait for input
  }
  _nextTurn() {
    if (this._endIfResolved()) return;
    this.turnIdx += 1;
    // Initiative is rolled ONCE per combat (per room, in openDoor) — Pathfinder
    // keeps the same order each round; we just wrap back to the top.
    if (this.turnIdx >= this.turnOrder.length) { this.turnIdx = 0; this.round += 1; }
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
    // No human left in the run at all (dead or bailed) → AI allies cash out and end.
    if (!this._humansInRun()) { this._wrapUp(); return true; }
    return false;
  }
  // Pay remaining AI allies (standing OR dying — the downed get their cut too) an
  // even share of what's left, announce it, then end.
  _wrapUp() {
    if (this.status === 'over') return;
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
  _clearRoom() {
    clearTimeout(this._turnTimer); clearTimeout(this._stepTimer);
    this.status = 'exploring';
    const gold = this.enemies.reduce((s, e) => s + (e.gold || 0), 0);
    this.runGold += gold;
    this._note(`✨ Room cleared! +${gold} gp (pool ${this.runGold} gp).`);
    this._log('clear', { gold, runGold: this.runGold });
    this._maybeDropLoot();
    this._maybeDropPotion();     // can revive a downed ally before they bleed
    this._bleedDowned();         // the still-dying lose 1 HP this room (toward −10)
    if (!this._humansInRun()) { this._wrapUp(); return; }   // last human bled out → AI allies cash out
    this._broadcast();
  }
  _runOver() {
    clearTimeout(this._turnTimer); clearTimeout(this._stepTimer); clearTimeout(this._lootTimer);
    this.lootRoll = null;
    this.status = 'over';
    this._broadcast();
    if (this._onEmpty) try { this._onEmpty(); } catch (_) {}
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
      this._note(`🧪 A Potion of ${p.name} drops — ${m.nickname} ${revived ? 'is revived' : 'quaffs it'} (rolled ${p.count}d${p.die}+${p.bonus}): +${gained} HP (now ${m.hp}/${m.maxHp})${revived ? ' — back on their feet!' : ''}.`);
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
    // Bots decide immediately: roll only if it beats what they already wear here.
    for (const id of eligibleIds) {
      const m = this.member(id);
      if (!m || !m.isBot) continue;
      const cur = Number((m.gear || db.getGear(id))[slot]) || 0;
      this._lootDecide(id, tier > cur);   // upgrade → roll; equal/worse → pass
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
        this._relevel(m);   // any upgrade raises level → +10 max HP, +to-hit, +to-save
        this._note(`🛡️ ${m.nickname} equips the +${tier} ${db.GEAR_BY_KEY[slot]?.label || slot}. (Lv ${m.level})`);
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
  _relevel(m) {
    const nl = levelOf(m.gear);
    const nmax = maxHpFor(m.cls, nl);
    const gain = nmax - m.maxHp;
    m.level = nl; m.maxHp = nmax;
    if (gain > 0) m.hp += gain;   // leveling up heals the new HP; never drains current HP
  }
  _partySaveMod(m) { return (m.level || 1) + ((m.buffs && m.buffs.save) || 0); }   // saves scale with level (+ rage's +Will)
  // How much a hero's AC is lowered right now: sticky penalty (rage) + a
  // this-turn penalty (reckless / barbarian cleave drop their guard).
  _acPenalty(m) { return ((m.buffs && m.buffs.acPen) || 0) + (m.acPenRound === this.round ? (m.acPenAmt || 0) : 0); }
  _acBonus(m) {   // magus Shield (+4) + inquisitor Judgement: Protection
    return ((m.buffs && m.buffs.ac) || 0) + (m.judgment === 'protection' ? Math.max(1, Math.floor((m.level || 1) / 3)) : 0);
  }
  _atkStr(r) { return `[d20 ${r.roll} ${this._fmtBonus(r.toHit)} = ${r.total} vs AC ${r.ac}]`; }
  _swingVsAC(attacker, ac, target, extraToHit = 0) {
    const weapon = attacker.weapon;
    const sick = attacker.sickened > 0 ? SICKENED_PENALTY : 0;
    const lvl = attacker.level || 1;
    const cls = attacker.cls || 'fighter';
    // Point Blank Shot: rangers get +1 to hit & damage with ranged weapons.
    const pbs = (cls === 'ranger' && weapon && weapon.ranged) ? 1 : 0;
    // Smite Evil: an ACTIVATED smite (paladin's ability) vs an evil foe adds a
    // to-hit bump + bonus (un-multiplied) damage equal to level.
    const smite = !!(attacker.smiteActive && target && target.evil);
    // Sneak Attack: rogue-likes add precision dice vs a target that's denied its
    // defenses — flat-footed, prone, sickened, or paralyzed (PF1e). NOT crit-multiplied.
    const denied = !!(target && (target.flatFooted || target.prone || target.sickened > 0 || target.paralyzed > 0 || target.fascinated));
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
    // PF1e to-hit = class BAB (level-scaled) + ability mod + weapon bonus
    // (masterwork +1 / +N enhancement, carried on weapon.toHit) + smite + buffs,
    // minus a non-proficiency penalty if the class can't use this weapon.
    const bab = babFor(cls, lvl);
    const smiteHit = smite ? SMITE_TOHIT : 0;
    // NPCs are hand-assigned their signature weapons, so they're always
    // proficient; the −4 penalty only guides human weapon choices.
    const notProf = (attacker.isBot || weaponProficient(cls, weapon)) ? 0 : NON_PROFICIENT_PENALTY;
    const toHit = bab + ABILITY_MOD + (weapon.toHit || 0) + smiteHit + (buff.toHit || 0) + pbs + extraToHit + notProf - sick;
    const roll = dRoll(20), total = roll + toHit;
    if (roll === 1) return { hit: false, fumble: true, roll, toHit, total, ac, sound: SND.fumble };
    const hit = roll === 20 || total >= ac;
    if (!hit) return { hit: false, roll, toHit, total, ac, sound: weapon.isDagger ? SND.whiffDagger : pick(SND.whiffSword) };
    // Damage = weapon dice (NdX) + enhancement + ½ level + ability mod + buff dmg (+ Point Blank).
    const judgDmg = attacker.judgment === 'destruction' ? Math.max(1, Math.floor(lvl / 3)) : 0;   // inquisitor Judgement: Destruction
    const flatDmg = Math.floor(lvl / 2) + ABILITY_MOD + (buff.dmg || 0) + pbs + judgDmg;
    const rollDmg = () => dRollN(weapon.dmgCount, weapon.dmgDie) + weapon.dmgBonus + flatDmg;
    let dmg = rollDmg() - sick, crit = false;
    if (roll >= weapon.critRange) { const conf = dRoll(20) + bab + ABILITY_MOD + (weapon.toHit || 0) + smiteHit + (buff.toHit || 0) + pbs + extraToHit + notProf; if (conf === 20 || conf >= ac) { crit = true; for (let i = 1; i < weapon.critMult; i++) dmg += rollDmg(); } }
    // Precision (sneak), smite, and bane dice ride on top — NOT multiplied by a crit.
    let sneakDmg = 0;
    if (sneakDice) { sneakDmg = dRollN(sneakDice, 6); dmg += sneakDmg; }
    if (buff.bonusDice) dmg += dRollN(buff.bonusDice, 6);   // Bane
    if (smite) dmg += 2 * lvl;   // Smite Evil: +double level damage
    return { hit: true, crit, smite, sneakDice, sneakDmg, damage: Math.max(1, dmg), roll, toHit, total, ac, sound: pick(SND.flesh) };
  }
  _monsterSwing(e, targetAC) {
    const sick = e.sickened > 0 ? SICKENED_PENALTY : 0;
    // High ground: a flyer swooping on grounded heroes gets a to-hit edge.
    const toHit = e.toHit - sick + (e.flying ? HIGH_GROUND_HIT : 0);
    const roll = dRoll(20), total = roll + toHit;
    if (roll === 1) return { hit: false, roll, toHit, total, ac: targetAC, sound: SND.fumble };
    const hit = roll === 20 || total >= targetAC;
    if (!hit) return { hit: false, roll, toHit, total, ac: targetAC, sound: pick(SND.whiffSword) };
    let dmg = e.dmgBonus - sick;
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
      // Skeletal Champion: a bone-rattling shout — 1d8 + save-or-stunned.
      if (e.shout && e.shoutsLeft > 0 && dRoll(2) === 1) {
        const awake = this._targetableParty().filter(m => !(m.stunned > 0) && !(m.paralyzed > 0));
        if (awake.length) return this._enemyShout(e, pick(awake));
      }
      // Goblin Barbarian: roar a taunt (once) to pull the party's AI onto it.
      if (e.taunt && e.tauntsLeft > 0 && this.livingParty().some(m => m.isBot)) return this._enemyTaunt(e);
    }
    // Melee — the kobold rogue stabs twice (1d3 each); everyone else swings once.
    // A taunted foe hammers the barbarian; otherwise re-pick a living, TARGETABLE
    // (non-invisible), preferably-helpless target.
    for (let i = 0; i < Math.max(1, e.attacks || 1); i++) {
      const living = this._targetableParty();
      if (!living.length) break;
      if (forced && forced.hp > 0 && !forced.left) { this._enemyMelee(e, forced); continue; }
      const helpless = living.filter(m => m.paralyzed > 0);
      this._enemyMelee(e, pick(helpless.length ? helpless : living));
    }
  }
  // One enemy swing at a chosen target (handles the paralysis rider + signature sound).
  _enemyMelee(e, target) {
    // Dual-wielders (Farrus's twin axes) carry no shield — strip any shield AC.
    const tw = weaponOf(target.gear, target.weaponKey);
    const noShield = (tw && tw.noShield && (Number(target.gear && target.gear.shield) || 0) >= 1) ? (2 + Number(target.gear.shield)) : 0;
    const effAC = acOf(target.gear, target.cls).ac + this._acBonus(target) - noShield - (target.paralyzed > 0 ? 4 : 0) - this._acPenalty(target);   // Shield: +4 (barbarians cap at breastplate); helpless / rage / reckless / cleave: easier to hit
    const r = this._monsterSwing(e, effAC);
    if (e.atkSounds && e.atkSounds.length) r.sound = pick(e.atkSounds);   // monk's randomized "bruce" kiai (hit or miss)
    else if (r.hit && e.atkSound) r.sound = e.atkSound;                    // rogue's "riki" stab (hit only)
    if (r.hit) {
      let dmg = r.damage, sneakTag = '';
      // Enemy Sneak Attack (goblin/kobold rogues): +Xd6 vs a hero who's denied
      // their defenses — flat-footed (hasn't acted yet) or HELD by a shaman.
      if (e.sneakDice && (target.paralyzed > 0 || target.flatFooted)) {
        const sn = dRollN(e.sneakDice, 6); dmg += sn; sneakTag = ` 🗡️+${sn} sneak!`;
      }
      target.hp -= dmg;
      this._note(`${e.glyph} ${e.name} hits ${target.nickname} for ${dmg}.${sneakTag} ${this._atkStr(r)} (${Math.max(0, target.hp)}/${target.maxHp} HP)`, r.sound);
      if (target.hp <= -10) { this._memberDown(target); this._echoToTable(r.sound); return; }   // dead at −10
      if (target.hp <= 0)   { this._downMember(target); this._echoToTable(r.sound); return; }    // 0..−9 = down/dying
      if (e.paralyze) {
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
    if (!saved && target.hp > 0) {
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
  // A living foe this member is compelled (taunted) to attack, or null.
  _forcedFoe(m) {
    if (!m || !m.tauntedBy) return null;
    return this.enemies.find(x => x.uid === m.tauntedBy && x.hp > 0) || null;
  }
  _allyAct(m) {
    const foes = this.livingEnemies();
    if (!foes.length) return;
    // Taunted by a goblin barbarian → drop the clever play and just go hit it.
    if (m.tauntedBy && foes.some(e => e.uid === m.tauntedBy)) {
      const tgt = this._preferredFoe(m, foes);   // returns + consumes the taunter
      if (tgt) this._basicAttack(m, tgt.uid);
      this._hasteBonus(m);
      return;
    }
    // First see if a class ability is the smart play this turn (heal, buff,
    // blast, spell). If so, use it; otherwise fall back to a basic attack.
    const choice = this._botAbility(m);
    if (choice) {
      const ab = kitFor(m.cls).abilities[choice.slot];
      const r = this._useAbility(m, choice.slot, choice.payload);
      if (r && r.ok && ab) m._lastAbilityKey = ab.key;
      if (r && r.ok && !r.freeAction) { this._hasteBonus(m); return; }   // free action (judgement) → keep acting
    }
    // Basic attack — class-aware target pick (see _preferredFoe).
    const tgt = this._preferredFoe(m, foes);
    if (tgt) this._basicAttack(m, tgt.uid);
    this._hasteBonus(m);   // Haste: spend a pending extra attack after the action
  }
  // Which foe a bot should strike. ROGUES hunt the HELPLESS (flat-footed / prone
  // / sickened / paralyzed / ASLEEP) for Sneak Attack — they'll happily stab a
  // sleeper. Everyone else AVOIDS asleep/fascinated foes (a hit wakes them and
  // wastes the crowd-control), only hitting one if all living foes are out.
  _preferredFoe(m, foes) {
    if (!foes || !foes.length) return null;
    // Taunted → compelled to go straight for the taunter (cleared at turn's end).
    const forced = this._forcedFoe(m);
    if (forced) return forced;
    if (m.cls === 'rogue') {
      const helpless = foes.filter(e => e.flatFooted || e.prone || e.sickened > 0 || e.paralyzed > 0 || e.fascinated);
      return (helpless.length ? helpless : foes).slice().sort((a, b) => a.hp - b.hp)[0];   // weakest sneakable foe
    }
    const awake = foes.filter(e => !e.fascinated);
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
    const foes = this.livingEnemies();
    if (!foes.length) return null;
    // Rogue: if a foe is already HELPLESS (flat-footed at the open, prone, asleep,
    // held…) it's a free Sneak target — skip Feint and just stab it (basic attack).
    // Feint only when there's no opening to set one up.
    if (m.cls === 'rogue' && foes.some(e => e.flatFooted || e.prone || e.sickened > 0 || e.paralyzed > 0 || e.fascinated)) return null;
    const awake = foes.filter(e => !e.fascinated);
    const targets = awake.length ? awake : foes;          // don't wake sleepers
    const usable = (ab) => {
      if (!ab || lvl < (ab.minLevel || 1)) return false;
      if (ab.cost === 'pool') return (m.spellPool || 0) > 0;
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
    const revive = avail.find(a => a.effect === 'revive' && (a.raiseDead ? anyDead : anyDowned));
    if (revive) return { slot: slot(revive), payload: {} };
    // 0b) Inquisitor: declare a Judgement if none is up (free action, then attack).
    const judg = avail.find(a => a.effect === 'judgment');
    if (judg && !m.judgment) return { slot: slot(judg), payload: {} };
    // 1) Heal when an ally (or self) is meaningfully hurt — or CHANNEL to pull a
    //    downed ally back up (a party channel revives the dying).
    const heal = avail.find(a => a.effect === 'heal');
    const channelHeal = avail.find(a => a.effect === 'heal' && a.heal === 'party');
    if (channelHeal && anyDowned) return { slot: slot(channelHeal), payload: {} };
    if (heal && someoneHurt) return { slot: slot(heal), payload: {} };
    // 1b) Dispel Magic — cleanse a debuffed ally (paralysis / stun / sickness).
    const cleanse = avail.find(a => a.effect === 'cleanse');
    if (cleanse && allies.some(a => a.paralyzed > 0 || a.stunned > 0 || a.sickened > 0)) return { slot: slot(cleanse), payload: {} };
    // 2) Put up buffs once — Smite, then sticky self/party buffs (rage, shield,
    //    bane, divine favor, inspire). Sticky guard stops re-casting.
    const smite = avail.find(a => a.effect === 'smite' && !m.smiteActive);
    if (smite) return { slot: slot(smite), payload: {} };
    const buff = avail.find(a => a.effect === 'buff' && a.sticky && !(m.buffApplied && m.buffApplied[a.key]));
    if (buff) return { slot: slot(buff), payload: {} };
    // 2a) Taunt — a barbarian roars to pull a pack's fire onto themselves (once
    //     per room, only worth it against 2+ foes).
    const taunt = avail.find(a => a.effect === 'taunt');
    if (taunt && foes.length >= 2) return { slot: slot(taunt), payload: {} };
    // 2b) Haste — a powerful party buff (bards & wizards love it). Cast it once
    //     while there are foes to fight and the party isn't already hasted.
    const haste = avail.find(a => a.effect === 'haste');
    if (haste && !(m.hasted > 0)) return { slot: slot(haste), payload: {} };
    // 2c) Arcane controllers (wizard, sorcerer) play the battlefield: by default
    //     they pick the spell that AFFECTS THE MOST foes — a wide blast (Fireball,
    //     Lightning Bolt, Burning Hands) or a mass lockdown (Sleep, Grease). But
    //     when a lone outsized foe ("boss") looms, they spike it with their
    //     hardest single-target nuke (Disintegrate / Cone of Cold) or pin it with
    //     a save-or-suck debuff (Hold Person). NOTE: some 'aoe'-tagged spells only
    //     hit one target (maxTargets 1), so coverage = min(foes, maxTargets).
    if (m.cls === 'wizard' || m.cls === 'sorcerer') {
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
      for (const a of avail) if (['rapidshot', 'bullseye', 'cleave', 'trip', 'reckless', 'feint'].includes(a.effect)) {
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
  _memberDown(m) {   // −10 or worse, or a total-party wipe: actually dead, out of the run
    if (m.dead) return;
    m.dead = true; m.downed = false;
    this._note(`☠️ ${m.nickname} drops past −10 — slain in the dungeon, out of the run.`, '/audio/hero_death.mp3');
    this._echoToTable('/audio/hero_death.mp3');
    this._log('death', { who: m.playerId, hp: m.hp, depthReached: this.depth });
    this._emitMemberExit(m, { reason: 'dead', goldBanked: 0 });
  }
  // Total party incapacitation — everyone still in the run is down/dying, so they
  // all bleed out and the run ends.
  _wipe() {
    if (this.status === 'over') return;
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
    m.invisible = false;   // attacking (even a cantrip ray) breaks Invisibility
    return this._basicAttack(m, payload.targetUid);
  }
  // The basic attack for any combatant (human input, bot turn, or AFK auto-swing)
  // — a caster's cantrip ray, or a weapon swing. A barbarian's swing chain-cleaves
  // (drops a foe → carve into a random next one). Chosen foe is first; chains random.
  _basicAttack(m, targetUid) {
    const forced = this._forcedFoe(m);   // taunted → attack is dragged onto the taunter
    if (forced) targetUid = forced.uid;
    const at = kitFor(m.cls).atwill;
    if (at && at.effect === 'bolt') return this._abBolt(m, at, targetUid);
    if (m.cls === 'barbarian') {
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
    const lvl = m.level || 1;
    if (ab.minLevel && lvl < ab.minLevel) return { ok: false, error: `${ab.name} needs level ${ab.minLevel}` };
    if (ab.cost === 'pool' && (m.spellPool || 0) <= 0) return { ok: false, error: 'out of spell casts this room' };
    if (ab.cost === 'room' && ((m.abilityUses && m.abilityUses[ab.key]) || 0) <= 0) return { ok: false, error: `${ab.name} is spent for this room` };
    if (ab.cost === 'run'  && ((m.runAbilityUses && m.runAbilityUses[ab.key]) || 0) <= 0) return { ok: false, error: `${ab.name} is already cast for this dungeon` };
    m.flatFooted = false;   // acting ends flat-footed
    const D = {
      trip:        () => this._abTrip(m, payload),
      cleave:      () => this._abCleave(m, ab, payload),
      feint:       () => this._abFeint(m, payload),
      reckless:    () => this._abReckless(m, payload),
      buff:        () => this._abBuff(m, ab),
      taunt:       () => this._abTaunt(m, ab),
      smite:       () => this._abSmite(m, ab),
      heal:        () => this._abHeal(m, ab),
      revive:      () => this._abRevive(m, ab),
      haste:       () => this._abHaste(m, ab),
      invisible:   () => this._abInvisible(m, ab),
      judgment:    () => this._abJudgment(m, ab),
      cleanse:     () => this._abCleanse(m, ab),
      aoe:         () => this._abAoe(m, ab, payload),
      disintegrate: () => this._abDisintegrate(m, ab, payload),
      bolt:        () => this._abBolt(m, ab, payload.targetUid),
      missile:     () => this._abMissile(m, ab, payload),
      touch:       () => this._abTouch(m, ab, payload),
      rays:        () => this._abRays(m, ab, payload),
      spellstrike: () => this._abSpellstrike(m, ab, payload),
      save_debuff: () => this._abSaveDebuff(m, ab, payload),
      grease:      () => this._abGrease(m, ab, payload),
      fascinate:   () => this._abFascinate(m, ab, payload),
      sleep:       () => this._abSleep(m, ab, payload),
      slow:        () => this._abSlow(m, ab, payload),
      rapidshot:   () => this._abRapidShot(m, ab, payload),
      bullseye:    () => this._abBullseye(m, ab, payload),
    }[ab.effect];
    if (!D) return { ok: false, error: 'unknown ability' };
    D();
    if (ab.cost === 'pool') m.spellPool = Math.max(0, (m.spellPool || 0) - 1);
    else if (ab.cost === 'room') m.abilityUses[ab.key] = Math.max(0, ((m.abilityUses && m.abilityUses[ab.key]) || 0) - 1);
    else if (ab.cost === 'run') m.runAbilityUses[ab.key] = Math.max(0, ((m.runAbilityUses && m.runAbilityUses[ab.key]) || 0) - 1);
    if (ab.target === 'enemy' || ab.target === 'aoe') m.invisible = false;   // attacking breaks Invisibility
    if (ab.effect === 'judgment' || ab.freeAction) return { ok: true, freeAction: true };   // judgement switch / barbarian Rage cost no action
    return { ok: true };
  }
  // Per-room reset: refill the shared spell pool (full casters) + own-count
  // abilities, and clear sticky room buffs. Called each room and on join.
  _resetAbilities(m) {
    const kit = kitFor(m.cls);
    m.spellPool = isPoolClass(m.cls) ? spellSlots(m.level || 1) : 0;
    m.abilityUses = {};
    for (const ab of kit.abilities) if (ab.cost === 'room') m.abilityUses[ab.key] = roomUses(ab, m.level || 1);
    m.buffs = null;          // rage / bane / divine favor / inspire clear
    m.buffApplied = {};      // which sticky buffs are already active (no stacking)
    m.smiteActive = false;
    m.hasted = 0; m._justHasted = false; m.stunned = 0;   // transient round effects clear each room
    m.paralyzed = 0; m.heldDC = null; m.slowed = 0; m._slowTick = 0;   // hold / slow wear off between rooms
    m.tauntedBy = null;   // any pending goblin-taunt compulsion clears
    m.invisible = false; m.judgment = null;   // invisibility ends; judgement re-declared per encounter
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
    return {
      atwill: { key: kit.atwill.key, name: kit.atwill.name, icon: kit.atwill.icon, img: kit.atwill.img || null },
      caster: isCaster(m.cls),
      spellNote: kit.note || null,
      spellPool: isPoolClass(m.cls) ? { remaining: m.spellPool || 0, max: spellSlots(lvl) } : null,
      abilities: kit.abilities.map(ab => ({
        key: ab.key, name: ab.name, icon: ab.icon, img: ab.img || null, cost: ab.cost, target: ab.target, maxTargets: ab.maxTargets || 1,
        minLevel: ab.minLevel || 1, slvl: ab.slvl || null, available: lvl >= (ab.minLevel || 1), desc: ab.desc || '',
        remaining: ab.cost === 'pool' ? (m.spellPool || 0) : ab.cost === 'room' ? ((m.abilityUses && m.abilityUses[ab.key]) || 0) : ab.cost === 'run' ? ((m.runAbilityUses && m.runAbilityUses[ab.key]) || 0) : null,
        max: ab.cost === 'pool' ? spellSlots(lvl) : ab.cost === 'room' ? roomUses(ab, lvl) : ab.cost === 'run' ? (typeof ab.uses === 'function' ? ab.uses(lvl) : (ab.uses || 1)) : null,
      })),
    };
  }
  // Spell save DC + caster level for this member (level = 1 + gear).
  _spellDC(m) { return 10 + (m.level || 1) + ABILITY_MOD; }
  _spellDice(ab, m) { return diceCount(ab, m.level || 1); }
  _enemyTargets(payload, max) {
    let chosen = ((payload && payload.targetUids) || []).map(u => this.enemies.find(e => e.uid === u && e.hp > 0)).filter(Boolean);
    if (!chosen.length) chosen = this.livingEnemies();
    return max ? chosen.slice(0, max) : chosen;
  }
  _oneEnemy(payload) {
    return this.enemies.find(x => x.uid === (payload && payload.targetUid) && x.hp > 0) || this.livingEnemies()[0] || null;
  }
  _saveVs(bonus, dc) { const r = dRoll(20); return { roll: r, total: r + bonus, saved: r === 20 ? true : r === 1 ? false : (r + bonus) >= dc }; }
  _afterEnemyHit(e) { if (e.hp <= 0) return ' ☠️'; return ` (${Math.max(0, e.hp)}/${e.maxHp})`; }
  // Effective melee AC of an enemy: sickened = +2 to be hit, prone = +4 to be hit.
  // A flying creature holds the HIGH GROUND over the grounded party: +2 AC (hard
  // to reach a flyer from the floor). All heroes are grounded, so it always applies.
  _enemyAC(e) { return e.ac - (e.sickened > 0 ? 2 : 0) - (e.prone ? 4 : 0) - (e.slowed > 0 ? 1 : 0) + (e.flying ? HIGH_GROUND_AC : 0); }
  // Energy-resistance multiplier for a damage type (see RESIST_BY_KEY): 0 immune,
  // 0.5 resistant, 1.5 vulnerable, 1 (default) unchanged. Physical/untyped (no
  // dtype) is never modified.
  _resistMult(e, dtype) {
    if (!dtype || !e.resist || e.resist[dtype] == null) return 1;
    return e.resist[dtype];
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
    e.hp -= dealt; if (e.fascinated) e.fascinated = false;
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
    for (const t of hit) { this._dmgToMember(t, d); parts.push(`${t.nickname} −${d}`); }
    e._exploded = true; e.hp = 0;   // it consumes itself
    this._note(`💥 ${e.name} hurls itself among the heroes and DETONATES (${lvl}d6 fire = ${d})${parts.length ? ' — ' + parts.join(', ') : ' — but catches no one'}! It is destroyed.`, ex.sound, { side: 'enemy' });
    this._echoToTable(ex.sound);
  }
  // Enemy save bonus. Monsters carry Fort + Reflex; Will is approximated.
  _enemySave(e, which) {
    if (which === 'fort') return e.fort || 0;
    if (which === 'reflex') return e.reflex || 0;
    return Math.floor(((e.fort || 0) + (e.reflex || 0)) / 2);   // will (approx)
  }
  // A bare attack roll (to-hit only, no damage) using the member's weapon.
  _attackRoll(m, e) {
    const w = m.weapon || weaponOf(m.gear, m.weaponKey);
    const lvl = m.level || 1, cls = m.cls || 'fighter';
    const notProf = (m.isBot || weaponProficient(cls, w)) ? 0 : NON_PROFICIENT_PENALTY;
    const toHit = babFor(cls, lvl) + ABILITY_MOD + (w.toHit || 0) + ((m.buffs && m.buffs.toHit) || 0) + notProf - (m.sickened > 0 ? SICKENED_PENALTY : 0);
    const roll = dRoll(20), total = roll + toHit;
    return { hit: roll === 20 || (roll !== 1 && total >= this._enemyAC(e)), roll, total, toHit, weapon: w };
  }

  // ── Effects ──────────────────────────────────────────────────────────────
  // Ranged touch cantrip / single small bolt (Ray of Frost).
  _abBolt(m, ab, targetUid) {
    m.flatFooted = false;
    const e = this.enemies.find(x => x.uid === targetUid && x.hp > 0) || this.livingEnemies()[0];
    if (!e) return;
    const touchAC = Math.max(10, e.ac - 5);   // touch attacks ignore most armor
    const toHit = babFor(m.cls || 'fighter', m.level || 1) + ABILITY_MOD;
    const roll = dRoll(20), total = roll + toHit;
    const sound = ab.sound || pick(SND.lightning);
    if (roll !== 20 && (roll === 1 || total < touchAC)) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} misses ${e.name}. [d20 ${roll} ${this._fmtBonus(toHit)} = ${total} vs touch ${touchAC}]`, sound); this._echoToTable(sound); return; }
    const raw = Math.max(1, dRollN(this._spellDice(ab, m), ab.die || 3) + (ab.flat || 0));
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
    if (ab.randFoes || ab.randBase) {
      // Fireball-style: a RANDOM 1dN of the living enemies. Cone of Cold uses
      // randBase+randDie → 2+1d3 foes.
      const living = this.livingEnemies().slice();
      for (let i = living.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [living[i], living[j]] = [living[j], living[i]]; }
      const n = ab.randBase ? ((ab.randBase || 0) + dRoll(ab.randDie || 1)) : dRoll(ab.randFoes);
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
    const full = dRollN(dice, ab.die || 6);
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
    const touchAC = Math.max(10, this._enemyAC(e) - 5);
    const toHit = babFor(m.cls || 'fighter', m.level || 1) + ABILITY_MOD;
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
    const e = this._oneEnemy(payload); if (!e) return;
    // PF1e Scorching Ray: 1 ray, +1 per 4 caster levels past 3rd → 2 rays at CL7,
    // 3 at CL11. Each ray rolls to hit (4d6 fire). When it SPLITS (2+), use the
    // dramatic fire-combo sound instead of the single-ray report.
    const rays = Math.max(1, Math.min(3, 1 + Math.floor(((m.level || 1) - 3) / 4)));
    const touchAC = Math.max(10, e.ac - 5), toHit = babFor(m.cls || 'fighter', m.level || 1) + ABILITY_MOD;
    let dmg = 0, hits = 0;
    for (let i = 0; i < rays; i++) { const roll = dRoll(20); if (roll === 20 || (roll !== 1 && roll + toHit >= touchAC)) { dmg += dRollN(ab.dice || 4, ab.die || 6); hits++; } }
    const sound = (rays >= 2 && ab.splitSound) ? ab.splitSound : (ab.sound || pick(SND.lightning));
    if (!hits) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} (${rays} ray${rays > 1 ? 's' : ''}) all miss ${e.name}.`, sound); this._echoToTable(sound); return; }
    const dealt = this._dmgE(e, dmg, ab.dtype);
    this._note(`${ab.icon} ${m.nickname}'s ${ab.name} — ${hits}/${rays} rays burn ${e.name} for ${dealt} fire${this._resistTag(e, ab.dtype)}.${this._afterEnemyHit(e)}`, sound);
    if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  }
  // Spellstrike: a weapon hit carrying bonus elemental dice (+ optional debuff).
  _abSpellstrike(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    const sound = MAGUS_SPELLSTRIKE_SFX[m.nickname] || ab.sound || r.sound;
    if (!r.hit) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} misses ${e.name}. ${this._atkStr(r)}`, sound); this._echoToTable(sound); return; }
    const bonus = dRollN(this._spellDice(ab, m), ab.die || 6);
    const total = r.damage + bonus;
    this._dmgE(e, total);
    let extra = '';
    if (ab.debuff === 'sickened' && e.hp > 0) { e.sickened = SICKENED_ROUNDS; extra = ' — staggered!'; }
    this._note(`${ab.icon} ${m.nickname} ${ab.name}s ${e.name} for ${r.damage}+${bonus} ${ab.dtype || ''} = ${total}.${extra}${this._afterEnemyHit(e)}`, sound);
    if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  }
  // Haste — the whole party blurs with speed. Each ally gets ONE extra attack on
  // their next turn (see _hasteBonus), consumed when they act. Lasts ~1 round.
  _abHaste(m, ab) {
    const sound = ab.sounds ? pick(ab.sounds) : ab.sound;
    // Lasts 1 turn per 5 caster levels (rounded down, min 1). Each hasted turn
    // grants one extra attack (see _hasteBonus, which decrements the counter).
    const turns = Math.max(1, Math.floor((m.level || 1) / 5));
    for (const a of this.livingParty()) a.hasted = turns;
    // The caster spent THIS turn casting — their own extra attack waits until
    // their next turn (so the cast plays the Haste sound, not an immediate swing).
    m._justHasted = true;
    this._note(`${ab.icon} ${m.nickname} casts Haste — the party blurs with speed for ${turns} turn${turns > 1 ? 's' : ''}! (an extra attack each turn)`, sound);
    this._echoToTable(sound);
  }
  // Dispel Magic — strip the worst debuff off an afflicted ally (or self).
  _abCleanse(m, ab) {
    const sound = ab.sound;
    const allies = this.livingParty();
    const target = allies.find(a => (a.paralyzed > 0 || a.stunned > 0 || a.sickened > 0)) || m;
    const cleared = [];
    if (target.paralyzed > 0) { target.paralyzed = 0; target.heldDC = null; cleared.push('paralysis'); }
    if (target.stunned > 0)   { target.stunned = 0;   cleared.push('stun'); }
    if (target.sickened > 0)  { target.sickened = 0;  cleared.push('sickness'); }
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${target.nickname} — ${cleared.length ? 'clears ' + cleared.join(', ') + '!' : 'nothing to dispel'}.`, sound);
    this._echoToTable(sound);
  }
  // Invisibility — enemies can't target you until you attack (see _targetableParty
  // and the m.invisible=false clears in _playerAttack / offensive _useAbility).
  _abInvisible(m, ab) {
    m.invisible = true;
    this._note(`${ab.icon} ${m.nickname} fades from view — unseen until they strike!`, ab.sound);
    this._echoToTable(ab.sound);
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
      const dead = this.party.find(a => a.dead);
      if (dead) {
        dead.dead = false; dead.downed = false; dead.left = false;
        dead.hp = ab.full ? dead.maxHp : Math.max(1, Math.floor(dead.maxHp / 2));
        dead.flatFooted = true; dead.paralyzed = 0; dead.stunned = 0;
        this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${dead.nickname} is restored to the run at ${dead.hp}/${dead.maxHp} HP!`, sound);
        if (this.status === 'combat' && !this.turnOrder.some(t => t.kind === 'party' && t.id === dead.playerId)) {
          this.turnOrder.push({ kind: 'party', id: dead.playerId, init: dRoll(20) });
        }
        this._echoToTable(sound); this._broadcast(); return;
      }
      // No corpse to raise → fall through to a big heal.
    } else {
      // Breath of Life — snatch a DYING (downed) ally back first.
      const downed = this.party.find(a => !a.dead && !a.left && a.downed);
      if (downed) {
        downed.downed = false; downed.hp = Math.min(downed.maxHp, healBig());
        this._note(`${ab.icon} ${m.nickname} breathes life into ${downed.nickname} — back up at ${downed.hp}/${downed.maxHp} HP!`, sound);
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
    const touchAC = Math.max(10, this._enemyAC(e) - 5);
    const toHit = babFor(m.cls || 'fighter', m.level || 1) + ABILITY_MOD + ((m.buffs && m.buffs.toHit) || 0);
    const roll = dRoll(20), total = roll + toHit;
    const sound = ab.sound || pick(SND.lightning);
    if (roll !== 20 && (roll === 1 || total < touchAC)) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} misses ${e.name}. [touch d20 ${roll} ${this._fmtBonus(toHit)} = ${total} vs ${touchAC}]`, sound); this._echoToTable(sound); return; }
    const raw = Math.max(1, dRollN(this._spellDice(ab, m), ab.die || 6));
    const dmg = this._dmgE(e, raw, ab.dtype);
    this._note(`${ab.icon} ${m.nickname}'s ${ab.name} jolts ${e.name} for ${dmg} ${ab.dtype || ''}${this._resistTag(e, ab.dtype)}.${this._afterEnemyHit(e)}`, sound);
    if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  }
  // Grease: up to maxTargets foes Reflex-save or slip prone (and lose the turn).
  _abGrease(m, ab, payload) {
    const dc = this._spellDC(m);
    // Gust of Wind hits a RANDOM 1d3 foes (randFoes); Grease targets the picked
    // ones. Save type is configurable (Grease=Reflex, Gust=Fort).
    let chosen;
    if (ab.randFoes) {
      const living = this.livingEnemies().slice();
      for (let i = living.length - 1; i > 0; i--) { const j = dRoll(i + 1) - 1; [living[i], living[j]] = [living[j], living[i]]; }
      chosen = living.slice(0, dRoll(ab.randFoes));
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
    const chosen = this._enemyTargets(payload, ab.maxTargets || 3).slice().sort((a, b) => a.hp - b.hp);
    const sound = ab.sound || pick(SND.flesh), parts = [];
    for (const e of chosen) {
      const sv = this._saveVs(this._enemySave(e, 'will'), dc);
      if (!sv.saved) { e.fascinated = true; e.flatFooted = true; }   // asleep: skip turns (woken by a hit) + helpless
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
    const living = this.livingEnemies().slice();
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
  _abFascinate(m, ab, payload) {
    const chosen = this._enemyTargets(payload, ab.maxTargets || 3);
    for (const e of chosen) e.fascinated = true;
    const sound = ab.sound || pick(SND.flesh);
    this._note(`${ab.icon} ${m.nickname} performs ${ab.name} — ${chosen.map(e => e.name).join(', ')} stand fascinated (until struck).`, sound);
    this._echoToTable(sound);
  }
  // Heal: 'party' (channel) heals all living allies; 'channel' (lay on hands)
  // heals the most-wounded ally (or self).
  _abHeal(m, ab) {
    const lvl = m.level || 1;
    const sound = ab.sound || pick(SND.flesh);
    // Channel Positive — PF1e positive-energy burst: ½ caster level d6 (1d6 at
    // L1, +1d6 every 2 levels → 6d6 at L11), to the whole party.
    const channelAmt = () => Math.max(1, dRollN(Math.max(1, Math.ceil(lvl / 2)), 6));
    // Cure X Wounds — healDice d8 + caster level (capped: +5 light, +10 moderate).
    const cureAmt = () => Math.max(1, dRollN(ab.healDice || 1, 8) + Math.min(ab.healCap || lvl, lvl));
    if (ab.heal === 'party') {
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
      const allies = this.livingParty();
      const target = allies.slice().sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0] || m;
      const h = cureAmt(); target.hp = Math.min(target.maxHp, target.hp + h);
      this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${target.nickname} heals ${h} (${target.hp}/${target.maxHp}).`, sound);
    }
    this._echoToTable(sound);
  }
  // Sticky room buff (Rage / Judgment / Bane / Inspire). `party` spreads it.
  _abBuff(m, ab) {
    const apply = (who) => {
      who.buffApplied = who.buffApplied || {};
      if (ab.sticky && who.buffApplied[ab.key]) return;   // already active this room — don't stack
      if (ab.sticky) who.buffApplied[ab.key] = true;
      if (ab.persist) {   // Bless / Inspire: a run-long buff that survives room resets (never fades)
        who.runBuffs = who.runBuffs || { toHit: 0, dmg: 0 };
        who.runBuffs.toHit += (ab.buff && ab.buff.toHit) || 0;
        who.runBuffs.dmg   += (ab.buff && ab.buff.dmg) || 0;
        who.runBuffApplied = who.runBuffApplied || {};
        who.runBuffApplied[ab.key] = true;
        return;
      }
      who.buffs = who.buffs || { toHit: 0, dmg: 0, bonusDice: 0, acPen: 0, save: 0, ac: 0 };
      who.buffs.toHit += (ab.buff && ab.buff.toHit) || 0;
      who.buffs.dmg += (ab.buff && ab.buff.dmg) || 0;
      who.buffs.bonusDice += (ab.buff && ab.buff.bonusDice) || 0;
      who.buffs.acPen += (ab.buff && ab.buff.acPen) || 0;   // rage: −2 AC (sticky)
      who.buffs.ac += (ab.buff && ab.buff.ac) || 0;         // magus Shield: +4 AC (sticky)
      who.buffs.save += (ab.buff && ab.buff.save) || 0;     // rage: +1 saves
    };
    const sound = ab.sound || pick(SND.flesh);
    if (ab.party) { for (const a of this.livingParty()) apply(a); this._note(`${ab.icon} ${m.nickname} strikes up ${ab.name} — the party is emboldened!`, sound); }
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
  // Trip: an ATTACK ROLL (no damage). On a hit the foe is knocked prone, LOSES
  // its turn, and you get an immediate free attack (prone = +4 for all to hit).
  _abTrip(m, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    if (e.noTrip) { this._note(`${m.nickname} can't trip ${e.name} (no legs).`); return this._echoToTable(); }
    if (e.flying)  { this._note(`${m.nickname} can't trip ${e.name} — it's airborne, immune to prone.`); return this._echoToTable(); }
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const a = this._attackRoll(m, e);
    if (!a.hit) { this._note(`🦵 ${m.nickname} tries to trip ${e.name} but misses. [d20 ${a.roll} ${this._fmtBonus(a.toHit)} = ${a.total} vs AC ${this._enemyAC(e)}]`, a.weapon.isDagger ? SND.whiffDagger : pick(SND.whiffSword)); return this._echoToTable(); }
    e.prone = true; e.loseTurn = true;
    this._note(`🦵 ${m.nickname} TRIPS ${e.name} prone — it loses its turn! Free attack!`);
    const r = this._swingVsAC(m, this._enemyAC(e), e);   // prone (−4 AC) folded into _enemyAC
    if (r.hit) { this._dmgE(e, r.damage); this._note(`⚔️ free hit on ${e.name} for ${r.damage}.${this._afterEnemyHit(e)}`, r.sound); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    else this._note(`⚔️ the free hit misses. ${this._atkStr(r)}`, r.sound);
    this._echoToTable(r.sound);
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
  // Play a sequence of swing sounds to the dungeon (clear) and the table (muffled
  // echo), STAGGERED, so a chain of cleaves is heard as distinct hits — not one
  // blurred thwack. (The dungeon:state broadcast only plays the single newest log
  // sound, so chain swings carry no log sound and ride this instead.)
  _emitChainSfx(sounds) {
    let played = 0;
    for (const snd of sounds) {
      if (!snd) continue;
      const delay = played * CHAIN_SFX_GAP_MS; played++;
      setTimeout(() => {
        try {
          if (!this.io) return;
          this.io.to(this.roomName()).emit('dungeon:sfx', { sound: snd });
          this.io.to(`table:${this.tableId}`).emit('dungeon:echo', { sound: snd });
        } catch (_) {}
      }, delay);
    }
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

  // One bow shot at a to-hit modifier (rangers). Uses the bow's report sound.
  _bowShot(m, ab, payload, hitMod, label) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e, hitMod);
    if (ab.sound) r.sound = ab.sound; else if (m.weapon.atkSound) r.sound = m.weapon.atkSound;
    if (r.hit) { this._dmgE(e, r.damage); this._note(`${ab.icon} ${m.nickname}${label} ${r.crit ? 'CRITS' : 'hits'} ${e.name} for ${r.damage}. ${this._atkStr(r)}${this._afterEnemyHit(e)}`, r.sound); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    else this._note(`${ab.icon} ${m.nickname}${label} misses ${e.name}. ${this._atkStr(r)}`, r.sound);
    this._echoToTable(r.sound);
  }
  // Rapid Shot: two arrows this turn, each at −2.
  _abRapidShot(m, ab, payload) {
    this._bowShot(m, ab, payload, -2, ' (rapid 1)');
    this._bowShot(m, ab, payload, -2, ' (rapid 2)');
  }
  // Bullseye Shot: one carefully-aimed arrow at +4.
  _abBullseye(m, ab, payload) {
    this._bowShot(m, ab, payload, 4, ' takes aim and');
  }

  // At-will attack. Rogues with daggers strike TWICE (two-weapon style); a rogue
  // with any other weapon strikes once. Sneak Attack applies via _swingVsAC.
  _playerAttack(m, targetUid, quiet = false) {
    m.flatFooted = false;   // acting ends flat-footed
    m.invisible = false;    // attacking breaks Invisibility
    const e = this.enemies.find(x => x.uid === targetUid && x.hp > 0) || this.livingEnemies()[0];
    if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    // Two swings for a dual-wield weapon (Farrus's twin axes) or a rogue's dagger.
    const swings = m.weapon.dual ? 2 : ((m.cls === 'rogue' && m.weaponKey === 'dagger') ? 2 : 1);
    // Sound: signature atkSound > a blunt "bap" for B-type weapons (quarterstaff,
    // warhammer…) > the swing's own hit/whiff. A dual weapon plays its report ONCE.
    let baseSound = m.weapon.atkSound || (m.weapon.dtype === 'B' ? '/audio/weapon_blunt.mp3' : null);
    if (m.smiteActive && m.weaponKey === 'warhammer') baseSound = '/audio/weapon_warhammer_smite.mp3';   // holy hammer-ring on a smite
    for (let i = 0; i < swings; i++) {
      const tgt = (e.hp > 0) ? e : this.livingEnemies()[0];
      if (!tgt) break;
      const r = this._swingVsAC(m, this._enemyAC(tgt), tgt);
      if (m.weapon.dual) r.sound = (i === 0) ? baseSound : null;   // one report for the whole flurry
      else if (baseSound) r.sound = baseSound;                     // signature / blunt report (e.g. Rovadra)
      if (quiet) r.sound = null;   // secondary swing (Haste bonus) — stay silent so the main action's sound is heard
      // Rogue Sneak Attack with a light blade (dagger/kukri/shortsword) → Riki.
      if (r.sneakDice && m.cls === 'rogue' && ['dagger', 'kukri', 'shortsword'].includes(m.weaponKey)) r.sound = '/audio/sneak_riki.mp3';
      const tag = (r.smite ? ' ⚔️Smite!' : '') + (r.sneakDice ? ` 🗡️Sneak +${r.sneakDmg}(${r.sneakDice}d6)` : '');
      const lead = swings > 1 ? `${m.nickname} (hit ${i + 1})` : m.nickname;
      if (r.fumble) this._note(`${lead} fumbles the attack! ${this._atkStr(r)}`, r.sound);
      else if (r.hit) { this._dmgE(tgt, r.damage); this._note(`${lead} ${r.crit ? 'CRITS' : 'hits'} ${tgt.name} for ${r.damage}.${tag} ${this._atkStr(r)}${tgt.hp <= 0 ? ' ☠️ Slain!' : ` (${Math.max(0, tgt.hp)}/${tgt.maxHp})`}`, r.sound); }
      else this._note(`${lead} misses ${tgt.name}. ${this._atkStr(r)}`, r.sound);
      if (r.hit && tgt.hp <= 0) this._tryBanter(m, 'down', { enemy: tgt.name });
      this._echoToTable(r.sound);
    }
  }
  // ── Loot (per owner) ──────────────────────────────────────────────────────
  equipLoot(playerId, idx) {
    const loot = this.pendingLoot[idx];
    if (!loot || loot.owner !== playerId) return { ok: false, error: 'not your loot' };
    const m = this.member(playerId); if (!m) return { ok: false, error: 'gone' };
    const gear = db.getGear(playerId);
    if ((Number(gear[loot.slot]) || 0) >= loot.tier) { this.pendingLoot.splice(idx, 1); return { ok: false, error: 'already better' }; }
    gear[loot.slot] = loot.tier;
    db.setGear(playerId, gear);
    m.gear = gear;
    this._relevel(m);   // any upgrade raises level → +10 max HP, +to-hit, +to-save
    this.pendingLoot.splice(idx, 1);
    this._note(`🛡️ ${m.nickname} equipped the +${loot.tier} ${db.GEAR_BY_KEY[loot.slot]?.label || loot.slot}. (Lv ${m.level})`);
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
    const share = Math.floor(this.runGold / denom);
    this.runGold -= share;
    const p = db.getPlayer(playerId);
    if (p) db.setChips(playerId, p.chips + share);
    m.left = true;   // turn loop skips left members; entry stays for index integrity
    const how = m.downed ? 'is dragged out of the dungeon' : fled ? 'flees the fight and climbs out' : 'climbed out';
    this._note(`${m.downed ? '🩸' : fled ? '🏃' : '🪜'} ${m.nickname} ${how} with ${share} gp.`);
    this._log('bail', { who: playerId, share, poolLeft: this.runGold, fled, downed: !!m.downed });
    this._emitMemberExit(m, { reason: 'bailed', goldBanked: share, fled });
    // Last conscious member out → drag any remaining dying allies out with their
    // share (voluntary retreat). Otherwise, if only AI remain, cash them out.
    if (!this._anyUp()) { this._groupExtract(); return { ok: true, goldBanked: share }; }
    if (!this._humansInRun()) { this._wrapUp(); return { ok: true, goldBanked: share }; }
    // Only nudge the turn cycle if the bailer was the one we were waiting on.
    if (this.status === 'combat' && wasActor) { clearTimeout(this._turnTimer); this._nextTurn(); }
    else this._broadcast();
    return { ok: true, goldBanked: share };
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
