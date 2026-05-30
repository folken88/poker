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
const { interpretVoiceCommand } = require('../bot/voiceIntent');

function meOf(socket) { return socket.data.player; }

// ----- "Useless fight" narration helpers (cosmetic only) -----
const FLESH_VERBS = ['slashes', 'carves', 'cuts', 'eviscerates', 'opens up', 'runs through', 'guts', 'skewers'];
function fightLine(attacker, defender, s, isCounter) {
  const lead = isCounter ? '↩️ ' : '⚔️ ';
  const roll = ` (d20 ${s.roll}${s.weapon.toHit ? '+' + s.weapon.toHit : ''}=${s.total} vs AC ${s.ac})`;
  if (s.outcome === 'flesh') {
    const v = FLESH_VERBS[Math.floor(Math.random() * FLESH_VERBS.length)];
    const cb = s.weapon.toHit ? '+' + s.weapon.toHit : '';
    let tail = '';
    if (s.crit) tail = ` 💥 CRIT ×${s.weapon.critMult}! (threat on ${s.roll}, confirmed ${s.confirmRoll}${cb}=${s.confirmTotal} vs AC ${s.ac})`;
    else if (s.threat) tail = ` (threatened on ${s.roll} — failed to confirm: ${s.confirmRoll}${cb}=${s.confirmTotal} vs AC ${s.ac})`;
    return `${lead}${attacker} ${v} ${defender} with a ${s.weapon.name} for ${s.damage} damage!${tail}${roll}`;
  }
  if (s.outcome === 'blocked') {
    return `${lead}${attacker}'s ${s.weapon.name} clangs off ${defender}'s armor — blocked!${roll}`;
  }
  if (s.outcome === 'fumble') {
    return `${lead}${attacker} FUMBLES — trips over their own ${s.weapon.name} and eats dirt! 💀 oof${roll}`;
  }
  return `${lead}${attacker} swings a ${s.weapon.name} at ${defender} and whiffs.${roll}`;
}
function swingSummary(s) {
  if (s.outcome === 'flesh') return `a clean hit for ${s.damage} damage${s.crit ? ' (a CRIT!)' : ''}`;
  if (s.outcome === 'blocked') return `blocked by armor (0 damage)`;
  if (s.outcome === 'fumble') return `a clumsy fumble — they tripped over their own weapon (0 damage)`;
  return `a total whiff (0 damage)`;
}

