/**
 * Table — owns seats, spectators, and the current Hand.
 * Auto-starts a new hand whenever ≥2 seats hold chips and no hand is active.
 */

const db = require('../persistence/db');
const { Hand, STATES } = require('./Hand');
const { Bot } = require('../bot/Bot');
const { logHand, logBotDecision } = require('../persistence/logger');
const { strengthOf } = require('../bot/strength');

const HAND_RESULT_PAUSE_MS = parseInt(process.env.HAND_RESULT_PAUSE_MS || '6000', 10);
const HAND_AUTOSTART_DELAY_MS = parseInt(process.env.HAND_AUTOSTART_DELAY_MS || '1500', 10);
const BOT_THINK_MIN_MS = parseInt(process.env.BOT_THINK_MIN_MS || '900', 10);
const BOT_THINK_MAX_MS = parseInt(process.env.BOT_THINK_MAX_MS || '2200', 10);
const ACTION_TIMEOUT_MS = parseInt(process.env.ACTION_TIMEOUT_MS || '45000', 10);

class Seat {
  constructor(index) {
    this.index = index;
    this.playerId = null;
    this.player = null;
    this.socketId = null;
    this.inHand = false;
    this.chipsAtTable = 0;
    this.isBot = false;
  }
  isEmpty() { return this.playerId === null; }
}

class Table {
  constructor({ id, maxSeats = 9, smallBlind = 25, bigBlind = 50, io = null }) {
    this.id = id;
    this.maxSeats = maxSeats;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.seats = Array.from({ length: maxSeats }, (_, i) => new Seat(i));
    this.spectators = new Map();
    this.hand = null;
    /** position in the *seated-this-hand* participants array */
    this.dealerButtonSeatIndex = -1;
    this.io = io;
    this._autostartTimer = null;
    this._completeTimer = null;
    /** playerId -> Bot instance for bots currently seated here */
    this.bots = new Map();
    this._botActionTimer = null;
    this._humanActionTimer = null;
  }

  setIo(io) { this.io = io; }
  roomName() { return `table:${this.id}`; }

  // ============================================================
  // Seating
  // ============================================================

  findSeat(playerId) { return this.seats.find(s => s.playerId === playerId) || null; }
  findSeatBySocket(socketId) { return this.seats.find(s => s.socketId === socketId) || null; }
  firstOpenSeat() { return this.seats.find(s => s.isEmpty()) || null; }

  addSpectator({ playerId, socketId, player }) {
    if (this.findSeat(playerId)) return;
    this.spectators.set(playerId, { socketId, player });
  }
  removeSpectator(playerId) { this.spectators.delete(playerId); }

  sit({ playerId, socketId, player, seatIndex, isBot = false }) {
    if (this.findSeat(playerId)) return { ok: false, error: 'already seated' };
    let seat;
    if (Number.isInteger(seatIndex) && seatIndex >= 0 && seatIndex < this.maxSeats) {
      seat = this.seats[seatIndex];
      if (!seat.isEmpty()) return { ok: false, error: 'seat taken' };
    } else {
      seat = this.firstOpenSeat();
      if (!seat) return { ok: false, error: 'table full' };
    }
    if (player.chips <= 0) return { ok: false, error: 'no chips — re-buy first' };

    seat.playerId = playerId;
    seat.player = player;
    seat.socketId = socketId;
    seat.chipsAtTable = player.chips;
    seat.isBot = !!isBot || !!player.is_bot;
    if (seat.isBot) {
      this.bots.set(playerId, new Bot({
        playerId,
        baseMode: player.bot_mode || 'standard',
        mode: player.bot_mode || 'standard',
      }));
    }
    this.spectators.delete(playerId);
    this._scheduleAutoStart();
    return { ok: true, seatIndex: seat.index };
  }

  /** Add a bot to the table by player_id. Returns { ok, seatIndex } or error. */
  seatBot(playerId) {
    const player = db.getPlayer(playerId);
    if (!player) return { ok: false, error: 'unknown bot' };
    if (!player.is_bot) return { ok: false, error: 'not a bot' };
    return this.sit({ playerId, socketId: null, player, isBot: true });
  }

