// pf1data/domains.js — Cleric & Inquisitor DOMAINS (Phase A: data only).
// Per DOMAINS-DESIGN.md (approved 2026-06-28): a CLERIC picks TWO domains and
// gets each granted POWER plus the domain SPELLS (they fill the +1 domain slot
// per level clerics already receive); an INQUISITOR picks ONE domain and gets
// the granted power ONLY. Choices persist per class and change between rooms,
// never mid-room. Every power respects its PF1 usage limit — "per day" = per
// ROOM (the game's day), so `3plusWis` stocks 3 + Wis mod uses per room and
// `level-rounds` stocks caster-level rounds per room (Liberation auto-fires).
// Phase B wires the runtime handlers (granted.kind), Phase C the picker UI.
//
// granted.kind (runtime vocabulary): fom | attackbuff | smite | reroll |
//   saveward | healboost | sunvuln | bleed
// granted.limit: 'level-rounds' | '3plusWis' | 'passive'
// spells: spell level → an IMPLEMENTED spell key (cleric domain spells only).

const DOMAINS = {
  liberation: {
    key: 'liberation', name: 'Liberation', icon: '🕊️',
    blurb: 'Freedom of movement — no grapple, hold or snare can bind you.',
    granted: { kind: 'fom', name: 'Freedom of Movement', limit: 'level-rounds', auto: true },
    spells: { 2: 'removeparalysis', 3: 'dispelmagic', 6: 'dispelmagicgreater' },
  },
  strength: {
    key: 'strength', name: 'Strength', icon: '💪',
    blurb: 'Might of the faithful — surge power into your next blow.',
    granted: { kind: 'attackbuff', name: 'Strength Surge', limit: '3plusWis', auto: false },
    spells: { 2: 'bullsstrength', 5: 'righteousmight' },
  },
  war: {
    key: 'war', name: 'War', icon: '⚔️',
    blurb: 'The battle-blessing — a smiting strike guided by your god.',
    granted: { kind: 'smite', name: 'Battle Rage', limit: '3plusWis', auto: false },
    spells: { 4: 'divinepower', 5: 'flamestrike' },
  },
  luck: {
    key: 'luck', name: 'Luck', icon: '🍀',
    blurb: 'Fortune favors you — reroll a miss or a failed save.',
    granted: { kind: 'reroll', name: 'Good Fortune', limit: '3plusWis', auto: false },
    spells: { 2: 'protevil' },
  },
  protection: {
    key: 'protection', name: 'Protection', icon: '🛡️',
    blurb: 'The ward of the faithful — resistance against every blow.',
    granted: { kind: 'saveward', name: 'Resistant Touch', limit: '3plusWis', auto: false },
    spells: { 1: 'shieldoffaith', 2: 'protevil', 4: 'protectfire' },
  },
  healing: {
    key: 'healing', name: 'Healing', icon: '💗',
    blurb: 'The mercy of your god — your cures and channels run deeper.',
    granted: { kind: 'healboost', name: "Healer's Blessing", limit: 'passive', auto: false },
    spells: { 1: 'curelight', 2: 'curemoderate', 3: 'cureserious', 4: 'curecritical', 6: 'healspell', 9: 'massheal' },
  },
  sun: {
    key: 'sun', name: 'Sun', icon: '☀️',
    blurb: 'Daylight made wrath — the undead wither before you.',
    granted: { kind: 'sunvuln', name: "Sun's Blessing", limit: 'passive', auto: false },
    spells: { 3: 'searinglight', 8: 'sunburst' },
  },
  death: {
    key: 'death', name: 'Death', icon: '💀',
    blurb: 'The last breath — your touch leaves wounds that will not close.',
    granted: { kind: 'bleed', name: 'Bleeding Touch', limit: '3plusWis', auto: false },
    spells: { 5: 'slayliving' },
  },
  trickery: {
    key: 'trickery', name: 'Trickery', icon: '🎭',
    blurb: 'Misdirection made real — conjure shimmering decoys that soak blows.',
    granted: { kind: 'copycat', name: 'Copycat', limit: '3plusWis', auto: false },
    spells: { 1: 'disguiseself', 2: 'invisibility', 3: 'nondetection' },
  },
  // Fire — the hellfire domain (Asmodeus / Jason). Its blessing is an offensive
  // burning strike (rides the 'smite' power) and its spells are pure flame.
  fire: {
    key: 'fire', name: 'Fire', icon: '🔥',
    blurb: 'Wrath made flame — your blows are wreathed in searing fire.',
    granted: { kind: 'smite', name: 'Fire Bolt', limit: '3plusWis', auto: false },
    spells: { 1: 'burninghands', 2: 'scorchingray', 3: 'fireball', 5: 'flamestrike' },
  },
  // Law — Hell's iron order (Asmodeus / Jason). Touch of Law steadies fate (a
  // fortune reroll), and its spells enforce order and dispel the chaotic.
  law: {
    key: 'law', name: 'Law', icon: '⚖️',
    blurb: 'The letter of the contract — impose order, reroll fickle fate.',
    granted: { kind: 'reroll', name: 'Touch of Law', limit: '3plusWis', auto: false },
    spells: { 1: 'shieldoffaith', 3: 'protevil', 4: 'dispelmagic' },
  },
};

const DOMAIN_KEYS = Object.keys(DOMAINS);
// Defaults when a player has never picked: the powers Tim/Josh already rely on.
const DEFAULTS = { inquisitor: ['liberation'], cleric: ['healing', 'war'] };
// Per-CHARACTER domain defaults (override the class default until they pick).
const CHAR_DOMAINS = { binch: ['trickery', 'liberation'], jason: ['fire', 'law'] };   // Jason: cleric of Asmodeus — hellfire + Hell's iron law
const maxDomainsFor = (cls) => cls === 'cleric' ? 2 : cls === 'inquisitor' ? 1 : 0;

module.exports = { DOMAINS, DOMAIN_KEYS, DEFAULTS, CHAR_DOMAINS, maxDomainsFor };
