/**
 * "Hit the Dungeon" — a push-your-luck co-op side-game.
 *
 * Players leave their poker seat and descend into the basement beneath the poker
 * hall to fight PF1e-flavored monsters, hauling gold back up to the felt. ONE
 * shared run per table — players can dungeon TOGETHER as a party. The poker table
 * keeps playing without them. This NEVER affects poker mechanics except to ADD
 * gold to a player's stack on a successful bail (gold = chips = gp, 1:1).
 *
 * Everyone (human or bot) takes one turn per round in initiative order. A human
 * who idles on their turn auto-PASSES after 10s (the party plays on). Each member
 * bails individually for an even share of the current pool; a downed member is
 * out with nothing. The run ends when no one's left fighting.
 *
 * See docs/DUNGEON_DESIGN.md.
 */

const db = require('../persistence/db');
const { weaponOf, acOf, totalMagicBonus, SND, dRoll, pick } = require('./combat');
const { logDungeon } = require('../persistence/logger');
const banter = require('../bot/banter');

// ── Tuning knobs ────────────────────────────────────────────────────────────
// LEVEL = 1 + sum of all gear bonuses (min 1). Level drives HP (10/level),
// to-hit, and saves — for humans AND AI allies.
const HP_PER_LEVEL   = 10;
function levelOf(gear) { return Math.max(1, 1 + totalMagicBonus(gear)); }
const LIGHTNING_MAX_TARGETS = 2;
const SICKENED_ROUNDS = 3;
const SICKENED_PENALTY = 2;
const PARALYZE_DC = 14;
const AFK_PASS_MS    = 10_000; // idle on your turn → auto-pass after 10s
const ENEMY_STEP_MS  = 750;    // pacing between auto-resolved enemy/ally turns
const BOSS_EVERY     = 5;
const LOOT_ROLL_MS   = 20_000; // window to roll/pass on a dropped magic item

