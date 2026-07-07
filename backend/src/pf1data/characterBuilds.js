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
  'Olbryn':                  { race: 'drow' },     // Josh's Drow storm-sorcerer (Iron Gods) — Dex+2/Cha+2/Con−2, darkvision 120, SR, light blindness
  'Casandalee':              { race: 'android' },
  'Meyanda':                 { race: 'android' },
  'Vorkstag':                { race: 'skinwalker' },
  'Crisp':                   { race: 'animal' },     // deinonychus — natural attacks via 'bite' weapon

  // ── Hell's Vengeance / Rebels PCs → playable AI-heroes (2026-07-05) ──
  'Femmik Embersword':       { race: 'ifrit' },      // Dervish Dancer bard (DEX/CHA); Ifrit +2 Dex/+2 Cha/−2 Wis matches his real WIS 7
  'Freya Kusanagi':          { race: 'half_elf', flex: 'str' },   // Samurai/Hellknight — STR 26 bruiser; floating +2 into STR
  "J'Mal":                   { race: 'hobgoblin' },  // Red Mantis Assassin / Rogue — DEX finesse dual-saber + sneak
  'Jason':                   { race: 'tiefling' },   // Divine Scion / Cleric of Asmodeus — WIS caster (tiefling darkvision + resist)
  // Reese — Strix Eldritch-Archer magus. DEX-focused 25-pt build (his bow rides DEX,
  // not the magus template's default STR); INT for his spellstrike. Strix +2 Dex → 19.
  'Reese':                   { race: 'strix', scores: { str: 10, dex: 17, con: 14, int: 14, wis: 11, cha: 11 } },
  'Savage':                  { race: 'tiefling' },   // tiefling bloodrager — STR brute (class template handles the STR primary)
  'Draymus':                 { race: 'dhampir' },    // dhampir necromancer — INT caster (wizard template makes INT primary)
  'Azwraith':                { race: 'human' },       // human FIGHTER — STR bruiser (class template makes STR primary); reach fauchard trip-lord
  // Lord Gweyir — elf DEX cavalier duelist. Explicit scores so DEX (not the cavalier
  // template's default STR) is his attack stat; his finesse estoc rides Dex 18 (16 + elf +2).
  'Lord Gweyir':             { race: 'elf', scores: { str: 12, dex: 16, con: 12, int: 13, wis: 10, cha: 14 } },
};

module.exports = { BUILDS };