  stand(playerId) {
    const seat = this.findSeat(playerId);
    if (!seat) return { ok: false, error: 'not seated' };
    if (this.hand && this._inHandPlayerIds().has(playerId)) {
      // Mid-hand: treat as a fold via the hand engine, then vacate after the hand resolves.
      this._foldMidHandAndVacate(playerId, seat);
      return { ok: true };
    }
    this._vacate(seat);
    return { ok: true };
  }

  _vacate(seat) {
    // Persist their chips back to the DB before clearing.
    if (seat.playerId) {
      db.setChips(seat.playerId, seat.chipsAtTable);
      this.bots.delete(seat.playerId);
    }
    seat.playerId = null;
    seat.player = null;
    seat.socketId = null;
    seat.inHand = false;
    seat.chipsAtTable = 0;
    seat.isBot = false;
  }

  _foldMidHandAndVacate(playerId, seat) {
    // Best-effort: ask the hand engine to fold if it's their turn; otherwise mark
    // them folded by setting folded=true directly on the in-hand record.
    if (this.hand && this.hand.getCurrentActor() === playerId) {
      this.hand.applyAction(playerId, 'fold');
    } else if (this.hand) {
      const p = this.hand.players.find(pp => pp.playerId === playerId);
      if (p && !p.folded) {
        p.folded = true;
        this.hand.pot.fold(playerId);
        // If only one live player remains, end the hand.
        const live = this.hand.players.filter(q => !q.folded);
        if (live.length === 1) this.hand._winByFold(live[0]);
      }
    }
    seat._standAfterHand = true;
    this._broadcast();
  }

  handleDisconnect(playerId) {
    this.removeSpectator(playerId);
    const seat = this.findSeat(playerId);
    if (!seat) return;
    // PERSISTENT SEAT: keep the seat reserved when the socket disconnects.
    // The player can refresh / reconnect and pick up where they left off.
    // We only mark their socket null; the action timer will auto-fold them
    // if it's their turn and they don't come back in time.
    seat.socketId = null;
    this._broadcast();
  }

  // ============================================================
  // Hand lifecycle
  // ============================================================

  _seatsReadyForHand() {
    // Eligible to be dealt in:
    //   - Has chips
    //   - AND either is a bot OR has a live socket connection
    //     (humans whose tab is closed / network dropped sit OUT this hand)
    return this.seats.filter(s =>
      !s.isEmpty() &&
      s.chipsAtTable > 0 &&
      (s.isBot || s.socketId)
    );
  }

  /** True if this seat is a human who's currently disconnected. */
  _isSeatAfk(s) {
    return !s.isEmpty() && !s.isBot && !s.socketId;
  }

  _inHandPlayerIds() {
    if (!this.hand) return new Set();
    return new Set(this.hand.players.map(p => p.playerId));
  }

  _scheduleAutoStart() {
    if (this.hand) return;
    if (this._autostartTimer) return;
    this._autostartTimer = setTimeout(() => {
      this._autostartTimer = null;
      this._maybeStartHand();
    }, HAND_AUTOSTART_DELAY_MS);
  }

  _maybeStartHand() {
    if (this.hand) return;
    const ready = this._seatsReadyForHand();
    if (ready.length < 2) return;

    // Rotate the dealer button — pick the next eligible seat clockwise.
    const buttonOrder = this._nextButtonIndex(ready);
    const participantsInOrder = this._participantsFromButton(ready, buttonOrder);

    this.hand = new Hand({
      seats: participantsInOrder.map(s => ({
        index: s.index,
        playerId: s.playerId,
        player: s.player,
        chipsAtTable: s.chipsAtTable,
      })),
      dealerButton: 0,   // by construction, button is participants[0]
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
    });
    this.hand.start();

    // Mark seats as in-hand and snapshot starting stack for chip movements
    for (const s of this.seats) s.inHand = false;
    for (const p of this.hand.players) {
      const s = this.seats[p.seatIndex];
      if (s) s.inHand = true;
    }

    this._broadcast();
    this._emitPrivateHoleCards();
    this._maybeDriveBot();
    this._armHumanActionTimer();
  }

