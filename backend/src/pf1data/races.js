/**
 * pf1data/races.js — PF1 playable RACES (PURE data + pure helpers; no game state).
 *
 * Phase 1 of the races feature: each race carries its ability MODIFIERS, size,
 * speed, VISION, and racial SAVE bonuses (flat + typed), plus a human-readable
 * trait list. game/character.js already layers race mods onto the base array
 * (base -> +race -> +ASI); Dungeon.js reads vision + the save bonuses.
 *
 * Phase 2 will act on `size` (small-race AC/attack/CMB/damage dice) and add
 * racial spell-like abilities — for now `size` is descriptive only.
 *
 * `mods`  — flat ability adjustments ({dex:2,int:2,con:-2}).
 * `flex`  — a FLOATING +N to the character's best base ability (human/half-orc/
 *           half-elf "+2 to one ability"); resolved against the base array.
 * `saves` — racial save bonuses. `all` applies to every save; a TYPED key
 *           (spell/enchantment/fear/poison/illusion) applies only when the save
 *           is tagged with that category at the call site. Halfling = +1 all,
 *           +2 more vs fear (so +3 vs fear, stacking the two).
 */

const RACES = {
  // 'none' = race not yet assigned: NO ability mods, normal vision, no save
  // bonus. This is the DEFAULT, so characters are unchanged until a race is
  // deliberately assigned in characterBuilds.js (human's floating +2 is a real
  // choice, not a silent roster-wide buff).
  none:     { name: 'Unspecified', size: 'medium', speed: 30, vision: 'normal',                                     saves: {},                      traits: [] },
  human:    { name: 'Human',    flex: 2,                          size: 'medium', speed: 30, vision: 'normal',       saves: {},                      traits: ['+2 to one ability (best)', 'Bonus feat', 'Skilled'] },
  half_elf: { name: 'Half-Elf', flex: 2,                          size: 'medium', speed: 30, vision: 'low-light',    saves: { enchantment: 2 },      traits: ['+2 to one ability (best)', 'Immunity to magic sleep', '+2 vs enchantment', 'Low-light vision'] },
  half_orc: { name: 'Half-Orc', flex: 2,                          size: 'medium', speed: 30, vision: 'darkvision60', saves: {},                      traits: ['+2 to one ability (best)', 'Orc ferocity (fight on at 0 HP)', 'Darkvision 60'] },
  elf:      { name: 'Elf',      mods: { dex: 2, int: 2, con: -2 }, size: 'medium', speed: 30, vision: 'low-light',    saves: { enchantment: 2 },      traits: ['+2 DEX, +2 INT, −2 CON', 'Immunity to magic sleep', '+2 vs enchantment', 'Low-light vision'] },
  dwarf:    { name: 'Dwarf',    mods: { con: 2, wis: 2, cha: -2 }, size: 'medium', speed: 20, vision: 'darkvision60', saves: { poison: 2, spell: 2 }, traits: ['+2 CON, +2 WIS, −2 CHA', 'Hardy (+2 vs poison & spells)', 'Stability', 'Darkvision 60'] },
  halfling: { name: 'Halfling', mods: { dex: 2, cha: 2, str: -2 }, size: 'small',  speed: 20, vision: 'normal',       saves: { all: 1, fear: 2 },     traits: ['+2 DEX, +2 CHA, −2 STR', 'Halfling luck (+1 all saves)', 'Fearless (+2 more vs fear)', 'Small'] },
  gnome:    { name: 'Gnome',    mods: { con: 2, cha: 2, str: -2 }, size: 'small',  speed: 20, vision: 'low-light',    saves: { illusion: 2 },         traits: ['+2 CON, +2 CHA, −2 STR', '+2 vs illusions', 'Defensive training vs giants', 'Small', 'Low-light vision'] },
  kobold:   { name: 'Kobold',   mods: { dex: 2, str: -4, con: -2 }, size: 'small', speed: 30, vision: 'darkvision60', saves: {},                      traits: ['+2 DEX, −4 STR, −2 CON', '+1 natural armor', 'Small', 'Darkvision 60'] },
  orc:      { name: 'Orc',      mods: { str: 4, int: -2, wis: -2, cha: -2 }, size: 'medium', speed: 30, vision: 'darkvision60', saves: {},          traits: ['+4 STR, −2 INT/WIS/CHA', 'Orc ferocity', 'Darkvision 60'] },
  tiefling: { name: 'Tiefling', mods: { dex: 2, int: 2, cha: -2 }, size: 'medium', speed: 30, vision: 'darkvision60', saves: {},                     traits: ['+2 DEX, +2 INT, −2 CHA', 'Fire/cold/electricity resist 5', 'Darkvision 60'] },
  aasimar:  { name: 'Aasimar',  mods: { wis: 2, cha: 2 },          size: 'medium', speed: 30, vision: 'darkvision60', saves: {},                     traits: ['+2 WIS, +2 CHA', 'Acid/cold/electricity resist 5', 'Darkvision 60'] },
  // ── Extended roster races (Folken cast) ──────────────────────────────────
  drow:     { name: 'Drow',     mods: { dex: 2, cha: 2, con: -2 }, size: 'medium', speed: 30, vision: 'darkvision120', srBase: 6, saves: { enchantment: 2 },  traits: ['+2 DEX, +2 CHA, −2 CON', 'Spell resistance 6 + level', '+2 vs enchantment', 'Darkvision 120', 'Light blindness'] },
  catfolk:  { name: 'Catfolk',  mods: { dex: 2, cha: 2, wis: -2 }, size: 'medium', speed: 30, vision: 'low-light',     saves: {},                     traits: ['+2 DEX, +2 CHA, −2 WIS', 'Cat’s luck', 'Low-light vision'] },
  goblin:   { name: 'Goblin',   mods: { dex: 4, str: -2, cha: -2 }, size: 'small', speed: 30, vision: 'darkvision60',  saves: {},                     traits: ['+4 DEX, −2 STR, −2 CHA', 'Small', 'Darkvision 60'] },
  tengu:    { name: 'Tengu',    mods: { dex: 2, wis: 2, con: -2 }, size: 'medium', speed: 30, vision: 'low-light',     saves: {},                     traits: ['+2 DEX, +2 WIS, −2 CON', 'Swordtrained', 'Gifted linguist', 'Low-light vision'] },
  gillman:  { name: 'Gillman',  mods: { con: 2, cha: 2, wis: -2 }, size: 'medium', speed: 30, vision: 'low-light',     saves: {},                     traits: ['+2 CON, +2 CHA, −2 WIS', 'Amphibious', 'Enchantment resistance (aboleths)', 'Low-light vision'] },
  // Iku-Turso — an aberration (Bujon). No PC ability adjustments; its key trait
  // is Blindsense 30 ft, so invisibility/darkness can't hide a foe from it.
  iku_turso: { name: 'Iku-Turso',                                   size: 'large',  speed: 20, vision: 'darkvision60', blindsense: 30, saves: {},     traits: ['Aberration (no racial ability adjustments)', 'Blindsense 30 ft — pinpoints unseen foes; invisibility & darkness fail against it', 'Amphibious', 'Darkvision 60'] },
  android:  { name: 'Android',  mods: { dex: 2, int: 2, cha: -2 }, size: 'medium', speed: 30, vision: 'darkvision60',  saves: {},                     traits: ['+2 DEX, +2 INT, −2 CHA', 'Constructed (immune to mind-affecting fear/morale, disease, exhaustion)', 'Darkvision 60'] },
  skinwalker: { name: 'Skinwalker', mods: { wis: 2, cha: -2 },     size: 'medium', speed: 30, vision: 'low-light',     saves: {},                     traits: ['+2 WIS, −2 CHA', 'Change shape (beast-form)', 'Low-light vision'] },
  leshy:    { name: 'Leshy',    mods: { con: 2, wis: 2, cha: -2 }, size: 'small',  speed: 20, vision: 'low-light',     saves: {},                     traits: ['+2 CON, +2 WIS, −2 CHA', 'Plant (immune to mind-affecting — Phase 2)', 'Small', 'Low-light vision'] },
  animal:   { name: 'Animal',                                       size: 'medium', speed: 40, vision: 'low-light',     saves: {},                     traits: ['No racial ability adjustments (not a humanoid race)', 'Natural attacks (via weapon)', 'Low-light vision', 'Scent'] },
  // Ifrit — fire-touched Geniekin (Femmik). Fire resist 5; the −2 WIS shows in his headlong style.
  ifrit:    { name: 'Ifrit',    mods: { dex: 2, cha: 2, wis: -2 }, size: 'medium', speed: 30, vision: 'darkvision60',  saves: {},                     traits: ['+2 DEX, +2 CHA, −2 WIS', 'Fire resistance 5', 'Darkvision 60'] },
  // Hobgoblin — disciplined goblinoid soldiers (J'Mal). Tough and quick.
  hobgoblin:{ name: 'Hobgoblin', mods: { dex: 2, con: 2 },          size: 'medium', speed: 30, vision: 'darkvision60',  saves: {},                     traits: ['+2 DEX, +2 CON', 'Darkvision 60'] },
  // Strix — winged nocturnal humanoids (Reese). Their flight is a PHYSICAL pair of
  // wings, not a spell: it is INNATE and can never be dispelled (see raceFly + the
  // member build in Dungeon.js). `fly` = the innate fly speed in feet.
  strix:    { name: 'Strix',    mods: { dex: 2, cha: -2 },          size: 'medium', speed: 30, fly: 60, vision: 'darkvision60', saves: {},               traits: ['+2 DEX, −2 CHA', 'Winged — innate fly 60 ft (real wings; CANNOT be dispelled)', 'Nocturnal', 'Darkvision 60'] },
  // Dhampir — the half-living dhampir (Draymus). A humanoid with the DHAMPIR subtype:
  // negative energy heals it and positive energy harms it (like the undead), immune to
  // disease & magical sleep, +2 vs disease/mind-affecting. Darkvision 60. NOTE: the
  // negative-energy-healing quirk is described here but NOT yet mechanically applied to
  // heroes (he heals normally in-game for now, so the party cleric can still keep him up).
  dhampir:  { name: 'Dhampir',  mods: { dex: 2, cha: 2, con: -2 }, size: 'medium', speed: 30, vision: 'darkvision60',  saves: {},                     traits: ['+2 DEX, +2 CHA, −2 CON', 'Negative energy heals, positive harms (dhampir)', 'Immune to disease & magical sleep', '+2 vs disease & mind-affecting', 'Darkvision 60'] },
};

