// pf1data/bloodlines.js — SORCERER BLOODLINES (PF1 Core Rulebook, the ten of them).
// v3.37.169 (Tobias, 2026-09-23: "start building in the sorcerer bloodlines from the core
// rule book and include their powers"). Data only — the runtime templates live in
// game/dungeon/abilities.js (_bloodlineSetup / BL_TEMPLATES), the picker in the lobby
// profile row (lobby:setBloodline), persistence in db.players.bloodline.
//
// What a bloodline gives a sorcerer (CRB p.71-79):
//   • BONUS SPELLS — one extra spell KNOWN per spell level, at class levels 3/5/7/…/19.
//     They are ALWAYS known (they do not count against Table 3-15), so a sorcerer with a
//     bloodline loses the "+1 free pick" the engine modelled before (knownCapsFor).
//   • POWERS at 1st, 3rd, 9th, 15th and 20th level. "Per day" = per ROOM (the game's
//     day, same as domains); "3 + Cha modifier uses" reads the sorcerer's Cha mod.
//   • ARCANA (a passive tweak to their spellcasting) and BONUS FEATS — not modelled yet.
//
// power.kind (runtime vocabulary — see BL_TEMPLATES in abilities.js):
//   ray        a ranged touch attack, 1d6 (or d4) + ½ level of `dtype`, 3+Cha uses/room
//   touchfear  a touch that leaves the foe SHAKEN (engine: Will save, like Doom), 3+Cha uses
//   claws      a room-long self buff standing in for two claw attacks (see desc)
//   blast      a level d6 area burst, Reflex half, `dtype`, 1/room (2 at 17, 3 at 20)
//   wings      a room-long self Fly, 1/room (Wings of Heaven)
//   invis      Greater Invisibility on yourself, 1/room (Fleeting Glance)
//   reroll     re-roll your next failed attack or save (rides the Luck domain engine), 1/room
//   passive    always on: ac / save / sr / resist / immune / dr / fly / hit / dmg (functions of level)
//   todo       written down, NOT in the engine yet (the picker and the info entry say so)
//
// spells: class level → CANDIDATE spell keys (the first one the engine implements wins;
// none implemented → that bonus spell is skipped and the info entry says which).

const R = (n) => () => n;   // constant-by-level helper

