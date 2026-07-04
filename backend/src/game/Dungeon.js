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
const FINESSE_KEYS = new Set(['rapier', 'scimitar', 'shortsword', 'dagger', 'kukri', 'cutlass', 'estoc', 'sword_cane', 'starknife', 'sap', 'radiance', 'curator']);
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
// Signature Spell Strike sounds per magus (keyed by dungeon nickname). Human
// magi (and any unlisted magus) fall back to the spell's default electric zap.
const MAGUS_SPELLSTRIKE_SFX = {
  Kate:    '/audio/spellstrike_boudicca.mp3',     // Kate Blackwood — "boudicca" battle cry
  Vaughan: '/audio/spellstrike_vaughan.mp3',      // Vaughan — Genji-style sword ult
  Toni:    '/audio/spellstrike_toni.mp3',         // Toni — arcane sword-lightning yell
};
const BOSS_EVERY     = 5;
// (LOOT_ROLL_MS moved to game/dungeon/loot.js — Phase-2 seam 1)

// Every applied spell/feat buff that should show an icon on a hero's buff strip,
// keyed by the ability key recorded in m.buffApplied / m.runBuffApplied. Each
// needs a matching /dungeon/buffs/<key>.webp. _buffList walks the applied keys,
// so adding a new buff spell is just: give it a kit entry + an icon + a line here.
const BUFF_META = {
  rage:          { label: 'Rage',            desc: '+2 hit & damage, −2 AC (this room)' },
  bane:          { label: 'Bane',            desc: '+2 hit, +2d6+2 vs foes (this room)' },
  divinefavor:   { label: 'Divine Favor',    desc: '+3 hit & damage (this room)' },
  prayer:        { label: 'Prayer',          desc: 'allies +1 hit, damage & saves (this room)' },
  shield:        { label: 'Shield',          desc: '+4 AC (this room)' },
  shieldoffaith: { label: 'Shield of Faith', desc: '+2 deflection AC (this room)' },
  protevil:      { label: 'Protection from Evil', desc: '+2 AC & +2 saves (this room)' },
  magearmor:     { label: 'Mage Armor',      desc: '+4 armor AC (this dungeon)' },
  stoneskin:     { label: 'Stoneskin',       desc: 'DR 10 vs physical blows (this room)' },
  stoneskincomm: { label: 'Stoneskin (Communal)', desc: 'DR 10 vs physical blows — whole party (this room)', icon: '/dungeon/buffs/stoneskin.webp' },
  ironskin:      { label: 'Iron Skin',       desc: 'DR 10 vs physical blows (this room)', icon: '/dungeon/buffs/stoneskin.webp' },
  barkskin:      { label: 'Barkskin',        desc: '+3 natural-armor AC (this room)', icon: '/dungeon/buffs/stoneskin.webp' },
  magicfang:     { label: 'Magic Fang',      desc: '+1 to hit & damage — natural weapons (this room)', icon: '/dungeon/buffs/bullsstrength.webp' },
  catsgrace:     { label: "Cat's Grace",     desc: '+2 AC & +1 to hit — Dexterity (this room)' },
  bullsstrength: { label: "Bull's Strength", desc: '+2 hit & damage — Strength (this room)' },
  bearsendurance:{ label: "Bear's Endurance",desc: '+temporary HP — Constitution (this room)' },
  heroism:       { label: 'Heroism',         desc: '+2 to hit & +2 on saves (this room)' },
  goodhope:      { label: 'Good Hope',       desc: 'allies +2 hit, damage & saves (this room)' },
  deadlyaim:     { label: 'Deadly Aim',      desc: 'trading aim for power — −hit, +damage' },
  powerattack:   { label: 'Power Attack',    desc: 'trading accuracy for power — −hit, +damage' },
  fightdefensively: { label: 'Fighting Defensively', desc: '−4 to hit for a dodge AC bonus', icon: '/dungeon/buffs/shieldoffaith.webp' },
  fly:           { label: 'Flying',          desc: 'airborne — grounded foes cannot reach you' },
  protectfire:   { label: 'Fire Ward',       desc: 'absorbs incoming fire damage until spent (Protection from Fire)' },
  bless:         { label: 'Bless',           desc: '+1 to hit — whole dungeon' },
  inspire:       { label: 'Inspire Courage', desc: 'allies +1 hit & damage — whole dungeon' },
  // ── Magus buffs (icons fall back to fitting existing art) ──
  displacement:  { label: 'Displacement',    desc: '50% of incoming attacks miss (this room)', icon: '/dungeon/buffs/fly.webp' },
  fireshield:    { label: 'Fire Shield',     desc: 'melee attackers scorched for 1d6+level fire (this room)', icon: '/dungeon/buffs/protevil.webp' },
  elementalbody: { label: 'Elemental Body',  desc: 'immune to crits, paralysis, stun, sicken & blind (this room)', icon: '/dungeon/buffs/stoneskin.webp' },
  trueseeing:    { label: 'True Seeing',     desc: 'see through darkness, illusions & invisibility (this room)', icon: '/dungeon/buffs/magearmor.webp' },
  mirrorimage:   { label: 'Mirror Image',    desc: 'shimmering decoys soak incoming attacks', icon: '/dungeon/buffs/fly.webp' },
};

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
  _targetableParty() { const live = this.alivePresent(); const seen = live.filter(m => !m.invisible && !m.untargetable); return seen.length ? seen : live; }
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
    let list = this.enemies.filter(e => e.hp > 0 && (dv || (!(e.darkened > 0) && !e.invisible)));
    // If invisibility/darkness hid EVERY foe, the party can still flail into the dark
    // (each swing eats the 50% concealment miss in _swingVsAC) — never leave them with
    // zero targets and a stuck room.
    if (!list.length) list = this.enemies.filter(e => e.hp > 0);
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
    if (!e || !e.flying) return true;
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
      flying: (playerId || '').toLowerCase() === 'vesorianna',
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
    for (const ab of kitFor(cls).abilities) {
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
        const kit = kitFor(m.cls);
        (kit.abilities || []).forEach((ab, slot) => {
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
    if (cast.length) this._note(`✨ The party readies before the door: ${cast.join(', ')}.`, '/audio/spell_invoke.mp3');
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
    for (const m of this.present()) { this._computeCastable(m); this._resetAbilities(m); m.flatFooted = !fighterFeats(m.cls, m.level, this._isRanged(m)).supremacy; }  // re-read the spell LOADOUT (Spellbook picker edits land at the door) + refresh per-room spells/channels + flat-footed until they act (Weapon Supremacy: never caught flat-footed)
    if (Math.random() < 0.05) { try { this._reskinVorkstag(); } catch (_) {} }   // skinwalker drifts to a new face between rooms (rare)
    this._maintainBardSongs();   // Inspire Courage is a passive aura — always up, no action spent
    this.status = 'combat';
    this.round = 1;
    this.targeting = {};   // last room's 🎯 aim picks are stale — fresh foes, fresh aims
    this._fleeing = false;   // a fresh room — any prior retreat is moot
    this._rollInitiative();
    this._note(`🚪 Door creaks open — room ${this.depth}. ${this._enemySummary()}`);
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
    return Math.max(1, Math.min(13, cr));
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
  _makeEnemy(base, boss) {
    // BOSS ADVANCEMENT — a designated boss gains 1d4 EXTRA LEVELS (PF1 advancing
    // by class levels/HD): +12% HP and +1 to-hit per level; +1 AC, saves, damage,
    // ability DCs and special-use counts per 2 levels; bigger sneak/spellstrike/
    // heal dice; +1 effective CR per 2 levels (so XP and loot scale with the
    // tougher fight); and a fatter gold pouch. `bossLevels` feeds the lich's
    // caster level too, so its spells grow with the advancement.
    const extra = boss ? dRoll(4) : 0;
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
      name: boss ? `Boss: ${base.name}${extra ? ` +${extra}` : ''}` : base.name,
      glyph: base.glyph, art: base.tokenPool ? pick(base.tokenPool) : (base.art || null), boss,
      cr: (boss && half) ? String((base.crNum || 0) + half) : (base.cr || null),   // advanced CR → bigger XP + loot rolls
      bossLevels: extra,
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
  // Build a room of foes. The per-enemy CR is geared to the weakest hero; the
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
      // Boss rooms also mob a big party — minions at a notch below the room CR.
      const baseCR = this._minLevel() + Math.floor(this.depth / 4);
      fill(Math.round(rawXpForCR(baseCR) * Math.max(0, partyN - 1) * 0.6),
           Math.max(0.25, encCR - 6), Math.max(1, encCR - 2), 1 + partyN);
    } else {
      fill(Math.round(rawXpForCR(encCR) * sizeMult),
           Math.max(0.25, encCR - 4), encCR, Math.min(14, 4 + partyN * 2));
    }
    if (!keys.length) keys.push(pickByCR(this.depth));
    keys.forEach((k, i) => this.enemies.push(this._makeEnemy(MON[k], boss && i === 0)));
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
    for (const m of this.alivePresent()) order.push({ kind: 'party', id: m.playerId, init: dRoll(20) + 2 + Math.floor((m.level || 1) / 2) + fighterFeats(m.cls, m.level, this._isRanged(m)).init });   // + fighter Improved Initiative
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
    if (this.livingEnemies().length === 0) { this._clearRoom(); return true; }
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
  _acPenalty(m) { return ((m.buffs && m.buffs.acPen) || 0) + (m.acPenRound === this.round ? (m.acPenAmt || 0) : 0) + (m.grappled ? 2 : 0); }
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
    return b;
  }
  // A hero's three PF1 AC values (base, no situational mods) — for display + touch
  // resolution. touch drops armor/shield/mage-armor; flat-footed drops Dodge.
  // acOf for a hero, weapon-aware: a RANGED weapon (bow/crossbow/gun) or a
  // dual-wield/no-shield weapon grants no shield AC (they can still own the shield
  // for its treasure value). Centralizes the shield-AC exclusion in one place.
  _acOf(m) {
    const w = m.weapon || weaponOf(m.gear, m.weaponKey);
    return acOf(m.gear, m.cls, { noShield: !!(w && (w.noShield || w.ranged)) });
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
  _swingVsAC(attacker, ac, target, extraToHit = 0, offHand = false) {
    const weapon = attacker.weapon;
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
    let arcEnhDelta = 0, arcKeen = false, arcFlame = 0, arcFlameBurst = false, arcHoly = 0, arcUnholy = 0;
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
    const denied = !!(target && (target.flatFooted || target.prone || target.sickened > 0 || target.paralyzed > 0 || target.fascinated || target.blinded > 0)) || !!attacker.greaterInvis;
    const sneakOk = SNEAK_CLASSES.has(cls) && denied;
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
    const toHit = bab + _ap.toHitMod + (weapon.toHit || 0) + arcEnhDelta + smiteHit + baneHit + (buff.toHit || 0) + pbs + extraToHit + notProf - sick - (attacker.grappled ? 2 : 0) - (attacker.slowed > 0 ? 1 : 0) - (attacker.prone && !(weapon && weapon.ranged) ? 4 : 0) + _dStrike + ff.hit + swashWF;   // PF1: a prone attacker takes −4 on MELEE attacks (ranged unaffected here — crossbow rule simplified); Strength Surge (domain) rides this one swing
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
    const impCrit = ff.impCrit || (swashFin && lvl >= 5) || arcKeen;   // fighter / swashbuckler / magus arcane-pool keen (don't stack)
    const effCritRange = impCrit ? (2 * weapon.critRange - 21) : weapon.critRange;
    const critFocus = (ff.critFocus ? 4 : 0) + (ff.critMastery ? 4 : 0);   // Critical Focus +4, Critical Mastery +4 more (+8 confirm)
    if (roll >= effCritRange) { const conf = dRoll(20) + bab + _ap.toHitMod + (weapon.toHit || 0) + smiteHit + baneHit + (buff.toHit || 0) + pbs + extraToHit + notProf + ff.hit + swashWF + critFocus; if (conf === 20 || conf >= ac) { crit = true; for (let i = 1; i < weapon.critMult; i++) dmg += rollDmg(); } }
    // Precision (sneak / swashbuckler Precise Strike), smite, and bane dice ride on
    // top — NOT multiplied by a crit.
    let sneakDmg = 0;
    if (preciseDmg) dmg += preciseDmg;   // swashbuckler Precise Strike
    if (sneakDice) { sneakDmg = dRollN(sneakDice, 6); dmg += sneakDmg; }
    if (buff.bonusDice) dmg += dRollN(buff.bonusDice, 6);   // misc bonus dice
    if (baneOn) dmg += dRollN(BANE_DICE, 6);                // Inquisitor Bane — +2d6 vs the declared type
    if (smite) dmg += 2 * lvl;   // Smite Evil: +double level damage
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
    // Divine Bond HOLY (paladin) / Fiendish Boon UNHOLY (antipaladin): +2d6 of aligned
    // energy that only bites the opposed alignment — vs EVIL foes (holy) / GOOD foes
    // (unholy). Rides on top: not soaked by physical DR, not crit-multiplied.
    if (arcHoly && (target.evil || target.markedEvil)) dmg += dRollN(arcHoly, 6);
    if (arcUnholy && target.good) dmg += dRollN(arcUnholy, 6);
    return { hit: true, crit, smite, sneakDice, sneakDmg, damage: Math.max(0, dmg), drTag, roll, toHit, total, ac, sound: pick(SND.flesh) };
  }
  // (the villain brain — _monsterSwing/_enemyAct/maneuvers/caster brains — moved to game/dungeon/enemyAI.js — Phase-2 seam 3)
  // A living foe this member is compelled (taunted) to attack, or null.
  _forcedFoe(m) {
    if (!m || !m.tauntedBy) return null;
    return this.enemies.find(x => x.uid === m.tauntedBy && x.hp > 0) || null;
  }
  _allyAct(m) {
    const foes = this._targetableEnemies();   // can't target Darkness-shrouded foes
    if (!foes.length) return;
    // Taunted by a goblin barbarian → drop the clever play and just go hit it.
    if (m.tauntedBy && foes.some(e => e.uid === m.tauntedBy)) {
      const tgt = this._preferredFoe(m, foes);   // returns + consumes the taunter
      if (tgt) this._basicAttack(m, tgt.uid);
      this._hasteBonus(m);
      return;
    }
    // An INVISIBLE ally:
    //  • a SNEAK-class killer (rogue, soon slayer) doesn't lurk — an unseen
    //    attacker denies Dex, so the next strike is a guaranteed Sneak Attack.
    //    Pick the juiciest prey (enemy caster first, then the boss, lowest HP
    //    breaking ties) and gut it. The strike breaks normal invisibility —
    //    that's what it was FOR; Greater Invisibility keeps them unseen.
    //  • everyone else stays hidden: a NON-offensive support action (heal/buff)
    //    if they have one, else they hold — attacking would break the spell.
    //    (Always narrated, so blind players know exactly why nobody swung.)
    if (m.invisible) {
      if (isSneakClass(m.cls)) {
        const prey = this._sneakPrey(foes);
        this._note(m.greaterInvis
          ? `🗡️ ${m.nickname} strikes from everywhere and nowhere — ${prey.name} can't see the blade coming!`
          : `🗡️ ${m.nickname} melts out of the shadows behind ${prey.name} — an unseen strike!`);
        this._botStance(m, foes);
        this._basicAttack(m, prey.uid);
        this._hasteBonus(m);
        return;
      }
      // GREATER Invisibility does NOT break on attack, so a greater-invisible
      // ally fights normally (Josh: a greater-invis'd fighter just stood there
      // doing nothing). Fall through to the normal turn below; every swing lands
      // against a foe denied its Dex (see the greaterInvis branch in _denied).
      if (!m.greaterInvis) {
        const c = this._botAbility(m);
        if (c) {
          const ab = this._abilitiesFor(m)[c.slot];
          if (ab && ab.target !== 'enemy' && ab.target !== 'aoe' && ab.effect !== 'attack') {
            const r = this._useAbility(m, c.slot, c.payload);
            if (r && r.ok && ab) m._lastAbilityKey = ab.key;
            if (r && r.ok && !r.freeAction) { this._hasteBonus(m); return; }
          }
        }
        this._note(`👻 ${m.nickname} stays hidden — attacking would break the invisibility — and holds for the right moment.`);
        this._broadcast();
        return;
      }
    }
    // Set the Power Attack / Deadly Aim stance for this turn FIRST (free toggle):
    // kept on for the damage, eased off against a target too well-armored to power
    // through. Done here so the swing that follows uses the right stance.
    this._botStance(m, foes);
    // Then see if a class ability is the smart play this turn (heal, buff,
    // blast, spell). If so, use it; otherwise fall back to a basic attack.
    const choice = this._botAbility(m);
    if (choice) {
      const ab = this._abilitiesFor(m)[choice.slot];
      m._botMM = this._botPickMetamagic(m, ab);   // spontaneous bot may empower/maximize a damage spell when flush on high slots
      const r = this._useAbility(m, choice.slot, choice.payload);
      m._botMM = null;                            // one-shot — never leaks past the cast
      if (r && r.ok && ab) m._lastAbilityKey = ab.key;
      if (r && r.ok && !r.freeAction) { this._hasteBonus(m); return; }   // free action (judgement) → keep acting
      // Curator: after a quickened (swift) buff, immediately try ONE more support
      // action — a second buff — before falling through to a melee strike.
      if (r && r.ok && r.freeAction && this._wieldsCurator(m)) {
        const c2 = this._botAbility(m);
        if (c2) {
          const ab2 = kitFor(m.cls).abilities[c2.slot];
          const r2 = this._useAbility(m, c2.slot, c2.payload);
          if (r2 && r2.ok && ab2) m._lastAbilityKey = ab2.key;
          if (r2 && r2.ok && !r2.freeAction) { this._hasteBonus(m); return; }
        }
      }
    }
    // Basic attack — class-aware target pick (see _preferredFoe).
    const tgt = this._preferredFoe(m, foes);
    if (tgt) this._basicAttack(m, tgt.uid);
    this._hasteBonus(m);   // Haste: spend a pending extra attack after the action
  }
  // A bot's Power Attack / Deadly Aim STANCE for this turn. Default is ON (free
  // damage, kept on across rooms). It EASES OFF against a target whose AC it can't
  // reliably beat while powering — and powers back up once a hittable foe is up.
  // Decision = the d20 it would need to land WHILE powering: needs 16+ (≤25%) → drop
  // for accuracy; needs 14- (≥35%) → keep the damage; 15 is a hysteresis dead-band so
  // it doesn't flip-flop turn to turn. Pure casters take no stance (at-will isn't a
  // weapon), and the stance only flips when it actually changes (so no spam).
  _botStance(m, foes) {
    const kit = kitFor(m.cls);
    if (((kit.atwill || {}).effect) !== 'attack') return;     // pure caster — no weapon stance
    const ranged = this._isRanged(m);
    const idx = kit.abilities.findIndex(a => ranged ? a.deadlyaim : a.powerattack);
    if (idx < 0) return;
    const on = ranged ? !!(m.buffApplied && m.buffApplied.deadlyaim)
                      : !!(m.buffApplied && m.buffApplied.powerattack);
    const tgt = this._preferredFoe(m, foes);
    if (!tgt) return;
    const weapon = m.weapon || weaponOf(m.gear, m.weaponKey);
    const abilityMod = m.mods ? attackProfile({ mods: m.mods }, weapon).toHitMod : ABILITY_MOD;
    const bab = babFor(m.cls || 'fighter', m.level || 1);
    const ffHit = (fighterFeats(m.cls, m.level || 1, ranged).hit) || 0;   // Weapon Focus etc., as folded into the real swing
    const curHit = bab + abilityMod + (weapon.toHit || 0) + ffHit + ((m.buffs && m.buffs.toHit) || 0);
    const pen = ranged ? 2 : (m._paPen || (1 + Math.floor(bab / 4)));
    const hitWhilePowering = on ? curHit : curHit - pen;      // m.buffs.toHit already holds −pen when the stance is on
    const ac = (tgt.ac != null ? tgt.ac : 10);
    const neededOn = ac - hitWhilePowering;                   // d20 needed to land while powered
    let want = on;
    if (neededOn >= 16) want = false;                         // too tough to power through → accuracy
    else if (neededOn <= 14) want = true;                     // comfortably hits → take the damage
    if (want !== on) this._useAbility(m, idx, {});            // free toggle (announces the change)
    // FIGHT DEFENSIVELY — a survival stance: raise it when badly hurt (≤35% HP,
    // trade offense for +2-3 dodge AC to live until a heal lands), drop it once
    // recovered. Only matters for kits that HAVE the toggle (STR front-liners).
    const fdIdx = kit.abilities.findIndex(a => a.fightdefensively);
    if (fdIdx >= 0) {
      const fdOn = !!(m.buffApplied && m.buffApplied.fightdefensively);
      const wantFd = m.hp > 0 && m.hp <= (m.maxHp || 1) * 0.35;
      if (wantFd !== fdOn) this._useAbility(m, fdIdx, {});
    }
  }
  // Which foe a bot should strike. ROGUES hunt the HELPLESS (flat-footed / prone
  // / sickened / paralyzed / ASLEEP) for Sneak Attack — they'll happily stab a
  // sleeper. BARBARIANS pick the lowest-HP foe to fish for a kill → Cleave chain.
  // Everyone else AVOIDS asleep/fascinated foes (a hit wakes them and wastes the
  // crowd-control), only hitting one if all living foes are out.
  // Does a creature's physical DR blunt THIS member's weapon? (true = its hits are
  // reduced — the bot should rather strike a foe it can hurt.) Mirrors _physDR's bypass
  // test: a matching S/P/B type, or a magic weapon vs DR/magic, gets through; DR/— and
  // a plain numeric DR (Stoneskin) block every weapon. Used only as a SOFT preference
  // — never to refuse combat (see _preferredFoe's fallback).
  _drBlocksWeapon(m, e) {
    const dr = e && e.dr;
    const amount = dr ? (typeof dr === 'object' ? dr.amount : dr) : 0;
    if (!(amount > 0)) return false;
    const w = m.weapon || weaponOf(m.gear, m.weaponKey);
    const bypass = (typeof dr === 'object') ? dr.bypass : null;
    if (bypass === 'magic') return !(w && (w.dmgBonus > 0 || w.custom));
    if (bypass && bypass !== '—') return !(w && w.dtype === bypass);
    return true;   // DR/— or numeric (Stoneskin) — nothing physical bypasses
  }
  _preferredFoe(m, foes) {
    if (!foes || !foes.length) return null;
    // Taunted → compelled to go straight for the taunter (cleared at turn's end).
    const forced = this._forcedFoe(m);
    if (forced) return forced;
    // Melee fighters can't reach flyers — prefer grounded foes (fall back to flyers
    // only if that's all that's left, so the wasted-swing message still fires).
    const _w = m.weapon || weaponOf(m.gear, m.weaponKey);
    if (_w && !_w.ranged && !_w.reachFly) { const grounded = foes.filter(e => !e.flying); if (grounded.length) foes = grounded; }
    // DR awareness: go for a foe this weapon can actually bite into. But if EVERY foe
    // is warded by DR we can't pierce (an enemy Stoneskin, a room full of skeletons for
    // a swordsman), DON'T give up — keep the whole list and swing anyway; a crit can
    // still punch through. (Casters keep bypassing physical DR with energy spells.)
    const hittable = foes.filter(e => !this._drBlocksWeapon(m, e));
    if (hittable.length) foes = hittable;
    if (isSneakClass(m.cls)) {
      const helpless = foes.filter(e => e.flatFooted || e.prone || e.sickened > 0 || e.paralyzed > 0 || e.fascinated);
      return (helpless.length ? helpless : foes).slice().sort((a, b) => a.hp - b.hp)[0];   // weakest sneakable foe
    }
    const awake = foes.filter(e => !e.fascinated);
    if (m.cls === 'barbarian') return (awake.length ? awake : foes).slice().sort((a, b) => a.hp - b.hp)[0];   // weakest first → drop it → Cleave carries on
    return (awake.length ? awake : foes)[0];
  }
  // The juiciest prey for an UNSEEN killer striking from invisibility: enemy
  // CASTERS die first (arcane wizards, hold-shamans, priests), then the BOSS,
  // then whoever is closest to death — lowest HP breaks every tie.
  _sneakPrey(foes) {
    const byHp = foes.slice().sort((a, b) => a.hp - b.hp);
    return byHp.find(e => e.arcane || e.caster || e.healer)
        || byHp.find(e => e.boss)
        || byHp[0];
  }
  // Bot ability AI: pick a class ability for this turn, or null to basic-attack.
  // Priority: heal the hurt → raise buffs (smite/rage/shield/inspire/bane) →
  // blast/control a group → fire a spell or maneuver at the best target. Only
  // ever returns an ability that's actually usable right now (level + uses/pool).
  _botAbility(m) {
    const kit = kitFor(m.cls);
    if (!kit.abilities || !kit.abilities.length) return null;
    const lvl = m.level || 1;
    const foes = this._targetableEnemies();   // can't target Darkness-shrouded foes
    if (!foes.length) return null;
    // Rogue: if a foe is already HELPLESS (flat-footed at the open, prone, asleep,
    // held…) it's a free Sneak target — skip Feint and just stab it (basic attack).
    // Feint only when there's no opening to set one up.
    if (isSneakClass(m.cls) && foes.some(e => e.flatFooted || e.prone || e.sickened > 0 || e.paralyzed > 0 || e.fascinated)) return null;
    const awake = foes.filter(e => !e.fascinated);
    const targets = awake.length ? awake : foes;          // don't wake sleepers
    const usable = (ab) => {
      if (!ab || lvl < (ab.minLevel || 1)) return false;
      if (!this._charAllows(ab, m)) return false;   // char-gated forms (Rissa vs generic druids)
      if (!this._loadoutAllows(ab, m)) return false;   // PHASE C: bot only casts prepared/known spells
      if (ab.effect === 'form' && m.form && m.form.key === (ab.form && ab.form.key)) return false;   // already in this form
      if (ab.cost === 'pool') return (m.spellPool || 0) > 0;
      if (ab.cost === 'slot') return ((m.slots && m.slots[ab.slvl]) || 0) > 0;   // spontaneous: a slot of that level
      if (ab.cost === 'room') return ((m.abilityUses && m.abilityUses[ab.key]) || 0) > 0;
      if (ab.cost === 'run')  return ((m.runAbilityUses && m.runAbilityUses[ab.key]) || 0) > 0;   // don't re-pick a spent run cast (e.g. auto-Inspire/Bless)
      return true;                                         // 'free'
    };
    const allAbs = this._abilitiesFor(m);   // class kit + injected DOMAIN powers
    const slot = (ab) => allAbs.indexOf(ab);
    const avail = allAbs.filter(usable);
    if (!avail.length) return null;
    const allies = this.livingParty();
    const someoneHurt = allies.some(a => !a.undead && a.hp < a.maxHp * 0.55);   // the undead don't count — positive energy can't help them anyway
    const weakestFoe = targets.slice().sort((a, b) => a.hp - b.hp)[0];
    const anyDowned = this.party.some(a => !a.dead && !a.left && a.downed);
    const topCR = Math.max(0, ...targets.map(e => crToNum(e.cr) || 0));
    // Biggest damage spell on hand — widest coverage first, dice as the tiebreak,
    // aimed weakest-first. Shared by the blaster opener and the chaff calculus.
    const bestBlast = () => {
      const DMG = ['aoe', 'bolt', 'missile', 'touch', 'rays', 'disintegrate'];
      const cov = (a) => Math.min(targets.length, a.maxTargets || 1);
      const pow = (a) => {   // honest dice count: halflevel scales at lvl/2, dcap respected
        const n = typeof a.dice === 'number' ? a.dice : (a.dice === 'halflevel' ? Math.ceil(lvl / 2) : lvl);
        return Math.min(n, a.dcap || n) * (a.die || 6);
      };
      const blast = avail.filter(a => DMG.includes(a.effect) && (a.dice || a.die))
                         .sort((x, y) => (cov(y) - cov(x)) || (pow(y) - pow(x)))[0];
      if (!blast) return null;
      const weakFirst = targets.slice().sort((a, b) => a.hp - b.hp);
      const cap = blast.maxTargets || 1;
      return { slot: slot(blast), payload: cap < 2 ? { targetUid: weakFirst[0].uid } : { targetUids: weakFirst.slice(0, cap).map(e => e.uid) } };
    };

    // 0) Revive the DYING (Breath of Life — castable in combat). The already-DEAD
    //    are a non-factor mid-round: they return via the between-rounds ritual
    //    (_endOfRoundRaise) or between rooms — no combat turn is spent on them.
    const revive = avail.find(a => a.effect === 'revive' && !a.raiseDead && anyDowned);
    if (revive) return { slot: slot(revive), payload: {} };
    // 0b) Inquisitor: declare a Judgement if none is up (free action, then attack).
    const judg = avail.find(a => a.effect === 'judgment');
    if (judg && !m.judgment) return { slot: slot(judg), payload: {} };
    // 0c) Inquisitor: declare BANE (free action) vs the most common foe type when we
    //     have a use and our current declaration isn't aimed at a type that's present.
    const baneAb = avail.find(a => a.effect === 'bane');
    if (baneAb) {
      const present = new Set(foes.map(e => e.type).filter(Boolean));
      if (present.size && (!m.bane || !present.has(m.bane.type))) {
        return { slot: slot(baneAb), payload: { baneType: this._autoBaneType() } };
      }
    }
    // 0d) FRONT-LOADED BLASTERS — Elfrip trusts the alpha strike: winning
    //     initiative (round 1) against foes of his level or weaker, he usually
    //     just opens with his biggest blast, hoping to end the fight before
    //     anyone needs buffing or healing. (A dying ally still trumps glory.)
    if (this.round === 1 && Dungeon.BLASTER_OPENERS.has((m.playerId || '').toLowerCase())
        && !anyDowned && topCR <= lvl && Math.random() < 0.65) {
      const b = bestBlast();
      if (b) return b;
    }
    // ── MAGUS DOCTRINE ── the team's boss-killer. A buff or two to open, then it
    //    SPELLSTRIKES the beefiest / most dangerous foe with its biggest crit-fishing
    //    strike (the bigger the target, the better) — it KNOWS it's the party's best
    //    bet at melting a boss fast, and saves those limited strikes for bosses/real
    //    threats, not chaff. It only falls back to dispel / debuff / a minor buff when
    //    the field is ALREADY under control (most foes grappled, prone, held, asleep);
    //    otherwise it just swings steel. Self-contained: always returns a choice or
    //    null (= weapon attack), so it never defaults to Grease/Slow/Tentacles.
    if (m.cls === 'magus') {
      const byHp = targets.slice().sort((a, b) => b.maxHp - a.maxHp);
      const boss = targets.find(e => e.boss) || byHp[0];                    // beefiest = a boss, else highest-HP foe
      const second = byHp[1] ? byHp[1].maxHp : 0;
      const worthy = !!boss && (boss.boss || targets.length <= 2 || topCR >= lvl - 2 || boss.maxHp >= 1.5 * second);
      const controlled = targets.length >= 2 &&
        targets.filter(e => e.grappled || e.prone || e.paralyzed > 0 || e.fascinated || e.asleep).length * 2 >= targets.length;
      const dmgPow = (a) => {   // honest output incl. Empower, for ranking strikes & nukes
        const n = typeof a.dice === 'number' ? a.dice : (a.dice === 'halflevel' ? Math.ceil(lvl / 2) : lvl);
        let p = Math.min(n, a.dcap || n) * (a.die || 6);
        if (a.empowered) p = Math.floor(p * 1.5);
        return p;
      };
      // (a) Open with AT MOST a buff or two (rounds 1-2) vs a real threat — one
      //     defensive self-buff or Mirror Image not already up — THEN start blowing up.
      if ((this.round || 1) <= 2 && worthy && !controlled) {
        // Higher-level buff first when time is short (Tobias): Stoneskin (4) over
        // Mirror Image (2) over Shield (1) — rank the openers by spell level.
        const opens = avail.filter(a =>
             (a.effect === 'buff' && a.sticky && a.target === 'self' && !a.powerattack && !a.deadlyaim
               && !(m.buffApplied && m.buffApplied[a.key]) && !(m.runBuffApplied && m.runBuffApplied[a.key]))
          || (a.effect === 'mirrorimage' && !(m.images > 0)))
          .sort((x, y) => (y.slvl || 0) - (x.slvl || 0));
        if (opens[0]) return { slot: slot(opens[0]), payload: {} };
      }
      // (b) PRIMARY — spellstrike the beefiest foe with the biggest strike; if the
      //     strikes are spent, the hardest single-target nuke (Disintegrate / Chain
      //     Lightning / Scorching Ray) on that same boss.
      if (worthy) {
        const ss = avail.filter(a => a.effect === 'spellstrike').sort((x, y) => dmgPow(y) - dmgPow(x))[0];
        if (ss) return { slot: slot(ss), payload: { targetUid: boss.uid } };
        const nuke = avail.filter(a => ['disintegrate', 'rays', 'touch', 'bolt'].includes(a.effect)).sort((x, y) => dmgPow(y) - dmgPow(x))[0];
        if (nuke) return { slot: slot(nuke), payload: { targetUid: boss.uid } };
      }
      // (c) OPPORTUNITY — the field is already locked down (Black Tentacles, River of
      //     Wind, mass Hold): now there's TIME to dispel a buffed foe / free a debuffed
      //     ally, or debuff a foe still standing.
      if (controlled) {
        const cleanse = avail.find(a => a.effect === 'cleanse');
        if (cleanse) {
          const allyDebuffed = allies.some(a => (a.paralyzed > 0 && a.heldDC != null) || a.slowed > 0 || a.blinded > 0);   // SPELL effects only — dispel can't touch grapple/stun/sickness (PF1, Tobias 2026-07-03)
          // Foe-side dispel ECONOMICS (Tobias: bards over-dispelled): grounding
          // SPELL-flight, unveiling Invisibility or stripping Haste is worth the
          // turn; a static AC ward (Shield/Mage Armor) is NOT — fall through to
          // fighting/buffing/debuffing/healing instead.
          const worthy = this._dispelWorthyFoe();
          if (allyDebuffed || worthy) return { slot: slot(cleanse), payload: (worthy && !allyDebuffed) ? { targetUid: worthy.uid } : {} };
        }
        const active = targets.filter(e => !(e.grappled || e.prone || e.paralyzed > 0 || e.fascinated || e.asleep));
        const dbf = avail.find(a => ['glitterdust', 'slow', 'grease', 'save_debuff'].includes(a.effect));
        if (dbf && active.length) {
          const cap = dbf.maxTargets || 1;
          return { slot: slot(dbf), payload: cap < 2 ? { targetUid: active[0].uid } : { targetUids: active.slice(0, cap).map(e => e.uid) } };
        }
      }
      return null;   // chaff / nothing magical worth a turn → swing steel (conserve the strikes)
    }
    // 1) Healing. CHANNEL (party heal) is the better call when MULTIPLE allies are
    //    hurt or anyone's DOWNED (it revives the dying); a single big CURE is better
    //    when exactly ONE ally is badly hurt (more HP on one target). If nobody's
    //    hurt but UNDEAD are present, CHANNEL anyway — _abHeal sears them (PF1).
    // UNDEAD comrades (Tar Baphon, Vrood, Vesorianna, Farrus) take NOTHING from
    // positive energy — healers who know better reach for INFERNAL HEALING on
    // them (eagerly — any hurt undead jumps the queue), and Adimarus mends them
    // with his Channel Negative. They're excluded from every cure/channel count.
    const undeadHurt = allies.filter(a => a.undead && !a.infernalHeal && a.hp < a.maxHp * 0.7)
                             .sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0];
    if (undeadHurt) {
      const infernal = avail.find(a => a.effect === 'infernalheal');
      if (infernal) return { slot: slot(infernal), payload: { targetUid: undeadHurt.playerId } };
      const chNeg = avail.find(a => a.effect === 'channelneg');
      if (chNeg) return { slot: slot(chNeg), payload: {} };
    }
    const channelHeal = avail.find(a => a.effect === 'heal' && a.heal === 'party');
    const bigCure = avail.filter(a => a.effect === 'heal' && a.heal === 'single')
                         .sort((x, y) => (y.healDice || 0) - (x.healDice || 0))[0];   // largest castable cure (e.g. Cure Serious)
    const hurtCount = allies.filter(a => !a.undead && a.hp < a.maxHp * 0.6).length + (anyDowned ? 1 : 0);
    const pickHeal = () => {
      if (channelHeal && (anyDowned || hurtCount >= 2)) return { slot: slot(channelHeal), payload: {} };   // many hurt / dying → channel
      if (bigCure && hurtCount === 1) {
        const worst = allies.slice().sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0];
        if (worst && worst.hp < worst.maxHp * 0.5) return { slot: slot(bigCure), payload: {} };   // one badly hurt → big single cure
      }
      if ((channelHeal || bigCure) && someoneHurt) return { slot: slot(channelHeal || bigCure), payload: {} };
      return null;
    };
    // Healing is PRIORITY-BY-SEVERITY: someone dying, or an ally below 30%, and
    // the heal happens RIGHT NOW, ahead of everything. Mild scrapes wait their
    // turn — control and buffs come first; the patch-up lands just before the
    // offense phase (the mild-wounds stop below). Nobody hurt → no healing.
    const sevHurt = anyDowned || allies.some(a => !a.undead && a.hp < a.maxHp * 0.3);
    if (sevHurt) { const h = pickHeal(); if (h) return h; }
    // Nobody hurt, but a CROWD of undead → channel to SEAR them (PF1 cleric).
    // The sear is an AoE spend (Tobias): vs a single undead a martial's weapon
    // + Smite out-damages it, so PALADINS never open with it at all, and the
    // priestly classes want 2+ undead up before burning the action.
    if (channelHeal && !someoneHurt && m.cls !== 'paladin' && m.cls !== 'antipaladin'
        && targets.filter(e => e.type === 'undead').length >= 2) return { slot: slot(channelHeal), payload: {} };
    // 1b) Dispel Magic — free a SPELL-debuffed ally, or strip a foe buff that's
    //     genuinely WORTH the turn (Tobias: bards over-dispelled — grounding
    //     spell-flight yes, peeling a Shield ward no; otherwise fall through to
    //     fight/buff/debuff/heal like a real bard).
    const cleanse = avail.find(a => a.effect === 'cleanse');
    if (cleanse) {
      const allyDebuffed = allies.some(a => (a.paralyzed > 0 && a.heldDC != null) || a.slowed > 0 || a.blinded > 0);   // SPELL effects only — dispel can't touch grapple/stun/sickness (PF1, Tobias 2026-07-03)
      const worthy = this._dispelWorthyFoe();
      if (allyDebuffed || worthy) return { slot: slot(cleanse), payload: (worthy && !allyDebuffed) ? { targetUid: worthy.uid } : {} };
    }
    // 1c) Druid WILD SHAPE — most druids fight shapeshifted. If not already in a
    //     form, shift into a combat shape: prefer a reach form when every foe is
    //     airborne, else the strongest melee form (Beast > Promethean > Bear > Tiger).
    //     Hawk is a defensive/flight form, so the AI doesn't auto-pick it for combat.
    if (m.cls === 'druid' && !m.form) {
      const forms = avail.filter(a => a.effect === 'form' && a.form && a.form.key !== 'hawk');
      if (forms.length) {
        const allAirborne = targets.length && targets.every(e => e.flying);
        let chosen = null;
        if (allAirborne) chosen = forms.find(a => a.form.weapon === 'form_promethean' || a.form.weapon === 'form_beast');
        if (!chosen) chosen = ['beast', 'promethean', 'bear', 'tiger'].map(k => forms.find(a => a.form.key === k)).find(Boolean) || forms[0];
        if (chosen) return { slot: slot(chosen), payload: {} };
      }
    }
    // 1d) DOMAIN actives (Phase B) — spend them like a real battle-priest.
    //     Only when the fight is REAL (a boss, or CR at/above our level): chaff
    //     dies to plain attacks; burning actions on buffs there is a waste.
    //     · Resistant Touch: ward the frailest living ally once, early.
    //     · Battle Rage / Strength Surge: ONE opener per room vs a tough foe —
    //       activating costs the action, so the AI doesn't chain-rebuff.
    //     · Bleeding Touch: once, vs a high-HP foe with blood to spill.
    //     (Good Fortune is deliberately NOT bot-picked: a whole action for a
    //     conditional reroll is a bad trade a human may still choose to make.)
    const bigFight = targets.some(e => e.boss) || topCR >= lvl;
    if (bigFight && !sevHurt && !m._domAIBuffed) {
      const ward = avail.find(a => a.effect === 'domward');
      if (ward && !allies.some(a => (a._domWardRounds || 0) > 0)) {
        const frail = allies.filter(a => !a.dead && a.hp > 0).sort((a, b) => a.maxHp - b.maxHp)[0];
        if (frail) { m._domAIBuffed = true; return { slot: slot(ward), payload: { allyUid: frail.playerId } }; }
      }
      const toughFoe = targets.some(e => e.hp >= 40);
      const rage = avail.find(a => (a.effect === 'domsmite' && !m._domSmite) || (a.effect === 'domstrike' && !m._domStrike));
      if (rage && toughFoe && !someoneHurt) { m._domAIBuffed = true; return { slot: slot(rage), payload: {} }; }
      const bleedT = avail.find(a => a.effect === 'dombleed');
      if (bleedT && !m._domBleed) {
        const bloodless = (e) => e.type === 'undead' || e.type === 'construct' || /golem|skelet|zombie|ooze|elemental|wraith|ghost|shadow|specter|spectre/i.test(e.name || '');
        if (targets.some(e => e.hp >= 50 && !e._bleeding && !bloodless(e))) { m._domAIBuffed = true; return { slot: slot(bleedT), payload: {} }; }
      }
    }
    // ── CR CALCULUS (full casters) ── when the toughest foe's CR is BELOW the
    //    caster's own level, the fight is chaff: no wards, no save-or-suck
    //    babysitting, no defensive setup. The caster either throws the ONE
    //    offensive buff worth a turn (Haste, if the party's speed is dry) or
    //    just BLASTS — widest coverage first, biggest dice as the tiebreak —
    //    until the damage spells run out, then falls back to cantrips/weapon.
    //    (Healing and cleansing above still always apply; inquisitors and magi
    //    keep their steel-first rules — this is for the robe-wearers.)
    if (['wizard', 'sorcerer', 'cleric', 'druid', 'bard', 'oracle'].includes(m.cls)) {
      if (topCR < lvl) {
        const haste = avail.find(a => a.effect === 'haste');
        if (haste && !this.livingParty().some(p => p.hasted > 0)) return { slot: slot(haste), payload: {} };
        const b = bestBlast();
        if (b) return b;
        return null;   // damage spells spent → cantrip / weapon swing
      }
    }
    // ── CONTROL FIRST (caster doctrine) ── a SERIOUS fight gets shut down BEFORE
    //    the buff checklist: Black Tentacles grips a pack, Slow staggers a crowd,
    //    the bard pins the boss with Hideous Laughter. THEN buffs (Stoneskin
    //    Communal / Haste / Fervor), THEN offense.
    const tentacles = avail.find(a => a.effect === 'blacktentacles');
    if (tentacles && !this.blackTentacles && foes.length >= 2) return { slot: slot(tentacles), payload: {} };
    const slowAb = avail.find(a => a.effect === 'slow');
    if (slowAb) {
      const fresh = targets.filter(t => !(t.slowed > 0) && !t.fascinated);
      if (fresh.length >= 2) return { slot: slot(slowAb), payload: { targetUids: fresh.slice(0, slowAb.maxTargets || 3).map(e => e.uid) } };
    }
    // The bard pins a BOSS so it misses turns — Hideous Laughter (Held) survives
    // being hit (unlike Fascinate), so the party can keep focus-firing while it
    // wastes turns re-saving. Re-cast only if the boss shrugs free; a crowd with
    // no boss falls through to the phases below.
    if (m.cls === 'bard') {
      const heaviest = targets.slice().sort((a, b) => b.maxHp - a.maxHp);
      const boss = targets.find(e => e.boss) || (heaviest.length >= 2 && heaviest[0].maxHp >= 1.6 * heaviest[1].maxHp ? heaviest[0] : null);
      if (boss && !(boss.paralyzed > 0)) {
        const laugh = avail.find(a => a.effect === 'save_debuff');   // Hideous Laughter → Held
        if (laugh) return { slot: slot(laugh), payload: { targetUid: boss.uid } };
      }
    }
    // 2) Put up buffs once — Smite, then sticky self/party buffs (rage, shield,
    //    bane, divine favor, inspire). Sticky guard stops re-casting.
    const smite = avail.find(a => a.effect === 'smite' && !m.smiteActive);
    if (smite) return { slot: slot(smite), payload: {} };
    // Paladin: Detect Evil reveals NON-evil foes (animals/constructs) so Smite
    // bites them — a standard action, worth it when not every foe is already evil.
    const detectEvil = avail.find(a => a.effect === 'detectevil');
    if (detectEvil && this.livingEnemies().some(e => !e.evil && !e.markedEvil)) return { slot: slot(detectEvil), payload: {} };
    // Mage Armor — a free, run-long +4 AC; put it up once if not already on.
    const mageArmor = avail.find(a => a.effect === 'magearmor');
    if (mageArmor && !m.mageArmor) return { slot: slot(mageArmor), payload: {} };
    // ── ROUND-DECAY BUFF APPETITE ── nobody opens round 8 with Shield. The urge
    //    to spend a turn raising buffs is strongest at the top of a fight and
    //    fades fast — R1 ~90%, R2 ~60%, R3 ~30%, R4+ never — after which the
    //    caster falls through to control/offense below. Reactive picks are NOT
    //    gated (heals, prot-fire vs fiery foes, invisibility triage, smite/
    //    judgement/bane attack enablers): those answer the battlefield, not the
    //    opening checklist.
    const buffAppetite = Math.random() < Math.max(0, 0.9 - 0.3 * ((this.round || 1) - 1));
    // High-level casters don't burn turns on petty buffs: a leveled buff only
    // makes the cut if its slot level is within 3 of the caster's best — a L12
    // wizard opens Stoneskin (Communal) / Haste, never Shield. Class features
    // without a spell level (Rage, Inspire Courage) always qualify.
    const bestSlvl = Math.ceil(Math.min(lvl, 18) / 2);
    // PARTY/communal buffs (a.party) are exempt — a party-wide ward like
    // Protection from Evil (Communal) or Bless is worth a slot at ANY level
    // (Josh: high-level sorcerers never cast Prot Evil Communal because its
    // slvl-2 fell under the floor). The floor only suppresses petty SELF buffs
    // (no Shield in round 8). Class features without a spell level always qualify.
    const potentEnough = (a) => !a.slvl || a.party || a.slvl >= Math.max(1, Math.min(3, bestSlvl - 3));
    // Don't waste a turn re-casting a NON-STACKING buff that's already up. A buff
    // is "fully up" when every recipient already has it: the whole party for a
    // party buff (Inspire/Prayer/Bless), or the caster for a self buff (Rage/
    // Shield). Single-ally buffs (Bull's/Cat's/Bear's) are gated by their once-
    // per-room use instead, so they fall through to the find naturally.
    const buffFullyUp = (a) => {
      const flag = a.persist ? 'runBuffApplied' : 'buffApplied';
      // party buff → everyone; single-ally buff → the one ally it would land on
      // (so it's "done" once that ally has it, instead of re-casting forever);
      // self buff → me.
      const recips = a.party ? this.livingParty()
                   : a.target === 'ally' ? [this._buffTarget(m, a)]
                   : [m];
      return recips.length > 0 && recips.every(w => w && w[flag] && w[flag][a.key]);
    };
    // Protection from Fire — only worth a slot when fiery foes are on the field.
    const fireFoes = foes.some(e => e.detonate || e.hellfire || /fire|flame|magma|salamander|phoenix/i.test(e.name));
    const protect = avail.find(a => a.protectFire);
    if (protect && fireFoes && this.livingParty().some(p => !p.protectFire)) return { slot: slot(protect), payload: {} };
    // Buff priority (PF1 support play): a multi-target PARTY buff is almost always the
    // best use of a turn, so take those FIRST — Stoneskin (Communal), Prayer, Protection
    // from Evil, Bless reach every ally at once. Then cheap SELF buffs (Divine Favor,
    // Shield, Displacement). SINGLE-ALLY buffs (Shield of Faith, Bull's Strength, single
    // Stoneskin) land on ONE ally per cast; spreading them down the line is fine early but
    // a poor use of a turn at mid-late levels — past L6 the bot stops babysitting each ally
    // and would rather drop a party buff or just attack. (Power Attack / Deadly Aim are
    // toggles handled by _botStance, never auto-picked here.)
    // HIGHER-LEVEL BUFFS FIRST when buff time is short (Tobias): rank every eligible
    // sticky buff — AND Haste / Blessing of Fervor, which competes as a buff — by
    // SPELL LEVEL, a party-wide buff winning ties (it reaches everyone). With lots of
    // time they all get cast over successive rounds; in a hurry the meatiest goes
    // first (Blessing of Fervor over Shield of Faith, Stoneskin over Shield). Past L6
    // a PETTY single-ally buff (slvl < 4) is skipped, but a meaty one (Stoneskin) counts.
    const buffCands = avail.filter(a => buffAppetite && potentEnough(a)
      && a.effect === 'buff' && a.sticky && !a.protectFire
      && !a.powerattack && !a.deadlyaim && !buffFullyUp(a)
      && (a.target !== 'ally' || (m.level || 1) < 7 || (a.slvl || 0) >= 4));
    const fervor = avail.find(a => a.effect === 'haste');
    if (fervor && buffAppetite && !this.livingParty().some(p => p.hasted > 0)) buffCands.push(fervor);   // Haste/Fervor ranks by its own spell level
    buffCands.sort((x, y) => (y.slvl || 0) - (x.slvl || 0) || ((y.party ? 1 : 0) - (x.party ? 1 : 0)));
    if (buffCands.length) return { slot: slot(buffCands[0]), payload: {} };
    // Invisibility — shields the most-hurt ally (it lands on the lowest-HP ally in
    // _abInvisible). Cast when an ally is badly hurt and nobody's hidden yet.
    const invis = avail.find(a => a.effect === 'invisible');
    if (invis && !this.livingParty().some(p => p.invisible)) {
      const hurt = allies.slice().sort((a, b) => a.hp - b.hp)[0];
      if (hurt && hurt.hp < hurt.maxHp * 0.5) return { slot: slot(invis), payload: {} };
    }
    // 2a) Taunt — a barbarian roars to pull a pack's fire onto themselves (once
    //     per room, only worth it against 2+ foes). With multiple barbarians,
    //     DON'T pile on if a team-mate's taunt already gripped most foes — but if
    //     MOST of the pack RESISTED, a second taunt (re-rolling their saves) is
    //     worth it. Heuristic: only taunt while fewer than half the foes are
    //     currently under a taunt-compulsion.
    const taunt = avail.find(a => a.effect === 'taunt');
    if (taunt && foes.length >= 2 && foes.filter(e => e.taunted).length * 2 < foes.length) {
      return { slot: slot(taunt), payload: {} };
    }
    // 2b) Haste / Blessing of Fervor — the SAME benefit in this implementation,
    //     and they don't stack. Cast one only when the party's speed has fully
    //     run dry (no living member still holds a haste charge) — never double
    //     up on a fervor that's already running, and vice versa.
    const haste = avail.find(a => a.effect === 'haste');
    if (haste && buffAppetite && !this.livingParty().some(p => p.hasted > 0)) return { slot: slot(haste), payload: {} };
    // 2b4) Suffocation — try to outright kill a dangerous non-undead foe (boss/elite,
    //      or a lone target). A made save still deals heavy damage, so it's never wasted.
    const suffocate = avail.find(a => a.effect === 'savedie');
    if (suffocate) {
      const prey = targets.filter(e => e.type !== 'undead' && e.type !== 'construct').slice().sort((a, b) => b.maxHp - a.maxHp)[0];
      if (prey && (prey.boss || targets.length <= 2)) return { slot: slot(suffocate), payload: { targetUid: prey.uid } };
    }
    // 2b5) Infernal Healing (Greater) — fast-heal a badly-hurt ally not already under it.
    const infheal = avail.find(a => a.effect === 'infernalheal');
    if (infheal) {
      const hurt = allies.filter(a => !a.infernalHeal).slice().sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0];
      if (hurt && hurt.hp < hurt.maxHp * 0.55) return { slot: slot(infheal), payload: { targetUid: hurt.playerId } };
    }
    // 2b6) Overland Flight — rise above grounded foes (defensive), once, if not flying.
    const overland = avail.find(a => a.effect === 'overlandflight');
    if (overland && !m.flying) return { slot: slot(overland), payload: {} };
    // 3) MILD wounds — control is down and the buffs are up; patch the party up
    //    BEFORE opening fire. (SEVERE wounds already jumped the queue at the top;
    //    nobody hurt → pickHeal returns null and the offense below proceeds.)
    { const h = pickHeal(); if (h) return h; }
    // 2c) Arcane controllers (wizard, sorcerer) play the battlefield: by default
    //     they pick the spell that AFFECTS THE MOST foes — a wide blast (Fireball,
    //     Lightning Bolt, Burning Hands) or a mass lockdown (Sleep, Grease). But
    //     when a lone outsized foe ("boss") looms, they spike it with their
    //     hardest single-target nuke (Disintegrate / Cone of Cold) or pin it with
    //     a save-or-suck debuff (Hold Person). NOTE: some 'aoe'-tagged spells only
    //     hit one target (maxTargets 1), so coverage = min(foes, maxTargets).
    // 2c0) INQUISITORS fight with STEEL — Judgement and Bane are already up (the
    //      buff phase above), so the turn is best spent swinging, not casting
    //      offense spells. The one exception: pin a PARTICULARLY DANGEROUS foe
    //      (a boss, or one towering over the field) with Hold Person — then carve it.
    if (m.cls === 'inquisitor') {
      const byHp = targets.slice().sort((a, b) => b.maxHp - a.maxHp);
      const dangerous = targets.find(e => e.boss)
        || ((byHp.length >= 2 && byHp[0].maxHp >= 1.6 * byHp[1].maxHp) ? byHp[0] : null);
      const hold = avail.find(a => a.effect === 'save_debuff');
      if (hold && dangerous && !(dangerous.paralyzed > 0) && this._spellWorksOn(hold, dangerous)) return { slot: slot(hold), payload: { targetUid: dangerous.uid } };
      return null;   // → Bane/Judgement-boosted weapon attack
    }
    if (m.cls === 'wizard' || m.cls === 'sorcerer' || m.cls === 'oracle') {
      const SPELLISH = ['aoe', 'disintegrate', 'grease', 'sleep', 'slow', 'fascinate', 'bolt', 'missile', 'touch', 'rays', 'save_debuff'];
      const weakFirst = targets.slice().sort((a, b) => a.hp - b.hp);
      const cand = [];
      for (const a of avail) {
        if (!SPELLISH.includes(a.effect)) continue;
        // Only foes this spell actually WORKS on (mind-immune shrug off Hold /
        // Sleep / Fascinate; element-immune shrug off the blast) — a spell with
        // no eligible target is never queued (see _spellWorksOn).
        const el = weakFirst.filter(t => this._spellWorksOn(a, t));
        if (!el.length) continue;
        const cap = a.maxTargets || 1;
        const affects = Math.max(1, Math.min(el.length, cap));
        const single = cap < 2;
        const isDebuff = a.effect === 'save_debuff' || ['grease', 'sleep', 'fascinate'].includes(a.effect);
        // Rough damage rank for boss focus: honest dice count ('halflevel' scales
        // at lvl/2, dcap respected); a numeric count is taken as-is. Debuffs rank 0.
        const nDice = typeof a.dice === 'number' ? a.dice : (a.dice === 'halflevel' ? Math.ceil(lvl / 2) : lvl);
        const power = isDebuff ? 0 : Math.min(nDice, a.dcap || nDice) * (a.die || 6);
        const payload = single ? { targetUid: el[0].uid } : { targetUids: el.slice(0, cap).map(e => e.uid) };
        cand.push({ ab: a, payload, affects, single, isDebuff, power });
      }
      if (cand.length) {
        const byHp = targets.slice().sort((a, b) => b.maxHp - a.maxHp);
        const boss = (byHp.length >= 2 && byHp[0].maxHp >= 1.6 * byHp[1].maxHp) ? byHp[0]
                   : (byHp.length === 1 ? byHp[0] : null);
        let chosen = null;
        if (boss) {
          // Hardest single-target nuke on the boss (Disintegrate first), else a
          // single-target debuff (Hold Person) to take it out of the fight.
          const nuke = cand.filter(c => c.single && !c.isDebuff && this._spellWorksOn(c.ab, boss))
                           .sort((x, y) => (y.power - x.power) || ((y.ab.minLevel || 1) - (x.ab.minLevel || 1)))[0];
          const dbf = cand.find(c => c.single && c.ab.effect === 'save_debuff' && this._spellWorksOn(c.ab, boss));
          const c = nuke || dbf;
          if (c) chosen = { ab: c.ab, payload: { targetUid: boss.uid } };
        }
        if (!chosen) {
          // No boss → control the crowd: most-foes-affected wins, with a nudge
          // away from last turn's spell so they vary their blasts.
          const best = Math.max(...cand.map(c => c.affects));
          const top = cand.filter(c => c.affects === best);
          const c = top.find(o => o.ab.key !== m._lastAbilityKey) || top[0];
          chosen = { ab: c.ab, payload: c.payload };
        }
        return { slot: slot(chosen.ab), payload: chosen.payload };
      }
    }
    // 3+4) Offense — gather usable options in priority order (group blast →
    //      single-target spell → maneuver), then prefer one we did NOT use last
    //      turn. That variety stops a bot from spamming ONE ability — and its one
    //      sound (e.g. a cleric's Holy Smite) — every single turn; the cleric
    //      now alternates Holy Smite / Hold Person instead.
    const offense = [];
    if (targets.length >= 2) {
      for (const a of avail) if (['aoe', 'grease', 'sleep', 'slow', 'fascinate', 'exhaust', 'prismatic', 'masscharm'].includes(a.effect)) {
        // Only foes the spell WORKS on (a Sleep with nothing but skeletons on the
        // field is never queued) — see _spellWorksOn.
        const el = targets.filter(t => this._spellWorksOn(a, t));
        if (!el.length) continue;
        offense.push({ ab: a, payload: { targetUids: el.slice(0, a.maxTargets || 3).map(e => e.uid) } });
      }
    }
    if (weakestFoe) {
      for (const a of avail) if (['bolt', 'missile', 'touch', 'rays', 'spellstrike', 'save_debuff', 'savedie', 'charm', 'dominate'].includes(a.effect)) {
        // Immunity-aware single-target pick: the BARD's Hideous Laughter skips the
        // undead (no mind to tickle); death spells skip the unliving; element
        // blasts skip the immune. Death/charm spend on the BIGGEST eligible threat
        // (best case), plain damage on the weakest (finish it off).
        const el = targets.filter(t => this._spellWorksOn(a, t) && !((a.effect === 'charm' || a.effect === 'dominate') && (ccd(t) || t.dominated > 0)));
        if (!el.length) continue;
        const pick = (a.effect === 'savedie' || a.effect === 'charm' || a.effect === 'dominate')
          ? el.slice().sort((x, y) => y.maxHp - x.maxHp)[0]
          : (el.includes(weakestFoe) ? weakestFoe : el.slice().sort((x, y) => x.hp - y.hp)[0]);
        offense.push({ ab: a, payload: { targetUid: pick.uid } });
      }
      // Spiritual Weapon — conjure it onto the TOUGHEST foe (sustained damage) and
      // never re-cast while one is already fighting; the cleric then does other things.
      if (!(m.spiritWeapon && m.spiritWeapon.rounds > 0)) {
        const sw = avail.find(a => a.effect === 'spiritweapon');
        if (sw) { const tough = targets.slice().sort((a, b) => b.maxHp - a.maxHp)[0] || weakestFoe; offense.push({ ab: sw, payload: { targetUid: tough.uid } }); }
      }
      const boltAction = !!weaponOf(m.gear, m.weaponKey).boltAction;   // can't Rapid Shot a bolt-action rifle
      for (const a of avail) if (['rapidshot', 'bullseye', 'cleave', 'trip', 'reckless', 'feint', 'disarm', 'stunfist', 'grapple', 'bullrush'].includes(a.effect)) {
        if (a.needsRepeating && boltAction) continue;
        // GRAPPLE — lock down a DANGEROUS foe (caster/boss) the bot can reach; never
        // an incorporeal or already-grappled one (those refuse + waste the turn).
        if (a.effect === 'grapple') {
          const grab = targets.filter(t => !t.grappled && !t.incorporeal && this._canReach(m, t));
          if (!grab.length) continue;
          const prey = grab.find(t => t.boss || t.arcane || t.caster || t.healer) || grab.slice().sort((x, y) => y.maxHp - x.maxHp)[0];
          offense.push({ ab: a, payload: { targetUid: prey.uid } });
          continue;
        }
        // BULL RUSH — shove a reachable, not-already-prone foe (a hard shove knocks it down).
        if (a.effect === 'bullrush') {
          const shove = targets.filter(t => this._canReach(m, t) && !t.prone);
          if (!shove.length) continue;
          offense.push({ ab: a, payload: { targetUid: shove.slice().sort((x, y) => y.maxHp - x.maxHp)[0].uid } });
          continue;
        }
        // DISARM — only a reachable foe that fights with a real weapon (claws/fangs/fists refuse).
        if (a.effect === 'disarm') {
          const dis = targets.filter(t => !fightsNatural(t) && this._canReach(m, t));
          if (!dis.length) continue;
          offense.push({ ab: a, payload: { targetUid: dis.slice().sort((x, y) => y.maxHp - x.maxHp)[0].uid } });
          continue;
        }
        // Stunning Fist (monk, 1/room): a strike + Fort-or-stun. Spend it on the
        // BIGGEST threat that actually HAS a mind/body to stun (undead & constructs
        // are immune) — robbing a boss of a turn is its highest-value use.
        if (a.effect === 'stunfist') {
          const prey = targets.filter(t => !mindImmune(t)).sort((x, y) => y.maxHp - x.maxHp)[0];
          if (!prey) continue;                       // everything here is immune — save the strike
          offense.push({ ab: a, payload: { targetUid: prey.uid } });
          continue;
        }
        // Trip smarts (PF1): never try to trip the untrippable (oozes, flyers, Huge
        // things); pick a TRIPPABLE foe — preferring two-legged ones (quadrupeds and
        // many-legged foes get +4 stability per extra leg, so they're poor targets).
        if (a.effect === 'trip') {
          const trippable = targets.filter(t => !this._tripBlocked(t));
          if (!trippable.length) continue;                       // nobody worth sweeping — skip trip
          const best = trippable.slice().sort((x, y) => this._tripDefBonus(x) - this._tripDefBonus(y))[0];
          offense.push({ ab: a, payload: { targetUid: best.uid } });
          continue;
        }
        offense.push({ ab: a, payload: { targetUid: weakestFoe.uid } });
      }
    }
    if (offense.length) {
      const choice = offense.find(o => o.ab.key !== m._lastAbilityKey) || offense[0];
      return { slot: slot(choice.ab), payload: choice.payload };
    }
    return null;   // nothing fit → basic attack
  }
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
    const soaked = Math.min(dmg, amount);
    return [Math.max(0, dmg - amount), soaked > 0 ? ` 🛡️−${soaked} DR` : ''];
  }
  // A readable description of a creature's DR — for the once-per-fight reveal so the
  // party knows to switch weapons (and so Josh hears it in the log).
  _drDesc(dr) {
    if (!dr) return '';
    const amount = (typeof dr === 'object') ? dr.amount : dr;
    const bypass = (typeof dr === 'object') ? dr.bypass : null;
    const TYPE = { S: 'slashing', P: 'piercing', B: 'bludgeoning' };
    if (bypass === 'magic') return `DR ${amount}/magic — only an enchanted weapon (a +1 or a signature weapon) bites through`;
    if (TYPE[bypass]) {
      const weak = Object.keys(TYPE).filter(k => k !== bypass).map(k => TYPE[k]).join(' & ');
      return `DR ${amount}/${TYPE[bypass]} — ${weak} glance off; only ${TYPE[bypass]} cuts deep`;
    }
    return `DR ${amount}/— — almost nothing physical gets through; lean on spells and energy`;
  }
  _downMember(m) {
    if (m.dead) return;
    if (!m.downed) {
      m.downed = true; m.queuedAction = null;   // dying wipes the pre-load
      this._note(`🩸 ${m.nickname} collapses at ${m.hp} HP — DOWN and dying! (slain at −10; a Cure potion can still save them)`);
      this._log('downed', { who: m.playerId, hp: m.hp, depth: this.depth });
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
  action(playerId, kind, payload = {}) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };

    // Bail, loot rolls, and loot management are allowed any time (not on-turn).
    if (kind === 'bail') return this.bail(playerId);
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
Object.assign(Dungeon.prototype, require('./dungeon/serialize')({ fighterFeats }));
Object.assign(Dungeon.prototype, require('./dungeon/enemyAI')({ SICKENED_PENALTY, HIGH_GROUND_HIT, ABILITY_MOD }));
Object.assign(Dungeon.prototype, require('./dungeon/abilities')({ ABILITY_MOD, CAST_MOD, SICKENED_PENALTY, SICKENED_ROUNDS, BLIND_ROUNDS, HIGH_GROUND_AC, EFFECT_CL_FLOOR, mindImmune, fightsNatural, isSneakClass, titleCase, ccd, stepDamage }));

module.exports = { Dungeon, MON, BOSS_KEYS };
