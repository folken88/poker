/**
 * "Hit the Dungeon" — a push-your-luck side-game (Phase 1: solo MVP).
 *
 * A player leaves their poker seat and descends into the basement beneath the
 * poker hall to fight PF1e-flavored monsters on a simplified VTT, hauling gold
 * back up to the felt. This NEVER affects poker mechanics except to ADD gold to
 * a player's stack on a successful bail (gold = chips = gp, 1:1).
 *
 * Combat reuses the cosmetic combat helpers (weaponOf / acOf / totalMagicBonus
 * + the fight sound pools) but tracks REAL hp here in the Dungeon instance —
 * chips are only ever touched at the very end (bail = credit; death = nothing).
 *
 * See docs/DUNGEON_DESIGN.md for the full design.
 */

const db = require('../persistence/db');
const { weaponOf, acOf, totalMagicBonus, SND, dRoll, pick } = require('./combat');

// ── Tuning knobs (all easily adjustable) ────────────────────────────────────
const BASE_HP        = 30;     // gearless player hp
const HP_PER_BONUS   = 10;     // +per ring tier and per cloak tier
const SPELL_COOLDOWN = 3;      // rounds between casts of lightning / stinking
const LIGHTNING_MAX_TARGETS = 2;
const SICKENED_ROUNDS = 3;     // duration applied by stinking cloud
const SICKENED_PENALTY = 2;    // -2 to-hit and damage while sickened
const TURN_TIMER_MS  = 90_000; // AFK auto-bail after this on the player's turn
const ENEMY_STEP_MS  = 750;    // pacing between auto-resolved enemy turns
const BOSS_EVERY     = 5;      // every Nth room is a boss