// ── Monster bestiary (placeholder art = emoji glyphs) ───────────────────────
// PF1e stat blocks (CR in comment). NO depth scaling — difficulty comes from
// which creatures a depth's BAND can spawn and from designated bosses, not from
// buffing mooks. Our combat model uses one representative attack:
//   damage = dmgCount × d(dmgDie) + dmgBonus   (dmgCount defaults to 1)
//   attacks = number of separate swings per turn (default 1)
const MON = {
  dire_rat:          { name: 'Dire Rat',          glyph: '🐀', cr: '1/3', hp: 5,   ac: 14, toHit: 1,  dmgDie: 4,  dmgBonus: 0, fort: 3,  reflex: 3,  gold: [3, 10] },
  giant_centipede:   { name: 'Giant Centipede',   glyph: '🐛', cr: '1/2', hp: 5,   ac: 14, toHit: 2,  dmgDie: 6,  dmgBonus: 0, fort: 1,  reflex: 3,  gold: [3, 10] },
  goblin:            { name: 'Goblin',            glyph: '👺', cr: '1/3', hp: 6,   ac: 16, toHit: 2,  dmgDie: 4,  dmgBonus: 0, fort: 3,  reflex: 2,  gold: [6, 16] },
  kobold:            { name: 'Kobold',            glyph: '🦎', cr: '1/4', hp: 5,   ac: 15, toHit: 1,  dmgDie: 6,  dmgBonus: 0, fort: 2,  reflex: 1,  gold: [6, 14] },
  kobold_spearman:   { name: 'Kobold Spearman',   glyph: '🦎', cr: '1/3', hp: 6,   ac: 15, toHit: 2,  dmgDie: 6,  dmgBonus: 0, fort: 2,  reflex: 1,  gold: [6, 16] },                                            // 1d6 spear
  kobold_shaman:     { name: 'Kobold Shaman',     glyph: '🦎', cr: '1',   hp: 7,   ac: 13, toHit: 0,  dmgDie: 4,  dmgBonus: 0, fort: 2,  reflex: 1,  gold: [12, 26], caster: 'holdperson', spellDC: 13 },          // Hold Person (Will DC 13)
  kobold_rogue:      { name: 'Kobold Rogue',      glyph: '🦎', cr: '1',   hp: 6,   ac: 16, toHit: 2,  dmgDie: 3,  dmgBonus: 0, fort: 1,  reflex: 4,  gold: [10, 24], attacks: 2, atkSound: '/audio/fight_riki.mp3' }, // two 1d3 daggers
  skeleton:          { name: 'Skeleton',          glyph: '💀', cr: '1/3', hp: 5,   ac: 16, toHit: 2,  dmgDie: 6,  dmgBonus: 2, fort: 0,  reflex: 1,  gold: [8, 20] },
  giant_spider:      { name: 'Giant Spider',      glyph: '🕷️', cr: '1',   hp: 16,  ac: 14, toHit: 4,  dmgDie: 6,  dmgBonus: 0, fort: 4,  reflex: 4,  gold: [10, 26] },
  zombie:            { name: 'Zombie',            glyph: '🧟', cr: '1/2', hp: 12,  ac: 12, toHit: 4,  dmgDie: 6,  dmgBonus: 4, fort: 0,  reflex: 0,  gold: [10, 26] },
  ghoul:             { name: 'Ghoul',             glyph: '🧛', cr: '1',   hp: 13,  ac: 14, toHit: 3,  dmgDie: 6,  dmgBonus: 1, fort: 1,  reflex: 3,  gold: [14, 32], paralyze: true, paralyzeDC: 13 },
  cultist:           { name: 'Whispering Cultist',glyph: '🕯️', cr: '1',   hp: 14,  ac: 14, toHit: 3,  dmgDie: 8,  dmgBonus: 1, fort: 3,  reflex: 1,  gold: [16, 38] },
  ghast:             { name: 'Ghast',             glyph: '🧟‍♂️', cr: '2', hp: 17,  ac: 17, toHit: 6,  dmgDie: 8,  dmgBonus: 3, fort: 2,  reflex: 5,  gold: [28, 60], paralyze: true, paralyzeDC: 15 },
  skeletal_champion: { name: 'Skeletal Champion', glyph: '☠️', cr: '2',   hp: 19,  ac: 17, toHit: 5,  dmgDie: 8,  dmgBonus: 3, fort: 3,  reflex: 2,  gold: [26, 55] },
  shadow:            { name: 'Shadow',            glyph: '🌑', cr: '3',   hp: 19,  ac: 13, toHit: 4,  dmgDie: 6,  dmgBonus: 0, fort: 1,  reflex: 3,  gold: [30, 65] },
  wight:             { name: 'Wight',             glyph: '👻', cr: '3',   hp: 26,  ac: 15, toHit: 4,  dmgDie: 4,  dmgBonus: 1, fort: 3,  reflex: 1,  gold: [34, 72] },
  ogre:              { name: 'Ogre',              glyph: '👹', cr: '3',   hp: 30,  ac: 17, toHit: 8,  dmgDie: 8,  dmgCount: 2, dmgBonus: 7, fort: 6, reflex: 0, gold: [40, 90] },                                  // greatclub 2d8+7
  gray_ooze:         { name: 'Gray Ooze',         glyph: '🟢', cr: '4',   hp: 50,  ac: 6,  toHit: 5,  dmgDie: 6,  dmgBonus: 4, fort: 6,  reflex: 0,  gold: [38, 80] },
  gibbering_mouther: { name: 'Gibbering Mouther', glyph: '👄', cr: '5',   hp: 60,  ac: 19, toHit: 5,  dmgDie: 4,  dmgBonus: 0, fort: 8,  reflex: 6,  gold: [55, 120], attacks: 2 },                              // many small bites
  ettin:             { name: 'Ettin',             glyph: '👹', cr: '6',   hp: 65,  ac: 18, toHit: 12, dmgDie: 6,  dmgCount: 2, dmgBonus: 6, fort: 9, reflex: 3, attacks: 2, gold: [70, 150] },                    // two morningstars
  brass_golem:       { name: 'Brass Golem',       glyph: '🗿', cr: '9',   hp: 92,  ac: 24, toHit: 14, dmgDie: 10, dmgCount: 2, dmgBonus: 9, fort: 3, reflex: 3, attacks: 2, gold: [180, 320] },                  // 8-HD construct, two 2d10+9 slams
  barbed_devil:      { name: 'Barbed Devil',      glyph: '😈', cr: '11',  hp: 138, ac: 26, toHit: 18, dmgDie: 8,  dmgCount: 2, dmgBonus: 7, fort: 12, reflex: 9, attacks: 2, gold: [260, 460] },                 // hamatula, two 2d8+7 claws
};
// Real token art from the Foundry library (public/dungeon/monsters/). dire_rat
// has no token in the library, so it falls back to its emoji glyph.
const MON_ART = {
  dire_rat: 'dire_rat',
  kobold_spearman: 'kobold_spearman', kobold_shaman: 'kobold_shaman', kobold_rogue: 'kobold_rogue',
  giant_centipede: 'centipede', goblin: 'goblin', kobold: 'kobold', skeleton: 'skeleton',
  giant_spider: 'spider', zombie: 'zombie', ghoul: 'ghoul', cultist: 'cultist',
  gray_ooze: 'ooze', skeletal_champion: 'skeletal_champion', shadow: 'shadow', wight: 'wight',
  ghast: 'ghast', gibbering_mouther: 'gibbering_mouther', ogre: 'ogre', ettin: 'ettin',
  brass_golem: 'brass_golem', barbed_devil: 'barbed_devil',
};
for (const [k, name] of Object.entries(MON_ART)) if (MON[k]) MON[k].art = `/dungeon/monsters/${name}.webp`;

// ── Difficulty curve: Pathfinder CR creeps ~0.25 per room ───────────────────
// Parse a CR string ("1/4", "3") to a number, and tag every monster with it.
function crToNum(cr) {
  if (typeof cr === 'number') return cr;
  if (!cr) return 0;
  if (String(cr).includes('/')) { const [a, b] = String(cr).split('/').map(Number); return b ? a / b : a; }
  return Number(cr) || 0;
}
const BOSS_KEYS = new Set(['brass_golem', 'barbed_devil']);   // boss-only, never regular spawns
for (const k of Object.keys(MON)) MON[k].crNum = crToNum(MON[k].cr);
const SPAWNABLE = Object.keys(MON).filter(k => !BOSS_KEYS.has(k));