const BLOODLINES = {
  aberrant: {
    key: 'aberrant', name: 'Aberrant', icon: '🐙',
    blurb: 'Something alien twists your blood — acid, reach and a body that refuses to die.',
    arcana: 'Polymorph spells last 50% longer (not modelled).',
    powers: [
      { level: 1,  key: 'acidicray',       name: 'Acidic Ray',        kind: 'ray',     die: 6, dtype: 'acid', desc: 'A ranged touch of acid: 1d6 + ½ your level acid damage, 3 + Cha uses per room.' },
      { level: 3,  key: 'longlimbs',       name: 'Long Limbs',        kind: 'todo',    desc: 'Your melee touch spells reach 5 ft further (10 at 11, 15 at 17). No grid here — nothing to model yet.' },
      { level: 9,  key: 'unusualanatomy',  name: 'Unusual Anatomy',   kind: 'todo',    desc: 'A 25% chance (50% at 13) to ignore a critical hit or sneak attack. Not in the engine yet.' },
      { level: 15, key: 'alienresistance', name: 'Alien Resistance',  kind: 'passive', sr: (l) => l + 10, desc: 'Spell resistance equal to your level + 10, always on.' },
      { level: 20, key: 'aberrantform',    name: 'Aberrant Form',     kind: 'passive', dr: R(5), desc: 'DR 5/— always on (the book also grants immunity to critical hits and sneak attacks and blindsight 60 ft — not modelled yet).' },
    ],
    spells: { 3: ['enlargeperson'], 5: ['seeinvisibility'], 7: ['tongues'], 9: ['blacktentacles'], 11: ['feeblemind'], 13: ['veil'], 15: ['planeshift'], 17: ['mindblank'], 19: ['shapechange'] },
  },
  abyssal: {
    key: 'abyssal', name: 'Abyssal', icon: '😈',
    blurb: 'Demon blood — claws, hardened flesh and the strength of the Abyss.',
    arcana: 'Your summoned creatures gain DR/good (not modelled).',
    powers: [
      { level: 1,  key: 'claws',           name: 'Claws',             kind: 'claws',   desc: 'Grow claws for the room (the book: two 1d4 claw attacks for 3 + Cha rounds a day; 1d6 and magic at 7, +1d6 fire at 11). Engine stand-in: +2 damage on every hit this room (+3 from 7, plus 1d6 fire from 11).', dtype: 'fire' },
      { level: 3,  key: 'demonresist',     name: 'Demon Resistances', kind: 'passive', resist: (l) => ({ electricity: l >= 9 ? 10 : 5 }), save: R(0), desc: 'Electricity resistance 5 (10 at 9), always on. (+2 vs poison at 3, +4 at 9 — poison saves are not typed yet.)' },
      { level: 9,  key: 'abyssstrength',   name: 'Strength of the Abyss', kind: 'passive', hit: (l) => l >= 17 ? 3 : l >= 13 ? 2 : 1, dmg: (l) => l >= 17 ? 3 : l >= 13 ? 2 : 1, desc: '+2 Strength (+4 at 13, +6 at 17): +1/+2/+3 to hit and melee damage, always on.' },
      { level: 15, key: 'addedsummonings', name: 'Added Summonings',  kind: 'todo',    desc: 'Summon Monster brings one extra creature. Not in the engine yet.' },
      { level: 20, key: 'demonicmight',    name: 'Demonic Might',     kind: 'passive', immune: ['electricity', 'poison'], resist: () => ({ acid: 10, cold: 10, fire: 10 }), desc: 'Immune to electricity and poison; acid, cold and fire resistance 10. Always on.' },
    ],
    spells: { 3: ['causefear'], 5: ['bullsstrength', 'bullstrength'], 7: ['rage', 'ragespell'], 9: ['stoneskin'], 11: ['dismissal'], 13: ['transformation'], 15: ['greaterteleport', 'teleportgreater', 'teleport'], 17: ['unholyaura'], 19: ['summonmonster9'] },
  },
  arcane: {
    key: 'arcane', name: 'Arcane', icon: '📘',
    blurb: 'Pure magic runs in the family — more spells known and metamagic in your bones.',
    arcana: 'A metamagic spell has +1 to its save DC (not modelled).',
    powers: [
      { level: 1,  key: 'arcanebond',      name: 'Arcane Bond',       kind: 'todo',    desc: 'A familiar or a bonded object (one free extra cast a day). Not in the engine yet — ask Toby how it should read here.' },
      { level: 3,  key: 'metamagicadept',  name: 'Metamagic Adept',   kind: 'todo',    desc: 'Apply a metamagic feat without the longer casting time, 1/day (+1 per 4 levels). Not in the engine yet.' },
      { level: 9,  key: 'newarcana',       name: 'New Arcana',        kind: 'passive', newArcana: true, desc: 'One extra spell KNOWN at 9, 13 and 17 (the engine adds it to the cap of your newest spell level).' },
      { level: 15, key: 'schoolpower',     name: 'School Power',      kind: 'todo',    desc: '+2 to the save DC of one school of magic. The engine has no schools on spells yet.' },
      { level: 20, key: 'apotheosis',      name: 'Arcane Apotheosis', kind: 'todo',    desc: 'Metamagic paid with lower-level slots instead of time. Not in the engine yet.' },
    ],
    spells: { 3: ['identify'], 5: ['invisibility'], 7: ['dispelmagic'], 9: ['dimensiondoor'], 11: ['overlandflight'], 13: ['trueseeing'], 15: ['greaterteleport', 'teleportgreater', 'teleport'], 17: ['powerwordstun'], 19: ['wish'] },
  },
  celestial: {
    key: 'celestial', name: 'Celestial', icon: '😇',
    blurb: 'Heaven-born — holy fire, resistances and wings of light.',
    arcana: 'Your summoned creatures gain DR/evil (not modelled).',
    powers: [
      { level: 1,  key: 'heavenlyfire',    name: 'Heavenly Fire',     kind: 'ray',     die: 4, dtype: 'holy', desc: 'A ray of holy fire: 1d4 + ½ your level divine damage, 3 + Cha uses per room. (The book harms only evil creatures and heals good ones — here it burns any foe.)' },
      { level: 3,  key: 'celestialresist', name: 'Celestial Resistances', kind: 'passive', resist: (l) => ({ acid: l >= 9 ? 10 : 5, cold: l >= 9 ? 10 : 5 }), desc: 'Acid and cold resistance 5 (10 at 9), always on.' },
      { level: 9,  key: 'wingsofheaven',   name: 'Wings of Heaven',   kind: 'wings',   desc: 'Wings of light: fly for the rest of the room (the book: level minutes a day). Grounded foes cannot reach you; once per room.' },
      { level: 15, key: 'conviction',      name: 'Conviction',        kind: 'reroll',  desc: 'Once per room, re-roll your next MISSED attack (the same engine as the Luck domain; saves are not covered yet).' },
      { level: 20, key: 'ascension',       name: 'Ascension',         kind: 'passive', immune: ['acid', 'cold'], resist: () => ({ electricity: 10, fire: 10 }), desc: 'Immune to acid and cold; electricity and fire resistance 10. Always on. (Petrification immunity and +4 vs poison not modelled.)' },
    ],
    spells: { 3: ['bless'], 5: ['resistenergy', 'resistfire'], 7: ['magiccircleevil', 'magiccircleagainstevil', 'protevilcomm'], 9: ['removecurse'], 11: ['flamestrike'], 13: ['dispelmagicgreater', 'greaterdispel'], 15: ['banishment'], 17: ['sunburst'], 19: ['gate'] },
  },
  destined: {
    key: 'destined', name: 'Destined', icon: '🌠',
    blurb: 'Fate itself favours you — luck on your saves and a second roll when it matters.',
    arcana: 'Personal-range spells give +1 luck to saves for a round per spell level (not modelled).',
    powers: [
      { level: 1,  key: 'touchofdestiny',  name: 'Touch of Destiny',  kind: 'todo',    desc: 'Touch an ally: +½ your level on attacks, saves and checks for one round, 3 + Cha uses. Not in the engine yet — one-round buffs need a new hook.' },
      { level: 3,  key: 'fated',           name: 'Fated',             kind: 'passive', ac: (l) => 1 + Math.floor((l - 3) / 4), save: (l) => 1 + Math.floor((l - 3) / 4), desc: '+1 luck bonus to AC and saves (+1 more every 4 levels after 3rd). The book limits it to the first round of a fight; here it is always on.' },
      { level: 9,  key: 'meanttobe',       name: 'It Was Meant To Be', kind: 'reroll', desc: 'Once per room (twice at 17 in the book), re-roll your next MISSED attack (the same engine as the Luck domain; saves are not covered yet).' },
      { level: 15, key: 'withinreach',     name: 'Within Reach',      kind: 'todo',    desc: 'Once a day a blow that would kill you leaves you at −1 and stable on a DC 20 Will save. Not in the engine yet.' },
      { level: 20, key: 'destinyrealized', name: 'Destiny Realized',  kind: 'todo',    desc: 'Foes confirm criticals against you only on a natural 20; yours confirm automatically. Not in the engine yet.' },
    ],
    spells: { 3: ['alarm'], 5: ['blur'], 7: ['protectenergy', 'protectfire'], 9: ['freedommove'], 11: ['breakenchantment'], 13: ['mislead'], 15: ['spellturning'], 17: ['momentofprescience', 'momentprescience'], 19: ['foresight'] },
  },
  draconic: {
    key: 'draconic', name: 'Draconic (red — fire)', icon: '🐉',
    blurb: 'A dragon in the family tree: claws, scales, a breath weapon and, in time, wings.',
    arcana: 'Your fire spells deal +1 damage per die (not modelled). Other dragon colours (cold, electricity, acid) on request.',
    energy: 'fire',
    powers: [
      { level: 1,  key: 'dragonclaws',     name: 'Claws',             kind: 'claws',   dtype: 'fire', desc: 'Grow claws for the room (the book: two 1d4 claw attacks for 3 + Cha rounds a day; 1d6 and magic at 7, +1d6 fire at 11). Engine stand-in: +2 damage on every hit this room (+3 from 7, plus 1d6 fire from 11).' },
      { level: 3,  key: 'dragonresist',    name: 'Dragon Resistances', kind: 'passive', resist: (l) => ({ fire: l >= 15 ? 20 : l >= 9 ? 10 : 5 }), ac: (l) => l >= 15 ? 4 : l >= 9 ? 2 : 1, desc: 'Fire resistance 5 and +1 natural armor (10 / +2 at 9, 20 / +4 at 15), always on.' },
      { level: 9,  key: 'breathweapon',    name: 'Breath Weapon',     kind: 'blast',   dtype: 'fire', maxTargets: 4, desc: 'A cone of dragonfire: your level d6 fire on up to 4 foes, Reflex half. Once per room (twice at 17, three times at 20).' },
      { level: 15, key: 'dragonwings',     name: 'Wings',             kind: 'passive', fly: true, desc: 'Leathery wings: you fly, always. Grounded foes cannot reach you.' },
      { level: 20, key: 'powerofwyrms',    name: 'Power of Wyrms',    kind: 'passive', immune: ['fire'], desc: 'Immune to fire, always on. (Immunity to paralysis and sleep, and blindsense 60 ft, not modelled.)' },
    ],
    spells: { 3: ['magearmor'], 5: ['resistenergy', 'resistfire'], 7: ['fly'], 9: ['fear'], 11: ['spellresistance'], 13: ['formofthedragon1', 'formdragon1'], 15: ['formofthedragon2', 'formdragon2'], 17: ['formofthedragon3', 'formdragon3'], 19: ['wish'] },
  },
  elemental: {
    key: 'elemental', name: 'Elemental (air — electricity)', icon: '⚡',
    blurb: 'The storm is in your veins: lightning rays, a thunderous blast and the wind under you.',
    arcana: 'You may change the energy type of any energy spell to electricity (not modelled). Earth (acid), fire and water (cold) on request.',
    energy: 'electricity',
    powers: [
      { level: 1,  key: 'elementalray',    name: 'Elemental Ray',     kind: 'ray',     die: 6, dtype: 'electricity', desc: 'A ranged touch of lightning: 1d6 + ½ your level electricity damage, 3 + Cha uses per room.' },
      { level: 3,  key: 'elementalresist', name: 'Elemental Resistance', kind: 'passive', resist: (l) => ({ electricity: l >= 9 ? 20 : 10 }), desc: 'Electricity resistance 10 (20 at 9), always on.' },
      { level: 9,  key: 'elementalblast',  name: 'Elemental Blast',   kind: 'blast',   dtype: 'electricity', maxTargets: 4, desc: 'A 20-ft burst of lightning: your level d6 electricity on up to 4 foes, Reflex half. Once per room (twice at 17, three times at 20).' },
      { level: 15, key: 'elementalmove',   name: 'Elemental Movement', kind: 'passive', fly: true, desc: 'Air: you fly at 60 ft, always. Grounded foes cannot reach you.' },
      { level: 20, key: 'elementalbodycap', name: 'Elemental Body',   kind: 'passive', immune: ['electricity'], desc: 'Immune to electricity, always on. (Immunity to critical hits and sneak attacks not modelled.)' },
    ],
    spells: { 3: ['burninghands'], 5: ['scorchingray'], 7: ['protectenergy', 'protectelectricity', 'protectfire'], 9: ['elementalbody', 'elementalbody1'], 11: ['elementalbody2'], 13: ['elementalbody3'], 15: ['elementalbody4'], 17: ['summonmonster8'], 19: ['elementalswarm'] },
  },
  fey: {
    key: 'fey', name: 'Fey', icon: '🧚',
    blurb: 'Faerie blood — laughter, vanishing and magic that slips past resistance.',
    arcana: '+2 to the save DC of your compulsion spells (not modelled).',
    powers: [
      { level: 1,  key: 'laughingtouch',   name: 'Laughing Touch',    kind: 'todo',    desc: 'Touch a foe: it can only take a move action next turn, 3 + Cha uses. Not in the engine yet — needs a lose-your-attack hook.' },
      { level: 3,  key: 'woodlandstride',  name: 'Woodland Stride',   kind: 'todo',    desc: 'Undergrowth never slows you. No terrain here — nothing to model.' },
      { level: 9,  key: 'fleetingglance',  name: 'Fleeting Glance',   kind: 'invis',   desc: 'Turn invisible for the rest of the room even while you cast and attack (Greater Invisibility on yourself), once per room.' },
      { level: 15, key: 'feymagic',        name: 'Fey Magic',         kind: 'todo',    desc: 'Re-roll a caster level check to beat spell resistance, 1/day. Not in the engine yet.' },
      { level: 20, key: 'souloffey',       name: 'Soul of the Fey',   kind: 'passive', immune: ['poison'], dr: R(10), desc: 'Immune to poison; DR 10/— (the book: /cold iron). Always on. (Shadow Walk 1/day not modelled.)' },
    ],
    spells: { 3: ['entangle'], 5: ['hideouslaughter'], 7: ['deepslumber'], 9: ['poison'], 11: ['treestride'], 13: ['mislead'], 15: ['phasedoor'], 17: ['irresistibledance'], 19: ['shapechange'] },
  },
  infernal: {
    key: 'infernal', name: 'Infernal', icon: '🔥',
    blurb: 'Devil blood — a corrupting touch, hellfire and, in time, dark wings.',
    arcana: '+2 to the save DC of your charm spells (not modelled).',
    powers: [
      { level: 1,  key: 'corruptingtouch', name: 'Corrupting Touch',  kind: 'touchfear', desc: 'A touch that leaves a foe SHAKEN (−2 to hit and damage) for the fight, 3 + Cha uses per room. (The book: a melee touch, no save, ½ level rounds; here it is a Will save like Doom.)' },
      { level: 3,  key: 'infernalresist',  name: 'Infernal Resistances', kind: 'passive', resist: (l) => ({ fire: l >= 9 ? 10 : 5 }), desc: 'Fire resistance 5 (10 at 9), always on. (+2/+4 vs poison not typed yet.)' },
      { level: 9,  key: 'hellfire',        name: 'Hellfire',          kind: 'blast',   dtype: 'fire', maxTargets: 3, desc: 'A column of hellfire: your level d6 fire on up to 3 foes, Reflex half. Once per room (twice at 17, three times at 20).' },
      { level: 15, key: 'ondarkwings',     name: 'On Dark Wings',     kind: 'passive', fly: true, desc: 'Bat-like wings: you fly, always. Grounded foes cannot reach you.' },
      { level: 20, key: 'powerofthepit',   name: 'Power of the Pit',  kind: 'passive', immune: ['fire', 'poison'], resist: () => ({ acid: 10, cold: 10 }), desc: 'Immune to fire and poison; acid and cold resistance 10. Always on. (Seeing in darkness not modelled.)' },
    ],
    spells: { 3: ['protgood', 'protectionfromgood', 'protevil'], 5: ['scorchingray'], 7: ['suggestion'], 9: ['charmmonster'], 11: ['dominateperson'], 13: ['planarbinding'], 15: ['greaterteleport', 'teleportgreater', 'teleport'], 17: ['powerwordstun'], 19: ['meteorswarm'] },
  },
  undead: {
    key: 'undead', name: 'Undead', icon: '💀',
    blurb: 'The grave calls — a frightening touch, cold resistance and the arms of the dead.',
    arcana: 'Your mind-affecting spells work on corporeal undead (not modelled).',
    powers: [
      { level: 1,  key: 'gravetouch',      name: 'Grave Touch',       kind: 'touchfear', desc: 'A touch that leaves a foe SHAKEN (−2 to hit and damage) for the fight, 3 + Cha uses per room. (The book: a melee touch, no save, ½ level rounds; here it is a Will save like Doom.)' },
      { level: 3,  key: 'deathsgift',      name: "Death's Gift",      kind: 'passive', resist: (l) => ({ cold: l >= 9 ? 10 : 5 }), desc: 'Cold resistance 5 (10 at 9), always on. (DR vs nonlethal not modelled — no nonlethal damage here.)' },
      { level: 9,  key: 'graspofthedead',  name: 'Grasp of the Dead', kind: 'blast',   dtype: 'slashing', maxTargets: 4, desc: 'Skeletal arms erupt from the ground: your level d6 slashing on up to 4 foes, Reflex half. Once per room (twice at 17, three times at 20).' },
      { level: 15, key: 'incorporealform', name: 'Incorporeal Form',  kind: 'todo',    desc: 'Become incorporeal for level rounds, 1/day. Not in the engine yet.' },
      { level: 20, key: 'oneofthedead',    name: 'One of the Dead',   kind: 'passive', immune: ['cold'], dr: R(5), desc: 'Immune to cold; DR 5/—. Always on. (Immunity to paralysis, sleep and nonlethal not modelled.)' },
    ],
    spells: { 3: ['chilltouch'], 5: ['falselife'], 7: ['vampirictouch'], 9: ['animatedead'], 11: ['wavesfatigue', 'wavesoffatigue'], 13: ['undeathtodeath'], 15: ['fingerofdeath'], 17: ['horridwilting'], 19: ['energydrain'] },
  },
};