// ----- Spell narration (Lightning Bolt / Stinking Cloud), cosmetic only -----
function spellLine(caster, target, s) {
  const saveInfo = ` (${s.save} ${s.saveRoll}${s.cloak ? '+' + s.cloak : ''}=${s.saveTotal} vs DC ${s.dc})`;
  if (s.type === 'lightning') {
    if (s.power === 0) {
      return `⚡ ${caster} points dramatically at ${target}… and nothing happens — no magic items, the bolt fizzles. 💀 oof`;
    }
    return s.saved
      ? `⚡ ${caster} hurls a Lightning Bolt at ${target} — DC ${s.dc}! ${target} dives aside (saved) — half of ${s.fullDamage} = ${s.damage} lightning.${saveInfo}`
      : `⚡ ${caster} hurls a Lightning Bolt at ${target} — DC ${s.dc}! ${target} is FRIED for ${s.damage} lightning damage!${saveInfo}`;
  }
  // stinking cloud
  return s.saved
    ? `💨 ${caster} conjures a Stinking Cloud around ${target} — DC ${s.dc}! ${target} holds their breath (saved).${saveInfo}`
    : `💨 ${caster} conjures a Stinking Cloud around ${target} — DC ${s.dc}! ${target} gags and is SICKENED! 🤢${saveInfo}`;
}
function spellReactionDesc(caster, target, s) {
  let what;
  if (s.type === 'lightning') {
    what = s.power === 0
      ? `${caster} tried to zap you with a Lightning Bolt but owns NO magic items, so it fizzled into nothing — RIDICULE their non-existent spell mastery ("your mastery of spells is non-existent", "you call that magic?").`
      : s.saved
        ? `${caster} threw a Lightning Bolt at you but it barely tickled — you shrugged off all but ${s.damage}. RIDICULE their FEEBLE spellcraft and poor spell mastery; mock the WEAK magic, NOT dodging.`
        : `${caster} FRIED you with a Lightning Bolt for ${s.damage} lightning — react (indignant, or grudging respect for real power).`;
  } else {
    what = s.saved
      ? `${caster} tried to gag you with a Stinking Cloud but you held your breath — mock their feeble little conjuration.`
      : `${caster} hit you with a Stinking Cloud and you are SICKENED, gagging on the stench — react with disgust ("ugh", "gross", "rude").`;
  }
  return `${what} This is a silly cosmetic spell, NOT poker — one short in-character line.`;
}

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

  // Fill EVERY empty seat with a random, distinct AI in one go.
  socket.on('table:fillBots', (_p, ack) => {
    const table = tables.get(socket.data.tableId);
    if (!table) return ack?.({ ok: false, error: 'not at a table' });
    const emptyCount = table.seats.filter(s => s.isEmpty()).length;
    if (emptyCount === 0) return ack?.({ ok: false, error: 'no empty seats' });
    const seatedIds = new Set(table.seats.filter(s => s.playerId).map(s => s.playerId));
    // Available bots (is_bot=1, not already seated, with chips), shuffled.
    const pool = db.listBots().filter(b => b.is_bot === 1 && !seatedIds.has(b.player_id) && b.chips > 0);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    let seated = 0;
    for (const bot of pool) {
      if (seated >= emptyCount) break;
      if (table.seatBot(bot.player_id).ok) seated++;
    }
    if (seated === 0) return ack?.({ ok: false, error: 'no available bots' });
    io.to(table.roomName()).emit('table:state', table.publicState());
    io.emit('roster', { players: db.listAll(), defaultStack: db.DEFAULT_STACK });
    ack?.({ ok: true, seated });
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
    const playerId = (payload && typeof payload === 'object') ? payload.playerId : null;
    if (!playerId) return ack?.({ ok: false, error: 'missing playerId' });
    if (playerId === me.player_id) return ack?.({ ok: false, error: 'cannot kick yourself — use Leave' });
    const targetSeat = table.findSeat(playerId);
    if (!targetSeat) return ack?.({ ok: false, error: 'target not seated' });
    if (targetSeat.pendingStand) return ack?.({ ok: false, error: 'already leaving after this hand' });
    // Seating requirement applies ONLY when kicking another HUMAN —
    // that has real political weight, so only players sharing the
    // felt should have standing to do it. Bots are fair game for any
    // logged-in caller: a spectator needs to be able to clear stale
    // bots before sitting down. Mirrors the old table:removeBot path
    // (kept below as a legacy alias) which had no seated check.
    const callerSeat = table.findSeat(me.player_id);
    if (!targetSeat.isBot && !callerSeat) {
      return ack?.({ ok: false, error: 'must be seated to kick a human player' });
    }

    const callerNick = me.nickname || me.player_id;
    // displayNickname() preserves Vorkstag's disguise — chat says
    // "kicked Kate" even if Kate is actually the skinwalker.
    const targetNick = targetSeat.displayNickname();
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

  /**
   * table:fight — the cosmetic "useless fight" gag. A seated player swings
   * their weapon at another seated player; the target swings back. PURELY
   * FLAVOR: nothing about chips, pots, or the hand is touched. Just a chat
   * line + a sound effect for everyone, and a bot reaction if the target
   * is an AI.
   */
  socket.on('table:fight', ({ targetPlayerId, attack } = {}, ack) => {
    const me = meOf(socket);
    if (!me) return ack?.({ ok: false, error: 'choose a character first' });
    const table = tables.get(socket.data.tableId);
    if (!table) return ack?.({ ok: false, error: 'not at a table' });
    if (!targetPlayerId) return ack?.({ ok: false, error: 'missing target' });
    if (targetPlayerId === me.player_id) return ack?.({ ok: false, error: 'cannot attack yourself' });

    const mySeat = table.findSeat(me.player_id);
    if (!mySeat) return ack?.({ ok: false, error: 'sit down to fight' });
    const targetSeat = table.findSeat(targetPlayerId);
    if (!targetSeat || targetSeat.isEmpty()) return ack?.({ ok: false, error: 'target not seated' });

    // Per-socket cooldown (shared across melee + spells) so the felt isn't a
    // sword/lightning spam machine.
    const now = Date.now();
    if (now - (socket.data.lastFightAt || 0) < 2500) return ack?.({ ok: false, error: 'catch your breath…' });
    socket.data.lastFightAt = now;

    const mode = (attack === 'lightning' || attack === 'stinking') ? attack : 'melee';
    const combat = require('../game/combat');
    const aNick = mySeat.displayNickname ? mySeat.displayNickname() : (me.nickname || me.player_id);
    const dNick = targetSeat.displayNickname ? targetSeat.displayNickname() : (targetSeat.player?.nickname || targetPlayerId);
    const aGear = db.getGear(me.player_id);
    const dGear = db.getGear(targetPlayerId);

    if (mode === 'melee') {
      // Attacker's swing — broadcast line + sound to everyone.
      const a = combat.resolveSwing(aGear, dGear);
      table.chat('fight', fightLine(aNick, dNick, a), { audioUrl: a.sound });

      // Target's counter-swing, delayed so the two sounds don't collide.
      setTimeout(() => {
        try {
          const c = combat.resolveSwing(dGear, aGear);
          table.chat('fight', fightLine(dNick, aNick, c, true), { audioUrl: c.sound });
          if (targetSeat.isBot) {
            const banter = require('../bot/banter');
            const dealtMore = c.damage > a.damage;
            const tookMore  = a.damage > c.damage;
            const mood = dealtMore
              ? 'You hit them HARDER than they hit you — GLOAT briefly ("have any regrets?", "oops.", "whoops, was that your face?").'
              : tookMore
                ? 'They got you worse than you got them — be INDIGNANT but brief ("rude.", "excuse you.", "ow — seriously?").'
                : 'An even, petty exchange — react however fits your character, briefly.';
            banter.maybeSpeak(table, {
              kind: 'fight',
              description: `${aNick} just swung a ${a.weapon.name} at you (${dNick}) — ${swingSummary(a)}. ` +
                `You swung back with your ${c.weapon.name} — ${swingSummary(c)}. ${mood} ` +
                `This is a silly bar-brawl side-gag, NOT poker — one short in-character line.`,
              speakerHint: targetPlayerId,
              actorIds: [me.player_id],
              prob: 0.9,
            });
          }
        } catch (_) { /* fight is pure flavor; never let it throw */ }
      }, 900);
    } else {
      // Ranged spell: Lightning Bolt (Reflex) or Stinking Cloud (Fort). No
      // counter-attack — the target just saves (or doesn't).
      const s = combat.resolveSpell(mode, aGear, dGear);
      // Stinking Cloud sickens on a failed Fort save — a cosmetic ~30s status.
      if (mode === 'stinking' && s.sickened) {
        targetSeat.sickenedUntil = Date.now() + 30000;
      }
      table.chat('fight', spellLine(aNick, dNick, s), { audioUrl: s.sound });
      table._broadcast(); // push the (maybe) new sickened status to clients
      if (targetSeat.isBot) {
        setTimeout(() => {
          try {
            const banter = require('../bot/banter');
            banter.maybeSpeak(table, {
              kind: 'fight',
              description: spellReactionDesc(aNick, dNick, s),
              speakerHint: targetPlayerId,
              actorIds: [me.player_id],
              prob: 0.9,
            });
          } catch (_) {}
        }, 900);
      }
    }

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
    const targetNick = target ? target.displayNickname() : playerId;
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

  // Blind-mode LLM fallback: the browser couldn't parse a spoken phrase
  // with its routine regexes, so it forwards the raw transcript here. We
  // build the player's live decision context (server is authoritative),
  // ask Ollama to coerce it into one action, and hand it back. We do NOT
  // execute it — the client confirms the guess aloud first, then dispatches
  // via the normal table:action path. ack always carries { ok, action,
  // amount, isActor }; action 'none' means "couldn't understand".
  socket.on('blind:interpret', async ({ transcript } = {}, ack) => {
    const me = meOf(socket);
    if (!me) return ack?.({ ok: false, action: 'none' });
    const table = tables.get(socket.data.tableId);
    if (!table?.hand) return ack?.({ ok: true, action: 'none' });
    const hand = table.hand;
    const p = hand.players.find(pp => pp.playerId === me.player_id);
    if (!p) return ack?.({ ok: true, action: 'none' });
    const isActor = typeof hand.getCurrentActor === 'function'
      && hand.getCurrentActor() === me.player_id;
    const toCall   = Math.max(0, (hand.currentBet || 0) - (p.invested || 0));
    const allInTo  = (p.stack || 0) + (p.invested || 0);
    const minRaiseTo = Math.min(allInTo, (hand.currentBet || 0) + (hand.minRaise || 0));
    const ctx = {
      toCall,
      canCheck: toCall === 0,
      minRaiseTo,
      maxTo: allInTo,
      stack: p.stack || 0,
      pot: (hand.pot && typeof hand.pot.totalSize === 'function') ? hand.pot.totalSize() : 0,
    };
    let intent = null;
    try { intent = await interpretVoiceCommand(String(transcript || ''), ctx); }
    catch (_) { intent = null; }
    if (!intent) return ack?.({ ok: true, action: 'none' });
    ack?.({ ok: true, action: intent.action, amount: intent.amount ?? null, isActor });
  });
}

module.exports = { registerTableHandlers };
