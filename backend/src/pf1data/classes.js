/**
 * Pathfinder 1e Paizo BASE classes (no archetypes). Source: PF1 SRD / Archives
 * of Nethys (open content). Each entry carries the bits the game needs now —
 * Hit Die, BAB progression, and the three save progressions — with room to grow
 * (class features / spellcasting) as we layer in more PF1 detail.
 *
 *   bab:  'full'  → BAB = level
 *         '3/4'   → BAB = floor(level * 3 / 4)
 *         '1/2'   → BAB = floor(level / 2)
 *   saves: 'good' → floor(level/2) + 2     'poor' → floor(level/3)
 */
const CLASSES = {
  // ---- Core Rulebook ----
  barbarian:    { name: 'Barbarian',    hd: 12, bab: 'full', fort: 'good', ref: 'poor', will: 'poor' },
  bard:         { name: 'Bard',         hd: 8,  bab: '3/4',  fort: 'poor', ref: 'good', will: 'good' },
  cleric:       { name: 'Cleric',       hd: 8,  bab: '3/4',  fort: 'good', ref: 'poor', will: 'good' },
  druid:        { name: 'Druid',        hd: 8,  bab: '3/4',  fort: 'good', ref: 'poor', will: 'good' },
  fighter:      { name: 'Fighter',      hd: 10, bab: 'full', fort: 'good', ref: 'poor', will: 'poor' },
  monk:         { name: 'Monk',         hd: 8,  bab: '3/4',  fort: 'good', ref: 'good', will: 'good' },
  paladin:      { name: 'Paladin',      hd: 10, bab: 'full', fort: 'good', ref: 'poor', will: 'good' },
  antipaladin:  { name: 'Antipaladin',  hd: 10, bab: 'full', fort: 'good', ref: 'poor', will: 'good' },
  ranger:       { name: 'Ranger',       hd: 10, bab: 'full', fort: 'good', ref: 'good', will: 'poor' },
  rogue:        { name: 'Rogue',        hd: 8,  bab: '3/4',  fort: 'poor', ref: 'good', will: 'poor' },
  sorcerer:     { name: 'Sorcerer',     hd: 6,  bab: '1/2',  fort: 'poor', ref: 'poor', will: 'good' },
  wizard:       { name: 'Wizard',       hd: 6,  bab: '1/2',  fort: 'poor', ref: 'poor', will: 'good' },
  // ---- Advanced Player's Guide ----
  alchemist:    { name: 'Alchemist',    hd: 8,  bab: '3/4',  fort: 'good', ref: 'good', will: 'poor' },
  cavalier:     { name: 'Cavalier',     hd: 10, bab: 'full', fort: 'good', ref: 'poor', will: 'poor' },
  inquisitor:   { name: 'Inquisitor',   hd: 8,  bab: '3/4',  fort: 'good', ref: 'poor', will: 'good' },
  oracle:       { name: 'Oracle',       hd: 8,  bab: '3/4',  fort: 'poor', ref: 'poor', will: 'good' },
  summoner:     { name: 'Summoner',     hd: 8,  bab: '3/4',  fort: 'poor', ref: 'poor', will: 'good' },
  witch:        { name: 'Witch',        hd: 6,  bab: '1/2',  fort: 'poor', ref: 'poor', will: 'good' },
  // ---- Ultimate Magic / Combat ----
  magus:        { name: 'Magus',        hd: 8,  bab: '3/4',  fort: 'good', ref: 'poor', will: 'good' },
  gunslinger:   { name: 'Gunslinger',   hd: 10, bab: 'full', fort: 'good', ref: 'good', will: 'poor' },
  ninja:        { name: 'Ninja',        hd: 8,  bab: '3/4',  fort: 'poor', ref: 'good', will: 'poor' },
  samurai:      { name: 'Samurai',      hd: 10, bab: 'full', fort: 'good', ref: 'poor', will: 'poor' },
  // ---- Advanced Class Guide (hybrids) ----
  arcanist:     { name: 'Arcanist',     hd: 6,  bab: '1/2',  fort: 'poor', ref: 'poor', will: 'good' },
  bloodrager:   { name: 'Bloodrager',   hd: 10, bab: 'full', fort: 'good', ref: 'poor', will: 'poor' },
  brawler:      { name: 'Brawler',      hd: 10, bab: 'full', fort: 'good', ref: 'good', will: 'poor' },
  hunter:       { name: 'Hunter',       hd: 8,  bab: '3/4',  fort: 'good', ref: 'good', will: 'poor' },
  investigator: { name: 'Investigator', hd: 8,  bab: '3/4',  fort: 'poor', ref: 'good', will: 'good' },
  shaman:       { name: 'Shaman',       hd: 8,  bab: '3/4',  fort: 'poor', ref: 'poor', will: 'good' },
  skald:        { name: 'Skald',        hd: 8,  bab: '3/4',  fort: 'good', ref: 'poor', will: 'good' },
  slayer:       { name: 'Slayer',       hd: 10, bab: 'full', fort: 'good', ref: 'good', will: 'poor' },
  swashbuckler: { name: 'Swashbuckler', hd: 10, bab: 'full', fort: 'good', ref: 'good', will: 'poor' },
  warpriest:    { name: 'Warpriest',    hd: 8,  bab: '3/4',  fort: 'good', ref: 'poor', will: 'good' },
  // ---- Occult Adventures ----
  kineticist:   { name: 'Kineticist',   hd: 8,  bab: '3/4',  fort: 'good', ref: 'good', will: 'poor' },
  medium:       { name: 'Medium',       hd: 8,  bab: '3/4',  fort: 'poor', ref: 'poor', will: 'good' },
  mesmerist:    { name: 'Mesmerist',    hd: 8,  bab: '3/4',  fort: 'poor', ref: 'good', will: 'good' },
  occultist:    { name: 'Occultist',    hd: 8,  bab: '3/4',  fort: 'good', ref: 'poor', will: 'good' },
  psychic:      { name: 'Psychic',      hd: 6,  bab: '1/2',  fort: 'poor', ref: 'poor', will: 'good' },
  spiritualist: { name: 'Spiritualist', hd: 8,  bab: '3/4',  fort: 'good', ref: 'poor', will: 'good' },
  vigilante:    { name: 'Vigilante',    hd: 8,  bab: '3/4',  fort: 'poor', ref: 'good', will: 'good' },
  // ---- 3rd-party (Kobold Press, Open Design) ----
  theurge:      { name: 'Theurge',      hd: 6,  bab: '1/2',  fort: 'poor', ref: 'poor', will: 'good' },   // dual arcane+divine PREPARED caster (Celeb of Nethys) — glass cannon, no armor
};

