/**
 * Fight director — the cosmetic "useless fight" bar-brawl side-gag.
 *
 * PURELY FLAVOR: nothing here ever touches chips, pots, the hand, or seating.
 * It resolves a swing/spell (via combat.js), posts a chat line + sound for
 * everyone, and optionally fires a bot reaction.
 *
 * Two entry points share one implementation so humans and bots behave
 * identically:
 *   - executeFight()      one attack from attacker → target (human-initiated
 *                         via the table:fight socket handler, or bot-initiated)
 *   - maybeBotRevenge()   called at hand-complete; a seated bot MAY take a
 *                         petty cosmetic swing at someone who beat them,
 *                         bluffed them, or is a lore enemy (random revenge)
 *
 * Lives in its own module (deps: combat, db, banter, enemies — none of which
 * require Table/sockets) so both sockets/table.js and game/Table.js can use it
 * without a circular import.
 */
const combat  = require('./combat');
const db      = require('../persistence/db');
const banter  = require('../bot/banter');
const enemies = require('../bot/enemies');

// ----- Narration helpers (cosmetic only) -----
const FLESH_VERBS = ['slashes', 'carves', 'cuts', 'eviscerates', 'opens up', 'runs through', 'guts', 'skewers'];
// Narrative-only fight lines: the d20 / AC / confirmation-roll breakdowns are
// gone now that the system is proven out — just the result, with the damage
// number as the only number on a hit.
function fightLine(attacker, defender, s, isCounter) {
  const lead = isCounter ? '↩️ ' : '⚔️ ';
  if (s.outcome === 'flesh') {
    const v = FLESH_VERBS[Math.floor(Math.random() * FLESH_VERBS.length)];
    const tail = s.crit ? ' 💥 CRIT!' : '';
    return `${lead}${attacker} ${v} ${defender} with a ${s.weapon.name} for ${s.damage} damage!${tail}`;
  }
  if (s.outcome === 'blocked') {
    return `${lead}${attacker}'s ${s.weapon.name} clangs off ${defender}'s armor — blocked!`;
  }
  if (s.outcome === 'fumble') {
    return `${lead}${attacker} FUMBLES — trips over their own ${s.weapon.name} and eats dirt! 💀 oof`;
  }
  return `${lead}${attacker} swings a ${s.weapon.name} at ${defender} and whiffs.`;
}
function swingSummary(s) {
  if (s.outcome === 'flesh') return `a clean hit for ${s.damage} damage${s.crit ? ' (a CRIT!)' : ''}`;
  if (s.outcome === 'blocked') return `blocked by armor (0 damage)`;
  if (s.outcome === 'fumble') return `a clumsy fumble — they tripped over their own weapon (0 damage)`;
  return `a total whiff (0 damage)`;
}
// Narrative-only spell lines: no DC, no save-roll breakdown — just the
// outcome, with the damage number (lightning only) as the only number.
function spellLine(caster, target, s) {
  if (s.type === 'lightning') {
    return s.saved
      ? `⚡ ${caster} hurls a Lightning Bolt at ${target} — ${target} dives aside, taking ${s.damage} lightning.`
      : `⚡ ${caster} hurls a Lightning Bolt at ${target} — ${target} is FRIED for ${s.damage} lightning damage!`;
  }
  return s.saved
    ? `💨 ${caster} conjures a Stinking Cloud around ${target} — ${target} holds their breath (saved).`
    : `💨 ${caster} conjures a Stinking Cloud around ${target} — ${target} gags and is SICKENED! 🤢`;
}
function spellReactionDesc(caster, target, s) {
  let what;
  if (s.type === 'lightning') {
    what = s.saved
      ? `${caster} threw a Lightning Bolt at you but it barely tickled — you shrugged off all but ${s.damage}. RIDICULE their FEEBLE spellcraft and poor spell mastery; mock the WEAK magic, NOT dodging.`
      : `${caster} FRIED you with a Lightning Bolt for ${s.damage} lightning — react (indignant, or grudging respect for real power).`;
  } else {
    what = s.saved
      ? `${caster} tried to gag you with a Stinking Cloud but you held your breath — mock their feeble little conjuration.`
      : `${caster} hit you with a Stinking Cloud and you are SICKENED, gagging on the stench — react with disgust ("ugh", "gross", "rude").`;
  }
  return `${what} This is a silly cosmetic spell, NOT poker — one short in-character line.`;
}

