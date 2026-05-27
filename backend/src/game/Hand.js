/**
 * Hand — state machine for ONE Texas Hold'em hand.
 *
 *   WAITING -> PREFLOP -> FLOP -> TURN -> RIVER -> SHOWDOWN -> COMPLETE
 *
 * Responsibilities:
 *   - Build + shuffle deck (crypto-grade randomness)
 *   - Deal hole cards (private per seat)
 *   - Run betting rounds with proper turn rotation
 *   - Track pot + build side pots when someone is all-in
 *   - Evaluate hands at showdown via pokersolver
 *   - Distribute pots (split ties, handle remainder)
 *   - Settle each player's table stack after the hand
 *
 * Trust model: the only state the CLIENT sends is action intent
 * { action, amount }. Everything else is server-owned. Hole cards leave
 * this module only via the private socket to their owner.
 */

const { Deck } = require('./Deck');
const { Pot } = require('./Pot');
const { validate } = require('./actions');
const { Hand: SolverHand } = require('pokersolver');

const STATES = {
  WAITING:  'WAITING',
  PREFLOP:  'PREFLOP',
  FLOP:     'FLOP',
  TURN:     'TURN',
  RIVER:    'RIVER',
  SHOWDOWN: 'SHOWDOWN',
  COMPLETE: 'COMPLETE',
};

// ---- Hand description helpers ----
// pokersolver's `descr` gives the category but not the kicker, so
// "Three of a Kind, 8's" doesn't tell you whether it was ace-high or
// duece-high. These helpers produce a richer line for the chat log.
const RANK_WORD = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: '10' };
function rankWord(v)   { return RANK_WORD[v] || v; }
function rankPlural(v) { return rankWord(v) + 's'; }

/** Order two hole cards highest-rank first so descriptions read "AK"
 *  not "KA". Returns [highCard, lowCard]. */
const RANK_ORDER = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };
function sortHoleHighFirst(hole) {
  if (!hole || hole.length !== 2) return hole || [];
  const [c1, c2] = hole;
  return (RANK_ORDER[c1[0]] || 0) >= (RANK_ORDER[c2[0]] || 0) ? [c1, c2] : [c2, c1];
}

/** Describe two hole cards in poker shorthand. Used when a hand is
 *  won by fold (no real showdown) so opponents can see if the winner
 *  was bluffing. Examples:
 *    "Pocket Aces"            (pair)
 *    "Ace-King suited"        (premium)
 *    "Ten-Two off — total bluff" (junk)
 */
function describeHoleCards(hole) {
  const sorted = sortHoleHighFirst(hole);
  if (sorted.length !== 2) return 'no cards';
  const [c1, c2] = sorted;
  const r1 = c1[0], r2 = c2[0];
  const s1 = c1[1], s2 = c2[1];
  if (r1 === r2) {
    return r1 === 'A' ? 'Pocket Aces' :
           r1 === 'K' ? 'Pocket Kings' :
           r1 === 'Q' ? 'Pocket Queens' :
           r1 === 'J' ? 'Pocket Jacks' :
           `Pocket ${rankPlural(r1)}`;
  }
  const high = rankWord(r1), low = rankWord(r2);
  const suit = s1 === s2 ? 'suited' : 'off';
  // Bluff label: unconnected + low (both ≤ 10) is shouting "bluff".
  const r1n = RANK_ORDER[r1] || 0;
  const r2n = RANK_ORDER[r2] || 0;
  const gap = r1n - r2n;
  let suffix = '';
  if (r1n <= 10 && gap >= 3 && s1 !== s2)       suffix = ' — total bluff';
  else if (r1n <= 11 && gap >= 4)               suffix = ' — definite bluff';
  else if (r1n <= 9)                            suffix = ' — sketchy bluff';
  return `${high}-${low} ${suit}${suffix}`;
}

/** Take a pokersolver Hand result and return a sentence including kickers.
 *  Falls back to the library's own `descr` on any unexpected shape. */