  _nextButtonIndex(ready) {
    // ready is in Table seat-index order. Find the seat to the left of the last button.
    if (this.dealerButtonSeatIndex < 0) {
      // First hand of the session: button on the first ready seat.
      this.dealerButtonSeatIndex = ready[0].index;
      return this.dealerButtonSeatIndex;
    }
    const lastButton = this.dealerButtonSeatIndex;
    // Walk clockwise from lastButton+1 until we hit a ready seat.
    for (let off = 1; off <= this.maxSeats; off++) {
      const cand = (lastButton + off) % this.maxSeats;
      if (ready.find(r => r.index === cand)) {
        this.dealerButtonSeatIndex = cand;
        return cand;
      }
    }
    return ready[0].index;
  }

  _participantsFromButton(ready, buttonSeatIndex) {
    // Reorder so that the button player is at index 0, then clockwise from there.
    const sorted = [...ready].sort((a, b) => a.index - b.index);
    const startIdx = sorted.findIndex(s => s.index === buttonSeatIndex);
    if (startIdx < 0) return sorted;
    return sorted.slice(startIdx).concat(sorted.slice(0, startIdx));
  }

  /**
   * Cancel the current hand without paying out. Refund every player's
   * in-hand contributions back to their seat stack. Used by the "Reset"
   * button. Safe to call when no hand is active (no-op).
   */
  cancelHand() {
    if (this._completeTimer) { clearTimeout(this._completeTimer); this._completeTimer = null; }
    if (this._autostartTimer) { clearTimeout(this._autostartTimer); this._autostartTimer = null; }
    this._clearHumanActionTimer();
    if (this._botActionTimer) { clearTimeout(this._botActionTimer); this._botActionTimer = null; }
    if (this.hand) {
      // Refund: give each player back exactly what they put in this hand.
      for (const p of this.hand.players) {
        const seat = this.seats[p.seatIndex];
        if (!seat || seat.playerId !== p.playerId) continue;
        const refund = p.totalIn;       // chips this player put into the pot
        seat.chipsAtTable = p.stack + refund;
        db.setChips(p.playerId, seat.chipsAtTable);
      }
      this.hand = null;
    }
    for (const s of this.seats) s.inHand = false;
    if (this.io) {
      this.io.emit('roster', { players: db.listHumans(), defaultStack: db.DEFAULT_STACK });
    }
    this._broadcast();
    this._scheduleAutoStart();
  }

  /**
   * Full game reset: cancel hand, refund, then set every seated player's
   * stack to DEFAULT_STACK and bulk-reset every roster player's chip total.
   */
  resetGame() {
    this.cancelHand();
    const DEFAULT = db.DEFAULT_STACK;
    // Reset every seated player's table stack
    for (const seat of this.seats) {
      if (!seat.isEmpty()) {
        seat.chipsAtTable = DEFAULT;
        db.setChips(seat.playerId, DEFAULT);
      }
    }
    // Reset every roster player's bank too
    for (const p of db.listHumans()) {
      db.setChips(p.player_id, DEFAULT);
    }
    // Wipe stats — db has no bulk-reset helper; do it via raw query
    try { db.db.prepare('UPDATE players SET total_won = 0, total_lost = 0, hands_played = 0').run(); } catch (e) { /* fine */ }
    // Reset dealer button so next hand starts fresh
    this.dealerButtonSeatIndex = -1;
    if (this.io) this.io.emit('roster', { players: db.listHumans(), defaultStack: DEFAULT });
    this._broadcast();
    this._scheduleAutoStart();
  }

  applyAction({ playerId, action, amount }) {
    if (!this.hand) return { ok: false, error: 'no active hand' };
    const before = this.hand.state;
    const result = this.hand.applyAction(playerId, action, amount);
    if (!result.ok) return result;

    // If hand transitioned or completed, broadcast + handle next steps.
    this._broadcast();

    if (this.hand.state === STATES.COMPLETE) {
      this._clearHumanActionTimer();
      this._afterHandComplete();
    } else {
      this._maybeDriveBot();   // if next actor is a bot, schedule its decision
      this._armHumanActionTimer();
    }
    return { ok: true };
  }

