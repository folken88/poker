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
const { weaponOf, acOf, totalMagicBonus, SND, dRoll, dRollN, pick } = require('./combat');
const { CLASSES, babFor, saveFor, weaponProficient, NON_PROFICIENT_PENALTY } = require('../pf1data/classes');
const { kitFor, roomUses, isPoolClass, isCaster, isSpontaneous, spellSlots, spontaneousSlots, slotsFor, diceCount, CANTRIPS, CANTRIP_BY_KEY } = require('../pf1data/abilities');
const { levelFromXp, xpFloorForLevel, xpForCR, rawXpForCR, xpProgress } = require('../pf1data/xp');
const { logDungeon, recordSound } = require('../persistence/logger');
const banter = require('../bot/banter');
const { deriveCharacter, attackProfile } = require('./character');
const { MON, MON_GANGS, BOSS_KEYS, SPAWNABLE, crToNum, SIZE_RANK, SIZE_NAME } = require('../pf1data/monsters');
const RACES = require('../pf1data/races');   // racial ability mods, vision, save bonuses (Phase 1)
const loadouts = require('../pf1data/loadouts');
const { fighterFeats, gatingLevel, FEAT_AT, PALADIN_FEAT_AT, DRUID_FEAT_AT, CASTER_FEAT_AT, RANGED_FEAT_AT, CLASS_FEAT_AT, RANGED_FEAT_CLASSES } = require('../pf1data/feats');   // PF1 feat trees (concept split — pf1core, PGM-shared)   // spell-loadout pool + defaults (Phase B) — the Spellbook picker reads kitSpells from here
const { DOMAINS, maxDomainsFor } = require('../pf1data/domains');   // cleric/inquisitor domains (DOMAINS-DESIGN.md Phase B)

// (DOMAIN_POWERS moved to game/dungeon/abilities.js — Phase-2 seam 4)

// ── Tuning knobs ────────────────────────────────────────────────────────────
// LEVEL = 1 + sum of all gear bonuses (min 1). Level drives HP, to-hit, and
// saves — for humans AND AI allies.
const HP_PER_LEVEL   = 10;   // legacy fallback (used only if a class has no Hit Die)
// HP per level is the class's Hit Die, MAX roll assumed (barbarian d12, fighter
// d10, rogue/cleric/bard d8, wizard/sorcerer d6 …). So a level-6 fighter has 60
// HP, a level-6 wizard 36.
function hdFor(cls) { return (CLASSES[cls] && CLASSES[cls].hd) || HP_PER_LEVEL; }
// (FF_NONE + the feat system moved to pf1data/feats.js — concept split 2026-07-04)
// PF1 weapon-damage-by-size table (Enlarge Person / Improved Natural Attack), one
// step UP per entry. Used to grow a druid's natural-attack dice when they enlarge
// into a bigger form and/or take Improved Natural Weapon.
const DMG_STEP = {
  '1d2': [1, 3], '1d3': [1, 4], '1d4': [1, 6], '1d6': [1, 8], '1d8': [2, 6], '1d10': [2, 8], '1d12': [3, 6],
  '2d6': [3, 6], '2d8': [3, 8], '2d10': [4, 8], '3d6': [4, 6], '3d8': [4, 8], '4d6': [6, 6], '4d8': [6, 8],
  '6d6': [8, 6], '6d8': [8, 8], '8d6': [12, 6],
};
function stepDamage(count, die, steps) {
  let c = count || 1, d = die || 4;
  for (let i = 0; i < (steps || 0); i++) { const nx = DMG_STEP[`${c}d${d}`]; if (!nx) break; c = nx[0]; d = nx[1]; }
  return { count: c, die: d };
}
// The fighter bonus-feat ladder, evaluated at a GATING level `g` (which feats are
// earned so far) with the Toughness HP bonus scaling on actual Hit Dice `hd`.
// (the class feat trees + fighterFeats moved to pf1data/feats.js — concept split 2026-07-04)
// Bane's flat bonuses (the +2d6 rides on top, not crit-multiplied). See _abBane.
const BANE_TOHIT = 2, BANE_DMG = 2, BANE_DICE = 2;
// Title-case a creature type for display ("magical beast" → "Magical Beast").
function titleCase(s) { return String(s || '').replace(/\b\w/g, c => c.toUpperCase()); }
// Undead & constructs are immune to mind-affecting magic — sleep, fascinate, hold
// person, hideous laughter (PF1: no mind to affect / no Con).
const MIND_IMMUNE_TYPES = new Set(['undead', 'construct']);
// isSneakClass — every rogue-style AI behavior keys off the SNEAK_CLASSES set
// declared with the class conditionals below (rogue/ninja/slayer): invisible
// alpha strikes, feint logic, helpless-target preference, dagger dual-wield
// styling. New rogue variants just join that set and inherit all of it.
const isSneakClass = (cls) => SNEAK_CLASSES.has(cls);
function mindImmune(e) { return !!e && MIND_IMMUNE_TYPES.has(e.type); }
// Fights with NATURAL weapons / unarmed (claws, fangs, slams, fists, tentacles) —
// no manufactured weapon to knock away, so it can't be DISARMED. True for the
// explicit `natural` flag (monks + flagged monsters) or these creature types.
const NATURAL_TYPES = new Set(['animal', 'vermin', 'ooze', 'magical beast', 'aberration', 'plant']);
function fightsNatural(e) { return !!e && (e.natural || NATURAL_TYPES.has(e.type)); }
// "Already taken out of the fight" by crowd control — don't waste fresh CC on them
// (asleep / fascinated / held / prone / stunned). Used to target CC intelligently.
function ccd(o) { return !!o && (o.asleep || o.fascinated || o.charmed || (o.paralyzed > 0) || o.prone || (o.stunned > 0) || (o.nauseated > 0)); }
// A "finessable" melee weapon (light, or a one-handed fencing blade) — what a
// swashbuckler's Precise Strike, Weapon Focus/Specialization and Improved
// Critical key off of.
const FINESSE_KEYS = new Set(['rapier', 'scimitar', 'shortsword', 'dagger', 'kukri', 'cutlass', 'estoc', 'sword_cane', 'starknife', 'sap', 'radiance', 'curator', 'bastardsblade', 'lammas']);   // bastardsblade: Kai Ginn's DEX-ridden fauchard; lammas: Femmik's Dawnflower Dervish scimitar (Dervish Dance = DEX to hit & damage)
function isFinesseWeapon(w) { return !!w && !w.ranged && (w.cat === 'light' || FINESSE_KEYS.has(w.key)); }
function maxHpFor(cls, level) { return hdFor(cls) * Math.max(1, level || 1) + fighterFeats(cls, level).hp; }
// (gatingLevel + the *_FEAT_AT tables moved to pf1data/feats.js — concept split 2026-07-04)
const LIGHTNING_MAX_TARGETS = 2;
const SICKENED_ROUNDS = 3;
const SICKENED_PENALTY = 2;
const BLIND_ROUNDS = 3;           // Glitterdust — how long a blinded foe stays blind
const PARALYZE_DC = 14;
// PF1 Dispel Magic: the check (1d20 + caster level) is made vs DC = 11 + the CL of
// the EFFECT being dispelled (NOT dungeon depth). Each debuff is stamped with its
// source's caster level when applied; these are the FLOORS (the minimum caster
// level able to produce that effect — roughly the spell's level), so even a weak
// mook's Hold Person is no easier to dispel than the spell allows, while a deep,
// high-CL caster's magic is genuinely stubborn. Used by _dispellableCL.
// SPELL effects only (Tobias 2026-07-03: Dispel ends active spells — grapple,
// stun, sickness and nausea are PHYSICAL and undispellable).
const EFFECT_CL_FLOOR = {
  paralyzed: 3,   // Hold Person (2nd-level spell, min CL 3); Hold Monster stamps higher — spell-held only (heldDC set)
  slowed:    5,   // Slow (3rd-level, min CL 5)
  blinded:   3,   // Blindness/Glitterdust (2nd-level, min CL 3)
};
// A flying creature holds the "high ground" over grounded foes: +1 to hit them,
// +2 AC against their attacks. (Heroes are always grounded.)
const HIGH_GROUND_HIT = 1;
const HIGH_GROUND_AC  = 2;
// We don't roll ability scores — instead every character is assumed to have an 18
// in their attack stat, granting the standard +4 ability modifier to hit AND to
// damage (the latter doubles on a crit, like any static damage mod in PF1e). This
// is the missing "STR/DEX" piece on top of level (BAB-ish) and gear.
const ABILITY_MOD = 4;
// Casting-stat modifier — an 18 Int/Wis/Cha, mirroring the 18 STR/DEX behind
// attacks (ABILITY_MOD). Drives hero spell save DCs; the matching PF1 bonus
// spells live in abilities._tableSlots. Kept separate from ABILITY_MOD so the
// spell stat can diverge from the attack stat later as we approach full PF1.
const CAST_MOD = 4;
// Class conditionals (powered by the alignment / flat-footed tracking).
const SNEAK_CLASSES = new Set(['rogue', 'ninja', 'slayer']);  // gain Sneak Attack
const SNEAK_DICE_CAP = 5;     // cap precision dice so it stays flavorful, not silly
const SMITE_TOHIT    = 2;     // paladin Smite Evil: to-hit bump vs an evil foe (+level dmg)
const AFK_PASS_MS    = 60_000; // idle on your turn → auto-ATTACK after 60s (extra time for screen-reader play)
// AI "decision time" scales with THREAT: 1s + 0.1s per CR for enemies (so a CR-1
// rat snaps in ~1.1s and a CR-10 horror broods ~2s), or per LEVEL for AI allies
// (who have no CR). Clamped to [1s, 5s]. crToNum (hoisted below) parses "1/2" etc.
const aiStepMs = (actor) => {
  let n = 0;
  if (actor) { if (actor.cr != null) n = crToNum(actor.cr); else if (actor.level != null) n = actor.level; }
  return Math.round(Math.max(1000, Math.min(5000, 1000 + n * 100)));
};
const CHAIN_SFX_GAP_MS = 320;  // audible gap between staggered cleave/chain swing sounds
// (MAGUS_SPELLSTRIKE_SFX moved to game/dungeon/abilities.js, its only user)
const BOSS_EVERY     = 5;
// (LOOT_ROLL_MS moved to game/dungeon/loot.js — Phase-2 seam 1)

// (BUFF_META — the buff-strip icon metadata — moved to game/dungeon/serialize.js, its only user)

// ── Monster bestiary, gangs, art, types, resists, alignment + CR/spawnable
//    derivation now live in pf1data/monsters.js (imported at the top of this file).

// PF1e XP value by CR — the currency for building balanced encounters. The
// total XP of a room's monsters ≈ the XP of a single creature at the target
// encounter CR (that's how PF1 turns "2× CR n = CR n+2" into simple addition).
// XP-per-CR for character progression (xpForCR, × multiplier) and encounter
// budgeting (rawXpForCR, un-multiplied) both live in pf1data/xp.js now.
// Legacy gentle-creep target (kept as a fallback for the budget builder).
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