function describeWinningHand(solverHand) {
  try {
    const name  = solverHand.name;
    const cards = solverHand.cards;          // best 5, made-hand first then kickers desc
    const r     = cards.map(c => c.value);   // ['8','8','8','A','K']
    switch (name) {
      case 'Royal Flush':
        return 'Royal Flush';
      case 'Straight Flush':
        return `Straight Flush, ${rankWord(r[0])} high`;
      case 'Four of a Kind':
        return `Four ${rankPlural(r[0])}, ${rankWord(r[4])} kicker`;
      case 'Full House':
        return `Full House, ${rankPlural(r[0])} over ${rankPlural(r[3])}`;
      case 'Flush':
        return `Flush, ${rankWord(r[0])} high`;
      case 'Straight':
        return `Straight, ${rankWord(r[0])} high`;
      case 'Three of a Kind':
        return `Three ${rankPlural(r[0])}, ${rankWord(r[3])} high`;
      case 'Two Pair':
        return `Two Pair: ${rankPlural(r[0])} and ${rankPlural(r[2])}, ${rankWord(r[4])} kicker`;
      case 'Pair':
        return `Pair of ${rankPlural(r[0])}, ${rankWord(r[2])} high`;
      case 'High Card':
        return `${rankWord(r[0])} high, ${rankWord(r[1])} kicker`;
      default:
        return solverHand.descr || name || 'Best hand';
    }
  } catch (_) {
    return solverHand?.descr || 'Best hand';
  }
}

