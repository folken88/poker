// pf1data/loadouts.js — DEFAULT spell loadouts (Phase B of SPELL-LOADOUTS-DESIGN.md).
//
// A character with no SAVED loadout falls back to a sensible default built here. The
// default is a curated, best-first priority order of Core-Rulebook staples per caster
// class (Tobias 2026-06-23: "curated CRB staples"). Only spells the game can actually
// RUN are eligible — i.e. each class's implemented kit (pf1data/abilities KITS) — so a
// default can never reference an unplayable spell.
//
//   • PREPARED casters (cleric/druid/wizard/paladin/ranger/antipaladin): the builder
//     fills each spell level's slots (slotsFor) with that level's highest-priority kit
//     spells, up to the slot count → { <slotLevel>: [spellKey, …] }.
//   • SPONTANEOUS casters (sorcerer/bard/oracle/inquisitor): there is no spells-KNOWN
//     cap table yet, so v1 default = the whole implemented kit in priority order (they
//     already cast their entire kit today — no regression) → [spellKey, …].
//
// Defaults are NOT persisted: db.js recomputes them for the character's CURRENT level,
// so leveling up auto-grows the default. Only player CUSTOMIZATIONS get stored.
const { KITS, slotsFor, SPONTANEOUS_CLASSES } = require('./abilities');

// Best-first priority per class. Keys MUST exist in that class's kit; anything not in
// the kit is ignored, and any kit spell NOT listed here is still usable — it just sorts
// after the listed ones (lowest priority) within its spell level. Metamagic variants
// (…_emp/_int/_max/_quick) sit last on purpose: §8.2 makes them opt-in, not defaults.
const PRIORITY = {
  cleric: ['curelight', 'curemoderate', 'cureserious', 'curecritical', 'bless', 'divinefavor', 'shieldoffaith', 'holdperson', 'spiritweapon', 'dispelmagic', 'searinglight', 'prayer', 'bullsstrength', 'bearsendurance', 'protevil', 'greatermagicweapon', 'holysmite', 'blessingoffervor', 'protectfire', 'breathoflife', 'raisedead', 'resurrection', 'healspell', 'massheal', 'flamestrike', 'bladebarrier', 'firestorm', 'implosion', 'slayliving'],
  druid: ['curelight', 'curemoderate', 'barkskin', 'entangle', 'shockinggrasp', 'calllightning', 'lightningbolt', 'dispelmagic', 'bullsstrength', 'catsgrace', 'bearsendurance', 'magicfang', 'removeparalysis', 'reincarnate', 'riverofwind', 'firesnake', 'chainlightning', 'ironskin', 'firestorm', 'stormofvengeance', 'sunburst'],
  wizard: ['magicmissile', 'fireball', 'haste', 'dispelmagic', 'glitterdust', 'invisibility', 'scorchingray', 'grease', 'shield', 'magearmor', 'sleep', 'shockinggrasp', 'aciddart', 'darkness', 'protevil', 'fly', 'slow', 'holdperson', 'lightningbolt', 'blacktentacles', 'stoneskin', 'invisgreater', 'cloudkill', 'coneofcold', 'suffocation', 'disintegrate', 'chainlightning', 'delayedfireball', 'fingerofdeath', 'horridwilting', 'polarray', 'meteorswarm', 'wailbanshee', 'overlandflight', 'firesnake', 'infernalhealgreater', 'riverofwind', 'stoneskincomm', 'fireball_int', 'fireball_emp', 'scorch_emp', 'cone_max', 'disint_max', 'magicmissile_quick', 'freezingsphere', 'dominatemonster', 'waveexhaustion', 'prismaticspray', 'sunburst'],
  paladin: ['shieldoffaith', 'bullsstrength', 'prayer', 'blessingoffervor'],
  antipaladin: ['bullsstrength', 'vampirictouch'],
  ranger: [],
  sorcerer: ['magicmissile', 'fireball', 'haste', 'dispelmagic', 'scorchingray', 'glitterdust', 'burninghands', 'shield', 'magearmor', 'sleep', 'aciddart', 'catsgrace', 'darkness', 'gustofwind', 'protevil', 'fly', 'slow', 'holdperson', 'stoneskin', 'blacktentacles', 'invisgreater', 'coneofcold', 'cloudkill', 'suffocation', 'disintegrate', 'chainlightning', 'delayedfireball', 'fingerofdeath', 'horridwilting', 'polarray', 'meteorswarm', 'wailbanshee', 'overlandflight', 'firesnake', 'infernalhealgreater', 'riverofwind', 'stoneskincomm', 'freezingsphere', 'dominatemonster', 'waveexhaustion', 'prismaticspray', 'sunburst'],
  bard: ['curelight', 'curemoderate', 'haste', 'dispelmagic', 'glitterdust', 'hideouslaughter', 'grease', 'sleep', 'heroism', 'goodhope', 'slow', 'soundburst', 'charmperson', 'vanish', 'bullsstrength', 'catsgrace', 'bearsendurance', 'dominateperson', 'heroismgreater', 'masssuggestion'],
  oracle: ['curelight', 'curemoderate', 'cureserious', 'curecritical', 'bless', 'divinefavor', 'shieldoffaith', 'holdperson', 'mirrorimage', 'invisibility', 'dispelmagic', 'searinglight', 'fireball', 'haste', 'displacement', 'prayer', 'scorchingray', 'bullsstrength', 'bearsendurance', 'darkness', 'spiritweapon', 'protevil', 'slow', 'greatermagicweapon', 'darkvisioncomm', 'holysmite', 'blessingoffervor', 'fireshield', 'invisgreater', 'protectfire', 'burninghands', 'breathoflife', 'raisedead', 'firesnake', 'resurrection'],
  inquisitor: ['curelight', 'curemoderate', 'cureserious', 'curecritical', 'bless', 'divinefavor', 'shieldoffaith', 'holdperson', 'spiritweapon', 'dispelmagic', 'searinglight', 'prayer', 'displacement', 'bullsstrength', 'protevil', 'sleep', 'blessingoffervor', 'holysmite', 'invisgreater', 'banishment', 'dispelmagicgreater'],
};

