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
};

const DEFAULT_CLASS = 'fighter';

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

module.exports = { CLASSES, DEFAULT_CLASS, babFor, saveFor };
