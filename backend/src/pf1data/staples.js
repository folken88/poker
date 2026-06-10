/**
 * The "staple" weapons offered in the weapon-choice dropdown. Each resolves to
 * the full PF1 stats from weapons.js; Unarmed Strike is added from the PF1 SRD
 * (it isn't in the Foundry weapons pack). `key` is the stable storage value.
 *
 * Players start on the Dagger at MASTERWORK quality (see combat: masterwork =
 * +1 to hit / +0 damage; a purchased +N enhancement rides on the chosen weapon).
 */
const { WEAPON_BY_NAME } = require('./weapons');

const UNARMED = { name: 'Unarmed Strike', cat: 'light', ranged: false, dmgCount: 1, dmgDie: 3, crit: 20, mult: 2, type: 'B', group: 'natural' };

// Each entry: [storageKey, foundryName, proficiencyClass]. The proficiency
// class ('simple' | 'martial' | 'exotic') drives class proficiency — wielding a
// weapon your class isn't proficient with is −4 to hit (see classes.js).
const STAPLE_DEFS = [
  ['dagger',       'Dagger',       'simple'],
  ['kukri',        'Kukri',        'martial'],   // light slashing blade (1d4, 18–20) — a rogue's off-hand
  ['shortsword',   'Shortsword',   'martial'],
  ['longsword',    'Longsword',    'martial'],
  ['greatsword',   'Greatsword',   'martial'],
  ['warhammer',    'Warhammer',    'martial'],
  ['battleaxe',    'Battle Axe',   'martial'],
  ['greataxe',     'Greataxe',     'martial'],
  ['longspear',    'Longspear',    'simple'],
  ['quarterstaff', 'Quarterstaff', 'simple'],
  ['unarmed',      null,           'simple'],   // SRD entry (UNARMED above) — everyone is proficient
  ['katana',       'Katana',       'exotic'],
  ['bastardsword', 'Bastard Sword','exotic'],   // 1d10, 19–20 — exotic one-hander; full/¾-BAB classes wield it proficiently (home-rule)
  ['scimitar',     'Scimitar',     'martial'],
  ['rapier',       'Rapier',       'martial'],
  ['glaive',       'Glaive',       'martial'],  // representative polearm
  ['whip',         'Whip',         'exotic'],
];

const STAPLE_WEAPONS = STAPLE_DEFS.map(([key, name, prof]) => {
  const w = key === 'unarmed' ? UNARMED : WEAPON_BY_NAME[String(name).toLowerCase()];
  if (!w) throw new Error(`staple weapon not found: ${name}`);
  return { key, prof, ...w };
});
const STAPLE_BY_KEY = Object.fromEntries(STAPLE_WEAPONS.map(w => [w.key, w]));
// Per-staple signature attack sounds (override the generic blunt/swing report).
const STAPLE_SOUNDS = { warhammer: '/audio/weapon_warhammer.mp3' };
for (const [k, snd] of Object.entries(STAPLE_SOUNDS)) if (STAPLE_BY_KEY[k]) STAPLE_BY_KEY[k].atkSound = snd;
const DEFAULT_WEAPON = 'dagger';