// ── Monster bestiary (placeholder art = emoji glyphs; swap for Foundry art) ──
// hp is a base average; ac/toHit/dmg are PF1e-ish. fort/reflex are save mods.
const MON = {
  dire_rat:          { name: 'Dire Rat',          glyph: '🐀', hp: 6,  ac: 13, toHit: 2, dmgDie: 4,  dmgBonus: 0, fort: 2, reflex: 3, gold: [4, 14] },
  giant_centipede:   { name: 'Giant Centipede',   glyph: '🐛', hp: 5,  ac: 14, toHit: 3, dmgDie: 4,  dmgBonus: 0, fort: 1, reflex: 4, gold: [4, 12] },
  goblin:            { name: 'Goblin',            glyph: '👺', hp: 8,  ac: 15, toHit: 3, dmgDie: 6,  dmgBonus: 0, fort: 2, reflex: 3, gold: [8, 20] },
  kobold:            { name: 'Kobold',            glyph: '🦎', hp: 6,  ac: 15, toHit: 2, dmgDie: 6,  dmgBonus: 0, fort: 1, reflex: 3, gold: [8, 18] },
  skeleton:          { name: 'Skeleton',          glyph: '💀', hp: 10, ac: 14, toHit: 3, dmgDie: 6,  dmgBonus: 1, fort: 2, reflex: 3, gold: [10, 25] },
  giant_spider:      { name: 'Giant Spider',      glyph: '🕷️', hp: 12, ac: 14, toHit: 4, dmgDie: 6,  dmgBonus: 1, fort: 3, reflex: 4, gold: [12, 30] },
  zombie:            { name: 'Zombie',            glyph: '🧟', hp: 16, ac: 12, toHit: 4, dmgDie: 6,  dmgBonus: 3, fort: 4, reflex: 0, gold: [15, 35] },
  ghoul:             { name: 'Ghoul',             glyph: '🧛', hp: 14, ac: 15, toHit: 5, dmgDie: 6,  dmgBonus: 2, fort: 3, reflex: 4, gold: [18, 40] },
  cultist:           { name: 'Whispering Cultist',glyph: '🕯️', hp: 14, ac: 14, toHit: 4, dmgDie: 8,  dmgBonus: 1, fort: 3, reflex: 3, gold: [20, 45] },
  gray_ooze:         { name: 'Gray Ooze',         glyph: '🟢', hp: 18, ac: 10, toHit: 5, dmgDie: 6,  dmgBonus: 2, fort: 5, reflex: 0, gold: [15, 40] },
  skeletal_champion: { name: 'Skeletal Champion', glyph: '☠️', hp: 22, ac: 17, toHit: 6, dmgDie: 8,  dmgBonus: 3, fort: 4, reflex: 4, gold: [30, 60] },
  shadow:            { name: 'Shadow',            glyph: '🌑', hp: 20, ac: 15, toHit: 5, dmgDie: 6,  dmgBonus: 2, fort: 4, reflex: 6, gold: [35, 70] },
  wight:             { name: 'Wight',             glyph: '👻', hp: 26, ac: 16, toHit: 6, dmgDie: 8,  dmgBonus: 3, fort: 5, reflex: 4, gold: [40, 80] },
  ghast:             { name: 'Ghast',             glyph: '🧟‍♂️', hp: 24, ac: 17, toHit: 7, dmgDie: 8,  dmgBonus: 3, fort: 5, reflex: 5, gold: [45, 90] },
  gibbering_mouther: { name: 'Gibbering Mouther', glyph: '👄', hp: 36, ac: 15, toHit: 6, dmgDie: 6,  dmgBonus: 3, fort: 6, reflex: 4, gold: [60, 120] },
  ogre:              { name: 'Ogre',              glyph: '👹', hp: 34, ac: 16, toHit: 8, dmgDie: 10, dmgBonus: 6, fort: 7, reflex: 2, gold: [50, 110] },
  ettin:             { name: 'Ettin',             glyph: '👹', hp: 48, ac: 16, toHit: 9, dmgDie: 10, dmgBonus: 7, fort: 8, reflex: 2, gold: [80, 160] },
};
const BANDS = {
  shallow: ['dire_rat', 'giant_centipede', 'goblin', 'kobold', 'skeleton', 'giant_spider'],
  mid:     ['skeleton', 'giant_spider', 'zombie', 'ghoul', 'cultist', 'gray_ooze', 'skeletal_champion'],
  deep:    ['ghoul', 'cultist', 'shadow', 'wight', 'ghast', 'gibbering_mouther', 'ogre', 'ettin'],
};
function bandFor(depth) { return depth <= 3 ? 'shallow' : depth <= 7 ? 'mid' : 'deep'; }
function rint(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

let _uidSeq = 0;

class Dungeon {
  constructor({ leaderId, tableId, io, onExit }) {
    this.id = leaderId;          // one run per leader (Phase 1)
    this.leaderId = leaderId;
    this.tableId = tableId;
    this.io = io;
    this._onExit = onExit;       // callback(dungeon) when the run ends
    this.depth = 0;
    this.round = 0;
    this.runGold = 0;
    this.pendingLoot = [];       // [{ slot, tier }]
    this.enemies = [];
    this.turnOrder = [];
    this.turnIdx = 0;
    this.status = 'exploring';   // exploring | combat | victory | dead | bailed
    this.log = [];
    this._logSeq = 0;
    this._turnTimer = null;
    this._stepTimer = null;

    const p = db.getPlayer(leaderId) || { player_id: leaderId, nickname: leaderId };
    const gear = db.getGear(leaderId);
    const maxHp = BASE_HP + HP_PER_BONUS * ((Number(gear.ring) || 0) + (Number(gear.cloak) || 0));
    this.party = [{
      playerId: leaderId,
      nickname: p.nickname || leaderId,
      avatarId: p.avatar_id || null,
      isBot: false,
      isLeader: true,
      gear,
      hp: maxHp,
      maxHp,
      sickened: 0,
      cooldown: { lightning: 0, stinking: 0 },   // round number when next available
    }];
    this._note(`🗡️ ${this.party[0].nickname} descends into the dungeon. (${maxHp} HP)`);
  }

  roomName() { return `dungeon:${this.id}`; }
  _note(text, sound) { this.log.push({ t: ++this._logSeq, text, sound: sound || null }); if (this.log.length > 60) this.log.shift(); }
  leader() { return this.party[0]; }
  livingParty() { return this.party.filter(m => m.hp > 0); }
  livingEnemies() { return this.enemies.filter(e => e.hp > 0); }

  // ── Broadcasting ──────────────────────────────────────────────────────────
  publicState() {
    return {
      id: this.id,
      leaderId: this.leaderId,
      depth: this.depth,
      round: this.round,
      status: this.status,
      runGold: this.runGold,
      party: this.party.map(m => ({
        playerId: m.playerId, nickname: m.nickname, avatarId: m.avatarId,
        isBot: m.isBot, isLeader: m.isLeader, hp: Math.max(0, m.hp), maxHp: m.maxHp,
        sickened: m.sickened > 0,
        lightningReady: this.round >= m.cooldown.lightning,
        stinkingReady: this.round >= m.cooldown.stinking,
      })),
      enemies: this.enemies.map(e => ({
        uid: e.uid, name: e.name, glyph: e.glyph, boss: !!e.boss,
        hp: Math.max(0, e.hp), maxHp: e.maxHp, alive: e.hp > 0, sickened: e.sickened > 0,
      })),
      turn: this._currentTurn(),       // { kind:'party'|'enemy', id }
      pendingLoot: this.pendingLoot.map((l, i) => ({
        idx: i, slot: l.slot, tier: l.tier,
        label: (db.GEAR_BY_KEY[l.slot]?.label || l.slot),
        hockValue: db.gearHockValue(l.slot, l.tier),
      })),
      log: this.log.slice(-30),
    };
  }
  _broadcast() {
    if (this.io) this.io.to(this.roomName()).emit('dungeon:state', this.publicState());
  }
  // Echo a combat sound to the poker table so seated players hear muffled
  // thumps from the basement.
  _echoToTable(sound) {
    if (sound && this.io && this.tableId) this.io.to(`table:${this.tableId}`).emit('dungeon:echo', { sound });
  }

  // ── Turn order helpers ──────────────────────────────────────────────────
  _currentTurn() {
    if (this.status !== 'combat') return null;
    const ent = this.turnOrder[this.turnIdx];
    return ent ? { kind: ent.kind, id: ent.id } : null;
  }
  _isLeaderTurn() {
    const t = this._currentTurn();
    return !!(t && t.kind === 'party' && t.id === this.leaderId);
  }

  // ── Exploration: open the next door → roll an encounter ──────────────────
  openDoor() {
    if (this.status !== 'exploring') return { ok: false, error: 'not exploring' };
    this.depth += 1;
    this._spawnRoom();
    this.status = 'combat';
    this.round = 1;
    this._rollInitiative();
    this._note(`🚪 Door creaks open — room ${this.depth}. ${this._enemySummary()}`);
    this._beginTurnCycle();
    return { ok: true };
  }

  _spawnRoom() {
    this.enemies = [];
    const boss = this.depth % BOSS_EVERY === 0;
    const band = bandFor(this.depth);
    const hpScale = 1 + Math.max(0, this.depth - 1) * 0.06;
    const acBump = Math.floor(this.depth / 4);
    const goldScale = 1 + this.depth * 0.05;
    const count = boss ? 1 : rint(this.depth <= 3 ? 1 : 2, this.depth <= 3 ? 3 : 4);
    for (let i = 0; i < count; i++) {
      const key = pick(BANDS[band]);
      const base = MON[key];
      const hp = Math.max(3, Math.round(base.hp * hpScale * (boss ? 1.8 : 1)));
      const goldLo = Math.round(base.gold[0] * goldScale * (boss ? 3 : 1));
      const goldHi = Math.round(base.gold[1] * goldScale * (boss ? 3 : 1));
      this.enemies.push({
        uid: `e${++_uidSeq}`,
        name: boss ? `Boss: ${base.name}` : base.name,
        glyph: boss ? '👑' : base.glyph,
        boss,
        hp, maxHp: hp,
        ac: base.ac + acBump + (boss ? 2 : 0),
        toHit: base.toHit + (boss ? 2 : 0),
        dmgDie: base.dmgDie, dmgBonus: base.dmgBonus + (boss ? 2 : 0),
        fort: base.fort, reflex: base.reflex,
        sickened: 0,
        gold: rint(goldLo, goldHi),
      });
    }
  }
  _enemySummary() {
    const counts = {};
    for (const e of this.enemies) counts[e.name] = (counts[e.name] || 0) + 1;
    return Object.entries(counts).map(([n, c]) => (c > 1 ? `${c}× ${n}` : n)).join(', ') + '.';
  }

  _rollInitiative() {
    const order = [];
    for (const m of this.party) if (m.hp > 0) order.push({ kind: 'party', id: m.playerId, init: dRoll(20) + 2 });
    for (const e of this.enemies) order.push({ kind: 'enemy', id: e.uid, init: dRoll(20) + 1 });
    order.sort((a, b) => b.init - a.init);
    this.turnOrder = order;
    this.turnIdx = 0;
  }

  // ── Turn loop: auto-resolve enemy turns; pause for the player ────────────
  _beginTurnCycle() {
    clearTimeout(this._stepTimer);
    this._advanceToActor();
  }
  _advanceToActor() {
    if (this._endIfResolved()) return;
    const t = this._currentTurn();
    if (!t) return;
    // Skip dead actors.
    if (t.kind === 'enemy') {
      const e = this.enemies.find(x => x.uid === t.id);
      if (!e || e.hp <= 0) return this._nextTurn();
      this._tickSickened(e);
      this._stepTimer = setTimeout(() => { this._enemyAct(e); this._nextTurn(); }, ENEMY_STEP_MS);
      this._broadcast();
      return;
    }
    // party member
    const m = this.party.find(x => x.playerId === t.id);
    if (!m || m.hp <= 0) return this._nextTurn();
    this._tickSickened(m);
    if (m.isLeader) {
      // Human leader — wait for input; arm the AFK auto-bail.
      this._armTurnTimer();
      this._broadcast();
    } else {
      // (Phase 2) AI ally auto-acts. For MVP there are no allies.
      this._stepTimer = setTimeout(() => { this._allyAct(m); this._nextTurn(); }, ENEMY_STEP_MS);
      this._broadcast();
    }
  }
  _nextTurn() {
    if (this._endIfResolved()) return;
    this.turnIdx += 1;
    if (this.turnIdx >= this.turnOrder.length) {
      this.turnIdx = 0;
      this.round += 1;
    }
    this._advanceToActor();
  }
  _tickSickened(actor) { if (actor.sickened > 0) actor.sickened -= 1; }

  _armTurnTimer() {
    clearTimeout(this._turnTimer);
    this._turnTimer = setTimeout(() => {
      this._note('💤 Idle too long — auto-bailing with your gold.');
      this.bail();
    }, TURN_TIMER_MS);
  }

  // ── End-of-combat / run checks ───────────────────────────────────────────
  _endIfResolved() {
    if (this.status !== 'combat') return true;
    if (this.leader().hp <= 0) { this._die(); return true; }
    if (this.livingEnemies().length === 0) { this._clearRoom(); return true; }
    return false;
  }
  _clearRoom() {
    clearTimeout(this._turnTimer); clearTimeout(this._stepTimer);
    this.status = 'exploring';
    const gold = this.enemies.reduce((s, e) => s + (e.gold || 0), 0);
    this.runGold += gold;
    this._note(`✨ Room cleared! +${gold} gp (run total ${this.runGold} gp).`);
    this._maybeDropLoot();
    this._broadcast();
  }
  _maybeDropLoot() {
    const chance = Math.min(0.25, 0.06 + this.depth * 0.015);
    if (Math.random() >= chance) return;
    // Improve a random slot the leader can still upgrade (tier < 5).
    const gear = this.leader().gear;
    const options = db.GEAR_SLOT_KEYS.filter(k => (Number(gear[k]) || 0) < 5);
    if (!options.length) return;
    const slot = pick(options);
    const tier = (Number(gear[slot]) || 0) + 1;
    this.pendingLoot.push({ slot, tier });
    this._note(`💎 Found a +${tier} ${db.GEAR_BY_KEY[slot]?.label || slot}! Equip it or hock it.`);
  }

  // ── Combat resolution ────────────────────────────────────────────────────
  _swingVsAC(attacker, ac) {
    const weapon = attacker.weapon;
    const sick = attacker.sickened > 0 ? SICKENED_PENALTY : 0;
    const roll = dRoll(20);
    const total = roll + weapon.toHit - sick;
    if (roll === 1) return { hit: false, fumble: true, roll, sound: SND.fumble };
    const hit = roll === 20 || total >= ac;
    if (!hit) return { hit: false, roll, sound: weapon.isDagger ? SND.whiffDagger : pick(SND.whiffSword) };
    let dmg = dRoll(weapon.dmgDie) + weapon.dmgBonus - sick;
    let crit = false;
    if (roll >= weapon.critRange) {
      const conf = dRoll(20) + weapon.toHit;
      if (conf === 20 || conf >= ac) { crit = true; dmg += dRoll(weapon.dmgDie) + weapon.dmgBonus; }
    }
    return { hit: true, crit, damage: Math.max(1, dmg), roll, sound: pick(SND.flesh) };
  }
  // Generic d20 attack used by monsters (no gear object).
  _monsterSwing(e, targetAC) {
    const sick = e.sickened > 0 ? SICKENED_PENALTY : 0;
    const roll = dRoll(20);
    const total = roll + e.toHit - sick;
    if (roll === 1) return { hit: false, sound: SND.fumble };
    const hit = roll === 20 || total >= targetAC;
    if (!hit) return { hit: false, sound: pick(SND.whiffSword) };
    let dmg = dRoll(e.dmgDie) + e.dmgBonus - sick;
    return { hit: true, damage: Math.max(1, dmg), sound: pick(SND.flesh) };
  }

  _enemyAct(e) {
    const targets = this.livingParty();
    if (!targets.length) return;
    const target = pick(targets);
    const ac = acOf(target.gear).ac;
    const r = this._monsterSwing(e, ac);
    if (r.hit) {
      target.hp -= r.damage;
      this._note(`${e.glyph} ${e.name} hits ${target.nickname} for ${r.damage}. (${Math.max(0, target.hp)}/${target.maxHp} HP)`, r.sound);
    } else {
      this._note(`${e.glyph} ${e.name} misses ${target.nickname}.`, r.sound);
    }
    this._echoToTable(r.sound);
  }
  _allyAct(m) {  // Phase 2 — simple auto-attack
    const foes = this.livingEnemies();
    if (!foes.length) return;
    const target = foes[0];
    this._playerAttack(m, target.uid, true);
  }

  // ── Player actions (from dungeon:action) ─────────────────────────────────
  action(playerId, kind, payload = {}) {
    if (playerId !== this.leaderId) return { ok: false, error: 'not your run' };
    if (this.status === 'exploring') {
      if (kind === 'door') return this.openDoor();
      if (kind === 'bail') return this.bail();
      let r;
      if (kind === 'equip') r = this.equipLoot(payload.idx);
      else if (kind === 'hock') r = this.hockLoot(payload.idx);
      else return { ok: false, error: 'invalid while exploring' };
      this._broadcast();
      return r;
    }
    if (this.status !== 'combat') return { ok: false, error: 'run is over' };
    if (!this._isLeaderTurn()) return { ok: false, error: 'not your turn' };
    clearTimeout(this._turnTimer);
    const m = this.leader();
    let handled = true;
    if (kind === 'attack')        this._playerAttack(m, payload.targetUid);
    else if (kind === 'lightning') this._castLightning(m, payload.targetUids || []);
    else if (kind === 'stinking')  this._castStinking(m);
    else if (kind === 'bail')      { return this.bail(); }
    else if (kind === 'equip')     { this.equipLoot(payload.idx); this._armTurnTimer(); this._broadcast(); return { ok: true }; }
    else if (kind === 'hock')      { this.hockLoot(payload.idx); this._armTurnTimer(); this._broadcast(); return { ok: true }; }
    else handled = false;
    if (!handled) { this._armTurnTimer(); return { ok: false, error: 'unknown action' }; }
    this._nextTurn();
    return { ok: true };
  }

  _playerAttack(m, targetUid, silentTurn) {
    const e = this.enemies.find(x => x.uid === targetUid && x.hp > 0) || this.livingEnemies()[0];
    if (!e) return;
    m.weapon = weaponOf(m.gear);
    const r = this._swingVsAC(m, e.ac);
    if (r.fumble) { this._note(`${m.nickname} fumbles the attack!`, r.sound); }
    else if (r.hit) {
      e.hp -= r.damage;
      this._note(`${m.nickname} ${r.crit ? 'CRITS' : 'hits'} ${e.name} for ${r.damage}.${e.hp <= 0 ? ' ☠️ Slain!' : ` (${Math.max(0, e.hp)}/${e.maxHp})`}`, r.sound);
    } else {
      this._note(`${m.nickname} misses ${e.name}.`, r.sound);
    }
    this._echoToTable(r.sound);
  }
  _castLightning(m, targetUids) {
    if (this.round < m.cooldown.lightning) return;
    m.cooldown.lightning = this.round + SPELL_COOLDOWN;
    const power = Math.max(2, totalMagicBonus(m.gear));
    const dc = 10 + power;
    let chosen = (targetUids || []).map(u => this.enemies.find(e => e.uid === u && e.hp > 0)).filter(Boolean);
    if (!chosen.length) chosen = this.livingEnemies().slice(0, LIGHTNING_MAX_TARGETS);
    chosen = chosen.slice(0, LIGHTNING_MAX_TARGETS);
    const sound = pick(SND.lightning);
    let parts = [];
    for (const e of chosen) {
      let full = 0; for (let i = 0; i < power; i++) full += dRoll(6);
      const saved = (dRoll(20) + e.reflex) >= dc;
      const dmg = saved ? Math.floor(full / 2) : full;
      e.hp -= dmg;
      parts.push(`${e.name} ${dmg}${saved ? ' (save)' : ''}${e.hp <= 0 ? ' ☠️' : ''}`);
    }
    this._note(`⚡ ${m.nickname} looses a Lightning Bolt — ${parts.join(', ')}.`, sound);
    this._echoToTable(sound);
  }
  _castStinking(m) {
    if (this.round < m.cooldown.stinking) return;
    m.cooldown.stinking = this.round + SPELL_COOLDOWN;
    const power = Math.max(2, totalMagicBonus(m.gear));
    const dc = 10 + power;
    const sound = pick(SND.stink);
    let hit = 0;
    for (const e of this.livingEnemies()) {
      const saved = (dRoll(20) + e.fort) >= dc;
      if (!saved) { e.sickened = SICKENED_ROUNDS; hit++; }
    }
    this._note(`💨 ${m.nickname} conjures a Stinking Cloud — ${hit} sickened.`, sound);
    this._echoToTable(sound);
  }

  // ── Loot management ──────────────────────────────────────────────────────
  equipLoot(idx) {
    const loot = this.pendingLoot[idx];
    if (!loot) return { ok: false, error: 'no such loot' };
    const gear = db.getGear(this.leaderId);
    if ((Number(gear[loot.slot]) || 0) >= loot.tier) { this.pendingLoot.splice(idx, 1); return { ok: false, error: 'already better' }; }
    gear[loot.slot] = loot.tier;
    db.setGear(this.leaderId, gear);
    this.leader().gear = gear;
    // Ring / cloak raise max HP mid-run; grant the new headroom + heal it.
    if (loot.slot === 'ring' || loot.slot === 'cloak') {
      const m = this.leader();
      m.maxHp += HP_PER_BONUS; m.hp += HP_PER_BONUS;
    }
    this.pendingLoot.splice(idx, 1);
    this._note(`🛡️ Equipped the +${loot.tier} ${db.GEAR_BY_KEY[loot.slot]?.label || loot.slot}.`);
    return { ok: true };
  }
  hockLoot(idx) {
    const loot = this.pendingLoot[idx];
    if (!loot) return { ok: false, error: 'no such loot' };
    const v = db.gearHockValue(loot.slot, loot.tier);
    this.runGold += v;
    this.pendingLoot.splice(idx, 1);
    this._note(`💰 Hocked the +${loot.tier} ${db.GEAR_BY_KEY[loot.slot]?.label || loot.slot} for ${v} gp.`);
    return { ok: true };
  }

  // ── Run end ──────────────────────────────────────────────────────────────
  bail() {
    if (this.status === 'dead' || this.status === 'bailed') return { ok: false, error: 'run over' };
    clearTimeout(this._turnTimer); clearTimeout(this._stepTimer);
    this.status = 'bailed';
    // Even split across the party (solo = all to leader). Phase 2 pays allies.
    const share = Math.floor(this.runGold / this.party.length);
    for (const m of this.party) {
      const p = db.getPlayer(m.playerId);
      if (p) db.setChips(m.playerId, p.chips + share);
    }
    this._note(`🪜 Climbed out with ${this.runGold} gp${this.party.length > 1 ? ` (split ${share} each)` : ''}.`);
    this._finish({ reason: 'bailed', goldBanked: this.runGold });
    return { ok: true, goldBanked: this.runGold };
  }
  _die() {
    clearTimeout(this._turnTimer); clearTimeout(this._stepTimer);
    this.status = 'dead';
    this._note(`☠️ ${this.leader().nickname} falls! The run's gold and unbanked loot are lost.`);
    this.runGold = 0;
    this.pendingLoot = [];
    this._finish({ reason: 'dead', goldBanked: 0 });
  }
  _finish(exit) {
    this.exit = exit;
    this._broadcast();
    if (this.io) this.io.to(this.roomName()).emit('dungeon:exit', exit);
    if (this._onExit) try { this._onExit(this); } catch (_) {}
  }
  destroy() { clearTimeout(this._turnTimer); clearTimeout(this._stepTimer); }
}

module.exports = { Dungeon };
