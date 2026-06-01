/**
 * Dungeon socket handlers — ONE shared co-op run per table.
 *
 *   dungeon:enter  -> leave poker seat, join (or start) the table's run
 *   dungeon:action -> { kind, ...payload }  (attack/lightning/stinking/door/bail/equip/hock)
 *   dungeon:leave  -> bail out (bank your share) + leave the room
 *
 * dungeon:state / dungeon:exit broadcast to the `dungeon:<tableId>` room
 * (dungeon:exit carries playerId — only that client surfaces back to the table).
 * dungeon:echo carries muffled combat sounds to the poker table.
 */
const db = require('../persistence/db');
const { Dungeon } = require('../game/Dungeon');

function registerDungeonHandlers(io, socket, { tables, dungeons }) {
  const meOf = () => socket.data.player;
  const tableIdOf = () => socket.data.tableId || 'main';

  function getOrCreateDungeon(tableId) {
    let d = dungeons.get(tableId);
    if (d && d.status !== 'over') return d;
    d = new Dungeon({
      tableId, io,
      onMemberExit: (playerId, nickname, exit) => {
        io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
        const t = tables.get(tableId);
        if (!t) return;
        try { t._broadcast(); } catch (_) {}
        try {
          if (exit.reason === 'dead') t.chat('info', `☠️ ${nickname} has died in the dungeon.`);
          else if (exit.goldBanked) t.chat('info', `🪜 ${nickname} returned from the dungeon with ${exit.goldBanked}g.`);
          else t.chat('info', `🪜 ${nickname} returned from the dungeon empty-handed.`);
        } catch (_) {}
      },
      onEmpty: () => { dungeons.delete(tableId); },
    });
    dungeons.set(tableId, d);
    return d;
  }

  socket.on('dungeon:enter', (_p, ack) => {
    const me = meOf();
    if (!me) return ack?.({ ok: false, error: 'choose a player first' });
    if (me.is_bot) return ack?.({ ok: false, error: 'bots cannot enter the dungeon directly' });
    const tableId = tableIdOf();
    const table = tables.get(tableId);

    const d = getOrCreateDungeon(tableId);
    // Leave the poker seat (humans only). The table keeps playing without us.
    if (table) {
      const seat = table.findSeat(me.player_id);
      if (seat && !seat.isBot) { try { table.stand(me.player_id); } catch (_) {} }
      try { table._broadcast(); } catch (_) {}
      io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
    }
    socket.join(d.roomName());
    const fresh = db.getPlayer(me.player_id) || me;
    const already = d.hasMember(me.player_id);
    if (!already) {
      d.addMember(fresh);
      try { if (table) table.chat('info', `🗡️ ${me.nickname} has entered the dungeon.`); } catch (_) {}
    }
    socket.emit('dungeon:state', d.publicState());
    ack?.({ ok: true, state: d.publicState() });
  });

  socket.on('dungeon:action', ({ kind, ...payload } = {}, ack) => {
    const me = meOf();
    if (!me) return ack?.({ ok: false, error: 'no player' });
    const d = dungeons.get(tableIdOf());
    if (!d) return ack?.({ ok: false, error: 'no dungeon' });
    let res;
    try { res = d.action(me.player_id, kind, payload); }
    catch (e) { res = { ok: false, error: e.message }; }
    ack?.(res || { ok: true });
  });

  socket.on('dungeon:leave', (_p, ack) => {
    const me = meOf();
    if (me) {
      const d = dungeons.get(tableIdOf());
      if (d && d.hasMember(me.player_id)) { try { d.bail(me.player_id); } catch (_) {} }
      if (d) socket.leave(d.roomName());
    }
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const me = meOf();
    if (!me) return;
    const d = dungeons.get(tableIdOf());
    if (d && d.hasMember(me.player_id)) { try { d.bail(me.player_id); } catch (_) {} }  // auto-bail keeps their gold
  });
}

module.exports = { registerDungeonHandlers };