const DEFAULT_RACE = 'none';   // unassigned → no racial mods (zero change until a race is chosen)
const ABILITY_ORDER = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/** Normalize/validate a race key; unknown → 'human'. */
function raceKey(k) { return RACES[k] ? k : DEFAULT_RACE; }
function raceFor(k) { return RACES[raceKey(k)]; }

/** The flat ability-mod object for a race, resolving a FLOATING +N (human et al.)
 *  against the character's base array — the +N lands on the highest base score
 *  (ties broken by ABILITY_ORDER), mirroring "put your racial +2 in your prime
 *  stat". Returns a fresh object; safe to pass straight to deriveCharacter. */
function raceModsFor(k, baseScores, flexStat) {
  const r = raceFor(k);
  if (r.mods) return { ...r.mods };
  if (r.flex) {
    // A floating +N (human/half-elf/half-orc): land it on the EXPLICIT choice
    // (characterBuilds `flex`), else on the highest base ability.
    if (flexStat && ABILITY_ORDER.includes(flexStat)) return { [flexStat]: r.flex };
    const base = baseScores || {};
    let best = ABILITY_ORDER[0], bestVal = -Infinity;
    for (const a of ABILITY_ORDER) {
      const v = base[a] != null ? base[a] : 10;
      if (v > bestVal) { bestVal = v; best = a; }   // first wins ties (ABILITY_ORDER)
    }
    return { [best]: r.flex };
  }
  return {};
}

