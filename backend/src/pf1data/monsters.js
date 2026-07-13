/**
 * pf1data/monsters.js — the dungeon BESTIARY (extracted from game/Dungeon.js,
 * Phase 0 of the refactor — pure data + pure derivation, NO behavior change).
 *
 * Owns every monster stat block (MON) plus the data that is merged onto it at
 * load: body plans (size/legs), encounter gangs, token art, creature type,
 * energy resist/vuln, alignment, CR-as-number, and the spawnable list. crToNum
 * is a pure CR-string parser used here and re-exported for Dungeon.js. SIZE_RANK
 * /SIZE_NAME (size math for the trip rules) live here too and are imported back.
 *
 * Dungeon.js keeps the spawn HELPERS that need its RNG (pickByCR/targetCR).
 */

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
// MONK strike pool (Tobias 2026-07-04): every monk — hero OR villain — mixes
// the bruce kiai, the punisher yell, and the bamboo smacks, picked per swing.
const MONK_SFX = [...BRUCE_SFX, '/audio/punisher_yell_punch.mp3', '/audio/bamboo_bap_tuesdayt.mp3', '/audio/bamboo_whoosh_thump.mp3'];
// Monks are now a roster of NAMED individuals (see the MONKS block below), each
// its own MON entry with fixed art — no more random-face token pool.

