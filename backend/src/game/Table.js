/**
 * Table — owns seats, spectators, and the current Hand.
 * Auto-starts a new hand whenever ≥2 seats hold chips and no hand is active.
 */

const db = require('../persistence/db');
const { Hand, STATES } = require('./Hand');
const { Bot } = require('../bot/Bot');
const { logHand, logBotDecision, logChat, getRecords, resetRecords, recordSound } = require('../persistence/logger');
const { gold } = require('../util/numwords');
const { strengthOf } = require('../bot/strength');
const { botRebuyMessage, botBorrowMessage, botHockMessage, humanRebuyMessage, bustMessage } = require('../util/flavor');
// A bot prefers to borrow from Abadar (keeping its magic items). Only once its
// debt climbs past this does it pawn an item as a last resort to stay seated.
const BOT_DEBT_CEILING = 30000;   // ~6 rebuys deep
const banter = require('../bot/banter');

// Showdown pause — how long the final hand stays on screen before clearing.
// 15 s by default so everyone can read winners, hole cards, and the board.
// Override per-table via env var HAND_RESULT_PAUSE_MS if you want it shorter.
const HAND_RESULT_PAUSE_MS = parseInt(process.env.HAND_RESULT_PAUSE_MS || '15000', 10);
const HAND_AUTOSTART_DELAY_MS = parseInt(process.env.HAND_AUTOSTART_DELAY_MS || '1500', 10);
// Extended autostart delay after a seat just vacated, so a watching
// spectator has time to click the now-empty seat before the next
// hand begins (otherwise they have to wait another full hand).
const HAND_GRACE_DELAY_MS     = parseInt(process.env.HAND_GRACE_DELAY_MS    || '5000', 10);
const ACTION_TIMEOUT_MS = parseInt(process.env.ACTION_TIMEOUT_MS || '120000', 10);

