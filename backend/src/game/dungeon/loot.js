/**
 * game/dungeon/loot.js — LOOT: drops, roll-offs, equip/hock, cure potions.
 * Mixin on Dungeon.prototype (see the Object.assign at the bottom of
 * game/Dungeon.js) — `this` is the Dungeon instance, semantics identical.
 * Methods: _maybeDropLoot, _maybeDropPotion, _startLootRoll, _lootDecide,
 * _resolveLootRoll, _awardLoot, equipLoot, hockLoot (+ loot-only tuning:
 * LOOT_ROLL_MS, lootForCR, rollLootTier, potionForCR).
 * Depends on: persistence/db (gear/hock values), game/combat (dRoll/pick),
 * pf1data/monsters (crToNum).
 * 2026-07-03: born in the Phase-2 mixin split — bodies moved VERBATIM from
 * Dungeon.js (seam 1 of 4).
 */
const db = require('../../persistence/db');
const { dRoll, pick } = require('../combat');
const { crToNum } = require('../../pf1data/monsters');

const LOOT_ROLL_MS   = 35_000; // window to roll/pass on a dropped magic item (long enough that the auto-pass never fires while a blind player's end-of-room report is still reading)
// ── Loot odds from Pathfinder treasure-by-CR ────────────────────────────────
// PF1e ties treasure to encounter CR. A +1 item (~1-2k gp of enhancement) is the
// magic share of a ~CR 4-6 fight; +2 ≈ CR 7-9; +3 ≈ CR 10-12; +4 ≈ CR 13-15;
// +5 ≈ CR 16+. Below CR 3 magic is rare (mostly coin). The defeated room's
// toughest creature (its CR) drives both the drop chance and the best tier.
function lootForCR(cr) {
  const chance = cr < 3 ? 0.04 : Math.min(0.55, 0.10 + 0.045 * (cr - 3));
  const maxTier = cr >= 16 ? 5 : cr >= 13 ? 4 : cr >= 10 ? 3 : cr >= 7 ? 2 : 1;
  return { chance, maxTier };
}
// A drop CENTERS on the encounter's ceiling so treasure actually scales with CR:
// it's either the max tier or one below (50/50). A CR-9 boss (max +2) gives +1/+2,
// a CR-11 (max +3) gives +2/+3, a CR-16 (max +5) gives +4/+5 — instead of the old
// behaviour that buried everything at +1 regardless of how nasty the fight was.
function rollLootTier(maxTier) {
  if (maxTier <= 1) return 1;
  const floor = Math.max(1, maxTier - 1);
  return floor + (Math.random() < 0.5 ? 1 : 0);
}
// Cure potions also drop (CR-scaled), auto-quaffed by the most-hurt ally.
function potionForCR(cr) {
  if (cr >= 10) return { name: 'Cure Serious Wounds',  count: 3, die: 8, bonus: 5, gp: 750 };
  if (cr >= 5)  return { name: 'Cure Moderate Wounds', count: 2, die: 8, bonus: 3, gp: 300 };
  return          { name: 'Cure Light Wounds',    count: 1, die: 8, bonus: 1, gp: 50 };
}