  /**
   * If the current actor is a HUMAN, arm a timer that auto-folds them after
   * ACTION_TIMEOUT_MS so a disconnected / AFK player doesn't stall the table.
   */
  _armHumanActionTimer() {
    this._clearHumanActionTimer();
    if (!this.hand) return;
    const actor = this.hand.getCurrentActor();
    if (!actor) return;
    if (this.bots.has(actor)) return;   // bots have their own timer
    this._humanActionTimer = setTimeout(() => {
      this._humanActionTimer = null;
      if (!this.hand || this.hand.getCurrentActor() !== actor) return;
      console.log('[poker] action timeout — auto-folding', actor);
      this.applyAction({ playerId: actor, action: 'fold' });
    }, ACTION_TIMEOUT_MS);
  }

  _clearHumanActionTimer() {
    if (this._humanActionTimer) {
      clearTimeout(this._humanActionTimer);
      this._humanActionTimer = null;
    }
  }

  /**
   * If the current actor is a bot, schedule its decision after a short
   * "thinking" delay so it feels human. Safe to call repeatedly; only one
   * bot-action timer at a time.
   */
  _maybeDriveBot() {
    if (this._botActionTimer) return;
    if (!this.hand) return;
    const actor = this.hand.getCurrentActor();
    if (!actor) return;
    const bot = this.bots.get(actor);
    if (!bot) return;

    const delay = BOT_THINK_MIN_MS + Math.random() * (BOT_THINK_MAX_MS - BOT_THINK_MIN_MS);
    const expectedHand = this.hand;
    this._botActionTimer = setTimeout(() => {
      this._botActionTimer = null;
      // Bail if the hand changed under us (cancel, finish, etc.)
      if (this.hand !== expectedHand) return;
      if (this.hand.getCurrentActor() !== actor) return;

      const me = this.hand.players.find(p => p.playerId === actor);
      if (!me) return;
      const decideCtx = {
        hole: me.hole,
        board: this.hand.board,
        toCall: Math.max(0, this.hand.currentBet - me.invested),
        potTotal: this.hand.pot.totalSize(),
        stack: me.stack,
        currentBet: this.hand.currentBet,
        invested: me.invested,
        minRaise: this.hand.minRaise,
        bigBlind: this.bigBlind,
      };
      const decision = bot.decide(decideCtx);
      console.log(`[bot] ${actor} (${bot.mode}) → ${decision.action}${decision.amount != null ? ' to ' + decision.amount : ''}  // ${decision.reason}`);
      // Persist for offline analysis. Strength recomputed for record (cheap).
      logBotDecision({
        tableId: this.id,
        playerId: actor,
        mode: bot.mode,
        baseMode: bot.baseMode,
        decision,
        context: {
          strength: strengthOf(me.hole, this.hand.board),
          state: this.hand.state,
          boardLen: this.hand.board.length,
          pot: decideCtx.potTotal,
          toCall: decideCtx.toCall,
          stack: decideCtx.stack,
          currentBet: decideCtx.currentBet,
          invested: decideCtx.invested,
        },
      });
      this.applyAction({ playerId: actor, action: decision.action, amount: decision.amount });
    }, delay);
  }