const DEFAULT_CLASS = 'fighter';

// ── Weapon proficiency by class ─────────────────────────────────────────────
// `cats` = the proficiency categories a class is trained in ('simple',
// 'martial', 'exotic'); `weapons` = extra specific staple keys granted on top
// (a class's signature / deity-favored picks). A weapon is wielded proficiently
// if its proficiency category is in `cats` OR its key is listed in `weapons`.
// Wielding a NON-proficient weapon is −4 to hit (NON_PROFICIENT_PENALTY).
// Full arcane casters are deliberately restricted — a wizard is NOT proficient
// with a greatsword. Unarmed strikes are universal (handled in code).
const _MARTIAL = ['simple', 'martial'];
const _ALL     = ['simple', 'martial', 'exotic'];   // fighters/rangers/paladins: everything
const _SIMPLE  = ['simple'];
const PROFICIENCY = {
  // Fighter / Ranger / Paladin are proficient with ALL weapons, even exotics.
  fighter: { cats: _ALL }, ranger: { cats: _ALL }, paladin: { cats: _ALL },
  antipaladin: { cats: _MARTIAL }, barbarian: { cats: _MARTIAL }, cavalier: { cats: _MARTIAL },
  bloodrager: { cats: _MARTIAL }, brawler: { cats: _MARTIAL }, slayer: { cats: _MARTIAL },
  gunslinger: { cats: _MARTIAL }, swashbuckler: { cats: _MARTIAL }, magus: { cats: _MARTIAL },
  skald: { cats: _MARTIAL }, hunter: { cats: _MARTIAL }, vigilante: { cats: _MARTIAL },
  medium: { cats: _MARTIAL }, warpriest: { cats: _MARTIAL },
  samurai: { cats: _MARTIAL, weapons: ['katana'] },
  // Rogues + inquisitors get full simple + martial proficiency (per request).
  rogue: { cats: _MARTIAL }, inquisitor: { cats: _MARTIAL },
  // Simple + a few signature / deity-favored martial picks.
  bard: { cats: _SIMPLE, weapons: ['longsword', 'rapier', 'shortsword', 'whip'] },
  ninja: { cats: _SIMPLE, weapons: ['katana', 'shortsword'] },
  investigator: { cats: _SIMPLE, weapons: ['rapier', 'shortsword'] },
  mesmerist: { cats: _SIMPLE, weapons: ['rapier', 'shortsword', 'whip'] },
  cleric: { cats: _SIMPLE, weapons: ['warhammer'] },        // deity-favored stand-in
  // Simple weapons only.
  sorcerer: { cats: _SIMPLE }, oracle: { cats: _SIMPLE }, shaman: { cats: _SIMPLE },
  alchemist: { cats: _SIMPLE }, summoner: { cats: _SIMPLE }, kineticist: { cats: _SIMPLE },
  occultist: { cats: _SIMPLE }, spiritualist: { cats: _SIMPLE }, witch: { cats: _SIMPLE },
  arcanist: { cats: _SIMPLE }, psychic: { cats: _SIMPLE }, theurge: { cats: _SIMPLE },
  // Restricted specific lists (NOT all simple).
  wizard: { cats: [], weapons: ['dagger', 'quarterstaff'] },
  druid:  { cats: [], weapons: ['dagger', 'quarterstaff', 'scimitar', 'longspear'] },
  monk:   { cats: [], weapons: ['dagger', 'quarterstaff', 'longspear'] },
};
const NON_PROFICIENT_PENALTY = -4;

