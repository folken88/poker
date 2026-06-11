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
const { levelFromXp } = require('../pf1data/xp');

// An AI ally's recruit fee scales with how strong they are: 50g base + 10g per
// character level (level comes from XP). A fresh L1 merc is 60g; a veteran L10 is
// 150g. Paid recruiter → ally, so the gold stays in the economy.
const RECRUIT_BASE = 50;
const RECRUIT_PER_LEVEL = 10;
const recruitFee = (botId) => RECRUIT_BASE + RECRUIT_PER_LEVEL * Math.max(1, levelFromXp(db.getXp(botId) || 0));
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
      .map(b => ({ playerId: b.player_id, nickname: b.nickname, avatarId: b.avatar_id, wealth: b.chips, gear: db.getGear(b.player_id), fee: recruitFee(b.player_id) }))
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
    // Back within the reconnect grace window → cancel the pending auto-bail and
    // slot them straight back into their own run (same member, depth and share).
    if (already && d._dcBail && d._dcBail.has(me.player_id)) {
      try { clearTimeout(d._dcBail.get(me.player_id)); } catch (_) {}
      d._dcBail.delete(me.player_id);
      try { d._note(`📡 ${me.nickname} reconnected — back in the run!`); d._broadcast(); } catch (_) {}
    }
    if (!already) {
      d.addMember(fresh);
      try { if (table) table.chat('info', `🗡️ ${me.nickname} has entered the dungeon.`); } catch (_) {}
    }
    socket.emit('dungeon:state', d.publicState());
    ack?.({ ok: true, state: d.publicState(), rejoined: already });
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
    const fee = recruitFee(botId);   // 50g + 10g per the ally's level
    if ((meFresh?.chips || 0) < fee) return ack?.({ ok: false, error: `not enough gold (need ${fee}g)` });
    // Pay the fee: recruiter → ally.
    db.setChips(me.player_id, meFresh.chips - fee);
    db.setChips(botId, (bot.chips || 0) + fee);
    d.addMember(bot, true);
    d._note(`🤝 ${me.nickname} recruited ${bot.nickname} for ${fee}g.`);
    d._broadcast();
    io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true });
  });

  // Hire a RANDOM batch of AI allies in one click (the dungeon's answer to the
  // poker table's "Fill" button). Fills the open party slots with random unseated
  // bots, paying EACH ally's own level-scaled fee (50g + 10g/level). Hires down a
  // shuffled list, skipping any the recruiter can't currently afford, until the
  // slots are full or no affordable ally remains. The 3-ally cap is respected.
  socket.on('dungeon:recruitRandom', (_p, ack) => {
    const me = meOf();
    if (!me) return ack?.({ ok: false, error: 'no player' });
    const d = dungeons.get(tableIdOf());
    if (!d || !d.hasMember(me.player_id)) return ack?.({ ok: false, error: 'not in a dungeon' });
    const slots = MAX_BOT_ALLIES - d.botCount();
    if (slots <= 0) return ack?.({ ok: false, error: `party is full (${MAX_BOT_ALLIES} AI allies max)` });
    // Shuffle the unseated, not-already-in-party bots and hire down the list.
    const pool = computeRecruitable(d);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    let hired = 0;
    for (const c of pool) {
      if (hired >= slots) break;
      const bot = db.getPlayer(c.playerId);
      if (!bot || !bot.is_bot) continue;
      if (isSeatedAnywhere(c.playerId) || d.hasMember(c.playerId)) continue;
      const cur = db.getPlayer(me.player_id);
      const fee = recruitFee(c.playerId);
      if ((cur?.chips || 0) < fee) continue;   // can't afford this one — try a cheaper ally
      db.setChips(me.player_id, cur.chips - fee);
      db.setChips(c.playerId, (bot.chips || 0) + fee);
      d.addMember(bot, true);
      d._note(`🤝 ${me.nickname} recruited ${bot.nickname} for ${fee}g.`);
      hired++;
    }
    if (hired === 0) return ack?.({ ok: false, error: 'not enough gold for any available ally' });
    d._broadcast();
    io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, hired });
  });

  // Dismiss (kick) an AI ally from the party — the dungeon's answer to the poker
  // table's "× kick". Any human delver in the run may dismiss an AI ally.
  socket.on('dungeon:kick', ({ botId } = {}, ack) => {
    const me = meOf();
    if (!me) return ack?.({ ok: false, error: 'no player' });
    const d = dungeons.get(tableIdOf());
    if (!d || !d.hasMember(me.player_id)) return ack?.({ ok: false, error: 'not in a dungeon' });
    let res;
    try { res = d.kickBot(me.player_id, botId); } catch (e) { return ack?.({ ok: false, error: e.message }); }
    if (!res || !res.ok) return ack?.(res || { ok: false, error: 'could not dismiss ally' });
    d._broadcast();
    io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true });
  });

  // Bail out of the FIGHT but keep WATCHING — banks your gold, leaves the run,
  // and stays in the dungeon room as a spectator (you can re-Join later).
  socket.on('dungeon:bailWatch', (_p, ack) => {
    const me = meOf();
    if (!me) return ack?.({ ok: false, error: 'no player' });
    const d = dungeons.get(tableIdOf());
    if (!d) return ack?.({ ok: false, error: 'no dungeon' });
    if (d.hasMember(me.player_id)) { try { d.bail(me.player_id); } catch (_) {} }
    socket.join(d.roomName());               // ensure we keep receiving state + voices
    socket.data.dungeonSpectator = true;     // now a heckler
    ack?.({ ok: true, state: d.publicState() });
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

  // Hard-cancel the whole run — escape hatch for a stuck/broken run. Any player
  // at the table may trigger it; cancelRun() bails out everyone (each banks
  // their share and is surfaced back upstairs) and ends the run cleanly.
  socket.on('dungeon:cancel', (_p, ack) => {
    const me = meOf();
    if (!me) return ack?.({ ok: false, error: 'no player' });
    const d = dungeons.get(tableIdOf());
    if (!d) return ack?.({ ok: false, error: 'no dungeon to cancel' });
    try { d.cancelRun(); } catch (e) { return ack?.({ ok: false, error: e.message }); }
    ack?.({ ok: true });
  });

  // RECONNECT GRACE: a reload/disconnect no longer bails you out of the run on the
  // spot. The member stays in the party (their turns auto-resolve via the AFK
  // auto-attack) for a grace window; come back in time and dungeon:enter cancels
  // the pending bail — you're simply back, same depth, same share. Only when the
  // window expires do we bail them (banking their gold, exactly as before).
  const DC_BAIL_GRACE_MS = 3 * 60_000;
  socket.on('disconnect', () => {
    const me = meOf();
    if (!me) return;
    const d = dungeons.get(tableIdOf());
    if (!d || !d.hasMember(me.player_id)) return;
    const pid = me.player_id;
    d._dcBail = d._dcBail || new Map();
    if (d._dcBail.has(pid)) return;                 // a grace timer is already running
    try { d._note(`📡 ${me.nickname} lost connection — holding their place for ${Math.round(DC_BAIL_GRACE_MS / 60000)} minutes.`); d._broadcast(); } catch (_) {}
    const timer = setTimeout(() => {
      try {
        d._dcBail && d._dcBail.delete(pid);
        if (d.status !== 'over' && d.hasMember(pid)) d.bail(pid);   // grace expired → bail (banks their gold)
      } catch (_) {}
    }, DC_BAIL_GRACE_MS);
    if (timer.unref) timer.unref();
    d._dcBail.set(pid, timer);
  });
}

module.exports = { registerDungeonHandlers };