  _afterHandComplete() {
    // Sync seat chips from hand state + persist to DB.
    for (const p of this.hand.players) {
      const seat = this.seats[p.seatIndex];
      if (!seat || seat.playerId !== p.playerId) continue;
      seat.chipsAtTable = p.stack;
      db.setChips(p.playerId, p.stack);
    }
    // Push a fresh roster so every client's topbar (state.me.chips) updates.
    if (this.io) this.io.emit('roster', { players: db.listHumans(), defaultStack: db.DEFAULT_STACK });
    // Record hand history (SQLite — for the UI/admin).
    try {
      db.insertHand({
        tableId: this.id,
        board: this.hand.board.join(' '),
        players: this.hand.players.map(p => ({
          playerId: p.playerId, nickname: p.nickname, hole: p.hole, totalIn: p.totalIn, finalStack: p.stack, folded: p.folded,
        })),
        winners: this.hand.winners,
      });
    } catch (e) { console.error('[hand-history]', e); }

    // Append-only JSONL log for offline analysis (bind-mounted to host).
    try {
      logHand({
        tableId: this.id,
        hand: this.hand,
        durationMs: (this.hand.completedAt || Date.now()) - this.hand.startedAt,
      });
    } catch (e) { console.error('[hand-log]', e); }

    // Vacate any seats flagged for mid-hand stand.
    for (const seat of this.seats) {
      if (seat._standAfterHand) {
        delete seat._standAfterHand;
        this._vacate(seat);
      }
    }
    for (const seat of this.seats) seat.inHand = false;

    // Hold the completed hand briefly so the client can show showdown, then start next.
    const finishedHand = this.hand;
    if (this._completeTimer) clearTimeout(this._completeTimer);
    this._completeTimer = setTimeout(() => {
      this._completeTimer = null;
      // Clear hand only after pause so clients can render showdown via the COMPLETE snapshot.
      if (this.hand === finishedHand) this.hand = null;
      // Vacate broke players so the next hand can size correctly.
      let vacated = 0;
      for (const seat of this.seats) {
        if (!seat.isEmpty() && seat.chipsAtTable <= 0) {
          this._vacate(seat);
          vacated++;
        }
      }
      // Bots may shift mode at the end of each hand.
      for (const bot of this.bots.values()) bot.maybeShiftMode();
      // Push a fresh roster so clients see the bank totals AND the seat changes.
      if (vacated > 0 && this.io) {
        this.io.emit('roster', { players: db.listHumans(), defaultStack: db.DEFAULT_STACK });
      }
      this._broadcast();
      this._scheduleAutoStart();
    }, HAND_RESULT_PAUSE_MS);
  }

  // ============================================================
  // Broadcast
  // ============================================================

  _broadcast() {
    if (!this.io) return;
    this.io.to(this.roomName()).emit('table:state', this.publicState());
    // Re-emit hole cards on every public-state broadcast. Cheap and
    // guarantees that every connected participant always has their cards,
    // even if the deal-time emit happened to race a reconnect.
    if (this.hand && this.hand.state !== STATES.WAITING) {
      this._emitPrivateHoleCards();
    }
  }

  _emitPrivateHoleCards() {
    if (!this.io || !this.hand) return;
    // Iterate every connected socket in this room and emit to each their
    // own hole cards. Bypasses seat.socketId entirely — robust across any
    // sequence of reconnects/refreshes.
    const room = this.io.sockets.adapter.rooms.get(this.roomName());
    if (!room) return;
    for (const sid of room) {
      const s = this.io.sockets.sockets.get(sid);
      const playerId = s?.data?.player?.player_id;
      if (!playerId) continue;
      const p = this.hand.players.find(pp => pp.playerId === playerId);
      if (!p) continue;
      s.emit('table:hole', { playerId, hole: p.hole });
    }
  }

  // ============================================================
  // Snapshots
  // ============================================================

  publicSummary() {
    return {
      id: this.id,
      maxSeats: this.maxSeats,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      seated: this.seats.filter(s => !s.isEmpty()).length,
      spectators: this.spectators.size,
    };
  }

  publicState() {
    const hand = this.hand ? this.hand.publicState() : null;
    return {
      id: this.id,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      dealerButtonSeatIndex: this.dealerButtonSeatIndex,
      seats: this.seats.map(s => ({
        index: s.index,
        occupied: !s.isEmpty(),
        playerId: s.playerId,
        nickname: s.player?.nickname || null,
        avatarId: s.player?.avatar_id || null,
        chips: s.chipsAtTable,
        inHand: s.inHand,
        isBot: s.isBot,
        botMode: s.isBot ? (this.bots.get(s.playerId)?.mode || null) : null,
        isAfk: this._isSeatAfk(s),
      })),
      spectatorCount: this.spectators.size,
      hand,
    };
  }
}

module.exports = { Table, Seat };
