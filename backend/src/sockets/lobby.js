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

  // Roster snapshot includes everyone — humans AND bots. Bots are
  // playable identities; picking one lets a human supersede the AI.
  function fullRoster() {
    // Humans first, then bots — sorted within each group.
    return [...db.listHumans(), ...db.listBots()];
  }
  socket.emit('roster', { players: fullRoster(), defaultStack: db.DEFAULT_STACK });

  socket.on('lobby:roster', (_p, ack) => {
    ack?.({ ok: true, players: fullRoster(), defaultStack: db.DEFAULT_STACK });
  });

  socket.on('lobby:choosePlayer', ({ playerId } = {}, ack) => {
    if (typeof playerId !== 'string') return ack?.({ ok: false, error: 'playerId required' });
    const player = db.getPlayer(playerId.toLowerCase());
    if (!player) return ack?.({ ok: false, error: 'unknown player' });
    // Picking a bot is allowed — the human supersedes the AI for the
    // duration of their session. The character keeps its persistent
    // chips + gear; the human just drives the seat.
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
    // Accept three formats:
    //   1. /tokens/<file>   — player gallery (preferred)
    //   2. /assets/characters/<file>  — bot/PC tokens (rarely picked by humans)
    //   3. Legacy SVG ids   — old players still keep these until they re-pick
    if (typeof avatarId !== 'string' || !avatarId) {
      return ack?.({ ok: false, error: 'avatarId required' });
    }
    const LEGACY_SVG = new Set(['fox','owl','raccoon','knight','wizard','robot','cat','bear','frog','lion','wolf','dragon']);
    const isTokenPath = /^\/(tokens|assets\/characters)\/[A-Za-z0-9._\-]+\.(webp|png|jpe?g)$/i.test(avatarId);
    if (!isTokenPath && !LEGACY_SVG.has(avatarId)) {
      return ack?.({ ok: false, error: 'unknown avatar' });
    }
    db.db.prepare('UPDATE players SET avatar_id = ?, last_seen_at = ? WHERE player_id = ?').run(avatarId, Date.now(), player.player_id);
    const refreshed = db.getPlayer(player.player_id);
    socket.data.player = refreshed;
    io.emit('roster', { players: fullRoster(), defaultStack: db.DEFAULT_STACK });
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
    io.emit('roster', { players: fullRoster(), defaultStack: db.DEFAULT_STACK });
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
      table.chat('debt', `💸 ${refreshed.nickname} paid down ${amt.toLocaleString()} gp of debt. (Owes ${refreshed.rebuy_debt.toLocaleString()} gp.)`);
      table._broadcast?.();
    }
    io.emit('roster', { players: fullRoster(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, chips: refreshed.chips, rebuyDebt: refreshed.rebuy_debt });
  });

  // ---- Gear: buy / upgrade ----
  // Body: { slot: 'weapon'|'armor'|'shield'|'cloak'|'ring'|'amulet', tier: 1-5 }
  // Charges the chip difference between current item and target tier.
  socket.on('lobby:buyGear', ({ slot, tier } = {}, ack) => {
    const player = socket.data.player;
    if (!player) return ack?.({ ok: false, error: 'choose a player first' });
    if (!db.GEAR_BY_KEY[slot]) return ack?.({ ok: false, error: 'unknown slot' });
    const target = Math.floor(Number(tier));
    if (!Number.isFinite(target) || target < 1 || target > 5) {
      return ack?.({ ok: false, error: 'tier must be 1–5' });
    }
    const fresh = db.getPlayer(player.player_id);
    const gear  = db.getGear(player.player_id);
    const cur   = gear[slot] || 0;
    if (target <= cur) return ack?.({ ok: false, error: 'already at or above that tier — sell first' });
    const cost = db.gearPrice(slot, target) - (cur ? db.gearPrice(slot, cur) : 0);
    if (fresh.chips < cost) {
      return ack?.({ ok: false, error: `need ${cost.toLocaleString()} gp; you have ${fresh.chips.toLocaleString()}` });
    }
    gear[slot] = target;
    db.setGear(player.player_id, gear);
    db.setChips(player.player_id, fresh.chips - cost);
    const refreshed = db.getPlayer(player.player_id);
    socket.data.player = refreshed;
    const table = tableFor(socket, tables);
    if (table) {
      const seat = table.findSeat(player.player_id);
      if (seat) seat.chipsAtTable = refreshed.chips;
      const itemName = db.GEAR_BY_KEY[slot].label;
      const action = cur > 0 ? `upgraded to +${target}` : `bought a +${target}`;
      table.chat('rebuy', `🛒 ${refreshed.nickname} ${action} ${itemName} for ${cost.toLocaleString()} gp.`);
      // Loot Lord check on every purchase, not just hand-end.
      if (db.gearIsLootLord(gear)) {
        const seatRef = table.findSeat(player.player_id) || { playerId: player.player_id, player: refreshed, chipsAtTable: refreshed.chips };
        table._declareLootLord(seatRef);
      }
      table._broadcast?.();
    }
    io.emit('roster', { players: fullRoster(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, chips: refreshed.chips, gear });
  });

  // ---- Gear: sell ----
  // Body: { slot }. Refunds 50% of current item's market price, clears slot.
  socket.on('lobby:sellGear', ({ slot } = {}, ack) => {
    const player = socket.data.player;
    if (!player) return ack?.({ ok: false, error: 'choose a player first' });
    if (!db.GEAR_BY_KEY[slot]) return ack?.({ ok: false, error: 'unknown slot' });
    const gear = db.getGear(player.player_id);
    const cur  = gear[slot] || 0;
    if (!cur) return ack?.({ ok: false, error: 'nothing to sell in that slot' });
    const refund = db.gearHockValue(slot, cur);
    gear[slot] = null;
    db.setGear(player.player_id, gear);
    const fresh = db.getPlayer(player.player_id);
    db.setChips(player.player_id, fresh.chips + refund);
    const refreshed = db.getPlayer(player.player_id);
    socket.data.player = refreshed;
    const table = tableFor(socket, tables);
    if (table) {
      const seat = table.findSeat(player.player_id);
      if (seat) seat.chipsAtTable = refreshed.chips;
      const itemName = db.GEAR_BY_KEY[slot].label;
      table.chat('rebuy', `💰 ${refreshed.nickname} hocked a +${cur} ${itemName} for ${refund.toLocaleString()} gp.`);
      table._broadcast?.();
    }
    io.emit('roster', { players: fullRoster(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, chips: refreshed.chips, gear, refund });
  });

  // ---- Champions Board ----
  socket.on('lobby:listChampions', (_p, ack) => {
    try { ack?.({ ok: true, champions: db.listChampions(50) }); }
    catch (e) { ack?.({ ok: false, error: 'server error' }); }
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
