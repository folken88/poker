/**
 * Table socket handlers (v0.2 — identity comes from socket.data.player,
 * which lobby:choosePlayer sets).
 *
 *   table:join     -> { ok, state }
 *   table:sit      -> { ok, seatIndex }
 *   table:stand    -> { ok }
 *   table:action   -> { ok }  (placeholder until Hand logic lands)
 */

const db = require('../persistence/db');

function meOf(socket) { return socket.data.player; }

function registerTableHandlers(io, socket, { tables }) {

  socket.on('table:join', ({ tableId } = {}, ack) => {
    const me = meOf(socket);
    if (!me) return ack?.({ ok: false, error: 'choose a player first' });
    const table = tables.get(tableId || 'main');
    if (!table) return ack?.({ ok: false, error: 'no such table' });

    socket.join(table.roomName());
    socket.data.tableId = table.id;

    // CRITICAL: if this player is already seated (returning from disconnect /
    // refresh / second tab as same player), re-attach the new socket.id to
    // their existing seat. Otherwise hand events (incl. private hole cards)
    // would still be addressed to the dead socket and never reach them.
    //
    // If the player_record is a bot AND they're currently seated as a bot,
    // the human is SUPERSEDING the AI — flip the seat to human-controlled
    // by clearing the bot driver. The next time it's the seat's turn the
    // human's action panel will be enabled instead of the bot deciding.
    const existingSeat = table.findSeat(me.player_id);
    if (existingSeat) {
      existingSeat.socketId = socket.id;
      if (existingSeat.isBot && me.is_bot) {
        existingSeat.isBot = false;
        table.bots.delete(me.player_id);
        table.chat('info', `🎮 ${me.nickname} has taken control from the AI.`);
      }
    } else {
      table.addSpectator({ playerId: me.player_id, socketId: socket.id, player: me });

      // ---- Yield-a-seat for a newly-arrived human ----
      // If a human joins and every seat is full but at least one is an
      // AI, pick a random bot to leave at the end of the current hand
      // so the human can sit next deal. Skip if someone's already
      // pending-leave (kick or queued auto-yield) — those will free a
      // seat soon enough.
      const humanArriving = !me.is_bot;
      const tableFull = !table.firstOpenSeat();
      const yieldPending = table.seats.some(s => s._standAfterHand);
      if (humanArriving && tableFull && !yieldPending) {
        const botSeats = table.seats.filter(s => !s.isEmpty() && s.isBot);
        if (botSeats.length > 0) {
          const victim = botSeats[Math.floor(Math.random() * botSeats.length)];
          const victimNick = victim.player?.nickname || victim.playerId;
          if (table.hand) {
            // Mid-hand: queue the yield. _afterHandComplete's vacate
            // loop will free the seat when the hand resolves.
            victim._standAfterHand = true;
            table.chat('info', `🪑 ${me.nickname} just arrived — ${victimNick} (AI) will yield their seat after this hand.`);
          } else {
            // Between hands: free the seat immediately so the human can
            // sit on the next deal without waiting.
            table._vacate(victim);
            table.chat('info', `🪑 ${me.nickname} just arrived — ${victimNick} (AI) yielded their seat.`);
            io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
          }
        }
      }
    }

    // Replay private hole cards if we're seated in the active hand.
    if (table.hand) {
      const p = table.hand.players.find(pp => pp.playerId === me.player_id);
      if (p) socket.emit('table:hole', { playerId: me.player_id, hole: p.hole });
    }

    ack?.({ ok: true, state: table.publicState() });
    io.to(table.roomName()).emit('table:state', table.publicState());
  });

  socket.on('table:sit', ({ seatIndex } = {}, ack) => {
    const me = meOf(socket);
    if (!me) return ack?.({ ok: false, error: 'choose a player first' });
    const table = tables.get(socket.data.tableId);
    if (!table) return ack?.({ ok: false, error: 'not at a table' });

    const fresh = db.getPlayer(me.player_id);
    socket.data.player = fresh;
    const result = table.sit({ playerId: fresh.player_id, socketId: socket.id, player: fresh, seatIndex });
    if (!result.ok) return ack?.(result);
    io.to(table.roomName()).emit('table:state', table.publicState());
    ack?.({ ok: true, seatIndex: result.seatIndex });
  });

  // Manual force-start (rarely needed — table autostarts when ≥2 seated).
  socket.on('table:startHand', (_p, ack) => {
    const table = tables.get(socket.data.tableId);
    if (!table) return ack?.({ ok: false, error: 'not at a table' });
    table._maybeStartHand();
    ack?.({ ok: true });
  });

  socket.on('table:addBot', (payload, ack) => {
    const table = tables.get(socket.data.tableId);
    if (!table) return ack?.({ ok: false, error: 'not at a table' });
    let botId = (payload && typeof payload === 'object') ? payload.playerId : null;
    if (!botId) {
      // Auto-pick: first bot not already seated at this table, with chips.
      // listBots() already filters to is_bot=1, so reserved humans (Tobis,
      // Fred, etc.) can never appear in this list. The extra guard below
      // belts-and-suspenders the same invariant.
      const seatedIds = new Set(table.seats.filter(s => s.playerId).map(s => s.playerId));
      const candidates = db.listBots()
        .filter(b => b.is_bot === 1 && !seatedIds.has(b.player_id) && b.chips > 0);
      if (candidates.length === 0) return ack?.({ ok: false, error: 'no available bots' });
      botId = candidates[Math.floor(Math.random() * candidates.length)].player_id;
    }
    // Even if someone POSTs a specific playerId, refuse to seat a reserved
    // human as a bot. Real humans control their own destiny here.
    const candidate = db.getPlayer(botId);
    if (!candidate) return ack?.({ ok: false, error: 'unknown player' });
    if (candidate.is_bot !== 1) {
      return ack?.({ ok: false, error: `${candidate.nickname} is a reserved human; AI cannot play them` });
    }
    const result = table.seatBot(botId);
    if (!result.ok) return ack?.(result);
    io.to(table.roomName()).emit('table:state', table.publicState());
    io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, seatIndex: result.seatIndex, playerId: botId });
  });

  /**
   * Kick a player (human or bot) from the table. Effect is deferred to
   * end of current hand — same mechanism as table.stand(self). Requires
   * the caller is seated (only players at the table can kick others)
   * and can't be used to kick yourself (use table:stand for that).
   * Posts a chat line naming who kicked whom for transparency.
   */
  socket.on('table:kickPlayer', (payload, ack) => {
    const me = meOf(socket);
    if (!me) return ack?.({ ok: false, error: 'choose a player first' });
    const table = tables.get(socket.data.tableId);
    if (!table) return ack?.({ ok: false, error: 'not at a table' });
    const callerSeat = table.findSeat(me.player_id);
    if (!callerSeat) return ack?.({ ok: false, error: 'must be seated to kick' });
    const playerId = (payload && typeof payload === 'object') ? payload.playerId : null;
    if (!playerId) return ack?.({ ok: false, error: 'missing playerId' });
    if (playerId === me.player_id) return ack?.({ ok: false, error: 'cannot kick yourself — use Leave' });
    const targetSeat = table.findSeat(playerId);
    if (!targetSeat) return ack?.({ ok: false, error: 'target not seated' });
    if (targetSeat.pendingStand) return ack?.({ ok: false, error: 'already leaving after this hand' });

    const callerNick = me.nickname || me.player_id;
    const targetNick = targetSeat.player?.nickname || playerId;
    const verb = targetSeat.isBot ? 'kicked the bot' : 'kicked';
    table.chat('leave', `🚪 ${callerNick} ${verb} ${targetNick} — leaves after this hand.`);
    table.stand(playerId);
    io.to(table.roomName()).emit('table:state', table.publicState());
    ack?.({ ok: true });
  });

  /**
   * Human trash talk. Validates length, escapes nothing here (the
   * client escapes on render — see KIND_CLASS handling), and posts
   * via table.chat('human', ...). Per-socket cooldown prevents spam.
   * Fires a banter trigger so bots can react.
   */
  socket.on('table:say', ({ text } = {}, ack) => {
    const me = meOf(socket);
    if (!me) return ack?.({ ok: false, error: 'choose a character first' });
    const table = tables.get(socket.data.tableId);
    if (!table) return ack?.({ ok: false, error: 'not at a table' });
    if (typeof text !== 'string') return ack?.({ ok: false, error: 'bad text' });
    const trimmed = text.trim().slice(0, 240);
    if (!trimmed) return ack?.({ ok: false, error: 'empty message' });
    // Cooldown: 1.5s per socket. socket.data.lastChatAt is the floor.
    const now = Date.now();
    const last = socket.data.lastChatAt || 0;
    if (now - last < 1500) return ack?.({ ok: false, error: 'slow down…' });
    socket.data.lastChatAt = now;

    const nick = me.nickname || me.player_id;
    table.chat('human', `💬 ${nick}: ${trimmed}`);

    // Let a bot react in voice (if banter is enabled). 5% reply rate
    // for chat messages — much lower than the 30% default banter prob
    // so a chatty player doesn't trigger constant chatter back. The
    // per-table cooldown still applies on top.
    try {
      const banter = require('../bot/banter');
      banter.maybeSpeak(table, {
        kind: 'human-chat',
        description: `${nick} just said in the chat: "${trimmed}"`,
        actorIds: [me.player_id],
        prob: 0.05,
      });
    } catch (_) { /* banter optional */ }

    ack?.({ ok: true });
  });

  // Legacy alias for old client tabs that haven't refreshed yet.
  // Routes to the same handler logic without the caller/self checks
  // (the old UI only allowed × on bots, not on humans).
  socket.on('table:removeBot', (payload, ack) => {
    const table = tables.get(socket.data.tableId);
    if (!table) return ack?.({ ok: false, error: 'not at a table' });
    let playerId = (payload && typeof payload === 'object') ? payload.playerId : null;
    if (!playerId) {
      const botSeat = table.seats.find(s => s.isBot);
      if (!botSeat) return ack?.({ ok: false, error: 'no bots seated' });
      playerId = botSeat.playerId;
    }
    const me = meOf(socket);
    const callerNick = me?.nickname || 'A player';
    const target = table.findSeat(playerId);
    const targetNick = target?.player?.nickname || playerId;
    table.chat('leave', `🚪 ${callerNick} kicked ${targetNick} — leaves after this hand.`);
    table.stand(playerId);
    io.to(table.roomName()).emit('table:state', table.publicState());
    ack?.({ ok: true });
  });

  socket.on('table:stand', (_p, ack) => {
    const me = meOf(socket);
    if (!me) return ack?.({ ok: false, error: 'choose a player first' });
    const table = tables.get(socket.data.tableId);
    if (!table) return ack?.({ ok: false, error: 'not at a table' });
    table.stand(me.player_id);
    io.to(table.roomName()).emit('table:state', table.publicState());
    ack?.({ ok: true });
  });

  // Player keeps their seat but isn't dealt in upcoming hands.
  // Doesn't affect a hand already in progress — bets stand and the
  // current hand plays out. Toggles via table:rejoin.
  socket.on('table:sitOut', (_p, ack) => {
    const me = meOf(socket);
    if (!me) return ack?.({ ok: false, error: 'choose a player first' });
    const table = tables.get(socket.data.tableId);
    if (!table) return ack?.({ ok: false, error: 'not at a table' });
    const seat = table.findSeat(me.player_id);
    if (!seat) return ack?.({ ok: false, error: 'not seated' });
    if (seat.sittingOut) return ack?.({ ok: true, alreadySittingOut: true });
    seat.sittingOut = true;
    table.chat('info', `🪑 ${me.nickname} sat out — they'll skip the next deal.`);
    table._broadcast();
    ack?.({ ok: true });
  });
  socket.on('table:rejoin', (_p, ack) => {
    const me = meOf(socket);
    if (!me) return ack?.({ ok: false, error: 'choose a player first' });
    const table = tables.get(socket.data.tableId);
    if (!table) return ack?.({ ok: false, error: 'not at a table' });
    const seat = table.findSeat(me.player_id);
    if (!seat) return ack?.({ ok: false, error: 'not seated' });
    if (!seat.sittingOut) return ack?.({ ok: true, alreadyIn: true });
    seat.sittingOut = false;
    table.chat('info', `🎲 ${me.nickname} rejoined the next deal.`);
    table._broadcast();
    table._scheduleAutoStart();
    ack?.({ ok: true });
  });

  // Client can ask "give me my hole cards" any time. Used as a recovery
  // path when the deal-time emit might have missed an in-flight reconnect.
  socket.on('table:requestHole', (_p, ack) => {
    const me = meOf(socket);
    if (!me) return ack?.({ ok: false, error: 'choose a player first' });
    const table = tables.get(socket.data.tableId || 'main');
    if (!table?.hand) return ack?.({ ok: true, hole: null });
    const p = table.hand.players.find(pp => pp.playerId === me.player_id);
    if (!p) return ack?.({ ok: true, hole: null });
    // Refresh seat's socketId in case it's stale from a reconnect.
    const seat = table.findSeat(me.player_id);
    if (seat) seat.socketId = socket.id;
    socket.emit('table:hole', { playerId: me.player_id, hole: p.hole });
    ack?.({ ok: true, hole: p.hole });
  });

  socket.on('table:action', ({ action, amount } = {}, ack) => {
    const me = meOf(socket);
    if (!me) return ack?.({ ok: false, error: 'choose a player first' });
    const table = tables.get(socket.data.tableId);
    if (!table) return ack?.({ ok: false, error: 'not at a table' });
    const result = table.applyAction({ playerId: me.player_id, action, amount });
    if (!result.ok) return ack?.(result);
    io.to(table.roomName()).emit('table:state', table.publicState());
    ack?.({ ok: true });
  });
}

module.exports = { registerTableHandlers };
