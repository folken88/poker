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
    io.emit('roster', { players: db.listHumans(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, seatIndex: result.seatIndex, playerId: botId });
  });

  socket.on('table:removeBot', (payload, ack) => {
    const table = tables.get(socket.data.tableId);
    if (!table) return ack?.({ ok: false, error: 'not at a table' });
    let playerId = (payload && typeof payload === 'object') ? payload.playerId : null;
    if (!playerId) {
      const botSeat = table.seats.find(s => s.isBot);
      if (!botSeat) return ack?.({ ok: false, error: 'no bots seated' });
      playerId = botSeat.playerId;
    }
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