// HOME-RULE: one-handed EXOTIC blades that any martially-capable warrior can pick
// up and swing well. Full-BAB and 3/4-BAB classes (fighters … through rogues and
// clerics — i.e. everyone but the 1/2-BAB arcane casters) treat these as if they
// had the Exotic Weapon Proficiency feat: NO −4 penalty, and wielded ONE-HANDED
// so they still benefit from a shield. (Gaspar's Curator is a custom bastard
// sword and is always proficient via the `custom` flag below.)
const EXOTIC_ONEHAND_FREE = new Set(['bastardsword', 'katana']);

/** Is `staple` (a staple weapon object with .key/.prof, or a bare key) wielded
 *  proficiently by `classKey`? Unarmed is universal; unknown classes default to
 *  full martial proficiency so we never wrongly penalize. */
function weaponProficient(classKey, staple) {
  if (!staple) return true;
  const key  = typeof staple === 'string' ? staple : staple.key;
  const prof = typeof staple === 'string' ? null   : staple.prof;
  if (key === 'unarmed') return true;
  if (staple && staple.custom) return true;   // a named NPC signature weapon — always proficient
  const p = PROFICIENCY[classKey] || { cats: _MARTIAL };
  if (prof && (p.cats || []).includes(prof)) return true;
  if ((p.weapons || []).includes(key)) return true;
  // Home-rule exotic one-handers: granted to full & 3/4 BAB classes for free.
  if (EXOTIC_ONEHAND_FREE.has(key)) {
    const bab = (CLASSES[classKey] || {}).bab;
    if (bab === 'full' || bab === '3/4') return true;
  }
  return false;
}

/** Base Attack Bonus for a class at a given level. */
function babFor(classKey, level) {
  const c = CLASSES[classKey] || CLASSES[DEFAULT_CLASS];
  const lvl = Math.max(1, level | 0);
  if (c.bab === 'full') return lvl;
  if (c.bab === '1/2')  return Math.floor(lvl / 2);
  return Math.floor(lvl * 3 / 4);     // 3/4
}

/** Base save bonus for one of fort/ref/will at a given level. */
function saveFor(classKey, which, level) {
  const c = CLASSES[classKey] || CLASSES[DEFAULT_CLASS];
  const lvl = Math.max(1, level | 0);
  return c[which] === 'good' ? Math.floor(lvl / 2) + 2 : Math.floor(lvl / 3);
}