// Named NPC SIGNATURE weapons — not selectable in the dropdown, assigned to
// specific characters in db.js. `custom: true` means the wielder is always
// proficient (it's their iconic weapon). `atkSound` overrides the hit sound.
const CUSTOM_WEAPONS = {
  // Dismas's holy dragon-rifle. A firearm (1d12, ×4 crit) — he smites with it.
  rovadra: { key: 'rovadra', name: 'Rovadra', cat: 'ranged', ranged: true, dmgCount: 1, dmgDie: 12, crit: 20, mult: 4, type: 'B', group: 'firearms', prof: 'exotic', custom: true, atkSound: '/audio/rovadra_dragonrifle.mp3' },   // Dismas's holy-gun report — the dragonrifle "delay" recording (single shot)
  // Gaspar's bastard sword "Curator".
  curator: { key: 'curator', name: 'Curator', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 10, crit: 19, mult: 2, type: 'S', group: 'heavyBlades', prof: 'exotic', custom: true },
  // Danger's composite longbow (1d8, ×3) — single-shot bow report.
  longbow: { key: 'longbow', name: 'Composite Longbow', cat: 'ranged', ranged: true, dmgCount: 1, dmgDie: 8, crit: 20, mult: 3, type: 'P', group: 'bows', prof: 'martial', custom: true, atkSound: '/audio/bow_silent_hits.mp3' },   // Danger's longbow — near-silent loose, sound lands on the hit
  // Vesorianna's spectral Ghost Touch — a chilling 2d6 melee strike.
  ghosttouch: { key: 'ghosttouch', name: 'Ghost Touch', cat: '1h', ranged: false, dmgCount: 2, dmgDie: 6, crit: 20, mult: 2, type: 'B', group: 'natural', prof: 'simple', custom: true },
  // Crisp the deinonychus — a natural full attack: bite + 2 raking talons (1d6
  // each), all at full BAB (see _attackOffsets naturalAttacks). No shield.
  bite: { key: 'bite', name: 'Talons & Bite', cat: 'light', ranged: false, dmgCount: 1, dmgDie: 6, crit: 20, mult: 2, type: 'S', group: 'natural', prof: 'simple', custom: true, naturalAttacks: 3, noShield: true },
  // Rissa's claws (natural, 1d6).
  claws: { key: 'claws', name: 'Claws', cat: 'light', ranged: false, dmgCount: 1, dmgDie: 6, crit: 20, mult: 2, type: 'S', group: 'natural', prof: 'simple', custom: true },
  // Vaughan's named scimitar "Radiance" (1d6, 18–20/×2).
  radiance: { key: 'radiance', name: 'Radiance', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 6, crit: 18, mult: 2, type: 'S', group: 'bladesHeavy', prof: 'martial', custom: true },
  // Lirienne's repeating crossbow (1d8, 19–20).
  repeatingcrossbow: { key: 'repeatingcrossbow', name: 'Repeating Crossbow', cat: 'ranged', ranged: true, dmgCount: 1, dmgDie: 8, crit: 19, mult: 2, type: 'P', group: 'crossbows', prof: 'exotic', custom: true, atkSound: '/audio/crossbow.mp3' },
  // Duristan's rifle "Longue Carabine" — a heavy-hitting bolt-action .338 (2d10, ×4).
  // Single-shot: no Rapid Shot. (Key stays 'lapua' so his persisted weapon row and
  // gear history survive the rename.) Report: cyberpunk sniper crack from Foundry.
  lapua: { key: 'lapua', name: 'Longue Carabine', cat: 'ranged', ranged: true, dmgCount: 2, dmgDie: 10, crit: 20, mult: 4, type: 'P', group: 'firearms', prof: 'exotic', custom: true, boltAction: true, atkSound: '/audio/rifle_longue_carabine.mp3' },
  // Taelys's DVL-10 bolt-action sniper rifle (2d8, ×4) — silenced single shot,
  // so no Rapid Shot (she relies on Bullseye Shot + Deadly Aim instead).
  dvl: { key: 'dvl', name: 'DVL-10 Sniper Rifle', cat: 'ranged', ranged: true, dmgCount: 2, dmgDie: 8, crit: 20, mult: 4, type: 'P', group: 'firearms', prof: 'exotic', custom: true, boltAction: true, atkSound: '/audio/rifle_dvl_silenced.mp3' },
  // Ser Toche's elven curved blade — the classic PF1 DEX two-hander (1d10, 18–20):
  // finesse2h lets a DEX build drive it (to-hit AND damage, ×1.5 two-handed).
  elvencurve: { key: 'elvencurve', name: 'Elven Curved Blade', cat: '2h', ranged: false, dmgCount: 1, dmgDie: 10, crit: 18, mult: 2, type: 'S', group: 'heavyBlades', prof: 'exotic', custom: true, finesse2h: true },
  // Ulfred's named battleaxe "Voidshard" (1d8, ×3) — its own meaty axe report.
  voidshard: { key: 'voidshard', name: 'Voidshard', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 8, crit: 20, mult: 3, type: 'S', group: 'axes', prof: 'martial', custom: true, atkSound: '/audio/voidshard.mp3' },
  // Farrus Richton's TWIN battleaxes — two-weapon fighting (2 swings/turn, one
  // report), and no shield (dual-wield → no shield AC).
  twoaxes: { key: 'twoaxes', name: 'Twin Battleaxes', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 8, crit: 20, mult: 3, type: 'S', group: 'axes', prof: 'martial', custom: true, dual: true, noShield: true, atkSound: '/audio/weapon_double_axe.mp3' },
  // Lou Candlebean's GNOME HOOKED HAMMER — a DOUBLE weapon she two-weapon fights
  // with (2 swings/turn, one report; no shield). Hammer head: 1d8 B, ×3 crit.
  gnomehammer: { key: 'gnomehammer', name: 'Gnome Hooked Hammer', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 8, crit: 20, mult: 3, type: 'B', group: 'hammers', prof: 'exotic', custom: true, dual: true, noShield: true, atkSound: '/audio/weapon_warhammer.mp3' },
  // Tokala's CHAINSAW — a roaring 3d6 slashing two-hander that crits on an 18.
  chainsaw: { key: 'chainsaw', name: 'Chainsaw', cat: '2h', ranged: false, dmgCount: 3, dmgDie: 6, crit: 18, mult: 2, type: 'S', group: 'axes', prof: 'exotic', custom: true, atkSound: '/audio/weapon_chainsaw.mp3' },
  // The DRUID's Shillelagh — a club a druid empowers with nature's strength
  // (1d10, ×2, blunt). Simple/always-proficient; the druid's signature weapon.
  shillelagh: { key: 'shillelagh', name: 'Shillelagh', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 10, crit: 20, mult: 2, type: 'B', group: 'clubs', prof: 'simple', custom: true, atkSound: '/audio/weapon_blunt.mp3' },
  // ── WILD SHAPE natural-attack weapons (set on a member while a form is active;
  // the member's base weapon is restored when the form drops). All are natural
  // (noShield), strike at full BAB per attack (naturalAttacks), and play a meaty
  // bite/slam report. ──
  form_tiger:      { key: 'form_tiger',      name: 'Tiger Claws & Bite',    cat: 'light', ranged: false, dmgCount: 1, dmgDie: 8,  crit: 20, mult: 2, type: 'S', group: 'natural', prof: 'simple', custom: true, naturalAttacks: 3, noShield: true, atkSound: '/audio/enemy_yak.mp3' },
  form_bear:       { key: 'form_bear',       name: 'Bear Claws & Bite',     cat: 'light', ranged: false, dmgCount: 1, dmgDie: 8,  crit: 20, mult: 2, type: 'S', group: 'natural', prof: 'simple', custom: true, naturalAttacks: 3, noShield: true, atkSound: '/audio/enemy_yak.mp3' },
  // Rissa — the Beast of Lepidstadt: huge slams, can swat airborne foes (reachFly).
  form_beast:      { key: 'form_beast',      name: 'Beast Slams',           cat: '2h',    ranged: false, dmgCount: 1, dmgDie: 10, crit: 20, mult: 2, type: 'B', group: 'natural', prof: 'simple', custom: true, naturalAttacks: 2, noShield: true, reachFly: true, atkSound: '/audio/weapon_blunt.mp3' },
  // Rissa — Promethean horror: FOUR tentacle strikes, 15' reach (hits flyers), and
  // every hit GRAPPLES the foe (grappled + helpless until it breaks free).
  form_promethean: { key: 'form_promethean', name: 'Promethean Tentacles',  cat: 'light', ranged: false, dmgCount: 1, dmgDie: 8,  crit: 20, mult: 2, type: 'B', group: 'natural', prof: 'simple', custom: true, naturalAttacks: 4, noShield: true, reachFly: true, grapple: true, atkSound: '/audio/slorr_grapple.mp3' },
};

// Combined lookup used by combat.weaponOf — staples + custom signature weapons.
const WEAPON_LOOKUP = { ...STAPLE_BY_KEY, ...CUSTOM_WEAPONS };

module.exports = { STAPLE_WEAPONS, STAPLE_BY_KEY, DEFAULT_WEAPON, CUSTOM_WEAPONS, WEAPON_LOOKUP };