/** Racial save bonus for a save tagged with `tags` (array or single string).
 *  `all` always applies; typed bonuses apply only for matching tags. */
function raceSaveBonus(k, tags) {
  const s = raceFor(k).saves || {};
  let b = s.all || 0;
  const list = Array.isArray(tags) ? tags : (tags ? [tags] : []);
  for (const t of list) if (s[t]) b += s[t];
  return b;
}

function raceBlindsense(k) { return raceFor(k).blindsense || 0; }
/** Innate racial FLY speed in feet (Strix = 60). 0 = no innate flight. Real wings:
 *  the member gets `flying` at build time and it is NEVER a dispellable buff. */
function raceFly(k) { return raceFor(k).fly || 0; }
/** Racial SPELL RESISTANCE at a given level (PF1 drow: SR 6 + class levels).
 *  0 = none. Hostile spells must win a caster-level check (d20+CL) vs this;
 *  friendly casts assume the PF1 "lower your SR voluntarily" standard action. */
function raceSR(k, level) { const b = raceFor(k).srBase; return b != null ? b + (level || 1) : 0; }
function raceVision(k) { return raceFor(k).vision || 'normal'; }
function raceSize(k)   { return raceFor(k).size || 'medium'; }
function raceName(k)   { return raceFor(k).name || 'Human'; }
function raceTraits(k) { return raceFor(k).traits || []; }
function raceList()    { return Object.keys(RACES).map(k => ({ key: k, name: RACES[k].name })); }

module.exports = {
  RACES, DEFAULT_RACE, raceKey, raceFor, raceModsFor, raceSaveBonus,
  raceVision, raceSize, raceName, raceTraits, raceList, raceBlindsense, raceSR, raceFly,
};
