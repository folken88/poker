/**
 * Lobby socket handlers (v0.2).
 *
 *   lobby:roster        -> { ok, players, defaultStack }     -- list everyone
 *   lobby:choosePlayer  -> { ok, player }                    -- pick one as 'me' for this socket
 *   lobby:resetStack    -> { ok, chips }                     -- re-buy for current player
 *   lobby:listTables    -> { ok, tables }
 */

const db = require('../persistence/db');
const { humanRebuyMessage } = require('../util/flavor');

function tableFor(socket, tables) {
  return tables.get(socket.data.tableId || 'main') || null;
}

function registerLobbyHandlers(io, socket, { tables }) {

  // Send the roster snapshot as soon as the socket connects.
  socket.emit('roster', { players: db.listHumans(), defaultStack: db.DEFAULT_STACK });

  socket.on('lobby:roster', (_p, ack) => {
    ack?.({ ok: true, players: db.listHumans(), defaultStack: db.DEFAULT_STACK });
  });

  socket.on('lobby:choosePlayer', ({ playerId } = {}, ack) => {
    if (typeof playerId !== 'string') return ack?.({ ok: false, error: 'playerId required' });
    const player = db.getPlayer(playerId.toLowerCase());
    if (!player) return ack?.({ ok: false, error: 'unknown player' });
    if (player.is_bot) return ack?.({ ok: false, error: 'cannot play as a bot' });

    socket.data.player = player;
    db.touchPlayer(player.player_id);
    ack?.({ ok: true, player });
  });

  socket.on('lobby:listBots', (_p, ack) => {
    ack?.({ ok: true, bots: db.listBots() });
  });

  socket.on('lobby:setAvatar', ({ avatarId } = {}, ack) => {
    const player = socket.data.player;
    if (!player) return ack?.({ ok: false, error: 'choose a player first' });
    const ALLOWED = new Set(['fox','owl','raccoon','knight','wizard','robot','cat','bear','frog','lion','wolf','dragon']);
    if (!ALLOWED.has(avatarId)) return ack?.({ ok: false, error: 'unknown avatar' });
    db.db.prepare('UPDATE players SET avatar_id = ?, last_seen_at = ? WHERE player_id = ?').run(avatarId, Date.now(), player.player_id);
    const refreshed = db.getPlayer(player.player_id);
    socket.data.player = refreshed;
    io.emit('roster', { players: db.listHumans(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, player: refreshed });
  });

  socket.on('lobby:resetStack', (_p, ack) => {
    const player = socket.data.player;
    if (!player) return ack?.({ ok: false, error: 'choose a player first' });
    // Re-buy is a LOAN. Set chips back to default and add DEFAULT_STACK
    // to the player's long-term debt. They can pay it down later via
    // lobby:payDebt from accumulated winnings.
    db.setChips(player.player_id, db.DEFAULT_STACK);
    db.addRebuyDebt(player.player_id, db.DEFAULT_STACK);
    const refreshed = db.getPlayer(player.player_id);
    socket.data.player = refreshed;
    // Update seat chips at the table too, if they're seated.
    const table = tableFor(socket, tables);
    if (table) {
      const seat = table.findSeat(player.player_id);
      if (seat) seat.chipsAtTable = refreshed.chips;
      table.chat('rebuy', humanRebuyMessage(refreshed.nickname, db.DEFAULT_STACK));
      table._broadcast?.();
    }
    io.emit('roster', { players: db.listHumans(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, chips: refreshed.chips, rebuyDebt: refreshed.rebuy_debt });
  });

  /** Pay down some of your rebuy debt from your current chip stack.
   *  Validates that you have enough chips AND that the amount doesn't
   *  exceed your debt. Smallest gesture (100) and capped at min(chips, debt). */
  socket.on('lobby:payDebt', ({ amount } = {}, ack) => {
    const player = socket.data.player;
    if (!player) return ack?.({ ok: false, error: 'choose a player first' });
    const amt = Math.floor(Number(amount));
    if (!Number.isFinite(amt) || amt < 1) return ack?.({ ok: false, error: 'amount must be ≥ 1' });
    const fresh = db.getPlayer(player.player_id);
    if (amt > fresh.chips)       return ack?.({ ok: false, error: 'not enough chips' });
    if (amt > fresh.rebuy_debt)  return ack?.({ ok: false, error: 'amount exceeds debt' });
    db.payRebuyDebt(player.player_id, amt);
    const refreshed = db.getPlayer(player.player_id);
    socket.data.player = refreshed;
    const table = tableFor(socket, tables);
    if (table) {
      const seat = table.findSeat(player.player_id);
      if (seat) seat.chipsAtTable = refreshed.chips;
      table.chat('debt', `💸 ${refreshed.nickname} paid down ${amt.toLocaleString()} of debt. (Owes ${refreshed.rebuy_debt.toLocaleString()}.)`);
      table._broadcast?.();
    }
    io.emit('roster', { players: db.listHumans(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, chips: refreshed.chips, rebuyDebt: refreshed.rebuy_debt });
  });

  socket.on('lobby:listTables', (_p, ack) => {
    const list = [...tables.values()].map(t => t.publicSummary());
    ack?.({ ok: true, tables: list });
  });

  // Destructive: cancels current hand (refunds bets) and resets every
  // roster player's chip total to default. Any tab can call it; assumes
  // friends-game trust model.
  socket.on('lobby:resetGame', (_p, ack) => {
    try {
      for (const t of tables.values()) t.resetGame();
      ack?.({ ok: true });
    } catch (e) {
      console.error('[lobby:resetGame]', e);
      ack?.({ ok: false, error: 'server error' });
    }
  });

  socket.on('lobby:cancelHand', (_p, ack) => {
    try {
      for (const t of tables.values()) t.cancelHand();
      ack?.({ ok: true });
    } catch (e) {
      console.error('[lobby:cancelHand]', e);
      ack?.({ ok: false, error: 'server error' });
    }
  });
}

module.exports = { registerLobbyHandlers };
