/**
 * Table — owns seats, spectators, and the current Hand.
 * Auto-starts a new hand whenever ≥2 seats hold chips and no hand is active.
 */

const db = require('../persistence/db');
const { Hand, STATES } = require('./Hand');
const { Bot } = require('../bot/Bot');
const { logHand, logBotDecision } = require('../persistence/logger');
const { strengthOf } = require('../bot/strength');
const { botRebuyMessage, humanRebuyMessage, bustMessage } = require('../util/flavor');

// Showdown pause — how long the final hand stays on screen before clearing.
// 15 s by default so everyone can read winners, hole cards, and the board.
// Override per-table via env var HAND_RESULT_PAUSE_MS if you want it shorter.
const HAND_RESULT_PAUSE_MS = parseInt(process.env.HAND_RESULT_PAUSE_MS || '15000', 10);
const HAND_AUTOSTART_DELAY_MS = parseInt(process.env.HAND_AUTOSTART_DELAY_MS || '1500', 10);
const ACTION_TIMEOUT_MS = parseInt(process.env.ACTION_TIMEOUT_MS || '120000', 10);
// Bot "thinking" time is mode-flavored — riskier bots act snappy, cautious
// ones brood. Each entry = number of d-sides; final delay is 1..N seconds.
// Hard cap 30s (cautious 1d29 already enforces this).
const BOT_TIMING = {
  risky:    { sides: 4  },   // 1d4  seconds — snap decisions
  standard: { sides: 10 },   // 1d10 seconds
  cautious: { sides: 15 },   // 1d15 seconds — they brood, but not for ever.
                              // Was 1d29; players felt that was too long.
};
function rollBotDelayMs(mode) {
  const cfg = BOT_TIMING[mode] || BOT_TIMING.standard;
  const sec = Math.floor(Math.random() * cfg.sides) + 1;
  return Math.min(sec, 30) * 1000;
}

class Seat {
  constructor(index) {
    this.index = index;
    this.playerId = null;
    this.player = null;
    this.socketId = null;
    this.inHand = false;
    this.chipsAtTable = 0;
    this.isBot = false;
    // Player keeps their seat but isn't dealt in. They can rejoin at
    // any time. Takes effect on the NEXT deal — can't undo bets or
    // exit a hand already in progress (those still resolve normally).
    this.sittingOut = false;
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
    /** Timestamp (ms since epoch) when the current human actor will be
     *  auto-folded. Null when no human is on the clock. Broadcast in
     *  publicState so clients can show a live countdown under the actor. */
    this.actionDeadline = null;
    /** Append-only chat / event log shown in the bottom panel. Ring
     *  buffer trimmed at MAX_CHAT_LOG. Each entry: { id, ts, kind, text }. */
    this.chatLog = [];
    this._chatId = 0;
    this.handCount = 0;
    /** Wall-clock ms when the next hand will be dealt. Set when the
     *  current hand completes (or autostart is scheduled). Cleared once
     *  a new hand actually starts. Drives the topbar "next hand in N"
     *  countdown. */
    this.nextHandAt = null;
    /** Loot Lord ceremony state. When non-null, the table is paused on
     *  a celebration screen showing the winner. Frontend renders a
     *  full-screen overlay; the game-state reset is deferred until
     *  resetAt ms wall-clock so everyone gets to see the big reveal.
     *  Shape: { playerId, nickname, avatarId, handCount, resetAt }. */
    this.lootLord = null;
    this._lootLordTimer = null;
  }

  // ============================================================
  // Chat log
  // ============================================================

