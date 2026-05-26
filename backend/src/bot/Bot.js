/**
 * Bot — heuristic Texas Hold'em opponent.
 *
 *   Two orthogonal dimensions drive behavior:
 *
 *   risk appetite (mode):
 *     cautious  → only bets big when certain; folds crappy hands fast;
 *                 never shoves (no all-in even on monsters).
 *     standard  → balanced; lets intelligence guide the calls.
 *     risky     → big bets, frequent raises, will shove monsters,
 *                 actively manipulates the pot with bluffs/probes.
 *
 *   intelligence:
 *     low       → noisy hand-read, makes obvious mistakes ~20% of the
 *                 time (misses value, calls junk). Doesn't bluff with
 *                 intent — its "bluffs" are accidents.
 *     average   → solid hand-read, mistakes ~10% of the time, light
 *                 bluffing.
 *     high      → almost always picks the right action for its hand
 *                 and the table; will deliberately bluff to manipulate
 *                 opponents, especially in risky mode.
 *
 *   Each bot has a baseMode personality and a current mode that may
 *   shift between hands (maybeShiftMode).
 */

const { strengthOf } = require('./strength');

const MODES = ['cautious', 'standard', 'risky'];

/* Risk knobs — how the bot bets/folds at a given perceived strength.
 *   sizing         : bet size as a multiplier on pot
 *   raiseThresh    : perceived strength needed to raise rather than call
 *   monsterThresh  : perceived strength considered "very strong"
 *   foldBias       : extra pressure added to fold threshold (+ folds more)
 *   bigBetProtect  : min v to call a bet that's >50% of pot
 *   willShove      : whether a monster can become an all-in (risky only)
 */
const MODE_TUNING = {
  cautious: { sizing: 0.55, raiseThresh: 0.72, monsterThresh: 0.90, foldBias: +0.15, bigBetProtect: 0.82, willShove: false },
  standard: { sizing: 0.80, raiseThresh: 0.60, monsterThresh: 0.82, foldBias:  0.00, bigBetProtect: 0.70, willShove: false },
  risky:    { sizing: 1.15, raiseThresh: 0.50, monsterThresh: 0.74, foldBias: -0.10, bigBetProtect: 0.55, willShove: true  },
};

/* Intelligence knobs — accuracy + skill.
 *   noise         : ± drift on the bot's perception of its own strength
 *   mistakeProb   : chance per decision to take a clearly suboptimal action
 *   bluffProb     : base chance to attempt a deliberate bluff-raise
 */
const INTEL_TIERS = ['low', 'average', 'high'];
const INTEL_TUNING = {
  low:     { noise: 0.28, mistakeProb: 0.20, bluffProb: 0.02 },
  average: { noise: 0.10, mistakeProb: 0.10, bluffProb: 0.05 },
  high:    { noise: 0.03, mistakeProb: 0.02, bluffProb: 0.12 },
};

class Bot {
  /**
   * @param {Object} opts
   * @param {string} opts.playerId
   * @param {string} [opts.baseMode]      - the bot's "personality" mode it tends back to
   * @param {string} [opts.mode]          - the current mode (may differ from base)
   * @param {string} [opts.intelligence]  - 'low' | 'average' | 'high'
   */
  constructor({ playerId, baseMode = 'standard', mode, intelligence = 'average' }) {
    this.playerId = playerId;
    this.baseMode = MODES.includes(baseMode) ? baseMode : 'standard';
    this.mode = MODES.includes(mode) ? mode : this.baseMode;
    this.intelligence = INTEL_TIERS.includes(intelligence) ? intelligence : 'average';
  }

