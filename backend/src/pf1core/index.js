/**
 * pf1core/index.js — THE one door to the PF1 rules engine (PF1CORE-PLAN.md,
 * Tobias 2026-07-04: "fix dispel magic 1 place and it is fixed in both apps").
 * Both apps — the poker dungeon today, the Personal GM (pgm.folkengames.com)
 * tomorrow — import rules ONLY through this façade. Everything behind it is
 * PURE: no persistence/, no sockets/, no poker anything (the test suite greps).
 *
 * Namespaces (by Pathfinder concept, per Tobias's organizing rule):
 *   abilities  — spell/kit data + slot tables (kitFor, slotsFor, CANTRIPS…)
 *   feats      — feat trees + gating + display tables (fighterFeats…)
 *   classes    — BAB/saves/HD/proficiency (babFor, saveFor, weaponProficient…)
 *   races      — racial mods/vision/saves/SR (raceModsFor, raceSR…)
 *   domains    — cleric/inquisitor domains (DOMAINS, maxDomainsFor…)
 *   monsters   — the bestiary + CR math (MON, crToNum, SIZE_RANK…)
 *   weapons    — weapon stats (weaponOf…)
 *   xp         — XP↔level tables (levelFromXp, xpForCR…)
 *   abilityScores — 25-pt builds, mods, ASI (applyRace, validateBuild…)
 *   loadouts   — prepared/known spell defaults + priority lists
 *   profiles   — per-class character templates
 *   character  — deriveCharacter + attackProfile (the stat engine)
 *   combat     — dice, AC math, sound pools (dRoll, acOf, SND…)
 *
 * NOT core (stays app-side): characterBuilds.js (the poker cast's authored
 * races/scores), staples.js (the poker shop), kits.generated.js (internal to
 * abilities — regenerate via the content-DB pipeline, never import directly).
 *
 * Step 2 (at PGM kickoff): the files physically move under pf1core/ and this
 * index becomes the package entry — imports already flow through it, so that
 * move is mechanical. 2026-07-04: façade created (step 1 of task #71).
 */
module.exports = {
  abilities: require('../pf1data/abilities'),
  feats: require('../pf1data/feats'),
  classes: require('../pf1data/classes'),
  races: require('../pf1data/races'),
  domains: require('../pf1data/domains'),
  monsters: require('../pf1data/monsters'),
  weapons: require('../pf1data/weapons'),
  xp: require('../pf1data/xp'),
  abilityScores: require('../pf1data/abilityScores'),
  loadouts: require('../pf1data/loadouts'),
  profiles: require('../pf1data/characterProfiles'),
  character: require('../game/character'),
  combat: require('../game/combat'),
};
