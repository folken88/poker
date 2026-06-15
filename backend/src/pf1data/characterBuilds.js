/**
 * pf1data/characterBuilds.js — per-character RACE + optional individualized
 * ability build. Re-synced into the DB at boot (see db.js seedRoster), exactly
 * like BOT_CLASSES/BOT_WEAPONS — this file is the source of truth.
 *
 * Keyed by the character's display name (case-insensitive → player_id).
 *   race   — a key from pf1data/races.js (default 'none' = no mods when absent)
 *   flex   — for a FLEX race (human/half-elf/half-orc), the ability that takes
 *            the floating +2 (e.g. 'str'). Omit to auto-pick the highest stat.
 *   scores — OPTIONAL hand-authored 25-pt base array {str,dex,con,int,wis,cha}
 *            that OVERRIDES the class template (seedScores). Templates remain
 *            the fallback for anyone without `scores`.
 *
 * NOTE on creature TEMPLATES (lich/ghost/vampire/graveknight): race here is the
 * BASE race only. The undead overlay (positive energy does nothing, etc.) is
 * handled by Dungeon.UNDEAD_HEROES (tar baphon/auren vrood/vesorianna/farrus/
 * toni). Full template mechanics (DR, energy drain…) are a later sub-feature.
 */

const BUILDS = {
  // ── Templated undead (race = base race; template handled in UNDEAD_HEROES) ──
  'Tar Baphon':              { race: 'human', flex: 'int' },   // + lich
  'Auren Vrood':             { race: 'human', flex: 'int' },   // + lich
  'Vesorianna':              { race: 'human', flex: 'cha' },   // + ghost
  'Toni':                    { race: 'human', flex: 'int' },   // + vampire
  'Farrus Richton':          { race: 'human', flex: 'str' },   // + graveknight

  // ── Humans (floating +2 pinned per character) ──
  'Sirona':                  { race: 'human', flex: 'str' },
  'Gaspar':                  { race: 'human', flex: 'str' },
  'Kate Blackwood':          { race: 'human', flex: 'int' },
  'Dismas':                  { race: 'human', flex: 'dex' },
  'Estovion':                { race: 'human', flex: 'int' },
  'Farrah':                  { race: 'human', flex: 'cha' },
  'Tamsin':                  { race: 'human', flex: 'cha' },
  'Concetta':                { race: 'human', flex: 'dex' },
  'Rodney Smith':            { race: 'human', flex: 'dex' },
  'Chef':                    { race: 'human', flex: 'dex' },
  'Lirienne':                { race: 'human', flex: 'dex' },
  'Duristan Silvio':         { race: 'human', flex: 'cha' },
  'Vaughan':                 { race: 'human', flex: 'dex' },
  'Holden':                  { race: 'human', flex: 'dex' },
  'El Guapo':                { race: 'human', flex: 'dex' },

  // ── Half-orc / half-elf (floating +2 pinned) ──
  'Tokala':                  { race: 'half_orc', flex: 'str' },
  'Kai Ginn':                { race: 'half_orc', flex: 'dex' },
  'Agu':                     { race: 'half_elf', flex: 'dex' },

  // ── Fixed-mod races ──
  'Storgrim Thunderbeard':   { race: 'dwarf' },
  'Kelda':                   { race: 'dwarf' },
  'Ulfred':                  { race: 'dwarf' },
  'Conchobar':               { race: 'gnome' },
  'Lou Candlebean':          { race: 'gnome' },
  'Elodie':                  { race: 'gnome' },
  'Mr. Brow':                { race: 'gnome' },
  'Gabriel':                 { race: 'aasimar' },
  'Dinvaya':                 { race: 'aasimar' },   // this version (canon she was a half-elf)
  'Fera':                    { race: 'halfling' },
  'Kovira':                  { race: 'tiefling' },
  'Taelys':                  { race: 'tiefling' },
  'Rhyarca':                 { race: 'drow' },
  'Nomkath':                 { race: 'catfolk' },
  'Elfrip':                  { race: 'goblin' },
  'Ser Toche':               { race: 'tengu' },
  'Rissa':                   { race: 'leshy' },     // plant person
  'Bujon, Storm of Cheliax': { race: 'iku_turso' },   // eel-like aberration; Blindsense 30 ft (invisibility never works on him)
  'Casandalee':              { race: 'android' },
  'Meyanda':                 { race: 'android' },
  'Vorkstag':                { race: 'skinwalker' },
  'Crisp':                   { race: 'animal' },     // deinonychus — natural attacks via 'bite' weapon
};

module.exports = { BUILDS };