// (loot tuning helpers moved to game/dungeon/loot.js — Phase-2 seam 1)
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
    this._noteSide = null;   // set to 'enemy' while a monster is taking its turn (see _withSide)
    this._turnTimer = null;
    this._stepTimer = null;
    this._bantRound = -1;        // last combat round an AI ally reacted (1 per round)
    this.targeting = {};         // playerId → enemy uid: live 🎯 aim telegraphy (humans only)
    this._fleeing = false;       // a human fled mid-fight with no human left to lead → AI hirelings retreat too
  }

  // Live aim telegraphy — a human's currently-selected foe, rebroadcast so the
  // whole party (including blind players' locked targets) can see the focus
  // converging. Validated against living enemies; deduped to spare broadcasts.
  setTargeting(playerId, uid) {
    const next = (typeof uid === 'string' && this.enemies.some(e => e.uid === uid && e.hp > 0)) ? uid : null;
    const cur = this.targeting[playerId] || null;
    if (cur === next) return;
    if (next) this.targeting[playerId] = next; else delete this.targeting[playerId];
    this._broadcast();
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
      if (Math.random() > 0.36) return;
    } else if (Math.random() > 0.40) return;
    this._emitBanter(member, eventType, ctx);
  }
  _emitBanter(member, eventType, ctx) {
    const flavorNick = member.trueNick || member.nickname;   // Vorkstag keeps his own creepy voice…
    const label = member.nickname;                           // …but is shown + voiced as whoever he wears
    Promise.resolve(banter.dungeonLine(flavorNick, eventType, { ...ctx, voiceNick: label })).then(res => {
      if (!res || !res.line) return;
      // voiced: the 11labs clip carries this line out loud — the blind narrator
      // must NOT read it again (Josh: "the blind voice is doing double duty").
      this._note(`💬 ${label}: ${res.line}`, null, { kind: 'banter', voiced: !!res.audio });
      if (this.io && res.audio) {
        // Clear for the dungeon party; the poker table overhears it MUFFLED
        // (same "through the floor" treatment as the combat echo).
        this.io.to(this.roomName()).emit('dungeon:say', { nick: label, audio: res.audio, audioMime: res.audioMime });
        if (this.tableId) this.io.to(`table:${this.tableId}`).emit('dungeon:voiceecho', { audio: res.audio, audioMime: res.audioMime });
      }
      this._broadcast();
    }).catch(() => {});
  }
  // RADIANCE — Vaughan's SENTIENT scimitar speaks. Mechanically a SECOND voice of Vaughan
  // (fires on HIS events), but shown + voiced as "Radiance" in the Tresdin voice; in-fiction
  // only Vaughan hears her (the table plays along). Gated to whoever wields the blade (Vaughan)
  // and ONE line per combat round, so she punctuates — a dry roast on a whiff / a death, a
  // gleeful howl when he unmakes undead. Fired from the miss / drop / undead-kill hooks.
  _radianceQuip(m, eventType, ctx = {}) {
    if (!m || m.weaponKey !== 'radiance') return;   // she rides Vaughan's blade only
    if (this.status === 'combat') {
      if (this.round === this._radRound) return;     // one Radiance line per round
      this._radRound = this.round;
      if (Math.random() > 0.55) return;
    } else if (Math.random() > 0.5) return;
    Promise.resolve(banter.dungeonLine('Radiance', eventType, { ...ctx, voiceNick: 'Radiance' })).then(res => {
      if (!res || !res.line) return;
      this._note(`💬 Radiance: ${res.line}`, null, { kind: 'banter', voiced: !!res.audio });
      if (this.io && res.audio) {
        this.io.to(this.roomName()).emit('dungeon:say', { nick: 'Radiance', audio: res.audio, audioMime: res.audioMime });
        if (this.tableId) this.io.to(`table:${this.tableId}`).emit('dungeon:voiceecho', { audio: res.audio, audioMime: res.audioMime });
      }
      this._broadcast();
    }).catch(() => {});
  }

  // ── ORDER OF THE FLAME cavalier deeds (beyond Glorious Challenge) ──
  // A Flame cavalier is identified the same way Glorious Challenge is char-gated — keep this in
  // sync with GLORIOUS_CHALLENGE's char field when more Flame heroes join. FOOLHARDY RUSH (L2) is
  // a passive (+4 initiative & never flat-footed — see openDoor + _rollInitiative); DAUNTING
  // SUCCESS (L8) fires below off a confirmed crit; BLAZE OF GLORY (L15) is a room-cost buff button.
  _isFlameCavalier(m) {
    if (!m || m.cls !== 'cavalier') return false;
    return (m.trueNick || m.nickname || m.playerId || '').toLowerCase() === 'lord gweyir';
  }
  // DAUNTING SUCCESS (L8): a confirmed crit from a Flame cavalier DEMORALIZES every living foe
  // (−2 to hit/damage/saves — the `prayed` penalty) for the rest of the room. Once per room.
  _dauntingSuccess(m) {
    if (!this._isFlameCavalier(m) || (m.level || 1) < 8 || m._dauntedRoom) return;
    m._dauntedRoom = true;
    let n = 0;
    for (const e of this.livingEnemies()) { e.prayed = Math.max(e.prayed || 0, 2); n++; }
    if (n) { const s = '/audio/draugr_shout03_burning.mp3'; this._note(`😱 ${m.nickname}'s GLORIOUS critical DAUNTS the room — ${n} foe${n > 1 ? 's' : ''} quail (−2 to hit, damage & saves)! (Daunting Success)`, s); this._echoToTable(s); }
  }

  roomName() { return `dungeon:${this.id}`; }
  _note(text, sound, meta = {}) {
    if (this._silentSfx) sound = null;   // pre-door buff pass: log the line, mute the SFX (no wall of sounds at once)
    // Each entry carries `side` (which column it belongs in) and `kind` (its
    // colour tint) so the client can split the log hero-left / enemy-right and
    // gently colour heals (gold), deaths (red), buffs (blue), debuffs (purple).
    const side = meta.side || this._noteSide || this._inferSide(text);
    const kind = meta.kind || this._inferKind(text);
    // `phase` tags each line's REPORT SECTION ('combat' / 'loot' / 'xp' / 'levelup')
    // so the blind narrator's stop key can skip just the section now reading instead
    // of the whole end-of-room report (Josh's segmented silence, 2026-07-03).
    const phase = meta.phase || this._notePhase || (this.lootRoll ? 'loot' : (this.status === 'combat' ? 'combat' : null));
    this.log.push({ t: ++this._logSeq, text, sound: sound || null, side, kind, voiced: !!meta.voiced, phase });
    if (this.log.length > 150) this.log.shift();
    if (sound) { try { recordSound('dungeon', sound, text); } catch (_) {} }
  }
  // Run `fn` with every _note inside it attributed to one side (used to tag a
  // monster's whole turn 'enemy' in one place). Synchronous; restores on exit.
  _withSide(side, fn) { const prev = this._noteSide; this._noteSide = side; try { return fn(); } finally { this._noteSide = prev; } }
  // Party chatter and run-level admin (doors, loot, gold, interest) live in the
  // centre channel; everything else defaults to the hero side unless _noteSide
  // (an enemy turn) or an explicit meta.side says otherwise.
  _inferSide(text) { return /^(💬|🚪|✨|💎|🎲|🚫|🏆|💰|🛡️|🏛️|💀|🧪|🪜|🏃)/.test(text) ? 'system' : 'hero'; }
  // Colour tint by event kind. Order matters: death wins over heal/buff/debuff.
  _inferKind(text) {
    if (/☠️|💀|🩸|hero_death|[Ss]lain|bleeds out|bleeds —|collapses|DOWN and dying|battered while down|drops past|claims them|dragged out/.test(text)) return 'death';
    if (/💗|💚|🧪|heals|mends|is revived|quaffs|breathes life|[Bb]reath of [Ll]ife|restored to the run|channels positive|back on their feet|back up at/.test(text)) return 'heal';
    if (/💨|[Hh]aste|emboldened|Inspire|Bless|Rage|fades from view|unseen until|Invisib|Divine Favor|righteous fury|calls a Smite|Prayer|blurs with|pronounces Judgement|Judgement —|Judgment —/.test(text)) return 'buff';
    if (/paralyz|fascinat|sickened|retches|prone|clambers|feint|TRIPS|tries to trip|HELD|Hold Person|Hideous|off-balance|flat-footed|dispel|stunned|held —|is held/.test(text)) return 'debuff';
    return 'normal';
  }
  _log(type, extra) {
    try { logDungeon({ type, run: this.id, depth: this.depth, round: this.round, ...(extra || {}) }); } catch (_) {}
  }

  // ── Party membership ──────────────────────────────────────────────────────
  member(playerId) { return this.party.find(m => m.playerId === playerId); }
  present() { return this.party.filter(m => !m.left); }                 // still in the run (alive or downed-this-tick)
  alivePresent() { return this.party.filter(m => !m.left && m.hp > 0); }
  livingParty() { return this.alivePresent(); }
  // Heroes the enemy can actually target — invisible ones are unseen (until they
  // attack). If EVERY living hero is invisible, fall back so combat can resolve.
  _targetableParty() { const live = this.alivePresent(); const seen = live.filter(m => !m.invisible && !m.untargetable && !m.blinkedBy); return seen.length ? seen : live; }   // blinkedBy: teleported — untouchable until the caster's next turn
  livingEnemies() { return this.enemies.filter(e => e.hp > 0); }
  // Foes a hero can actually hit — excludes those shrouded in DARKNESS (can't be
  // attacked for 2 rounds). They're still "alive" (room stays active until it lifts).
  _targetableEnemies() {
    // Darkvision (Communal — Rhyarca's Trickery mystery): when ANY living party
    // member carries it, the party can TARGET foes shrouded in magical darkness
    // (the darkened foes still lose their own turns — see _advanceToActor).
    // Darkvision Communal OR a blindsense hero (iku-turso) present → the party can
    // TARGET foes shrouded in magical darkness (and, when foes can turn invisible,
    // those too — blindsense pinpoints the unseen).
    // Seeing the UNSEEN — darkvision/blindsense (Rhyarca's Communal Darkvision,
    // Bujon's blindsense) OR True Seeing — lets the party target foes shrouded in
    // darkness AND foes who've gone INVISIBLE (enemy casters can now vanish).
    const dv = this.party.some(p => !p.left && p.hp > 0 && (p.darkvision || p.blindsense > 0 || p.trueSeeing));
    // SUMMONED undead are the party's OWN allies — never a valid target for the party.
    let list = this.enemies.filter(e => e.hp > 0 && !e.summoned && (dv || (!(e.darkened > 0) && !e.invisible)));
    // If invisibility/darkness hid EVERY foe, the party can still flail into the dark
    // (each swing eats the 50% concealment miss in _swingVsAC) — never leave them with
    // zero targets and a stuck room.
    if (!list.length) list = this.enemies.filter(e => e.hp > 0 && !e.summoned);
    return list;
  }

  hasMember(playerId) { const m = this.member(playerId); return !!(m && !m.left && m.hp > 0); }
  botCount() { return this.party.filter(m => m.isBot && !m.left && m.hp > 0).length; }
  // Orc / half-orc FEROCITY: these characters keep fighting at 0 HP and below
  // (until slain at −10) instead of dropping when downed. Keyed by name/playerId.
  _hasFerocity(m) {
    const id = String((m && (m.trueNick || m.nickname || m.playerId)) || '').toLowerCase();
    return id === 'tokala' || id === 'kai ginn' || id === 'kai gin';
  }

  // True if this member wields a ranged weapon (bow/crossbow/firearm) — selects the
  // RANGED feat tree (Weapon Focus, Point Blank, Rapid Shot, …) over the melee one.
  _isRanged(m) { try { return !!weaponOf(m.gear, m.weaponKey).ranged; } catch (_) { return false; } }
  // Which BACKUP ranged weapon a melee character draws when they can't reach
  // (or, for Gaspar, when he just feels like shooting): signature sidearms for
  // the gunfighters, the plain masterwork light crossbow for everyone else.
  _backupRangedKey(m) {
    const BY_CHAR = { 'el guapo': 'guapopistol', gaspar: 'gasparpistols' };
    return BY_CHAR[(m.playerId || '').toLowerCase()] || 'lightcrossbow';
  }
  // Can this member's CURRENT weapon reach foe `e`? Grounded melee can't touch a
  // flyer; ranged/reach weapons and airborne attackers (Overland Flight) can.
  _canReach(m, e) {
    if (m && m._tpStrike > 0) return true;   // Dimension Door/Teleport: the next strike reaches ANY foe
    if (!e || !e.flying) return true;
    // A CORPOREAL flyer that is HELD (paralyzed) or GRAPPLED has fallen / been dragged
    // down out of the air — grounded melee CAN now reach it. Real wings (Reese) beat
    // DISPEL, but not Hold Person or Black Tentacles. Incorporeal flyers (ghosts) still
    // drift out of reach regardless.
    if (!(e.incorporeal || e.ghost) && ((e.paralyzed > 0) || e.grappled)) return true;
    const w = m.weapon || weaponOf(m.gear, m.weaponKey);
    return !!(w.ranged || w.reachFly || (m.canHitFlyers && m.flying));
  }
  // Compute + cache a member's PF1 derived stats (ability mods, CON-adjusted max
  // HP, casting mod, iterative-attack offsets) from their base 25-pt ability array.
  // Called at join and on every level change so the numbers track level/ASI.
  _setDerived(m) {
    const featHp = (fighterFeats(m.cls, m.level, this._isRanged(m)).hp) || 0;
    const raceMods = RACES.raceModsFor(m.race, m.abilityScores, m.flexStat);   // race ability adjustments (flat, or a flex race's chosen/best +2)
    const d = deriveCharacter({ cls: m.cls, level: m.level, baseScores: m.abilityScores, raceMods, featHp });
    m.mods = d.mods;
    m.castingMod = d.castingMod;
    m.iteratives = d.iteratives;
    m.maxHpDerived = d.hp;
    return d;
  }
  // UNDEAD party members — standard PF1 undead rules apply to THEM too: positive
  // energy (cure spells, Channel Positive, cure potions) does NOTHING; they mend
  // through Infernal Healing or Adimarus's Channel Negative. Vesorianna is also
  // a GHOST: constantly flying and incorporeal (half of physical blows pass through).
  static UNDEAD_HEROES = new Set(['tar baphon', 'auren vrood', 'vesorianna', 'farrus richton', 'toni']);   // lich/ghost/graveknight/vampire templates → undead (positive energy does nothing)
  // Casters who FRONT-LOAD damage: on a won initiative (round 1) vs foes of
  // their level or weaker they usually skip straight to their biggest blast.
  static BLASTER_OPENERS = new Set(['elfrip']);
  addMember(player, isBot = false) {
    const playerId = player.player_id;
    const idx = this.party.findIndex(m => m.playerId === playerId);
    if (idx >= 0 && !this.party[idx].left && this.party[idx].hp > 0) return this.party[idx];  // already active
    if (idx >= 0) this.party.splice(idx, 1);   // drop a stale (downed/bailed) entry → rejoin fresh
    const gear = db.getGear(playerId);
    const xp = db.getXp(playerId);
    const level = levelFromXp(xp);             // level now comes from XP (not gear)
    const cls = player.class || 'fighter';
    const abilityScores = db.getAbilityScores(playerId, cls);   // PF1 base 25-pt array
    const race = db.getRace(playerId);                          // PF1 race (default 'none')
    const flexStat = db.getRaceFlex(playerId);                  // chosen ability for a flex race's +2 ('' = auto)
    const raceMods = RACES.raceModsFor(race, abilityScores, flexStat);   // racial ability adjustments
    const _ranged = !!weaponOf(gear, player.weapon || 'dagger').ranged;
    const featHp = (fighterFeats(cls, level, _ranged).hp) || 0;
    const maxHp = deriveCharacter({ cls, level, baseScores: abilityScores, raceMods, featHp }).hp;   // Hit Die×level + CON mod/level (race-adjusted) + feat HP
    const m = {
      playerId,
      nickname: player.nickname || playerId,
      avatarId: player.avatar_id || null,
      isBot: !!isBot,
      undead: Dungeon.UNDEAD_HEROES.has((playerId || '').toLowerCase()),   // positive energy does nothing for them
      ghost: (playerId || '').toLowerCase() === 'vesorianna',               // always flying + incorporeal
      // A hero is airborne if they're a ghost OR their RACE has innate wings
      // (Strix, raceFly > 0). Innate flight is a member property, NOT a buff — so
      // dispel never grounds them (Reese's wings are real). canHitFlyers lets a
      // winged hero also strike other airborne foes in melee.
      flying: (playerId || '').toLowerCase() === 'vesorianna' || RACES.raceFly(race) > 0,
      innateFly: RACES.raceFly(race) > 0,      // real wings — undispellable (guarded in the dispel path)
      canHitFlyers: RACES.raceFly(race) > 0,
      race,                                    // PF1 race key (drives ability mods, vision, save bonuses)
      flexStat,                                // chosen ability for a flex race's floating +2 ('' = auto)
      vision: RACES.raceVision(race),          // 'normal' | 'low-light' | 'darkvision60' (read by blind mode; Phase-2 will negate darkness penalties)
      blindsense: RACES.raceBlindsense(race),  // ft of blindsense (iku-turso 30): pinpoints unseen foes — invisibility/darkness can't hide a target from this hero (see _targetableEnemies)
      lightningCL: ((playerId || '').toLowerCase() === 'olbryn') ? 2 : 0,   // Staff of Lightning: +2 caster level to electricity spells (see _spellDice)
      abilityScores,
      gear, level, xp,
      crowned: !!(db.getPlayer(playerId)?.crowned),   // permanent Loot Lord crown
      cls,                                     // PF1e class → drives BAB + Hit Die
      weaponKey: player.weapon || 'dagger',    // chosen base weapon (dropdown)
      hp: maxHp, maxHp,
      sickened: 0, paralyzed: 0, flatFooted: true,
      abilityUses: {}, buffs: null, smiteActive: false, acPenRound: -1, acPenAmt: 0,
      // Per-RUN state (persists across rooms, NOT refreshed by _resetAbilities):
      //   runAbilityUses — 'run'-cost abilities (Bless: once per whole dungeon)
      //   runBuffs       — run-long buffs (Bless's +1 to-hit) that never fade
      runAbilityUses: {}, runBuffs: { toHit: 0, dmg: 0 }, runBuffApplied: {},
      left: false, dead: false,
    };
    this._computeCastable(m);   // PHASE C: which spells this character may actually cast (prepared/known loadout)
    // Stock 'run'-cost abilities (Mage Armor, Bless) from the member's REAL ability
    // list — celebKit() for the Theurge, not kitFor(cls) (fighter DEFAULT_KIT for
    // 'theurge', which has no Mage Armor, so Celeb's Mage Armor never stocked → he
    // fell back to Shield of Faith). Domain powers aren't set yet (fine; not run-cost).
    for (const ab of this._abilitiesFor(m)) {
      if (ab.cost === 'run') m.runAbilityUses[ab.key] = (typeof ab.uses === 'function' ? ab.uses(level) : (ab.uses || 1));
    }
    this._setDerived(m);       // cache PF1 ability mods / CON-HP / iteratives FIRST — the reset below stocks Wis-scaled pools (domain powers) and stat-bonus slots from them
    this._resetAbilities(m);   // stock the per-room spell/channel pool by level
    // Vorkstag the skinwalker wears a partymate's face + name (true identity
    // hidden) — same as his poker-seat disguise. He keeps his own creepy
    // personality but is shown/voiced as whoever he's impersonating.
    if (playerId === 'vorkstag') {
      const victims = this.party.filter(x => !x.left && x.hp > 0);
      if (victims.length) { const v = pick(victims); m.trueNick = m.nickname; m.nickname = v.nickname; m.avatarId = v.avatarId; }
    }
    this.party.push(m);
    if (!isBot && this._fleeing) { this._fleeing = false; this._note('🛡️ A delver returns to the fray — the hired blades hold their ground after all.'); }   // a human re-joining calls off the retreat
    this._note(`🚪 ${m.nickname} joins the delve. (Lv ${level} · ${maxHp} HP)`);
    this._log('join', { who: playerId, level, maxHp, party: this.present().length });
    // Mid-combat join → add to the current turn order so they act this round.
    if (this.status === 'combat') this.turnOrder.push({ kind: 'party', id: playerId, init: dRoll(20) + 2 + Math.floor((m.level || 1) / 2) });
    // A bard's Inspire aura covers a MID-RUN newcomer — but the song doesn't
    // strike up at character selection (Tobias: it fired in the quiet room at
    // depth 0). The FIRST door's openDoor() call starts it like every other room.
    if (this.depth > 0) this._maintainBardSongs();
    this._broadcast();
    return m;
  }
  // (_condList/_buffList/_enemyBuffList/publicState moved to game/dungeon/serialize.js — Phase-2 seam 2)
  _broadcast() {
    if (!this.io) return;
    this.io.to(this.roomName()).emit('dungeon:state', this.publicState());
    // Tell everyone still at the poker table that a run is live, so they can
    // pop in to spectate / heckle from the money menu.
    if (this.tableId) this.io.to(`table:${this.tableId}`).emit('dungeon:active', this._summary());
  }
  _summary() {
    return { active: this.status !== 'over', depth: this.depth, status: this.status, party: this.present().map(m => m.nickname) };
  }
  _echoToTable(sound) {
    if (this._silentSfx) return;   // muted during the pre-door buff pass
    if (sound && this.io && this.tableId) this.io.to(`table:${this.tableId}`).emit('dungeon:echo', { sound });
  }
  // ── Pre-door buffs ──────────────────────────────────────────────────────────
  // Before the door opens, AI casters (heroes; villains pre-buff via spawn precast)
  // put up their RUN-LONG buffs — Mage Armor, Bless, Overland Flight — so they don't
  // waste combat turns on them (Josh: "casters never cast mage armor / fly"). Cast
  // SILENTLY (one summary line + sound), so it's not a wall of noise. Humans are NOT
  // auto-cast — they choose to cast these during exploring themselves.
  _isRunLongBuff(ab) {
    return !!ab && (ab.effect === 'magearmor' || ab.effect === 'overlandflight'
      || (ab.effect === 'buff' && ab.persist && ab.key !== 'inspire'));   // inspire is auto-maintained
  }
  _preDoorBuffs() {
    if (this.status !== 'exploring') return;
    const cast = [];
    this._silentSfx = true;
    try {
      for (const m of this.present()) {
        if (!m.isBot || m.dead || m.left || m.hp <= 0) continue;
        // Use the member's ACTUAL ability list — celebKit() for the Theurge, base
        // kit + domain powers for clerics, etc. NOT kitFor(m.cls): for Celeb that
        // resolves to the fighter DEFAULT_KIT (no Mage Armor!), so he never
        // auto-cast Mage Armor pre-door and fell back to Shield of Faith in combat.
        // It also keeps the slot index in sync with _useAbility's _abilitiesFor(m).
        this._abilitiesFor(m).forEach((ab, slot) => {
          if (!this._isRunLongBuff(ab) || (m.level || 1) < (ab.minLevel || 1)) return;
          if (ab.effect === 'magearmor' && m.mageArmor) return;
          if (ab.effect === 'overlandflight' && m.flying) return;
          const flag = ab.persist ? 'runBuffApplied' : 'buffApplied';
          if (m[flag] && m[flag][ab.key]) return;                                  // already up
          if (ab.cost === 'run' && !((m.runAbilityUses || {})[ab.key] > 0)) return; // none left
          const r = this._useAbility(m, slot, {});
          if (r && r.ok) cast.push(`${m.nickname} — ${ab.name}`);
        });
      }
    } finally { this._silentSfx = false; }
    if (cast.length) this._note(`✨ The party readies before the door: ${cast.join(', ')}.`, '/audio/spell_buff_invoke.mp3');
  }

  // ── Between-rooms economy (AI personas) ──────────────────────────────────────
  // Between rooms, an AI delver manages money like a person would: pay DOWN debt
  // when flush, then BUY a weapon upgrade if they can sensibly afford one — taking
  // a modest LOAN from Abadar to cover a small shortfall. Spends their persistent
  // chips (the SAME wallet humans buy gear from via the bank). Conservative + bounded
  // so it can't blow up the economy; all knobs are right here. Humans are untouched.
  _aiEconomy() {
    if (this.status !== 'exploring') return;
    const RESERVE   = 1500;   // never spend a bot's chips below this poker buffer
    const MAX_LOAN  = 4000;   // biggest single shortfall a bot will borrow to cover
    const DEBT_CAP  = 12000;  // a bot won't let its total Abadar tab exceed this
    for (const m of this.present()) {
      if (!m.isBot || m.dead || m.left || m.hp <= 0) continue;
      const p = db.getPlayer(m.playerId); if (!p) continue;
      let chips = p.chips || 0;
      // 1) PAY DOWN DEBT first when comfortably flush.
      const debt = p.rebuy_debt || 0;
      if (debt > 0 && chips > RESERVE + 250) {
        const pay = Math.min(debt, chips - RESERVE);
        if (pay > 0) { db.payRebuyDebt(m.playerId, pay); chips -= pay; this._note(`🏦 ${m.nickname} pays down ${pay} gp of their Abadar tab.`); }
      }
      // 2) BUY a WEAPON upgrade — one tier per stop, capped to a WBL-sane target for
      //    their level (≈ +1 by L3, +2 by L7, +3 by L11, +4 by L15, +5 by L19).
      const gear = db.getGear(m.playerId) || {};
      const cur = Number(gear.weapon) || 0;
      const target = Math.min(5, Math.floor(((m.level || 1) + 1) / 4));
      if (cur >= target || cur >= 5) continue;
      const next = cur + 1;
      const price = db.gearPrice('weapon', next);
      let borrowed = 0;
      if (chips < price + RESERVE) {                          // a little short → consider a modest loan
        const gap = (price + RESERVE) - chips;
        const curDebt = (db.getPlayer(m.playerId).rebuy_debt || 0);
        if (gap <= MAX_LOAN && curDebt + gap <= DEBT_CAP) { db.addRebuyDebt(m.playerId, gap); db.setChips(m.playerId, chips + gap); chips += gap; borrowed = gap; }
      }
      if (chips >= price + RESERVE) {
        db.setChips(m.playerId, chips - price);
        gear.weapon = next; db.setGear(m.playerId, gear); m.gear = gear;   // apply THIS run too (weaponOf reads m.gear)
        this._note(`🛒 ${m.nickname} buys a +${next} weapon for ${price} gp${borrowed ? ` (borrowing ${borrowed} from Abadar)` : ''}.`);
      }
    }
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
    this._aiEconomy();      // AI delvers shop between rooms — buy a weapon upgrade, borrow/repay Abadar
    this._preDoorBuffs();   // AI casters put up run-long buffs (Mage Armor/Bless/Fly) before the fight
    this.depth += 1;
    this._spawnRoom();
    this.blackTentacles = null;   // the tentacle field doesn't carry between rooms
    for (const m of this.present()) { this._computeCastable(m); this._resetAbilities(m); m.flatFooted = !(fighterFeats(m.cls, m.level, this._isRanged(m)).supremacy || (this._isFlameCavalier(m) && (m.level || 1) >= 2)); }  // re-read the spell LOADOUT (Spellbook picker edits land at the door) + refresh per-room spells/channels + flat-footed until they act (Weapon Supremacy — and Order of the Flame's FOOLHARDY RUSH at L2 — are never caught flat-footed)
    if (Math.random() < 0.05) { try { this._reskinVorkstag(); } catch (_) {} }   // skinwalker drifts to a new face between rooms (rare)
    this._maintainBardSongs();   // Inspire Courage is a passive aura — always up, no action spent
    this.status = 'combat';
    this.round = 1;
    this.targeting = {};   // last room's 🎯 aim picks are stale — fresh foes, fresh aims
    this._fleeing = false;   // a fresh room — any prior retreat is moot
    this._rollInitiative();
    this._note(`🚪 Door creaks open — room ${this.depth}. ${this._enemySummary()}`);
    // HYPE TRACK — a boss with a Maestro theme (extracted from the FVTT worlds)
    // makes an entrance: its music rides the reveal line and echoes to the table.
    const hypeBoss = this.enemies.find(e => e.boss && e.hype);
    if (hypeBoss) { this._note(`🎵 ${hypeBoss.name.replace(/^Boss: /, '')}'s theme rolls through the door…`, hypeBoss.hype, { side: 'enemy' }); this._echoToTable(hypeBoss.hype); }
    this._log('room', { boss: this.enemies.some(e => e.boss), party: this.present().length, enemies: this.enemies.map(e => ({ name: e.name, cr: e.cr, hp: e.maxHp, ac: e.ac, toHit: e.toHit })) });
    this._beginTurnCycle();
    return { ok: true };
  }
  // Average Party Level (PF1e): mean of the heroes' levels (1 + gear), rounded.
  _apl() {
    const party = this.alivePresent();
    if (!party.length) return 1;
    return Math.max(1, Math.round(party.reduce((s, m) => s + (m.level || 1), 0) / party.length));
  }
  // The LOWEST level in the party — the dungeon starts geared to its weakest
  // member so nobody gets one-shot in room 1, then ramps up as they descend.
  _minLevel() {
    const party = this.alivePresent();
    if (!party.length) return 1;
    return Math.max(1, Math.min(...party.map(m => m.level || 1)));
  }
  // The per-enemy CR for this room: geared to the LOWEST party member's level
  // (so the weakest isn't one-shot), ramping ~+1 every 4 rooms as they descend,
  // +2 on boss rooms. Party SIZE is handled by the XP budget (more heroes → more
  // enemies), not by inflating each foe's CR. Capped to the bestiary.
  _encounterCR(boss) {
    let cr = this._minLevel() + Math.floor(this.depth / 4);
    if (boss) cr += 2;
    return Math.max(1, Math.min(20, cr));   // cap tracks the bestiary — Tar-Baphon is CR 20 (the old 13 locked out every boss above 15)
  }
  // Strongest thematic foe (incl. boss-only creatures) the party can handle.
  _pickBoss(capCR) {
    const cand = Object.keys(MON).filter(k => MON[k].crNum <= capCR);
    if (!cand.length) return bossKeyFor(this.depth);
    const top = cand.sort((a, b) => MON[b].crNum - MON[a].crNum).slice(0, 3);
    return pick(top);
  }
  // A spawnable creature that fits the remaining XP budget. Biased HARD toward
  // CHEAP foes (weight ∝ 1/xp) so a room fills up with lots of shitty mooks —
  // goblins, kobolds, their sneaky rogues and Hold-Person shamans — instead of a
  // few tough ones. Falls back to anything affordable.
  _pickForBudget(budget, floorCR, capCR, gang) {
    // Gang filter: stick to the room's theme (wildcards — unlisted monsters —
    // run with anyone). If the gang pool can't fill the CR window, fall back
    // to the full roster rather than leave the room under-strength.
    const inGang = (k) => { if (!gang) return true; const g = MON_GANGS[k]; return !g || g.includes(gang); };
    let cand = SPAWNABLE.filter(k => inGang(k) && MON[k].crNum >= floorCR && MON[k].crNum <= capCR && rawXpForCR(MON[k].crNum) <= budget);
    if (!cand.length) cand = SPAWNABLE.filter(k => inGang(k) && MON[k].crNum <= capCR && rawXpForCR(MON[k].crNum) <= budget);
    if (!cand.length) cand = SPAWNABLE.filter(k => MON[k].crNum <= capCR && rawXpForCR(MON[k].crNum) <= budget);
    if (!cand.length) return null;
    const weights = cand.map(k => 1 / Math.max(1, rawXpForCR(MON[k].crNum)));
    const tot = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * tot;
    for (let i = 0; i < cand.length; i++) { r -= weights[i]; if (r <= 0) return cand[i]; }
    return cand[cand.length - 1];
  }
  // Defensive WARDS a caster foe walks in already wearing — they know the party
  // is coming, so the long-duration buffs they'd sensibly keep up are assumed
  // pre-cast (Tobias: "all enemy casters should have pre-cast wards — they know
  // they're about to be under attack"). An explicit base.precast wins; otherwise
  // we DERIVE a loadout from the foe's caster type + CR. ARCANE casters
  // (wizard/sorcerer/magus → arcane/spellstrike) wear Mage Armor + Shield, and
  // Stoneskin / Fly / Fire ward as they get tougher; DIVINE casters (clerics/
  // oracles who heal → healer) wear Shield of Faith, plus Fire ward / Stone skin.
  // Only the ward keys the Dispel-strip + chip UI understand are used: magearmor,
  // shield, shieldoffaith, stoneskin, protfire, fly. Stoneskin is skipped when the
  // foe already has innate DR (don't fake-stack a ward the dispel can't truly peel).
  _autoWards(base) {
    const arcane = !!base.arcane || !!base.spellstrike;
    const divine = !!base.healer;
    if (!arcane && !divine && !base.caster) return [];   // not a caster — no wards
    const cr = (base.crNum != null) ? base.crNum : (crToNum(base.cr) || 1);
    const w = [];
    if (arcane) {
      w.push('magearmor', 'shield');
      if (cr >= 7 && !base.dr) w.push('stoneskin');
      if (cr >= 9)  w.push('fly');
      if (cr >= 11) w.push('protfire');
    }
    if (divine || (!arcane && base.caster)) {
      w.push('shieldoffaith');
      if (cr >= 6) w.push('protfire');
      if (cr >= 9 && !base.dr) w.push('stoneskin');
    }
    return [...new Set(w)];
  }
  _makeEnemy(base, boss, elite = 0) {
    // BOSS ADVANCEMENT — a designated boss gains 1d4 EXTRA LEVELS (PF1 advancing
    // by class levels/HD): +12% HP and +1 to-hit per level; +1 AC, saves, damage,
    // ability DCs and special-use counts per 2 levels; bigger sneak/spellstrike/
    // heal dice; +1 effective CR per 2 levels (so XP and loot scale with the
    // tougher fight); and a fatter gold pouch. `bossLevels` feeds the lich's
    // caster level too, so its spells grow with the advancement.
    // ADVANCEMENT (PF1, Tobias 2026-07-04): +2..4 class levels = +1-2 CR, and
    // the levels bring EVERYTHING — hp, to-hit, saves, DCs. A boss ALWAYS
    // advances (2-4 levels; the old 1d4 could roll a wet +1); a regular spawn
    // advances only when the spawner flags it ELITE to fill a thin CR band.
    const extra = boss ? 1 + dRoll(3) : (elite || 0);
    const half = Math.floor(extra / 2);
    // BOSS PRE-CAST WARDS — a caster boss "cheats": every long-duration buff
    // (anything NOT measured in rounds/level — Mage Armor, Shield, Stoneskin,
    // Protection from Fire, Fly, Shield of Faith) is assumed already up when the
    // party walks in. Stored on e.precast so the enemy's chips show the wards and
    // Dispel Magic can strip them one by one (Greater sweeps them all).
    const pre = Array.isArray(base.precast) ? base.precast.slice() : this._autoWards(base);   // explicit wards (boss or not) else derive from caster type/CR
    const preAC = (pre.includes('magearmor') ? 4 : 0) + (pre.includes('shield') ? 4 : 0) + (pre.includes('shieldoffaith') ? 3 : 0);
    const preTouch = pre.includes('shieldoffaith') ? 3 : 0;   // deflection counts vs touch; armor/shield bonuses don't
    return {
      uid: `e${++_uidSeq}`,
      // NAME: "Elite"/"Boss:" tells the player it's tougher; the raw advancement count
      // (the old " +3") is meaningless noise in combat lines and confusing over TTS
      // (Josh: "reported as Deathblade Monk +3 — the +3 doesn't matter"). Dropped from the
      // name; the level count still drives the stats via bossLevels below.
      name: boss ? `Boss: ${base.name}` : (extra ? `Elite ${base.name}` : base.name),
      glyph: base.glyph, art: base.tokenPool ? pick(base.tokenPool) : (base.art || null), artPos: base.artPos || null, boss,
      // Advanced CR, ROUNDED for display: a CR-1/3 (or 1/4, 1/2) creature advanced to Elite
      // used to stringify as "1.3333333333333335" and read that way in the inspector (Josh).
      // Round to 2 places → "1.33"; crToNum still parses it for XP/loot (negligible delta).
      cr: half ? String(Math.round(((base.crNum || 0) + half) * 100) / 100) : (base.cr || null),   // advanced CR (boss OR elite) → bigger XP + loot rolls
      bossLevels: extra,
      hype: base.hype || null,   // Maestro hype track (from the FVTT worlds) — plays when the boss room opens
      hp: Math.round(base.hp * (1 + 0.12 * extra)), maxHp: Math.round(base.hp * (1 + 0.12 * extra)),
      ac: base.ac + half + preAC,
      // PF1 AC types. touchAC: spells/firearms ignore armor & natural armor (an
      // optional per-monster `touch` overrides the heuristic). Flat-footed AC is
      // derived (−2, denied Dex) in _enemyAC. Refine per-monster touch values later.
      touchAC: (base.touch != null ? base.touch : Math.max(10, base.ac - 5)) + half + preTouch,
      precast: pre,                                         // pre-cast wards (chips + dispellable)
      shieldUp: pre.includes('shield'),                     // PF1 Shield: also IMMUNE to Magic Missile
      fireWard: pre.includes('protfire') ? Math.min(120, 12 * Math.max(10, (base.crNum || 10) + extra)) : 0,   // absorption pool, 12/CL
      toHit: base.toHit + extra,
      dmgDie: base.dmgDie, dmgCount: base.dmgCount || 1, dmgBonus: base.dmgBonus + half,
      fort: base.fort + Math.ceil(extra / 2), reflex: base.reflex + Math.ceil(extra / 2),
      align: base.align || 'NE', evil: !!base.evil, markedEvil: false, type: base.type || 'humanoid',
      flatFooted: true, prone: false, fascinated: false, asleep: false, loseTurn: false,
      paralyze: !!base.paralyze, paralyzeDC: (base.paralyzeDC || PARALYZE_DC) + half, sickened: 0,
      attacks: base.attacks || 1,
      atkSound: base.atkSound || null,
      atkSounds: base.atkSounds || null,
      caster: base.caster || null,
      spellDC: (base.spellDC || 13) + half,
      castsLeft: base.caster ? 2 + half : 0,
      // special shout attack (e.g. Skeletal Champion) — boss levels raise the DC + uses
      shout: base.shout ? { ...base.shout, dc: (base.shout.dc || 14) + half } : null,
      shoutsLeft: base.shout ? 2 + half : 0,
      // goblin barbarian: roars a taunt that pulls AI allies onto it
      taunt: base.taunt ? { ...base.taunt, dc: (base.taunt.dc || 13) + half } : null,
      tauntsLeft: base.taunt ? 1 : 0,
      hook: base.hook || null,             // barbed devil: chain hook → grapple + constrict
      // barbed devil hellfire / dragon breath — boss levels add dice, DC and uses
      hellfire: base.hellfire ? { ...base.hellfire, dc: (base.hellfire.dc || 18) + half, dice: (base.hellfire.dice || 5) + extra } : null,
      hellfireLeft: base.hellfire ? ((base.hellfire.uses || 2) + half) : 0,   // per-monster satchel size (the Bomb Devil packs 6)
      arcane: base.arcane || null,         // lich (wizard of its level): _lichCast adds bossLevels to its caster level
      arcaneLeft: base.arcane ? 3 + half : 0,
      summon: base.summon || null,         // Whispering Way: raises undead reinforcements onto the ENEMY side (see _enemySummon)
      summonLeft: base.summon ? ((base.summon.uses || 2) + half) : 0,
      // vampire (magus of its level): Vampiric Touch on its strike — boss = more dice
      spellstrike: base.spellstrike ? { ...base.spellstrike, dice: (base.spellstrike.dice || 4) + half } : null,
      // priestly foes mend their allies (see _enemyHeal) — boss priests heal harder, more often
      healer: base.healer ? { ...base.healer, dice: (base.healer.dice || 1) + half } : null,
      healsLeft: base.healer ? (base.healer.uses || 1) + half : 0,
      // rogue-types: sneak attack dice vs denied defenses (was never copied — latent
      // bug: enemy sneak attacks silently never fired). Boss rogues sneak harder.
      sneakDice: base.sneakDice ? base.sneakDice + half : 0,
      prayed: 0,                           // cleric Prayer: −1 to this enemy's attacks/damage/saves
      acid: null,                          // Acid Arrow lingering burn: { rounds, dice, die }
      resist: base.resist || null,         // energy resistances / vulnerabilities (see RESIST_BY_KEY)
      dr: (pre.includes('stoneskin') && !base.dr) ? 10 : (base.dr || 0),   // physical DAMAGE REDUCTION — number (DR/— / Stoneskin) or { amount, bypass } (see _physDR); a boss keeps its own DR over a pre-cast Stoneskin
      size: base.size || 'M',               // PF1 size category (S/M/L/H…) — trip & flavor (see MON_BODY)
      legs: (base.legs != null ? base.legs : 2),   // leg count — 0 = untrippable; >2 = +4 trip defense per extra leg
      flying: !!base.flying || pre.includes('fly'),   // airborne: immune to prone + "high ground" vs grounded foes (a pre-cast Fly can be DISPELLED — the boss crashes)
      evasion: !!base.evasion,             // rogues/monks: a made Reflex save vs an area effect = NO damage
      natural: !!base.natural,             // fights with natural weapons / unarmed (claws, bite, slams) → cannot be DISARMED
      detonate: base.detonate || null,     // fire skeleton: rushes in and blows itself up on its turn
      taunted: null,                       // barbarian Taunt: playerId it's compelled to attack next turn
      slowed: 0, _slowTick: 0,             // Slow spell: sluggish for N rounds, acts every other turn
      gold: Math.round(rint(base.gold[0], base.gold[1]) * (1 + 0.25 * extra)),   // an advanced boss carries a fatter pouch
    };
  }
  // SUMMON system (_abSummon allied summons + _enemySummon reinforcements) → game/dungeon/summons.js (grafted below).
  // NUMBER of foes scales with party SIZE — each hero past the first adds roughly
  // a full standard encounter's worth of monsters, so a packed party gets mobbed.
  _spawnRoom() {
    this.enemies = [];
    const boss = this.depth % BOSS_EVERY === 0;
    const encCR = this._encounterCR(boss);
    const partyN = Math.max(1, this.alivePresent().length);
    const sizeMult = Math.max(1, partyN - 1);   // 1→×1, 2→×1, 3→×2, 4→×3, 6→×5
    const keys = [];
    // ── GANGS ── the FIRST creature picked (the boss, or the first budget
    // fill) sets the room's theme; everything after fills from the same gang
    // pool — vampires bring the restless dead, a goblin brings the warband,
    // a minotaur brings its fellow horrors. Multi-gang monsters anchor ONE of
    // their gangs at random (an ogre room is goblinoid OR giant, not both).
    let roomGang;   // undefined = not set yet; null = wildcard anchor → mixed pack
    const adoptGang = (k) => {
      if (roomGang !== undefined || !k) return;
      const g = MON_GANGS[k];
      roomGang = (g && g.length) ? g[dRoll(g.length) - 1] : null;
    };
    // Fill an XP budget with creatures CR ≤ cap (and not trivially weak).
    const fill = (budget, floorCR, capCR, maxCount) => {
      let g = 0;
      while (keys.length < maxCount && budget > 100 && g++ < 80) {
        const key = this._pickForBudget(budget, floorCR, capCR, roomGang);
        if (!key) break;
        keys.push(key);
        adoptGang(key);
        budget -= rawXpForCR(MON[key].crNum);
      }
    };
    if (boss) {
      const bk = this._pickBoss(encCR);   // one strong foe — its gang themes the minions
      keys.push(bk);
      adoptGang(bk);
      // Barzillai Thrune NEVER rides alone — Rivozair, his devil-bound blue
      // dragon, descends with her master (and the dragon brings him along too).
      if (bk === 'barzillai' && MON.rivozair) keys.push('rivozair');
      else if (bk === 'rivozair' && MON.barzillai) keys.push('barzillai');
      // Boss rooms also mob a big party — minions at a notch below the room CR.
      const baseCR = this._minLevel() + Math.floor(this.depth / 4);
      fill(Math.round(rawXpForCR(baseCR) * Math.max(0, partyN - 1) * 0.6),
           Math.max(0.25, encCR - 6), Math.max(1, encCR - 2), 1 + partyN);
    } else {
      fill(Math.round(rawXpForCR(encCR) * sizeMult),
           Math.max(0.25, encCR - 4), encCR, Math.min(14, 4 + partyN * 2));
    }
    if (!keys.length) keys.push(pickByCR(this.depth));
    // ELITE ADVANCEMENT (Tobias: "+1-2 CR to any being by adding more levels"):
    // when a picked mook sits well below the room's CR, it sometimes shows up
    // as an ELITE (+2..4 levels → +1-2 CR: hp, to-hit, saves, DCs all rise).
    // Fills thin CR bands with tougher takes on creatures we already have.
    keys.forEach((k, i) => {
      const isBoss = boss && i === 0;
      const pairBoss = boss && i === 1 && ((keys[0] === 'barzillai' && k === 'rivozair') || (keys[0] === 'rivozair' && k === 'barzillai'));   // the Thrune pair are BOTH bosses
      const elite = !isBoss && !pairBoss && (encCR - MON[k].crNum >= 1.5) && dRoll(4) === 1 ? 1 + dRoll(3) : 0;
      this.enemies.push(this._makeEnemy(MON[k], isBoss || pairBoss, elite));
    });
    this._log('encounter', { depth: this.depth, minLevel: this._minLevel(), encCR, partyN, count: keys.length, gang: roomGang || 'mixed' });
  }
  _enemySummary() {
    const counts = {};
    for (const e of this.enemies) counts[e.name] = (counts[e.name] || 0) + 1;
    return Object.entries(counts).map(([n, c]) => (c > 1 ? `${c}× ${n}` : n)).join(', ') + '.';
  }
  _rollInitiative() {
    const order = [];
    // Characters add ½ their level (rounded down) to initiative, on top of the base +2.
    for (const m of this.alivePresent()) order.push({ kind: 'party', id: m.playerId, init: dRoll(20) + 2 + Math.floor((m.level || 1) / 2) + fighterFeats(m.cls, m.level, this._isRanged(m)).init + (this._isFlameCavalier(m) && (m.level || 1) >= 2 ? 4 : 0) });   // + fighter Improved Initiative + Order of the Flame FOOLHARDY RUSH (L2: moves during initiative → +4)
    for (const e of this.livingEnemies()) order.push({ kind: 'enemy', id: e.uid, init: dRoll(20) + 1 + (e.gloriousChallenge ? 4 : 0) });   // Order of the Flame FOOLHARDY RUSH (enemy parity): the sahuagin prince moves during initiative → +4
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
      // SUMMONED UNDEAD (Draymus's Summon Undead): an ally riding in the enemy
      // array — it strikes a REAL foe each turn and crumbles when its time runs out
      // (or at room end). Bypasses the enemy-condition logic below. (Phase 1: foes
      // don't yet target summons back — no soak.)
      if (e.summoned) {
        // Flavor the log by summon KIND: undead claw & crumble to dust; devils rend &
        // are banished back to Hell. (Jason's devil summons were wrongly logged as "undead".)
        const isDevil = e.summonFlavor === 'devil';
        const glyph = isDevil ? '😈' : '☠️';
        const kind = isDevil ? 'your devil' : 'your undead';
        const foes = this.livingEnemies().filter(x => !x.summoned && x.hp > 0);
        if (foes.length) {
          const prey = foes.slice().sort((a, b) => a.hp - b.hp)[0];   // finish the weakest first
          const r = this._monsterSwing(e, this._enemyAC(prey));
          if (r.hit) { this._dmgE(prey, r.damage); this._note(`${glyph} ${e.name} (${kind}) rends ${prey.name} for ${r.damage}!${prey.hp <= 0 ? ` ${glyph} Slain!` : ''}`, null, { side: 'party' }); }
          else this._note(`${glyph} ${e.name} (${kind}) ${isDevil ? 'lashes' : 'claws'} at ${prey.name} — and misses.`, null, { side: 'party' });
        } else {
          this._note(`${glyph} ${e.name} (${kind}) stands ready — no foe in reach.`, null, { side: 'party' });
        }
        e.summonExpiry = (e.summonExpiry || 1) - 1;
        if (e.summonExpiry <= 0) { e.hp = 0; this._note(`${glyph} ${e.name} ${isDevil ? 'is banished back to Hell — the pact expires' : 'crumbles back to dust — the summoning ends'}.`, null, { side: 'party' }); }
        this._broadcast(); return this._nextTurn();
      }
      // Darkness (wizard/sorcerer): shrouded foes can't act (and can't be hit) for
      // 2 of their turns. Tick it down here; the shroud lifts at 0.
      if (e.darkened > 0) { e.darkened -= 1; this._note(`🌑 ${e.name} is lost in magical darkness — does nothing${e.darkened <= 0 ? ' (the shroud lifts!)' : ''}.`, null, { side: 'enemy' }); this._broadcast(); return this._nextTurn(); }
      // Acid Arrow keeps eating away at the start of the foe's turn (whatever it
      // then does). If the acid finishes it off, its turn just ends.
      if (e.acid && e.acid.rounds > 0) {
        e.acid.rounds -= 1;
        const dealt = this._dmgE(e, Math.max(1, dRollN(e.acid.dice || 1, e.acid.die || 6)), 'acid');
        if (e.acid.rounds <= 0) e.acid = null;
        this._note(`🟢 Acid keeps sizzling on ${e.name} — ${dealt} acid${this._resistTag(e, 'acid')}.${this._afterEnemyHit(e)}`, null, { side: 'enemy' });
        if (e.hp <= 0) { this._broadcast(); return this._nextTurn(); }
      }
      if (e.blinded > 0) e.blinded -= 1;   // Glitterdust wears off (doesn't cost the turn — just −4 to hit / denied Dex while it lasts)
      if (e.fascinated) { this._note(`${e.glyph} ${e.name} ${e.asleep ? 'sleeps soundly' : 'stands fascinated'} — does nothing.`, null, { side: 'enemy' }); this._broadcast(); return this._nextTurn(); }
      // DOMINATED (hero magic): the foe fights FOR the party this turn — it turns
      // on its own allies. A fresh Will save each of its turns can shake the hold;
      // it also breaks if the dominator has fallen. (Dominate Phase A, 2026-07-03.)
      if (e.dominated > 0) {
        const dominator = this.member(e.dominatedBy);
        if (!dominator || dominator.left || dominator.hp <= 0) {
          e.dominated = 0; e.dominatedBy = null;
          this._note(`💫 ${e.name} shakes off the domination — its master has fallen.`, null, { side: 'enemy' });
        } else {
          const sv = this._saveVs(this._enemySave(e, 'will'), e.dominateDC || 15);
          if (sv.saved) {
            e.dominated = 0; e.dominatedBy = null;
            this._note(`💫 ${e.name} tears its will free of the domination! [Will ${sv.total} vs ${e.dominateDC || 15}]`, null, { side: 'enemy' });
          } else {
            e.dominated -= 1;
            const kin = this.livingEnemies().filter(x => x.uid !== e.uid && x.hp > 0);
            if (kin.length) {
              const prey = kin.slice().sort((a, b) => b.maxHp - a.maxHp)[0];
              const r = this._monsterSwing(e, this._enemyAC(prey));
              if (r.hit) { this._dmgE(prey, r.damage); this._note(`💫 ${e.name}, DOMINATED, savages its ally ${prey.name} for ${r.damage}!${prey.hp <= 0 ? ' ☠️ Slain!' : ''}`, null, { side: 'enemy' }); }
              else this._note(`💫 ${e.name}, DOMINATED, claws at its ally ${prey.name} — and misses.`, null, { side: 'enemy' });
            } else {
              this._note(`💫 ${e.name} stands slack under the domination — no allies left to turn on.`, null, { side: 'enemy' });
            }
            if (e.dominated <= 0) { e.dominatedBy = null; this._note(`💫 the domination on ${e.name} fades.`, null, { side: 'enemy' }); }
            this._broadcast(); return this._nextTurn();
          }
        }
      }
      if (e.paralyzed > 0) {
        if (e.heldDC) {   // Hold Person / Hideous Laughter: a NEW Will save each turn — costs the turn either way (PF1e).
          e.paralyzed -= 1; const hdc = e.heldDC;
          const sv = this._saveVs(this._enemySave(e, 'will'), hdc);
          if (sv.saved || e.paralyzed <= 0) { e.paralyzed = 0; e.heldDC = null; this._note(`🖐️ ${e.name} ${sv.saved ? 'wrenches free of the hold' : 'the hold finally fades'}! [Will ${sv.total} vs ${hdc}]${sv.saved ? ' — but the struggle cost its turn.' : ''}`, null, { side: 'enemy' }); }
          else this._note(`🖐️ ${e.name} stays HELD — struggles in vain and loses its turn. [Will ${sv.total} vs ${hdc}]`, null, { side: 'enemy' });
        } else { e.paralyzed -= 1; this._note(`🖐️ ${e.name} is paralyzed — loses its turn.`, null, { side: 'enemy' }); }
        this._broadcast(); return this._nextTurn();
      }
      // GRAPPLED (by a Promethean OR by Black Tentacles): helpless, loses its turn.
      // Each turn it may struggle free (its attack bonus vs the grappler's CMD); the
      // grip drops if the source is gone (grappler left/dead/un-shifted, or the
      // tentacle field has lapsed).
      if (e.grappled) {
        let cmd, srcGlyph = '🐙', stillHeld;
        if (e.grappledBy === 'tentacles') {
          const bt = this.blackTentacles; srcGlyph = '🦑';
          stillHeld = !!bt; cmd = bt ? 10 + bt.cmb : 0;
        } else {
          // A HERO holds the grip — either Promethean tentacles or a Grapple MANEUVER
          // (both set grappledBy = the hero's playerId). Held as long as that hero is
          // up; the foe rolls its CMB vs the grappler's CMD to slip free.
          const grappler = this.member(e.grappledBy);
          stillHeld = !!(grappler && !grappler.left && grappler.hp > 0);
          cmd = stillHeld ? this._heroCMD(grappler) : 0;
        }
        if (!stillHeld) { e.grappled = false; e.grappledBy = null; e.grappleRounds = 0; this._note(`${srcGlyph} ${e.name} wrenches loose — the grip releases it.`, null, { side: 'enemy' }); }
        else {
          e.grappleRounds = (e.grappleRounds || 1) - 1;
          const roll = dRoll(20), tot = roll + (e.toHit || 0);
          const broke = roll === 20 || tot >= cmd;
          if (broke || e.grappleRounds <= 0) { e.grappled = false; e.grappledBy = null; this._note(`${srcGlyph} ${e.name} ${broke ? 'tears free' : 'finally slips'} of the grapple! [Str ${tot} vs ${cmd}] — but the struggle cost its turn.`, null, { side: 'enemy' }); }
          else this._note(`${srcGlyph} ${e.name} is held fast — helpless, loses its turn. [Str ${tot} vs ${cmd}]`, null, { side: 'enemy' });
          this._broadcast(); return this._nextTurn();
        }
      }
      if (e.loseTurn) { e.loseTurn = false; this._note(`${e.glyph} ${e.name} is off-balance — loses its turn.`, null, { side: 'enemy' }); this._broadcast(); return this._nextTurn(); }
      if (e.nauseated > 0) { e.nauseated -= 1; this._note(`${e.glyph} ${e.name} retches — nauseated, loses its turn.`, null, { side: 'enemy' }); this._broadcast(); return this._nextTurn(); }
      // Slow (PF1 STAGGERED): the creature still acts every turn — the single-
      // action limit (move OR attack, never both, never a full attack) is
      // enforced down in _enemyAct's action economy. Just tick the duration.
      if (e.slowed > 0) e.slowed -= 1;
      // Death domain — Bleeding Touch: the wound bleeds 1d6 at the top of each
      // of the foe's turns until it drops (PF1 bleed, no heal-check sim).
      if (e._bleeding && e.hp > 0) {
        const b = dRoll(6);
        this._dmgE(e, b, 'bleed');
        this._note(`🩸 ${e.glyph} ${e.name} BLEEDS for ${b}.${e.hp <= 0 ? ' ☠️ It collapses in a pool of its own blood!' : ''}`, null, { side: 'enemy' });
        if (e.hp <= 0) { this._broadcast(); return this._nextTurn(); }
      }
      this._stepTimer = setTimeout(() => { this._withSide('enemy', () => this._enemyAct(e)); this._nextTurn(); }, aiStepMs(e));
      this._broadcast();
      return;
    }
    // party member
    const m = this.member(t.id);
    if (!m || m.left) return this._nextTurn();
    // Black Tentacles renew their grip on the CASTER'S turn only (not at round-top) —
    // the field re-grabs when its conjurer acts (free; doesn't cost the turn).
    if (this.blackTentacles && this.blackTentacles.caster === m.playerId && m.hp > 0) this._blackTentaclesTick();
    m._curatorBuffUsed = false;   // Curator: the once-per-turn swift buff resets each turn
    m._swiftUsed = false;         // PF1: ONE swift action per turn (shared by Curator / Quicken Channel / metamagic Quicken)
    if (m.untargetable) m.untargetable = false;   // Bladed Dash blur ends at the start of the magus's next turn
    if (m._tpStrike > 0) m._tpStrike -= 1;         // Dimension Door/Teleport strike-window ticks down at the recipient's turns
    for (const x of this.present()) if (x.blinkedBy === m.playerId) x.blinkedBy = null;   // the CASTER's turn arrived — their blinked allies become targetable again
    if (m.touchStrike > 0) m.touchStrike -= 1;     // Dimensional Blade touch-strikes lapse after the round
    if (m._domWardRounds > 0) m._domWardRounds -= 1;   // Resistant Touch (Protection domain) ticks down
    // Bleeding (a death-priest's touch): 1d6 at the turn's top until magically healed.
    if (m._bleeding && m.hp > 0 && !m.dead) {
      const b = dRoll(6);
      m.hp -= b;
      this._note(`🩸 ${m.nickname} BLEEDS for ${b} — magical healing will staunch it. (${Math.max(0, m.hp)}/${m.maxHp} HP)`);
      if (m.hp <= -10) { this._memberDown(m); this._broadcast(); return this._nextTurn(); }
      if (m.hp <= 0)   { this._downMember(m); this._broadcast(); return this._nextTurn(); }
    }
    if (m.blinded > 0) m.blinded -= 1;             // (heroes can be blinded by future foes too)
    // Infernal Healing (Greater): fast healing at the START of the turn — BEFORE the
    // down/skip check, so it can knit a dying ally (below 0 HP) back onto their feet.
    if (m.infernalHeal > 0 && !m.dead && m.hp < m.maxHp) {
      const before = m.hp; m.hp = Math.min(m.maxHp, m.hp + m.infernalHeal);
      const gained = m.hp - before;
      // Only narrate the IMPORTANT case (a revive). The routine per-turn tick applies
      // SILENTLY — narrating every hero's regen each turn was "updates of everyone's
      // hp" chatter (Josh: tell me it happened, I'll check HP on my turn).
      if (before <= 0 && m.hp > 0) { m.downed = false; this._note(`🩸 ${m.nickname}'s infernal ichor knits ${gained} HP — back on their feet!`); }
    }
    if (m.hp <= 0) {
      // Orc / half-orc FEROCITY: keep fighting at 0 HP and below (until slain at
      // −10) — take the turn normally instead of dropping.
      if (this._hasFerocity(m) && !m.dead && m.hp > -10) {
        this._note(`💢 ${m.nickname} fights on through the wounds — Ferocity! (${m.hp} HP)`);
        this._broadcast();
      }
      // A DOWNED (but not dead) paladin refuses to fall: on their turn, Hero's
      // Defiance auto-fires — a lay-on-hands heal that brings them back to their
      // feet, after which they take their turn normally (it's an immediate action
      // in PF1). If it's unavailable/used or fails, the turn is skipped as usual.
      else if (m.dead || !this._tryHeroesDefiance(m)) return this._nextTurn();
      else this._broadcast();   // back up — fall through and act this turn
    }
    // Spiritual Weapon fights independently — it strikes at the start of the
    // cleric's turn (even if they're held), then the cleric does their own thing.
    if (m.spiritWeapon && m.spiritWeapon.rounds > 0) { this._spiritWeaponStrike(m); if (this._endIfResolved()) return; }
    if (m.paralyzed > 0) {
      if (m.heldDC) {   // Hold Person on a hero: re-save each turn, costs the turn either way (PF1e).
        m.paralyzed -= 1; const hdc = m.heldDC;
        const sm = this._partySaveMod(m, ['enchantment', 'spell']), sroll = dRoll(20), stot = sroll + sm;   // Hold is a compulsion spell
        const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= hdc;
        if (saved || m.paralyzed <= 0) { m.paralyzed = 0; m.heldDC = null; this._note(`🖐️ ${m.nickname} ${saved ? 'breaks free of the hold' : 'the hold finally fades'}! [Will d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs ${hdc}]${saved ? ' — but the struggle cost the turn.' : ''}`); }
        else this._note(`🖐️ ${m.nickname} stays HELD — can't break free and loses the turn. [Will d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs ${hdc}]`);
      } else { m.paralyzed -= 1; this._note(`🥶 ${m.nickname} is paralyzed — loses the turn.`); }
      this._broadcast(); return this._nextTurn();
    }
    if (m.stunned > 0) { m.stunned -= 1; this._note(`😵 ${m.nickname} is stunned — loses the turn.`); this._broadcast(); return this._nextTurn(); }
    if (m.nauseated > 0) { m.nauseated -= 1; this._note(`🤮 ${m.nickname} is nauseated — can only retch, loses the turn.`); this._broadcast(); return this._nextTurn(); }
    // PRONE (tripped / bull-rushed by a foe): standing is a MOVE action — the hero
    // clambers up at the start of their turn and still acts (keeps their standard).
    // They were only easier to hit while down, between turns.
    if (m.prone) { m.prone = false; this._note(`🧍 ${m.nickname} clambers back to their feet (a move action).`); this._broadcast(); }
    // GRAPPLED by a foe: a PENALTY, not a lost turn (PF1 — they can still act at
    // −2 to hit, and are easier to hit). They struggle at the top of the turn: a
    // CMB check (DEX-or-STR homerule) vs the grappler's CMD breaks it; the grip
    // also lapses if the grappler is gone or after ~2 rounds. Dispel/Grease free
    // them early (see _abCleanse / _abGrease). They take their turn either way.
    if (m.grappled && this._fomSpend(m, 'the grapple')) {
      m.grappled = false; m.grappledBy = null; m.grappleRounds = 0;
    } else if (m.grappled) {
      const grappler = this.enemies.find(x => x.uid === m.grappledBy && x.hp > 0);
      if (!grappler) { m.grappled = false; m.grappledBy = null; m.grappleRounds = 0; this._note(`🤼 ${m.nickname} is free — nothing holds them anymore.`); }
      else {
        m.grappleRounds = (m.grappleRounds || 1) - 1;
        const cmb = this._heroCMB(m), cmd = this._enemyCMD(grappler);
        const broke = cmb >= cmd;
        if (broke || m.grappleRounds <= 0) { m.grappled = false; m.grappledBy = null; this._note(`🤼 ${m.nickname} ${broke ? 'breaks' : 'finally wrenches'} free of ${grappler.name}'s grapple! [CMB ${cmb} vs CMD ${cmd}]`); }
        else this._note(`🤼 ${m.nickname} is caught in ${grappler.name}'s grip — −2 to hit until they break free. [CMB ${cmb} vs CMD ${cmd}]`);
      }
      this._broadcast();
    }
    if (m.sickened > 0) m.sickened -= 1;
    if (m.slowed > 0) { m.slowed -= 1; this._note(`🐌 ${m.nickname} is slowed — a single action only this turn.`); }
    if (m.judgment === 'healing' && m.hp > 0 && m.hp < m.maxHp) {   // Judgement: Healing regen each turn — applies SILENTLY (routine per-turn regen; Josh: don't narrate every tick)
      const h = Math.max(1, Math.floor((m.level || 1) / 3)); m.hp = Math.min(m.maxHp, m.hp + h);
    }
    if (m.isBot && this._fleeing) {
      // The party is in RETREAT (a human fled with no human left to lead) — the
      // hireling grabs its share and flees too, on its own turn (Josh: "if the
      // humans flee, the AI should flee, if they live that long"). bail() banks
      // the share, advances the turn, and group-extracts the rest once the field
      // empties.
      this._stepTimer = setTimeout(() => { try { this.bail(m.playerId); } catch (_) { this._nextTurn(); } }, aiStepMs(m));
      this._broadcast();
    }
    else if (m.isBot) { this._stepTimer = setTimeout(() => { this._allyAct(m); this._nextTurn(); }, aiStepMs(m)); this._broadcast(); }
    else if (m.queuedAction) {
      // ── ACTION QUEUE ── the player pre-loaded this turn: fire it after a
      // short beat (the board visibly becomes their turn first). If it fizzles
      // (target gone, slot spent), the turn is handed back to the player live.
      const q = m.queuedAction; m.queuedAction = null;
      this._note(`⏳ ${m.nickname}'s pre-loaded ${q.label} triggers!`);
      this._stepTimer = setTimeout(() => {
        if (this.status !== 'combat' || this._currentActorId() !== m.playerId) return;   // room/run resolved in the beat
        const r = this.action(m.playerId, q.kind, q.payload);
        if (!r || r.ok === false) {
          this._note(`⏳ ${m.nickname}'s queued ${q.label} fizzled${r && r.error ? ` (${r.error})` : ''} — act now!`);
          this._armAfkTimer(m); this._broadcast();
        }
      }, 900);
      this._broadcast();
    }
    else { this._armAfkTimer(m); this._broadcast(); }   // human — wait for input
  }
  _nextTurn() {
    if (this._endIfResolved()) return;
    this.turnIdx += 1;
    // Initiative is rolled ONCE per combat (per room, in openDoor) — Pathfinder
    // keeps the same order each round; we just wrap back to the top.
    if (this.turnIdx >= this.turnOrder.length) { this.turnIdx = 0; this.round += 1; this._endOfRoundRaise(); }   // the fallen are raised between rounds (Black Tentacles re-grab on the CASTER'S turn, not at round-top)
    this._advanceToActor();
  }
  _armAfkTimer(m) {
    clearTimeout(this._turnTimer);
    // Stamp when this human auto-acts, so their card can show a live countdown.
    m.afkDeadline = Date.now() + AFK_PASS_MS;
    this._turnTimer = setTimeout(() => {
      m.afkDeadline = null;
      // Time's up → swing rather than waste the turn. (Class-aware target pick.)
      const foes = this.livingEnemies();
      if (foes.length) {
        this._note(`⏱️ ${m.nickname} hesitates too long — auto-attacks!`);
        const tgt = this._preferredFoe(m, foes);
        if (tgt) this._basicAttack(m, tgt.uid);
        this._hasteBonus(m);
      } else {
        this._note(`💤 ${m.nickname} is idle — passes.`);
      }
      this._broadcast();
      this._nextTurn();
    }, AFK_PASS_MS);
  }

  // ── Resolution / run-over ────────────────────────────────────────────────
  _anyUp() { return this.party.some(m => !m.left && !m.dead && m.hp > 0); }           // someone able to fight
  _humansInRun() { return this.party.some(m => !m.isBot && !m.left && !m.dead); }     // includes the downed/dying
  _endIfResolved() {
    if (this.status !== 'combat') return true;
    // Clear FIRST — clearing a room can drop a Cure potion that revives a downed ally.
    // SUMMONED undead (the party's own minions) don't count — the room is won when the
    // real foes are down, even if a summon is still shambling around.
    if (this.livingEnemies().every(e => e.summoned)) { this._clearRoom(); return true; }
    // Nobody left standing (all downed or dead) while foes remain → party wipe.
    if (!this._anyUp()) { this._wipe(); return true; }
    // NOTE: when no humans remain mid-fight we deliberately do NOT cash the AI out
    // here — they FINISH the current room first. The wrap-up happens on the room
    // clear (_clearRoom) or a wipe (above), so the AI leave at the end of the room.
    return false;
  }
  // Pay remaining AI allies (standing OR dying — the downed get their cut too) an
  // even share of what's left, announce it, then end.
  _wrapUp() {
    if (this.status === 'over') return;
    if (this.status === 'combat') this._runFailed = true;   // last human fell mid-fight (room unwon) → gear loss
    const allies = this.party.filter(m => m.isBot && !m.left && !m.dead);
    const share = allies.length ? Math.floor(this.runGold / allies.length) : 0;
    for (const m of allies) {
      if (share > 0) { const p = db.getPlayer(m.playerId); if (p) db.setChips(m.playerId, p.chips + share); this.runGold -= share; }
      m.left = true;
      this._note(`${m.downed ? '🩸' : '🤖'} ${m.nickname} ${m.downed ? 'is dragged out of' : 'returns from'} the dungeon with ${share} gp.`);
      this._log('ally_payout', { who: m.playerId, share, downed: !!m.downed });
      this._emitMemberExit(m, { reason: 'bailed', goldBanked: share, ai: true });
    }
    this._runOver();
  }
  // The last conscious member bailed → any allies still down are hauled out too,
  // each banking an even share. (A voluntary retreat, NOT a combat wipe.)
  _groupExtract() {
    if (this.status === 'over') return;
    if (this.status === 'combat') this._runFailed = true;   // fled an uncleared room with no one left to win it → gear loss
    const members = this.party.filter(m => !m.left && !m.dead);
    if (!members.length) return this._runOver();
    const share = Math.floor(this.runGold / members.length);
    for (const m of members) {
      if (share > 0) { const p = db.getPlayer(m.playerId); if (p) db.setChips(m.playerId, p.chips + share); this.runGold -= share; }
      m.left = true;
      this._note(`🩸 ${m.nickname} is dragged out of the dungeon with ${share} gp.`);
      this._log('extract', { who: m.playerId, share });
      this._emitMemberExit(m, { reason: 'bailed', goldBanked: share, ai: m.isBot });
    }
    this._runOver();
  }
  // Downed allies bleed 1 HP each room — heal or extract them before they hit −10.
  _bleedDowned() {
    for (const m of this.party.filter(x => !x.left && !x.dead && x.hp <= 0)) {
      m.hp -= 1;
      if (m.hp <= -10) { this._note(`🩸 ${m.nickname} bleeds out…`); this._memberDown(m); }
      else this._note(`🩸 ${m.nickname} bleeds — ${m.hp} HP (slain at −10).`);
    }
  }
  // Between rooms (out of combat): a present cleric or oracle brings back the SLAIN.
  // Resurrection (full HP, level restored) is preferred over Raise Dead (1 HP, the lost
  // level stays lost). Each cast spends a slot; we loop until no corpse remains or nobody
  // can cast. (Auto-cast — the party always saves a fallen comrade if able.)
  // The DEAD are a non-factor while a round is running — no healer wastes a
  // combat turn on them. But as the round TURNS, a healer who still holds Raise
  // Dead / Resurrection (or a druid's Reincarnate) performs the ritual between
  // turns, so the fallen stand again for the new round (the raise sound marks
  // the moment). One raise per round-turn — the rest wait for the next.
  _endOfRoundRaise() {
    if (this.status !== 'combat') return;
    if (!this.party.some(c => c.dead && !c.left)) return;
    const caster = this.party.find(c => !c.left && !c.dead && c.hp > 0
      && !(c.paralyzed > 0) && !(c.stunned > 0) && this._raiseSlotFor(c) != null);
    if (!caster) return;
    this._roundRaise = true;   // lets the ritual through _useAbility's in-combat block
    try { this._useAbility(caster, this._raiseSlotFor(caster), {}); }
    finally { this._roundRaise = false; }
  }
  _endOfRoomRaise() {
    let guard = 16;
    while (guard-- > 0 && this.party.some(c => c.dead && !c.left)) {
      const caster = this.party.find(c => !c.left && !c.dead && c.hp > 0 && this._raiseSlotFor(c) != null);
      if (!caster) break;
      const idx = this._raiseSlotFor(caster);
      const r = this._useAbility(caster, idx, {});
      if (!r || r.ok === false) break;   // couldn't cast — stop (avoid a spin)
    }
  }
  // Index of the best available Raise-Dead-type prayer a member can cast right now
  // (prefers Resurrection / full over Raise Dead), or null if they have none ready.
  _raiseSlotFor(m) {
    const kit = kitFor(m.cls);
    if (!kit || !kit.abilities) return null;
    const lvl = m.level || 1;
    const ready = (ab) => ab && ab.effect === 'revive' && ab.raiseDead
      && lvl >= (ab.minLevel || 1)
      && (ab.cost !== 'slot' || ((m.slots && m.slots[ab.slvl]) || 0) > 0)
      && (ab.cost !== 'room' || ((m.abilityUses && m.abilityUses[ab.key]) || 0) > 0)
      && (ab.cost !== 'pool' || (m.spellPool || 0) > 0);
    let bestIdx = null, bestFull = -1;
    kit.abilities.forEach((ab, i) => {
      if (!ready(ab)) return;
      const f = ab.full ? 1 : 0;
      if (f > bestFull) { bestFull = f; bestIdx = i; }
    });
    return bestIdx;
  }
  _clearRoom() {
    clearTimeout(this._turnTimer); clearTimeout(this._stepTimer);
    this.status = 'exploring';
    const gold = this.enemies.reduce((s, e) => s + (e.gold || 0), 0);
    this.runGold += gold;
    // Each end-of-room block stamps its notes with a SECTION (see _note's phase) so
    // the blind stop key can skip section-by-section: loot → xp → level-ups (Josh).
    this._notePhase = 'xp';
    this._note(`✨ Room cleared! +${gold} gp (pool ${this.runGold} gp).`);
    this._notePhase = null;
    this._log('clear', { gold, runGold: this.runGold });
    // END-OF-ROOM ORDER (Josh, blind-tester flow): loot roll FIRST (so a blind player
    // hears the prompt and can roll before the rest of the report scrolls past), THEN
    // XP + money, and LEVEL-UPS LAST so they are never cut off by the loot prompt.
    this._notePhase = 'loot';
    this._maybeDropLoot();       // loot roll prompt up front
    this._notePhase = null;
    this._maybeDropPotion();     // can revive a downed ally before they bleed
    this._endOfRoomRaise();      // a cleric/oracle raises the SLAIN now the fight is over
    this._notePhase = 'xp';
    this._awardRoomXp();         // PF1 XP for the vanquished foes + LEVEL-UPS (announced last)
    this._notePhase = null;
    this._bleedDowned();         // the still-dying lose 1 HP this room (toward −10)
    if (!this._humansInRun()) { this._wrapUp(); return; }   // last human bled out → AI allies cash out
    this._broadcast();
  }
  // Grant standard PF1 XP for the foes cleared this room, split EQUALLY among every
  // ally still in the dungeon — alive, downed, or DEAD-awaiting-revival (they fought
  // for this room too; PF1 practice gives dead PCs the encounter's XP). The killing
  // blow never matters: there is no per-kill XP anywhere, only this even room split.
  // Persisted per player (humans AND bots level the same way).
  _awardRoomXp() {
    const roomXp = this.enemies.reduce((s, e) => s + xpForCR(crToNum(e.cr)), 0);
    if (roomXp <= 0) return;
    const recips = this.party.filter(m => !m.left);   // alive + downed + dead-but-revivable; only bailers miss out
    if (!recips.length) return;
    const per = Math.floor(roomXp / recips.length);
    if (per <= 0) return;
    const ups = [];
    for (const m of recips) {
      const from = m.level || 1;
      const newXp = db.addXp(m.playerId, per);
      if (this._applyLevelFromXp(m, newXp) > 0) ups.push({ m, from, to: m.level });
    }
    this._note(`✨ Foes vanquished — the party earns ${roomXp} XP (${per} each).`);
    this._notePhase = 'levelup';   // level-ups are their own skippable section (Josh)
    for (const u of ups) this._announceLevelUp(u.m, u.from, u.to);
    this._notePhase = 'xp';        // caller (_clearRoom) resets to null
  }
  // What a hero GAINS going from level `from` to `to` — BAB/HP/saves deltas,
  // feats crossed, new abilities/spells unlocked, new spell-slot levels. Shared
  // by the level-up announcement and the class-progression reference (Josh:
  // "what does each level give me" — the blind X key).
  _levelGains(m, from, to) {
    const cls = m.cls;
    const parts = [];
    const babD = babFor(cls, to) - babFor(cls, from);
    if (babD > 0) parts.push(`BAB +${babD}`);
    parts.push(`+${maxHpFor(cls, to) - maxHpFor(cls, from)} HP`);
    const sv = ['fort', 'ref', 'will'].reduce((a, w) => a + (saveFor(cls, w, to) - saveFor(cls, w, from)), 0);
    if (sv > 0) parts.push(`saves +${sv}`);
    const feats = [];
    const featNames = (RANGED_FEAT_CLASSES.has(cls) && this._isRanged(m)) ? RANGED_FEAT_AT
                    : (cls === 'paladin' || cls === 'antipaladin') ? PALADIN_FEAT_AT : cls === 'druid' ? DRUID_FEAT_AT
                    : (cls === 'wizard' || cls === 'sorcerer' || cls === 'witch') ? CASTER_FEAT_AT
                    : CLASS_FEAT_AT[cls] || FEAT_AT;
    for (let g = gatingLevel(cls, from) + 1; g <= gatingLevel(cls, to); g++) if (featNames[g]) feats.push(featNames[g]);
    if (feats.length) parts.push(`feat: ${feats.join(', ')}`);
    const kit = kitFor(cls), spells = [];
    if (kit && kit.abilities) for (const ab of kit.abilities) if (ab.minLevel && ab.minLevel > from && ab.minLevel <= to) spells.push(ab.name);
    const s0 = slotsFor(cls, from, m.castingMod) || {}, s1 = slotsFor(cls, to, m.castingMod) || {};
    const newSlot = Object.keys(s1).filter(L => !s0[L]).map(L => `${L}${({ 1: 'st', 2: 'nd', 3: 'rd' })[L] || 'th'}-level`);
    if (newSlot.length) parts.push(`new ${newSlot.join(' & ')} spell slots`);
    if (spells.length) parts.push(`spells: ${spells.slice(0, 4).join(', ')}`);
    return parts;
  }
  // Announce a level-up with a short summary of what the hero gained.
  _announceLevelUp(m, from, to) {
    const cls = m.cls;
    const gains = this._levelGains(m, from, to);
    const parts = gains.length ? gains : ['steady growth'];
    this._note(`⭐ LEVEL UP! ${m.nickname} reaches level ${to} (${cls})! ${parts.join(' · ')}`, '/audio/spell_channel_charge.mp3');
    this._echoToTable('/audio/spell_channel_charge.mp3');
    this._log('levelup', { who: m.playerId, from, to });
  }
  _runOver() {
    clearTimeout(this._turnTimer); clearTimeout(this._stepTimer); clearTimeout(this._lootTimer);
    this.lootRoll = null;
    if (this._runFailed) this._loseAllGear();   // no-win wipe / full retreat → the party loses all gear
    // Any hero still DEAD when the run ends never got revived: lock in the death penalty
    // and surface them back to the table (they were spectating the run until now).
    for (const m of this.party) {
      if (m.left || !m.dead) continue;
      this._applyDeathPenalty(m);
      this._emitMemberExit(m, { reason: 'dead', goldBanked: 0 });
      m.left = true;
    }
    this.status = 'over';
    this._broadcast();
    if (this._onEmpty) try { this._onEmpty(); } catch (_) {}
  }
  // No-win wipe / full retreat from an UNCLEARED room: every participant loses ALL
  // gear (had even one hero cleared the room, they'd have hauled the loot upstairs
  // — but nobody did). Gear no longer drives level, so this costs equipment power
  // (to-hit / AC / damage), not levels.
  _loseAllGear() {
    let any = false;
    for (const m of this.party) {
      // Only members who DIED in the dungeon (dead, still in the run) forfeit gear.
      // Anyone who got OUT — bailed, fled, or disconnected/reloaded (m.left) — keeps
      // everything. A browser reload must NEVER wipe a player's gear (see Josh's bug).
      if (m._gearLost || m.left || !m.dead) continue;
      m._gearLost = true; any = true;
      try { db.setGear(m.playerId, {}); } catch (_) {}
      m.gear = {};
    }
    this.pendingLoot = [];
    if (any) this._note('💀 No one survived to win the room — the fallen LOSE THEIR GEAR to the dungeon.');
  }
  // (loot drops / roll-offs / potions moved to game/dungeon/loot.js — Phase-2 seam 1)
  // ── Combat math (rolls shown in the log) ─────────────────────────────────
  _fmtBonus(n) { return (n >= 0 ? '+' : '') + n; }
  // Recompute a member's level + HP from current gear (level = 1 + gear bonuses).
  // (_xpInfo moved to game/dungeon/serialize.js — Phase-2 seam 2)
  // Apply a hero's level + HP from their XP total — handles level UP (room-clear
  // awards) and the death-penalty level DOWN. Returns the signed level delta.
  _applyLevelFromXp(m, xp) {
    m.xp = xp;
    const nl = levelFromXp(xp);
    const old = m.level || 1;
    if (nl === old) return 0;
    const _featHp = (fighterFeats(m.cls, nl, this._isRanged(m)).hp) || 0;
    const nmax = deriveCharacter({ cls: m.cls, level: nl, baseScores: m.abilityScores, raceMods: RACES.raceModsFor(m.race, m.abilityScores, m.flexStat), featHp: _featHp }).hp;
    const gain = nmax - m.maxHp;
    m.level = nl; m.maxHp = nmax;
    this._setDerived(m);                    // refresh ability mods / iteratives at the new level
    this._computeCastable(m);               // PHASE C: new level → default loadout may unlock more prepared/known spells
    if (gain > 0) m.hp += gain;             // level up heals the new HP
    else if (m.hp > nmax) m.hp = nmax;      // level down caps current HP to the new max
    return nl - old;
  }
  // HASTE's secondary bonuses (PF1): +1 to attack rolls, +1 dodge AC, +1 Reflex —
  // active ONLY while the FULL Haste spell is up (m.hasteFull), NOT for Blessing of
  // Fervor's extra-attack-only choice. A flat +1 gated on `hasted` means it can't
  // stack with itself and ends exactly when Haste does. (Engine saves are generic,
  // so the Reflex bonus reads as +1 to all saves — a small, benign approximation.)
  _hasteMod(m) { return (m && m.hasted > 0 && m.hasteFull) ? 1 : 0; }
  _partySaveMod(m, tags) { return (m.level || 1) + ((m.buffs && m.buffs.save) || 0) + fighterFeats(m.cls, m.level, this._isRanged(m)).save + this._hasteMod(m) + RACES.raceSaveBonus(m.race, tags) - (m.sickened > 0 ? SICKENED_PENALTY : 0) - (m.slowed > 0 && tags && tags.includes('reflex') ? 1 : 0) + (m._domWardRounds > 0 ? 2 : 0); }   // saves scale with level (+ rage's +Will, + fighter save feats, + Haste's +1 Reflex, + racial save bonuses: flat 'all' always, typed only when tagged; Slow drags Reflex −1 — PF1; Resistant Touch (Protection domain) +2 while warded)
  // How much a hero's AC is lowered right now: sticky penalty (rage) + a
  // this-turn penalty (reckless / barbarian cleave drop their guard).
  _acPenalty(m) { return ((m.buffs && m.buffs.acPen) || 0) + (m.acPenRound === this.round ? (m.acPenAmt || 0) : 0) + (m.grappled ? 2 : 0) + (m.gloriousAC || 0); }   // gloriousAC: Order of the Flame recklessness (−2 per consecutive glorious challenge this room)
  // Is this hero fighting with two weapons (a double/dual weapon, or a rogue's
  // paired daggers)? Drives Two-Weapon Defense and the TWF attack sequence.
  _isDualWielding(m) {
    const w = m.weapon || weaponOf(m.gear, m.weaponKey);
    // Monk FLURRY OF BLOWS: any melee attack is a two-strike flurry (their free
    // TWF/ITWF flags in monkFeats keep the penalty at −2/−2 like real Flurry).
    if (m.cls === 'monk' && w && !w.ranged) return true;
    return !!(w && (w.dual || (isSneakClass(m.cls) && (m.weaponKey === 'dagger' || m.weaponKey === 'kukri'))));
  }
  _acBonus(m) {   // magus Shield (+4) + inquisitor Judgement: Protection + fighter Dodge (+1) + Haste (+1 dodge)
    let b = ((m.buffs && m.buffs.ac) || 0) + (m.mageArmor ? 4 : 0) + (m.judgment === 'protection' ? Math.max(1, Math.floor((m.level || 1) / 3)) : 0) + fighterFeats(m.cls, m.level, this._isRanged(m)).ac + this._hasteMod(m) + (m._offDef ? 2 : 0) + (m._fdAc || 0);   // rogue Offensive Defense: +2 AC after a sneak hit; _fdAc: Fight Defensively dodge bonus
    if (fighterFeats(m.cls, m.level, this._isRanged(m)).twDef && this._isDualWielding(m)) b += 1;   // Two-Weapon Defense
    // Celeb of Nethys wears NO armor but weaves the god's arcane-divine balance into
    // his defense — he adds BOTH his Dexterity AND his Wisdom modifier to AC (a monk-
    // like unarmored defense). Stacks with his auto-cast Mage Armor (+4) and Shield.
    if (m.playerId === 'celeb' && m.mods) b += (m.mods.dex || 0) + (m.mods.wis || 0);
    // DEFLECTION (Shield of Faith) does NOT stack with a Ring of Protection (also
    // deflection) — take the HIGHER. acOf() already adds the ring's deflection, so
    // here we add only the EXCESS of the spell's deflection over the ring.
    const ringDef = Number(m.gear && m.gear.ring) || 0;
    b += Math.max(0, ((m.buffs && m.buffs.deflect) || 0) - ringDef);
    return b;
  }
  // A hero's three PF1 AC values (base, no situational mods) — for display + touch
  // resolution. touch drops armor/shield/mage-armor; flat-footed drops Dodge.
  // acOf for a hero, weapon-aware: a RANGED weapon (bow/crossbow/gun) or a
  // dual-wield/no-shield weapon grants no shield AC (they can still own the shield
  // for its treasure value). Centralizes the shield-AC exclusion in one place.
  _acOf(m) {
    const w = m.weapon || weaponOf(m.gear, m.weaponKey);
    // A BASHING SHIELD (w.shieldAC — J'Mal's Dragon Shield) grants intrinsic shield AC:
    // its base + its own enhancement (the owned shield tier, if any). We route it through
    // opts.shieldBonus and suppress the normal gear-shield path so it isn't double-counted.
    const wShield = (w && w.shieldAC) || 0;
    const shieldBonus = wShield ? (wShield + (Number(m.gear && m.gear.shield) || 0)) : 0;
    const noShield = !!(w && (w.noShield || w.ranged)) || wShield > 0;
    return acOf(m.gear, m.cls, { noShield, shieldBonus, noArmor: (m.playerId === 'celeb') });   // Celeb of Nethys wears no armor
  }
  // (_heroACs moved to game/dungeon/serialize.js — Phase-2 seam 2)
  _atkStr(r) {
    // A roll that BEAT the AC but was foiled by the foe's defenses shouldn't print
    // "[40 vs AC 19]" as if the math failed — say what actually stopped it (Tobias:
    // "the calculation does not make sense"). Mirror image / concealment, not a miss.
    if (r && r.image)   return '— a mirror-image decoy soaks the hit (not the real foe).';
    if (r && r.conceal) return '— the foe is UNSEEN: 50% concealment foils it (True Seeing / blindsense pierces it).';
    return `[d20 ${r.roll} ${this._fmtBonus(r.toHit)} = ${r.total} vs AC ${r.ac}]`;
  }
  // FLANK bookkeeping (Tobias 2026-07-04): record this MELEE hero on the foe and
  // report whether an ally is already in melee with it → this attacker is flanking
  // (the first to close is alone; everyone who joins that foe afterward flanks).
  // Melee + hero only; tracked per-room on the foe object (fresh each room).
  _flankRegister(attacker, target, weapon) {
    if (!(attacker && attacker.playerId && weapon && !weapon.ranged && target)) return false;
    target._meleeBy = target._meleeBy || new Set();
    const flanking = [...target._meleeBy].some(id => id !== attacker.playerId);
    target._meleeBy.add(attacker.playerId);
    return flanking;
  }
  _swingVsAC(attacker, ac, target, extraToHit = 0, offHand = false) {
    const weapon = attacker.weapon;
    if (weapon && !weapon.ranged) attacker._lastMeleeRound = this.round;   // "melee weapon is OUT" this round — drives Jason's Force Push (ally free attacks)
    const sick = attacker.sickened > 0 ? SICKENED_PENALTY : 0;
    const lvl = attacker.level || 1;
    const cls = attacker.cls || 'fighter';
    // Strength Surge (domain): +½ level hit & damage on ONE attack — consumed by
    // THIS swing whether it lands or not (a Good Fortune reroll restores it first).
    const _dStrike = attacker._domStrike || 0;
    if (_dStrike) attacker._domStrike = 0;
    // MAGUS Arcane Pool — an automatic, level-scaled weapon enhancement (the magus
    // is always treated as wielding at least this grade): +1@1, +2@5, keen@6,
    // flaming@8, +3@9, flaming burst@11, +4@13, +5@17. The real weapon's enchant
    // wins if it's higher; keen/flaming layer on top.
    let arcEnhDelta = 0, arcKeen = false, arcFlame = 0, arcFlameBurst = false, arcHoly = 0, arcUnholy = 0, arcShock = 0, arcFrost = 0, arcFrostBurst = false;
    if (cls === 'magus') {
      const arcEnh = lvl >= 17 ? 5 : lvl >= 13 ? 4 : lvl >= 9 ? 3 : lvl >= 5 ? 2 : 1;
      arcEnhDelta = Math.max(0, arcEnh - (weapon.dmgBonus || 0));   // only the part above the real enchant
      arcKeen = lvl >= 6;
      arcFlame = lvl >= 8 ? 1 : 0;        // +1d6 fire on each hit
      arcFlameBurst = lvl >= 11;          // flaming burst: extra fire dice on a crit
    } else if ((cls === 'paladin' || cls === 'antipaladin') && lvl >= 5) {
      // DIVINE BOND (paladin) / FIENDISH BOON (antipaladin) — a celestial/fiendish
      // spirit pours into the weapon: an automatic enhancement of +1@5, +2@8, +3@11,
      // +4@14, +5@17, +6@20 (PF1). The real weapon's enchant wins if it's higher.
      // From 8th the blade turns HOLY/UNHOLY: +2d6 vs EVIL (paladin) / vs GOOD
      // (antipaladin), granted free on top — the way the magus gets flaming.
      const bond = lvl >= 20 ? 6 : lvl >= 17 ? 5 : lvl >= 14 ? 4 : lvl >= 11 ? 3 : lvl >= 8 ? 2 : 1;
      arcEnhDelta = Math.max(0, bond - (weapon.dmgBonus || 0));
      if (lvl >= 8) { if (cls === 'paladin') arcHoly = 2; else arcUnholy = 2; }
    }
    // WEAPON-BORNE special abilities — a NAMED/signature weapon carries its own
    // magic (flaming, holy, keen…) INTRINSICALLY: always on, regardless of the
    // wielder's class, level, or +N tier (Gabriel's Redeemer burns even at +0).
    // These layer onto any class rider (magus flaming / paladin holy) — take the
    // stronger, never double-stack. Enhancement (+N to hit/damage) still rides the
    // in-game gear tier; these are the flavour that's ALWAYS on the blade.
    const wsp = weapon.special;
    if (wsp) {
      if (wsp.keen) arcKeen = true;
      if (wsp.flaming || wsp.flamingBurst) arcFlame = Math.max(arcFlame, 1);
      if (wsp.flamingBurst) arcFlameBurst = true;
      // holy/unholy accept a NUMBER of d6 (Rovadra is a "little bit holy" = 1d6);
      // a bare `true` is the standard 2d6.
      if (wsp.holy) arcHoly = Math.max(arcHoly, typeof wsp.holy === 'number' ? wsp.holy : 2);
      if (wsp.unholy) arcUnholy = Math.max(arcUnholy, typeof wsp.unholy === 'number' ? wsp.unholy : 2);
      if (wsp.shock) arcShock = Math.max(arcShock, 1);
      if (wsp.frost || wsp.frostBurst) arcFrost = Math.max(arcFrost, 1);
      if (wsp.frostBurst) arcFrostBurst = true;   // FREEZING BURST: +1d6 cold, extra cold on a crit (Voidshard)
    }
    // Dimensional Blade — for 1 round the magus's strikes resolve as TOUCH attacks.
    if (attacker.touchStrike > 0 && target) ac = this._enemyAC(target, { touch: true, melee: true });   // Dimensional Blade = a MELEE touch → prone stays a −4 (melee) AC
    // Fly / Overland Flight (magus) — a flyer can melee airborne foes (no high-ground gap).
    if (attacker.canHitFlyers && attacker.flying && target && target.flying) ac -= HIGH_GROUND_AC;
    // Point Blank Shot: +1 to hit & damage with a bow/crossbow, but ONLY against a
    // foe that has closed to melee — i.e. one that has struck an ally this room
    // (_engagedAlly). A distant/untouched foe is out of point-blank range.
    const pbs = (weapon && weapon.ranged && target && target._engagedAlly) ? (fighterFeats(cls, lvl, true).pbs || 0) : 0;
    // Smite Evil: an ACTIVATED smite (paladin's ability) vs an evil foe adds a
    // to-hit bump + bonus (un-multiplied) damage equal to level.
    const smite = !!(attacker.smiteActive && target && (target.evil || target.markedEvil));   // Detect Evil marks neutral foes smite-able
    // Sneak Attack: rogue-likes add precision dice vs a target that's denied its
    // defenses — flat-footed, prone, sickened, or paralyzed (PF1e). NOT crit-multiplied.
    // A target is denied its Dex vs an UNSEEN attacker too — Greater Invisibility
    // keeps a rogue striking from concealment, so every hit is a Sneak Attack.
    const denied = !!(target && (target.flatFooted || target.prone || target.sickened > 0 || target.paralyzed > 0 || target.fascinated || target.blinded > 0)) || !!attacker.greaterInvis || !!attacker._unseenStrike;   // _unseenStrike: the one blow struck while still invisible (before it breaks) catches the foe unseen — denies its Dex
    // FLANK (Tobias 2026-07-04): once TWO+ melee allies work the SAME foe, they
    // flank it — +2 to hit, and Sneak Attack switches on for rogue-likes. The
    // first to close gets nothing (moved up alone); every ally who joins the
    // melee on that foe afterward is flanking. Tracked per-room on the foe.
    const flanking = this._flankRegister(attacker, target, weapon);
    const flankHit = flanking ? 2 : 0;   // PF1 flanking bonus (both flankers, once positioned)
    // SLAYER Studied Target: the foe this slayer has MARKED takes +N insight to hit
    // AND damage from them (N scales with the slayer's level; set by _abStudyTarget).
    const studied = !!(target && attacker.studiedId != null && attacker.studiedId === target.uid);
    const studiedN = studied ? (attacker.studiedN || 0) : 0;
    // CAVALIER Challenge: +level bonus DAMAGE (not to-hit) vs the challenged foe.
    const challengeN = (target && attacker.challengedId != null && attacker.challengedId === target.uid) ? (attacker.challengeN || 0) : 0;
    const sneakOk = SNEAK_CLASSES.has(cls) && (denied || flanking);
    const sneakDice = sneakOk ? Math.min(SNEAK_DICE_CAP, Math.max(1, Math.ceil(lvl / 2))) : 0;
    // Sticky room buffs (Rage / Judgment / Bane / Inspire Courage / Prayer)
    // PLUS run-long buffs (Bless's +1 to-hit) that persist across rooms.
    const rb = attacker.runBuffs || {};
    const rbuff = attacker.buffs || {};
    const buff = {
      toHit: (rbuff.toHit || 0) + (rb.toHit || 0),
      dmg: (rbuff.dmg || 0) + (rb.dmg || 0),
      bonusDice: rbuff.bonusDice || 0,
    };
    // Inquisitor BANE — declared against ONE creature type (see _abBane). Its
    // +2 hit / +2d6+2 damage applies ONLY when THIS target is that type.
    const baneOn = !!(attacker.bane && target && target.type && target.type === attacker.bane.type);
    const baneHit = baneOn ? BANE_TOHIT : 0;
    // PF1e to-hit = class BAB (level-scaled) + ability mod + weapon bonus
    // (masterwork +1 / +N enhancement, carried on weapon.toHit) + smite + buffs,
    // minus a non-proficiency penalty if the class can't use this weapon.
    const bab = babFor(cls, lvl);
    const smiteHit = smite ? SMITE_TOHIT : 0;
    // NPCs are hand-assigned their signature weapons, so they're always
    // proficient; the −4 penalty only guides human weapon choices.
    // PF1 proficiency applies to EVERY combatant — bots, humans, and piloted
    // personas alike (no AI exemption). Signature `custom` weapons are always
    // proficient (weaponProficient handles that), so iconic gear is unaffected.
    const notProf = weaponProficient(cls, weapon) ? 0 : NON_PROFICIENT_PENALTY;
    const ff = fighterFeats(cls, lvl, !!(weapon && weapon.ranged));   // bonus feats — RANGED ladder with a bow/crossbow, else melee
    // Swashbuckler — only with a finessable weapon: Weapon Focus, Weapon
    // Specialization, Precise Strike (+level, NOT crit-multiplied), Improved Critical.
    const swashFin = cls === 'swashbuckler' && isFinesseWeapon(weapon);
    const swashWF = swashFin ? 1 : 0;
    const swashSpec = (swashFin && lvl >= 4) ? 2 : 0;
    const preciseDmg = (swashFin && lvl >= 3) ? lvl : 0;   // Precise Strike: +swashbuckler level
    // Real PF1 ability mods: to-hit from STR (or DEX for a finesse/ranged weapon),
    // damage from STR ×1 / ×1.5 two-handed / ×0.5 off-hand (or DEX). Falls back to
    // the legacy +4 if a member has no derived mods yet. Replaces the ABILITY_MOD
    // placeholder, and the level-scaled damage ramp is dropped (iteratives + feats
    // now carry high-level scaling — see the iterative loop in _playerAttack).
    const _ap = attacker.mods ? attackProfile({ mods: attacker.mods }, weapon, { offHand }) : { toHitMod: ABILITY_MOD, dmgBonus: ABILITY_MOD };   // off-hand swing → ½ ability mod to DAMAGE (PF1 two-weapon fighting)
    const toHit = bab + _ap.toHitMod + (weapon.toHit || 0) + arcEnhDelta + smiteHit + baneHit + (buff.toHit || 0) + pbs + flankHit + studiedN + extraToHit + notProf - sick - (attacker.grappled ? 2 : 0) - (attacker.slowed > 0 ? 1 : 0) - (attacker.prone && !(weapon && weapon.ranged) ? 4 : 0) + _dStrike + ff.hit + swashWF;   // PF1: a prone attacker takes −4 on MELEE attacks (ranged unaffected here — crossbow rule simplified); Strength Surge (domain) rides this one swing
    const roll = dRoll(20), total = roll + toHit;
    // Luck domain — GOOD FORTUNE: the next missed swing (fumble included) is
    // rerolled once, keep the better outcome. Consumed on the reroll.
    const _fortune = () => {
      if (!attacker._domFortune) return null;
      attacker._domFortune = false;
      if (_dStrike) attacker._domStrike = _dStrike;   // the surge rides into the reroll
      this._note(`🍀 GOOD FORTUNE — ${attacker.nickname}'s miss is rerolled!`);
      return this._swingVsAC(attacker, ac, target, extraToHit, offHand);
    };
    if (roll === 1) return _fortune() || { hit: false, fumble: true, roll, toHit, total, ac, sound: SND.fumble };
    const hit = roll === 20 || total >= ac;
    if (!hit) return _fortune() || { hit: false, roll, toHit, total, ac, sound: weapon.isDagger ? SND.whiffDagger : pick(SND.whiffSword) };
    // A foe that has self-buffed defenses turns a clean hit aside (enemy casters
    // can now go Invisible / Mirror Image mid-fight). A hero who pierces the unseen
    // — True Seeing or blindsense — ignores the concealment.
    if (target && !attacker.trueSeeing && !(attacker.blindsense > 0)) {
      if (target.invisible && dRoll(2) === 1) {   // total concealment vs an unseen foe → 50% miss
        return { hit: false, conceal: true, roll, toHit, total, ac, sound: weapon.isDagger ? SND.whiffDagger : pick(SND.whiffSword) };
      }
      // PF1 MIRROR IMAGE: the blow HIT the AC — now roll which of (real + N figments)
      // it lands on. 1/(N+1) chance it's the REAL foe (fall through to normal damage;
      // DR & other defenses still apply); otherwise it strikes a figment, destroyed
      // outright (one hit, no damage). So piling on attacks BOTH whittles the decoys
      // AND keeps a real-hit chance each swing — exactly RAW. (True Seeing / blindsense
      // skip the whole illusion, handled by the guard above.)
      if (target.images > 0 && dRoll(target.images + 1) !== 1) {
        target.images -= 1;
        const _nm = target.name === undefined ? target.nickname : target.name;
        this._note(`🪞 a mirror image of ${_nm} POPS — ${target.images} decoy${target.images === 1 ? '' : 's'} left.`, null);
        return { hit: false, image: true, imagesLeft: target.images, roll, toHit, total, ac, sound: pick(SND.flesh) };
      }
    }
    // Damage = weapon dice (NdX) + enhancement + ½ level + ability mod + buff dmg (+ Point Blank).
    const judgDmg = attacker.judgment === 'destruction' ? Math.max(1, Math.floor(lvl / 3)) : 0;   // inquisitor Judgement: Destruction
    const flatDmg = _ap.dmgBonus + (buff.dmg || 0) + (baneOn ? BANE_DMG : 0) + pbs + judgDmg + ff.dmg + swashSpec + arcEnhDelta;
    // Natural attacks (a druid's claws/bite) grow their DICE with the wielder's SIZE
    // (the bigger combat forms enlarge them) and with Improved Natural Weapon — both
    // step the dice up the PF1 size table (1d6→1d8→2d6→…), stacking.
    let dmgCount = weapon.dmgCount, dmgDie = weapon.dmgDie;
    // MONK Improved Unarmed Strike (free class feature): fists follow the PF1 monk
    // ladder — 1d6, 1d8@L4, 1d10@L8, 2d6@L12, 2d8@L16, 2d10@L20 (replaces the 1d3).
    if (attacker.cls === 'monk' && weapon.key === 'unarmed') {
      const MONK_FIST = [[1, 6], [1, 8], [1, 10], [2, 6], [2, 8], [2, 10]];
      const t = MONK_FIST[Math.min(5, Math.floor(lvl / 4))];
      dmgCount = t[0]; dmgDie = t[1];
    }
    if (weapon.group === 'natural') {
      const steps = ((attacker.form && attacker.form.sizeSteps) || 0) + (ff.inw ? 1 : 0);
      if (steps > 0) { const st = stepDamage(dmgCount, dmgDie, steps); dmgCount = st.count; dmgDie = st.die; }
    }
    const rollDmg = () => dRollN(dmgCount, dmgDie) + weapon.dmgBonus + flatDmg;
    let dmg = rollDmg() - sick, crit = false;
    // Improved Critical doubles the weapon's threat range (fighter L8; swashbuckler
    // L5 with a finesse blade). Critical Focus (fighter L9) adds +4 to confirm.
    const impCrit = ff.impCrit || (weapon.impCritAt && lvl >= weapon.impCritAt) || (swashFin && lvl >= 5) || arcKeen;   // fighter / swashbuckler / magus arcane-pool keen / weapon-borne (Bastard's Blade at 9) — don't stack
    const effCritRange = impCrit ? (2 * weapon.critRange - 21) : weapon.critRange;
    const critFocus = ((ff.critFocus || (weapon && weapon.critFocus)) ? 4 : 0) + (ff.critMastery ? 4 : 0);   // Critical Focus +4 (fighter feat OR weapon-borne — Lammas / Sawtooth Sabers), Critical Mastery +4 more (+8 confirm)
    if (roll >= effCritRange) { const conf = dRoll(20) + bab + _ap.toHitMod + (weapon.toHit || 0) + smiteHit + baneHit + (buff.toHit || 0) + pbs + flankHit + studiedN + extraToHit + notProf + ff.hit + swashWF + critFocus; if (conf === 20 || conf >= ac) { crit = true; for (let i = 1; i < weapon.critMult; i++) dmg += rollDmg(); } }
    // Precision (sneak / swashbuckler Precise Strike), smite, and bane dice ride on
    // top — NOT multiplied by a crit.
    let sneakDmg = 0;
    if (preciseDmg) dmg += preciseDmg;   // swashbuckler Precise Strike
    if (sneakDice) { sneakDmg = dRollN(sneakDice, 6); dmg += sneakDmg; }
    if (buff.bonusDice) dmg += dRollN(buff.bonusDice, 6);   // misc bonus dice
    if (baneOn) dmg += dRollN(BANE_DICE, 6);                // Inquisitor Bane — +2d6 vs the declared type
    if (smite) dmg += 2 * lvl;   // Smite Evil: +double level damage
    if (studiedN) dmg += studiedN;   // Studied Target: +N insight damage vs the marked foe (un-multiplied)
    if (challengeN) dmg += challengeN;   // Cavalier Challenge: +level damage vs the challenged foe (un-multiplied)
    // DOMAIN riders — Strength Surge (+½ level dmg on this one swing; to-hit added
    // above, consumed at the top) and War's Battle Rage (+level dmg on ONE landed
    // hit — consumed here; a fully-missed action forfeits it, cleared in
    // _playerAttack). Neither is crit-multiplied (precision-style riders).
    if (_dStrike) dmg += _dStrike;
    if (attacker._domSmite) { dmg += attacker._domSmite; attacker._domSmite = 0; }
    // Sun domain — passive: the faithful's blows BURN the undead (+½ level, min 1).
    if (attacker.domainSunVuln && target && target.type === 'undead') dmg += Math.max(1, Math.ceil(lvl / 2));
    // Death domain — Bleeding Touch rides the first landed hit: the foe bleeds
    // 1d6 at the top of each of its turns until it drops (no heal-check sim).
    // PF1: bloodless creatures (undead, constructs, oozes, elementals) can't bleed
    // — the touch is spent anyway (the hit landed), it just finds no blood.
    if (attacker._domBleed && target) {
      attacker._domBleed = false;
      const bloodless = target.type === 'undead' || target.type === 'construct'
        || /golem|skelet|zombie|ooze|elemental|wraith|ghost|shadow|specter|spectre/i.test(target.name || '');
      if (bloodless) this._note(`💀 ${attacker.nickname}'s Bleeding Touch finds no blood in ${target.name} — no wound to open.`);
      else { target._bleeding = true; this._note(`🩸 ${target.name} is BLEEDING (Death domain) — 1d6 each round until it falls!`); }
    }
    // PHYSICAL DR: the foe soaks the weapon's physical damage (dice + static + crit +
    // precision/sneak/bane/smite) unless this weapon's TYPE (S/P/B) or its magic
    // bypasses the foe's DR. A clean hit is ≥1 before DR; DR can soak it to 0 (a sword
    // glancing off a skeleton). Elemental riders (flaming) ride on top, unsoaked.
    dmg = Math.max(1, dmg);
    let drTag = '';
    [dmg, drTag] = this._physDR(target, dmg, weapon, ff.prStrike || 0);   // Penetrating Strike pierces 5/10 of the DR
    // First time the party lands a blow on a creature with DR, announce what it has
    // (once per creature TYPE per run) so they can switch to the weapon that bites.
    const _drAmt = target.dr ? (typeof target.dr === 'object' ? target.dr.amount : target.dr) : 0;
    if (_drAmt > 0) { this._drSeen = this._drSeen || new Set(); if (!this._drSeen.has(target.name)) { this._drSeen.add(target.name); this._note(`🛡️ ${target.name}: ${this._drDesc(target.dr)}.`); } }
    // Magus arcane-pool FLAMING: +1d6 FIRE each hit (elemental — not soaked by physical
    // DR, not crit-multiplied); FLAMING BURST adds extra fire dice on a confirmed crit.
    // Routed through the target's FIRE resistance/immunity/vulnerability (Phase 4) —
    // a flaming blade does nothing extra to a devil and ×1.5 to a wood golem.
    if (arcFlame) dmg += this._resisted(target, dRollN(arcFlame, 6), 'fire');
    if (crit && arcFlameBurst) dmg += this._resisted(target, dRollN(Math.max(1, (weapon.critMult || 2) - 1), 10), 'fire');
    // SHOCK (electricity) / FROST (cold) weapon riders — same as flaming, routed
    // through the target's resistance (a shocking blade does nothing to an angel,
    // ×1.5 to a robot). Weapon-borne only (Stormcaller's storm shot); no burst tier.
    if (arcShock) dmg += this._resisted(target, dRollN(arcShock, 6), 'electricity');
    if (arcFrost) dmg += this._resisted(target, dRollN(arcFrost, 6), 'cold');
    if (crit && arcFrostBurst) dmg += this._resisted(target, dRollN(Math.max(1, (weapon.critMult || 2) - 1), 10), 'cold');   // freezing burst: extra cold dice on a confirmed crit (matches flaming burst, ×the crit multiplier)
    // Divine Bond HOLY (paladin) / Fiendish Boon UNHOLY (antipaladin): +2d6 of aligned
    // energy that only bites the opposed alignment — vs EVIL foes (holy) / GOOD foes
    // (unholy). Rides on top: not soaked by physical DR, not crit-multiplied.
    if (arcHoly && (target.evil || target.markedEvil)) dmg += dRollN(arcHoly, 6);
    if (arcUnholy && target.good) dmg += dRollN(arcUnholy, 6);
    return { hit: true, crit, smite, sneakDice, sneakDmg, damage: Math.max(0, dmg), drTag, roll, toHit, total, ac, sound: pick(SND.flesh) };
  }
  // (the villain brain — _monsterSwing/_enemyAct/maneuvers/caster brains — moved to game/dungeon/enemyAI.js — Phase-2 seam 3)
  // (the hero-bot brain — _allyAct/_botAbility/_botStance/_preferredFoe/_sneakPrey/_forcedFoe/_drBlocksWeapon — moved to game/dungeon/heroAI.js — heroAI seam)
  // ── AI SPELL KNOWLEDGE ─────────────────────────────────────────────────────
  // Would this spell actually WORK on this foe? The bot brain consults the same
  // immunity rules the cast handlers enforce, so an AI caster never spends its
  // turn on a cast the engine will refuse — a bard doesn't Hideous-Laughter a
  // skeleton, a wizard doesn't Fireball a fire-immune devil (Tobias 2026-07-03:
  // "AI casters know the limitations & best cases for their spells").
  _spellWorksOn(ab, t) {
    if (!ab || !t) return true;
    const eff = ab.effect;
    // Mind-affecting: charm / sleep / fascinate + the mind-seizing debuffs
    // (Hold Person, Hideous Laughter) — undead & constructs have no mind.
    if ((eff === 'charm' || eff === 'dominate' || eff === 'masscharm' || eff === 'sleep' || eff === 'fascinate') && mindImmune(t)) return false;
    if (eff === 'exhaust' && (t.type === 'undead' || t.type === 'construct')) return false;   // no living body to tire
    if (ab.onlyOutsiders && !(t.type === 'outsider' || /demon|devil|daemon|fiend/i.test(t.name || ''))) return false;   // Banishment
    if (ab.onlyHumanoids && !this._isHumanoid(t)) return false;   // Hold Person (PF1 RAW)
    if (eff === 'save_debuff' && ab.debuff === 'paralyzed' && mindImmune(t)) return false;
    // Death effects (Suffocation / Slay Living / Finger of Death / Implosion /
    // Wail) need a living, breathing body — mirror _abSaveDie's immune set.
    if (eff === 'savedie' && (t.type === 'undead' || t.type === 'construct'
      || /golem|skelet|zombie|wraith|ghost|lich|vampire|wight|ghoul|ghast|shadow|ooze|elemental|construct|undead/i.test(t.name || ''))) return false;
    // NEGATIVE ENERGY HEALS THE UNDEAD (PF1, Tobias 2026-07-04): an antipaladin's
    // Touch of Corruption / Vampiric Touch on a vampire would MEND it — never a
    // legal hostile cast. Adimarus knows better now.
    if (ab.dtype === 'negative' && t.type === 'undead') return false;
    // Damage spells: skip a foe IMMUNE to the element (mere resistance still
    // halves through — that cast is weaker but not wasted).
    if (ab.dtype && ab.dice && this._resistMult(t, ab.dtype) === 0) return false;
    // SPELL RESISTANCE no caster can EVER beat (d20 20 + CL 20 + Spell Pen 2):
    // a smart caster doesn't waste the slot. (_spellWorksOn doesn't know the
    // caster, so this is the absolute bound; beatable SR is still worth trying —
    // PF1 casters roll the check, they don't pre-give-up.)
    if (t.sr > 42 && ab.slvl != null) return false;
    return true;
  }
  // PF1 RAW (Tobias 2026-07-03): Hold Person affects HUMANOIDS only. Most foes
  // carry no .type, so classify by type when present, else by name. Giants ARE
  // humanoids in PF1 (the humanoid [giant] subtype: ogres, ettins, hill/stone
  // giants), while MONSTROUS humanoids (harpy, medusa, minotaur, gargoyle),
  // beasts, vermin, oozes, constructs, dragons, outsiders and undead are not.
  _isHumanoid(t) {
    if (t.type && ['undead', 'construct', 'outsider', 'dragon', 'aberration', 'animal', 'vermin', 'ooze', 'plant', 'magical beast', 'monstrous humanoid'].includes(t.type)) return false;
    return !/golem|dragon|drake|wyvern|devil|demon|daemon|fiend|ooze|mouther|spider|centipede|\brat\b|badger|boar|bear\b|\bape\b|wolf|caimon|basilisk|chimera|ettercap|harpy|gargoyle|minotaur|medusa|horror|elemental|shadow|skelet|zombie|ghoul|ghast|wight|vampire|lich|ghost|wraith|specter|spectre|spirit/i.test(t.name || '');
  }
  // 0 to −9 HP: down and dying — can't act (the turn loop skips hp<=0), but a Cure
  // potion can still bring them back. Dead only once they pass −10.
  // Apply non-melee damage to a member (shouts, hazards) with the same down/dead
  // thresholds as a weapon hit.
  _dmgToMember(m, dmg) {
    m.hp -= dmg;
    if (m.hp <= -10) return this._memberDown(m);
    if (m.hp <= 0) return this._downMember(m);
  }
  // Mirror Image + Displacement (magus defenses): does an incoming attack on this
  // hero get soaked by a decoy or slip through their blurred form? Returns true
  // (and logs) when the attack is fully negated.
  _evadeIncoming(target, attacker) {
    if (target.images > 0) {
      target.images -= 1;
      this._note(`🪞 the blow strikes a mirror image of ${target.nickname} — it pops! (${target.images} left)`, null);
      return true;
    }
    if (target.displaced && dRoll(2) === 1) {
      this._note(`🌫️ ${target.nickname} is displaced — the attack passes through empty air!`, null);
      return true;
    }
    // INCORPOREAL — Vesorianna is a ghost: half of all physical blows pass clean
    // through her. (She also never lands, so grounded foes can't reach her at all.)
    if (target.ghost && dRoll(2) === 1) {
      this._note(`👻 the blow passes THROUGH ${target.nickname} — she is incorporeal!`, null);
      return true;
    }
    return false;
  }
  // Fire Shield — a foe that lands a MELEE hit on the warded hero is scorched.
  _fireShieldRetaliate(target, e) {
    if (!target.fireShield || !(e && e.hp > 0)) return;
    const fs = target.fireShield;
    const dealt = this._dmgE(e, dRollN(1, fs.die || 6) + (fs.bonus || 1), 'fire');
    this._note(`🔥 ${e.name} is scorched by ${target.nickname}'s Fire Shield for ${dealt} fire!${this._afterEnemyHit(e)}`, null, { side: 'enemy' });
  }
  // Stoneskin DR vs PHYSICAL blows (melee swings, claws, chains — NOT energy/spells).
  // Returns [reducedDamage, tag] where tag annotates how much the stone soaked.
  // PF1 DAMAGE REDUCTION. target.dr is either a NUMBER (DR X/— — nothing physical
  // bypasses; used by Stoneskin / wild-shape forms) OR { amount, bypass } where bypass
  // is what IGNORES the DR: a weapon type 'S'/'P'/'B' (slash/pierce/blunt), 'magic' (a
  // +N or signature weapon), or '—'/null (nothing bypasses). `weapon` is the attacker's
  // weapon — its .dtype is the physical type, .dmgBonus>0 or .custom marks it magic.
  // Elemental damage is NOT physical and never routes through here (it uses resist).
  // `pierce` — the attacker's Penetrating Strike (high fighter ladder): ignore that
  // many points of the foe's DR.
  _physDR(target, dmg, weapon, pierce = 0) {
    const raw = target.dr;
    if (!raw) return [dmg, ''];
    const amount = Math.max(0, ((typeof raw === 'object') ? (raw.amount || 0) : raw) - (pierce || 0));
    if (amount <= 0) return [dmg, ''];
    const bypass = (typeof raw === 'object') ? raw.bypass : null;   // bare number ⇒ DR/—
    let bypassed = false;
    if (bypass === 'magic') bypassed = !!(weapon && (weapon.dmgBonus > 0 || weapon.custom));
    else if (bypass && bypass !== '—') bypassed = !!(weapon && weapon.dtype === bypass);   // matching S/P/B
    if (bypassed) return [dmg, ''];
    // DR still SOAKS the damage; we just don't tag every hit with "−N DR" (Josh
    // 2026-07-05: redundant noise — the once-per-fight "DR 10/magic" reveal already
    // says the foe has DR, and the reduced damage number speaks for itself).
    return [Math.max(0, dmg - amount), ''];
  }
  // A readable description of a creature's DR — for the once-per-fight reveal so the
  // party knows to switch weapons (and so Josh hears it in the log).
  _drDesc(dr) {
    // TERSE (Josh 2026-07-05): just the fact — "DR 10/magic" — no "rely on spell
    // damage / glances off" fluff. The once-per-fight reveal still tells the party
    // a foe HAS DR; the mechanical soak still applies. Cuts a big chunk of noise.
    if (!dr) return '';
    const amount = (typeof dr === 'object') ? dr.amount : dr;
    const bypass = (typeof dr === 'object') ? dr.bypass : null;
    const TYPE = { S: 'slashing', P: 'piercing', B: 'bludgeoning' };
    return `DR ${amount}/${bypass === 'magic' ? 'magic' : (TYPE[bypass] || '—')}`;
  }
  _downMember(m) {
    if (m.dead) return;
    if (!m.downed) {
      m.downed = true; m.queuedAction = null;   // dying wipes the pre-load
      this._note(`🩸 ${m.nickname} collapses at ${m.hp} HP — DOWN and dying! (slain at −10; a Cure potion can still save them)`);
      this._log('downed', { who: m.playerId, hp: m.hp, depth: this.depth });
      this._radianceQuip(m, 'radiance_drop');   // "Here we go again." — Radiance sighs at Vaughan's umpteenth death
    } else {
      this._note(`🩸 ${m.nickname} is battered while down — ${m.hp} HP (slain at −10).`);
    }
    this._broadcast();
  }
  _memberDown(m) {   // −10 or worse, or a total-party wipe: SLAIN — but NOT yet kicked.
    if (m.dead) return;
    m.dead = true; m.downed = false; m.queuedAction = null;   // death wipes the pre-load
    m._deathPending = true;   // the level-loss penalty is DEFERRED — a Breath of Life
                              // (in combat) or Resurrection (end of room) can undo it.
    this._note(`☠️ ${m.nickname} drops past −10 — SLAIN. They lie fallen, awaiting a Breath of Life or a rescue at the end of the room.`, '/audio/hero_death.mp3');
    this._echoToTable('/audio/hero_death.mp3');
    this._log('death', { who: m.playerId, hp: m.hp, depthReached: this.depth });
    // The fallen hero STAYS in the run as a corpse (their turn is skipped) so a cleric
    // or oracle can still revive them, and so the player can keep spectating. The death
    // penalty and the surfacing-back-to-the-table happen ONLY once death is locked in
    // (no revive) — see _applyDeathPenalty / _runOver / bail / _abRevive.
    this._broadcast();
  }
  // The death penalty: lose a level — back to the START of the previous level. Applied
  // ONLY when death is final: stayed dead to the run's end, left the run while dead, or
  // was brought back by Raise Dead (which does NOT restore the lost level). Breath of
  // Life and Resurrection clear the pending flag instead, so this never fires for them.
  // Guarded so it applies at most once per death.
  _applyDeathPenalty(m) {
    if (!m || !m._deathPending) return;
    m._deathPending = false;
    const lvl = m.level || 1;
    if (lvl > 1) {
      const newXp = xpFloorForLevel(lvl - 1);
      db.setXp(m.playerId, newXp);
      this._applyLevelFromXp(m, newXp);
      this._note(`📉 ${m.nickname} loses a level — dragged back to the start of level ${m.level}.`);
    }
  }
  // Total party incapacitation — everyone still in the run is down/dying, so they
  // all bleed out and the run ends.
  _wipe() {
    if (this.status === 'over') return;
    this._runFailed = true;   // total wipe in an uncleared room → gear loss (see _runOver)
    this._note('💀 The whole party is down — the dungeon claims them. The run ends.');
    for (const m of this.party.filter(x => !x.left && !x.dead)) this._memberDown(m);
    this._runOver();
  }

  // ── Human chat in the dungeon (from dungeon:say) ─────────────────────────
  // Mirrors the poker table chat: a 💬-prefixed line in the shared dungeon log,
  // visible to everyone in the run. Combatants only (you must be in the party).
  say(playerId, text) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!clean) return { ok: false, error: 'empty message' };
    this._note(`💬 ${m.nickname}: ${clean}`);
    this._broadcast();
    try { this._maybeVorkstagReskinOnChat(clean); } catch (_) {}
    // Let a bot party-mate clap back if the player named one of them.
    try { this._maybeChatBanter(m, clean); } catch (_) { /* flavor only */ }
    return { ok: true };
  }
  // A spectator up at the table heckling the delvers. Not a combatant — their
  // line is tagged "(watching)" but lands in the same shared log.
  spectatorSay(player, text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!clean) return { ok: false, error: 'empty message' };
    const nick = player.nickname || player.player_id;
    this._note(`💬 ${nick} (watching): ${clean}`);
    this._broadcast();
    try { this._maybeVorkstagReskinOnChat(clean); } catch (_) {}
    // A heckler can still draw a clap-back if they name a bot in the party.
    try { this._maybeChatBanter({ playerId: player.player_id, nickname: nick }, clean); } catch (_) {}
    return { ok: true };
  }
  // If the human's line names a bot currently in the party, that bot may answer
  // in character (dungeon voice). Best-effort and rate-limited by banter itself.
  _maybeChatBanter(speaker, text) {
    const lower = text.toLowerCase();
    const botMates = this.present().filter(x => x.isBot && x.hp > 0 && x.playerId !== speaker.playerId);
    if (!botMates.length) return;
    const named = botMates.find(b => {
      const nick = (b.trueNick || b.nickname || '').toLowerCase();
      const first = nick.split(/\s+/)[0];
      return nick && (lower.includes(nick) || (first.length >= 4 && lower.includes(first)));
    });
    if (!named) return;
    // Explicit mention → reply (near-)always, like the poker chat's name call-out.
    // Bypasses the combat once-per-round banter gate since the player addressed them.
    if (!banter.CHARACTER_FLAVOR[named.trueNick || named.nickname]) return;
    this._emitBanter(named, 'chat', { from: speaker.nickname, said: text });
  }
  // Vorkstag the skinwalker swaps which delver he's wearing — a fresh face + name
  // from another living party-mate (never himself, never his current disguise).
  _reskinVorkstag() {
    const vork = this.party.find(x => x.playerId === 'vorkstag' && !x.left && x.hp > 0);
    if (!vork) return false;
    vork.trueNick = vork.trueNick || vork.nickname;   // remember his real identity if not already
    const victims = this.party.filter(x => x.playerId !== 'vorkstag' && !x.left && x.hp > 0 && x.nickname !== vork.nickname);
    if (!victims.length) return false;
    const v = pick(victims);
    vork.nickname = v.nickname; vork.avatarId = v.avatarId;
    this._note(`🎭 Something is wrong with one of the delvers…`);
    this._broadcast();
    return true;
  }
  // Addressing Vorkstag's current (fake) name in dungeon chat unsettles him — 25%
  // of the time he sheds that face for another.
  _maybeVorkstagReskinOnChat(text) {
    const vork = this.present().find(x => x.playerId === 'vorkstag' && x.hp > 0);
    if (!vork) return;
    const nick = (vork.nickname || '').toLowerCase(), first = nick.split(/\s+/)[0], lower = String(text).toLowerCase();
    const addressed = nick && (lower.includes(nick) || (first.length >= 4 && lower.includes(first)));
    if (addressed && Math.random() < 0.25) { try { this._reskinVorkstag(); } catch (_) {} }
  }

  // ── Player actions (from dungeon:action) ─────────────────────────────────
  // "Reset helpers to my level" (dungeon settings): lower every AI HELPER in the
  // party DOWN to the invoking human's level — never up (a helper already at or
  // below your level is untouched). Level is XP-derived, so we set their XP to the
  // floor of your level and re-derive HP/abilities. GEAR AND GOLD ARE NOT TOUCHED
  // (Tobias's rule) — only the level/XP changes. Humans are never affected.
  resetHelpers(callerId) {
    const caller = this.member(callerId);
    if (!caller) return { ok: false, error: 'not in this run' };
    const myLevel = caller.level || 1;
    const floorXp = xpFloorForLevel(myLevel);
    const lowered = [];
    for (const b of this.party) {
      if (!b.isBot || b.left) continue;
      if ((b.level || 1) <= myLevel) continue;   // only bring DOWN, never up
      db.setXp(b.playerId, floorXp);             // persist — gear/chips are left alone
      b.xp = floorXp; b.level = myLevel;
      const raceMods = RACES.raceModsFor(b.race, b.abilityScores, b.flexStat);
      const _ranged = !!weaponOf(b.gear, b.weaponKey || 'dagger').ranged;
      const featHp = (fighterFeats(b.cls, b.level, _ranged).hp) || 0;
      b.maxHp = deriveCharacter({ cls: b.cls, level: b.level, baseScores: b.abilityScores, raceMods, featHp }).hp;
      if (b.hp > b.maxHp) b.hp = b.maxHp;
      this._resetAbilities(b);                   // re-stock slots/uses at the new level
      lowered.push(b.nickname);
    }
    if (!lowered.length) { this._note(`⚖️ No helpers were above ${caller.nickname}'s level (${myLevel}) — nothing to reset.`); this._broadcast(); return { ok: true, lowered: [] }; }
    this._note(`⚖️ ${caller.nickname} levels the field: ${lowered.join(', ')} brought DOWN to level ${myLevel} (their gear & gold are untouched).`);
    this._broadcast();
    return { ok: true, lowered };
  }
  action(playerId, kind, payload = {}) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };

    // Bail, loot rolls, and loot management are allowed any time (not on-turn).
    if (kind === 'bail') return this.bail(playerId);
    if (kind === 'resetHelpers') return this.resetHelpers(playerId);   // lower AI helpers DOWN to my level (gear/gold untouched)
    if (kind === 'lootroll') return this._lootDecide(playerId, !!payload.roll);
    if (kind === 'equip') { const r = this.equipLoot(playerId, payload.idx); this._broadcast(); return r; }
    if (kind === 'hock')  { const r = this.hockLoot(playerId, payload.idx); this._broadcast(); return r; }
    if (kind === 'cantrip') return this.setCantrip(playerId, payload.key);   // pick at-will element (free, any time)
    if (kind === 'metamagic') return this.setMetamagic(playerId, payload.key);   // spontaneous caster toggles a metamagic on/off
    if (kind === 'loadout') return this.loadout(playerId, payload);   // Spellbook picker: fetch the loadout model / toggle a spell (lands at the next door)
    if (kind === 'domains') return this.domains(playerId, payload);   // Domain picker (Phase C): fetch the model / toggle a domain (lands at the next door)
    if (kind === 'progression') return this.progression(playerId);    // class-progression reference (Josh's blind X key) — pure lookup, any time

    if (this.status === 'exploring') {
      if (kind === 'door') return this.openDoor();
      // Humans may pre-cast their RUN-LONG buffs (Mage Armor / Bless / Overland
      // Flight) before opening the door — their choice, never auto-cast for them.
      if (kind === 'ability' && m) {
        const ab = this._abilitiesFor(m)[payload.slot | 0];
        if (this._isRunLongBuff(ab)) return this._useAbility(m, payload.slot | 0, payload || {});
        return { ok: false, error: 'only long-lasting buffs (Mage Armor, Bless, Overland Flight) can be cast before the door' };
      }
      return { ok: false, error: 'invalid while exploring' };
    }
    if (this.status !== 'combat') return { ok: false, error: 'run is over' };
    if (this._currentActorId() !== playerId) {
      // ── ACTION QUEUE ── acting before your turn PRE-LOADS the turn: the
      // action fires the moment your turn begins. Queueing again REPLACES the
      // earlier pick (last one wins) — line up your move and go get a drink.
      if ((kind === 'attack' || kind === 'ability') && !m.dead && !m.downed && m.hp > 0) {
        // A queue with NO explicit target inherits the player's last 🎯 AIM (their
        // most recent enemy click, tracked in this.targeting). The client clears its
        // local pick after each send, so a REPLACEMENT queue ("queue again to
        // replace") used to go out target-less and fire at the auto-pick instead of
        // the foe the player had selected (Tobias, 2026-07-02).
        if (payload.targetUid == null && this.targeting[playerId]) {
          payload.targetUid = this.targeting[playerId];
          if (!Array.isArray(payload.targetUids) || !payload.targetUids.length) payload.targetUids = [payload.targetUid];
        }
        const label = kind === 'attack' ? (payload.mode === 'ranged' ? 'ranged attack' : payload.mode === 'melee' ? 'melee attack' : 'attack')
          : ((this._abilitiesFor(m)[payload.slot | 0] || {}).name || 'ability');
        m.queuedAction = { kind, payload, label };
        this._broadcast();   // the ⏳ chip appears on their hero card
        return { ok: true, queued: true, label };
      }
      return { ok: false, error: 'not your turn' };
    }
    m.queuedAction = null;   // acting live always clears a stale pre-load
    clearTimeout(this._turnTimer);
    this._log('action', { who: playerId, kind, hp: m.hp, enemiesAlive: this.livingEnemies().length });
    if (kind === 'attack') {
      const r = this._useAtwill(m, payload);
      if (r && r.ok === false) { this._armAfkTimer(m); return r; }   // refused (Melee pressed with a bow) → reason toasted/spoken, turn kept
    }
    else if (kind === 'ability') {
      // Taunted → a single-target offensive ability is dragged onto the taunter.
      const forced = this._forcedFoe(m);
      if (forced) {
        const ab = this._abilitiesFor(m)[payload.slot | 0];
        if (ab && ab.target === 'enemy') payload.targetUid = forced.uid;
      }
      const r = this._useAbility(m, payload.slot | 0, payload);
      if (r && r.ok === false) { this._armAfkTimer(m); return r; }   // spent/invalid → don't burn the turn
      if (r && r.freeAction) { this._armAfkTimer(m); this._broadcast(); return { ok: true, freeAction: true }; }   // judgement switch — keep your turn
    }
    else { this._armAfkTimer(m); return { ok: false, error: 'unknown action' }; }
    this._hasteBonus(m);   // Haste: spend a pending extra attack after the action
    // NOTE: Abadar's interest no longer ticks per combat turn or per room — a
    // whole dungeon RUN counts as ONE tick (see _emitMemberExit), the same as
    // one poker hand.
    this._nextTurn();
    return { ok: true };
  }

  // (the hero ability system — attacks, _ab* handlers, pickers, spell math, SR — moved to game/dungeon/abilities.js — Phase-2 seam 4)
  // (equipLoot / hockLoot moved to game/dungeon/loot.js — Phase-2 seam 1)

  // ── Exits ─────────────────────────────────────────────────────────────────
  // One member climbs out with an even share of the current pool.
  bail(playerId) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };
    const wasActor = this._currentActorId() === playerId;
    const fled = this.status === 'combat';   // bailing mid-fight = running away
    const denom = Math.max(1, this.party.filter(x => !x.left && !x.dead).length);   // split among everyone in the run, incl. the dying
    // A SLAIN hero (dead, not merely downed) forfeits their cut — they get no
    // gold when carried out. The living/dying split the pool among themselves.
    const share = m.dead ? 0 : Math.floor(this.runGold / denom);
    if (share > 0) {
      this.runGold -= share;
      const p = db.getPlayer(playerId);
      if (p) db.setChips(playerId, p.chips + share);
    }
    m.left = true;   // turn loop skips left members; entry stays for index integrity
    const how = m.dead ? 'is carried out, slain — no share of the gold'
              : m.downed ? `is dragged out of the dungeon with ${share} gp`
              : fled ? `flees the fight and climbs out with ${share} gp`
              : `climbed out with ${share} gp`;
    this._note(`${m.dead ? '☠️' : m.downed ? '🩸' : fled ? '🏃' : '🪜'} ${m.nickname} ${how}.`);
    this._log('bail', { who: playerId, share, poolLeft: this.runGold, fled, downed: !!m.downed });
    if (m.dead) this._applyDeathPenalty(m);   // a slain hero leaving the run locks in the level loss
    this._emitMemberExit(m, { reason: 'bailed', goldBanked: share, fled });
    // RETREAT SIGNAL — a CONSCIOUS human voluntarily fleeing mid-fight, with no
    // conscious human left to lead, tells the hired AI to break and run too. Each
    // bot bails on its own next turn (see the turn scheduler). The dying are
    // dragged out with the group-extract once the field clears.
    if (fled && !m.isBot && !m.dead && !m.downed && !this._fleeing) {
      const humanUp = this.party.some(h => !h.isBot && !h.left && !h.dead && h.hp > 0);
      if (!humanUp) {
        this._fleeing = true;
        this._note('🏃 The last of the delvers turns to flee — the hired blades break and run for the stairs too!');
      }
    }
    // Last conscious member out → drag any remaining dying allies out with their
    // share (voluntary retreat). Otherwise, if only AI remain, cash them out.
    if (!this._anyUp()) { this._groupExtract(); return { ok: true, goldBanked: share }; }
    // Last human out (left OR went to spectator): if we're BETWEEN rooms, the AI
    // cash out now (nothing to finish). If a fight is in progress, let the AI
    // FINISH the current room — _clearRoom wraps them up on the clear.
    if (!this._humansInRun()) {
      if (this.status !== 'combat') { this._wrapUp(); return { ok: true, goldBanked: share }; }
      if (wasActor) { clearTimeout(this._turnTimer); this._nextTurn(); } else this._broadcast();   // keep the bots fighting
      return { ok: true, goldBanked: share };
    }
    // Only nudge the turn cycle if the bailer was the one we were waiting on.
    if (this.status === 'combat' && wasActor) { clearTimeout(this._turnTimer); this._nextTurn(); }
    else this._broadcast();
    return { ok: true, goldBanked: share };
  }
  // A human delver dismisses an AI ally from the party (the dungeon's answer to
  // the poker table's "× kick"). Routes through bail() so turn order, the gold
  // split, and group-extract edge cases are all handled. Only human sockets call
  // this; any member in the run may dismiss an AI ally.
  kickBot(requesterId, botId) {
    const r = this.member(requesterId);
    if (!r || r.left) return { ok: false, error: 'not in this run' };
    const b = this.member(botId);
    if (!b || b.left) return { ok: false, error: 'not in the party' };
    if (!b.isBot) return { ok: false, error: 'you can only dismiss AI allies' };
    if (b.playerId === requesterId) return { ok: false, error: 'cannot dismiss yourself' };
    this._note(`👋 ${r.nickname} dismissed ${b.nickname} from the party.`);
    return this.bail(botId);
  }
  /** Hard-cancel the ENTIRE run — the "Cancel Dungeon" escape hatch for a stuck
   *  or broken run. Bails out every remaining member (each banks their split
   *  share and is surfaced back to the table via dungeon:exit), then ends the
   *  run. NOT a wipe: no gear is lost — this is a clean group retreat. */
  cancelRun() {
    if (this.status === 'over') return { ok: true };
    this._note('🛑 The run was cancelled — the party retreats upstairs.');
    this._runFailed = false;   // a cancel is a clean retreat, never a gear-loss wipe
    // Snapshot ids first: bail() mutates party entries and may end the run.
    for (const id of this.present().map(m => m.playerId)) {
      const m = this.member(id);
      if (m && !m.left) { try { this.bail(id); } catch (_) {} }
    }
    if (this.status !== 'over') { try { this._runOver(); } catch (_) {} }
    return { ok: true };
  }
  // Tell THIS player's client to surface back to the table; notify the table.
  _emitMemberExit(m, exit) {
    // Abadar's interest: ONE dungeon RUN = ONE tick of the compound-interest
    // clock for a human delver (the same as one poker hand) — NOT per room or
    // per combat turn. Guarded so the various exit paths tick at most once.
    if (!m.isBot && !m._debtTicked) {
      m._debtTicked = true;
      try {
        const intr = db.tickDebtTurn(m.playerId);
        if (intr) this._note(`🏛️ Abadar's interest — ${m.nickname}'s tab compounds ${intr.before.toLocaleString()} → ${intr.after.toLocaleString()} gp (+${intr.interest.toLocaleString()}).`);
      } catch (_) {}
    }
    if (this.io) this.io.to(this.roomName()).emit('dungeon:exit', { playerId: m.playerId, ...exit });
    if (this._onMemberExit) try { this._onMemberExit(m.playerId, m.nickname, exit); } catch (_) {}
  }
  destroy() { clearTimeout(this._turnTimer); clearTimeout(this._stepTimer); clearTimeout(this._lootTimer); }
}

