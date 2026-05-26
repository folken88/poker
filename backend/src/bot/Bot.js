/**
 * Bot — heuristic Texas Hold'em opponent.
 *
 *   modes:
 *     cautious  → tighter ranges, smaller bets, fold to pressure
 *     standard  → balanced
 *     risky     → looser, larger bets, occasional bluffs
 *
 *   Each bot has a base personality (its preferred mode) and a current mode
 *   that may shift between hands. Decisions combine hand strength, pot odds,
 *   stack, position, and RNG variance.
 */

const { strengthOf } = require('./strength');

const MODES = ['cautious', 'standard', 'risky'];

const MODE_TUNING = {
  cautious: { boost: -0.13, raiseProb: 0.30, bluffProb: 0.03, sizing: 0.60 },
  standard: { boost:  0.00, raiseProb: 0.50, bluffProb: 0.08, sizing: 0.80 },
  risky:    { boost: +0.13, raiseProb: 0.70, bluffProb: 0.18, sizing: 1.10 },
};

class Bot {
  /**
   * @param {Object} opts
   * @param {string} opts.playerId
   * @param {string} [opts.baseMode]   - the bot's "personality" mode it tends back to
   * @param {string} [opts.mode]       - the current mode (may differ from base)
   */
  constructor({ playerId, baseMode = 'standard', mode }) {
    this.playerId = playerId;
    this.baseMode = MODES.includes(baseMode) ? baseMode : 'standard';
    this.mode = MODES.includes(mode) ? mode : this.baseMode;
  }

  /**
   * Pick an action.
   * @param {Object} ctx
   * @param {string[]} ctx.hole
   * @param {string[]} ctx.board
   * @param {number}   ctx.toCall
   * @param {number}   ctx.potTotal
   * @param {number}   ctx.stack
   * @param {number}   ctx.currentBet
   * @param {number}   ctx.invested
   * @param {number}   ctx.minRaise
   * @param {number}   ctx.bigBlind
   * @returns {{action:string, amount?:number, reason:string}}
   */
  decide(ctx) {
    const { hole, board, toCall, potTotal, stack, currentBet, invested, minRaise, bigBlind } = ctx;
    const tuning = MODE_TUNING[this.mode] || MODE_TUNING.standard;
    const rng = Math.random;

    const baseStrength = strengthOf(hole, board);
    // Adjusted strength includes mode boost + ±0.075 variance
    const v = clamp01(baseStrength + tuning.boost + (rng() - 0.5) * 0.15);

    // --- No bet to call (we can check or open) ---
    if (toCall === 0) {
      // Strong hand → open
      const openThreshold = 0.55 - tuning.boost;
      const bluffRoll = rng() < tuning.bluffProb;
      if (v > openThreshold || bluffRoll) {
        const size = Math.max(
          minRaise,
          Math.round(Math.max(potTotal, bigBlind) * tuning.sizing * (0.7 + rng() * 0.6))
        );
        const raiseTo = Math.min(currentBet + size, currentBet + stack);
        if (raiseTo - currentBet >= stack) {
          return { action: 'allin', reason: `open-shove v=${v.toFixed(2)} ${this.mode}` };
        }
        return { action: 'raise', amount: raiseTo, reason: `open-bet v=${v.toFixed(2)} ${this.mode}` };
      }
      return { action: 'check', reason: `check v=${v.toFixed(2)} ${this.mode}` };
    }

    // --- There is a bet to call ---
    const callCost = Math.min(toCall, stack);
    const potAfterCall = potTotal + callCost;
    const potOdds = callCost / potAfterCall;  // 0..1, fraction of new pot we'd be putting in

    // Fold threshold scales with how expensive the call is relative to the pot
    const foldThreshold = clamp01(0.20 + potOdds * 0.65 - tuning.boost);

    if (v < foldThreshold) {
      // Slight chance to call anyway (loose play / curiosity), especially in risky mode
      if (rng() < 0.04 + tuning.bluffProb) {
        return { action: 'call', reason: `loose-call v=${v.toFixed(2)} ${this.mode}` };
      }
      return { action: 'fold', reason: `fold v=${v.toFixed(2)} odds=${potOdds.toFixed(2)} ${this.mode}` };
    }

    // Strong → raise
    const raiseThreshold = 0.62 - tuning.boost;
    if (v > raiseThreshold && rng() < tuning.raiseProb) {
      const size = Math.max(
        minRaise,
        Math.round(Math.max(potTotal, bigBlind) * tuning.sizing * (0.6 + rng() * 0.7))
      );
      const raiseTo = Math.min(currentBet + size, invested + stack);
      const addedChips = raiseTo - invested;
      if (addedChips >= stack || v > 0.85 + (rng() - 0.5) * 0.1) {
        return { action: 'allin', reason: `shove v=${v.toFixed(2)} ${this.mode}` };
      }
      return { action: 'raise', amount: raiseTo, reason: `value-raise v=${v.toFixed(2)} ${this.mode}` };
    }

    return { action: 'call', reason: `call v=${v.toFixed(2)} odds=${potOdds.toFixed(2)} ${this.mode}` };
  }

  /** Possibly shift current mode. Tends to drift back to baseMode over time. */
  maybeShiftMode() {
    const rng = Math.random;
    // 18% chance to shift modes at all
    if (rng() > 0.18) return false;
    // 60% chance to drift back toward base; 40% randomize
    let next;
    if (this.mode !== this.baseMode && rng() < 0.6) {
      next = this.baseMode;
    } else {
      do { next = MODES[Math.floor(rng() * MODES.length)]; } while (next === this.mode);
    }
    this.mode = next;
    return true;
  }
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

module.exports = { Bot, MODES };