module.exports = {
  _maybeDropLoot() {
    const eligible = this.party.filter(m => !m.left && !m.dead);   // up OR dying — the downed can still roll/win loot
    if (!eligible.length || !this.enemies.length) return;
    // Pathfinder-style: the encounter's toughest creature (its CR) sets both the
    // odds of a magic item and its best enhancement; a crowd nudges the CR up;
    // bosses are loot milestones (a big chance bump, but tier still from CR).
    const topCR = Math.max(0, ...this.enemies.map(e => crToNum(e.cr)));
    const effCR = topCR + (this.enemies.length >= 4 ? 1 : 0);
    let { chance, maxTier } = lootForCR(effCR);
    const isBoss = this.enemies.some(e => e.boss);
    if (isBoss) chance = 1;   // bosses ALWAYS drop ≥1 item, and it's at least +1 (rollLootTier floors at 1)
    this._log('loot_check', { topCR, effCR, boss: isBoss, chance: +chance.toFixed(2), maxTier });
    if (Math.random() >= chance) return;
    const tier = rollLootTier(maxTier);
    const slot = pick(db.GEAR_SLOT_KEYS);
    this._startLootRoll(slot, tier, eligible.map(m => m.playerId));
  },
  // Cure potions drop separately from gear (so the boss gear guarantee stands) and
  // are auto-rolled + quaffed by the most-hurt living ally. Strength scales with CR.
  _maybeDropPotion() {
    if (!this.enemies.length) return;
    const topCR = Math.max(0, ...this.enemies.map(e => crToNum(e.cr)));
    const effCR = topCR + (this.enemies.length >= 4 ? 1 : 0);
    let chance = Math.min(0.35, 0.12 + 0.02 * effCR);
    if (this.enemies.some(e => e.boss)) chance = Math.min(0.55, chance + 0.2);
    if (Math.random() >= chance) return;
    const p = potionForCR(effCR);
    let heal = p.bonus; for (let i = 0; i < p.count; i++) heal += dRoll(p.die);   // auto-roll e.g. 2d8+3
    // Most-hurt member drinks it — DOWNED (dying) allies count too and sort first
    // (negative HP fraction), so a Cure potion can haul them back up.
    const hurt = this.party
      .filter(m => !m.left && !m.dead && !m.undead && m.hp < m.maxHp)   // cure potions are positive energy — the undead pass
      .sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp));
    if (hurt.length) {
      const m = hurt[0], before = m.hp;
      m.hp = Math.min(m.maxHp, m.hp + heal);
      const gained = m.hp - before;
      const revived = before <= 0 && m.hp > 0;
      if (m.hp > 0) m.downed = false;
      this._note(`🧪 A Potion of ${p.name} drops — ${m.nickname} ${revived ? 'is revived' : 'quaffs it'} (rolled ${p.count}d${p.die}+${p.bonus}): +${gained} HP (now ${m.hp}/${m.maxHp})${revived ? ' — back on their feet!' : ''}.`, '/audio/mix_drink.mp3');
      this._log('potion', { name: p.name, who: m.playerId, rolled: heal, gained, revived });
    } else {
      const sell = Math.floor(p.gp / 2); this.runGold += sell;
      this._note(`🧪 A Potion of ${p.name} drops, but everyone's hale — hocked for ${sell} gp (pool ${this.runGold} gp).`);
      this._log('potion_sold', { name: p.name, sell });
    }
  },
  // Everyone present rolls 1d20 or passes; highest roll claims the item. AI only
  // rolls when it's an UPGRADE for them (better than what they have in that slot);
  // otherwise they pass. If nobody rolls, the item is hocked into the pool.
  _startLootRoll(slot, tier, eligibleIds) {
    this.lootRoll = { slot, tier, eligible: eligibleIds, decided: {} };
    const label = db.GEAR_BY_KEY[slot]?.label || slot;
    this._note(`💎 A +${tier} ${label} drops! Press R to roll a d20 for it, or P to pass.`, '/audio/spell_revive.mp3');
    this._log('lootdrop', { slot, tier, eligible: eligibleIds.length });
    // Decide immediately for anyone who can't benefit, and for bots:
    //   • ANY delver (human or bot) already wearing an equal-or-better item in this
    //     slot AUTO-PASSES — no point rolling to keep gear you'd never equip.
    //   • A bot that WOULD upgrade rolls right away.
    //   • A human who'd upgrade is left undecided → they get the roll/pass prompt.
    for (const id of eligibleIds) {
      const m = this.member(id);
      const cur = Number((m?.gear || db.getGear(id))[slot]) || 0;
      if (cur >= tier) { this._lootDecide(id, false); continue; }   // already have ≥ → auto-pass
      if (m && m.isBot) this._lootDecide(id, true);                 // bot upgrade → roll
    }
    // Idle humans auto-pass after the window.
    clearTimeout(this._lootTimer);
    this._lootTimer = setTimeout(() => {
      // Capture the roll: a _lootDecide that RESOLVES the roll mid-loop nulls
      // this.lootRoll, so re-reading this.lootRoll.decided on the next iteration
      // would deref null and CRASH THE WHOLE PROCESS (lost a depth-15 run +
      // 12,893 gp this way, 2026-06-13). Iterate the captured object and stop
      // the instant the live roll is gone.
      const lr = this.lootRoll;
      if (!lr) return;
      for (const id of lr.eligible) {
        if (!this.lootRoll) break;   // the roll resolved — nothing left to auto-pass
        if (!(id in lr.decided)) this._lootDecide(id, false, true);
      }
    }, LOOT_ROLL_MS);
    this._broadcast();
  },
  _lootDecide(playerId, roll, byTimeout) {
    if (!this.lootRoll) return { ok: false, error: 'no loot roll' };
    if (!this.lootRoll.eligible.includes(playerId)) return { ok: false, error: 'not eligible for this loot' };
    if (playerId in this.lootRoll.decided) return { ok: false, error: 'already decided' };
    const m = this.member(playerId);
    if (roll) { const r = dRoll(20); this.lootRoll.decided[playerId] = r; this._note(`🎲 ${m?.nickname || playerId} rolls ${r} for the loot.`); }
    else { this.lootRoll.decided[playerId] = 'pass'; this._note(`🚫 ${m?.nickname || playerId} passes on the loot${byTimeout ? ' (idle)' : ''}.`); }
    if (this.lootRoll.eligible.every(id => id in this.lootRoll.decided)) this._resolveLootRoll();
    else this._broadcast();
    return { ok: true };
  },
  _resolveLootRoll() {
    clearTimeout(this._lootTimer);
    const lr = this.lootRoll; this.lootRoll = null;
    if (!lr) return;
    const rollers = lr.eligible.filter(id => typeof lr.decided[id] === 'number');
    if (!rollers.length) {
      // Nobody wanted it → hock it into the shared pool (split evenly on bail).
      const v = db.gearHockValue(lr.slot, lr.tier);
      this.runGold += v;
      this._note(`🚫 Everyone passed — the +${lr.tier} ${db.GEAR_BY_KEY[lr.slot]?.label || lr.slot} is hocked for ${v} gp into the pool.`);
      this._log('lootpass', { slot: lr.slot, tier: lr.tier, hocked: v });
      this._broadcast(); return;
    }
    let bestRoll = -1; for (const id of rollers) if (lr.decided[id] > bestRoll) bestRoll = lr.decided[id];
    const tied = rollers.filter(id => lr.decided[id] === bestRoll);
    const winnerId = tied.length > 1 ? pick(tied) : tied[0];
    const winner = this.member(winnerId);
    this._note(`🏆 ${winner?.nickname || winnerId} wins the +${lr.tier} ${db.GEAR_BY_KEY[lr.slot]?.label || lr.slot} with a ${bestRoll}${tied.length > 1 ? ' (tie-break)' : ''}.`);
    this._log('lootwin', { slot: lr.slot, tier: lr.tier, who: winnerId, roll: bestRoll });
    this._awardLoot(winnerId, lr.slot, lr.tier);
    // An AI who lost the roll might gripe about it.
    const aiLosers = rollers.filter(id => id !== winnerId).map(id => this.member(id)).filter(x => x && x.isBot);
    if (aiLosers.length) this._tryBanter(pick(aiLosers), 'loot_lose', { tier: lr.tier, item: db.GEAR_BY_KEY[lr.slot]?.label || lr.slot, winner: winner?.nickname });
    this._broadcast();
  },
  _awardLoot(playerId, slot, tier) {
    const m = this.member(playerId);
    const gear = db.getGear(playerId);
    const cur = Number(gear[slot]) || 0;
    if (m && m.isBot) {
      // AI: equip if it's a real upgrade (needs it), else hock for the pool.
      if (cur < tier) {
        gear[slot] = tier; db.setGear(playerId, gear); m.gear = gear;
        // (gear no longer changes level — level is from XP; gear only adds to-hit/AC/dmg)
        let extra = '';
        if (cur >= 1) { const v = db.gearHockValue(slot, cur); this.runGold += v; extra = ` (old +${cur} hocked for ${v} gp)`; }
        this._note(`🛡️ ${m.nickname} equips the +${tier} ${db.GEAR_BY_KEY[slot]?.label || slot}.${extra} (Lv ${m.level})`);
      } else {
        const v = db.gearHockValue(slot, tier); this.runGold += v;
        this._note(`💰 ${m.nickname} doesn't need it — hocks it for ${v} gp (into the pool).`);
      }
      this._tryBanter(m, 'loot_win', { tier, item: db.GEAR_BY_KEY[slot]?.label || slot });
      return;
    }
    // Human: lands in their pending loot to equip or hock as they choose.
    this.pendingLoot.push({ slot, tier, owner: playerId });
  },
  // ── Loot (per owner) ──────────────────────────────────────────────────────
  equipLoot(playerId, idx) {
    const loot = this.pendingLoot[idx];
    if (!loot || loot.owner !== playerId) return { ok: false, error: 'not your loot' };
    const m = this.member(playerId); if (!m) return { ok: false, error: 'gone' };
    const gear = db.getGear(playerId);
    const oldTier = Number(gear[loot.slot]) || 0;
    const lbl0 = db.GEAR_BY_KEY[loot.slot]?.label || loot.slot;
    // Already have an equal/better one → HOCK the won item into the pool rather than
    // silently discarding it (which used to lose the loot — see Josh's report).
    if (oldTier >= loot.tier) {
      const v = db.gearHockValue(loot.slot, loot.tier); this.runGold += v;
      this.pendingLoot.splice(idx, 1);
      this._note(`💰 ${m.nickname} already has a better ${lbl0} — hocks the +${loot.tier} for ${v} gp into the pool.`);
      return { ok: true, hocked: true };
    }
    gear[loot.slot] = loot.tier;
    db.setGear(playerId, gear);
    m.gear = gear;
    // (gear no longer changes level — level is from XP; gear only adds to-hit/AC/dmg)
    this.pendingLoot.splice(idx, 1);
    const lbl = db.GEAR_BY_KEY[loot.slot]?.label || loot.slot;
    // Auto-hock the item this one replaces — its value goes into the run pool.
    let extra = '';
    if (oldTier >= 1) { const v = db.gearHockValue(loot.slot, oldTier); this.runGold += v; extra = ` Old +${oldTier} ${lbl} auto-hocked for ${v} gp into the pool.`; }
    this._note(`🛡️ ${m.nickname} equipped the +${loot.tier} ${lbl}.${extra} (Lv ${m.level})`);
    return { ok: true };
  },
  hockLoot(playerId, idx) {
    const loot = this.pendingLoot[idx];
    if (!loot || loot.owner !== playerId) return { ok: false, error: 'not your loot' };
    const v = db.gearHockValue(loot.slot, loot.tier);
    this.runGold += v;
    this.pendingLoot.splice(idx, 1);
    this._note(`💰 ${this.member(playerId)?.nickname || playerId} hocked a +${loot.tier} ${db.GEAR_BY_KEY[loot.slot]?.label || loot.slot} for ${v} gp (into the pool).`);
    return { ok: true };
  },
};