  /** Add intelligence-dependent noise to a true strength estimate (0..1).
   *  High-intel bots see close to ground truth; low-intel bots can be way off. */
  _perceivedStrength(trueStrength) {
    const { noise } = INTEL_TUNING[this.intelligence] || INTEL_TUNING.average;
    const drift = (Math.random() - 0.5) * 2 * noise;
    return clamp01(trueStrength + drift);
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
    const intel  = INTEL_TUNING[this.intelligence] || INTEL_TUNING.average;
    const rng = Math.random;

    const trueStrength = strengthOf(hole, board);
    const v = this._perceivedStrength(trueStrength);
    const tag = `${this.mode}/${this.intelligence}`;

    // Builds a raise action; auto-promotes to all-in if it'd commit the stack.
    const buildRaise = (sizeFactorMul, label) => {
      const factor = tuning.sizing * sizeFactorMul * (0.75 + rng() * 0.5);
      const size = Math.max(minRaise, Math.round(Math.max(potTotal, bigBlind) * factor));
      const raiseTo = Math.min(currentBet + size, invested + stack);
      const addedChips = raiseTo - invested;
      if (addedChips >= stack) {
        return { action: 'allin', reason: `${label}->shove v=${v.toFixed(2)} ${tag}` };
      }
      return { action: 'raise', amount: raiseTo, reason: `${label} v=${v.toFixed(2)} ${tag}` };
    };

    // ─── Mistake roll ────────────────────────────────────────────────────────
    // With intelligence-dependent probability, take an action the bot wouldn't
    // normally take. Low-intel ≈ 20%, average ≈ 10%, high ≈ 2%. Mistakes are
    // shaped by the read:
    //   • strong hand → miss value (just call instead of raise; sometimes fold)
    //   • junk hand   → spew (call/raise instead of fold)
    //   • marginal    → fall through to normal logic
    if (rng() < intel.mistakeProb) {
      if (v > 0.65) {
        if (toCall === 0) {
          return { action: 'check', reason: `MISS-VAL v=${v.toFixed(2)} ${tag}` };
        }
        if (toCall <= potTotal * 0.5 || rng() < 0.75) {
          return { action: 'call', reason: `MISS-VAL-call v=${v.toFixed(2)} ${tag}` };
        }
        return { action: 'fold', reason: `BAD-FOLD v=${v.toFixed(2)} ${tag}` };
      }
      if (v < 0.30) {
        if (toCall === 0)            return buildRaise(0.6, 'bad-open');
        if (toCall <= stack * 0.30)  return { action: 'call', reason: `BAD-CALL v=${v.toFixed(2)} ${tag}` };
        if (rng() < 0.55)            return { action: 'call', reason: `BAD-CALL v=${v.toFixed(2)} ${tag}` };
        return buildRaise(0.7, 'punt');
      }
      // marginal range — let normal logic run
    }

    // ─── Deliberate bluff ────────────────────────────────────────────────────
    // High-intel bots actually bluff to manipulate. Risky leans hardest into
    // this; cautious almost never bluffs; low-intel never deliberately bluffs.
    const bluffMul = this.mode === 'risky' ? 1.8 : this.mode === 'standard' ? 1.0 : 0.3;
    const cheapBluff = toCall < Math.max(bigBlind * 2, stack * 0.20);
    if (
      this.intelligence !== 'low' &&
      v < 0.45 &&
      cheapBluff &&
      rng() < intel.bluffProb * bluffMul
    ) {
      return buildRaise(1.05, 'bluff');
    }

    // ─── No bet to call (we can check or open) ───────────────────────────────
    if (toCall === 0) {
      if (v > tuning.raiseThresh) {
        // Risky + high-intel sometimes "traps" with a probe bet to induce raises.
        if (this.mode === 'risky' && this.intelligence === 'high' && v < 0.86 && rng() < 0.30) {
          return buildRaise(0.55, 'probe');
        }
        // Monster + risky → shove (only risky shoves).
        if (v >= tuning.monsterThresh && tuning.willShove) {
          return { action: 'allin', reason: `monster-shove v=${v.toFixed(2)} ${tag}` };
        }
        return buildRaise(1.0, 'value-open');
      }
      return { action: 'check', reason: `check v=${v.toFixed(2)} ${tag}` };
    }

    // ─── Facing a bet ────────────────────────────────────────────────────────
    const callCost = Math.min(toCall, stack);
    const potAfterCall = potTotal + callCost;
    const potOdds = callCost / Math.max(1, potAfterCall);
    const isBigBet = callCost > potTotal * 0.5 || callCost > stack * 0.30;

    // Base fold floor by mode: cautious folds anything that's not solid,
    // risky calls down a lot, standard sits in between.
    const baseFold =
      this.mode === 'cautious' ? 0.42 :
      this.mode === 'risky'    ? 0.22 :
                                 0.32;
    const foldThreshold = clamp01(baseFold + potOdds * 0.40 + tuning.foldBias);

    if (v < foldThreshold) {
      return { action: 'fold', reason: `fold v=${v.toFixed(2)} fT=${foldThreshold.toFixed(2)} ${tag}` };
    }

    // Defending against a big bet — need solid strength regardless of pot odds.
    if (isBigBet && v < tuning.bigBetProtect) {
      return { action: 'fold', reason: `fold-big v=${v.toFixed(2)} ${tag}` };
    }

    // Strong → raise. Only risky promotes monsters to all-in.
    if (v > tuning.raiseThresh) {
      if (this.mode === 'risky' && v >= tuning.monsterThresh) {
        return { action: 'allin', reason: `monster v=${v.toFixed(2)} ${tag}` };
      }
      // Cautious only "bets big" when truly certain — otherwise small value bet.
      if (this.mode === 'cautious' && v < tuning.monsterThresh) {
        return buildRaise(0.75, 'value-small');
      }
      return buildRaise(1.0, 'value');
    }

    return { action: 'call', reason: `call v=${v.toFixed(2)} odds=${potOdds.toFixed(2)} ${tag}` };
  }

  /** Possibly shift current mode. Tends to drift back to baseMode over time. */
  maybeShiftMode() {
    const rng = Math.random;
    if (rng() > 0.18) return false;
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