// ── Ability-score metadata (PF1 ability-priority builds) ────────────────────
// Each class supplies a DEFAULT ability PRIORITY (the order the 25-pt allocator
// spends 17/14/14/12 down — see pf1data/abilityScores.js), the class's CASTING
// ability (null for non-casters; a caster's stat must land at priority 1 or 2),
// and the ASI pattern cycled at every-4-levels increases (single-key classes
// bump one stat; MAD classes alternate two). Named characters override these in
// pf1data/characterProfiles.js (e.g. a finesse-weapon fighter leads with DEX).
const CASTING_ABILITY = {
  wizard: 'int', magus: 'int', arcanist: 'int', witch: 'int', alchemist: 'int', investigator: 'int', occultist: 'int', theurge: 'int',   // theurge is dual-stat: INT arcane + WIS divine; INT is the allocator-primary, per-spell dcStat picks the right one at cast time
  sorcerer: 'cha', bard: 'cha', paladin: 'cha', antipaladin: 'cha', oracle: 'cha', summoner: 'cha', skald: 'cha', bloodrager: 'cha', mesmerist: 'cha', psychic: 'cha', medium: 'cha',
  cleric: 'wis', druid: 'wis', ranger: 'wis', inquisitor: 'wis', warpriest: 'wis', hunter: 'wis', shaman: 'wis', spiritualist: 'wis',
  // martials & non-casters → null (kineticist uses CON for its blasts):
  kineticist: 'con',
};
const ABILITY_PRIORITY = {
  fighter:    ['str', 'con', 'dex', 'wis'],
  barbarian:  ['str', 'con', 'dex', 'wis'],
  paladin:    ['str', 'cha', 'con', 'dex'],
  antipaladin:['str', 'cha', 'con', 'dex'],
  ranger:     ['dex', 'str', 'con', 'wis'],   // archer default (melee rangers override)
  rogue:      ['dex', 'cha', 'con', 'wis'],
  monk:       ['dex', 'wis', 'con', 'str'],
  cleric:     ['wis', 'str', 'con', 'dex'],    // melee default (ranged clerics override → dex)
  druid:      ['wis', 'con', 'dex', 'str'],
  wizard:     ['int', 'dex', 'con', 'wis'],
  sorcerer:   ['cha', 'dex', 'con', 'wis'],
  bard:       ['cha', 'dex', 'con', 'wis'],
  magus:      ['str', 'int', 'con', 'dex'],    // gish: STR melee + INT casting (INT at P2)
  inquisitor: ['wis', 'str', 'con', 'dex'],
  oracle:     ['cha', 'con', 'dex', 'str'],
  swashbuckler: ['dex', 'cha', 'con', 'wis'],  // finesse + panache (CHA)
  investigator: ['int', 'dex', 'con', 'wis'],  // studied combat (INT)
  gunslinger:   ['dex', 'wis', 'con', 'cha'],  // DEX shooting + WIS grit
  theurge:      ['int', 'wis', 'con', 'dex'],  // dual caster — INT arcane (P1) + WIS divine (P2), both pumped (MAD)
  slayer:       ['dex', 'str', 'con', 'wis'],  // DEX-finesse hunter (Kai Ginn's DEX-riding fauchard); STR slayers override
};
const ASI_PATTERN = {
  fighter: ['str'], barbarian: ['str'], rogue: ['dex'], wizard: ['int'], sorcerer: ['cha'], druid: ['wis'],
  bard: ['cha', 'dex'],   // gish duelist — CHA casting + DEX finesse rapier (MAD spread)
  paladin: ['str', 'cha'], antipaladin: ['str', 'cha'], ranger: ['dex', 'str'], monk: ['dex', 'wis'],
  cleric: ['wis', 'str'], magus: ['str', 'int'], inquisitor: ['wis', 'str'], oracle: ['cha', 'con'],
  swashbuckler: ['dex', 'cha'], investigator: ['int', 'dex'],   // two-stat (MAD) — keep the 17/14/14/12 spread
  gunslinger: ['dex'],    // SAD — pump DEX (18/14/12 spread); guns hit touch AC anyway
  theurge: ['int', 'wis'],   // MAD dual caster — alternate INT (arcane) and WIS (divine)
  slayer: ['dex'],   // DEX-finesse hunter — pump DEX
};

/** The class's casting ability ('int'|'wis'|'cha'|'con') or null for non-casters. */
function castingAbilityFor(classKey) { return CASTING_ABILITY[classKey] || null; }
/** The class's DEFAULT ability priority order (used when a character has no override). */
function abilityPriorityFor(classKey) { return ABILITY_PRIORITY[classKey] || ['str', 'con', 'dex', 'wis']; }
/** The class's ASI pattern (cycled at every-4-levels). Defaults to the primary stat. */
function asiPatternFor(classKey) { return ASI_PATTERN[classKey] || [abilityPriorityFor(classKey)[0]]; }

module.exports = {
  CLASSES, DEFAULT_CLASS, babFor, saveFor, PROFICIENCY, NON_PROFICIENT_PENALTY, weaponProficient, EXOTIC_ONEHAND_FREE,
  CASTING_ABILITY, ABILITY_PRIORITY, ASI_PATTERN, castingAbilityFor, abilityPriorityFor, asiPatternFor,
};
