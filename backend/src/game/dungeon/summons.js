/**
 * game/dungeon/summons.js — the SUMMONING system. Two builders that spawn
 * creatures mid-combat and slot them into the turn order on the SUMMONER'S
 * initiative (PF1: a summon acts the moment it appears):
 *   _abSummon    — ALLIED summons (Draymus's undead, Jason's devils): minions that
 *                  fight FOR the party, flagged `summoned` (not targetable by the
 *                  party, don't block room-clear, crumble after `rounds`).
 *   _enemySummon — the enemy mirror (Whispering Way necromancers): REAL foes raised
 *                  as reinforcements onto the enemy side.
 * Plain-object mixin on Dungeon.prototype. The summoned minion's actual TURN (its
 * swing at the weakest foe + expiry tick) lives in _advanceToActor — turn-loop core.
 * Depends on: game/combat (dRoll/dRollN/pick), pf1data/monsters (MON).
 * Cross-calls Dungeon core freely via `this` (_makeEnemy/_note/_echoToTable/_broadcast).
 * 2026-07-07: extracted VERBATIM from Dungeon.js (summon seam, post Phase-2).
 */
const { dRoll, dRollN, pick } = require('../combat');
const { MON } = require('../../pf1data/monsters');

module.exports = {
  // SUMMON (Draymus's Summon Undead) — raise minion(s) that fight FOR the party.
  // Each minion is a normal enemy stat block (via _makeEnemy) flagged `summoned`:
  // it joins this.enemies + the turn order, attacks REAL foes on its turn (see the
  // summoned block in _advanceToActor), is NOT targetable by the party, does NOT
  // block room-clear, and crumbles after `rounds` (or at room end). Phase 1: foes
  // do not yet target summons back (no soak) — that's a later pass.
  _abSummon(m, ab, payload) {
    const spec = ab.summon || {};
    // Flavored per summon KIND: UNDEAD claw up from the grave (Draymus); DEVILS are called
    // up from Hell by an infernal pact (Jason, Cleric of Asmodeus). Default = undead.
    const FL = {
      undead: { fizzle: 'the grave yields nothing',            raise: 'tears open the grave',    join: (n) => `claw${n > 1 ? '' : 's'} free to fight for the party`,                align: 'NE' },
      devil:  { fizzle: 'the infernal contract goes unanswered', raise: 'seals an INFERNAL PACT', join: (n) => `answer${n > 1 ? '' : 's'} the call, marching up from Hell to serve the party`, align: 'LE' },
    };
    const fl = FL[spec.flavor] || FL.undead;
    const pool = spec.pool || (spec.key ? [spec.key] : []);
    const valid = pool.filter(k => MON[k]);
    if (!valid.length) { this._note(`${ab.icon || '☠️'} ${m.nickname}'s ${ab.name} fizzles — ${fl.fizzle}.`); this._echoToTable(); return; }
    // PF1 Summon Monster: 1 creature, or 1d3 / 1d4+1 of a lower tier — all of the SAME
    // KIND. Pick ONE kind at random from the choices at this CR (spec.pool), then roll
    // the PF1 count ('1d4+1' / '1d3' / a number).
    const key = pick(valid);
    const rollN = (c) => { if (typeof c === 'number') return Math.max(1, c); const mm = /^(\d+)d(\d+)(?:\+(\d+))?$/.exec(String(c || '1')); return mm ? dRollN(+mm[1], +mm[2]) + (+mm[3] || 0) : 1; };
    const count = Math.max(1, rollN(spec.count));
    const rounds = spec.rounds || Math.max(3, Math.ceil((m.level || 1)));   // ~rounds/level (PF1 summon duration); crumbles after
    const cur = this.turnOrder[this.turnIdx];                          // the summoner's slot — they're acting right now (raw entry carries .init)
    const casterInit = (cur && cur.init != null) ? cur.init : (dRoll(20) + 1);
    const newTurns = [];
    for (let i = 0; i < count; i++) {
      const e = this._makeEnemy(MON[key], false, 0);
      e.name = MON[key].name;                 // no Elite/Boss prefix on a summon
      e.summoned = true; e.summonedBy = m.playerId; e.summonExpiry = rounds; e.summonFlavor = spec.flavor || 'undead';
      e.flatFooted = false;                   // it rises ready to fight
      e.gold = 0;                             // a summon drops no loot
      e.align = fl.align; e.evil = true;      // summoned fiend/undead fights on the party's side but is still evil
      this.enemies.push(e);
      newTurns.push({ kind: 'enemy', id: e.uid, init: casterInit });   // shares the caster's initiative
    }
    // PF1: a summon acts the moment it appears, on the SUMMONER'S initiative — splice it right after the caster's slot (this round + every round after), not at the end.
    const at = ((this.turnIdx != null ? this.turnIdx : this.turnOrder.length - 1)) + 1;
    this.turnOrder.splice(at, 0, ...newTurns);
    const nm = MON[key].name;
    const label = count > 1 ? `${count} ${nm}${/s$/.test(nm) ? '' : 's'}` : `a ${nm}`;
    this._note(`${ab.icon || '☠️'} ${m.nickname} ${fl.raise} — ${label} ${fl.join(count)}! (${rounds} rounds)`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // Build a room of foes. The per-enemy CR is geared to the weakest hero; the
  // ENEMY-SIDE SUMMON (Whispering Way necromancers): raise undead reinforcements onto
  // the ENEMY side — REAL foes (not allied `summoned`), built from MON like any spawn,
  // joining this.enemies + the turn order. e.summon = { pool:[keys], count:'1d3'|N, sound };
  // consumes e.summonLeft. (The enemy mirror of _abSummon.)
  _enemySummon(e) {
    e.summonLeft = Math.max(0, (e.summonLeft || 0) - 1);
    const spec = e.summon || {};
    const valid = (spec.pool || []).filter(k => MON[k]);
    if (!valid.length) { this._broadcast(); return; }
    const key = pick(valid);
    const rollN = (c) => { if (typeof c === 'number') return Math.max(1, c); const mm = /^(\d+)d(\d+)(?:\+(\d+))?$/.exec(String(c || '1')); return mm ? dRollN(+mm[1], +mm[2]) + (+mm[3] || 0) : 1; };
    const count = Math.max(1, rollN(spec.count));
    const curE = this.turnOrder[this.turnIdx];                         // the enemy summoner's slot (acting now; raw entry carries .init)
    const casterInitE = (curE && curE.init != null) ? curE.init : (dRoll(20) + 1);
    const newTurnsE = [];
    for (let i = 0; i < count; i++) {
      const ne = this._makeEnemy(MON[key], false, 0);
      ne.flatFooted = false;   // clawed up ready to fight
      this.enemies.push(ne);
      newTurnsE.push({ kind: 'enemy', id: ne.uid, init: casterInitE });
    }
    // PF1: reinforcements act on the summoner's initiative — splice in right after the caster (join THIS round), not at the tail.
    const atE = ((this.turnIdx != null ? this.turnIdx : this.turnOrder.length - 1)) + 1;
    this.turnOrder.splice(atE, 0, ...newTurnsE);
    const nm = MON[key].name;
    this._note(`${e.glyph} ${e.name} rasps a grave-rite — ${count > 1 ? `${count} ${nm}s` : `a ${nm}`} claw${count > 1 ? '' : 's'} up from the earth to fight!`, spec.sound || '/audio/spell_umbral_bolt.mp3', { side: 'enemy' });
    this._broadcast();
  },
};
