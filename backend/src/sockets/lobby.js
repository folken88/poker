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
  socket.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });

  socket.on('lobby:roster', (_p, ack) => {
    ack?.({ ok: true, players: db.listAll(), defaultStack: db.DEFAULT_STACK });
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

  // Banter-voice listener flag. Client pushes its current toggle
  // state here on connect AND on every change so the server can
  // skip 11labs synthesis when nobody at the table is listening.
  // Lives on socket.data.voiceOn; Table.anyVoiceListener() walks
  // the room. No persistence — defaults to false on every reconnect,
  // client republishes its true preference immediately.
  socket.on('lobby:setVoicePref', ({ enabled } = {}, ack) => {
    socket.data.voiceOn = !!enabled;
    ack?.({ ok: true });
  });

  // Player chooses their pronouns from the topbar dropdown. Validated
  // against 'he' | 'she' | 'they' inside db.setGender; bots are pinned
  // via BOT_ROSTER and re-synced on boot, so this path only ever
  // changes humans' values. Broadcast roster so other clients see
  // the new pronoun on the next render (the banter LLM context
  // reads gender from db.listAll()).
  socket.on('lobby:setGender', ({ gender } = {}, ack) => {
    const player = socket.data.player;
    if (!player) return ack?.({ ok: false, error: 'choose a player first' });
    if (!['he', 'she', 'they'].includes(gender)) {
      return ack?.({ ok: false, error: 'invalid gender' });
    }
    db.setGender(player.player_id, gender);
    const refreshed = db.getPlayer(player.player_id);
    socket.data.player = refreshed;
    io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, gender: refreshed.gender });
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
    io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, player: refreshed });
  });

  socket.on('lobby:resetStack', (_p, ack) => {
    const player = socket.data.player;
    if (!player) return ack?.({ ok: false, error: 'choose a player first' });
    // Hock-first gate: as long as you own magic items, you have to
    // liquidate those before going to the bank. Otherwise you could
    // hoard +5 gear AND ride the loan window indefinitely. Once you
    // hit a true 0-gear / 0-gold floor, the First Bank of Abadar will
    // extend you a fresh DEFAULT_STACK loan. There's no cap on how
    // many times you can do this — the debt just keeps stacking.
    const gear = db.getGear(player.player_id) || {};
    const ownedItems = Object.entries(gear).filter(([, t]) => t > 0);
    if (ownedItems.length > 0) {
      return ack?.({
        ok: false,
        error: 'You own magic items — hock them first (use the Loot Bank).',
      });
    }
    // 0 gear, 0 gold → take an Abadar loan. Chips back to DEFAULT_STACK,
    // outstanding debt += DEFAULT_STACK. Pay it down voluntarily via
    // lobby:payDebt; otherwise it lingers on the ledger (and drags net
    // worth) until the next Loot Lord reset wipes everyone clean.
    db.setChips(player.player_id, db.DEFAULT_STACK);
    db.addRebuyDebt(player.player_id, db.DEFAULT_STACK);
    const refreshed = db.getPlayer(player.player_id);
    socket.data.player = refreshed;
    const table = tableFor(socket, tables);
    if (table) {
      const seat = table.findSeat(player.player_id);
      if (seat) seat.chipsAtTable = refreshed.chips;
      table.chat('rebuy', humanRebuyMessage(refreshed.nickname, db.DEFAULT_STACK));
      table._broadcast?.();
    }
    io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
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
      const owesLine = refreshed.rebuy_debt > 0
        ? ` (Still owes ${refreshed.rebuy_debt.toLocaleString()} gp to the First Bank of Abadar.)`
        : ' Debt cleared — Abadar smiles on you.';
      table.chat('debt', `💸 ${refreshed.nickname} paid down ${amt.toLocaleString()} gp of debt.${owesLine}`);
      table._broadcast?.();
    }
    io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, chips: refreshed.chips, rebuyDebt: refreshed.rebuy_debt });
  });

  // ---- Gear: buy / upgrade ----
  // Body: { slot: 'weapon'|'armor'|'shield'|'cloak'|'ring', tier: 1-5 }
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
      // CRITICAL: if a hand is live, also deduct from the in-hand stack.
      // Without this, _afterHandComplete's `db.setChips(p.playerId, p.stack)`
      // overwrites the deduction we just made and the purchase appears free.
      if (table.hand) {
        const hp = table.hand.players.find(pp => pp.playerId === player.player_id);
        if (hp) hp.stack = Math.max(0, hp.stack - cost);
      }
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
    io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
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
      // Same hand-sync fix as buyGear: credit the refund into the live
      // hand stack so it doesn't get wiped at hand-end.
      if (table.hand) {
        const hp = table.hand.players.find(pp => pp.playerId === player.player_id);
        if (hp) hp.stack = hp.stack + refund;
      }
      const itemName = db.GEAR_BY_KEY[slot].label;
      table.chat('rebuy', `💰 ${refreshed.nickname} hocked a +${cur} ${itemName} for ${refund.toLocaleString()} gp.`);
      table._broadcast?.();
    }
    io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
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
