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
  // High-intel was 0.12 — the bluffiest tier — which the decision logs showed
  // producing a ~6.5:1 bluff:value ratio. Over-bluffing is the most exploitable
  // leak there is (the opposite of "intelligent"), so we rebalance toward value:
  // a lower bluff frequency here, plus a thin-value gate and a "don't bluff into
  // a crowd" filter in decide(). Re-check the logs after a few hundred hands.
  high:    { noise: 0.03, mistakeProb: 0.02, bluffProb: 0.08 },
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
    // Per-opponent bluff-memory. Map<opponentId, {samples, bluffs}>.
    // Higher intelligence "remembers" more samples; lower intel
    // forgets faster (cap applied in noteOpponentReveal).
    this._opponentMemory = new Map();
  }

  /** Record that we saw an opponent's hand at showdown / fold-win.
   *  Caller decides isBluff based on revealed strength + their action.
   *  Memory caps at MAX samples per opponent — old behavior fades. */
  noteOpponentReveal(opponentId, isBluff) {
    if (!opponentId || opponentId === this.playerId) return;
    const MAX = this.intelligence === 'high' ? 24
              : this.intelligence === 'average' ? 14
              : 6;
    const rec = this._opponentMemory.get(opponentId) || { samples: 0, bluffs: 0 };
    rec.samples++;
    if (isBluff) rec.bluffs++;
    if (rec.samples > MAX) {
      // Shrink proportionally so the running ratio stays meaningful.
      const factor = MAX / rec.samples;
      rec.bluffs  = Math.round(rec.bluffs * factor);
      rec.samples = MAX;
    }
    this._opponentMemory.set(opponentId, rec);
  }

  /** Look up a smoothed bluff-ratio for an opponent.
   *  Returns 0..1 with Bayesian prior (assumes 30% bluff baseline at 0
   *  samples so unknown opponents aren't auto-trusted). Requires ≥2
   *  samples before the data influences anything appreciable. */
  _opponentBluffRatio(opponentId) {
    if (!opponentId) return 0.30;
    const rec = this._opponentMemory.get(opponentId);
    if (!rec || rec.samples < 2) return 0.30;
    // Smoothed: (bluffs + prior) / (samples + 2)
    return (rec.bluffs + 0.6) / (rec.samples + 2);
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
    const {
      hole, board, toCall, potTotal, stack, currentBet, invested, minRaise, bigBlind,
      selfWealth, opponents, aggressorWealth, aggressorId,
    } = ctx;
    const tuning = MODE_TUNING[this.mode] || MODE_TUNING.standard;
    const intel  = INTEL_TUNING[this.intelligence] || INTEL_TUNING.average;
    const rng = Math.random;

    const trueStrength = strengthOf(hole, board);
    const v = this._perceivedStrength(trueStrength);
    const tag = `${this.mode}/${this.intelligence}`;

    // VALUE-OVER-BLUFF REBALANCE (high-intel only). A skilled player extracts
    // THIN value: because it reads hands accurately (low noise), it can
    // profitably bet a touch weaker than its mode's base raiseThresh when it
    // gets to open. Lifts the value side of the bluff:value ratio to pair with
    // the reduced bluffProb above. Floor keeps it from value-betting junk.
    const valueThresh = this.intelligence === 'high'
      ? Math.max(0.42, tuning.raiseThresh - 0.06)
      : tuning.raiseThresh;

    // ─── Wealth context (chips + magic items) ────────────────────────────────
    // High-intel bots use this accurately; low-intel ones mostly ignore it
    // (the noise on perception swamps the small wealth adjustment).
    //
    //   selfRel  > 1 → I'm richer than the average opponent (can risk more)
    //                < 1 → I'm poorer (chips matter more, tighten up)
    //   aggRel   > 1 → the raiser is richer than me (bet less credible —
    //                  they can afford to bluff)
    //                < 1 → the raiser is poorer than me (more credible —
    //                  they're committing a larger share of their bankroll)
    const myW = Number.isFinite(selfWealth) && selfWealth > 0 ? selfWealth : stack;
    const oppsLive = Array.isArray(opponents) ? opponents.filter(o => o && o.wealth > 0) : [];
    const avgOppW = oppsLive.length
      ? oppsLive.reduce((s, o) => s + o.wealth, 0) / oppsLive.length
      : myW;
    const selfRel = avgOppW > 0 ? myW / avgOppW : 1;
    const aggRel  = (aggressorWealth && aggressorWealth > 0) ? aggressorWealth / Math.max(1, myW) : 1;

    // How much wealth awareness drives behavior — high intel reads it
    // well, average half, low only barely.
    const wealthWeight = this.intelligence === 'high' ? 1.0
                       : this.intelligence === 'average' ? 0.5
                       : 0.15;

    // Fold-threshold tweak: poorer bot folds more; richer bot folds less.
    // selfRel = 2 (twice as rich) → -0.04 to fold threshold;
    // selfRel = 0.5 (half as rich) → +0.04.
    const wealthFoldAdj = clamp(-0.08, 0.08, (1 - selfRel) * 0.08) * wealthWeight;
    // Sizing tweak: richer bot can size up; poorer scales down.
    const wealthSizeAdj = clamp(0.7, 1.3, 1 + (selfRel - 1) * 0.15 * wealthWeight);
    // Aggressor credibility: rich raiser → discount their bet (less fold);
    //                       poor raiser → respect their bet (more fold).
    // aggRel = 2 (rich raiser) → -0.04; aggRel = 0.5 (poor raiser) → +0.04.
    const aggCredAdj = clamp(-0.08, 0.08, (aggRel - 1) * -0.05) * wealthWeight;

    // Bluff-history adjustment. If we've seen the aggressor bluff a lot,
    // call them down more (negative = lower fold threshold). High-intel
    // bots weight this strongly; low-intel barely uses it.
    // ratio 0.30 = neutral, 0.60+ = chronic bluffer.
    const bluffRatio = this._opponentBluffRatio(aggressorId);
    const memoryWeight = this.intelligence === 'high' ? 1.0
                       : this.intelligence === 'average' ? 0.6
                       : 0.2;
    // Only act on deviations from the 0.30 prior. Cap effect at ±0.12.
    const bluffAdj = clamp(-0.12, 0.12, (0.30 - bluffRatio) * 0.30) * memoryWeight;

    // Builds a raise action; auto-promotes to all-in if it'd commit the stack.
    const buildRaise = (sizeFactorMul, label) => {
      const factor = tuning.sizing * sizeFactorMul * wealthSizeAdj * (0.75 + rng() * 0.5);
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
    // High-intel doesn't bluff into a crowd — a bluff only gets through when few
    // opponents are still live (heads-up to ~4-handed). Firing into a multiway
    // pot is spew: someone usually has a hand. Other tiers keep prior behavior.
    const bluffCrowdOk = this.intelligence !== 'high' || oppsLive.length <= 3;
    if (
      this.intelligence !== 'low' &&
      v < 0.45 &&
      cheapBluff &&
      bluffCrowdOk &&
      rng() < intel.bluffProb * bluffMul
    ) {
      return buildRaise(1.05, 'bluff');
    }

    // ─── High-intel slow-play (build the pot, slam-dunk later) ──────────────
    // A skilled player doesn't fire a huge bet the moment they get a
    // monster — they flat-call or small-probe on the early streets to
    // let the pot grow and disguise their strength, then go big on
    // turn / river once opponents are committed. Gated on:
    //   - intelligence === 'high' (only the smart ones know how)
    //   - v >= monsterThresh (only true monsters — medium-strong hands
    //     still play normally so they don't leak by under-betting)
    //   - street <= 3 (preflop + flop are "early"; turn=4 / river=5
    //     fall through to the normal value/jam logic below)
    // Without this, high-intel cautious bots monster-shove on flop and
    // scare everyone out, leaving them with a tiny pot for a huge hand.
    const street = board?.length || 0;
    if (this.intelligence === 'high' && v >= tuning.monsterThresh && street <= 3) {
      if (toCall === 0) {
        // Mix check (60%) with a small probe bet (40% at 0.35× pot).
        // The check looks weak-passive; the probe looks like a feeler.
        // Either way, opponents stay in or start betting into us.
        if (rng() < 0.60) {
          return { action: 'check', reason: `slowplay-check v=${v.toFixed(2)} ${tag}` };
        }
        return buildRaise(0.35, 'slowplay-probe');
      }
      // Facing a bet — just call to disguise the monster and let them
      // keep firing on later streets. Exception: if the call is itself
      // pot-committing (>30% of stack), the hand is going all-in by the
      // river anyway, so falling through to the existing strong-hand
      // logic (which will shove) is correct.
      const wouldCommitNow = toCall > stack * 0.30;
      if (!wouldCommitNow) {
        return { action: 'call', reason: `slowplay-trap v=${v.toFixed(2)} ${tag}` };
      }
      // Pot-committed → fall through; existing logic will shove.
    }

    // ─── No bet to call (we can check or open) ───────────────────────────────
    if (toCall === 0) {
      if (v > valueThresh) {   // high-intel opens thinner value; others use raiseThresh
        // Risky + high-intel sometimes "traps" with a probe bet to induce raises.
        if (this.mode === 'risky' && this.intelligence === 'high' && v < 0.86 && rng() < 0.30) {
          return buildRaise(0.55, 'probe');
        }
        // Monster + risky → shove (only risky shoves on standard monsters).
        if (v >= tuning.monsterThresh && tuning.willShove) {
          return { action: 'allin', reason: `monster-shove v=${v.toFixed(2)} ${tag}` };
        }
        // Cautious patient-pays: near-nuts (v ≥ 0.92) finally trigger an
        // all-in. The patient bot has waited for a great hand — when it
        // comes, they jam to extract maximum value.
        if (this.mode === 'cautious' && v >= 0.92) {
          return { action: 'allin', reason: `patience-pays v=${v.toFixed(2)} ${tag}` };
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
    // Preflop discount: calling pre is cheap (forced blinds, five more
    // cards coming, multiway gives implicit drawing odds). Without this
    // the fold threshold + potOdds inflation makes cautious bots wait
    // for AA/KK before they'll even see a flop. -0.10 = "call one more
    // street of hands you wouldn't call postflop."
    const preflopDiscount = (board?.length || 0) === 0 ? 0.10 : 0;
    const foldThreshold = clamp01(baseFold + potOdds * 0.40 + tuning.foldBias + wealthFoldAdj + aggCredAdj + bluffAdj - preflopDiscount);

    if (v < foldThreshold) {
      return { action: 'fold', reason: `fold v=${v.toFixed(2)} fT=${foldThreshold.toFixed(2)} ${tag}` };
    }

    // Defending against a big bet — need solid strength regardless of pot odds.
    if (isBigBet && v < tuning.bigBetProtect) {
      return { action: 'fold', reason: `fold-big v=${v.toFixed(2)} ${tag}` };
    }

    // Strong → raise. Risky promotes monsters to all-in; cautious does so
    // only on near-nuts (the patient bot's payoff move).
    if (v > tuning.raiseThresh) {
      if (this.mode === 'risky' && v >= tuning.monsterThresh) {
        return { action: 'allin', reason: `monster v=${v.toFixed(2)} ${tag}` };
      }
      if (this.mode === 'cautious' && v >= 0.92) {
        return { action: 'allin', reason: `patience-pays v=${v.toFixed(2)} ${tag}` };
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
function clamp(lo, hi, x) { return Math.max(lo, Math.min(hi, x)); }

module.exports = { Bot, MODES };
