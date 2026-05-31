/**
 * Lore grudges — who hates whom, for the cosmetic "random revenge" attacks.
 *
 * PURE FLAVOR. This only feeds the useless bar-brawl side-gag (a bot may
 * randomly swing a weapon / sling a spell at a seated lore enemy). It never
 * touches chips, pots, seating, or any poker outcome.
 *
 * Keys and values are seat DISPLAY nicknames — the same short names shown on
 * the felt and used in banter.js CHARACTER_FLAVOR (e.g. 'Kate', 'Mr. Brow',
 * 'Tar Baphon'). Relationships are made SYMMETRIC below, so you only need to
 * write each grudge once (A → [B] also makes B an enemy of A).
 *
 * Seeded conservatively with the enmities we're sure of; expand freely —
 * add a line under ENEMY_MAP and the symmetric index rebuilds on load.
 */
const ENEMY_MAP = {
  // Estovion betrayed the werewolves and stays wary of them. Kate leads the
  // Blackwood werewolf clan; Adimarus runs with that pack.
  'Estovion': ['Kate', 'Adimarus'],
  // Kate (werewolf clan leader) vs Daramid (the judge) — their courtroom
  // rivalry ("objection!" / "overruled.") spills onto the felt.
  'Kate': ['Daramid'],
  // TODO(folken): expand with the rest of the lore grudges — paladins vs
  // undead villains, old campaign rivalries, etc.
};

// Build a symmetric adjacency index: lower-cased nick → Set(lower-cased foes).
const _adj = new Map();
function _add(a, b) {
  const k = a.toLowerCase();
  if (!_adj.has(k)) _adj.set(k, new Set());
  _adj.get(k).add(b.toLowerCase());
}
for (const [a, foes] of Object.entries(ENEMY_MAP)) {
  for (const b of foes) { _add(a, b); _add(b, a); }
}

/** Set of lower-cased enemy nicknames for a given display nick (or empty). */
function enemiesOf(nick) {
  if (!nick) return new Set();
  return _adj.get(String(nick).toLowerCase()) || new Set();
}

/** True if a and b are lore enemies (symmetric). */
function areEnemies(a, b) {
  if (!a || !b) return false;
  const s = _adj.get(String(a).toLowerCase());
  return !!s && s.has(String(b).toLowerCase());
}

module.exports = { ENEMY_MAP, enemiesOf, areEnemies };