function nickOfSeat(seat) {
  return seat.displayNickname ? seat.displayNickname() : (seat.player?.nickname || seat.playerId);
}

/**
 * Run ONE cosmetic attack from attackerSeat at targetSeat.
 *   mode: 'melee' | 'lightning' | 'stinking'
 *   opts.attackerMotive: optional banter description so a bot attacker can
 *     voice WHY it's swinging (revenge taunt) before the blow lands.
 * Mirrors the original table:fight handler exactly: melee gets a counter-
 * swing + (if target is a bot) a reaction; spells just save + react.
 */
function executeFight(table, attackerSeat, targetSeat, mode, opts = {}) {
  if (!table || !attackerSeat || !targetSeat) return;
  mode = (mode === 'lightning' || mode === 'stinking') ? mode : 'melee';
  const aNick = nickOfSeat(attackerSeat);
  const dNick = nickOfSeat(targetSeat);
  const aGear = db.getGear(attackerSeat.playerId);
  const dGear = db.getGear(targetSeat.playerId);

  // Bot attacker voices its motive (revenge taunt) up front, if asked.
  if (opts.attackerMotive && attackerSeat.isBot) {
    try {
      banter.maybeSpeak(table, {
        kind: 'fight',
        description: opts.attackerMotive,
        speakerHint: attackerSeat.playerId,
        actorIds: [],
        prob: 0.95,
      });
    } catch (_) { /* flavor only */ }
  }

  if (mode === 'melee') {
    const a = combat.resolveSwing(aGear, dGear);
    table.chat('fight', fightLine(aNick, dNick, a), { audioUrl: a.sound });
    // Target's counter-swing, delayed so the two sounds don't collide.
    setTimeout(() => {
      try {
        const c = combat.resolveSwing(dGear, aGear);
        table.chat('fight', fightLine(dNick, aNick, c, true), { audioUrl: c.sound });
        if (targetSeat.isBot) {
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
            speakerHint: targetSeat.playerId,
            actorIds: [attackerSeat.playerId],
            prob: 0.9,
          });
        }
      } catch (_) { /* fight is pure flavor; never let it throw */ }
    }, 900);
  } else {
    const s = combat.resolveSpell(mode, aGear, dGear);
    if (mode === 'stinking' && s.sickened) {
      targetSeat.sickenedUntil = Date.now() + 30000;
    }
    table.chat('fight', spellLine(aNick, dNick, s), { audioUrl: s.sound });
    table._broadcast(); // push the (maybe) new sickened status to clients
    if (targetSeat.isBot) {
      setTimeout(() => {
        try {
          banter.maybeSpeak(table, {
            kind: 'fight',
            description: spellReactionDesc(aNick, dNick, s),
            speakerHint: targetSeat.playerId,
            actorIds: [attackerSeat.playerId],
            prob: 0.9,
          });
        } catch (_) {}
      }, 900);
    }
  }
}

// Bot attack-type weighting: mostly a swing, sometimes a spell.
function pickBotAttack() {
  const r = Math.random();
  if (r < 0.60) return 'melee';
  if (r < 0.85) return 'lightning';
  return 'stinking';
}

