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
  // Kai Ginn's polearm "Bastard's Blade" — functions as a PF1 FAUCHARD (1d10,
  // 18-20/×2, reach) and Kai is trained with it (prof martial here — it's HIS
  // signature blade). impCritAt 9: Improved Critical folds in at level 9+
  // (threat 15-20). It's in FINESSE_KEYS (character.js + Dungeon.js): despite
  // being a STR polearm, this blade rides Kai's DEX 20 for attack AND damage.
  bastardsblade: { key: 'bastardsblade', name: "Bastard's Blade", cat: '2h', ranged: false, dmgCount: 1, dmgDie: 10, crit: 18, mult: 2, type: 'S', group: 'polearms', prof: 'martial', custom: true, special: { keen: true }, reachFly: true, impCritAt: 9 },
  // Azwraith's FAUCHARD — a reach polearm (1d10, 18-20/×2). The tool of a trip-fighter:
  // reach threatens a wide arc, and his Trip sweeps foes off their feet (prone + lost turn
  // + a FREE attack — his reach/AoO game). NO built-in keen — his Improved Critical
  // (fighter, L8 per PF1) does the widening. reachFly: the long haft plucks a low flyer down.
  fauchard: { key: 'fauchard', name: 'Fauchard', cat: '2h', ranged: false, dmgCount: 1, dmgDie: 10, crit: 18, mult: 2, type: 'S', group: 'polearms', prof: 'martial', custom: true, reachFly: true },
  // Azwraith's TON BOKIRI — a demon-infused legendary fauchard that constantly whispers "KUROSE"
  // (kill). A reach polearm (threatens AoO like any polearm), UNHOLY + KEEN. On a KILL it floods
  // him with a barbarian rage; when the foes run out he must make a Will save (DC 10 + ½ level) or
  // the demon turns him on his own allies — see _tonbokiriRage / _tonbokiriFrenzyBurst. Iron Will
  // is the only leash on it (why Azwraith took Iron Will + Improved Iron Will).
  tonbokiri: { key: 'tonbokiri', name: 'Ton Bokiri', cat: '2h', ranged: false, dmgCount: 1, dmgDie: 10, crit: 18, mult: 2, type: 'S', group: 'polearms', prof: 'martial', custom: true, reachFly: true, special: { unholy: 2, keen: true } },
  // Celeb's named three-section staff "Kagero Sansetsukon" (from his Foundry build,
  // Hell's Rebels — 'kagero' = shimmering heat-haze). PF1 sansetsukon: 1d10 B, 19-20/×2,
  // flails group. No elemental rider (Tobias's call) — a scholar-monk's caster staff that
  // is simply always magic (custom => always magic + always proficient). His +N rides gear.
  kagerosansetsukon: { key: 'kagerosansetsukon', name: 'Kagero Sansetsukon', cat: '2h', ranged: false, dmgCount: 1, dmgDie: 10, crit: 19, mult: 2, type: 'B', group: 'flails', prof: 'exotic', custom: true, atkSound: '/audio/weapon_blunt.mp3' },
  // Elodie's named rapier "Raison d'Acier" ("Reason of Steel"; from her Foundry build).
  // A duelist's blade — KEEN (widens its 18-20 threat to 15-20). 1d6 P, bladesLight. As a
  // 1h light blade it rides the better of STR/DEX (finesse house rule) for the bard-duelist.
  raisondacier: { key: 'raisondacier', name: "Raison d'Acier", cat: '1h', ranged: false, dmgCount: 1, dmgDie: 6, crit: 18, mult: 2, type: 'P', group: 'bladesLight', prof: 'martial', custom: true, special: { keen: true } },
  // Lord Gweyir's ESTOC — a stiff two-handed thrusting blade (2d4, 18-20/×2, piercing).
  // finesse2h rides his DEX for hit AND damage (the elf duelist's foil). custom => proficient.
  estoc: { key: 'estoc', name: 'Estoc', cat: '2h', ranged: false, dmgCount: 2, dmgDie: 4, crit: 18, mult: 2, type: 'P', group: 'bladesHeavy', prof: 'martial', custom: true, finesse2h: true },
  // Dismas's holy dragon-rifle. A firearm (1d12, ×4 crit) — he smites with it.
  // INTRINSICALLY a HOLY (a "little bit" — 1d6 vs evil) FLAMING BURST dragon-rifle:
  // +1d6 fire each shot, +2d10 fire on its ×4 crit, +1d6 vs evil. Dismas's holy gun.
  rovadra: { key: 'rovadra', name: 'Rovadra', cat: 'ranged', ranged: true, dmgCount: 1, dmgDie: 12, crit: 20, mult: 4, type: 'B', group: 'firearms', prof: 'exotic', custom: true, special: { flamingBurst: true, holy: 1 }, atkSound: '/audio/rovadra_dragonrifle.mp3' },   // Dismas's holy-gun report — the dragonrifle "delay" recording (single shot)
  // Gaspar's bastard sword "Curator" — KEEN (folds its 19-20 threat into 17-20).
  curator: { key: 'curator', name: 'Curator', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 10, crit: 19, mult: 2, type: 'S', group: 'heavyBlades', prof: 'exotic', custom: true, special: { keen: true } },
  // Gabriel's greatsword "Redeemer" — a green-glass blade of legend, once a tool of
  // evil, reforged into a holy sword in a paladin's hands. INTRINSICALLY a FLAMING
  // BURST, HOLY blade (2d6, 19-20/×2): +1d6 fire every hit, extra fire on a crit, and
  // +2d6 vs EVIL — always on, even at +0. Its ENHANCEMENT (+N) rides Gabriel's gear
  // tier / Divine Bond on top.
  redeemer: { key: 'redeemer', name: 'Redeemer', cat: '2h', ranged: false, dmgCount: 2, dmgDie: 6, crit: 19, mult: 2, type: 'S', group: 'heavyBlades', prof: 'martial', custom: true, special: { flamingBurst: true, holy: true }, atkSound: '/audio/sword_eviscerate2_flaming.mp3' },
  // Danger's ORCISH WARBOW — a massive hornbow (2d6, ×3). An exotic weapon, but Danger
  // is TRAINED with it (custom => always proficient). Key stays 'longbow' so his persisted
  // weapon row / gear history survive the rename.
  longbow: { key: 'longbow', name: 'Orcish Warbow', cat: 'ranged', ranged: true, dmgCount: 2, dmgDie: 6, crit: 20, mult: 3, type: 'P', group: 'bows', prof: 'exotic', custom: true, atkSound: '/audio/bow_silent_hits.mp3' },   // Danger's warbow — near-silent loose, sound lands on the hit
  // Vesorianna's spectral Ghost Touch — a chilling 2d6 melee strike. FROST: +1d6 cold each hit.
  ghosttouch: { key: 'ghosttouch', name: 'Ghost Touch', cat: '1h', ranged: false, dmgCount: 2, dmgDie: 6, crit: 20, mult: 2, type: 'B', group: 'natural', prof: 'simple', custom: true, special: { frost: true } },
  // Crisp the deinonychus — a natural full attack: bite + 2 raking talons (1d6
  // each), all at full BAB (see _attackOffsets naturalAttacks). No shield.
  bite: { key: 'bite', name: 'Talons & Bite', cat: 'light', ranged: false, dmgCount: 1, dmgDie: 6, crit: 20, mult: 2, type: 'S', group: 'natural', prof: 'simple', custom: true, naturalAttacks: 3, noShield: true },
  // Rissa's claws (natural, 1d6).
  claws: { key: 'claws', name: 'Claws', cat: 'light', ranged: false, dmgCount: 1, dmgDie: 6, crit: 20, mult: 2, type: 'S', group: 'natural', prof: 'simple', custom: true },
  // Vaughan's named scimitar "Radiance" (1d6, 18–20/×2). A SENTIENT blade — voice
  // "Tresdin", she has lived dozens of reincarnated lives beside Vaughan and critiques
  // him often (banter is a future feature). No intrinsic element: she is not holy/flaming,
  // but she is ALWAYS at least magic +1 and scales with BOTH Vaughan's gear tier AND his
  // magus levels — the magus arcane-pool enhancement already handles that, so no `special`.
  radiance: { key: 'radiance', name: 'Radiance', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 6, crit: 18, mult: 2, type: 'S', group: 'bladesHeavy', prof: 'martial', custom: true },
  // Lirienne's named repeating crossbow "Light of the Dawn" (1d8, 19–20). From her
  // Foundry build (Justice Gorls). HOLY: dawn-light bolts sear the wicked — +2d6 vs
  // EVIL foes (and bite undead). Key stays 'repeatingcrossbow' so her saved row survives.
  repeatingcrossbow: { key: 'repeatingcrossbow', name: 'Light of the Dawn', cat: 'ranged', ranged: true, dmgCount: 1, dmgDie: 8, crit: 19, mult: 2, type: 'P', group: 'crossbows', prof: 'exotic', custom: true, special: { holy: true }, atkSound: '/audio/crossbow.mp3' },
  // Universal BACKUP weapon — every melee character carries a light crossbow to shoot
  // airborne foes they can't reach in melee (last resort; see _playerAttack). Masterwork
  // (no enchant), so always weaker than their real weapon. 1d8, 19-20/x2. custom => always proficient.
  lightcrossbow: { key: 'lightcrossbow', name: 'Light Crossbow', cat: 'ranged', ranged: true, dmgCount: 1, dmgDie: 8, crit: 19, mult: 2, type: 'P', group: 'crossbows', prof: 'simple', custom: true, atkSound: '/audio/crossbow_fire_and_reload.mp3' },
  // El Guapo's pistol — his swashbuckler archetype packs a sidearm as the SECONDARY
  // attack: firearms hit TOUCH AC, full iteratives apply (ranged always full-attacks).
  // Drawn via the backup-ranged path when his rapier can't reach (see _backupRangedKey).
  guapopistol: { key: 'guapopistol', name: 'Pistol', cat: 'ranged', ranged: true, dmgCount: 1, dmgDie: 8, crit: 20, mult: 4, type: 'B', group: 'firearms', prof: 'martial', custom: true, atkSound: '/audio/tarkov_pistol_rsh12_empty_reload2.mp3' },
  // El Guapo's MITHRAL SCIMITAR (from his Foundry build; was a Mithril Scimitar +2).
  // A scimitar (1d6, 18-20/×2, S). Just MITHRAL + MAGIC — no elemental rider (Tobias:
  // "that's all it is"). custom => always magic + proficient; as a 1h light-riding blade
  // it uses the better of STR/DEX (the swashbuckler's Dexterity). His pistol backup is
  // keyed to his playerId (_backupRangedKey), so it's unaffected by this main-weapon swap.
  mithralscimitar: { key: 'mithralscimitar', name: 'Mithral Scimitar', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 6, crit: 18, mult: 2, type: 'S', group: 'bladesHeavy', prof: 'martial', custom: true },
  // Gaspar's PAIRED PISTOLS — his backup ranged option: dual-wielded firearms (two
  // shots + TWF, touch AC, full iteratives) that ride Bane/Judgement and every other
  // buff like any weapon. He LIKES them — see the 60/40 mixed-field pick in _playerAttack.
  gasparpistols: { key: 'gasparpistols', name: 'Paired Pistols', cat: 'ranged', ranged: true, dual: true, noShield: true, dmgCount: 1, dmgDie: 8, crit: 20, mult: 4, type: 'B', group: 'firearms', prof: 'exotic', custom: true, atkSound: '/audio/pistol_evil-rsh12_sonny_landham_billy_laugh.mp3' },
  // Duristan's rifle "Longue Carabine" — a heavy-hitting bolt-action .338 (2d10, ×4).
  // Single-shot: no Rapid Shot. (Key stays 'lapua' so his persisted weapon row and
  // gear history survive the rename.) Report: cyberpunk sniper crack from Foundry.
  lapua: { key: 'lapua', name: 'Longue Carabine', cat: 'ranged', ranged: true, dmgCount: 2, dmgDie: 10, crit: 20, mult: 4, type: 'P', group: 'firearms', prof: 'exotic', custom: true, boltAction: true, atkSound: '/audio/rifle_longue_carabine.mp3' },
  // Duristan's DARK SILVER SCIMITAR — a rarely-drawn melee sidearm (from his Foundry
  // build). A scimitar (1d6, 18-20/×2, S), just dark-silver + magic, no elemental rider.
  // Bot-Duristan stays on his rifle (Longue Carabine); this is here so a human pilot can
  // choose it from the ★ signature list. custom => always magic + proficient.
  darksilverscimitar: { key: 'darksilverscimitar', name: 'Dark Silver Scimitar', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 6, crit: 18, mult: 2, type: 'S', group: 'bladesHeavy', prof: 'martial', custom: true },
  // Taelys's DVL-10 bolt-action sniper rifle (2d8, ×4) — silenced single shot,
  // so no Rapid Shot (she relies on Bullseye Shot + Deadly Aim instead).
  dvl: { key: 'dvl', name: 'DVL-10 Sniper Rifle', cat: 'ranged', ranged: true, dmgCount: 2, dmgDie: 8, crit: 20, mult: 4, type: 'P', group: 'firearms', prof: 'exotic', custom: true, boltAction: true, atkSound: '/audio/rifle_dvl_silenced.mp3' },
  // Ser Toche's elven curved blade — the classic PF1 DEX two-hander (1d10, 18–20):
  // finesse2h lets a DEX build drive it (to-hit AND damage, ×1.5 two-handed).
  elvencurve: { key: 'elvencurve', name: 'Elven Curved Blade', cat: '2h', ranged: false, dmgCount: 1, dmgDie: 10, crit: 18, mult: 2, type: 'S', group: 'heavyBlades', prof: 'exotic', custom: true, special: { keen: true }, finesse2h: true },
  // Ulfred's named battleaxe "Voidshard" (1d8, ×3) — its own meaty axe report.
  // FREEZING BURST: +1d6 cold each hit, +2d10 cold on its ×3 crit (frostBurst rider).
  voidshard: { key: 'voidshard', name: 'Voidshard', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 8, crit: 20, mult: 3, type: 'S', group: 'axes', prof: 'martial', custom: true, special: { frostBurst: true }, atkSound: '/audio/voidshard.mp3' },
  // Farrus Richton's TWIN battleaxes — two-weapon fighting (2 swings/turn, one
  // report), and no shield (dual-wield → no shield AC).
  // UNHOLY: +2d6 vs good-aligned foes (Farrus is a devil-blooded villain PC).
  twoaxes: { key: 'twoaxes', name: 'Twin Battleaxes', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 8, crit: 20, mult: 3, type: 'S', group: 'axes', prof: 'martial', custom: true, special: { unholy: true }, dual: true, noShield: true, atkSound: '/audio/weapon_double_axe.mp3' },
  // Lou Candlebean's named gnome hooked hammer "HAMMERTIME" (from her Foundry build,
  // Justice Gorls) — a DOUBLE weapon she two-weapon fights with (2 swings/turn, one
  // report; no shield). Hammer head: 1d8 B, ×3 crit. No elemental rider (Tobias's call);
  // custom => always magic + always proficient. Key stays 'gnomehammer' (her saved row).
  gnomehammer: { key: 'gnomehammer', name: 'HAMMERTIME', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 8, crit: 20, mult: 3, type: 'B', group: 'hammers', prof: 'exotic', custom: true, dual: true, noShield: true, atkSound: '/audio/weapon_warhammer.mp3' },
  // Tokala's CHAINSAW — a roaring 3d6 slashing two-hander that crits on an 18.
  // KEEN: those churning teeth widen its 18-20 threat to 15-20 (thematically perfect).
  chainsaw: { key: 'chainsaw', name: 'Chainsaw', cat: '2h', ranged: false, dmgCount: 3, dmgDie: 6, crit: 18, mult: 2, type: 'S', group: 'axes', prof: 'exotic', custom: true, special: { keen: true }, atkSound: '/audio/weapon_chainsaw.mp3' },
  // ── THE HELL'S VENGEANCE / REBELS PCs — now playable AI-heroes (2026-07-05) ──
  // Femmik's scimitar "Lammas Aeternum" (1d6, 18-20/×2). A Dawnflower Dervish
  // wields the scimitar with GRACE — it's in Dungeon.js FINESSE_KEYS, so it rides
  // his DEX (24) for to-hit AND damage. custom => always proficient (bards aren't
  // normally proficient with scimitars; the Dervish Dance feat grants it).
  // INTRINSICALLY KEEN + CRITICAL FOCUS — the Dawnflower Dervish's whirling blade
  // threatens a crit on 15-20 (keen doubles its 18-20 range) AND confirms crits at
  // +4 (Critical Focus). Always on; +N rides his gear. (Finesse: rides his DEX for
  // hit & damage via the 1h house rule.)
  lammas: { key: 'lammas', name: 'Lammas Aeternum', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 6, crit: 18, mult: 2, type: 'S', group: 'bladesHeavy', prof: 'martial', custom: true, special: { keen: true }, critFocus: true, atkSound: '/audio/sword_eviscerate2_flaming.mp3' },
  // Freya Kusanagi's katana "Balrog's Blessed Blade" — a FLAMING samurai's blade
  // (1d8, 18-20/×2). She's a samurai, already proficient; custom => the blade is
  // always hers. INTRINSICALLY FLAMING BURST: +1d6 fire on every hit AND extra fire
  // dice on a crit (a balrog-forged blade; matches its oversized +1d8 fire source).
  // Always on (even at +0); her +N rides her gear tier on top.
  balrogblade: { key: 'balrogblade', name: "Balrog's Blessed Blade", cat: '1h', ranged: false, dmgCount: 1, dmgDie: 8, crit: 18, mult: 2, type: 'S', group: 'bladesHeavy', prof: 'martial', custom: true, special: { flamingBurst: true }, atkSound: '/audio/sword_eviscerate2_flaming.mp3' },
  // J'Mal's "Angelbone Sawtooth Sabers" — TWIN sawtoothed sabres (Red Mantis
  // signature), two-weapon fighting (2 swings/turn, one report; no shield),
  // 1d8 18-20/×2. His Red Mantis Assassin / Rogue sneak dice ride the class.
  // INTRINSICALLY KEEN + CRITICAL FOCUS — the sawtoothed Red Mantis blades threaten
  // on 17-20 (keen doubles 19-20) AND confirm at +4 (Critical Focus), feeding the
  // assassin's crit-hungry sneak attacks. (Both blades ride his DEX for hit & damage
  // via the 1h house rule.)
  sawtoothsabers: { key: 'sawtoothsabers', name: 'Angelbone Sawtooth Sabers', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 8, crit: 19, mult: 2, type: 'S', group: 'bladesHeavy', prof: 'exotic', custom: true, dual: true, noShield: true, special: { keen: true }, critFocus: true, atkSound: '/audio/fight_riki.mp3' },
  // J'Mal's SABER-AND-DRAGON-SHIELD build — an Angelbone Sawtooth Saber in the main
  // hand and the DRAGON SHIELD in the off: a bashing heavy shield he attacks WITH.
  // Two swings a round (saber + shield bash), and UNLIKE a normal dual-wielder he
  // KEEPS his shield AC — `shieldAC: 2` (a masterwork heavy shield; +N rides his
  // owned shield tier). Keen (17-20). 1d8 19-20/×2. NOT noShield → shield AC applies.
  sawtoothdragon: { key: 'sawtoothdragon', name: 'Sawtooth Saber & Dragon Shield', cat: '1h', ranged: false, dmgCount: 1, dmgDie: 8, crit: 19, mult: 2, type: 'S', group: 'bladesHeavy', prof: 'exotic', custom: true, dual: true, shieldAC: 2, special: { keen: true }, critFocus: true, atkSound: '/audio/fight_riki.mp3' },
  // Jason's "Force Pike" (modeled on Dota's Force Staff) — a reach weapon (1d10, ×3)
  // that hits like a NORMAL magic weapon at his current gear tier. Its real trick is
  // the FORCE PUSH ability (see Jason's char-gated 'forcepush'): shove a foe and every
  // melee ally with their weapon out gets a FREE attack. reachFly lets him strike
  // airborne foes from the back rank. custom => always proficient.
  forcepike: { key: 'forcepike', name: 'Force Pike', cat: '2h', ranged: false, dmgCount: 1, dmgDie: 10, crit: 20, mult: 3, type: 'P', group: 'spears', prof: 'martial', custom: true, reachFly: true },
  // Reese's "Stormcaller" — an arcane composite longbow (1d8, ×3). As an ELDRITCH
  // ARCHER magus he casts touch spells THROUGH it: his magus Spellstrike rides this
  // bow (m.weapon), delivering the spell on a ranged shot. custom => always proficient.
  // INTRINSICALLY SHOCK — the storm bow crackles: +1d6 electricity on every shot,
  // always on (on top of his magus Spellstrike). +N rides his gear.
  stormcaller: { key: 'stormcaller', name: 'Stormcaller', cat: 'ranged', ranged: true, dmgCount: 1, dmgDie: 8, crit: 20, mult: 3, type: 'P', group: 'bows', prof: 'martial', custom: true, special: { shock: true }, atkSound: '/audio/bow_silent_hits.mp3' },
  // Draymus's "Angelbone Scythe" — a necromancer's reaping blade (2d4, ×4 crit, the
  // scythe's brutal multiplier). custom => always proficient. UNHOLY: he's a Neutral
  // Evil dhampir, so +2d6 vs GOOD foes (bites the Heavenly Host). A caster's backup —
  // he mostly casts — but thematic and it hits hard on a crit.
  angelbonescythe: { key: 'angelbonescythe', name: 'Angelbone Scythe', cat: '2h', ranged: false, dmgCount: 2, dmgDie: 4, crit: 20, mult: 4, type: 'P/S', group: 'bladesHeavy', prof: 'martial', custom: true, special: { unholy: true }, atkSound: '/audio/spell_umbral_bolt.mp3' },
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