const BLOODLINE_KEYS = Object.keys(BLOODLINES);
/** Normalize any stored value to a real bloodline key or 'none'. */
const bloodlineKey = (k) => (k && BLOODLINES[String(k).toLowerCase()]) ? String(k).toLowerCase() : 'none';
const bloodlineName = (k) => (BLOODLINES[bloodlineKey(k)] || {}).name || 'None';
/** Picker rows for the lobby (pf1meta): key, name, icon, blurb, the power names by level. */
function bloodlineList() {
  return [{ key: 'none', name: 'None (no bloodline)', icon: '—', blurb: 'The engine’s old model: one extra free spell pick per spell level, no powers.' }]
    .concat(BLOODLINE_KEYS.map(k => { const b = BLOODLINES[k]; return { key: k, name: b.name, icon: b.icon, blurb: b.blurb, powers: b.powers.map(p => `${p.level}: ${p.name}${p.kind === 'todo' ? ' (not yet)' : ''}`) }; }));
}
/** Which classes pick a bloodline. (The bloodrager keeps its Bloodline Surge until Toby rules — question 11.) */
const bloodlineClasses = ['sorcerer'];

module.exports = { BLOODLINES, BLOODLINE_KEYS, bloodlineKey, bloodlineName, bloodlineList, bloodlineClasses };