// The class's implemented, castable LEVELED spells (slvl ≥ 1; at-will cantrips and
// non-spell class features like Channel/Smite/Wild Shape are excluded).
function kitSpells(cls) {
  const kit = KITS && KITS[cls];
  if (!kit) return [];
  const arr = Array.isArray(kit) ? kit : (kit.abilities || kit.spells || []);
  return arr.filter((a) => a && a.slvl != null && a.slvl >= 1 && !a.atwill && a.is_atwill !== 1);
}

// Sort a spell list by curated priority (listed first = higher), then spell level, then
// key — so unlisted kit spells fall to the back deterministically.
function orderedByPriority(cls, spells) {
  const pri = PRIORITY[cls] || [];
  const rank = (k) => { const i = pri.indexOf(k); return i < 0 ? 1e6 : i; };
  return spells.slice().sort((a, b) => rank(a.key) - rank(b.key) || a.slvl - b.slvl || String(a.key).localeCompare(String(b.key)));
}

/** PREPARED default: { <slotLevel>: [spellKey, …] }, each level filled to its slot count.
 *  castMod = the caster's casting-stat modifier (so bonus spells widen the prepared list). */
function buildDefaultPrepared(cls, level, castMod = 0) {
  const slots = slotsFor(cls, level, castMod) || {};      // { <spellLevel>: count } (base + stat bonus + domain)
  const byLevel = {};
  for (const s of kitSpells(cls)) (byLevel[s.slvl] = byLevel[s.slvl] || []).push(s);
  const out = {};
  for (const sl of Object.keys(slots)) {
    const cnt = slots[sl] | 0;
    if (cnt <= 0) continue;
    const pool = orderedByPriority(cls, byLevel[sl] || []);
    if (pool.length) out[sl] = pool.slice(0, cnt).map((s) => s.key);
  }
  return out;
}

/** SPONTANEOUS default: [spellKey, …] — the whole implemented kit, priority order. */
function buildDefaultKnown(cls /* , level */) {
  return orderedByPriority(cls, kitSpells(cls)).map((s) => s.key);
}

/** Convenience: the right default shape for either caster type (or null for non-casters). */
function buildDefault(cls, level, castMod = 0) {
  if (!cls) return null;
  if (SPONTANEOUS_CLASSES && SPONTANEOUS_CLASSES.has(cls)) return buildDefaultKnown(cls, level);
  if (PRIORITY[cls] !== undefined && slotsFor(cls, level, castMod)) return buildDefaultPrepared(cls, level, castMod);
  return null;   // non-caster
}

module.exports = { PRIORITY, kitSpells, buildDefaultPrepared, buildDefaultKnown, buildDefault };