// Unique-per-process tag for chat entry ids. The client dedups chat lines by
// id; a bare ++counter resets to 1 on every server restart, so the client's
// already-seen set would silently DROP the new lines (chat appears frozen
// until a manual refresh). Tagging every id with a fresh per-process token
// makes ids collision-free across restarts — the real fix for "chat stopped
// updating after a deploy".
const CHAT_ID_TAG = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
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
    // Optional per-seat avatar override. Used today by Vorkstag (the
    // skinwalker serial killer) — when seated, he picks a random
    // tablemate's avatar and wears their face. Stored at the SEAT
    // level (not the DB), so leaving the table restores his true
    // visage and a fresh seating picks a fresh disguise.
    this.avatarOverride = null;
    // Nickname of the player whose face/voice we're impersonating
    // (Vorkstag only). When set, the 11labs voice lookup routes
    // through this name instead of "Vorkstag" so he sounds like
    // whoever he's wearing.
    this.impersonatedNick = null;
  }
  isEmpty() { return this.playerId === null; }
  effectiveAvatar() {
    return this.avatarOverride || this.player?.avatar_id || null;
  }
  /** Display name to show OTHER players + record in chat lines.
   *  For Vorkstag the impersonatedNick replaces his real one so
   *  the table can't see who he actually is — the deception covers
   *  visual avatar AND text label. Cash, gear, and debt amounts
   *  stay accurate (the Church of Abadar can't be fooled), so a
   *  careful observer can still spot an anomaly. */
  displayNickname() {
    return this.impersonatedNick || this.player?.nickname || this.playerId;
  }
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
    /** True if a seat just vacated (kick, auto-yield, voluntary leave,
     *  bust). _scheduleAutoStart uses this to extend the next-hand
     *  delay so a watching spectator has time to click in. Cleared
     *  once consumed. */
    this._seatVacatedRecently = false;
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
   *  hand, win, rebuy, leave, join, info, debt, banter, human, action.
   *  Optional `extras` is merged into the emitted event but NOT stored
   *  in the persisted chatLog — used for one-shot per-broadcast payloads
   *  like 11labs base64 audio that would otherwise blow up memory and
   *  re-broadcast every time a fresh state snapshot ships. */
  chat(kind, text, extras) {
    const entry = { id: `${CHAT_ID_TAG}-${this.id}-${++this._chatId}`, ts: Date.now(), kind, text };
    this.chatLog.push(entry);
    if (this.chatLog.length > Table.MAX_CHAT_LOG) {
      this.chatLog.splice(0, this.chatLog.length - Table.MAX_CHAT_LOG);
    }
    // Persist to conversation.jsonl: the full timestamped transcript of
    // banter + human chat + gameplay narration. Never let logging break
    // a broadcast.
    try { logChat({ tableId: this.id, entry, extras }); } catch (_) {}
    if (extras && extras.audioUrl) { try { recordSound('table', extras.audioUrl, text); } catch (_) {} }
    // Build the emitted payload separately from the persisted entry so
    // ephemeral extras (audio, etc.) don't end up in the ring buffer.
    const payload = extras ? { ...entry, ...extras } : entry;
    if (this.io) this.io.to(this.roomName()).emit('table:chat', payload);
    return entry;
  }

  setIo(io) { this.io = io; }
  roomName() { return `table:${this.id}`; }

  /** True iff at least one connected socket in this table's room
   *  has banter-voice enabled (toggle stored on socket.data.voiceOn,
   *  pushed up by the client whenever the audio menu changes).
   *  Used by banter.js to skip 11labs synthesis when nobody at the
   *  table is listening — saves API tokens. Local sound pools (Crisp
   *  chirps, Elfrip burps) ignore this — those are static files and
   *  cost nothing to broadcast. */
  anyVoiceListener() {
    if (!this.io) return false;
    const room = this.io.sockets.adapter.rooms.get(this.roomName());
    if (!room) return false;
    for (const sid of room) {
      const s = this.io.sockets.sockets.get(sid);
      if (s?.data?.voiceOn) return true;
    }
    return false;
  }

  /** True if any human client is LIVE-connected to this table's room —
   *  whether seated-and-watching or just spectating. Bots are driven
   *  server-side and never hold a socket, so any socket in the room is a
   *  human browser actually at the table. Used to send all bots home when
   *  nobody is present, so we don't burn LLM / 11labs / CPU dealing hands
   *  no one will see.
   *
   *  NOTE: we deliberately use LIVE connections, not seat occupancy.
   *  Disconnected humans keep their seat reserved (handleDisconnect's
   *  PERSISTENT SEAT), so a seat-based check would keep bots grinding
   *  forever after someone simply closes their tab — the opposite of the
   *  resource-saving intent. Their reserved seat is preserved regardless;
   *  the bots just leave, and the human re-adds them on reconnect. */
  anyHumanPresent() {
    if (!this.io) return false;
    const room = this.io.sockets.adapter.rooms.get(this.roomName());
    if (!room) return false;
    for (const sid of room) {
      const s = this.io.sockets.sockets.get(sid);
      if (!s?.data?.player?.is_bot) return true; // any non-bot socket = human at the table
    }
    return false;
  }

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
    // Snapshot tablemates BEFORE we sit Vorkstag so his "wear someone's
    // face" pick is from real other seats (not himself). We capture both
    // avatar AND nickname — the avatar drives the visual disguise via
    // Seat.avatarOverride, the nickname drives the 11labs voice swap
    // via Seat.impersonatedNick (see character_voices.voiceFor). If
    // nobody else is here he just shows his true skinless visage.
    const stealableTargets = playerId === 'vorkstag'
      ? this.seats
          .filter(s => !s.isEmpty() && s.player?.avatar_id)
          .map(s => ({ avatar: s.player.avatar_id, nick: s.player.nickname }))
      : null;
    const result = this.sit({ playerId, socketId: null, player, isBot: true });
    if (result.ok && playerId === 'vorkstag' && stealableTargets && stealableTargets.length > 0) {
      const seat = this.seats[result.seatIndex];
      const t = stealableTargets[Math.floor(Math.random() * stealableTargets.length)];
      seat.avatarOverride   = t.avatar;
      seat.impersonatedNick = t.nick;
      this.chat('info', `🎭 Something is wrong with one of the players at the table…`);
    }
    return result;
  }

  stand(playerId) {
    const seat = this.findSeat(playerId);
    if (!seat) return { ok: false, error: 'not seated' };
    // Mid-hand ONLY when the seat is actively dealt in. After hand-complete
    // the hand reference lingers ~2-3s for the showdown pause, but
    // seat.inHand is already cleared in _afterHandComplete. If we don't
    // also gate on seat.inHand here, a kick in that pause window flags
    // the seat for "leave after this hand" — which then never fires when
    // the kicked player was the only AI at the table (no new hand starts,
    // no _afterHandComplete to consume the flag, seat stranded forever).
    if (this.hand && seat.inHand && this._inHandPlayerIds().has(playerId)) {
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
    seat.avatarOverride = null;   // strip any Vorkstag-style disguise
    seat.impersonatedNick = null; // and the matching voice override
    // Reset PER-SEAT flags that would otherwise be inherited by whoever
    // lands here next. Without this, a player who clicked "Sit out" and
    // then left would leave sittingOut=true on the empty seat — and any
    // bot the user added next would silently inherit the sit-out flag
    // and be skipped at deal time ("called in a bot, why is it sitting
    // out?"). Same idea for _standAfterHand.
    seat.sittingOut = false;
    seat.sickenedUntil = null;
    delete seat._standAfterHand;
    // Signal to _scheduleAutoStart that a seat just opened up — the
    // next-hand delay should be extended so a spectator has time to
    // grab it. Also push back an autostart that's already armed but
    // would fire sooner than the grace window allows.
    this._seatVacatedRecently = true;
    if (this._autostartTimer) {
      const desired = Date.now() + HAND_GRACE_DELAY_MS;
      if (!this.nextHandAt || this.nextHandAt < desired) {
        clearTimeout(this._autostartTimer);
        this._autostartTimer = null;
        this.nextHandAt = desired;
        this._autostartTimer = setTimeout(() => {
          this._autostartTimer = null;
          this._maybeStartHand();
        }, HAND_GRACE_DELAY_MS);
      }
    }
  }

  _foldMidHandAndVacate(playerId, seat) {
    // CRITICAL: flag the seat for vacate BEFORE applying the fold. If the
    // fold ends the hand, _afterHandComplete's vacate loop runs in the
    // same call stack and needs to see the flag already set, or the
    // player would still be sitting there after the hand resolves.
    seat._standAfterHand = true;

    if (this.hand && this.hand.getCurrentActor() === playerId) {
      // Their turn: dispatch through Table.applyAction (not Hand directly)
      // so the post-action handling runs — chat line, broadcast, and most
      // importantly _afterHandComplete if the fold ended the hand. Without
      // this, the seat flagged above never gets vacated and the next hand
      // never starts.
      this.applyAction({ playerId, action: 'fold' });
      return;   // applyAction broadcasts at the end
    }

    if (this.hand) {
      const p = this.hand.players.find(pp => pp.playerId === playerId);
      if (p && !p.folded) {
        p.folded = true;
        this.hand.pot.fold(playerId);
        // If only one live player remains, end the hand here. Because we
        // bypassed Table.applyAction, we have to drive the close-out
        // manually so the vacate loop, chat winners, chip sync, and
        // nextHandAt all get set.
        const live = this.hand.players.filter(q => !q.folded);
        if (live.length === 1) {
          this.hand._winByFold(live[0]);
          this._clearHumanActionTimer();
          this._afterHandComplete();
        }
      }
    }
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
    // If a seat just opened up, use the longer GRACE delay so a
    // watching spectator has time to click in before the next hand
    // starts. Consume the flag so the *next* hand cycles at normal
    // cadence.
    const useGrace = this._seatVacatedRecently;
    this._seatVacatedRecently = false;
    const delay = useGrace ? HAND_GRACE_DELAY_MS : HAND_AUTOSTART_DELAY_MS;
    // Surface to clients so the topbar clock can count down to it.
    // Don't clobber a later nextHandAt that's already been set by _afterHandComplete.
    const planned = Date.now() + delay;
    if (!this.nextHandAt || this.nextHandAt < planned) this.nextHandAt = planned;
    this._autostartTimer = setTimeout(() => {
      this._autostartTimer = null;
      this._maybeStartHand();
    }, delay);
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
    // Round-reset also kicks every bot so the human has a clean slate to
    // re-pick whoever they actually want at the table for the next hand.
    // Mirrors resetGame's bot-vacate loop — the round-reset modal advertises
    // this behavior too. Refunds for those bots are already applied above
    // via the per-player refund loop; _vacate then persists their chip
    // total back to the DB before clearing the seat.
    let vacatedBots = 0;
    for (const seat of this.seats) {
      if (seat.isEmpty() || !seat.isBot) continue;
      this._vacate(seat);
      vacatedBots++;
    }
    if (vacatedBots > 0) {
      this.chat('leave', `🃏 Round reset — ${vacatedBots} AI player${vacatedBots===1?'':'s'} cleared from the table.`);
    }
    if (this.io) {
      this.io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
    }
    this._broadcast();
    this._scheduleAutoStart();
  }

  /**
   * Full game reset: cancel hand, refund, then set every seated player's
   * stack to DEFAULT_STACK and bulk-reset every roster player's chip total.
   * Also vacates ALL bot seats so the table is humans-only after a reset
   * — fresh slate, no leftover NPCs filling seats the player wanted clear.
   * Humans can re-seat bots via the + Bot / Pick AI buttons as they wish.
   */
  resetGame() {
    this.cancelHand();
    resetRecords();   // Hall of Records starts fresh — only count hands after this reset
    const DEFAULT = db.DEFAULT_STACK;
    // Reset every seated HUMAN's table stack to default. Bots are
    // about to be vacated, so we skip them here to avoid persisting
    // a default chip count for a bot that's leaving anyway.
    for (const seat of this.seats) {
      if (seat.isEmpty()) continue;
      if (seat.isBot) continue;
      seat.chipsAtTable = DEFAULT;
      db.setChips(seat.playerId, DEFAULT);
    }
    // Vacate every bot seat — humans get a clean room.
    let vacatedBots = 0;
    for (const seat of this.seats) {
      if (seat.isEmpty() || !seat.isBot) continue;
      this._vacate(seat);
      vacatedBots++;
    }
    if (vacatedBots > 0) {
      this.chat('leave', `🃏 Game reset — ${vacatedBots} AI player${vacatedBots===1?'':'s'} cleared from the table.`);
    }
    // Reset EVERY player's bank — humans AND bots — to the default stack,
    // wipe all gear (current `gear` slots + legacy `swords`), clear any
    // rebuy debt, and zero lifetime stats. One bulk query so the
    // leaderboard (which lists humans + bots) truly shows everyone at the
    // default stack with no gear. BUGFIX: this previously reset only
    // listHumans() and never touched gear, so bots kept their accumulated
    // wealth and geared players still showed gear value on the board.
    try {
      db.db.prepare(
        "UPDATE players SET chips = ?, swords = '{}', gear = '{}', rebuy_debt = 0, " +
        "total_won = 0, total_lost = 0, hands_played = 0"
      ).run(DEFAULT);
    } catch (e) { console.error('[resetGame] bulk reset failed', e); }
    // Reset dealer button so next hand starts fresh
    this.dealerButtonSeatIndex = -1;
    // Use listAll() so the leaderboard shows everyone (humans + bots)
    // with their default stacks — fixes a long-standing bug where the
    // reset emit dropped bots from the roster.
    if (this.io) this.io.emit('roster', { players: db.listAll(), defaultStack: DEFAULT });
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

      // ---- Abadar's interest ----
      // Each turn a human takes counts toward Abadar's compound-interest clock;
      // every 10 turns (poker or dungeon) the tab grows. Bots never owe.
      if (!isBot) {
        const intr = db.tickDebtTurn(playerId);
        if (intr) this.chat('debt', `🏛️ Abadar's interest — ${nick}'s tab compounds ${intr.before.toLocaleString()} → ${intr.after.toLocaleString()} gp (+${intr.interest.toLocaleString()}).`);
      }

      // ---- Banter trigger (LLM-driven ambient chat) ----
      // Fire-and-forget; banter.maybeSpeak no-ops if LLM is disabled.
      // Triggered on the more noteworthy actions: raises, all-ins, and
      // any committed chips > big blind. The acting player is excluded
      // from the speaker pool (no commenting on themselves).
      try {
        if (action === 'allin' || action === 'raise' || (action === 'call' && committed > this.bigBlind * 3)) {
          // Amounts spelled out as words for the LLM (numwords.gold) so the
          // small model can't misread digit strings ("152" → "fifteen two").
          // The exact value also rides along in `amounts` so a {amount}
          // token in the model's line gets the precise figure substituted in.
          const amtVal = action === 'raise' ? (actorAfter?.invested ?? amount) : committed;
          const desc = action === 'allin'
            ? `${nick} just shoved all-in (${gold(committed)}).`
            : action === 'raise'
              ? `${nick} raised to ${gold(actorAfter?.invested ?? amount)}.`
              : `${nick} called a big ${gold(committed)} bet.`;
          banter.maybeSpeak(this, { kind: action, description: desc, actorIds: [playerId], amounts: { amount: amtVal } });
        } else if (action === 'check' && this.findSeat(playerId)?.isBot) {
          // The actual checker (a bot) may announce their OWN check — never a
          // bystander, and folded players never reach this action branch. The
          // per-table banter cooldown keeps it occasional, not every check.
          banter.maybeSpeak(this, {
            kind: 'check',
            description: `You (${nick}) just CHECKED — tapped the table, no bet, staying in the hand for free. You may simply say "check", or a brief in-character line as you do it. One short line.`,
            speakerHint: playerId,
            actorIds: [],
            prob: 0.25,
          });
        }
      } catch (_) { /* never let banter break a hand */ }
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

    // ---- Banter: spectator advice for the new actor ----
    // Folded / waiting bots can chime in for the player now on the
    // clock — "your move", "fold it", "smell a bluff", etc. Excludes
    // the new actor (no commenting on themselves) AND the player who
    // just acted (they likely already got a reaction line above).
    // Fires at 8% per turn so it's flavor-only, not constant chatter.
    try {
      const newActor = this.hand?.getCurrentActor?.();
      if (newActor && newActor !== playerId && this.hand?.state !== STATES.COMPLETE) {
        const newActorP = this.hand.players.find(p => p.playerId === newActor);
        const newActorNick = newActorP?.nickname || newActor;
        const toCall = Math.max(0, this.hand.currentBet - (newActorP?.invested || 0));
        const potSize = this.hand.pot.totalSize();
        const desc = toCall > 0
          ? `${newActorNick} is on the clock, facing a call of ${gold(toCall)} into a ${gold(potSize)} pot. You are a SPECTATOR watching THEM decide — heckle, predict, or needle them; do NOT announce an action yourself.`
          : `${newActorNick} is on the clock and can check or open. You are a SPECTATOR watching THEM decide — heckle, predict, or needle them; do NOT say "check"/"call" yourself.`;
        banter.maybeSpeak(this, {
          kind: 'advice',
          description: desc,
          actorIds: [newActor, playerId],
          prob: 0.08,
          amounts: toCall > 0 ? { call: toCall, pot: potSize } : null,
        });
      }
    } catch (_) { /* never let banter break a hand */ }
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
    // ROOT-CAUSE FIX: cancel any prior human auto-fold timer FIRST — even when
    // the new actor is a bot or there's no actor. The old code returned early
    // (below) before clearing, so a human's auto-fold timer could outlive its
    // turn: e.g. human acts → next actor is a bot → this returned without
    // clearing, leaving the human's 120s timer scheduled. When that stale
    // timer later fired, its callback ran `this.actionDeadline = null`,
    // wiping out whatever actor was on the clock by then, and bailed at the
    // guard with no re-broadcast — the table sat with a dead clock. We clear
    // only the TIMER here, NOT actionDeadline: when the next actor is a bot,
    // _maybeDriveBot (called just before us) already set the bot's deadline.
    if (this._humanActionTimer) {
      clearTimeout(this._humanActionTimer);
      this._humanActionTimer = null;
    }
    const actor = this.hand.getCurrentActor();
    // Bot's turn / no actor — _maybeDriveBot owns actionDeadline + the
    // thinking-delay setTimeout. Leave the deadline it set intact.
    if (!actor || this.bots.has(actor)) return;
    this.actionDeadline = Date.now() + ACTION_TIMEOUT_MS;
    this._humanActionTimer = setTimeout(() => {
      this._humanActionTimer = null;
      this.actionDeadline = null;
      const cur = this.hand && this.hand.getCurrentActor();
      if (!this.hand || cur !== actor) {
        // Defensive: the actor moved on without this timer being cleared.
        // With the early-clear above this should no longer happen; log it
        // if it ever does so the real path is visible (no silent stall).
        if (this.hand) console.warn('[poker] auto-fold skipped — actor changed', { armedFor: actor, current: cur });
        return;
      }
      console.log('[poker] action timeout — auto-folding', actor);
      const r = this.applyAction({ playerId: actor, action: 'fold' });
      if (!r || !r.ok) console.error('[poker] auto-fold rejected', actor, r && r.error);
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

    // The clock shows every bot the SAME fixed allotment — the MAX time they're
    // given — regardless of how long they'll actually take, so the countdown can't
    // telegraph a snap-decision vs a long brood.
    const AI_TURN_MS = 15000;
    // Hidden, mode-flavored think time (risky ~1-4s, standard ~1-10s, cautious
    // longer) — when the bot ACTUALLY acts. Capped just inside the allotment so it
    // never acts after the displayed timer would hit zero.
    const delay = Math.min(rollBotDelayMs(bot.mode), AI_TURN_MS - 300);
    // Surface the FULL allotment (not `delay`) so the topbar clock ticks down the
    // fixed 15s max for everyone — not the bot's real think time. Callers broadcast
    // after timer setup, so we never emit a half-updated state here.
    this.actionDeadline = Date.now() + AI_TURN_MS;
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
      // Defensive: bot.decide() must never throw (would silently strand the
      // actor — the setTimeout already nulled itself, no new timer would be
      // scheduled, the table sits forever showing "thinking" past the
      // displayed countdown). If a decision is rejected by validate (e.g.
      // 'check' when toCall>0) the same dead-end occurs because the bot
      // driver previously ignored applyAction's return value.
      // Wrap both calls and force-fold on any anomaly so the hand keeps
      // moving and the bug surfaces in logs instead of hanging silently.
      let decision = null;
      try {
        decision = bot.decide(decideCtx);
      } catch (e) {
        console.error(`[bot] ${actor} (${bot.mode}) decide() threw — force-folding: ${e?.message || e}`);
        decision = { action: 'fold', reason: 'decide-threw->force-fold' };
      }
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
      const applyResult = this.applyAction({ playerId: actor, action: decision.action, amount: decision.amount });
      if (!applyResult?.ok) {
        // Rejected by validator — the bot picked an action illegal in the
        // current state. Log the details so we can fix the decision logic
        // and force-fold the actor so the hand isn't stranded.
        console.error(
          `[bot] ${actor} (${bot.mode}) action ${decision.action} ${decision.amount ?? ''} REJECTED: ${applyResult?.error || 'unknown'} — ` +
          `state={toCall:${decideCtx.toCall}, currentBet:${decideCtx.currentBet}, invested:${decideCtx.invested}, ` +
          `minRaise:${decideCtx.minRaise}, stack:${decideCtx.stack}}`
        );
        const recovery = this.applyAction({ playerId: actor, action: 'fold' });
        if (!recovery?.ok) {
          console.error(`[bot] ${actor} recovery fold also failed: ${recovery?.error || 'unknown'} — table may be stuck`);
        }
      }
    }, delay);
  }

  _afterHandComplete() {
    // Distinctive marker for log-tail watchers (e.g. the deploy script
    // that waits for a between-hand window before recreating the
    // container). A long quiet gap could just be a cautious bot
    // brooding — this is the unambiguous "round just ended" signal.
    console.log(`[poker] hand-complete table=${this.id} #${this.handCount}`);
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
      // Banter trigger on the win. If the WINNER is a bot, THEY gloat —
      // a smug, self-aggrandizing victory lap about their own win (not a
      // line that reads as chiding someone else). If a human won, fall
      // back to an opponent bot reacting to it.
      if (ws.length > 0) {
        const top = ws[0];
        const nick = nickById.get(top.playerId) || top.playerId;
        const isBluff = (top.handDesc || '').includes('bluff');
        const amt = gold(top.amount);
        const handTail = top.handDesc ? ` with ${top.handDesc}` : '';
        const winnerIsBot = this.seats.some(s => !s.isEmpty() && s.isBot && s.playerId === top.playerId);
        if (winnerIsBot) {
          const desc = isBluff
            ? `You (${nick}) JUST WON ${amt} on a BLUFF (${top.handDesc})! This is YOUR victory — GLOAT: be smug and self-aggrandizing about your OWN win, in character (you may relish that it was a bluff). Brag about yourself; do NOT chide or scold someone else.`
            : `You (${nick}) JUST WON ${amt}${handTail}! This is YOUR victory — GLOAT: be smug and self-aggrandizing about your OWN win, in character. Brag about yourself; do NOT chide or scold someone else.`;
          banter.maybeSpeak(this, { kind: isBluff ? 'bluff-win' : 'win', description: desc, speakerHint: top.playerId, actorIds: [], amounts: { amount: top.amount, pot: top.amount } });
        } else {
          const desc = isBluff
            ? `${nick} just won ${amt} on a bluff (${top.handDesc}). React as an opponent who just lost the pot to them.`
            : `${nick} just won ${amt}${handTail}. React as an opponent who just lost the pot to them.`;
          banter.maybeSpeak(this, { kind: isBluff ? 'bluff-win' : 'win', description: desc, actorIds: [top.playerId], amounts: { amount: top.amount, pot: top.amount } });
        }
      }
      // Loser-reaction trigger — pick one random bot who DIDN'T win
      // and let them react to losing the hand. The system prompt
      // explicitly permits character-flavored cursing; pirates curse
      // like sailors, dwarves invoke Torag, Farrah swears for shock
      // value. Per-table cooldown gates this against the win banter
      // so we get at most one chat line per hand-complete pause.
      const winnerIds = new Set(ws.map(w => w.playerId));
      const loserBots = this.hand.players.filter(p => {
        if (winnerIds.has(p.playerId)) return false;
        const seat = this.seats[p.seatIndex];
        return seat && !seat.isEmpty() && seat.isBot && seat.playerId === p.playerId;
      });
      if (loserBots.length > 0) {
        const lp = loserBots[Math.floor(Math.random() * loserBots.length)];
        const lnick = nickById.get(lp.playerId) || lp.playerId;
        const winnerNick = ws.length > 0 ? (nickById.get(ws[0].playerId) || ws[0].playerId) : 'someone';
        const desc = `You (${lnick}) JUST LOST this hand to ${winnerNick}. React with frustration — cursing in character is encouraged.`;
        banter.maybeSpeak(this, {
          kind: 'lose',
          description: desc,
          speakerHint: lp.playerId,
          prob: 0.22,
        });
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

      // ---- Cosmetic bot revenge (pure flavor; see fightDirector.js) ----
      // A seated bot MAY take a petty swing at someone who beat them this
      // hand, bluffed them (took a pot with weak cards), or is a lore enemy
      // (random revenge). Heavily gated — rare, human-present-only. Never
      // touches chips/pots/seating.
      const _winnerIds = new Set((this.hand.winners || []).map(w => w.playerId));
      const _bluffers = new Set();
      for (const w of (this.hand.winners || [])) {
        if ((w.handDesc || '').includes('bluff')) _bluffers.add(w.playerId);
      }
      for (const r of revealedThisHand) {
        if (r.isBluff && _winnerIds.has(r.playerId)) _bluffers.add(r.playerId);
      }
      require('./fightDirector').maybeBotRevenge(this, { winnerIds: _winnerIds, bluffers: _bluffers });
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
      const nick = seat.displayNickname();
      const itemName = db.GEAR_BY_KEY[slot].label;
      const verb = prev > 0 ? `upgraded to +${target}` : `picked up a +${target}`;
      this.chat('rebuy', `🛒 ${nick} ${verb} ${itemName} for ${cost.toLocaleString()} gp.`);
    }

    // ---- Cash cap (20,000 gp) ----
    // No player can hoard more than CASH_CAP in unspent chips at
    // hand-end. The winnings still pay out fully, but any excess
    // above the cap gets burned with a chat callout. Players are
    // expected to bank their wins into gear via the Loot Bank — the
    // cap is the pressure that nudges them toward the LOOT LORD
    // win condition instead of just stockpiling cash to bully with.
    // (Bots get itchy to buy gear as they approach 15k via the auto-invest
    // loop above, so they rarely climb anywhere near this cap.)
    // Cap = the most expensive single item (+5 Longsword, 50,315 gp) so a
    // player can always save up for the priciest piece of gear. Computed
    // from the price table so it tracks any future price changes.
    const CASH_CAP = Math.max(...Object.keys(db.GEAR_BY_KEY).map(k => db.gearPrice(k, 5)));
    for (const seat of this.seats) {
      if (seat.isEmpty()) continue;
      if (seat.chipsAtTable > CASH_CAP) {
        const overflow = seat.chipsAtTable - CASH_CAP;
        seat.chipsAtTable = CASH_CAP;
        db.setChips(seat.playerId, CASH_CAP);
        const nick = seat.displayNickname();
        this.chat('debt', `💸 ${nick} hit the ${CASH_CAP.toLocaleString()} gp cash cap — ${overflow.toLocaleString()} gp lost (buy magic items to keep your winnings!).`);
      }
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
    // "next hand in N" mode while everyone catches their breath. If a
    // seat just vacated (kick / auto-yield / bust), use the longer
    // grace delay so the displayed countdown is honest from the start
    // — otherwise the topbar would jump from 1.5s → 5s when the
    // autostart timer actually fires. The flag is still consumed by
    // _scheduleAutoStart later; we only read it here.
    const postPauseDelay = this._seatVacatedRecently ? HAND_GRACE_DELAY_MS : HAND_AUTOSTART_DELAY_MS;
    this.nextHandAt = Date.now() + HAND_RESULT_PAUSE_MS + postPauseDelay;
    // No broadcast here — applyAction broadcasts AFTER calling us so
    // the client gets one consistent snapshot with nextHandAt set,
    // actionDeadline cleared, and chips synced.
    if (this._completeTimer) clearTimeout(this._completeTimer);
    this._completeTimer = setTimeout(() => {
      this._completeTimer = null;
      // Clear hand only after pause so clients can render showdown via the COMPLETE snapshot.
      if (this.hand === finishedHand) this.hand = null;

      // Resource saver: if nobody is seated or watching, send every bot
      // home instead of auto-rebuying them. With no humans and no bots,
      // nothing schedules a hand and the table simply idles until someone
      // shows up — no LLM banter, no 11labs synthesis, no bot-only hands
      // dealt to an empty room.
      if (!this.anyHumanPresent()) {
        let sentHome = 0;
        for (const seat of this.seats) {
          if (seat.isEmpty() || !seat.isBot) continue;
          this._vacate(seat);
          sentHome++;
        }
        if (sentHome > 0) {
          console.log(`[poker] table=${this.id} idle — sent ${sentHome} bot(s) home (no humans present)`);
          if (this.io) this.io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
        }
        this.nextHandAt = null;
        this._broadcast();
        return; // no autostart — nothing to play for
      }

      // Handle broke seats. Humans vacate; bots auto-rebuy back to the
      // default stack and stay seated (we want a persistent house roster
      // of NPCs, not seats that drain to zero and disappear).
      let vacated = 0, rebought = 0;
      for (const seat of this.seats) {
        if (seat.isEmpty() || seat.chipsAtTable > 0) continue;
        if (seat.isBot) {
          const nick = seat.displayNickname();
          const fresh = db.getPlayer(seat.playerId) || {};
          const debt = Number(fresh.rebuy_debt || 0);
          const gear = db.getGear(seat.playerId) || {};
          const owned = Object.entries(gear).filter(([, t]) => Number(t) > 0).sort((a, b) => Number(a[1]) - Number(b[1]));
          // AI would rather BORROW from Abadar than sell their magic items — but
          // once they're drowning in debt, they pawn their cheapest item to
          // stay in the game (do what they must).
          if (owned.length > 0 && debt >= BOT_DEBT_CEILING) {
            const [slot, tier] = owned[0];
            const proceeds = db.gearHockValue(slot, Number(tier));
            gear[slot] = 0;
            db.setGear(seat.playerId, gear);
            const stack = Math.max(db.DEFAULT_STACK, proceeds);
            db.setChips(seat.playerId, stack);
            seat.chipsAtTable = stack;
            const label = (db.GEAR_BY_KEY[slot] && db.GEAR_BY_KEY[slot].label) || slot;
            this.chat('rebuy', botHockMessage(nick, `+${tier} ${label}`, proceeds));
          } else {
            // Borrow from the First Bank of Abadar — a loan; keeps their gear.
            db.setChips(seat.playerId, db.DEFAULT_STACK);
            db.addRebuyDebt(seat.playerId, db.DEFAULT_STACK);
            seat.chipsAtTable = db.DEFAULT_STACK;
            this.chat('rebuy', botBorrowMessage(nick, db.DEFAULT_STACK));
          }
          rebought++;
        } else {
          const nick = seat.displayNickname();
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
      // Push a fresh roster whenever a seat changed (vacate OR rebuy) so
      // the right-side leaderboard reflects new chip totals. Without
      // including the rebuy case here, a bot that busted and was auto-
      // rebought to DEFAULT_STACK still showed 0 gp on the leaderboard
      // until the next vacate or external roster event.
      if ((vacated > 0 || rebought > 0) && this.io) {
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
    const RESERVE = db.DEFAULT_STACK;     // 5,000 — hard floor (solvency + bottom of the comfort band)
    const COMFORT_CEIL = 15000;           // bots are comfy holding 5k-15k; the itch to buy grows toward 15k
    const available = seat.chipsAtTable - RESERVE;
    if (available <= 0) return null;

    // Buy-eagerness rises CONVEXLY with the stack: ~0 in the low-mid band, near
    // certain at 15k, and pinned at 1 above it (spend the excess down). So bots
    // sit comfortably on 5k-15k and only think hard about gear as they approach /
    // exceed 15k, instead of draining straight to the reserve every hand.
    const eagerness = Math.min(1, (available / (COMFORT_CEIL - RESERVE)) ** 2);
    if (Math.random() > eagerness) return null;

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
    resetRecords();   // new game after a Loot Lord win — Hall of Records starts fresh
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
        // displayNickname() returns the impersonated name when
        // Vorkstag is wearing it, real nickname otherwise. Pairs
        // with effectiveAvatar() so the whole identity (face + name)
        // is disguised in the broadcast. Cash, gear, debt stay
        // accurate — the Church of Abadar can't be fooled.
        nickname: s.displayNickname(),
        avatarId: s.effectiveAvatar(),
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
        // Cosmetic "sickened" status from a failed Stinking Cloud save —
        // wall-clock ms until it wears off. Pure flavor, no poker effect.
        sickenedUntil: (!s.isEmpty() && s.sickenedUntil && s.sickenedUntil > Date.now()) ? s.sickenedUntil : null,
      })),
      spectatorCount: this.spectators.size,
      // Concise list of spectators (connected clients NOT seated). One
      // entry per playerId — the Map is already keyed by playerId so a
      // single user with multiple tabs counts once. Used by the topbar
      // chip; the count above is kept for the stage banner.
      spectators: Array.from(this.spectators.entries()).map(([playerId, entry]) => ({
        playerId,
        nickname: entry.player?.nickname || playerId,
        avatarId: entry.player?.avatar_id ?? null,
      })),
      hand,
      // Wall-clock ms when the current human actor will be auto-folded.
      // Null when no human is on the clock (waiting, bot turn, between hands).
      actionDeadline: this.actionDeadline,
      // Wall-clock ms when the next hand is scheduled to start (only set
      // between hands or while autostart is pending; null during a live hand).
      nextHandAt: this.nextHandAt,
      // All-time biggest single-hand win / loss for the sidebar "Hall of
      // Records". { biggestWin, biggestLoss } each { nick, amount, ts } | null.
      records: getRecords(),
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
