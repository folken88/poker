/**
 * Pot manager — handles main pot + side pots when ≥1 players are all-in.
 *
 * Algorithm (greedy "levels"):
 *   1. Collect each player's total contribution this hand.
 *   2. Sort the *distinct* contribution levels ascending.
 *   3. For each level L (and the level above it), build a pot equal to
 *      (L - previousL) × (number of players who contributed at least L).
 *      That pot is eligible to those players (minus the folded ones).
 *   4. Final return: [{ amount, eligible: Set<playerId> }, ...]
 *
 * Example: A bets 100 all-in. B bets 300. C bets 300 then folds.
 *   contribs = { A:100, B:300, C:300 }, folded = { C }
 *   levels = [100, 300]
 *   - pot at level 100: (100-0) × 3 = 300, eligible = {A, B} (C folded)
 *   - pot at level 300: (300-100) × 2 = 400, eligible = {B}
 *   total = 700 distributed across two pots.
 */

class Pot {
  constructor() {
    this.contribs = new Map();    // playerId -> total contributed this hand
    this.folded   = new Set();
  }

  reset() { this.contribs.clear(); this.folded.clear(); }

  add(playerId, amount) {
    if (amount <= 0) return;
    this.contribs.set(playerId, (this.contribs.get(playerId) || 0) + amount);
  }

  fold(playerId) { this.folded.add(playerId); }

  totalContributed(playerId) { return this.contribs.get(playerId) || 0; }

  totalSize() {
    let sum = 0;
    for (const v of this.contribs.values()) sum += v;
    return sum;
  }

  /**
   * Build side pots. Returns an array of { amount, eligible: Set<playerId> }.
   * If no one has contributed, returns [].
   */
  buildSidePots() {
    if (this.contribs.size === 0) return [];

    // Snapshot contributions
    const entries = [...this.contribs.entries()]
      .filter(([, amt]) => amt > 0)
      .map(([pid, amt]) => ({ pid, amt }));
    if (entries.length === 0) return [];

    // Distinct levels in ascending order
    const levels = [...new Set(entries.map(e => e.amt))].sort((a, b) => a - b);

    const pots = [];
    let prev = 0;
    for (const lvl of levels) {
      const delta = lvl - prev;
      const contributors = entries.filter(e => e.amt >= lvl);
      const amount = delta * contributors.length;
      if (amount === 0) { prev = lvl; continue; }

      const eligible = new Set(
        contributors.map(e => e.pid).filter(pid => !this.folded.has(pid))
      );
      pots.push({ amount, eligible });
      prev = lvl;
    }

    // Merge any consecutive pots whose eligible sets are identical — they
    // would be paid to the same winners anyway, no reason to keep separate.
    const merged = [];
    for (const p of pots) {
      const last = merged[merged.length - 1];
      if (last && setEq(last.eligible, p.eligible)) {
        last.amount += p.amount;
      } else {
        merged.push({ amount: p.amount, eligible: new Set(p.eligible) });
      }
    }
    return merged;
  }
}

function setEq(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

module.exports = { Pot };
