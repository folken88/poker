/**
 * Dungeon socket handlers (Phase 1: solo MVP).
 *
 *   dungeon:enter  -> leave poker seat, create/join a run, get dungeon:state
 *   dungeon:action -> { kind, ...payload }  (attack/lightning/stinking/door/bail/equip/hock)
 *   dungeon:leave  -> clean up after a finished run (or auto-bail if still active)
 *
 * Broadcasts dungeon:state / dungeon:exit to the `dungeon:<leaderId>` room, and
 * dungeon:echo (muffled combat sounds) to the poker table room.
 */
const db = require('../persistence/db');
const { Dungeon } = require('../game/Dungeon');

function registerDungeonHandlers(io, socket, { tables, dungeons }) {
  const meOf = () => socket.data.player;

  socket.on('dungeon:enter', (_p, ack) => {
    const me = meOf();
    if (!me) return ack?.({ ok: false, error: 'choose a player first' });
    if (me.is_bot) return ack?.({ ok: false, error: 'bots cannot enter the dungeon directly' });

    // Already running? just re-attach + resend.
    const existing = dungeons.get(me.player_id);
    if (existing && existing.status !== 'dead' && existing.status !== 'bailed') {
      socket.join(existing.roomName());
      socket.emit('dungeon:state', existing.publicState());
      return ack?.({ ok: true, state: existing.publicState() });
    }

    const table = tables.get(socket.data.tableId || 'main');
    // Leave the poker seat if currently seated (humans only — a human can't be
    // sitting as a bot here). Spectators just stay spectators.
    if (table) {
      const seat = table.findSeat(me.player_id);
      if (seat && !seat.isBot) { try { table.stand(me.player_id); } catch (_) {} }
      try { table._broadcast(); } catch (_) {}
      io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
      try { table.chat('info', `🗡️ ${me.nickname} has entered the dungeon.`); } catch (_) {}
    }

    const dungeon = new Dungeon({
      leaderId: me.player_id,
      tableId: (table && table.id) || 'main',
      io,
      onExit: (d) => {
        // Gold was already credited in bail(); refresh chip totals everywhere.
        io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
        const t = tables.get(d.tableId);
        try { if (t) t._broadcast(); } catch (_) {}
        // Only the simplest summary lines surface in the poker chat.
        try {
          if (t) {
            if (d.exit?.reason === 'dead') t.chat('info', `☠️ ${me.nickname} has died in the dungeon.`);
            else if (d.exit?.goldBanked) t.chat('info', `🪜 ${me.nickname} returned from the dungeon with ${d.exit.goldBanked}g.`);
            else t.chat('info', `🪜 ${me.nickname} returned from the dungeon empty-handed.`);
          }
        } catch (_) {}
        dungeons.delete(d.leaderId);
      },
    });
    dungeons.set(me.player_id, dungeon);
    socket.join(dungeon.roomName());
    socket.emit('dungeon:state', dungeon.publicState());
    ack?.({ ok: true, state: dungeon.publicState() });
  });

  socket.on('dungeon:action', ({ kind, ...payload } = {}, ack) => {
    const me = meOf();
    if (!me) return ack?.({ ok: false, error: 'no player' });
    const dungeon = dungeons.get(me.player_id);
    if (!dungeon) return ack?.({ ok: false, error: 'not in a dungeon' });
    let res;
    try { res = dungeon.action(me.player_id, kind, payload); }
    catch (e) { res = { ok: false, error: e.message }; }
    ack?.(res || { ok: true });
  });

  socket.on('dungeon:leave', (_p, ack) => {
    const me = meOf();
    if (!me) return ack?.({ ok: true });
    const dungeon = dungeons.get(me.player_id);
    if (dungeon) {
      // Leaving while still alive banks the gold (treated as a bail).
      if (dungeon.status === 'combat' || dungeon.status === 'exploring') {
        try { dungeon.bail(); } catch (_) {}
      }
      socket.leave(dungeon.roomName());
    }
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const me = meOf();
    if (!me) return;
    const dungeon = dungeons.get(me.player_id);
    if (dungeon && (dungeon.status === 'combat' || dungeon.status === 'exploring')) {
      try { dungeon.bail(); } catch (_) {}   // auto-bail so they keep their gold
    }
  });
}

module.exports = { registerDungeonHandlers };