// Target CR for a regular room rises ~0.25/room: room 1 ≈ CR 0.25, room 4 ≈ CR 1,
// room 8 ≈ CR 2, room 12 ≈ CR 3, room 20 ≈ CR 5. We pick a creature at-or-just-
// below the target (small window) for a gentle, varied creep.
function targetCR(depth) { return 0.25 * depth; }
function pickByCR(depth) {
  const target = targetCR(depth);
  let cand = SPAWNABLE.filter(k => MON[k].crNum >= target - 0.75 && MON[k].crNum <= target + 0.25);
  if (!cand.length) cand = [SPAWNABLE.reduce((best, k) =>
    Math.abs(MON[k].crNum - target) < Math.abs(MON[best].crNum - target) ? k : best, SPAWNABLE[0])];
  return pick(cand);
}
// Designated bosses by depth — real high-CR PF1e creatures, used as-is (no buff).
function bossKeyFor(depth) {
  if (depth >= 8 && depth <= 12) return 'brass_golem';   // golden (brass) golem, CR 9
  if (depth >= 13)               return 'barbed_devil';  // hamatula, CR 11
  return depth >= 4 ? 'ogre' : 'skeletal_champion';      // early milestone bosses (rooms 5)
}
function rint(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

let _uidSeq = 0;

class Dungeon {
  constructor({ tableId, io, onMemberExit, onEmpty }) {
    this.id = tableId;           // one shared run per table
    this.tableId = tableId;
    this.io = io;
    this._onMemberExit = onMemberExit;   // (playerId, nickname, exit) — chat + roster
    this._onEmpty = onEmpty;             // () — run fully over, drop the instance
    this.depth = 0;
    this.round = 0;
    this.runGold = 0;
    this.pendingLoot = [];       // [{ slot, tier, owner }]
    this.lootRoll = null;        // active roll-off for a dropped item (see _startLootRoll)
    this._lootTimer = null;
    this.enemies = [];
    this.party = [];             // members (see addMember)
    this.turnOrder = [];
    this.turnIdx = 0;
    this.status = 'exploring';   // exploring | combat | over
    this.log = [];
    this._logSeq = 0;
    this._turnTimer = null;
    this._stepTimer = null;
    this._bantRound = -1;        // last combat round an AI ally reacted (1 per round)
  }

  // ── AI ally trash-talk ────────────────────────────────────────────────────
  // At most ONE AI reaction per combat round (a chance each round); loot
  // reactions (between rooms) get their own occasional chance.
  _tryBanter(member, eventType, ctx) {
    if (!member || !member.isBot) return;
    if (!banter.CHARACTER_FLAVOR[member.trueNick || member.nickname]) return;
    if (this.status === 'combat') {
      if (this.round === this._bantRound) return;   // round already used its one chance
      this._bantRound = this.round;
      if (Math.random() > 0.45) return;
    } else if (Math.random() > 0.5) return;
    this._emitBanter(member, eventType, ctx);
  }
  _emitBanter(member, eventType, ctx) {
    const flavorNick = member.trueNick || member.nickname;   // Vorkstag keeps his own creepy voice…
    const label = member.nickname;                           // …but is shown + voiced as whoever he wears
    Promise.resolve(banter.dungeonLine(flavorNick, eventType, { ...ctx, voiceNick: label })).then(res => {
      if (!res || !res.line) return;
      this._note(`💬 ${label}: ${res.line}`);
      if (this.io && res.audio) this.io.to(this.roomName()).emit('dungeon:say', { nick: label, audio: res.audio, audioMime: res.audioMime });
      this._broadcast();
    }).catch(() => {});
  }

  roomName() { return `dungeon:${this.id}`; }
  _note(text, sound) { this.log.push({ t: ++this._logSeq, text, sound: sound || null }); if (this.log.length > 150) this.log.shift(); }
  _log(type, extra) {
    try { logDungeon({ type, run: this.id, depth: this.depth, round: this.round, ...(extra || {}) }); } catch (_) {}
  }

  // ── Party membership ──────────────────────────────────────────────────────
  member(playerId) { return this.party.find(m => m.playerId === playerId); }
  present() { return this.party.filter(m => !m.left); }                 // still in the run (alive or downed-this-tick)
  alivePresent() { return this.party.filter(m => !m.left && m.hp > 0); }
  livingParty() { return this.alivePresent(); }
  livingEnemies() { return this.enemies.filter(e => e.hp > 0); }

  hasMember(playerId) { const m = this.member(playerId); return !!(m && !m.left && m.hp > 0); }
  botCount() { return this.party.filter(m => m.isBot && !m.left && m.hp > 0).length; }

  addMember(player, isBot = false) {
    const playerId = player.player_id;
    const idx = this.party.findIndex(m => m.playerId === playerId);
    if (idx >= 0 && !this.party[idx].left && this.party[idx].hp > 0) return this.party[idx];  // already active
    if (idx >= 0) this.party.splice(idx, 1);   // drop a stale (downed/bailed) entry → rejoin fresh
    const gear = db.getGear(playerId);
    const level = levelOf(gear);
    const maxHp = HP_PER_LEVEL * level;
    const m = {
      playerId,
      nickname: player.nickname || playerId,
      avatarId: player.avatar_id || null,
      isBot: !!isBot,
      gear, level,
      hp: maxHp, maxHp,
      sickened: 0, paralyzed: 0,
      usedLightning: false, usedStinking: false,
      left: false, dead: false,
    };
    // Vorkstag the skinwalker wears a partymate's face + name (true identity
    // hidden) — same as his poker-seat disguise. He keeps his own creepy
    // personality but is shown/voiced as whoever he's impersonating.
    if (playerId === 'vorkstag') {
      const victims = this.party.filter(x => !x.left && x.hp > 0);
      if (victims.length) { const v = pick(victims); m.trueNick = m.nickname; m.nickname = v.nickname; m.avatarId = v.avatarId; }
    }
    this.party.push(m);
    this._note(`🚪 ${m.nickname} joins the delve. (Lv ${level} · ${maxHp} HP)`);
    this._log('join', { who: playerId, level, maxHp, party: this.present().length });
    // Mid-combat join → add to the current turn order so they act this round.
    if (this.status === 'combat') this.turnOrder.push({ kind: 'party', id: playerId, init: dRoll(20) + 2 + Math.floor((m.level || 1) / 2) });
    this._broadcast();
    return m;
  }

  // ── Broadcasting ──────────────────────────────────────────────────────────
  publicState() {
    return {
      id: this.id,
      depth: this.depth,
      round: this.round,
      status: this.status,
      runGold: this.runGold,
      party: this.party.map(m => ({
        playerId: m.playerId, nickname: m.nickname, avatarId: m.avatarId, isBot: m.isBot,
        level: m.level, hp: Math.max(0, m.hp), maxHp: m.maxHp,
        dead: m.hp <= 0, left: !!m.left,
        sickened: m.sickened > 0, paralyzed: m.paralyzed > 0,
        lightningReady: !m.usedLightning, stinkingReady: !m.usedStinking,
      })),
      enemies: this.enemies.map(e => ({
        uid: e.uid, name: e.name, glyph: e.glyph, art: e.art || null, boss: !!e.boss, cr: e.cr || null,
        hp: Math.max(0, e.hp), maxHp: e.maxHp, alive: e.hp > 0, sickened: e.sickened > 0,
      })),
      turn: this._currentTurn(),
      botCount: this.botCount(),
      recruitable: this._recruitableFn ? this._recruitableFn() : [],   // unseated bots, set by the socket layer
      lootRoll: this.lootRoll ? {
        slot: this.lootRoll.slot, tier: this.lootRoll.tier,
        label: db.GEAR_BY_KEY[this.lootRoll.slot]?.label || this.lootRoll.slot,
        hockValue: db.gearHockValue(this.lootRoll.slot, this.lootRoll.tier),
        decided: this.lootRoll.decided,
        pending: this.lootRoll.eligible.filter(id => !(id in this.lootRoll.decided)),
        eligible: this.lootRoll.eligible,
      } : null,
      pendingLoot: this.pendingLoot.map((l, i) => ({
        idx: i, slot: l.slot, tier: l.tier, owner: l.owner,
        label: (db.GEAR_BY_KEY[l.slot]?.label || l.slot),
        hockValue: db.gearHockValue(l.slot, l.tier),
      })),
      log: this.log.slice(-60),
    };
  }
  _broadcast() { if (this.io) this.io.to(this.roomName()).emit('dungeon:state', this.publicState()); }
  _echoToTable(sound) {
    if (sound && this.io && this.tableId) this.io.to(`table:${this.tableId}`).emit('dungeon:echo', { sound });
  }

  // ── Turn helpers ──────────────────────────────────────────────────────────
  _currentTurn() {
    if (this.status !== 'combat') return null;
    const ent = this.turnOrder[this.turnIdx];
    return ent ? { kind: ent.kind, id: ent.id } : null;
  }
  _currentActorId() { const t = this._currentTurn(); return t && t.kind === 'party' ? t.id : null; }

  // ── Exploration: open the next door → roll an encounter ──────────────────
  openDoor() {
    if (this.status !== 'exploring') return { ok: false, error: 'not exploring' };
    if (this.lootRoll) return { ok: false, error: 'finish the loot roll first' };
    this.depth += 1;
    this._spawnRoom();
    for (const m of this.present()) { m.usedLightning = false; m.usedStinking = false; }  // 1 of each per room
    this.status = 'combat';
    this.round = 1;
    this._rollInitiative();
    this._note(`🚪 Door creaks open — room ${this.depth}. ${this._enemySummary()}`);
    this._log('room', { boss: this.enemies.some(e => e.boss), party: this.present().length, enemies: this.enemies.map(e => ({ name: e.name, cr: e.cr, hp: e.maxHp, ac: e.ac, toHit: e.toHit })) });
    this._beginTurnCycle();
    return { ok: true };
  }
  _spawnRoom() {
    this.enemies = [];
    const boss = this.depth % BOSS_EVERY === 0;
    // Scale enemy COUNT up a little with party size so groups aren't trivial —
    // but each creature keeps its true PF1e stat block (no per-room buffs).
    const partyN = Math.max(1, this.alivePresent().length);
    const lo = this.depth <= 3 ? 1 : 2, hi = (this.depth <= 3 ? 3 : 4) + (partyN - 1);
    const count = boss ? 1 : rint(lo, hi);
    for (let i = 0; i < count; i++) {
      const base = MON[boss ? bossKeyFor(this.depth) : pickByCR(this.depth)];
      this.enemies.push({
        uid: `e${++_uidSeq}`,
        name: boss ? `Boss: ${base.name}` : base.name,
        glyph: base.glyph, art: base.art || null, boss, cr: base.cr || null,
        hp: base.hp, maxHp: base.hp,
        ac: base.ac, toHit: base.toHit,
        dmgDie: base.dmgDie, dmgCount: base.dmgCount || 1, dmgBonus: base.dmgBonus,
        fort: base.fort, reflex: base.reflex,
        paralyze: !!base.paralyze, paralyzeDC: base.paralyzeDC || PARALYZE_DC, sickened: 0,
        attacks: base.attacks || 1,            // separate swings per turn (rogue/ogre/golem…)
        atkSound: base.atkSound || null,        // signature hit sound (rogue: riki)
        caster: base.caster || null,            // kobold shaman: 'holdperson'
        spellDC: base.spellDC || 13,
        castsLeft: base.caster ? 2 : 0,
        gold: rint(base.gold[0], base.gold[1]),
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
    // Characters add ½ their level (rounded down) to initiative, on top of the base +2.
    for (const m of this.alivePresent()) order.push({ kind: 'party', id: m.playerId, init: dRoll(20) + 2 + Math.floor((m.level || 1) / 2) });
    for (const e of this.livingEnemies()) order.push({ kind: 'enemy', id: e.uid, init: dRoll(20) + 1 });
    order.sort((a, b) => b.init - a.init);
    this.turnOrder = order;
    this.turnIdx = 0;
  }

  // ── Turn loop ─────────────────────────────────────────────────────────────
  _beginTurnCycle() { clearTimeout(this._stepTimer); this._advanceToActor(); }
  _advanceToActor() {
    if (this._endIfResolved()) return;
    const t = this._currentTurn();
    if (!t) return;
    if (t.kind === 'enemy') {
      const e = this.enemies.find(x => x.uid === t.id);
      if (!e || e.hp <= 0) return this._nextTurn();
      if (e.sickened > 0) { e.sickened -= 1; this._note(`${e.glyph} ${e.name} retches in the cloud — loses its turn.`); this._broadcast(); return this._nextTurn(); }
      this._stepTimer = setTimeout(() => { this._enemyAct(e); this._nextTurn(); }, ENEMY_STEP_MS);
      this._broadcast();
      return;
    }
    // party member
    const m = this.member(t.id);
    if (!m || m.left || m.hp <= 0) return this._nextTurn();
    if (m.paralyzed > 0) { m.paralyzed -= 1; this._note(`🥶 ${m.nickname} is paralyzed — loses the turn.`); this._broadcast(); return this._nextTurn(); }
    if (m.sickened > 0) m.sickened -= 1;
    if (m.isBot) { this._stepTimer = setTimeout(() => { this._allyAct(m); this._nextTurn(); }, ENEMY_STEP_MS); this._broadcast(); }
    else { this._armAfkTimer(m); this._broadcast(); }   // human — wait for input
  }
  _nextTurn() {
    if (this._endIfResolved()) return;
    this.turnIdx += 1;
    // Initiative is rolled ONCE per combat (per room, in openDoor) — Pathfinder
    // keeps the same order each round; we just wrap back to the top.
    if (this.turnIdx >= this.turnOrder.length) { this.turnIdx = 0; this.round += 1; }
    this._advanceToActor();
  }
  _armAfkTimer(m) {
    clearTimeout(this._turnTimer);
    this._turnTimer = setTimeout(() => {
      this._note(`💤 ${m.nickname} is idle — passes.`);
      this._broadcast();
      this._nextTurn();
    }, AFK_PASS_MS);
  }

  // ── Resolution / run-over ────────────────────────────────────────────────
  _anyHumanFighting() { return this.party.some(m => !m.isBot && !m.left && m.hp > 0); }
  _endIfResolved() {
    if (this.status !== 'combat') return true;
    // The run belongs to the humans — once none are standing, cash out the AI
    // allies (their even share of the pool) and end.
    if (!this._anyHumanFighting()) { this._wrapUp(); return true; }
    if (this.livingEnemies().length === 0) { this._clearRoom(); return true; }
    return false;
  }
  // Pay surviving AI allies an even share of what's left, announce it, then end.
  _wrapUp() {
    if (this.status === 'over') return;
    const allies = this.party.filter(m => m.isBot && !m.left && m.hp > 0);
    const share = allies.length ? Math.floor(this.runGold / allies.length) : 0;
    for (const m of allies) {
      if (share > 0) { const p = db.getPlayer(m.playerId); if (p) db.setChips(m.playerId, p.chips + share); this.runGold -= share; }
      m.left = true;
      this._note(`🤖 ${m.nickname} returns from the dungeon with ${share} gp.`);
      this._log('ally_payout', { who: m.playerId, share });
      this._emitMemberExit(m, { reason: 'bailed', goldBanked: share, ai: true });
    }
    this._runOver();
  }
  _clearRoom() {
    clearTimeout(this._turnTimer); clearTimeout(this._stepTimer);
    this.status = 'exploring';
    const gold = this.enemies.reduce((s, e) => s + (e.gold || 0), 0);
    this.runGold += gold;
    this._note(`✨ Room cleared! +${gold} gp (pool ${this.runGold} gp).`);
    this._log('clear', { gold, runGold: this.runGold });
    this._maybeDropLoot();
    this._broadcast();
  }
  _runOver() {
    clearTimeout(this._turnTimer); clearTimeout(this._stepTimer); clearTimeout(this._lootTimer);
    this.lootRoll = null;
    this.status = 'over';
    this._broadcast();
    if (this._onEmpty) try { this._onEmpty(); } catch (_) {}
  }
  _maybeDropLoot() {
    const chance = this.depth <= 3 ? 0.015 : Math.min(0.12, 0.02 + (this.depth - 3) * 0.011);
    if (Math.random() >= chance) return;
    const eligible = this.alivePresent();
    if (!eligible.length) return;
    const tier = Math.min(5, 1 + Math.floor(this.depth / 4));   // depth-capped: +1 @1-3, +2 @4-7 …
    const slot = pick(db.GEAR_SLOT_KEYS);
    this._startLootRoll(slot, tier, eligible.map(m => m.playerId));
  }
  // Everyone present rolls 1d20 or passes; highest roll claims the item. AI
  // ALWAYS rolls (and auto-equips an upgrade, else hocks it for the pool).
  _startLootRoll(slot, tier, eligibleIds) {
    this.lootRoll = { slot, tier, eligible: eligibleIds, decided: {} };
    const label = db.GEAR_BY_KEY[slot]?.label || slot;
    this._note(`💎 A +${tier} ${label} drops! Roll a d20 for it, or pass.`);
    this._log('lootdrop', { slot, tier, eligible: eligibleIds.length });
    // Bots decide immediately (always roll).
    for (const id of eligibleIds) { const m = this.member(id); if (m && m.isBot) this._lootDecide(id, true); }
    // Idle humans auto-pass after the window.
    clearTimeout(this._lootTimer);
    this._lootTimer = setTimeout(() => {
      if (!this.lootRoll) return;
      for (const id of this.lootRoll.eligible) if (!(id in this.lootRoll.decided)) this._lootDecide(id, false, true);
    }, LOOT_ROLL_MS);
    this._broadcast();
  }
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
  }
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
  }
  _awardLoot(playerId, slot, tier) {
    const m = this.member(playerId);
    const gear = db.getGear(playerId);
    const cur = Number(gear[slot]) || 0;
    if (m && m.isBot) {
      // AI: equip if it's a real upgrade (needs it), else hock for the pool.
      if (cur < tier) {
        gear[slot] = tier; db.setGear(playerId, gear); m.gear = gear;
        this._relevel(m);   // any upgrade raises level → +10 max HP, +to-hit, +to-save
        this._note(`🛡️ ${m.nickname} equips the +${tier} ${db.GEAR_BY_KEY[slot]?.label || slot}. (Lv ${m.level})`);
      } else {
        const v = db.gearHockValue(slot, tier); this.runGold += v;
        this._note(`💰 ${m.nickname} doesn't need it — hocks it for ${v} gp (into the pool).`);
      }
      this._tryBanter(m, 'loot_win', { tier, item: db.GEAR_BY_KEY[slot]?.label || slot });
      return;
    }
    // Human: lands in their pending loot to equip or hock as they choose.
    this.pendingLoot.push({ slot, tier, owner: playerId });
  }

  // ── Combat math (rolls shown in the log) ─────────────────────────────────
  _fmtBonus(n) { return (n >= 0 ? '+' : '') + n; }
  // Recompute a member's level + HP from current gear (level = 1 + gear bonuses).
  _relevel(m) {
    const nl = levelOf(m.gear);
    const gain = HP_PER_LEVEL * nl - m.maxHp;
    m.level = nl; m.maxHp = HP_PER_LEVEL * nl;
    if (gain > 0) m.hp += gain;   // leveling up heals the new HP; never drains current HP
  }
  _partySaveMod(m) { return m.level || 1; }   // saves scale with level
  _atkStr(r) { return `[d20 ${r.roll} ${this._fmtBonus(r.toHit)} = ${r.total} vs AC ${r.ac}]`; }
  _swingVsAC(attacker, ac) {
    const weapon = attacker.weapon;
    const sick = attacker.sickened > 0 ? SICKENED_PENALTY : 0;
    const lvl = attacker.level || 1;        // to-hit scales with level, not weapon tier
    const toHit = lvl - sick;
    const roll = dRoll(20), total = roll + toHit;
    if (roll === 1) return { hit: false, fumble: true, roll, toHit, total, ac, sound: SND.fumble };
    const hit = roll === 20 || total >= ac;
    if (!hit) return { hit: false, roll, toHit, total, ac, sound: weapon.isDagger ? SND.whiffDagger : pick(SND.whiffSword) };
    let dmg = dRoll(weapon.dmgDie) + weapon.dmgBonus - sick, crit = false;
    if (roll >= weapon.critRange) { const conf = dRoll(20) + lvl; if (conf === 20 || conf >= ac) { crit = true; dmg += dRoll(weapon.dmgDie) + weapon.dmgBonus; } }
    return { hit: true, crit, damage: Math.max(1, dmg), roll, toHit, total, ac, sound: pick(SND.flesh) };
  }
  _monsterSwing(e, targetAC) {
    const sick = e.sickened > 0 ? SICKENED_PENALTY : 0;
    const toHit = e.toHit - sick;
    const roll = dRoll(20), total = roll + toHit;
    if (roll === 1) return { hit: false, roll, toHit, total, ac: targetAC, sound: SND.fumble };
    const hit = roll === 20 || total >= targetAC;
    if (!hit) return { hit: false, roll, toHit, total, ac: targetAC, sound: pick(SND.whiffSword) };
    let dmg = e.dmgBonus - sick;
    for (let i = 0; i < (e.dmgCount || 1); i++) dmg += dRoll(e.dmgDie);   // e.g. golem slam = 2d10+9
    return { hit: true, damage: Math.max(1, dmg), roll, toHit, total, ac: targetAC, sound: pick(SND.flesh) };
  }
  _enemyAct(e) {
    if (!this.livingParty().length) return;
    // Kobold shaman: cast Hold Person on an unheld target before resorting to melee.
    if (e.caster === 'holdperson' && e.castsLeft > 0) {
      const free = this.livingParty().filter(m => !(m.paralyzed > 0));
      if (free.length) return this._enemyCastHold(e, pick(free));
    }
    // Melee — the kobold rogue stabs twice (1d3 each); everyone else swings once.
    // Re-pick a living, preferably-helpless target each swing.
    for (let i = 0; i < Math.max(1, e.attacks || 1); i++) {
      const living = this.livingParty();
      if (!living.length) break;
      const helpless = living.filter(m => m.paralyzed > 0);
      this._enemyMelee(e, pick(helpless.length ? helpless : living));
    }
  }
  // One enemy swing at a chosen target (handles the paralysis rider + signature sound).
  _enemyMelee(e, target) {
    const effAC = acOf(target.gear).ac - (target.paralyzed > 0 ? 4 : 0);   // helpless: +4 to be hit
    const r = this._monsterSwing(e, effAC);
    if (r.hit && e.atkSound) r.sound = e.atkSound;   // rogue's "riki" stab
    if (r.hit) {
      target.hp -= r.damage;
      this._note(`${e.glyph} ${e.name} hits ${target.nickname} for ${r.damage}. ${this._atkStr(r)} (${Math.max(0, target.hp)}/${target.maxHp} HP)`, r.sound);
      if (target.hp <= 0) { this._memberDown(target); this._echoToTable(r.sound); return; }
      if (e.paralyze) {
        const pdc = e.paralyzeDC || PARALYZE_DC;
        const sm = this._partySaveMod(target), sroll = dRoll(20), stot = sroll + sm;
        const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= pdc;
        if (!saved) { target.paralyzed = 1; this._note(`🥶 ${target.nickname} fails the paralysis save [d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs DC ${pdc}] — paralyzed!`); }
        else this._note(`${target.nickname} resists paralysis [d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs DC ${pdc}].`);
      }
      if (target.hp > 0 && target.isBot) this._tryBanter(target, 'damage', { enemy: e.name, dmg: r.damage });
    } else {
      this._note(`${e.glyph} ${e.name} misses ${target.nickname}. ${this._atkStr(r)}`, r.sound);
    }
    this._echoToTable(r.sound);
  }
  // Kobold shaman's Hold Person: fail a Will save (DC 10 + ½ caster level) → lose a turn.
  _enemyCastHold(e, target) {
    e.castsLeft -= 1;
    const dc = e.spellDC || 13;
    const sm = this._partySaveMod(target), sroll = dRoll(20), stot = sroll + sm;
    const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= dc;
    const roll = `[Will d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs DC ${dc}]`;
    if (!saved) {
      target.paralyzed = Math.max(target.paralyzed || 0, 1);   // held → loses next turn
      this._note(`🪄 ${e.glyph} ${e.name} casts Hold Person on ${target.nickname} — HELD! ${roll} (loses a turn)`);
    } else {
      this._note(`🪄 ${e.glyph} ${e.name} casts Hold Person on ${target.nickname}, who breaks free. ${roll}`);
    }
    this._broadcast();
  }
  _allyAct(m) { const foes = this.livingEnemies(); if (foes.length) this._playerAttack(m, foes[0].uid); }
  _memberDown(m) {
    if (m.dead) return;
    m.dead = true;   // hp<=0 already; the turn loop skips them, run ends in _endIfResolved
    this._note(`☠️ ${m.nickname} falls in the dungeon — out of the run.`);
    this._log('death', { who: m.playerId, depthReached: this.depth });
    this._emitMemberExit(m, { reason: 'dead', goldBanked: 0 });
  }

  // ── Player actions (from dungeon:action) ─────────────────────────────────
  action(playerId, kind, payload = {}) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };

    // Bail, loot rolls, and loot management are allowed any time (not on-turn).
    if (kind === 'bail') return this.bail(playerId);
    if (kind === 'lootroll') return this._lootDecide(playerId, !!payload.roll);
    if (kind === 'equip') { const r = this.equipLoot(playerId, payload.idx); this._broadcast(); return r; }
    if (kind === 'hock')  { const r = this.hockLoot(playerId, payload.idx); this._broadcast(); return r; }

    if (this.status === 'exploring') {
      if (kind === 'door') return this.openDoor();
      return { ok: false, error: 'invalid while exploring' };
    }
    if (this.status !== 'combat') return { ok: false, error: 'run is over' };
    if (this._currentActorId() !== playerId) return { ok: false, error: 'not your turn' };
    clearTimeout(this._turnTimer);
    this._log('action', { who: playerId, kind, hp: m.hp, enemiesAlive: this.livingEnemies().length });
    if (kind === 'attack')         this._playerAttack(m, payload.targetUid);
    else if (kind === 'lightning') { if (m.usedLightning) { this._armAfkTimer(m); return { ok: false, error: 'lightning already used this room' }; } this._castLightning(m, payload.targetUids || []); }
    else if (kind === 'stinking')  { if (m.usedStinking) { this._armAfkTimer(m); return { ok: false, error: 'stinking already used this room' }; } this._castStinking(m); }
    else { this._armAfkTimer(m); return { ok: false, error: 'unknown action' }; }
    this._nextTurn();
    return { ok: true };
  }

  _playerAttack(m, targetUid) {
    const e = this.enemies.find(x => x.uid === targetUid && x.hp > 0) || this.livingEnemies()[0];
    if (!e) return;
    m.weapon = weaponOf(m.gear);
    const r = this._swingVsAC(m, e.sickened > 0 ? e.ac - 2 : e.ac);   // sickened: +2 to be hit
    if (r.fumble) this._note(`${m.nickname} fumbles the attack! ${this._atkStr(r)}`, r.sound);
    else if (r.hit) { e.hp -= r.damage; this._note(`${m.nickname} ${r.crit ? 'CRITS' : 'hits'} ${e.name} for ${r.damage}. ${this._atkStr(r)}${e.hp <= 0 ? ' ☠️ Slain!' : ` (${Math.max(0, e.hp)}/${e.maxHp})`}`, r.sound); }
    else this._note(`${m.nickname} misses ${e.name}. ${this._atkStr(r)}`, r.sound);
    if (r.hit && e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(r.sound);
  }
  _castLightning(m, targetUids) {
    m.usedLightning = true;
    const power = Math.max(2, totalMagicBonus(m.gear)), dc = 10 + power;
    const dice = Math.max(1, Math.floor(power / 2));   // 1d6 per 2 "levels" of magic power, rounded down
    let chosen = (targetUids || []).map(u => this.enemies.find(e => e.uid === u && e.hp > 0)).filter(Boolean);
    if (!chosen.length) chosen = this.livingEnemies().slice(0, LIGHTNING_MAX_TARGETS);
    chosen = chosen.slice(0, LIGHTNING_MAX_TARGETS);
    const sound = pick(SND.lightning), parts = [];
    for (const e of chosen) {
      let full = 0; for (let i = 0; i < dice; i++) full += dRoll(6);
      const sroll = dRoll(20), stot = sroll + e.reflex;
      const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= dc;
      const dmg = saved ? Math.floor(full / 2) : full;
      e.hp -= dmg;
      parts.push(`${e.name}: Ref [d20 ${sroll} ${this._fmtBonus(e.reflex)} = ${stot} vs DC ${dc}] ${saved ? 'save, half' : 'fail'} ${dmg}${e.hp <= 0 ? ' ☠️' : ''}`);
    }
    this._note(`⚡ ${m.nickname} Lightning Bolt (${dice}d6) — ${parts.join('; ')}.`, sound);
    this._echoToTable(sound);
  }
  _castStinking(m) {
    m.usedStinking = true;
    const power = Math.max(2, totalMagicBonus(m.gear)), dc = 10 + power;
    const sound = pick(SND.stink), parts = [];
    for (const e of this.livingEnemies()) {
      const sroll = dRoll(20), stot = sroll + e.fort;
      const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= dc;
      if (!saved) e.sickened = SICKENED_ROUNDS;
      parts.push(`${e.name}: Fort [d20 ${sroll} ${this._fmtBonus(e.fort)} = ${stot} vs DC ${dc}] ${saved ? 'save' : 'SICKENED'}`);
    }
    this._note(`💨 ${m.nickname} Stinking Cloud (DC ${dc}) — ${parts.join('; ')}.`, sound);
    this._echoToTable(sound);
  }

  // ── Loot (per owner) ──────────────────────────────────────────────────────
  equipLoot(playerId, idx) {
    const loot = this.pendingLoot[idx];
    if (!loot || loot.owner !== playerId) return { ok: false, error: 'not your loot' };
    const m = this.member(playerId); if (!m) return { ok: false, error: 'gone' };
    const gear = db.getGear(playerId);
    if ((Number(gear[loot.slot]) || 0) >= loot.tier) { this.pendingLoot.splice(idx, 1); return { ok: false, error: 'already better' }; }
    gear[loot.slot] = loot.tier;
    db.setGear(playerId, gear);
    m.gear = gear;
    this._relevel(m);   // any upgrade raises level → +10 max HP, +to-hit, +to-save
    this.pendingLoot.splice(idx, 1);
    this._note(`🛡️ ${m.nickname} equipped the +${loot.tier} ${db.GEAR_BY_KEY[loot.slot]?.label || loot.slot}. (Lv ${m.level})`);
    return { ok: true };
  }
  hockLoot(playerId, idx) {
    const loot = this.pendingLoot[idx];
    if (!loot || loot.owner !== playerId) return { ok: false, error: 'not your loot' };
    const v = db.gearHockValue(loot.slot, loot.tier);
    this.runGold += v;
    this.pendingLoot.splice(idx, 1);
    this._note(`💰 ${this.member(playerId)?.nickname || playerId} hocked a +${loot.tier} ${db.GEAR_BY_KEY[loot.slot]?.label || loot.slot} for ${v} gp (into the pool).`);
    return { ok: true };
  }

  // ── Exits ─────────────────────────────────────────────────────────────────
  // One member climbs out with an even share of the current pool.
  bail(playerId) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };
    const wasActor = this._currentActorId() === playerId;
    const fled = this.status === 'combat';   // bailing mid-fight = running away
    const denom = Math.max(1, this.alivePresent().length);
    const share = Math.floor(this.runGold / denom);
    this.runGold -= share;
    const p = db.getPlayer(playerId);
    if (p) db.setChips(playerId, p.chips + share);
    m.left = true;   // turn loop skips left members; entry stays for index integrity
    this._note(`${fled ? '🏃' : '🪜'} ${m.nickname} ${fled ? 'flees the fight and climbs out' : 'climbed out'} with ${share} gp.`);
    this._log('bail', { who: playerId, share, poolLeft: this.runGold, fled });
    this._emitMemberExit(m, { reason: 'bailed', goldBanked: share, fled });
    // Last human out (only AI allies left) → cash them out and end the run.
    if (!this._anyHumanFighting()) { this._wrapUp(); return { ok: true, goldBanked: share }; }
    // Only nudge the turn cycle if the bailer was the one we were waiting on.
    if (this.status === 'combat' && wasActor) { clearTimeout(this._turnTimer); this._nextTurn(); }
    else this._broadcast();
    return { ok: true, goldBanked: share };
  }
  // Tell THIS player's client to surface back to the table; notify the table.
  _emitMemberExit(m, exit) {
    if (this.io) this.io.to(this.roomName()).emit('dungeon:exit', { playerId: m.playerId, ...exit });
    if (this._onMemberExit) try { this._onMemberExit(m.playerId, m.nickname, exit); } catch (_) {}
  }
  destroy() { clearTimeout(this._turnTimer); clearTimeout(this._stepTimer); clearTimeout(this._lootTimer); }
}

module.exports = { Dungeon };
