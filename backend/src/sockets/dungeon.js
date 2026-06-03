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

const RECRUIT_FEE = 50;        // gold paid to an AI ally to bring them along
const MAX_BOT_ALLIES = 3;

function registerDungeonHandlers(io, socket, { tables, dungeons }) {
  const meOf = () => socket.data.player;
  const tableIdOf = () => socket.data.tableId || 'main';

  // Bots that are NOT seated at any table and not already in this run — the
  // only ones you can recruit (idle mercenaries, so poker isn't disrupted).
  function computeRecruitable(d) {
    const seated = new Set();
    for (const t of tables.values()) for (const s of t.seats) if (!s.isEmpty() && s.isBot) seated.add(s.playerId);
    const inParty = new Set(d.party.filter(m => !m.left).map(m => m.playerId));
    return db.listBots()
      .filter(b => !seated.has(b.player_id) && !inParty.has(b.player_id))
      .map(b => ({ playerId: b.player_id, nickname: b.nickname, avatarId: b.avatar_id, wealth: b.chips, gear: db.getGear(b.player_id), fee: RECRUIT_FEE }))
      .sort((a, b) => String(a.nickname).localeCompare(String(b.nickname)));
  }
  const isSeatedAnywhere = (botId) => [...tables.values()].some(t => !!t.findSeat(botId));

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
          else if (exit.fled) t.chat('info', `🏃 ${nickname} ran away from the dungeon${exit.goldBanked ? ` with ${exit.goldBanked}g` : ' empty-handed'}.`);
          else if (exit.ai) t.chat('info', `🤖 ${nickname} earned ${exit.goldBanked || 0}g in the dungeon.`);
          else if (exit.goldBanked) t.chat('info', `🪜 ${nickname} returned from the dungeon with ${exit.goldBanked}g.`);
          else t.chat('info', `🪜 ${nickname} returned from the dungeon empty-handed.`);
        } catch (_) {}
      },
      onEmpty: () => { dungeons.delete(tableId); },
    });
    d._recruitableFn = () => computeRecruitable(d);   // unseated bots for the recruit UI
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

  // Spectate the run — watch + heckle without leaving your poker seat or
  // joining the fight. Just joins the dungeon room to receive state + voices.
  socket.on('dungeon:spectate', (_p, ack) => {
    const me = meOf();
    if (!me) return ack?.({ ok: false, error: 'choose a player first' });
    const d = dungeons.get(tableIdOf());
    if (!d || d.status === 'over') return ack?.({ ok: false, error: 'nobody is in the dungeon right now' });
    if (d.hasMember(me.player_id)) return ack?.({ ok: false, error: 'you are already in the dungeon' });
    socket.join(d.roomName());
    socket.data.dungeonSpectator = true;
    socket.emit('dungeon:state', d.publicState());
    ack?.({ ok: true, state: d.publicState() });
  });

  // Human chat in the dungeon — same idea as table:say, scoped to the run.
  // Open to combatants AND spectators (heckling is half the fun).
  socket.on('dungeon:say', ({ text } = {}, ack) => {
    const me = meOf();
    if (!me) return ack?.({ ok: false, error: 'no player' });
    const d = dungeons.get(tableIdOf());
    if (!d) return ack?.({ ok: false, error: 'no dungeon' });
    const isMember = d.hasMember(me.player_id);
    const isSpectator = !!socket.data.dungeonSpectator;
    if (!isMember && !isSpectator) return ack?.({ ok: false, error: 'not in a dungeon' });
    if (typeof text !== 'string') return ack?.({ ok: false, error: 'bad text' });
    const now = Date.now();
    if (now - (socket.data.lastDungeonChatAt || 0) < 1200) return ack?.({ ok: false, error: 'slow down…' });
    socket.data.lastDungeonChatAt = now;
    let res;
    try { res = isMember ? d.say(me.player_id, text) : d.spectatorSay(me, text); }
    catch (e) { res = { ok: false, error: e.message }; }
    ack?.(res || { ok: true });
  });

  socket.on('dungeon:recruit', ({ botId } = {}, ack) => {
    const me = meOf();
    if (!me) return ack?.({ ok: false, error: 'no player' });
    const d = dungeons.get(tableIdOf());
    if (!d || !d.hasMember(me.player_id)) return ack?.({ ok: false, error: 'not in a dungeon' });
    if (d.botCount() >= MAX_BOT_ALLIES) return ack?.({ ok: false, error: `party is full (${MAX_BOT_ALLIES} AI allies max)` });
    const bot = db.getPlayer(botId);
    if (!bot || !bot.is_bot) return ack?.({ ok: false, error: 'unknown ally' });
    if (isSeatedAnywhere(botId)) return ack?.({ ok: false, error: 'that AI is seated at the table' });
    if (d.hasMember(botId)) return ack?.({ ok: false, error: 'already in the party' });
    const meFresh = db.getPlayer(me.player_id);
    if ((meFresh?.chips || 0) < RECRUIT_FEE) return ack?.({ ok: false, error: `not enough gold (need ${RECRUIT_FEE}g)` });
    // Pay the fee: recruiter → ally.
    db.setChips(me.player_id, meFresh.chips - RECRUIT_FEE);
    db.setChips(botId, (bot.chips || 0) + RECRUIT_FEE);
    d.addMember(bot, true);
    d._note(`🤝 ${me.nickname} recruited ${bot.nickname} for ${RECRUIT_FEE}g.`);
    d._broadcast();
    io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true });
  });

  socket.on('dungeon:leave', (_p, ack) => {
    const me = meOf();
    if (me) {
      const d = dungeons.get(tableIdOf());
      if (d && d.hasMember(me.player_id)) { try { d.bail(me.player_id); } catch (_) {} }
      if (d) socket.leave(d.roomName());
    }
    socket.data.dungeonSpectator = false;   // stop spectating (no-op for combatants)
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