// ── Monster bestiary (placeholder art = emoji glyphs) ───────────────────────
// PF1e stat blocks (CR in comment). NO depth scaling — difficulty comes from
// which creatures a depth's BAND can spawn and from designated bosses, not from
// buffing mooks. Our combat model uses one representative attack:
//   damage = dmgCount × d(dmgDie) + dmgBonus   (dmgCount defaults to 1)
//   attacks = number of separate swings per turn (default 1)
const MON = {
  dire_rat:          { name: 'Dire Rat',          glyph: '🐀', cr: '1/3', hp: 5,   ac: 14, toHit: 1,  dmgDie: 4,  dmgBonus: 0, fort: 3,  reflex: 3,  gold: [3, 10], atkSound: '/audio/enemy_badger.mp3' },
  // (badger removed 2026-07-04 — no real token art in the library; dire_rat covers the CR 1/2 beast-chaff slot)
  giant_centipede:   { name: 'Giant Centipede',   glyph: '🐛', cr: '1/2', hp: 5,   ac: 14, toHit: 2,  dmgDie: 6,  dmgBonus: 0, fort: 1,  reflex: 3,  gold: [3, 10] },
  goblin:            { name: 'Goblin',            glyph: '👺', cr: '1/3', hp: 6,   ac: 16, toHit: 2,  dmgDie: 4,  dmgBonus: 0, fort: 3,  reflex: 2,  gold: [6, 16] },
  kobold:            { name: 'Kobold',            glyph: '🦎', cr: '1/4', hp: 5,   ac: 15, toHit: 1,  dmgDie: 6,  dmgBonus: 0, fort: 2,  reflex: 1,  gold: [6, 14] },
  kobold_spearman:   { name: 'Kobold Spearman',   glyph: '🦎', cr: '1/3', hp: 6,   ac: 15, toHit: 2,  dmgDie: 6,  dmgBonus: 0, fort: 2,  reflex: 1,  gold: [6, 16] },                                            // 1d6 spear
  kobold_shaman:     { name: 'Kobold Shaman',     glyph: '🦎', cr: '1',   hp: 7,   ac: 13, toHit: 0,  dmgDie: 4,  dmgBonus: 0, fort: 2,  reflex: 1,  gold: [12, 26], caster: 'holdperson', spellDC: 13, healer: { dice: 1, uses: 1 } },          // Hold Person (Will DC 13) + one Cure Light for the warren
  kobold_rogue:      { name: 'Kobold Rogue',      glyph: '🦎', cr: '1',   hp: 6,   ac: 16, toHit: 2,  dmgDie: 3,  dmgBonus: 0, fort: 1,  reflex: 4,  gold: [10, 24], attacks: 2, sneakDice: 2, evasion: true, atkSound: '/audio/fight_riki.mp3' }, // two 1d3 daggers + sneak attack; Evasion
  goblin_rogue:      { name: 'Goblin Rogue',      glyph: '👺', cr: '1/2', hp: 7,   ac: 15, toHit: 3,  dmgDie: 4,  dmgBonus: 1, fort: 1,  reflex: 5,  gold: [8, 20],  attacks: 1, sneakDice: 2, evasion: true, atkSound: '/audio/fight_riki.mp3' }, // dogslicer + Sneak Attack; Evasion
  goblin_shaman:     { name: 'Goblin Shaman',     glyph: '👺', cr: '1',   hp: 8,   ac: 13, toHit: 1,  dmgDie: 4,  dmgBonus: 0, fort: 2,  reflex: 2,  gold: [12, 26], caster: 'holdperson', spellDC: 13, healer: { dice: 1, uses: 1 } },          // Hold Person (Will DC 13) — sets up the rogues; one Cure Light for the tribe
  goblin_barbarian:  { name: 'Goblin Barbarian',  glyph: '👺', cr: '1',   hp: 17,  ac: 14, toHit: 4,  dmgDie: 8,  dmgBonus: 4, fort: 4,  reflex: 2,  gold: [12, 28], taunt: { dc: 13, sound: '/audio/taunt_predator_goblin.mp3' } },   // raging goblin — roars a Taunt that pulls AI allies onto it
  skeleton:          { name: 'Skeleton',          glyph: '💀', cr: '1/3', hp: 5,   ac: 16, toHit: 2,  dmgDie: 6,  dmgBonus: 2, fort: 0,  reflex: 1,  gold: [8, 20], dr: { amount: 5, bypass: 'B' } },   // PF1 skeleton — DR 5/bludgeoning (slashing & piercing glance off; a mace crushes)
  giant_spider:      { name: 'Giant Spider',      glyph: '🕷️', cr: '1',   hp: 16,  ac: 14, toHit: 4,  dmgDie: 6,  dmgBonus: 0, fort: 4,  reflex: 4,  gold: [10, 26] },
  zombie:            { name: 'Ghoul Antipaladin', glyph: '🧟', cr: '13', hp: 135, ac: 25, toHit: 20, dmgDie: 8,  dmgCount: 1, dmgBonus: 11, fort: 12, reflex: 9, attacks: 2, gold: [280, 480], type: 'undead', evil: true, paralyze: true, paralyzeDC: 18, healer: { dice: 3, uses: 3 }, shout: { fear: true, dc: 18, sound: '/audio/enemy_lich_gaze.mp3' }, spellstrike: { name: 'TOUCH OF CORRUPTION', dice: 6, die: 6, dtype: 'negative', lifesteal: true, sound: '/audio/spell_umbral_bolt.mp3' }, precast: ['shieldoffaith', 'protfire'] },   // Antipaladin 13 risen as a ghoul: ghoul paralysis, Touch of Corruption (negative drain-touch), an aura of cowardice (dread-shout), channels negative to mend undead allies, pre-warded (art keyed 'zombie')
  ghoul:             { name: 'Ghoul',             glyph: '🧛', cr: '1',   hp: 13,  ac: 14, toHit: 3,  dmgDie: 6,  dmgBonus: 1, fort: 1,  reflex: 3,  gold: [14, 32], paralyze: true, paralyzeDC: 13 },
  cultist:           { name: 'Whispering Cultist',glyph: '🕯️', cr: '1',   hp: 14,  ac: 14, toHit: 3,  dmgDie: 8,  dmgBonus: 1, fort: 3,  reflex: 1,  gold: [16, 38], healer: { dice: 1, uses: 1 } },   // a lay priest of the Whispering Way — one dark mending
  ghoul_crusader:    { name: 'Ghoul Crusader',    glyph: '🧟‍♂️', cr: '9', hp: 80,  ac: 21, toHit: 12, dmgDie: 8,  dmgBonus: 6, fort: 8,  reflex: 6, attacks: 2, gold: [95, 190], type: 'undead', evil: true, paralyze: true, paralyzeDC: 16, healer: { dice: 3, uses: 3 }, caster: 'holdperson', spellDC: 17, shout: { fear: true, dc: 17, sound: '/audio/enemy_lich_gaze.mp3' }, precast: ['shieldoffaith', 'protfire'] },   // a fallen soldier of the Shining Crusade, risen as a ghoul and bound to dark gods — ghoul paralysis + evil cleric 8-12 (holds, dread-shouts, black mendings, pre-warded)
  // ── THE MONKS — named martial artists, each a class NPC (CR ≈ level − 1).
  //    Flurry of unarmed strikes (attacks scale with level), Evasion, Bruce-Lee
  //    kiai SFX. Puff runs with goblin warbands; the two kobold monks with kobold
  //    warrens; the Chelish ones (redactors, the Shackles sailor) are LE agents of
  //    Cheliax; the rest are wildcards that wander into any room. ──
  monk_shaolin:      { name: 'Shaolin Monk',      glyph: '🥋', cr: '4',   hp: 42,  ac: 18, toHit: 8,  dmgDie: 8,  dmgBonus: 4,  fort: 5,  reflex: 8,  will: 8,  gold: [30, 65],  attacks: 3, evasion: true, atkSounds: MONK_SFX },                 // L5 human
  monk_sailor:       { name: 'Shackles Brawler',  glyph: '🥋', cr: '5',   hp: 50,  ac: 19, toHit: 9,  dmgDie: 8,  dmgBonus: 4,  fort: 6,  reflex: 9,  will: 8,  gold: [40, 85],  attacks: 3, evasion: true, evil: true, atkSounds: MONK_SFX },   // L6 chelish sailor monk
  monk_greenbriar:   { name: 'Greenbriar Adept',  glyph: '🥋', cr: '7',   hp: 68,  ac: 20, toHit: 12, dmgDie: 10, dmgBonus: 6,  fort: 8,  reflex: 10, will: 9,  gold: [60, 130], attacks: 3, evasion: true, atkSounds: MONK_SFX },                 // L8 orc monk
  monk_redactor2:    { name: 'Chelish Redactor',  glyph: '🥋', cr: '8',   hp: 78,  ac: 21, toHit: 13, dmgDie: 10, dmgBonus: 6,  fort: 8,  reflex: 11, will: 10, gold: [85, 170], attacks: 3, evasion: true, evil: true, atkSounds: MONK_SFX },   // L9 chelish operative
  monk_redactor:     { name: 'Chelish Redactor',  glyph: '🥋', cr: '9',   hp: 85,  ac: 22, toHit: 14, dmgDie: 10, dmgBonus: 7,  fort: 9,  reflex: 12, will: 11, gold: [95, 190], attacks: 4, evasion: true, evil: true, atkSounds: MONK_SFX },   // L10 chelish operative — destroys/guards forbidden lore
  monk_vakra:        { name: 'Vakra',             glyph: '🥋', cr: '10',  hp: 95,  ac: 23, toHit: 15, dmgDie: 10, dmgBonus: 7,  fort: 9,  reflex: 12, will: 11, gold: [110, 220], attacks: 4, evasion: true, atkSounds: MONK_SFX },                // L11 half-orc monk
  monk_beastmode:    { name: 'Beastmode',         glyph: '🥋', cr: '14',  hp: 140, ac: 26, toHit: 19, dmgDie: 6,  dmgCount: 2, dmgBonus: 10, fort: 13, reflex: 14, will: 12, gold: [180, 360], attacks: 4, evasion: true, atkSounds: MONK_SFX },  // L15 orc monk — a flurry of 2d6+10 fists; very dangerous
  master_uke:        { name: 'Master Uke',        glyph: '🗡️', cr: '16',  hp: 176, ac: 30, toHit: 24, dmgDie: 8,  dmgBonus: 13, fort: 16, reflex: 18, will: 15, attacks: 4, evasion: true, gold: [360, 640], healer: { dice: 3, uses: 2 }, atkSounds: MONK_SFX },  // BOSS — a gestalt Paladin/Unchained-Monk/Samurai MASTER wielding HANZO STEEL (his +5 keen mithral katana): a blinding flurry of blade and fist (4 strikes, d8+13, Improved Crit folded in), Evasion, and Lay on Hands to mend himself mid-duel. LAWFUL GOOD — a righteous foe, so hero Smite Evil finds no purchase.
  monk_puff:         { name: 'Puff',              glyph: '🥋', cr: '2',   hp: 20,  ac: 16, toHit: 4,  dmgDie: 6,  dmgBonus: 2,  fort: 4,  reflex: 6,  will: 5,  gold: [12, 28],  attacks: 2, evasion: true, atkSounds: MONK_SFX },                 // goblin monk (goblin packs)
  monk_kobold:       { name: 'Kobold Monk',       glyph: '🥋', cr: '1',   hp: 12,  ac: 16, toHit: 3,  dmgDie: 4,  dmgBonus: 1,  fort: 3,  reflex: 5,  will: 4,  gold: [8, 20],   attacks: 2, evasion: true, atkSounds: MONK_SFX },                 // kobold monk (kobold packs)
  monk_kobold_big:   { name: 'Kobold Adept',      glyph: '🥋', cr: '3',   hp: 26,  ac: 17, toHit: 6,  dmgDie: 6,  dmgBonus: 2,  fort: 4,  reflex: 6,  will: 5,  gold: [16, 38],  attacks: 2, evasion: true, atkSounds: MONK_SFX },                 // bigger kobold monk
  skeletal_champion: { name: 'Skeletal Champion', glyph: '☠️', cr: '2',   hp: 19,  ac: 17, toHit: 5,  dmgDie: 8,  dmgBonus: 3, fort: 3,  reflex: 2,  gold: [26, 55], dr: { amount: 5, bypass: 'B' }, shout: { dc: 14, sound: '/audio/enemy_draugr_shout.mp3' } },   // DR 5/bludgeoning; bone-rattling shout: 1d8 + Fort or stunned 1
  shadow:            { name: 'Shadow',            glyph: '🌑', cr: '3',   hp: 19,  ac: 13, toHit: 4,  dmgDie: 6,  dmgBonus: 0, fort: 1,  reflex: 3,  gold: [30, 65] },
  fire_skeleton:     { name: 'Fire Skeleton',     glyph: '🔥', cr: '3',   hp: 22,  ac: 16, toHit: 5,  dmgDie: 6,  dmgBonus: 2, fort: 1,  reflex: 2,  gold: [24, 52], dr: { amount: 5, bypass: 'B' }, resist: { fire: 0, cold: 1.5 }, detonate: { count: 2, die: 6, sound: '/audio/enemy_fireskeleton_boom.mp3' } },   // skeleton: DR 5/bludgeoning, fire-immune, VULNERABLE to cold (×1.5); suicide bomber: on its TURN it rushes in and detonates — 1d6 fire/level to 1d2 heroes, destroying itself (kill it first to defuse)
  wight:             { name: 'Wight',             glyph: '👻', cr: '3',   hp: 26,  ac: 15, toHit: 4,  dmgDie: 4,  dmgBonus: 1, fort: 3,  reflex: 1,  gold: [34, 72] },
  skeletal_ogre:     { name: 'Skeletal Ogre',     glyph: '💀', cr: '6',   hp: 60,  ac: 17, toHit: 11, dmgDie: 8,  dmgCount: 2, dmgBonus: 7, fort: 5,  reflex: 2,  attacks: 1, gold: [40, 90], dr: { amount: 5, bypass: 'B' } },   // a Large skeletal ogre — a bone-crushing 2d8 slam (DR 5/bludgeoning); fills the CR6 undead gap + a Summon Undead VI creature
  ogre:              { name: 'Ogre',              glyph: '👹', cr: '3',   hp: 30,  ac: 17, toHit: 8,  dmgDie: 8,  dmgCount: 2, dmgBonus: 7, fort: 6, reflex: 0, gold: [40, 90] },                                  // greatclub 2d8+7
  gray_ooze:         { name: 'Gray Ooze',         glyph: '🟢', cr: '4',   hp: 50,  ac: 6,  toHit: 5,  dmgDie: 6,  dmgBonus: 4, fort: 6,  reflex: 0,  gold: [38, 80] },
  gibbering_mouther: { name: 'Gibbering Mouther', glyph: '👄', cr: '5',   hp: 60,  ac: 19, toHit: 5,  dmgDie: 4,  dmgBonus: 0, fort: 8,  reflex: 6,  gold: [55, 120], attacks: 2 },                              // many small bites
  ettin:             { name: 'Ettin',             glyph: '👹', cr: '6',   hp: 65,  ac: 18, toHit: 12, dmgDie: 6,  dmgCount: 2, dmgBonus: 6, fort: 9, reflex: 3, attacks: 2, gold: [70, 150] },                    // two morningstars
  // ── Diversity pack: animals, aberrations & other beasts (fills CR 3-8) ──
  dire_ape:          { name: 'Dire Ape',          glyph: '🦍', cr: '3',   hp: 30,  ac: 15, toHit: 7,  dmgDie: 6,  dmgBonus: 5,  fort: 7,  reflex: 5,  attacks: 2, gold: [22, 48] },
  ettercap:          { name: 'Ettercap',          glyph: '🕸️', cr: '3',   hp: 30,  ac: 16, toHit: 5,  dmgDie: 8,  dmgBonus: 3,  fort: 5,  reflex: 5,  attacks: 2, gold: [24, 52] },
  dire_boar:         { name: 'Dire Boar',         glyph: '🐗', cr: '4',   hp: 51,  ac: 15, toHit: 12, dmgDie: 8,  dmgBonus: 12, fort: 9,  reflex: 5,  gold: [34, 72] },                                 // gore 1d8+12
  harpy:             { name: 'Harpy',             glyph: '🦅', cr: '4',   hp: 38,  ac: 15, toHit: 9,  dmgDie: 8,  dmgBonus: 1,  fort: 2,  reflex: 7,  attacks: 2, gold: [34, 72], flying: true },
  gargoyle:          { name: 'Mecha Gargoyle',    glyph: '🗿', cr: '6',   hp: 58,  ac: 19, toHit: 11, dmgDie: 6,  dmgBonus: 5,  fort: 6,  reflex: 6,  attacks: 2, gold: [55, 115], flying: true, type: 'construct', dr: { amount: 10, bypass: 'adamantine' }, atkSound: '/audio/spell_shock.mp3' },   // a stone gargoyle cybernetically rebuilt by Unity (Iron Gods) — construct: mind-immune, adamantine claws, elec-vulnerable like its robot kin
  minotaur:          { name: 'Minotaur',          glyph: '🐂', cr: '4',   hp: 45,  ac: 14, toHit: 9,  dmgDie: 6,  dmgCount: 3, dmgBonus: 6, fort: 6, reflex: 5, gold: [38, 80], atkSound: '/audio/enemy_yak.mp3' },   // greataxe 3d6+6 — angry bovine bellow
  basilisk:          { name: 'Basilisk',          glyph: '🐍', cr: '5',   hp: 52,  ac: 16, toHit: 9,  dmgDie: 8,  dmgBonus: 4,  fort: 7,  reflex: 4,  paralyze: true, paralyzeDC: 13, gold: [42, 90] },  // petrifying gaze → "turned to stone, lose a turn"
  winter_wolf:       { name: 'Winter Wolf',       glyph: '🐺', cr: '5',   hp: 57,  ac: 18, toHit: 11, dmgDie: 8,  dmgBonus: 7,  fort: 9,  reflex: 7,  gold: [44, 95], resist: { cold: 0, fire: 1.5 } },   // PF1: cold-immune, VULNERABLE to fire (×1.5)
  blood_caimon:      { name: 'Blood Caimon',      glyph: '🐊', cr: '5',   hp: 60,  ac: 16, toHit: 11, dmgDie: 10, dmgBonus: 9,  fort: 8,  reflex: 5,  gold: [48, 105], atkSound: '/audio/enemy_caimon_bite.mp3' },   // giant red alligator — savage bite
  wood_golem:        { name: 'Wood Golem',        glyph: '🪵', cr: '6',   hp: 58,  ac: 21, toHit: 10, dmgDie: 8,  dmgCount: 2, dmgBonus: 5, fort: 2, reflex: 2, attacks: 2, gold: [55, 115], dr: { amount: 5, bypass: 'S' }, resist: { fire: 1.5 } },         // two 2d8+5 slams; DR 5/slashing (axes bite the timber); PF1 VULNERABLE to fire (×1.5); golem-poor saves
  bog_brute:         { name: 'Bog Brute',         glyph: '🌿', cr: '6',   hp: 65,  ac: 17, toHit: 12, dmgDie: 8,  dmgBonus: 7,  fort: 9,  reflex: 4,  attacks: 2, gold: [55, 115] },
  dire_bear:         { name: 'Dire Bear',         glyph: '🐻', cr: '7',   hp: 84,  ac: 17, toHit: 16, dmgDie: 8,  dmgBonus: 10, fort: 13, reflex: 9, attacks: 2, gold: [70, 150], art: '/dungeon/monsters/dire_bear.webp' },
  chimera:           { name: 'Chimera',           glyph: '🦁', cr: '7',   hp: 76,  ac: 19, toHit: 11, dmgDie: 8,  dmgBonus: 4,  fort: 10, reflex: 6, attacks: 2, gold: [75, 160], flying: true },
  hill_giant:        { name: 'Hill Giant',        glyph: '🪓', cr: '7',   hp: 85,  ac: 21, toHit: 16, dmgDie: 8,  dmgCount: 2, dmgBonus: 10, fort: 12, reflex: 3, gold: [80, 165] },                   // greatclub 2d8+10
  // ── THE MEDUSA-KIN of the Northern Shudderwood — classed serpent-women, each
  //    keeping the petrifying gaze (paralyze) on top of her class. ──
  medusa_archer:     { name: 'Medusa Archer',     glyph: '🐍', cr: '9',   hp: 78,  ac: 20, toHit: 14, dmgDie: 8,  dmgBonus: 5, fort: 6,  reflex: 11, attacks: 2, gold: [95, 190], paralyze: true, paralyzeDC: 16, atkSound: '/audio/bow_shot.mp3' },   // Ranger 9 — snapshots from the treeline; petrifying gaze
  medusa_swashbuckler:{ name: 'Medusa Swashbuckler', glyph: '🐍', cr: '9', hp: 82,  ac: 21, toHit: 14, dmgDie: 6,  dmgBonus: 5, fort: 6,  reflex: 12, attacks: 3, evasion: true, gold: [95, 190], paralyze: true, paralyzeDC: 16 },   // Swashbuckler 9 — parry-riposte rapier; petrifying gaze
  medusa_sorceress:  { name: 'Medusa Sorceress',  glyph: '🐍', cr: '9',   hp: 68,  ac: 17, toHit: 8,  dmgDie: 4,  dmgBonus: 1, fort: 5,  reflex: 8, gold: [95, 190], evil: true, arcane: true, paralyze: true, paralyzeDC: 16 },   // Sorcerer 9 — serpentfire arcana; petrifying gaze
  stone_giant:       { name: 'Stone Giant',       glyph: '🗿', cr: '8',   hp: 102, ac: 24, toHit: 17, dmgDie: 8,  dmgCount: 2, dmgBonus: 12, fort: 12, reflex: 5, gold: [95, 190] },                  // greatclub 2d8+12
  abyssal_horror:    { name: 'Abyssal Horror',    sr: 19, glyph: '🐙', cr: '8',   hp: 95,  ac: 19, toHit: 14, dmgDie: 8,  dmgBonus: 6,  fort: 9,  reflex: 6,  attacks: 2, gold: [95, 190] },                  // eldritch chaos beast
  brass_golem:       { name: 'The Golden Saurian', glyph: '🗿', cr: '9',  hp: 92,  ac: 24, toHit: 16, dmgDie: 10, dmgCount: 2, dmgBonus: 13, fort: 3, reflex: 3, attacks: 2, gold: [180, 320], dr: { amount: 10, bypass: '—' }, atkSound: '/audio/robot_gibberish.mp3', hype: '/audio/robot_gibberish.mp3' },   // 8-HD construct, two 2d10+9 slams; DR 10/—; chatters machine-gibberish as it swings (renamed from Brass Golem — Tobias 2026-07-04)
  barbed_devil:      { name: 'Barbed Devil',      sr: 22, glyph: '😈', cr: '11',  hp: 138, ac: 26, toHit: 18, dmgDie: 8,  dmgCount: 2, dmgBonus: 7, fort: 12, reflex: 9, attacks: 2, gold: [260, 460],
                       dr: { amount: 10, bypass: 'magic' }, resist: { fire: 0, cold: 10, acid: 10 },   // PF1 barbed devil — DR 10/good (modelled as /magic, no alignment weapons here); immune fire, resist cold/acid
                       atkSounds: ['/audio/slorr_sever.mp3', '/audio/slorr_crush.mp3', '/audio/slorr_fury.mp3'],   // Slorr voicelines on its barbed claws
                       hook: { dmgDie: 8, dmgCount: 2, dmgBonus: 7, constrict: 14, sound: '/audio/slorr_grapple.mp3' },   // chain hook → grapple the weakest hero, then constrict each turn
                       hellfire: { count: 3, dice: 5, die: 6, dc: 19, sound: '/audio/spell_hellfire.mp3' } },           // Hellfire Blast — fire AoE, Reflex for half

  vampire:           { name: 'Vampire',           sr: 19, glyph: '🧛', cr: '8',   hp: 95,  ac: 22, toHit: 14, dmgDie: 6,  dmgBonus: 8, fort: 8,  reflex: 11, attacks: 2, gold: [100, 200], dr: { amount: 10, bypass: 'magic' }, evil: true, shout: { fear: true, dc: 18, sound: '/audio/enemy_lich_gaze.mp3' }, spellstrike: { dice: 4, die: 6, dtype: 'negative', lifesteal: true, sound: '/audio/spell_umbral_bolt.mp3' } },   // magus of its level: dominating gaze + Vampiric Touch spellstrike (drains life)
  lich:              { name: 'Lich',              glyph: '💀', cr: '12',  hp: 138, ac: 25, toHit: 16, dmgDie: 8,  dmgBonus: 5, fort: 10, reflex: 9,  gold: [300, 520], dr: { amount: 15, bypass: 'B' }, evil: true, shout: { fear: true, dc: 20, sound: '/audio/enemy_lich_gaze.mp3' }, arcane: true, precast: ['magearmor', 'shield', 'protfire', 'fly'] },                 // a full wizard of its level: Hold Monster, Fireball/Cone/Chain Lightning, Disintegrate, Finger of Death, Magic Missile (see _lichCast); pre-buffed as a boss (keeps its own DR over Stoneskin)

  // ── THE VAMPIRE COURT — classed vampires (PF1 vampire template: DR 10/magic,
  //    undead = mind-immune). CR ≈ class level + 1 for the template. ──
  vampire_spawn:     { name: 'Vampire Spawn',     glyph: '🧛', cr: '4',   hp: 26,  ac: 15, toHit: 7,  dmgDie: 6,  dmgBonus: 4,  fort: 3,  reflex: 5,  gold: [36, 78],   type: 'undead', evil: true, dr: { amount: 5,  bypass: 'magic' } },
  vamp_knight:       { name: 'Vampire Knight',    sr: 20, glyph: '🧛', cr: '9',   hp: 100, ac: 23, toHit: 15, dmgDie: 8,  dmgBonus: 8,  fort: 9,  reflex: 7,  attacks: 2, gold: [110, 220], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' } },   // F8 + vampire
  vamp_inquisitor:   { name: 'Vampire Inquisitor',sr: 21, glyph: '🧛', cr: '10',  hp: 105, ac: 22, toHit: 15, dmgDie: 8,  dmgBonus: 7,  fort: 9,  reflex: 7,  attacks: 2, gold: [120, 240], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' }, shout: { fear: true, dc: 17, sound: '/audio/enemy_lich_gaze.mp3' }, healer: { dice: 2, uses: 2 }, precast: ['shieldoffaith', 'protfire'] },   // I9 + vampire — dread judgment; channels black mending for the court; pre-warded as a boss
  vamp_rogue:        { name: 'Vampire Rogue',     sr: 21, glyph: '🧛', cr: '10',  hp: 95,  ac: 23, toHit: 15, dmgDie: 6,  dmgBonus: 6,  fort: 6,  reflex: 11, attacks: 2, sneakDice: 5, evasion: true, gold: [120, 240], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' } },   // R9 + vampire
  vamp_scout:        { name: 'Vampire Scout',     sr: 22, glyph: '🧛', cr: '11',  hp: 105, ac: 24, toHit: 16, dmgDie: 6,  dmgBonus: 6,  fort: 6,  reflex: 12, attacks: 2, sneakDice: 5, evasion: true, gold: [130, 260], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' } },   // R10 + vampire
  vamp_warrior:      { name: 'Vampire Warrior',   sr: 22, glyph: '🧛', cr: '11',  hp: 120, ac: 24, toHit: 17, dmgDie: 8,  dmgBonus: 9,  fort: 10, reflex: 8,  attacks: 2, gold: [130, 260], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' } },   // F10 + vampire
  vamp_bodyguard:    { name: 'Vampire Bodyguard', sr: 24, glyph: '🧛', cr: '13',  hp: 140, ac: 26, toHit: 19, dmgDie: 8,  dmgBonus: 10, fort: 11, reflex: 9,  attacks: 2, gold: [170, 320], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' }, artPos: '50% 18%' },   // F12 + vampire; artPos: token framed low — pull the circle up onto his helmet
  vamp_priest:       { name: 'Vampire Priest',    sr: 24, glyph: '🧛', cr: '13',  hp: 130, ac: 25, toHit: 17, dmgDie: 8,  dmgBonus: 8,  fort: 11, reflex: 8,  attacks: 2, gold: [170, 320], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' }, shout: { fear: true, dc: 19, sound: '/audio/enemy_lich_gaze.mp3' }, healer: { dice: 3, uses: 3 }, precast: ['shieldoffaith', 'protfire'], bleedTouch: true },   // C12 + vampire — profane litany; a true battle-cleric who mends the court; pre-warded as a boss (divine list); Death-domain Bleeding Touch
  vamp_assassin:     { name: 'Vampire Assassin',  sr: 25, glyph: '🧛', cr: '14',  hp: 140, ac: 27, toHit: 19, dmgDie: 6,  dmgBonus: 8,  fort: 8,  reflex: 13, attacks: 2, sneakDice: 7, evasion: true, gold: [190, 360], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' } },   // R13 + vampire
  vamp_nightguard:   { name: 'Vampire Nightguard',sr: 25, glyph: '🧛', cr: '14',  hp: 160, ac: 27, toHit: 21, dmgDie: 6,  dmgCount: 2, dmgBonus: 10, fort: 12, reflex: 9, attacks: 2, gold: [190, 360], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' } },   // F14 + vampire — polearm sweeps (2d6+10)
  vamp_noble:        { name: 'Vampire Monk',      sr: 26, glyph: '🧛', cr: '17',  hp: 175, ac: 30, toHit: 21, dmgDie: 10, dmgBonus: 8,  fort: 13, reflex: 15, attacks: 4, evasion: true, gold: [260, 480], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' }, shout: { fear: true, dc: 22, sound: '/audio/enemy_lich_gaze.mp3' }, atkSounds: MONK_SFX },   // Monk 17 + vampire — a blur of unarmed flurry (4 strikes), Evasion, dominating gaze
  vamp_techwitch:    { name: 'Vampire Tech Witch',sr: 23, glyph: '🧛', cr: '12',  hp: 110, ac: 22, toHit: 12, dmgDie: 6,  dmgBonus: 4,  fort: 8,  reflex: 8,  gold: [150, 300], type: 'undead', evil: true, dr: { amount: 10, bypass: 'magic' }, arcane: true },   // W11 + vampire — Technic League arcanist, full wizard casting
  // ── THE WHISPERING WAY — classed living cultists (wizards, clerics, rogues,
  //    magi of various levels; NPC CR = class level − 1). They herd the undead
  //    (gang 'undead') but are LIVING humans: mind spells land, channel doesn't
  //    sear them, and their magi favor Vampiric Touch spellstrikes — fitting. ──
  ww_initiate:       { name: 'WW Initiate',        glyph: '🕯️', cr: '1',   hp: 14,  ac: 15, toHit: 2,  dmgDie: 8,  dmgBonus: 1,  fort: 4,  reflex: 0,  gold: [14, 32],  evil: true, healer: { dice: 1, uses: 1 } },   // C2 — a whispered mending for the dead-herders
  ww_knife:          { name: 'WW Knife',           glyph: '🗡️', cr: '3',   hp: 26,  ac: 17, toHit: 6,  dmgDie: 4,  dmgBonus: 2,  fort: 2,  reflex: 7,  attacks: 2, sneakDice: 2, evasion: true, gold: [26, 56], evil: true, atkSound: '/audio/fight_riki.mp3' },   // R4 — paired daggers from the dark
  ww_gravecaller:    { name: 'WW Gravecaller',     glyph: '🕯️', cr: '4',   hp: 36,  ac: 18, toHit: 6,  dmgDie: 8,  dmgBonus: 2,  fort: 6,  reflex: 2,  gold: [34, 72],  evil: true, healer: { dice: 2, uses: 2 }, caster: 'holdperson', spellDC: 15, summon: { pool: ['skeleton', 'ghoul'], count: '1d2', uses: 2 } },   // C5 — divine Hold Person (2nd-level ✓) + mendings; raises a few lesser undead
  ww_bladebound:     { name: 'WW Bladebound',      glyph: '⚔️', cr: '5',   hp: 45,  ac: 18, toHit: 8,  dmgDie: 8,  dmgBonus: 4,  fort: 6,  reflex: 4,  gold: [42, 90],  evil: true, spellstrike: { dice: 3, die: 6, dtype: 'negative', lifesteal: true, sound: '/audio/spell_umbral_bolt.mp3' } },   // Mag6 — Vampiric Touch spellstrikes
  ww_necromancer:    { name: 'WW Necromancer',     glyph: '🧙', cr: '6',   hp: 40,  ac: 16, toHit: 5,  dmgDie: 4,  dmgBonus: 0,  fort: 4,  reflex: 4,  gold: [55, 115], evil: true, arcane: true, precast: ['magearmor', 'shield'], summon: { pool: ['skeleton', 'ghoul', 'skeletal_champion'], count: '1d3', uses: 2 } },   // W7 — full wizard casting (pre-warded as a boss); Animate Dead reinforcements
  ww_slayer:         { name: 'WW Slayer',          glyph: '🗡️', cr: '7',   hp: 60,  ac: 20, toHit: 11, dmgDie: 6,  dmgBonus: 4,  fort: 4,  reflex: 10, attacks: 2, sneakDice: 4, evasion: true, gold: [70, 150], evil: true, atkSound: '/audio/fight_riki.mp3' },   // R8 — twin swords + deep sneak
  ww_deathpriest:    { name: 'WW Death Priest',    glyph: '🕯️', cr: '8',   hp: 70,  ac: 21, toHit: 11, dmgDie: 8,  dmgBonus: 4,  fort: 9,  reflex: 4,  gold: [95, 190], evil: true, healer: { dice: 3, uses: 3 }, caster: 'holdperson', spellDC: 17, shout: { fear: true, dc: 17, sound: '/audio/enemy_lich_gaze.mp3' }, precast: ['shieldoffaith', 'protfire'], bleedTouch: true, summon: { pool: ['ghoul', 'skeletal_champion', 'wight'], count: '1d3', uses: 2 } },   // C9 — dread litany, Hold Person, battle-mendings, Death-domain Bleeding Touch (first hit/room bleeds 1d6); raises undead
  ww_deathblade:     { name: 'WW Deathblade',      glyph: '⚔️', cr: '10',  hp: 95,  ac: 23, toHit: 15, dmgDie: 8,  dmgBonus: 7,  fort: 9,  reflex: 7,  attacks: 2, gold: [120, 240], evil: true, spellstrike: { name: 'INFLICT CRITICAL WOUNDS', dice: 4, die: 8, bonus: 11, dtype: 'negative', healsUndead: true, sound: '/audio/spell_umbral_bolt.mp3' }, precast: ['magearmor', 'shield'] },   // Magus 11 — Whispering Way training grants the INFLICT line to arcane spellstrikes: Inflict Critical Wounds (4d8+11) rides the blade — and it MENDS any undead it strikes (yes, including your undead heroes)
  ww_archnecromancer:{ name: 'WW Archnecromancer', glyph: '🧙', cr: '11',  hp: 75,  ac: 19, toHit: 8,  dmgDie: 4,  dmgBonus: 0,  fort: 7,  reflex: 7,  gold: [130, 260], evil: true, arcane: true, shout: { fear: true, dc: 18, sound: '/audio/enemy_lich_gaze.mp3' }, precast: ['magearmor', 'shield', 'stoneskin', 'fly'], summon: { pool: ['skeletal_champion', 'wight', 'skeletal_ogre'], count: '1d3', uses: 3 } },   // W12 — the cell's master, a lich-in-waiting; raises a horde of undead
  // ── TECHNIC LEAGUE & THRUNE — named villains ──
  zernibeth:         { name: 'Zernibeth',         glyph: '🤖', cr: '13',  hp: 120, ac: 24, toHit: 12, dmgDie: 6,  dmgBonus: 4,  fort: 9,  reflex: 9,  gold: [280, 480], evil: true, arcane: true, precast: ['magearmor', 'shield', 'stoneskin', 'protfire', 'fly'] },   // android W14 of the Technic League (LE) — full wizard casting; walks in pre-buffed (boss only)
  // ── THE MACHINES — Numerian robots from the Iron Gods campaign (Tobias's
  //    custom builds in the f1 world 03irongodspub / folken-constructs pack).
  //    Robot subtype: constructs (mind-immune, unaligned unless intelligent),
  //    adamantine chassis modeled as DR, and the classic Iron Gods weakness —
  //    VULNERABLE to electricity (×1.5, see RESIST_BY_KEY). They march with
  //    Zernibeth and the golems in the 'construct' gang. ──
  drone_rhoomba:     { name: 'Drone 0.5 Rhoomba', glyph: '🤖', cr: '1/3', hp: 4,   ac: 14, toHit: 2,  dmgDie: 4,  dmgBonus: 0,  fort: 0,  reflex: 3,  gold: [3, 10] },   // feral floor-cleaner — shin-bumps and blade-nicks
  drone_collector:   { name: 'Drone 1.0 Collector', glyph: '🤖', cr: '1', hp: 13,  ac: 16, toHit: 3,  dmgDie: 4,  dmgBonus: 2,  fort: 2,  reflex: 1,  attacks: 2, gold: [12, 26], flying: true },   // hovering salvage grabber — two grasping claws
  gearsman_mk1:      { name: 'Gearsman 1.0',      glyph: '🤖', cr: '2',   hp: 26,  ac: 17, toHit: 6,  dmgDie: 6,  dmgBonus: 4,  fort: 2,  reflex: 1,  attacks: 2, gold: [22, 48], dr: { amount: 5, bypass: '—' }, atkSound: '/audio/spell_shock.mp3' },   // the classic Numerian trooper — slam + integrated tazer
  drone_stinger:     { name: 'Drone 2.5 Stinger', glyph: '🤖', cr: '3',   hp: 26,  ac: 18, toHit: 8,  dmgDie: 6,  dmgBonus: 2,  fort: 1,  reflex: 6,  attacks: 2, sneakDice: 2, gold: [26, 60], flying: true },   // darting fly-spy — burrowing blades find the gaps
  drone_repair:      { name: 'Drone 3.0 Repairs', glyph: '🔧', cr: '3',   hp: 30,  ac: 17, toHit: 6,  dmgDie: 6,  dmgBonus: 3,  fort: 2,  reflex: 2,  gold: [26, 60], healer: { dice: 2, uses: 3 } },   // field mechanic — welds battered squadmates back together mid-fight
  gearsman_pugilist: { name: 'Gearsman 3.6 Pugilist', glyph: '🥊', cr: '5', hp: 52, ac: 19, toHit: 10, dmgDie: 8, dmgBonus: 5,  fort: 5,  reflex: 6,  attacks: 3, evasion: true, gold: [42, 90], dr: { amount: 5, bypass: '—' }, atkSounds: MONK_SFX },   // Monk 5 boxing chassis — carbon-fiber flurry (the Terminator variant)
  gearghost:         { name: 'Gearghost',         glyph: '👻', cr: '5',   hp: 60,  ac: 19, toHit: 9,  dmgDie: 10, dmgBonus: 6,  fort: 6,  reflex: 2,  gold: [42, 95], dr: { amount: 10, bypass: 'magic' }, healer: { dice: 2, uses: 2 }, shout: { fear: true, dc: 15, sound: '/audio/spell_shock.mp3' } },   // haunted HEAVY mech — a possessed war-chassis, NOT a flyer: one crushing spectral slam (1d10+6), spectral plating (DR 10/magic), a glitch-wail that spooks heroes, and poltergeist welds that mend its machine kin
  gearsman_gunslinger:{ name: 'Gearsman 5.0 Gunslinger', glyph: '🔫', cr: '6', hp: 60, ac: 20, toHit: 12, dmgDie: 8, dmgBonus: 6, fort: 4, reflex: 9, attacks: 2, gold: [55, 115], atkSound: '/audio/rifle_longue_carabine.mp3' },   // ronin chassis — fanning an integrated revolver
  gearsman_sniper:   { name: 'Gearsman 5.5 Sniper', glyph: '🎯', cr: '7', hp: 68,  ac: 20, toHit: 13, dmgDie: 8,  dmgBonus: 6,  fort: 4,  reflex: 10, attacks: 2, sneakDice: 4, evasion: true, gold: [70, 150], atkSound: '/audio/rifle_dvl_silenced.mp3' },   // Rogue 3/Gunslinger 7 — silenced shots to the vitals
  gearsman_riot:     { name: 'Gearsman 3.0 Riot Suppressor', glyph: '🛡️', cr: '8', hp: 95, ac: 22, toHit: 15, dmgDie: 8, dmgBonus: 9, fort: 6, reflex: 4, attacks: 2, gold: [95, 190], dr: { amount: 5, bypass: '—' }, taunt: { dc: 16, sound: '/audio/spell_shock.mp3' } },   // crowd-control frame — a COMPLIANCE bark taunts AI heroes onto its shield
  gearsman_harvester:{ name: 'Gearsman 6.0 Thought Harvester', glyph: '🧠', cr: '9', hp: 100, ac: 22, toHit: 14, dmgDie: 6, dmgBonus: 6, fort: 6, reflex: 6, attacks: 2, gold: [110, 220], caster: 'holdperson', spellDC: 19 },   // skull-drill chassis — neural clamp locks a hero rigid (Hold, Will DC 19), then it harvests
  gearsman_juggernaut:{ name: 'Gearsman 4.0 Juggernaut', glyph: '🤖', cr: '11', hp: 130, ac: 24, toHit: 17, dmgDie: 10, dmgCount: 2, dmgBonus: 10, fort: 8, reflex: 4, attacks: 2, gold: [260, 460], dr: { amount: 10, bypass: '—' } },   // HUGE siege frame — two 2d10+10 pistons; DR 10/— (adamantine plate)
  mecha_railgun:     { name: 'Mecha 3.4 Railgun Tank', glyph: '🚂', cr: '12', hp: 140, ac: 24, toHit: 18, dmgDie: 12, dmgCount: 2, dmgBonus: 8, fort: 9, reflex: 3, gold: [280, 500], dr: { amount: 10, bypass: '—' }, atkSound: '/audio/rovadra_dragonrifle.mp3' },   // HUGE treaded tank — one hypersonic slug per turn (2d12+8)
  mecha_repeater:    { name: 'Mecha 3.2 Repeater Tank', glyph: '🚂', cr: '13', hp: 155, ac: 25, toHit: 18, dmgDie: 8, dmgBonus: 8, fort: 9, reflex: 4, attacks: 4, gold: [300, 540], dr: { amount: 10, bypass: '—' }, atkSound: '/audio/rifle_sv98.mp3' },   // HUGE four-legged walker — repeater battery, four shots a round
  gearsman_scraper:  { name: 'Gearsman 6.7 Scraper', glyph: '🏗️', cr: '14', hp: 175, ac: 26, toHit: 21, dmgDie: 8, dmgCount: 2, dmgBonus: 12, fort: 11, reflex: 5, attacks: 2, gold: [340, 600], dr: { amount: 10, bypass: '—' },
                       hook: { dmgDie: 8, dmgCount: 2, dmgBonus: 12, constrict: 16, sound: '/audio/spell_shock.mp3' } },   // HUGE rail-scraper mech — GRAB SHOCK CRUSH: seizes a hero, then crushes with live current each turn
  mecha_warden:      { name: 'Mecha 5.5 Warden',  glyph: '🤖', cr: '15',  hp: 190, ac: 27, toHit: 21, dmgDie: 10, dmgCount: 2, dmgBonus: 10, fort: 12, reflex: 6, attacks: 3, gold: [380, 680], dr: { amount: 10, bypass: '—' }, atkSounds: ['/audio/rifle_lapua.mp3', '/audio/rifle_sv98.mp3', '/audio/rovadra_dragonrifle.mp3'] },   // BOSS — gatling arms + sniper arm, three barrels a round (boss only)
  overlord:          { name: 'Overlord',          sr: 28, glyph: '👁️', cr: '17',  hp: 210, ac: 28, toHit: 20, dmgDie: 8, dmgBonus: 11, fort: 13, reflex: 11, attacks: 2, gold: [450, 800], dr: { amount: 10, bypass: '—' }, evil: true, arcane: true, precast: ['magearmor', 'shield', 'stoneskin', 'protfire', 'fly'] },   // BOSS — Unity's herald, a Construct-25 war-mind: full arcane barrage, pre-warded, SR 28
  // ── THE SHACKLES — pirate crews, the Fungal dead, sahuagin sea-devils and
  //    Charau-Ka ape-men from Tobias's f1 world 03-shackletastic (task #61
  //    batch 2). Gangs: 'pirate' (crews + the Fungal, who also run with the
  //    restless dead), 'sahuagin' (a sea-devil raiding party), 'charauka'
  //    (a shrieking ape warband). ──
  shackles_lubber:   { name: 'Damned Lubber',     glyph: '🏴‍☠️', cr: '1/3', hp: 6, ac: 14, toHit: 2,  dmgDie: 6,  dmgBonus: 1,  fort: 2,  reflex: 1,  gold: [5, 14] },   // press-ganged deckhand with a belaying pin
  shackles_buccaneer:{ name: 'Fever Sea Buccaneer', glyph: '🏴‍☠️', cr: '1', hp: 16, ac: 15, toHit: 4, dmgDie: 6,  dmgBonus: 2,  fort: 3,  reflex: 2,  gold: [12, 26] },   // cutlass tar of the Fever Sea
  shackles_scallywag:{ name: 'Fever Sea Scallywag', glyph: '🏹', cr: '1',  hp: 14,  ac: 15, toHit: 4,  dmgDie: 8,  dmgBonus: 2,  fort: 2,  reflex: 4,  gold: [12, 26], atkSound: '/audio/bow_shot.mp3' },   // longboat archer
  shackles_marine:   { name: 'Chelish Marine',    glyph: '🔫', cr: '3',   hp: 28,  ac: 17, toHit: 7,  dmgDie: 12, dmgBonus: 3,  fort: 4,  reflex: 5,  gold: [26, 60], atkSound: '/audio/rifle_longue_carabine.mp3' },   // Gunslinger 5 — musket volley from the fighting top
  shackles_seacaster:{ name: 'Shackles Sea-Caster', glyph: '🌊', cr: '3', hp: 24,  ac: 15, toHit: 4,  dmgDie: 4,  dmgBonus: 1,  fort: 2,  reflex: 3,  gold: [26, 60], evil: true, arcane: true },   // S4 storm-blooded deck wizard
  shackles_swashbuckler:{ name: 'Port Peril Kingsguard', glyph: '⚔️', cr: '11', hp: 105, ac: 24, toHit: 17, dmgDie: 8, dmgBonus: 9, fort: 9, reflex: 8, attacks: 3, gold: [110, 220] },   // Fighter 12 — the Hurricane King's elite guard; heavy blade, full iteratives (cavalier levels later)
  shackles_officer:  { name: 'Bronze Fleet Officer', glyph: '🏴‍☠️', cr: '5', hp: 48, ac: 19, toHit: 10, dmgDie: 6, dmgBonus: 5, fort: 5, reflex: 6, attacks: 2, gold: [42, 90] },   // slaver fleet mate — cutlass + pistol grip
  sahuagin_scout:    { name: 'Sahuagin Scout',    glyph: '🦈', cr: '3',   hp: 26,  ac: 17, toHit: 7,  dmgDie: 6,  dmgBonus: 2,  fort: 3,  reflex: 6,  attacks: 2, sneakDice: 2, evasion: true, gold: [26, 60] },   // tidal trickster — knife-work from the surf
  sahuagin_ranger:   { name: 'Sahuagin Reefstalker', glyph: '🦈', cr: '5', hp: 48, ac: 18, toHit: 10, dmgDie: 8, dmgBonus: 4, fort: 6, reflex: 8, attacks: 2, ranged: true, gold: [42, 90], atkSound: '/audio/bow_shot.mp3' },   // Ranger 6 — a coral-bow sniper looses barbed arrows from the reef, two shots a round (see RANGED_KEYS)
  sahuagin_rager:    { name: 'Sahuagin Rager',    glyph: '🦈', cr: '5',   hp: 55,  ac: 17, toHit: 11, dmgDie: 8,  dmgBonus: 7,  fort: 8,  reflex: 4,  gold: [42, 90] },   // bloodrager — a frothing frenzy of trident and teeth
  sahuagin_shaman:   { name: 'Sahuagin Shaman',   glyph: '🦈', cr: '5',   hp: 45,  ac: 17, toHit: 8,  dmgDie: 6,  dmgBonus: 3,  fort: 5,  reflex: 4,  gold: [42, 95], healer: { dice: 2, uses: 2 }, caster: 'holdperson', spellDC: 16 },   // deep-god witchery: holds a hero rigid, mends the raiders
  sahuagin_prince:   { name: 'Sahuagin Prince',   glyph: '👑', cr: '7',   hp: 76,  ac: 21, toHit: 13, dmgDie: 8,  dmgBonus: 7,  fort: 8,  reflex: 6,  attacks: 2, gold: [70, 150], gloriousChallenge: true, blazeOfGlory: true },   // Cavalier 7, big blade — ORDER OF THE FLAME: every hero it DROPS fuels a GLORIOUS CHALLENGE (+2 dmg / −2 AC per consecutive kill this room, compounding). Kill it fast.
  charauka_warrior:  { name: 'Charau-Ka Warrior', glyph: '🐒', cr: '5',   hp: 50,  ac: 19, toHit: 10, dmgDie: 6,  dmgBonus: 4,  fort: 5,  reflex: 7,  attacks: 3, evasion: true, gold: [42, 90] },   // Brawler 6 ape-man — a shrieking flurry of fists and thrown stones
  charauka_stepper:  { name: 'Charau-Ka Stepper', glyph: '🐒', cr: '6',   hp: 55,  ac: 20, toHit: 11, dmgDie: 6,  dmgBonus: 4,  fort: 4,  reflex: 9,  attacks: 2, sneakDice: 4, evasion: true, gold: [55, 115], atkSound: '/audio/fight_riki.mp3' },   // Rogue 7 — drops from the canopy onto your back
  charauka_mancer:   { name: 'Charau-Ka Mancer',  glyph: '🐒', cr: '7',   hp: 60,  ac: 18, toHit: 8,  dmgDie: 4,  dmgBonus: 1,  fort: 5,  reflex: 6,  gold: [70, 150], evil: true, arcane: true },   // Witch 8 — jungle hexes and Angazhan's fire
  fungal_pirate:     { name: 'Fungal Pirate',     glyph: '🧟', cr: '5',   hp: 52,  ac: 18, toHit: 10, dmgDie: 6,  dmgBonus: 5,  fort: 4,  reflex: 4,  attacks: 2, gold: [42, 90], type: 'undead', evil: true, dr: { amount: 5, bypass: 'S' } },   // drowned crew re-risen, cutlass still in hand, spores in the wounds
  fungal_oracle:     { name: 'Fungal Oracle',     glyph: '🧟', cr: '7',   hp: 66,  ac: 19, toHit: 10, dmgDie: 8,  dmgBonus: 4,  fort: 6,  reflex: 5,  gold: [70, 150], type: 'undead', evil: true, dr: { amount: 5, bypass: 'S' }, healer: { dice: 3, uses: 3 } },   // rot-priest — black mendings knit the crew's fungus flesh
  fungal_captain:    { name: 'Fungal Captain',    glyph: '🧟', cr: '8',   hp: 85,  ac: 20, toHit: 14, dmgDie: 6,  dmgBonus: 6,  fort: 7,  reflex: 6,  attacks: 2, gold: [95, 190], type: 'undead', evil: true, dr: { amount: 5, bypass: 'S' }, shout: { fear: true, dc: 16, sound: '/audio/enemy_lich_gaze.mp3' } },   // the wreck's master — a moldering bellow that breaks nerve
  bentbeak_charney:  { name: 'Bent-Beak Charney', glyph: '🥊', cr: '7',   hp: 72,  ac: 20, toHit: 13, dmgDie: 8,  dmgBonus: 6,  fort: 7,  reflex: 8,  attacks: 3, evasion: true, gold: [70, 150], atkSounds: MONK_SFX, taunt: { dc: 16, sound: '/audio/taunt_predator_goblin.mp3' } },   // Brawler 7 dock legend — bare knuckles and a mouth that starts fights
  captain_maris:     { name: 'Captain Maris',     glyph: '🏴‍☠️', cr: '9', hp: 90, ac: 22, toHit: 15, dmgDie: 6,  dmgBonus: 7,  fort: 7,  reflex: 10, attacks: 3, evasion: true, gold: [110, 220], evil: true },   // Swashbuckler 10 tiefling captain — rapier bleeding-wounds and perfect footwork
  ikualoa:           { name: "Ikualo'a",          glyph: '🦖', cr: '10',  hp: 135, ac: 19, toHit: 19, dmgDie: 6,  dmgCount: 4, dmgBonus: 16, fort: 14, reflex: 11, gold: [240, 420], atkSound: '/audio/enemy_caimon_bite.mp3', hype: '/audio/tyrannosaur_low_roar_reverb.mp3' },   // BOSS — the tattooed tyrant-lizard the islanders worship (3d8+10 bite, boss only)
  captain_thrune:    { name: 'Captain Elliot Thrune', glyph: '🎩', cr: '13', hp: 58,  ac: 14, toHit: 6,  dmgDie: 4, dmgBonus: 0, fort: 5, reflex: 6, gold: [300, 520], evil: true, arcane: true, precast: ['magearmor', 'shield', 'stoneskin', 'protfire', 'fly'] },   // BOSS — W12 Chelish navy captain, full arcane broadside, pre-warded (boss only)
  barzillai:         { name: 'Barzillai Thrune',  glyph: '😈', cr: '15',  hp: 130, ac: 27, toHit: 21, dmgDie: 6,  dmgCount: 2, dmgBonus: 10, fort: 12, reflex: 7, attacks: 3, gold: [340, 580], evil: true, shout: { fear: true, dc: 22, sound: '/audio/enemy_lich_gaze.mp3' }, healer: { dice: 3, uses: 2 }, precast: ['shieldoffaith', 'protfire'] },   // BOSS — Inquisitor 16 of Asmodeus in +5 armor swinging a +5 FLAMING-BURST heavy mace (d8+9 + 1d6 fire folded → 2d6+10), three swings a round; dread litany, battle-mendings, pre-warded. He NEVER rides alone —
  rivozair:          { name: 'Rivozair',          sr: 27, glyph: '🐲', cr: '17',  hp: 210, ac: 28, toHit: 25, dmgDie: 8,  dmgCount: 2, dmgBonus: 13, fort: 16, reflex: 13, attacks: 3, flying: true, gold: [440, 760], evil: true, dr: { amount: 10, bypass: 'magic' }, resist: { electricity: 0, fire: 0.5 }, arcane: true, healer: { dice: 4, uses: 2 }, precast: ['magearmor', 'shield'], shout: { fear: true, dc: 24, sound: '/audio/dragon_roar_rivozair.mp3' },
                       hellfire: { count: 3, dice: 12, die: 8, dc: 24, dtype: 'electricity', verb: 'exhales a CRACKLING BOLT OF LIGHTNING down the party line', sound: '/audio/fight_lightning_2.mp3' }, hype: '/audio/dragon_roar_rivozair.mp3' },   // BOSS — Barzillai's devil-bound blue dragon (18 HD, Huge): lightning-immune, breath 12d8 electricity, full arcane FIRE barrage + divine mendings, SR 27; her roar announces the room
  abrogail:          { name: 'Abrogail Thrune II',glyph: '👑', cr: '16',  hp: 200, ac: 27, toHit: 14, dmgDie: 4,  dmgBonus: 4,  fort: 11, reflex: 12, gold: [400, 700], evil: true, arcane: true, shout: { fear: true, dc: 23, sound: '/audio/enemy_lich_gaze.mp3' }, art: '/dungeon/monsters/abrogail.png', precast: ['magearmor', 'shield', 'stoneskin', 'protfire', 'fly'] },   // S17 — Queen of Cheliax, full arcane barrage; pre-buffed (boss only)
  // ── THE INFERNAL COURT — classed devils (devil template: DR 10/magic, fire-immune,
  //    resist cold & acid). ──
  devil_swordsman:   { name: 'Devil Swordsman',   sr: 22, glyph: '😈', cr: '11',  hp: 125, ac: 25, toHit: 17, dmgDie: 8,  dmgBonus: 9,  fort: 11, reflex: 9,  attacks: 2, gold: [130, 260], evil: true, dr: { amount: 10, bypass: 'magic' }, resist: { fire: 0, cold: 0.5, acid: 0.5 } },   // F10 + devil — katana
  devil_samurai:     { name: 'Devil Samurai',     sr: 24, glyph: '😈', cr: '13',  hp: 145, ac: 26, toHit: 19, dmgDie: 6,  dmgCount: 2, dmgBonus: 9, fort: 12, reflex: 10, attacks: 2, gold: [170, 320], evil: true, dr: { amount: 10, bypass: 'magic' }, resist: { fire: 0, cold: 0.5, acid: 0.5 } },   // F12 + devil — naginata (2d6+9)
  devil_rogue:       { name: 'Nameless Horror',   sr: 27, glyph: '😈', cr: '16',  hp: 175, ac: 29, toHit: 22, dmgDie: 6,  dmgBonus: 9,  fort: 10, reflex: 15, attacks: 3, sneakDice: 8, evasion: true, gold: [380, 640], evil: true, dr: { amount: 10, bypass: 'magic' }, resist: { fire: 0, cold: 0.5, acid: 0.5 } },   // R15 + devil (Mangvhune) — a dual-wielding horror; its name is not spoken
  bomb_devil:        { name: 'Bomb Devil',        sr: 22, glyph: '💣', cr: '11',  hp: 115, ac: 24, toHit: 16, dmgDie: 6,  dmgBonus: 6,  fort: 10, reflex: 11, gold: [130, 260], evil: true, dr: { amount: 10, bypass: 'magic' }, resist: { fire: 0, cold: 0.5, acid: 0.5 },
                       hellfire: { count: 3, dice: 6, die: 6, bonus: 4, dc: 20, uses: 6, eager: true, verb: 'lobs a sputtering GRENADE into the party', sound: '/audio/tarkov_grenade_frag_full_.mp3' } },   // ALCHEMIST of its HD (11): bombs = 6d6+4 (1d6 per 2 levels + Int), a deep satchel (6), and it BOMBS ON SIGHT (eager) — Tarkov frag report from foundry media
  // ── DRAGONS — winged terrors with breath weapons (reuse the hellfire AoE with a
  //    breath verb + element). ──
  // Dragons are inherently EVERYTHING (Tobias): claws/bite melee, arcane blasting
  // at range, divine support casting, breath weapon, frightful presence, wings.
  // That toolkit is boss material — both are BOSS-ONLY now (they still lead
  // kobold warrens: the boss room fills its minions from the dragon's gangs).
  black_dragon:      { name: 'Black Dragon',      glyph: '🐉', cr: '11',  hp: 150, ac: 26, toHit: 20, dmgDie: 6,  dmgCount: 2, dmgBonus: 9, fort: 12, reflex: 9, attacks: 2, flying: true, gold: [200, 400], evil: true, dr: { amount: 5, bypass: 'magic' }, resist: { acid: 0 }, shout: { fear: true, dc: 19, sound: '/audio/enemy_lich_gaze.mp3' },
                       arcane: true, healer: { dice: 3, uses: 2 }, precast: ['magearmor', 'shield'],
                       hellfire: { count: 3, dice: 8, die: 6, dc: 20, dtype: 'acid', verb: 'breathes a hissing LINE OF ACID across the party', sound: '/audio/spell_acidsplash.mp3' } },   // adult black dragon — acid breath, frightful presence, sorcerer-casts + divine mendings
  void_dragon:       { name: 'Void Dragon',       glyph: '🐉', cr: '13',  hp: 175, ac: 27, toHit: 21, dmgDie: 8,  dmgCount: 2, dmgBonus: 9, fort: 13, reflex: 10, attacks: 2, flying: true, gold: [260, 480], evil: true, dr: { amount: 5, bypass: 'magic' }, resist: { cold: 0 }, shout: { fear: true, dc: 21, sound: '/audio/enemy_lich_gaze.mp3' },
                       arcane: true, healer: { dice: 4, uses: 2 }, precast: ['magearmor', 'shield'],
                       hellfire: { count: 3, dice: 10, die: 6, dc: 21, dtype: 'cold', verb: 'exhales a freezing GULF OF THE VOID over the party', sound: '/audio/spell_coneofcold.mp3' } },   // void dragon — entropic cold breath, full caster on the wing
  // ── EX-PC BOSSES — retired player characters back as villains ──
  blackout:          { name: 'Blackout',          sr: 20, glyph: '🎯', cr: '13',  hp: 120, ac: 23, toHit: 25, dmgDie: 10, dmgBonus: 8, fort: 12, reflex: 16, attacks: 3, sneakDice: 4, evasion: true, gold: [340, 600], evil: true, atkSound: '/audio/tarkov_sr25_silenced_3shot_burst.mp3' },   // BOSS — drow Slayer 14 (ex-PC, Iron Gods): SR-25 marksman rifle, 3-round bursts into studied vitals; drow SR 20
  ragh:              { name: 'Ragh',              glyph: '🔨', cr: '9',   hp: 118, ac: 15, toHit: 20, dmgDie: 8,  dmgCount: 2, dmgBonus: 13, fort: 13, reflex: 5, attacks: 2, gold: [110, 220], evil: true, atkSound: '/audio/mjolnir_short_hitd.mp3' },   // BOSS — orc Barbarian 10 (ex-PC): hurls a THROW-AND-RETURN STEEL BEAM (2d8+9) that always comes back
  // ── PALACE UNIQUES & CARRION CROWN CANON — bosses pulled from the Iron Gods
  //    world's Palace Uniques folder and the carrioncrown archive, at their
  //    in-story canonical levels (Tobias 2026-07-04). ──
  // (Freya / Jason / Jmal removed as ENEMIES 2026-07-05 — they are the Hell's
  //  Vengeance PCs and now ship as PLAYABLE AI-HEROES; see db.js BOT_ROSTER.)
  black_sovereign:   { name: 'Kevoth-Kul, the Black Sovereign', glyph: '👑', cr: '16', hp: 210, ac: 19, toHit: 30, dmgDie: 6, dmgCount: 4, dmgBonus: 17, fort: 16, reflex: 7, attacks: 3, vicious: 6, gold: [400, 700], atkSound: '/audio/sword_eviscerate2_flaming.mp3', hype: '/audio/tool_sober_hype.mp3' },   // BOSS — Barbarian 17 swinging BURNING HATE, his +5 VICIOUS greatsword: 2d6+18 blade + 2d6 vicious per hit — and the blade bites HIM for 1d6 every hit too (CN — enthralled, not evil; smite finds no purchase)
  amalokla:          { name: 'Amalokla, the First Sovereign', sr: 28, glyph: '👻', cr: '17', hp: 225, ac: 28, toHit: 24, dmgDie: 8, dmgBonus: 8, fort: 14, reflex: 17, attacks: 2, flying: true, gold: [440, 760], evil: true, dr: { amount: 10, bypass: 'magic' }, shout: { fear: true, dc: 22, sound: '/audio/enemy_lich_gaze.mp3' }, spellstrike: { dice: 6, die: 6, dtype: 'negative', lifesteal: true, sound: '/audio/spell_umbral_bolt.mp3' } },   // BOSS — the dybbuk who first ruled Numeria: PAIN TOUCH drains the living, dread presence, SR 28
  brogwort:          { name: 'Brogwort the Dim',  glyph: '🪨', cr: '17',  hp: 243, ac: 27, toHit: 27, dmgDie: 8,  dmgCount: 2, dmgBonus: 11, fort: 14, reflex: 13, attacks: 3, gold: [440, 760], atkSounds: ['/audio/wolf_bite_.mp3', '/audio/sword_smack_big.mp3'], hype: '/audio/backstreet_everybody_sexual.mp3' },   // BOSS — Huge athach (18 HD): bite + two slams a round, dim but VERY thorough
  auren_vrood:       { name: 'Auren Vrood',       glyph: '🕯️', cr: '13',  hp: 70,  ac: 12, toHit: 9,  dmgDie: 4,  dmgBonus: 0,  fort: 6,  reflex: 7, gold: [300, 520], evil: true, arcane: true, shout: { fear: true, dc: 19, sound: '/audio/enemy_lich_gaze.mp3' }, precast: ['magearmor', 'shield', 'stoneskin', 'fly'], hype: '/audio/radiohead_everything_intro.mp3' },   // BOSS — Necromancer 14 (Agent of the Grave), the Whispering Way's field commander: full arcane, dread litany, pre-warded
  vorkstag:          { name: 'Vorkstag',          glyph: '🔪', cr: '9',   hp: 70,  ac: 21, toHit: 14, dmgDie: 6,  dmgBonus: 6,  fort: 7,  reflex: 12, attacks: 2, sneakDice: 5, evasion: true, gold: [110, 220], evil: true, atkSound: '/audio/fight_riki.mp3' },   // BOSS — Rogue 10, the skinstealing half of Vorkstag & Grine: wears other people's faces, knives from the dark
  tar_baphon:        { name: 'Tar-Baphon, the Whispering Tyrant', sr: 31, glyph: '💀', cr: '20', hp: 175, ac: 17, toHit: 12, dmgDie: 8, dmgBonus: 10, fort: 11, reflex: 12, gold: [800, 1500], evil: true, arcane: true, paralyze: true, paralyzeDC: 25, dr: { amount: 15, bypass: 'B' }, shout: { fear: true, dc: 25, sound: '/audio/enemy_lich_gaze.mp3' }, precast: ['magearmor', 'shield', 'stoneskin', 'protfire', 'fly'] },   // BOSS — Wizard 20 archlich, the Whispering Tyrant himself: the deepest thing in the dungeon (SR 31, DR 15/B, full arcane)
  // ── HARPY SORCERER — harpy stats + 9 sorcerer levels (full arcane barrage on the wing). ──
  harpy_sorcerer:    { name: 'Harpy Sorcerer',    glyph: '🦅', cr: '10',  hp: 95,  ac: 21, toHit: 13, dmgDie: 6,  dmgBonus: 4,  fort: 6,  reflex: 10, attacks: 2, flying: true, gold: [120, 240], evil: true, arcane: true, precast: ['magearmor', 'shield', 'stoneskin'] },   // pre-buffed as a boss (already on the wing)
  // ── HELL'S LEGIONS — the infernal FACTION (gang 'devil'). Fills the low-mid
  //    CR gap the existing devils (CR11-16) left open, up to the Pit Fiend
  //    capstone. Canonical PF1 Bestiary stat blocks. Fire-immune, cold/acid-
  //    resistant, SR + DR/magic. They NEVER share a room with the celestials. ──
  imp:               { name: 'Imp',               glyph: '😈', cr: '2',   hp: 16,  ac: 17, toHit: 8,  dmgDie: 4,  dmgBonus: 0,  fort: 3,  reflex: 5, gold: [20, 50],  flying: true, sr: 13, evil: true, resist: { fire: 0, cold: 0.5, acid: 0.5 } },   // Tiny flying trickster — a stinger and a nasty attitude (fast healing, invisibility in lore)
  accuser_devil:     { name: 'Accuser Devil',     glyph: '👁️', cr: '3',   hp: 30,  ac: 16, toHit: 6,  dmgDie: 4,  dmgBonus: 1,  fort: 5,  reflex: 5, gold: [30, 70],  flying: true, sr: 14, evil: true, resist: { fire: 0, cold: 0.5, acid: 0.5 } },   // Zebub — a flying spy-devil, filth-fever bite, watches from the dark
  erinyes:           { name: 'Erinyes',           glyph: '🏹', cr: '8',   hp: 94,  ac: 24, toHit: 15, dmgDie: 8,  dmgBonus: 5,  fort: 11, reflex: 12, attacks: 2, flying: true, sr: 20, gold: [90, 190], evil: true, dr: { amount: 5, bypass: 'magic' }, resist: { fire: 0, cold: 0.5, acid: 0.5 }, atkSound: '/audio/bow_silent_hits.mp3' },   // fallen-angel ARCHER devil — a flaming longbow on the wing (the faction's ranged specialist)
  bone_devil:        { name: 'Bone Devil',        glyph: '💀', cr: '9',   hp: 105, ac: 25, toHit: 18, dmgDie: 4,  dmgCount: 3, dmgBonus: 9, fort: 12, reflex: 9, attacks: 2, flying: true, sr: 20, gold: [95, 190], evil: true, dr: { amount: 10, bypass: 'magic' }, resist: { fire: 0, cold: 0.5, acid: 0.5 }, shout: { fear: true, dc: 18, sound: '/audio/enemy_lich_gaze.mp3' } },   // Osyluth — a skeletal horror on the wing: poison sting (3d4), claws, and an aura of fear
  horned_devil:      { name: 'Horned Devil',      sr: 27, glyph: '👿', cr: '16',  hp: 217, ac: 35, toHit: 30, dmgDie: 6, dmgCount: 2, dmgBonus: 16, fort: 18, reflex: 17, attacks: 3, flying: true, gold: [380, 640], evil: true, dr: { amount: 15, bypass: 'magic' }, resist: { fire: 0, cold: 0.5, acid: 0.5 }, shout: { fear: true, dc: 23, sound: '/audio/enemy_lich_gaze.mp3' } },   // BOSS — Cornugon: a stunning +1 spiked chain (2d6+16) on the wing, regeneration, an aura of dread
  pit_fiend:         { name: 'Pit Fiend',         sr: 32, glyph: '👹', cr: '20',  hp: 350, ac: 38, toHit: 37, dmgDie: 6, dmgCount: 4, dmgBonus: 13, fort: 26, reflex: 19, attacks: 3, flying: true, gold: [800, 1500], evil: true, arcane: true, dr: { amount: 15, bypass: 'magic' }, resist: { fire: 0, cold: 0.5, acid: 0.5 }, shout: { fear: true, dc: 25, sound: '/audio/enemy_lich_gaze.mp3' }, precast: ['magearmor', 'shield', 'stoneskin', 'fly'], hellfire: { count: 3, dice: 10, die: 6, dc: 25, dtype: 'fire', verb: 'calls a rain of METEORIC HELLFIRE down on the party', sound: '/audio/spell_hellfire.mp3' } },   // BOSS — the lord of Hell's armies: claws/bite/tail flurry, full arcane (meteor swarm), fear aura, SR 32 — a peer of Tar-Baphon at the bottom of the dungeon
  // ── THE HEAVENLY HOST — the celestial FACTION (gang 'celestial'). The
  //    righteous foes you fight AS the villains (Hell's Vengeance). GOOD-aligned
  //    (hero Smite Evil finds no purchase), immune to electricity, resistant to
  //    fire/cold/acid, SR. Their own gang — they NEVER share a room with devils
  //    or the undead. Canonical PF1 Bestiary stat blocks. ──
  hound_archon:      { name: 'Hound Archon',      glyph: '🐕', cr: '4',   hp: 39,  ac: 19, toHit: 8,  dmgDie: 8,  dmgBonus: 4,  fort: 6,  reflex: 5, attacks: 2, gold: [35, 75],  sr: 16, resist: { electricity: 0, fire: 0.5, cold: 0.5, acid: 0.5 } },   // a dog-headed warden angel — bite + slams, an aura of menace, blinks across the room (teleport)
  bralani_azata:     { name: 'Bralani Azata',     glyph: '🏹', cr: '6',   hp: 66,  ac: 20, toHit: 10, dmgDie: 8,  dmgBonus: 4,  fort: 9,  reflex: 9, attacks: 2, flying: true, gold: [60, 120], sr: 17, dr: { amount: 5, bypass: 'magic' }, resist: { electricity: 0, fire: 0.5, cold: 0.5, acid: 0.5 }, arcane: true, atkSound: '/audio/bow_shot.mp3' },   // an elemental eladrin — a composite longbow and a whirlwind blast (lightning), CL6 spells: the host's ranged caster
  lillend_azata:     { name: 'Lillend Azata',     glyph: '🎵', cr: '7',   hp: 84,  ac: 21, toHit: 13, dmgDie: 8,  dmgBonus: 7,  fort: 9,  reflex: 11, attacks: 2, flying: true, gold: [70, 140], sr: 18, dr: { amount: 10, bypass: 'magic' }, resist: { electricity: 0, fire: 0.5, cold: 0.5, acid: 0.5 }, healer: { dice: 3, uses: 3 }, caster: 'holdperson', spellDC: 16 },   // a serpent-bodied muse-angel — bardic song, constricting tail, CL10 healing: the host's SUPPORT
  movanic_deva:      { name: 'Movanic Deva',      glyph: '⚔️', cr: '10',  hp: 126, ac: 24, toHit: 19, dmgDie: 6, dmgCount: 2, dmgBonus: 10, fort: 14, reflex: 13, attacks: 2, flying: true, gold: [120, 240], sr: 21, dr: { amount: 10, bypass: 'magic' }, resist: { electricity: 0, fire: 0.5, cold: 0.5, acid: 0.5 }, healer: { dice: 3, uses: 3 }, atkSound: '/audio/sword_eviscerate2_flaming.mp3' },   // a frontline war-angel — a flaming greatsword (2d6+10) and druidic mending
  ghaele_azata:      { name: 'Ghaele Azata',      sr: 25, glyph: '✨', cr: '13',  hp: 152, ac: 27, toHit: 23, dmgDie: 6, dmgCount: 2, dmgBonus: 14, fort: 14, reflex: 14, attacks: 2, flying: true, gold: [300, 520], dr: { amount: 10, bypass: 'magic' }, resist: { electricity: 0, fire: 0.5, cold: 0.5, acid: 0.5 }, arcane: true, healer: { dice: 4, uses: 3 }, precast: ['magearmor', 'shield'] },   // BOSS — a knight-errant angel: a +2 greatsword OR searing light-rays, CL14 cleric spells, a blinding gaze
  astral_deva:       { name: 'Astral Deva',       sr: 30, glyph: '😇', cr: '14',  hp: 172, ac: 29, toHit: 26, dmgDie: 8, dmgCount: 1, dmgBonus: 12, fort: 18, reflex: 16, attacks: 2, flying: true, gold: [340, 600], dr: { amount: 10, bypass: 'magic' }, resist: { electricity: 0, fire: 0.5, cold: 0.5, acid: 0.5 }, shout: { fear: true, dc: 21, sound: '/audio/enemy_lich_gaze.mp3' } },   // BOSS — a heavenly avenger: a +3 disruption warhammer that STUNS, a stunning smash, an aura of righteous menace
  // ── NEW celestial foes (2026-07-06) — Angel Bro, two aasimar gunslingers, an
  //    angel field-healer, an angel cavalier-knight, and their paladin champion
  //    CHAD. All ride the 'celestial' gang, GOOD-aligned, electricity-immune. ──
  angel_bro:         { name: 'Erelim (Angel Bro)', glyph: '💪', cr: '8',   hp: 95,  ac: 22, toHit: 14, dmgDie: 8, dmgCount: 2, dmgBonus: 9,  fort: 11, reflex: 8,  attacks: 2, flying: true, gold: [90, 180],  sr: 19, dr: { amount: 10, bypass: 'magic' }, resist: { electricity: 0, fire: 0.5, cold: 0.5, acid: 0.5 } },   // a warrior-angel "bro" — twin holy longswords and a wall of muscle
  aasimar_gunslinger:{ name: 'August', glyph: '🔫', cr: '10',  hp: 92,  ac: 21, toHit: 16, dmgDie: 8, dmgCount: 2, dmgBonus: 6,  fort: 9,  reflex: 13, attacks: 2, ranged: true, gold: [120, 240], sr: 20, atkSound: '/audio/tarkov_revolver_357_shot.mp3', resist: { electricity: 0, fire: 0.5, cold: 0.5, acid: 0.5 } },   // AUGUST of the Illneas Defenders (hellsvengeance) — a celestial GUNSLINGER dual-wielding his golden pistols "Hark the Herald Angel Kills," two shots a round
  aasimar_shotgunner:{ name: 'Nash', glyph: '💥', cr: '10',  hp: 92,  ac: 21, toHit: 15, dmgDie: 8, dmgCount: 1, dmgBonus: 6,  fort: 9,  reflex: 13, attacks: 1, ranged: true, gold: [120, 240], sr: 20, hellfire: { count: 1, dice: 4, die: 6, dc: 18, dtype: 'physical', verb: 'unloads a SPRAY of holy buckshot from HOLY NIGHT across the party', sound: '/audio/tarkov_mp153_shotgun.mp3' }, atkSound: '/audio/tarkov_mp153_shotgun.mp3', resist: { electricity: 0, fire: 0.5, cold: 0.5, acid: 0.5 } },   // NASH of the Illneas Defenders (hellsvengeance) — a celestial gun-MAGUS who scatters the party with his golden holy shotgun "Holy Night"
  angel_healer:      { name: 'Angelic Cleric',     glyph: '✚',  cr: '11',  hp: 105, ac: 24, toHit: 15, dmgDie: 8, dmgCount: 1, dmgBonus: 6,  fort: 13, reflex: 9,  attacks: 1, flying: true, gold: [140, 260], sr: 21, dr: { amount: 5, bypass: 'magic' }, resist: { electricity: 0, fire: 0.5, cold: 0.5, acid: 0.5 }, healer: { dice: 6, uses: 6 } },   // a lvl-12 cleric of the Healing domain — pours channels into her allies, greatsword only when cornered
  angel_cavalier:    { name: 'Angelic Cavalier',   glyph: '🛡️', cr: '14',  hp: 165, ac: 27, toHit: 24, dmgDie: 6, dmgCount: 2, dmgBonus: 15, fort: 15, reflex: 11, attacks: 2, flying: true, gold: [340, 600], sr: 24, dr: { amount: 10, bypass: 'magic' }, resist: { electricity: 0, fire: 0.5, cold: 0.5, acid: 0.5 }, atkSound: '/audio/sword_eviscerate2_flaming.mp3' },   // BOSS — a lvl-15 cavalier knight, a two-handed holy greatsword and a devastating charge
  chad:              { name: 'Chadriel',           glyph: '🔨', cr: '17',  hp: 210, ac: 30, toHit: 28, dmgDie: 6, dmgCount: 3, dmgBonus: 18, fort: 20, reflex: 14, attacks: 2, gold: [500, 900], sr: 26, dr: { amount: 10, bypass: 'magic' }, resist: { electricity: 0, fire: 0.5, cold: 0.5, acid: 0.5 }, healer: { dice: 6, uses: 8 } },   // BOSS — CHADRIEL, paladin champion of the Illneas Defenders (hellsvengeance): a lvl-18 aasimar PALADIN wielding THE GOLDENROD (+5 holy 2H hammer, 3d6+18 blunt w/ the +1d6 divine folded in), lay-on-hands to spare
  // ── NEW demon boss (2026-07-06) — SOIRSE, a succubus bard who charms & dominates.
  //    A fiend, not an angel: rides the 'devil' gang (Hell's forces), CHAOTIC EVIL. ──
  soirse:            { name: 'Soirse',             glyph: '💋', cr: '10',  hp: 125, ac: 23, toHit: 14, dmgDie: 6, dmgCount: 2, dmgBonus: 5,  fort: 9,  reflex: 12, attacks: 2, flying: true, gold: [200, 400], sr: 18, dr: { amount: 10, bypass: 'magic' }, resist: { electricity: 0, fire: 0.5, cold: 0.5, acid: 0.5, poison: 0 }, arcane: true, caster: 'holdperson', spellDC: 20 },   // BOSS — a lvl-10 succubus bard: her Dominate/charm is modeled as Hold Person (DC 20), claws when she must
  // ── THE GLORIOUS RECLAMATION (Iomedae's good-aligned crusade, hellsvengeance) — mortal/
  //    giant champions riding with the celestial gang. GOOD-aligned (Smite Evil finds no
  //    purchase). Chen + the Fist are the two Tobias called out; the rest of the pack
  //    (Sword Knights, Silvermane, Parnoneryx the dragon…) is a future expansion. ──
  chen:              { name: 'Chen',               glyph: '🐾', cr: '13',  hp: 118, ac: 22, toHit: 9,  dmgDie: 6, dmgBonus: 2, fort: 11, reflex: 13, will: 13, attacks: 1, gold: [300, 560], arcane: true, spellDC: 22, summon: { pool: ['dire_bear', 'dire_boar', 'blood_caimon', 'dire_ape', 'winter_wolf'], count: '1d2', uses: 3, summonNote: '{name} traces a summoning sigil — {list} answer the call and CHARGE onto the field!', sound: '/audio/enemy_yak.mp3' } },   // BOSS — half-elf CONJURER 14 of the Glorious Reclamation: she calls GREAT BEASTS (dire bears/boars/apes, blood caimans) to fight for her and blasts with arcane fire. NG — Smite finds no purchase.
  fist_of_iomedae:   { name: 'Fist of Iomedae',    glyph: '👊', cr: '16',  hp: 230, ac: 29, toHit: 27, dmgDie: 10, dmgCount: 2, dmgBonus: 18, fort: 18, reflex: 17, will: 18, attacks: 4, evasion: true, gold: [420, 760], healer: { dice: 3, uses: 2 }, hellfire: { count: 3, dice: 6, die: 6, dc: 24, dtype: 'physical', verb: 'STOMPS the earth — a shockwave hammers the whole party', sound: '/audio/weapon_blunt.mp3' }, atkSounds: MONK_SFX },   // BOSS — a CLOUD GIANT champion (Monk 12/Paladin 3, STR 38): a flurry of house-sized fists (2d10+18 ×4) + a ground-shaking STOMP, Evasion, Lay on Hands. LN — Smite finds no purchase.
  // ── THE GLORIOUS RECLAMATION — the rank-and-file order + its champions (gang 'reclamation').
  //    All good-aligned (Smite finds no purchase). The three SWORD KNIGHTS are a knightly RANK —
  //    several per room. Bosses: Graxus, Parnoneryx (a gold dragon), Sevestra, + Chen & the Fist above. ──
  sword_knight_4th:  { name: '4th Sword Knight',   glyph: '🏹', cr: '10',  hp: 95,  ac: 20, toHit: 13, dmgDie: 8,  dmgBonus: 5,  fort: 12, reflex: 11, will: 16, attacks: 2, ranged: true, gold: [95, 190],  caster: 'holdperson', spellDC: 17, atkSound: '/audio/bow_shot.mp3' },   // Inquisitor 11 — a guided-longbow archer of the order; judgements + Hold Person
  sword_knight_5th:  { name: '5th Sword Knight',   glyph: '⚔️', cr: '9',   hp: 85,  ac: 21, toHit: 11, dmgDie: 8,  dmgBonus: 4,  fort: 14, reflex: 10, will: 20, attacks: 2, gold: [85, 170],  healer: { dice: 3, uses: 3 }, caster: 'holdperson', spellDC: 18 },   // Cleric 10 — battle-priest: Hold Person + big heals (auto-warded)
  sword_knight_6th:  { name: '6th Sword Knight',   glyph: '🗡️', cr: '8',   hp: 80,  ac: 21, toHit: 12, dmgDie: 6,  dmgCount: 2, dmgBonus: 8,  fort: 10, reflex: 9,  will: 11, attacks: 2, gold: [80, 160],  healer: { dice: 2, uses: 2 }, atkSound: '/audio/sword_eviscerate2_flaming.mp3' },   // Paladin 9 — a greatsword "Edging Justice" (2d6+8), Smite + Lay on Hands
  holy_gun:          { name: "Inheritor's Holy Gun", glyph: '🔫', cr: '9', hp: 78, ac: 20, toHit: 12, dmgDie: 10, dmgBonus: 5, fort: 12, reflex: 10, will: 7, attacks: 2, ranged: true, gold: [90, 180], healer: { dice: 2, uses: 1 }, atkSound: '/audio/rifle_longue_carabine.mp3' },   // Gunslinger 5 / Paladin 4 — a holy MUSKET "Godsteel," two shots + a lay-on-hands
  silvermane:        { name: 'Silvermane',         glyph: '🦁', cr: '5',   hp: 62,  ac: 16, toHit: 10, dmgDie: 6,  dmgCount: 2, dmgBonus: 6,  fort: 9,  reflex: 8,  will: 3,  attacks: 3, gold: [44, 95],   atkSound: '/audio/enemy_yak.mp3' },   // a LIONESS animal companion of the Reclamation — a pounce of claw/claw/bite
  graxus:            { name: 'Knight Commander Graxus Phand', glyph: '🔨', cr: '14', hp: 185, ac: 27, toHit: 22, dmgDie: 8, dmgCount: 2, dmgBonus: 14, fort: 20, reflex: 12, will: 21, attacks: 3, gold: [340, 620], healer: { dice: 5, uses: 6 }, caster: 'holdperson', spellDC: 20 },   // BOSS — Warpriest 15 (STR 24): sacred-weapon smashes (2d8+14), Blessing of War, big channels (auto-warded)
  parnoneryx:        { name: 'Parnoneryx',         glyph: '🐉', cr: '15',  hp: 340, ac: 32, toHit: 30, dmgDie: 8, dmgCount: 2, dmgBonus: 16, fort: 22, reflex: 11, will: 20, attacks: 3, flying: true, gold: [400, 720], arcane: true, sr: 26, dr: { amount: 10, bypass: 'magic' }, resist: { fire: 0, cold: 0.5, acid: 0.5 }, healer: { dice: 4, uses: 3 }, hellfire: { count: 3, dice: 12, die: 8, dc: 24, dtype: 'fire', verb: 'exhales a ROARING GOUT of DRAGONFIRE over the party', sound: '/audio/spell_hellfire.mp3' }, atkSound: '/audio/sword_eviscerate2_flaming.mp3' },   // BOSS — a GOLD DRAGON (18 HD, LG): bite/claw/wing (2d8+16) + a fire-breath, full arcane/divine, fire-immune, on the wing
  sevestra:          { name: 'Sevestra Hanail',    glyph: '🏹', cr: '15',  hp: 178, ac: 26, toHit: 24, dmgDie: 8,  dmgBonus: 10, fort: 16, reflex: 14, will: 15, attacks: 3, ranged: true, gold: [380, 700], healer: { dice: 3, uses: 2 }, atkSound: '/audio/bow_silent_hits.mp3' },   // BOSS — Paladin 5 / Cavalier 12: her holy bow "Heavenly Arc," a rain of blessed arrows + Lay on Hands
};
// PF1 BODY PLANS — size category + leg count per monster (used by the trip rules:
// +4 to trip defense per leg beyond two; you can't trip a foe more than ONE size
// larger than you; legs:0 = can't be tripped at all — oozes, shadows, amorphous
// things). Anything not listed defaults to Medium biped. Merged onto MON below.
const SIZE_RANK = { F: -4, D: -3, T: -2, S: -1, M: 0, L: 1, H: 2, G: 3, C: 4 };
const SIZE_NAME = { F: 'Fine', D: 'Diminutive', T: 'Tiny', S: 'Small', M: 'Medium', L: 'Large', H: 'Huge', G: 'Gargantuan', C: 'Colossal' };
const MON_BODY = {
  dire_rat: { size: 'S', legs: 4 }, giant_centipede: { size: 'M', legs: 8 },
  goblin: { size: 'S' }, kobold: { size: 'S' }, kobold_spearman: { size: 'S' }, kobold_shaman: { size: 'S' },
  monk_puff: { size: 'S' }, monk_kobold: { size: 'S' }, monk_kobold_big: { size: 'S' },
  kobold_rogue: { size: 'S' }, goblin_rogue: { size: 'S' }, goblin_shaman: { size: 'S' }, goblin_barbarian: { size: 'S' },
  giant_spider: { size: 'M', legs: 8 }, shadow: { legs: 0 },                       // incorporeal — nothing to sweep
  gray_ooze: { legs: 0 }, gibbering_mouther: { legs: 0 },                          // amorphous
  ogre: { size: 'L' }, ettin: { size: 'L' }, dire_ape: { size: 'L' }, skeletal_ogre: { size: 'L' },
  dire_boar: { size: 'L', legs: 4 }, winter_wolf: { size: 'L', legs: 4 }, blood_caimon: { size: 'L', legs: 4 },
  dire_bear: { size: 'L', legs: 4 }, chimera: { size: 'L', legs: 4 }, basilisk: { size: 'M', legs: 8 },
  ettercap: { size: 'M' }, harpy: { size: 'M' }, gargoyle: { size: 'M' }, minotaur: { size: 'L' },
  wood_golem: { size: 'L' }, bog_brute: { size: 'L' }, hill_giant: { size: 'L' }, stone_giant: { size: 'L' },
  brass_golem: { size: 'L' }, barbed_devil: { size: 'L' }, abyssal_horror: { size: 'L', legs: 0 },   // a roil of tentacles
  // Hell's Legions + the Heavenly Host: imps/accusers are Tiny flyers; the bigger
  // devils are Large; the Lillend is a Large legless serpent-angel.
  imp: { size: 'T' }, accuser_devil: { size: 'T' }, bone_devil: { size: 'L' },
  horned_devil: { size: 'L' }, pit_fiend: { size: 'L' }, lillend_azata: { size: 'L', legs: 0 },
  medusa_archer: { size: 'M' }, medusa_swashbuckler: { size: 'M' }, medusa_sorceress: { size: 'M' }, vampire: { size: 'M' }, lich: { size: 'M' },
  // The vampire court / infernal court are classed humanoid shapes (Medium bipeds —
  // the default — so no entries needed); the dragons are Large quadrupeds.
  black_dragon: { size: 'L', legs: 4 }, void_dragon: { size: 'L', legs: 4 },
  // The machines: drones hover/roll (legs 0 — nothing to trip), tanks ride
  // treads or four legs, the big frames are Huge.
  drone_rhoomba: { size: 'T', legs: 0 }, drone_collector: { legs: 0 }, drone_stinger: { legs: 0 },
  drone_repair: { legs: 0 }, gearghost: { size: 'L', legs: 4 },
  gearsman_juggernaut: { size: 'H' }, mecha_railgun: { size: 'H', legs: 0 },
  mecha_repeater: { size: 'H', legs: 4 }, gearsman_scraper: { size: 'H' },
  mecha_warden: { size: 'H' }, overlord: { size: 'L' },
  // Shackles: charau-ka are Small apes; Ikualo'a is a Huge biped tyrant-lizard.
  charauka_warrior: { size: 'S' }, charauka_stepper: { size: 'S' }, charauka_mancer: { size: 'S' },
  ikualoa: { size: 'H' },
  brogwort: { size: 'H' },   // athach
  rivozair: { size: 'H', legs: 4 },   // devil-bound blue dragon
};
for (const [k, b] of Object.entries(MON_BODY)) if (MON[k]) Object.assign(MON[k], b);
// ── ENCOUNTER GANGS ── rooms spawn THEMED warbands: the first creature picked
// sets the room's gang and the rest of the budget fills from that pool, so
// vampires run with the restless dead, goblins with goblinoid warbands, and
// the weird monstrous horrors (minotaur, chimera, oozes…) prowl together.
// A monster may run with several gangs (ogres muscle for goblin tribes AND
// giant clans; kobolds serve dragons); anything UNLISTED is a wildcard that
// can wander into any room. The gang filter always falls back to "anyone"
// before letting a room come up empty or under-budget.
const MON_GANGS = {
  // the warrens — goblin & kobold tribes (with their kennel vermin)
  goblin: ['goblinoid'], goblin_rogue: ['goblinoid'], goblin_shaman: ['goblinoid'], goblin_barbarian: ['goblinoid'],
  kobold: ['kobold'], kobold_spearman: ['kobold'], kobold_shaman: ['kobold'], kobold_rogue: ['kobold'],
  dire_rat: ['goblinoid', 'kobold', 'beast'], giant_centipede: ['kobold', 'beast'], giant_spider: ['kobold', 'beast', 'horror'],
  // monks: Puff runs with goblins, the kobold monks with kobold warrens; the
  // Chelish agents serve Hell (devil/Thrune); the rest are wildcards (unlisted).
  monk_puff: ['goblinoid'], monk_kobold: ['kobold'], monk_kobold_big: ['kobold'],
  monk_redactor: ['devil'], monk_redactor2: ['devil'], monk_sailor: ['devil'],
  // the restless dead — vampires mix with every other undead; the Whispering
  // Way cultist herds them
  skeleton: ['undead'], zombie: ['undead'], ghoul: ['undead'], ghoul_crusader: ['undead'], shadow: ['undead'],
  wight: ['undead'], fire_skeleton: ['undead'], skeletal_champion: ['undead'], skeletal_ogre: ['undead'], cultist: ['undead'],
  ww_initiate: ['undead'], ww_knife: ['undead'], ww_gravecaller: ['undead'], ww_bladebound: ['undead'],
  ww_necromancer: ['undead'], ww_slayer: ['undead'], ww_deathpriest: ['undead'], ww_deathblade: ['undead'],
  ww_archnecromancer: ['undead'],
  lich: ['undead'], vampire: ['undead'], vampire_spawn: ['undead'],
  vamp_knight: ['undead'], vamp_inquisitor: ['undead'], vamp_rogue: ['undead'], vamp_scout: ['undead'],
  vamp_warrior: ['undead'], vamp_bodyguard: ['undead'], vamp_priest: ['undead'], vamp_assassin: ['undead'],
  vamp_nightguard: ['undead'], vamp_noble: ['undead'], vamp_techwitch: ['undead'],
  // beasts of the wild
  dire_ape: ['beast'], dire_boar: ['beast'], winter_wolf: ['beast'],
  blood_caimon: ['beast'], dire_bear: ['beast'],
  // aberrations & horrors — the weird monstrous things
  gray_ooze: ['horror'], gibbering_mouther: ['horror'], abyssal_horror: ['horror'], bog_brute: ['horror'],
  minotaur: ['horror'], chimera: ['horror'], basilisk: ['horror'],
  medusa_archer: ['medusa'], medusa_swashbuckler: ['medusa'], medusa_sorceress: ['medusa'],
  ettercap: ['horror'], harpy: ['horror'], harpy_sorcerer: ['horror'],
  gargoyle: ['construct', 'horror'],
  // the big folk — ogres also muscle for goblin warbands
  ogre: ['giant', 'goblinoid'], ettin: ['giant'], hill_giant: ['giant'], stone_giant: ['giant'],
  // constructs stand guard together (Zernibeth marches with the Technic League's machines)
  wood_golem: ['construct'], brass_golem: ['construct'], zernibeth: ['construct'],
  // the Numerian robots (Iron Gods) — one machine gang with the golems
  drone_rhoomba: ['construct'], drone_collector: ['construct'], gearsman_mk1: ['construct'],
  drone_stinger: ['construct'], drone_repair: ['construct'], gearsman_pugilist: ['construct'],
  gearghost: ['construct', 'undead'], gearsman_gunslinger: ['construct'], gearsman_sniper: ['construct'],
  gearsman_riot: ['construct'], gearsman_harvester: ['construct'], gearsman_juggernaut: ['construct'],
  mecha_railgun: ['construct'], mecha_repeater: ['construct'], gearsman_scraper: ['construct'],
  mecha_warden: ['construct'], overlord: ['construct'],
  // the Shackles — pirate crews sail together; the Fungal dead crew with
  // pirates AND the restless dead; sea-devils and ape-men raid as warbands
  shackles_lubber: ['pirate'], shackles_buccaneer: ['pirate'], shackles_scallywag: ['pirate'],
  shackles_marine: ['pirate'], shackles_seacaster: ['pirate'], shackles_swashbuckler: ['pirate'],
  shackles_officer: ['pirate'], bentbeak_charney: ['pirate'], captain_maris: ['pirate'],
  fungal_pirate: ['pirate', 'undead'], fungal_oracle: ['pirate', 'undead'], fungal_captain: ['pirate', 'undead'],
  sahuagin_scout: ['sahuagin'], sahuagin_ranger: ['sahuagin'], sahuagin_rager: ['sahuagin'], sahuagin_shaman: ['sahuagin'], sahuagin_prince: ['sahuagin'],
  charauka_warrior: ['charauka'], charauka_stepper: ['charauka'], charauka_mancer: ['charauka'],
  ikualoa: ['charauka'], captain_thrune: ['pirate', 'devil'],
  // the infernal court — devils and the Thrune villains who serve Hell
  barbed_devil: ['devil'], devil_swordsman: ['devil'], devil_samurai: ['devil'], devil_rogue: ['devil'],
  bomb_devil: ['devil'], barzillai: ['devil'], abrogail: ['devil'], rivozair: ['devil', 'dragon'],
  // Hell's Legions join the infernal 'devil' gang (fill the low-mid CR tier).
  imp: ['devil'], accuser_devil: ['devil'], erinyes: ['devil'], bone_devil: ['devil'],
  horned_devil: ['devil'], pit_fiend: ['devil'],
  // The Heavenly Host — their OWN gang 'celestial'. Angels ride only with angels:
  // they never share a room with devils or the undead (one gang per room).
  hound_archon: ['celestial'], bralani_azata: ['celestial'], lillend_azata: ['celestial'],
  movanic_deva: ['celestial'], ghaele_azata: ['celestial'], astral_deva: ['celestial'],
  angel_bro: ['celestial'], aasimar_gunslinger: ['celestial'], aasimar_shotgunner: ['celestial'],
  angel_healer: ['celestial'], angel_cavalier: ['celestial'], chad: ['celestial'],
  master_uke: ['celestial'],   // a mortal LG champion of good — rides with the Heavenly Host (smite-exempt)
  // THE GLORIOUS RECLAMATION — its own good-aligned gang (Iomedae's crusade rides together, not with the raw Heavenly Host).
  chen: ['reclamation'], fist_of_iomedae: ['reclamation'],
  sword_knight_4th: ['reclamation'], sword_knight_5th: ['reclamation'], sword_knight_6th: ['reclamation'],
  holy_gun: ['reclamation'], silvermane: ['reclamation'], graxus: ['reclamation'],
  parnoneryx: ['reclamation'], sevestra: ['reclamation'],
  soirse: ['devil'],   // a succubus among Hell's forces (fiends ride together for gameplay)
  // dragons — kobold warrens famously serve them
  black_dragon: ['dragon', 'kobold'], void_dragon: ['dragon', 'kobold'],
  // ex-PC bosses: Blackout stalks with the Numerian machines; Ragh muscles
  // with the big folk and the goblinoid warbands he bullies
  blackout: ['construct'], ragh: ['giant', 'goblinoid'],
  // Palace Uniques rule Numeria (machine minions); the CC canon lead the dead
  black_sovereign: ['construct'], amalokla: ['undead', 'construct'], brogwort: ['giant'],
  auren_vrood: ['undead'], vorkstag: ['undead'], tar_baphon: ['undead'],
};
// Real token art from the Foundry library (public/dungeon/monsters/). dire_rat
// has no token in the library, so it falls back to its emoji glyph.
const MON_ART = {
  dire_rat: 'dire_rat',
  kobold_spearman: 'kobold_spearman', kobold_shaman: 'kobold_shaman', kobold_rogue: 'kobold_rogue',
  giant_centipede: 'centipede', goblin: 'goblin', goblin_barbarian: 'goblin', kobold: 'kobold', skeleton: 'skeleton',
  goblin_rogue: 'goblin_rogue', goblin_shaman: 'goblin_shaman',   // real tokens at last (Commando + cleric-priest) — were emoji-only
  giant_spider: 'spider', zombie: 'zombie', ghoul: 'ghoul', cultist: 'cultist',
  // Undead with fresh Foundry token art (were emoji-only): a burning skull,
  // a fanged vampire lord, and a skeletal lich in his mitre.
  fire_skeleton: 'fire_skeleton', vampire: 'vampire', lich: 'lich', skeletal_ogre: 'skeletal_ogre',
  gray_ooze: 'ooze', skeletal_champion: 'skeletal_champion', shadow: 'shadow', wight: 'wight',
  ghoul_crusader: 'ghoul_crusader', gibbering_mouther: 'gibbering_mouther', ogre: 'ogre', ettin: 'ettin',
  brass_golem: 'brass_golem', barbed_devil: 'barbed_devil',
  // diversity pack (dire_bear sets its .webp art inline, so it's not listed here)
  dire_ape: 'dire_ape', ettercap: 'ettercap', dire_boar: 'dire_boar', harpy: 'harpy',
  gargoyle: 'gargoyle', minotaur: 'minotaur', basilisk: 'basilisk', winter_wolf: 'winter_wolf',
  wood_golem: 'wood_golem', bog_brute: 'swamp_horror', chimera: 'chimera', hill_giant: 'hill_giant',
  medusa_archer: 'medusa_archer', medusa_swashbuckler: 'medusa_swashbuckler', medusa_sorceress: 'medusa_sorceress', stone_giant: 'stone_giant', abyssal_horror: 'abyssal_horror',
  // The vampire court, Technic League & Thrune villains, the infernal court, and
  // dragons (Abrogail is a .png — her art is set inline on the MON entry).
  vampire_spawn: 'vampire_spawn', vamp_knight: 'vamp_knight', vamp_inquisitor: 'vamp_inquisitor',
  vamp_rogue: 'vamp_rogue', vamp_scout: 'vamp_scout', vamp_warrior: 'vamp_warrior',
  vamp_bodyguard: 'vamp_bodyguard', vamp_priest: 'vamp_priest', vamp_assassin: 'vamp_assassin',
  vamp_nightguard: 'vamp_nightguard', vamp_noble: 'vamp_noble', vamp_techwitch: 'vamp_techwitch',
  zernibeth: 'zernibeth', barzillai: 'barzillai',
  // The named monks (portrait + token paired from Foundry).
  monk_shaolin: 'monk_shaolin', monk_sailor: 'monk_sailor', monk_greenbriar: 'monk_greenbriar',
  monk_redactor: 'monk_redactor', monk_redactor2: 'monk_redactor2', monk_vakra: 'monk_vakra',
  monk_beastmode: 'monk_beastmode', monk_puff: 'monk_puff', monk_kobold: 'monk_kobold', monk_kobold_big: 'monk_kobold_big',
  // The Whispering Way cell — plague-masked tokens from carrion_crown/whisperingway.
  ww_initiate: 'ww_initiate', ww_knife: 'ww_knife', ww_gravecaller: 'ww_gravecaller',
  ww_bladebound: 'ww_bladebound', ww_necromancer: 'ww_necromancer', ww_slayer: 'ww_slayer',
  ww_deathpriest: 'ww_deathpriest', ww_deathblade: 'ww_deathblade', ww_archnecromancer: 'ww_archnecromancer',
  devil_swordsman: 'devil_swordsman', devil_samurai: 'devil_samurai', devil_rogue: 'devil_rogue',
  bomb_devil: 'bomb_devil', black_dragon: 'black_dragon', void_dragon: 'void_dragon',
  harpy_sorcerer: 'harpy_sorcerer',
  // Hell's Legions + the Heavenly Host (real Foundry tokens from the cheliax /
  // angelic character libraries).
  imp: 'imp', accuser_devil: 'accuser_devil', erinyes: 'erinyes', bone_devil: 'bone_devil',
  horned_devil: 'horned_devil', pit_fiend: 'pit_fiend',
  hound_archon: 'hound_archon', bralani_azata: 'bralani_azata', lillend_azata: 'lillend_azata',
  movanic_deva: 'movanic_deva', ghaele_azata: 'ghaele_azata', astral_deva: 'astral_deva',
  angel_bro: 'angel_bro', aasimar_gunslinger: 'aasimar_gunslinger', aasimar_shotgunner: 'aasimar_shotgunner',
  angel_healer: 'angel_healer', angel_cavalier: 'angel_cavalier', chad: 'chad', soirse: 'soirse',
  master_uke: 'master_uke', chen: 'chen', fist_of_iomedae: 'fist_of_iomedae',
  sword_knight_4th: 'sword_knight_4th', sword_knight_5th: 'sword_knight_5th', sword_knight_6th: 'sword_knight_6th',
  holy_gun: 'holy_gun', silvermane: 'silvermane', graxus: 'graxus', parnoneryx: 'parnoneryx', sevestra: 'sevestra',
  blood_caimon: 'blood_caimon',
  // The Numerian robots — tokens straight from the Iron Gods Foundry world.
  drone_rhoomba: 'drone_rhoomba', drone_collector: 'drone_collector', gearsman_mk1: 'gearsman_mk1',
  drone_stinger: 'drone_stinger', drone_repair: 'drone_repair', gearsman_pugilist: 'gearsman_pugilist',
  gearghost: 'gearghost', gearsman_gunslinger: 'gearsman_gunslinger', gearsman_sniper: 'gearsman_sniper',
  gearsman_riot: 'gearsman_riot', gearsman_harvester: 'gearsman_harvester', gearsman_juggernaut: 'gearsman_juggernaut',
  mecha_railgun: 'mecha_railgun', mecha_repeater: 'mecha_repeater', gearsman_scraper: 'gearsman_scraper',
  mecha_warden: 'mecha_warden', overlord: 'overlord',
  // The Shackles — tokens from the 03-shackletastic Foundry world.
  shackles_lubber: 'shackles_lubber', shackles_buccaneer: 'shackles_buccaneer', shackles_scallywag: 'shackles_scallywag',
  shackles_marine: 'shackles_marine', shackles_seacaster: 'shackles_seacaster', shackles_swashbuckler: 'shackles_swashbuckler',
  shackles_officer: 'shackles_officer', bentbeak_charney: 'bentbeak_charney', captain_maris: 'captain_maris',
  fungal_pirate: 'fungal_pirate', fungal_oracle: 'fungal_oracle', fungal_captain: 'fungal_captain',
  sahuagin_scout: 'sahuagin_scout', sahuagin_ranger: 'sahuagin_ranger', sahuagin_rager: 'sahuagin_rager', sahuagin_shaman: 'sahuagin_shaman',
  sahuagin_prince: 'sahuagin_prince', charauka_warrior: 'charauka_warrior', charauka_stepper: 'charauka_stepper',
  charauka_mancer: 'charauka_mancer', ikualoa: 'ikualoa', captain_thrune: 'captain_thrune',
  blackout: 'blackout', ragh: 'ragh',
  black_sovereign: 'black_sovereign', amalokla: 'amalokla', brogwort: 'brogwort',
  auren_vrood: 'auren_vrood', vorkstag: 'vorkstag', tar_baphon: 'tar_baphon',
  rivozair: 'rivozair',
};
for (const [k, name] of Object.entries(MON_ART)) if (MON[k]) MON[k].art = `/dungeon/monsters/${name}.webp`;

// PF1 creature TYPE per monster — drives the Inquisitor's BANE (declared against
// ONE type; the bane bonus applies only to foes of that type). Every MON key
// should be covered; anything missed defaults to 'humanoid' below.
const MON_TYPE = {
  dire_rat: 'animal', dire_ape: 'animal', dire_boar: 'animal', blood_caimon: 'animal', dire_bear: 'animal',
  giant_centipede: 'vermin', giant_spider: 'vermin',
  goblin: 'humanoid', goblin_rogue: 'humanoid', goblin_shaman: 'humanoid', goblin_barbarian: 'humanoid',
  kobold: 'humanoid', kobold_spearman: 'humanoid', kobold_shaman: 'humanoid', kobold_rogue: 'humanoid',
  cultist: 'humanoid',
  monk_shaolin: 'humanoid', monk_sailor: 'humanoid', monk_greenbriar: 'humanoid', monk_redactor: 'humanoid',
  monk_redactor2: 'humanoid', monk_vakra: 'humanoid', monk_beastmode: 'humanoid', monk_puff: 'humanoid',
  monk_kobold: 'humanoid', monk_kobold_big: 'humanoid',
  skeleton: 'undead', zombie: 'undead', ghoul: 'undead', ghoul_crusader: 'undead', skeletal_champion: 'undead',
  shadow: 'undead', fire_skeleton: 'undead', wight: 'undead', vampire: 'undead', lich: 'undead', skeletal_ogre: 'undead',
  ogre: 'giant', ettin: 'giant', hill_giant: 'giant', stone_giant: 'giant',
  harpy: 'monstrous humanoid', minotaur: 'monstrous humanoid',
  gargoyle: 'construct',
  medusa_archer: 'monstrous humanoid', medusa_swashbuckler: 'monstrous humanoid', medusa_sorceress: 'monstrous humanoid',
  basilisk: 'magical beast', winter_wolf: 'magical beast', chimera: 'magical beast',
  ettercap: 'aberration', gibbering_mouther: 'aberration', bog_brute: 'aberration', abyssal_horror: 'aberration',
  wood_golem: 'construct', brass_golem: 'construct',
  drone_rhoomba: 'construct', drone_collector: 'construct', gearsman_mk1: 'construct',
  drone_stinger: 'construct', drone_repair: 'construct', gearsman_pugilist: 'construct',
  gearghost: 'construct', gearsman_gunslinger: 'construct', gearsman_sniper: 'construct',
  gearsman_riot: 'construct', gearsman_harvester: 'construct', gearsman_juggernaut: 'construct',
  mecha_railgun: 'construct', mecha_repeater: 'construct', gearsman_scraper: 'construct',
  mecha_warden: 'construct', overlord: 'construct',
  // Shackles: pirates are humans; sahuagin are MONSTROUS humanoids (aquatic —
  // Hold Person correctly refuses them); charau-ka are Small humanoids (RAW);
  // the Fungal are undead; Ikualo'a is an animal.
  shackles_lubber: 'humanoid', shackles_buccaneer: 'humanoid', shackles_scallywag: 'humanoid',
  shackles_marine: 'humanoid', shackles_seacaster: 'humanoid', shackles_swashbuckler: 'humanoid',
  shackles_officer: 'humanoid', bentbeak_charney: 'humanoid', captain_maris: 'humanoid', captain_thrune: 'humanoid',
  blackout: 'humanoid', ragh: 'humanoid',
  black_sovereign: 'humanoid', vorkstag: 'humanoid', auren_vrood: 'humanoid',
  amalokla: 'undead', tar_baphon: 'undead', brogwort: 'giant',
  charauka_warrior: 'humanoid', charauka_stepper: 'humanoid', charauka_mancer: 'humanoid',
  sahuagin_scout: 'monstrous humanoid', sahuagin_ranger: 'monstrous humanoid', sahuagin_rager: 'monstrous humanoid',
  sahuagin_shaman: 'monstrous humanoid', sahuagin_prince: 'monstrous humanoid',
  fungal_pirate: 'undead', fungal_oracle: 'undead', fungal_captain: 'undead',
  ikualoa: 'animal',
  gray_ooze: 'ooze',
  // The infernal court are DEVILS (outsiders) and the dragons are DRAGONS —
  // they were missing here and defaulted to 'humanoid', so a Bane: Humanoids
  // inquisitor was shredding dragons while Bane: Outsiders did nothing.
  barbed_devil: 'outsider', devil_swordsman: 'outsider', devil_samurai: 'outsider',
  devil_rogue: 'outsider', bomb_devil: 'outsider',
  // Hell's Legions + the Heavenly Host are all OUTSIDERS (Bane: Outsiders bites them).
  imp: 'outsider', accuser_devil: 'outsider', erinyes: 'outsider', bone_devil: 'outsider',
  horned_devil: 'outsider', pit_fiend: 'outsider',
  hound_archon: 'outsider', bralani_azata: 'outsider', lillend_azata: 'outsider',
  movanic_deva: 'outsider', ghaele_azata: 'outsider', astral_deva: 'outsider',
  angel_bro: 'outsider', aasimar_gunslinger: 'outsider', aasimar_shotgunner: 'outsider',
  angel_healer: 'outsider', angel_cavalier: 'outsider', chad: 'outsider', soirse: 'outsider',
  black_dragon: 'dragon', void_dragon: 'dragon', rivozair: 'dragon', parnoneryx: 'dragon',
  silvermane: 'animal',   // a lioness — animal type (auto-natural, mind-affecting no-ops on her)
  harpy_sorcerer: 'monstrous humanoid',
};
for (const [k, t] of Object.entries(MON_TYPE)) if (MON[k]) MON[k].type = t;
for (const k of Object.keys(MON)) if (!MON[k].type) MON[k].type = 'humanoid';   // default → Bane always has a target

// ── Energy resistances / vulnerabilities ────────────────────────────────────
// A damage MULTIPLIER per energy type: 0 = immune, 0.5 = resistant (half),
// 1.5 = vulnerable (takes 50% more). Physical (B/S/P) and untyped damage are
// never modified here. Most undead shrug off cold (PF1e) — a Fire Skeleton is
// the exception (made of fire: immune to its own element, vulnerable to cold).
const UNDEAD_KEYS = ['skeleton', 'skeletal_champion', 'skeletal_ogre', 'zombie', 'ghoul', 'ghoul_crusader', 'wight', 'shadow', 'fire_skeleton', 'vampire', 'lich', 'fungal_pirate', 'fungal_oracle', 'fungal_captain', 'amalokla', 'tar_baphon'];
const RESIST_BY_KEY = {
  fire_skeleton: { fire: 0, cold: 1.5 },          // burning bones: fireproof, but cold shatters them
  wood_golem:    { fire: 1.5 },                    // dry timber: catches fire easily
  winter_wolf:   { cold: 0, fire: 1.5 },           // creature of ice: immune cold, vuln fire
  vampire:       { cold: 0, electricity: 0.5 },  // user rule: vampires are IMMUNE to cold (electricity still half)
  fire_elemental: { fire: 0, cold: 1.5 },
};
// Iron Gods robot subtype: VULNERABLE to electricity (×1.5) — lightning casters
// finally get a favored prey. (The Gearghost haunt shares its kin's weakness.)
const ROBOT_KEYS = ['drone_rhoomba', 'drone_collector', 'gearsman_mk1', 'drone_stinger', 'drone_repair',
  'gearsman_pugilist', 'gearghost', 'gearsman_gunslinger', 'gearsman_sniper', 'gearsman_riot',
  'gearsman_harvester', 'gearsman_juggernaut', 'mecha_railgun', 'mecha_repeater', 'gearsman_scraper',
  'mecha_warden', 'overlord'];
for (const k of ROBOT_KEYS) {
  const r = RESIST_BY_KEY[k] || (RESIST_BY_KEY[k] = {});
  if (r.electricity == null) r.electricity = 1.5;
}
for (const k of UNDEAD_KEYS) {                      // undead are immune to cold unless told otherwise
  if (!MON[k]) continue;
  const r = RESIST_BY_KEY[k] || (RESIST_BY_KEY[k] = {});
  if (r.cold == null) r.cold = 0;
}
if (MON.gargoyle) (RESIST_BY_KEY.gargoyle = RESIST_BY_KEY.gargoyle || {}).electricity = 1.5;   // Mecha Gargoyle: Unity's cyber-construct shares the Iron Gods robot weakness
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
  // mindless machinery is true-neutral (not smite-able); the intelligent
  // machines — the Thought Harvester, the haunted Gearghost, Unity's Overlord —
  // are another story.
  drone_rhoomba: 'N', drone_collector: 'N', gearsman_mk1: 'N', drone_stinger: 'N', drone_repair: 'N',
  gearsman_pugilist: 'N', gearsman_gunslinger: 'N', gearsman_sniper: 'N', gearsman_riot: 'N',
  gearsman_juggernaut: 'N', mecha_railgun: 'N', mecha_repeater: 'N', gearsman_scraper: 'N', mecha_warden: 'N',
  gearsman_harvester: 'LE', gearghost: 'NE', overlord: 'LE',
  // the Shackles: freebooters run chaotic evil, the Chelish and the sea-devils
  // lawful evil, the Fungal dead neutral evil; the tyrant-lizard is just hungry
  shackles_lubber: 'CE', shackles_buccaneer: 'CE', shackles_scallywag: 'CE', shackles_swashbuckler: 'CE',
  shackles_officer: 'CE', bentbeak_charney: 'CE', captain_maris: 'CE', shackles_seacaster: 'CE',
  charauka_warrior: 'CE', charauka_stepper: 'CE', charauka_mancer: 'CE',
  shackles_marine: 'LE', captain_thrune: 'LE',
  sahuagin_scout: 'LE', sahuagin_ranger: 'LE', sahuagin_rager: 'LE', sahuagin_shaman: 'LE', sahuagin_prince: 'LE',
  fungal_pirate: 'NE', fungal_oracle: 'NE', fungal_captain: 'NE',
  ikualoa: 'N',
  blackout: 'NE', ragh: 'CE',
  black_sovereign: 'CN',   // enthralled, not evil — smite finds no purchase
  rivozair: 'LE',
  amalokla: 'NE', brogwort: 'CE', auren_vrood: 'NE', vorkstag: 'CE', tar_baphon: 'NE',
  // lawful evil
  kobold: 'LE', kobold_spearman: 'LE', kobold_shaman: 'LE', kobold_rogue: 'LE',
  wight: 'LE', barbed_devil: 'LE',
  medusa_archer: 'LE', medusa_swashbuckler: 'LE', medusa_sorceress: 'LE',
  // Hell's Legions — lawful evil to the last devil.
  imp: 'LE', accuser_devil: 'LE', erinyes: 'LE', bone_devil: 'LE', horned_devil: 'LE', pit_fiend: 'LE',
  // The Heavenly Host — GOOD-aligned (hero Smite Evil finds no purchase on them).
  hound_archon: 'LG', bralani_azata: 'CG', lillend_azata: 'CG',
  movanic_deva: 'NG', ghaele_azata: 'CG', astral_deva: 'LG',
  angel_bro: 'LG', aasimar_gunslinger: 'NG', aasimar_shotgunner: 'NG',
  angel_healer: 'NG', angel_cavalier: 'LG', chad: 'LG',
  master_uke: 'LG',   // the master is Lawful Good — Smite Evil finds no purchase
  chen: 'NG', fist_of_iomedae: 'LN',   // Glorious Reclamation — good/neutral, not evil → Smite finds no purchase
  sword_knight_4th: 'N', sword_knight_5th: 'NG', sword_knight_6th: 'LG', holy_gun: 'LG',
  silvermane: 'N', graxus: 'LG', parnoneryx: 'LG', sevestra: 'LG',   // all non-evil → Smite finds no purchase
  soirse: 'CE',   // succubus demon — the one EVIL fiend in this batch (Smite Evil bites her)
  // neutral evil
  goblin: 'NE', skeleton: 'NE', skeletal_champion: 'NE', skeletal_ogre: 'NE', zombie: 'NE', cultist: 'NE', ettercap: 'NE', winter_wolf: 'NE',
  goblin_barbarian: 'CE',
  // chaotic evil
  ghoul: 'CE', ghoul_crusader: 'CE', shadow: 'CE', ogre: 'CE', ettin: 'CE', minotaur: 'CE',
  hill_giant: 'CE', harpy: 'CE', gargoyle: 'CE', chimera: 'CE', abyssal_horror: 'CE',
  // monks — the Chelish agents are lawful EVIL (smite-able); the rest are the
  // disciplined LN martial artists.
  monk_redactor: 'LE', monk_redactor2: 'LE', monk_sailor: 'LE',
  monk_shaolin: 'LN', monk_greenbriar: 'LN', monk_vakra: 'LN', monk_beastmode: 'LN',
  monk_puff: 'LN', monk_kobold: 'LN', monk_kobold_big: 'LN',
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
const BOSS_KEYS = new Set(['brass_golem', 'barbed_devil', 'mecha_warden', 'overlord', 'ikualoa', 'captain_thrune',
  'zernibeth', 'abrogail',   // (always SAID boss-only — now enforced)
  'black_dragon', 'void_dragon',   // dragons are inherently everything — boss material (Tobias 2026-07-04)
  'blackout', 'ragh',   // ex-PC villains
  'black_sovereign', 'amalokla', 'brogwort',   // the Palace Uniques (Iron Gods)
  'auren_vrood', 'vorkstag', 'tar_baphon',   // Carrion Crown canon
  'barzillai', 'rivozair',   // the Thrune pair (Hell's Rebels) — boss-only, ALWAYS spawn together
  'horned_devil', 'pit_fiend',   // Hell's Legions bosses (Cornugon; the Pit Fiend is a peer of Tar-Baphon)
  'ghaele_azata', 'astral_deva',   // the Heavenly Host bosses (the knight-angel & the avenger)
  'angel_cavalier', 'chad',   // NEW celestial bosses — the cavalier-knight & CHAD the paladin champion
  'master_uke',   // the katana MASTER (gestalt paladin/monk/samurai) — a righteous LG boss
  'chen', 'fist_of_iomedae', 'graxus', 'parnoneryx', 'sevestra',   // Glorious Reclamation bosses (summoner, cloud-giant, warpriest commander, GOLD DRAGON, archer-cavalier)
  'soirse']);   // NEW demon boss — the charming succubus bard
for (const k of Object.keys(MON)) MON[k].crNum = crToNum(MON[k].cr);
const SPAWNABLE = Object.keys(MON).filter(k => !BOSS_KEYS.has(k));

// NATURAL / UNARMED fighters — claws, bite, slams, fists, tentacles: there's no
// manufactured weapon to knock away, so they CANNOT be DISARMED (Dungeon._abDisarm
// also treats animals/vermin/oozes/magical beasts/aberrations as natural by TYPE).
// Flag the monks (unarmed) and the named natural-attackers that aren't those types.
const NATURAL_KEYS = ['zombie', 'ghoul', 'ghoul_crusader', 'shadow', 'wight', 'skeletal_champion', 'skeletal_ogre', 'harpy', 'gibbering_mouther', 'abyssal_horror', 'bog_brute', 'ettercap'];
NATURAL_KEYS.push('charauka_warrior', 'bentbeak_charney', 'ikualoa',
  'amalokla', 'brogwort',   // bare knuckles, pain touch, athach limbs — nothing to disarm (the Black Sovereign now swings a SWORD — disarm away, if you dare)
  'imp', 'accuser_devil', 'bone_devil', 'pit_fiend', 'hound_archon',   // devils/archon that fight with sting/bite/claws (erinyes=bow, horned=chain, the angels=weapons → those CAN be disarmed)
  'soirse',   // the succubus rakes with claws — nothing to disarm (the gunslingers' guns & the angels' blades CAN be disarmed)
  'master_uke',   // a monk-master who flows between Hanzo Steel and open hand — an integrated arsenal, nothing to reliably disarm
  'fist_of_iomedae');   // a cloud-giant MONK — bare fists & a stomp, nothing to disarm
for (const k of Object.keys(MON)) if (k.startsWith('monk_') || NATURAL_KEYS.includes(k) || ROBOT_KEYS.includes(k) || k === 'gargoyle') MON[k].natural = true;   // robots: integrated weaponry — nothing to disarm

// ── RANGED attackers — bows & guns (Josh 2026-07-11: enemy shot SFX were inconsistent).
// Flagging `ranged` does two things: (1) the foe fires its bow/gun `atkSound` on a MISS
// too (enemyAI) — a missed shot no longer clangs like a sword whiff; (2) "an archer
// doesn't wrestle" (enemyAI _pickManeuver) — a ranged foe just shoots, never grapples.
// Every key here MUST carry a bow/gun atkSound (or atkSounds) above. Add new archers/
// gunners here so their sound stays consistent.
const RANGED_KEYS = ['medusa_archer', 'erinyes', 'bralani_azata', 'shackles_scallywag', 'shackles_marine',
  'gearsman_gunslinger', 'gearsman_sniper', 'mecha_railgun', 'mecha_repeater', 'mecha_warden',
  'blackout', 'aasimar_gunslinger', 'aasimar_shotgunner', 'sahuagin_ranger',
  'sword_knight_4th', 'holy_gun', 'sevestra'];   // Glorious Reclamation ranged: the inquisitor-archer, the holy MUSKET, Sevestra's holy bow
for (const k of RANGED_KEYS) if (MON[k]) MON[k].ranged = true;

module.exports = { MON, MON_GANGS, MON_BODY, MON_ART, MON_TYPE, RESIST_BY_KEY, ALIGN_BY_KEY, UNDEAD_KEYS, BOSS_KEYS, SPAWNABLE, SIZE_RANK, SIZE_NAME, crToNum, BRUCE_SFX, MONK_SFX };