class Hand {
  /**
   * @param {Object} opts
   * @param {Object[]} opts.seats        - seated participants in seat-order:
   *                                       [{ index, playerId, player, chipsAtTable }, ...]
   *                                       Only INCLUDE seats that are playing this hand
   *                                       (filtered by caller — usually seat.isEmpty() === false
   *                                        AND chipsAtTable > 0).
   * @param {number} opts.dealerButton   - seat *position* in the participants
   *                                       array (NOT the Table-level seat index)
   *                                       whose owner has the button.
   * @param {number} opts.smallBlind
   * @param {number} opts.bigBlind
   */
  constructor({ seats, dealerButton, smallBlind, bigBlind }) {
    if (seats.length < 2) throw new Error('Hand needs at least 2 players');

    this.players = seats.map(s => ({
      seatIndex: s.index,
      playerId:  s.playerId,
      nickname:  s.player?.nickname || s.playerId,
      avatarId:  s.player?.avatar_id || null,
      stack:     s.chipsAtTable,    // current chips remaining at the table
      hole:      [],
      folded:    false,
      invested:  0,                  // contributed THIS street
      totalIn:   0,                  // contributed THIS HAND (mirrors Pot)
      hasActed:  false,              // since the last raise / start of round
      allIn:     false,
    }));
    this.n = this.players.length;

    this.dealerButton = dealerButton % this.n;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.deck = new Deck();
    this.pot = new Pot();
    this.board = [];
    this.state = STATES.WAITING;
    this.currentBet = 0;      // highest bet THIS round
    this.minRaise = bigBlind; // last raise size
    this.actionIdx = -1;      // index into players[] whose turn it is
    this.lastRaiser = -1;     // index of last raiser; round closes when we return to them
    this.startedAt = Date.now();
    this.completedAt = null;
    this.winners = [];        // populated at SHOWDOWN/COMPLETE
    this.events = [];         // free-form: bets, folds, deals — for client log
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  start() {
    this.state = STATES.PREFLOP;
    this._dealHoleCards();
    this._postBlinds();
    // Action starts left of BB (button+3 in full ring, button+1 heads-up).
    if (this.n === 2) {
      // Heads-up: button posts SB and acts first preflop.
      this.actionIdx = this.dealerButton;
    } else {
      this.actionIdx = (this.dealerButton + 3) % this.n;
    }
    this.lastRaiser = this._bbIndex();
    // Skip all-in / folded players for first-to-act
    this._advanceActorIfNeeded();
  }

  _sbIndex() { return this.n === 2 ? this.dealerButton : (this.dealerButton + 1) % this.n; }
  _bbIndex() { return this.n === 2 ? (this.dealerButton + 1) % this.n : (this.dealerButton + 2) % this.n; }

  _dealHoleCards() {
    // Two passes, one card per player per pass (classic order).
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < this.n; i++) {
        const idx = (this.dealerButton + 1 + i) % this.n;
        const p = this.players[idx];
        p.hole.push(this.deck.draw(1)[0]);
      }
    }
    this.events.push({ type: 'deal-hole' });
  }

  _postBlinds() {
    const sb = this.players[this._sbIndex()];
    const bb = this.players[this._bbIndex()];
    this._charge(sb, Math.min(this.smallBlind, sb.stack));
    this._charge(bb, Math.min(this.bigBlind,   bb.stack));
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.events.push({ type: 'blinds', sb: sb.playerId, bb: bb.playerId, sbAmount: this.smallBlind, bbAmount: this.bigBlind });
  }

  /** Move chips from player.stack to the pot; tracks invested-this-round. */
  _charge(p, amount) {
    const real = Math.min(amount, p.stack);
    p.stack -= real;
    p.invested += real;
    p.totalIn += real;
    this.pot.add(p.playerId, real);
    if (p.stack === 0) p.allIn = true;
    return real;
  }

  // ============================================================
  // Action
  // ============================================================

  getCurrentActor() {
    if (this.state === STATES.WAITING || this.state === STATES.COMPLETE || this.state === STATES.SHOWDOWN) {
      return null;
    }
    if (this.actionIdx < 0) return null;
    return this.players[this.actionIdx]?.playerId || null;
  }

  /**
   * Apply a player action.
   * Returns { ok, error?, transitioned? } — caller broadcasts state after.
   */
  applyAction(playerId, action, amount) {
    const p = this.players[this.actionIdx];
    if (!p || p.playerId !== playerId) {
      return { ok: false, error: "not your turn" };
    }
    if (p.folded || p.allIn) {
      return { ok: false, error: 'already out of action' };
    }

    const result = validate(
      { seat: { chipsAtTable: p.stack }, invested: p.invested, currentBet: this.currentBet, minRaise: this.minRaise },
      action,
      amount
    );
    if (!result.ok) return result;
    const a = result.normalized;

    let raised = false;

    if (a.type === 'fold') {
      p.folded = true;
      this.pot.fold(p.playerId);
      this.events.push({ type: 'action', player: p.playerId, action: 'fold' });
    } else if (a.type === 'check') {
      this.events.push({ type: 'action', player: p.playerId, action: 'check' });
    } else if (a.type === 'call') {
      this._charge(p, a.amount);
      this.events.push({ type: 'action', player: p.playerId, action: 'call', amount: a.amount, allIn: a.allIn });
    } else if (a.type === 'raise') {
      const raiseSize = a.to - this.currentBet;
      this._charge(p, a.add);
      this.currentBet = a.to;
      if (raiseSize >= this.minRaise) {
        this.minRaise = raiseSize;
        raised = true;
      } else if (a.allIn) {
        // Short all-in raise: doesn't reopen action for players already matched.
        // (We still record it as a "raise" for chip movement.)
      }
      this.events.push({ type: 'action', player: p.playerId, action: 'raise', to: a.to, allIn: a.allIn });
    } else if (a.type === 'allin') {
      const newTotal = p.invested + a.add;
      const raiseSize = newTotal - this.currentBet;
      this._charge(p, a.add);
      if (newTotal > this.currentBet) {
        this.currentBet = newTotal;
        if (raiseSize >= this.minRaise) {
          this.minRaise = raiseSize;
          raised = true;
        }
      }
      this.events.push({ type: 'action', player: p.playerId, action: 'allin', total: newTotal });
    }

    p.hasActed = true;

    if (raised) {
      // Re-open the action: everyone else who's not folded/all-in needs another turn.
      this.lastRaiser = this.actionIdx;
      for (const q of this.players) {
        if (q !== p && !q.folded && !q.allIn) q.hasActed = false;
      }
    }

    // Check for fold-out: only one non-folded player left.
    const live = this.players.filter(q => !q.folded);
    if (live.length === 1) {
      return this._winByFold(live[0]);
    }

    // Move action to next player. The round-close + _endStreet will handle
    // fast-forwarding to showdown when no one can meaningfully bet anymore.
    // CRITICAL: do NOT fast-forward here just because there's ≤1 player who
    // can still bet — opponents must still get to call/fold the all-in first.
    this._advanceActor();
    if (this._roundClosed()) {
      return this._endStreet();
    }
    return { ok: true };
  }

  _advanceActor() {
    let i = this.actionIdx;
    for (let n = 0; n < this.n; n++) {
      i = (i + 1) % this.n;
      const q = this.players[i];
      if (!q.folded && !q.allIn) {
        this.actionIdx = i;
        return;
      }
    }
    // No one can act — round must be closed.
    this.actionIdx = -1;
  }

  /** Move past any players who can't act (used after start() / blinds). */
  _advanceActorIfNeeded() {
    const cur = this.players[this.actionIdx];
    if (!cur || cur.folded || cur.allIn) this._advanceActor();
  }

  _roundClosed() {
    // Round is closed if every non-folded, non-all-in player has acted AND
    // their invested amount equals the current bet.
    for (const p of this.players) {
      if (p.folded || p.allIn) continue;
      if (!p.hasActed) return false;
      if (p.invested !== this.currentBet) return false;
    }
    return true;
  }

  // ============================================================
  // Street transitions
  // ============================================================

  _endStreet() {
    // Reset for-this-round trackers.
    for (const p of this.players) { p.invested = 0; p.hasActed = false; }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    if (this.state === STATES.PREFLOP) {
      this.deck.burn();
      this.board.push(...this.deck.draw(3));
      this.state = STATES.FLOP;
      this.events.push({ type: 'flop', cards: this.board.slice(0, 3) });
    } else if (this.state === STATES.FLOP) {
      this.deck.burn();
      this.board.push(this.deck.draw(1)[0]);
      this.state = STATES.TURN;
      this.events.push({ type: 'turn', card: this.board[3] });
    } else if (this.state === STATES.TURN) {
      this.deck.burn();
      this.board.push(this.deck.draw(1)[0]);
      this.state = STATES.RIVER;
      this.events.push({ type: 'river', card: this.board[4] });
    } else if (this.state === STATES.RIVER) {
      return this._resolveShowdown();
    }

    // Set first-to-act post-flop: left of dealer (skip folded/all-in).
    this.actionIdx = (this.dealerButton + 1) % this.n;
    this.lastRaiser = -1;
    this._advanceActorIfNeeded();

    // If only one player can still act (rest are all-in), skip to showdown.
    const stillCanBet = this.players.filter(q => !q.folded && !q.allIn);
    if (stillCanBet.length <= 1) return this._fastForwardToShowdown();

    return { ok: true, transitioned: true };
  }

  _fastForwardToShowdown() {
    // Reset per-round trackers, deal whatever streets remain with no betting.
    for (const p of this.players) { p.invested = 0; p.hasActed = false; }
    this.currentBet = 0;
    this.actionIdx = -1;

    while (this.board.length < 5) {
      this.deck.burn();
      if (this.board.length === 0) {
        this.board.push(...this.deck.draw(3));
        this.events.push({ type: 'flop', cards: this.board.slice(0, 3) });
        this.state = STATES.FLOP;
      } else if (this.board.length === 3) {
        this.board.push(this.deck.draw(1)[0]);
        this.events.push({ type: 'turn', card: this.board[3] });
        this.state = STATES.TURN;
      } else if (this.board.length === 4) {
        this.board.push(this.deck.draw(1)[0]);
        this.events.push({ type: 'river', card: this.board[4] });
        this.state = STATES.RIVER;
      } else {
        break;
      }
    }
    return this._resolveShowdown();
  }

  _winByFold(winner) {
    // Single live player; they win the entire pot (uncontested showdown).
    // We REVEAL the winner's hole cards (and describe them) so opponents
    // can see whether the bet was for value or a bluff. Folded players'
    // cards stay hidden — the gate in publicState filters them via
    // `!p.folded`.
    const total = this.pot.totalSize();
    winner.stack += total;
    this.state = STATES.SHOWDOWN;

    // Describe what they were holding. If 5+ board cards are out we can
    // name a made hand; otherwise fall back to hole-card shorthand
    // (which can also tag obvious bluffs).
    let handDesc;
    try {
      if (this.board.length >= 3) {
        const solver = SolverHand.solve([...winner.hole, ...this.board]);
        const made = describeWinningHand(solver);
        handDesc = `showing ${describeHoleCards(winner.hole)} — ${made}`;
      } else {
        handDesc = `showing ${describeHoleCards(winner.hole)}`;
      }
    } catch (_) {
      handDesc = `showing ${describeHoleCards(winner.hole)}`;
    }

    // Pick the cards the client should display on the winner banner.
    // Preflop fold-win: just the hole. Postflop: the best-5 from
    // pokersolver. Always sorted low → high so the card row reads
    // ascending (2♣ … A♠).
    let winningCards = winner.hole.slice();
    try {
      if (this.board.length >= 3) {
        const solver = SolverHand.solve([...winner.hole, ...this.board]);
        winningCards = solver.cards.map(c => c.toString());
      }
    } catch (_) { /* fall back to hole-only */ }
    winningCards.sort((a, b) => (RANK_ORDER[a[0]] || 0) - (RANK_ORDER[b[0]] || 0));

    this.winners = [{
      playerId: winner.playerId,
      amount: total,
      pot: 0,
      handDesc,
      cards: winner.hole.slice(),
      winningCards,
    }];
    this.events.push({ type: 'win-fold', player: winner.playerId, amount: total });
    return this._complete();
  }

  _resolveShowdown() {
    this.state = STATES.SHOWDOWN;
    const pots = this.pot.buildSidePots();

    pots.forEach((pot, potIdx) => {
      const contenders = this.players.filter(p => pot.eligible.has(p.playerId) && !p.folded);
      if (contenders.length === 0) return; // shouldn't happen but be safe
      if (contenders.length === 1) {
        const w = contenders[0];
        w.stack += pot.amount;
        // Same winningCards selection as fold-win: best-5 from solver
        // if the board's out, otherwise just the hole. Sort low → high.
        let winningCards = w.hole.slice();
        try {
          if (this.board.length >= 3) {
            const solver = SolverHand.solve([...w.hole, ...this.board]);
            winningCards = solver.cards.map(c => c.toString());
          }
        } catch (_) { /* fall back to hole-only */ }
        winningCards.sort((a, b) => (RANK_ORDER[a[0]] || 0) - (RANK_ORDER[b[0]] || 0));
        this.winners.push({
          playerId: w.playerId, amount: pot.amount, pot: potIdx,
          handDesc: 'uncontested side pot', cards: w.hole,
          winningCards,
        });
        this.events.push({ type: 'win-pot', player: w.playerId, amount: pot.amount, pot: potIdx });
        return;
      }
      // Build solver hands from each contender's hole + board
      const solverHands = contenders.map(p =>
        SolverHand.solve([...p.hole, ...this.board])
      );
      const winners = SolverHand.winners(solverHands);
      const winnerSet = new Set(winners);
      const winnerPlayers = contenders.filter((_, i) => winnerSet.has(solverHands[i]));
      // Split pot, integer division; remainder goes to first winner in seat order
      // (going clockwise from the button — closest to button gets the odd chip).
      const share = Math.floor(pot.amount / winnerPlayers.length);
      let remainder = pot.amount - share * winnerPlayers.length;
      // sort winners by position relative to button (closest first)
      const sortByButton = (a, b) => {
        const aIdx = this.players.indexOf(a);
        const bIdx = this.players.indexOf(b);
        const aDist = (aIdx - this.dealerButton + this.n) % this.n;
        const bDist = (bIdx - this.dealerButton + this.n) % this.n;
        return aDist - bDist;
      };
      const ordered = [...winnerPlayers].sort(sortByButton);
      for (const w of ordered) {
        let amt = share;
        if (remainder > 0) { amt += 1; remainder--; }
        w.stack += amt;
        const solver = solverHands[contenders.indexOf(w)];
        // Pull the best-5 cards from the solver result and sort low → high.
        const winningCards = (solver?.cards || []).map(c => c.toString())
          .sort((a, b) => (RANK_ORDER[a[0]] || 0) - (RANK_ORDER[b[0]] || 0));
        this.winners.push({
          playerId: w.playerId,
          amount: amt,
          pot: potIdx,
          handDesc: describeWinningHand(solver),
          cards: w.hole,
          winningCards,
        });
        this.events.push({ type: 'win-pot', player: w.playerId, amount: amt, pot: potIdx, hand: describeWinningHand(solver) });
      }
    });

    return this._complete();
  }

  _complete() {
    this.state = STATES.COMPLETE;
    this.completedAt = Date.now();
    return { ok: true, complete: true };
  }

  // ============================================================
  // Snapshots
  // ============================================================

  publicState() {
    return {
      state: this.state,
      board: [...this.board],
      pots: this.pot.buildSidePots().map(p => ({ amount: p.amount, eligible: [...p.eligible] })),
      potTotal: this.pot.totalSize(),
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      dealerButton: this.dealerButton,
      sbIndex: this._sbIndex(),
      bbIndex: this._bbIndex(),
      actor: this.getCurrentActor(),
      // Wall-clock ms the hand started — client uses it to render the
      // total-hand elapsed timer alongside the per-turn countdown.
      startedAt: this.startedAt,
      players: this.players.map(p => ({
        seatIndex: p.seatIndex,
        playerId:  p.playerId,
        stack:     p.stack,
        invested:  p.invested,
        totalIn:   p.totalIn,
        folded:    p.folded,
        allIn:     p.allIn,
        // Hole cards only shown publicly at a real showdown — never on a
        // fold-win (winner shouldn't have to reveal if everyone else folded).
        hole: ((this.state === STATES.SHOWDOWN || this.state === STATES.COMPLETE)
               && !p.folded
               && this.winners.length > 0
               && this.winners.some(w => w.cards))
          ? p.hole : null,
      })),
      winners: this.winners,
    };
  }

  /** Private — only sent to the player it belongs to. */
  holeCardsFor(playerId) {
    const p = this.players.find(pp => pp.playerId === playerId);
    return p?.hole || null;
  }

  /** When the hand is COMPLETE, return per-player final stack so Table can sync to DB. */
  finalStacks() {
    return this.players.map(p => ({
      playerId: p.playerId,
      stack: p.stack,
      delta: p.stack - (p.stack + p.totalIn - p.totalIn), // recompute below
    })).map((row, i) => {
      const p = this.players[i];
      // initial stack = current stack + everything invested (since we deducted as we charged)
      const initial = p.stack + p.totalIn;
      // But wait — winners had pot added back to stack. So:
      //    initial = (current stack) + (totalIn invested) - (totalIn returned via wins)
      // Easier to compute delta as: sum of wins to this player - totalIn.
      return row;
    }).map((_, i) => {
      const p = this.players[i];
      const won = this.winners.filter(w => w.playerId === p.playerId).reduce((a, b) => a + b.amount, 0);
      const delta = won - p.totalIn;
      return { playerId: p.playerId, stack: p.stack, delta };
    });
  }
}

module.exports = { Hand, STATES };