function revengeMotive(kind, aNick, dNick) {
  const tail = ' This is the silly cosmetic bar-brawl side-gag, NOT poker — give ONE short in-character taunt, no poker advice.';
  if (kind === 'bluff') return `${dNick} just BLUFFED you out of a pot and you (${aNick}) take a furious, petty swing at them for it — payback.` + tail;
  if (kind === 'beat')  return `${dNick} just beat you in that hand and you (${aNick}) take a sore-loser swing at them out of spite — payback for the pot.` + tail;
  return `${dNick} is an old enemy of yours from way back (a lore grudge, nothing to do with poker) and you (${aNick}) seize the moment to settle the score with a swing.` + tail;
}

/**
 * At hand-complete, a seated bot MAY take a cosmetic revenge swing. Three
 * motives, weighted: someone who bluffed them (5) > who beat them (3) > a
 * lore enemy (2). Heavily gated — only when a human is present, behind a
 * per-table cooldown and a low probability — so it stays a rare garnish, not
 * a brawl every hand. Tunable via env: BOT_REVENGE_ENABLED (0 disables),
 * BOT_REVENGE_PROB (default 0.12), BOT_REVENGE_COOLDOWN_MS (default 60000).
 *
 * @param {object} ctx { winnerIds:Set<playerId>, bluffers:Set<playerId> }
 */
function maybeBotRevenge(table, { winnerIds = new Set(), bluffers = new Set() } = {}) {
  try {
    if (process.env.BOT_REVENGE_ENABLED === '0') return;
    // Cosmetic flavor that burns LLM + TTS — skip when no human is watching.
    if (typeof table.anyHumanPresent === 'function' && !table.anyHumanPresent()) return;

    const now = Date.now();
    const cooldown = parseInt(process.env.BOT_REVENGE_COOLDOWN_MS || '60000', 10);
    if (now - (table._lastBotFightAt || 0) < cooldown) return;
    const prob = parseFloat(process.env.BOT_REVENGE_PROB || '0.12');
    if (Math.random() > prob) return;

    const seated = table.seats.filter(s => !s.isEmpty());
    const bots = seated.filter(s => s.isBot);
    if (!bots.length) return;

    const cands = [];
    // BLUFF revenge (strongest grudge): a non-bluffer bot swings at a bluffer.
    for (const b of bluffers) {
      const tgt = seated.find(s => s.playerId === b);
      if (!tgt) continue;
      for (const atk of bots) {
        if (atk.playerId === b) continue;
        cands.push({ atk, tgt, kind: 'bluff', weight: 5 });
      }
    }
    // BEAT revenge: a seated bot who did NOT win swings at a seated winner.
    for (const w of winnerIds) {
      const tgt = seated.find(s => s.playerId === w);
      if (!tgt) continue;
      for (const atk of bots) {
        if (winnerIds.has(atk.playerId) || atk.playerId === w) continue;
        cands.push({ atk, tgt, kind: 'beat', weight: 3 });
      }
    }
    // LORE revenge (random): a bot swings at a seated lore enemy, any hand.
    for (const atk of bots) {
      const foes = enemies.enemiesOf(nickOfSeat(atk));
      if (!foes.size) continue;
      for (const tgt of seated) {
        if (tgt.playerId === atk.playerId) continue;
        if (foes.has(String(nickOfSeat(tgt)).toLowerCase())) {
          cands.push({ atk, tgt, kind: 'lore', weight: 2 });
        }
      }
    }
    if (!cands.length) return;

    // Weighted random pick.
    const total = cands.reduce((sum, c) => sum + c.weight, 0);
    let roll = Math.random() * total;
    let chosen = cands[cands.length - 1];
    for (const c of cands) { roll -= c.weight; if (roll <= 0) { chosen = c; break; } }

    table._lastBotFightAt = now;
    const motive = revengeMotive(chosen.kind, nickOfSeat(chosen.atk), nickOfSeat(chosen.tgt));
    executeFight(table, chosen.atk, chosen.tgt, pickBotAttack(), { attackerMotive: motive });
  } catch (_) { /* cosmetic — never break a hand */ }
}

module.exports = { executeFight, maybeBotRevenge, pickBotAttack };
