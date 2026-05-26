/**
 * Lobby socket handlers (v0.2).
 *
 *   lobby:roster        -> { ok, players, defaultStack }     -- list everyone
 *   lobby:choosePlayer  -> { ok, player }                    -- pick one as 'me' for this socket
 *   lobby:resetStack    -> { ok, chips }                     -- re-buy for current player
 *   lobby:listTables    -> { ok, tables }
 */

const db = require('../persistence/db');

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
    db.setChips(player.player_id, db.DEFAULT_STACK);
    const refreshed = db.getPlayer(player.player_id);
    socket.data.player = refreshed;
    // Broadcast updated roster so other tabs see the new chip count.
    io.emit('roster', { players: db.listHumans(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, chips: refreshed.chips });
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