// ── MIXINS (Phase-2 restructure) — cohesive method groups live in game/dungeon/*
// and are grafted onto the prototype; `this` semantics are identical to class
// methods. ONE seam per deploy (see CLAUDE.md + REFACTOR-AND-RACES-PLAN).
Object.assign(Dungeon.prototype, require('./dungeon/loot'));
Object.assign(Dungeon.prototype, require('./dungeon/summons'));   // _abSummon / _enemySummon (summon seam)
Object.assign(Dungeon.prototype, require('./dungeon/serialize')({ fighterFeats, titleCase }));
Object.assign(Dungeon.prototype, require('./dungeon/enemyAI')({ SICKENED_PENALTY, SICKENED_ROUNDS, HIGH_GROUND_HIT, ABILITY_MOD, PARALYZE_DC }));
Object.assign(Dungeon.prototype, require('./dungeon/heroAI')({ ABILITY_MOD, mindImmune, fightsNatural, isSneakClass, ccd }));   // hero-bot brain (heroAI seam)
Object.assign(Dungeon.prototype, require('./dungeon/abilities')({ ABILITY_MOD, CAST_MOD, SICKENED_PENALTY, SICKENED_ROUNDS, BLIND_ROUNDS, HIGH_GROUND_AC, EFFECT_CL_FLOOR, mindImmune, fightsNatural, isSneakClass, titleCase, ccd, stepDamage }));

module.exports = { Dungeon, MON, BOSS_KEYS };
