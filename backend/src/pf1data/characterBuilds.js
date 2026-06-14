/**
 * pf1data/characterBuilds.js — per-character RACE + optional individualized
 * ability build. Re-synced into the DB at boot (see db.js seedRoster), exactly
 * like BOT_CLASSES/BOT_WEAPONS — this file is the source of truth.
 *
 * Keyed by the character's display name (case-insensitive → player_id).
 *   race   — a key from pf1data/races.js (default 'human' when absent)
 *   scores — an OPTIONAL hand-authored 25-pt base array {str,dex,con,int,wis,cha}.
 *            When present it OVERRIDES the class template (seedScores). When
 *            absent, the class template still derives the build as before — so
 *            TEMPLATES ARE NEVER REMOVED, they remain the fallback.
 *
 * Starts essentially empty so this lands with ZERO change to existing
 * characters. Add entries deliberately (a non-human race changes a character's
 * ability scores / HP / saves, so it's a balance decision per character).
 *
 * Example:
 *   'Crisp':  { race: 'kobold', scores: { str: 14, dex: 18, con: 12, int: 7, wis: 12, cha: 8 } },
 *   'Estovion': { race: 'elf' },     // race only → keeps the wizard template, +2 DEX/+2 INT/−2 CON applied
 */

const BUILDS = {
  // (intentionally empty — populate per character as races are assigned)
};

module.exports = { BUILDS };