  static MAX_CHAT_LOG = 200;
  /** Append an event line and broadcast it. `kind` is one of:
   *  hand, win, rebuy, leave, join, info, debt. */
  chat(kind, text) {
    const entry = { id: ++this._chatId, ts: Date.now(), kind, text };
    this.chatLog.push(entry);
    if (this.chatLog.length > Table.MAX_CHAT_LOG) {
      this.chatLog.splice(0, this.chatLog.length - Table.MAX_CHAT_LOG);
    }
    if (this.io) this.io.to(this.roomName()).emit('table:chat', entry);
    return entry;
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
    // A player is treated as a BOT at the seat only if EITHER:
    //   - the call was explicit (table.seatBot), OR
    //   - the player_record is is_bot AND no human socket is attached
    //     (i.e. nobody is driving them).
    // When a human picks an AI character from the roster, they sit with
    // a real socketId attached — the bot driver below is skipped so the
    // human controls the seat.
    const humanSupersede = !!socketId && !!player.is_bot;
    seat.isBot = (!!isBot || !!player.is_bot) && !humanSupersede;
    if (seat.isBot) {
      this.bots.set(playerId, new Bot({
        playerId,
        baseMode: player.bot_mode || 'standard',
        mode: player.bot_mode || 'standard',
        intelligence: player.bot_intelligence || 'average',
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
    // If a human was superseding a bot character (their underlying
    // player record is is_bot but the seat was being human-driven),
    // hand control back to the AI now that the human is gone.
    if (!seat.isBot && seat.player?.is_bot) {
      seat.isBot = true;
      this.bots.set(playerId, new Bot({
        playerId,
        baseMode: seat.player.bot_mode || 'standard',
        mode: seat.player.bot_mode || 'standard',
        intelligence: seat.player.bot_intelligence || 'average',
      }));
      this.chat('info', `🤖 The AI has resumed control of ${seat.player.nickname}.`);
    }
    this._broadcast();
  }

  // ============================================================
  // Hand lifecycle
  // ============================================================

  _seatsReadyForHand() {
    // Eligible to be dealt in:
    //   - Has chips
    //   - Has NOT clicked Sit Out
    //   - AND either is a bot OR has a live socket connection
    //     (humans whose tab is closed / network dropped sit OUT this hand)
    return this.seats.filter(s =>
      !s.isEmpty() &&
      s.chipsAtTable > 0 &&
      !s.sittingOut &&
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
    // Surface to clients so the topbar clock can count down to it.
    // Don't clobber a later nextHandAt that's already been set by _afterHandComplete.
    const planned = Date.now() + HAND_AUTOSTART_DELAY_MS;
    if (!this.nextHandAt || this.nextHandAt < planned) this.nextHandAt = planned;
    this._autostartTimer = setTimeout(() => {
      this._autostartTimer = null;
      this._maybeStartHand();
    }, HAND_AUTOSTART_DELAY_MS);
  }

  _maybeStartHand() {
    if (this.hand) return;
    // Don't deal mid-ceremony — wait for the Loot Lord reveal to finish.
    if (this.lootLord) return;
    const ready = this._seatsReadyForHand();
    if (ready.length < 2) {
      // Not enough players — keep `nextHandAt` null so the topbar shows
      // "waiting for players" instead of a misleading countdown.
      this.nextHandAt = null;
      return;
    }
    // A hand is about to start — clear the next-hand timer.
    this.nextHandAt = null;

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

    // Announce the hand in the chat log.
    this.handCount++;
    const dealer = this.hand.players[this.hand.dealerButton];
    const sb     = this.hand.players[this.hand.sbIndex];
    const bb     = this.hand.players[this.hand.bbIndex];
    this.chat('hand',
      `— Hand #${this.handCount} — Dealer: ${dealer?.nickname || '?'}`
      + (sb && bb ? ` · SB ${sb.nickname} · BB ${bb.nickname}` : '')
    );

    // Same ordering rule as applyAction: timer setup BEFORE broadcast so
    // a single emit carries the new actor's fresh deadline.
    this._maybeDriveBot();
    this._armHumanActionTimer();
    this._broadcast();              // _broadcast() also emits hole cards internally
    this._emitPrivateHoleCards();   // belt-and-suspenders for race conditions during deal
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
      this.io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
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

    // Snapshot the actor's stack BEFORE the action so we can compute
    // how many chips actually went into the pot (for the chat log).
    const actorBefore = this.hand.players.find(p => p.playerId === playerId);
    const stackBefore = actorBefore ? actorBefore.stack : 0;
    const nick = actorBefore?.nickname || playerId;
    const isBot = !!this.bots.get(playerId);

    const result = this.hand.applyAction(playerId, action, amount);
    if (!result.ok) return result;

    // ---- Per-action chat entry ----
    // One short line per turn so spectators can follow the action
    // in the chat log without having to watch the felt every second.
    try {
      const actorAfter = this.hand.players.find(p => p.playerId === playerId);
      const stackAfter = actorAfter ? actorAfter.stack : 0;
      const committed = Math.max(0, stackBefore - stackAfter);
      const tag = isBot ? '🤖 ' : '';
      let line = null;
      switch (action) {
        case 'fold':
          line = `🪦 ${tag}${nick} folded`;
          break;
        case 'check':
          line = `· ${tag}${nick} checked`;
          break;
        case 'call':
          line = committed > 0
            ? `📞 ${tag}${nick} called ${committed.toLocaleString()} gp`
            : `· ${tag}${nick} called (no chips)`;
          break;
        case 'raise': {
          const to = actorAfter ? actorAfter.invested : amount;
          line = `🎯 ${tag}${nick} raised to ${Number(to).toLocaleString()} gp`;
          break;
        }
        case 'allin':
          line = `💥 ${tag}${nick} went ALL-IN (${committed.toLocaleString()} gp)`;
          break;
        default:
          line = `${tag}${nick} ${action}`;
      }
      if (line) this.chat('action', line);
    } catch (_) { /* never let chat logging break a hand */ }

    // Set up all state changes (timers, next-hand bookkeeping) BEFORE
    // broadcasting so the single emit captures the final, consistent
    // snapshot — fresh deadlines, post-hand nextHandAt, etc. Previously
    // we broadcast first then mutated, and three separate fix-up
    // broadcasts had to compensate for the resulting stale state.
    if (this.hand.state === STATES.COMPLETE) {
      this._clearHumanActionTimer();
      this._afterHandComplete();
    } else {
      this._maybeDriveBot();   // if next actor is a bot, schedule its decision
      this._armHumanActionTimer();
    }
    this._broadcast();
    return { ok: true };
  }

  /**
   * If the current actor is a HUMAN, arm a timer that auto-folds them after
   * ACTION_TIMEOUT_MS so a disconnected / AFK player doesn't stall the table.
   * IMPORTANT: this must NOT touch actionDeadline when the actor is a bot —
   * _maybeDriveBot owns that deadline and any subsequent broadcast would
   * otherwise wipe the bot's "thinking" clock to null.
   */
  /**
   * If the current actor is a HUMAN, arm a timer that auto-folds them after
   * ACTION_TIMEOUT_MS so a disconnected / AFK player doesn't stall the table.
   * Must NOT broadcast — callers do that AFTER all timer setup is complete,
   * so a single broadcast captures the final state.
   */
  _armHumanActionTimer() {
    if (!this.hand) return;
    const actor = this.hand.getCurrentActor();
    // Bot's turn — _maybeDriveBot owns actionDeadline + the
    // thinking-delay setTimeout. Don't touch either.
    if (!actor || this.bots.has(actor)) return;
    this._clearHumanActionTimer();
    this.actionDeadline = Date.now() + ACTION_TIMEOUT_MS;
    this._humanActionTimer = setTimeout(() => {
      this._humanActionTimer = null;
      this.actionDeadline = null;
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
    this.actionDeadline = null;
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

    // Mode-flavored thinking delay: risky 1d4s, standard 1d10s, cautious 1d29s.
    const delay = rollBotDelayMs(bot.mode);
    // Surface the bot's deadline so the topbar clock ticks for everyone,
    // not just humans. Callers broadcast after all timer setup is done —
    // no internal broadcast here so we never emit a half-updated state.
    this.actionDeadline = Date.now() + delay;
    const expectedHand = this.hand;
    this._botActionTimer = setTimeout(() => {
      this._botActionTimer = null;
      // Bail if the hand changed under us (cancel, finish, etc.)
      if (this.hand !== expectedHand) return;
      if (this.hand.getCurrentActor() !== actor) return;

      const me = this.hand.players.find(p => p.playerId === actor);
      if (!me) return;

      // ---- Build opponent wealth picture so the bot can scale risk ----
      // Wealth = chips at the table + total magic-item value. We pass the
      // bot's own wealth and a list of still-live opponents (non-folded).
      // The aggressor (last raiser) is flagged so the bot can weigh how
      // credible the bet is given who's firing it.
      const myGear = db.gearTotalValue(db.getGear(actor) || {});
      const selfWealth = me.stack + myGear;
      const opponents = [];
      let aggressorWealth = null;
      let aggressorId = null;
      for (let i = 0; i < this.hand.players.length; i++) {
        const p = this.hand.players[i];
        if (p.playerId === actor) continue;
        if (p.folded) continue;
        const oppGear = db.gearTotalValue(db.getGear(p.playerId) || {});
        const oppWealth = p.stack + oppGear;
        opponents.push({
          playerId: p.playerId,
          stack: p.stack,
          gearValue: oppGear,
          wealth: oppWealth,
          invested: p.invested,
          allIn: p.allIn,
        });
        if (i === this.hand.lastRaiser) {
          aggressorWealth = oppWealth;
          aggressorId = p.playerId;
        }
      }

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
        // New: wealth-aware fields
        selfWealth,
        selfGear: myGear,
        opponents,
        aggressorWealth,
        aggressorId,
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
    // Announce winners in the chat log before we tear the hand down.
    try {
      const ws = this.hand.winners || [];
      const nickById = new Map(this.hand.players.map(p => [p.playerId, p.nickname]));
      for (const w of ws) {
        const nick = nickById.get(w.playerId) || w.playerId;
        const amt  = (w.amount || 0).toLocaleString();
        const hand = w.handDesc ? ` with ${w.handDesc}` : '';
        this.chat('win', `🏆 ${nick} wins ${amt} gp${hand}.`);
      }
    } catch (e) { /* never let logging break a hand */ }

    // Sync seat chips from hand state + persist to DB.
    for (const p of this.hand.players) {
      const seat = this.seats[p.seatIndex];
      if (!seat || seat.playerId !== p.playerId) continue;
      seat.chipsAtTable = p.stack;
      db.setChips(p.playerId, p.stack);
    }

    // ---- Feed bot bluff memory ----
    // For every player whose hole cards were revealed (showdown
    // contenders + fold-win winner), classify their action this
    // hand as BLUFF or VALUE based on revealed strength vs how
    // many chips they committed. Then notify each seated bot so
    // they remember this opponent's tendencies going forward.
    //
    //   BLUFF  : committed ≥ 4 BB AND revealed strength < 0.40
    //   VALUE  : committed ≥ 4 BB AND revealed strength ≥ 0.55
    //   IGNORE : low commitment (no signal) OR marginal strength
    //
    // Folded players are skipped — their cards stay hidden, no signal.
    try {
      const MIN_COMMIT = this.bigBlind * 4;
      const revealedThisHand = [];
      for (const p of this.hand.players) {
        if (p.folded) continue;                  // folded → hole not revealed
        if (!p.hole || p.hole.length !== 2) continue;
        if ((p.totalIn || 0) < MIN_COMMIT) continue;
        const strength = strengthOf(p.hole, this.hand.board);
        if (strength >= 0.55) revealedThisHand.push({ playerId: p.playerId, isBluff: false });
        else if (strength < 0.40) revealedThisHand.push({ playerId: p.playerId, isBluff: true });
        // else: marginal — no clear signal, skip
      }
      if (revealedThisHand.length > 0) {
        for (const bot of this.bots.values()) {
          for (const r of revealedThisHand) bot.noteOpponentReveal(r.playerId, r.isBluff);
        }
      }
    } catch (_) { /* never let memory updates break a hand */ }

    // ---- Bot auto-invest in gear (breadth-first) ----
    // Bots spend excess chips on magic items, but the AI strategy is
    // *breadth-first*: fill every slot at +1 before any slot gets +2,
    // every slot at +2 before any slot gets +3, etc. — building toward
    // a balanced kit instead of one shiny +5 weapon. Keeps a chip
    // reserve (≥ DEFAULT_STACK) so the bot stays solvent for blinds.
    for (const seat of this.seats) {
      if (seat.isEmpty() || !seat.isBot) continue;
      const plan = this._planBotGearPurchase(seat);
      if (!plan) continue;
      const { slot, target, cost } = plan;
      const gear = db.getGear(seat.playerId);
      const prev = gear[slot] || 0;
      gear[slot] = target;
      db.setGear(seat.playerId, gear);
      seat.chipsAtTable -= cost;
      db.setChips(seat.playerId, seat.chipsAtTable);
      const nick = seat.player?.nickname || seat.playerId;
      const itemName = db.GEAR_BY_KEY[slot].label;
      const verb = prev > 0 ? `upgraded to +${target}` : `picked up a +${target}`;
      this.chat('rebuy', `🛒 ${nick} ${verb} ${itemName} for ${cost.toLocaleString()} gp.`);
    }

    // Loot Lord check — if anyone now holds +5 in every gear slot, they
    // win the entire game. _declareLootLord posts the celebration and
    // resets EVERYONE'S chips + gear back to defaults; the rest of the
    // function still runs so the next hand schedules normally.
    const lord = this._checkLootLord();
    if (lord) this._declareLootLord(lord);
    // Push a fresh roster so every client's topbar (state.me.chips) updates.
    if (this.io) this.io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
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
    // Tell clients roughly when the next hand will be dealt. Used by the
    // topbar countdown clock to switch from action-deadline mode to
    // "next hand in N" mode while everyone catches their breath.
    this.nextHandAt = Date.now() + HAND_RESULT_PAUSE_MS + HAND_AUTOSTART_DELAY_MS;
    // No broadcast here — applyAction broadcasts AFTER calling us so
    // the client gets one consistent snapshot with nextHandAt set,
    // actionDeadline cleared, and chips synced.
    if (this._completeTimer) clearTimeout(this._completeTimer);
    this._completeTimer = setTimeout(() => {
      this._completeTimer = null;
      // Clear hand only after pause so clients can render showdown via the COMPLETE snapshot.
      if (this.hand === finishedHand) this.hand = null;
      // Handle broke seats. Humans vacate; bots auto-rebuy back to the
      // default stack and stay seated (we want a persistent house roster
      // of NPCs, not seats that drain to zero and disappear).
      let vacated = 0, rebought = 0;
      for (const seat of this.seats) {
        if (seat.isEmpty() || seat.chipsAtTable > 0) continue;
        if (seat.isBot) {
          const nick = seat.player?.nickname || seat.playerId;
          seat.chipsAtTable = db.DEFAULT_STACK;
          db.setChips(seat.playerId, db.DEFAULT_STACK);
          this.chat('rebuy', botRebuyMessage(nick, db.DEFAULT_STACK));
          rebought++;
        } else {
          const nick = seat.player?.nickname || seat.playerId;
          this.chat('leave', bustMessage(nick));
          this._vacate(seat);
          vacated++;
        }
      }
      if (rebought > 0) {
        console.log(`[poker] auto-rebought ${rebought} bot seat(s) at table ${this.id}`);
      }
      // Bots may shift mode at the end of each hand.
      for (const bot of this.bots.values()) bot.maybeShiftMode();
      // Push a fresh roster so clients see the bank totals AND the seat changes.
      if (vacated > 0 && this.io) {
        this.io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
      }
      this._broadcast();
      this._scheduleAutoStart();
    }, HAND_RESULT_PAUSE_MS);
  }

  // ============================================================
  // Magic-longsword auto-invest (PF1e flavor)
  // ============================================================

  /** Plan ONE gear purchase for a bot this hand. Returns
   *  `{ slot, target, cost }` or null if nothing affordable.
   *
   *  Strategy: breadth-first. The bot wants every slot at +N before
   *  any slot reaches +(N+1) — start by completing the +1 set across
   *  all five slots, then move to +2, etc. up to +5 (LOOT LORD).
   *  Among slots that are still at the lowest current tier (minTier),
   *  the bot picks the *cheapest* upgrade it can afford.
   *
   *  A reserve of DEFAULT_STACK chips is held back so the bot can
   *  still pay blinds and call modest bets after the purchase. */
  _planBotGearPurchase(seat) {
    const RESERVE = db.DEFAULT_STACK;
    const available = seat.chipsAtTable - RESERVE;
    if (available <= 0) return null;

    const gear = db.getGear(seat.playerId);
    let minTier = 5;
    for (const s of db.GEAR_SLOTS) {
      const t = gear[s.key] || 0;
      if (t < minTier) minTier = t;
    }
    if (minTier >= 5) return null;   // already maxed — Loot Lord triggers separately
    const targetTier = minTier + 1;

    // Affordable upgrades for slots currently sitting at minTier.
    const candidates = [];
    for (const s of db.GEAR_SLOTS) {
      const cur = gear[s.key] || 0;
      if (cur !== minTier) continue;
      const cost = db.gearPrice(s.key, targetTier) - (cur ? db.gearPrice(s.key, cur) : 0);
      if (cost > available) continue;
      candidates.push({ slot: s.key, target: targetTier, cost });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.cost - b.cost);
    return candidates[0];
  }

  /** Scan all seated players. If exactly one has +5 in every gear slot,
   *  return that seat. If multiple do simultaneously (rare but possible
   *  if two bots both upgrade in this hand's auto-buy phase), return
   *  whichever has the highest chip stack at the table — they earned it.
   *  Returns null if no Loot Lord this hand. */
  _checkLootLord() {
    const winners = [];
    for (const seat of this.seats) {
      if (seat.isEmpty()) continue;
      const gear = db.getGear(seat.playerId);
      if (db.gearIsLootLord(gear)) winners.push(seat);
    }
    if (winners.length === 0) return null;
    winners.sort((a, b) => b.chipsAtTable - a.chipsAtTable);
    return winners[0];
  }

  /** Crown the Loot Lord and start the ceremony. Doesn't reset state
   *  immediately — sets `this.lootLord` so the frontend can show a big
   *  reveal screen for LOOT_LORD_CEREMONY_MS, then `_resetForNextRun`
   *  fires the actual chip/gear wipe.
   *
   *  If a ceremony is already in progress (e.g. multiple bots cross
   *  the line on the same hand), the first winner stays — this is a
   *  no-op for subsequent calls. */
  _declareLootLord(seat) {
    if (this.lootLord) return;   // already crowned this game

    const nick = seat.player?.nickname || seat.playerId;
    const CEREMONY_MS = parseInt(process.env.LOOT_LORD_CEREMONY_MS || '20000', 10);
    const resetAt = Date.now() + CEREMONY_MS;

    db.recordChampion({
      playerId:    seat.playerId,
      nickname:    nick,
      avatarId:    seat.player?.avatar_id || null,
      handsToWin:  this.handCount,
      finalChips:  seat.chipsAtTable,
    });
    this.chat('lootlord', `👑 LOOTMAXXING LOOT LORD: ${nick}! Full +5 set assembled after ${this.handCount} hand${this.handCount===1?'':'s'}.`);
    this.chat('lootlord', `🎲 Game resets in ${Math.round(CEREMONY_MS/1000)} seconds — savor the crown.`);

    // Pause the action-timer machinery so no auto-fold fires during the show.
    this._clearHumanActionTimer();
    if (this._botActionTimer) { clearTimeout(this._botActionTimer); this._botActionTimer = null; }
    this.actionDeadline = null;

    this.lootLord = {
      playerId:  seat.playerId,
      nickname:  nick,
      avatarId:  seat.player?.avatar_id || null,
      handCount: this.handCount,
      finalChips: seat.chipsAtTable,
      resetAt,
    };

    this._lootLordTimer = setTimeout(() => {
      this._lootLordTimer = null;
      this._resetForNextRun();
    }, CEREMONY_MS);

    this._broadcast();
  }

  /** Wipe chips + gear + debt for every player. Clears the ceremony
   *  state. Sends fresh roster + state so clients drop the overlay
   *  and resume normal play. Called after LOOT_LORD_CEREMONY_MS. */
  _resetForNextRun() {
    const resetAll = db.db.prepare(`
      UPDATE players SET chips = ?, gear = '{}', swords = '{}', rebuy_debt = 0
    `);
    resetAll.run(db.DEFAULT_STACK);
    for (const s of this.seats) {
      if (s.isEmpty()) continue;
      s.chipsAtTable = db.DEFAULT_STACK;
    }
    this.handCount = 0;
    this.lootLord = null;
    this.chat('lootlord', `🃏 New game. Everyone back to ${db.DEFAULT_STACK.toLocaleString()} gp, gear cleared.`);
    if (this.io) {
      this.io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
    }
    this._broadcast();
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
        // True when a human clicked "× remove this bot" mid-hand. The seat
        // will vacate as soon as the current hand resolves.
        pendingStand: !!s._standAfterHand,
        // Player has clicked "Sit out" — they keep the seat but skip
        // upcoming deals until they click "Rejoin".
        sittingOut: !!s.sittingOut,
        // Gear inventory (PF1e). Map of slot → tier (1..5) or null.
        gear: s.isEmpty() ? null : db.getGear(s.playerId),
        gearValue: s.isEmpty() ? 0 : db.gearTotalValue(db.getGear(s.playerId)),
      })),
      spectatorCount: this.spectators.size,
      hand,
      // Wall-clock ms when the current human actor will be auto-folded.
      // Null when no human is on the clock (waiting, bot turn, between hands).
      actionDeadline: this.actionDeadline,
      // Wall-clock ms when the next hand is scheduled to start (only set
      // between hands or while autostart is pending; null during a live hand).
      nextHandAt: this.nextHandAt,
      // Last 60 chat-log entries so newly-joined / refreshed clients
      // see context, not an empty panel.
      chatLog: this.chatLog.slice(-60),
      // Active Loot Lord celebration. null normally; { playerId,
      // nickname, avatarId, handCount, finalChips, resetAt } during
      // the ceremony pause between win and game-reset.
      lootLord: this.lootLord,
    };
  }
}

module.exports = { Table, Seat };
